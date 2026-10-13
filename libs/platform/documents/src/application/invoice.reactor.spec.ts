import type { DomainEvent, EventBus } from '@justgo/events';
import type { SellerIdentityPort, SellerIdentity } from '@justgo/contracts';
import type { DocumentDTO } from '../contract/dto';
import type { DocumentsPort } from '../contract/documents.port';
import { InvoiceReactor } from './invoice.reactor';

/*
  These guard the two things the invoice gets wrong most expensively: issuing
  on the wrong moment, and issuing a facture that is not a legal one. Both are
  invisible to a type checker and both were live defects at some point.
*/

const COMPLETE_SELLER: SellerIdentity = {
  supplierId: 'sup-1',
  legalName: 'SARL PIECES AUTO ALGER',
  address: '12 rue Didouche Mourad',
  city: 'Alger',
  country: 'DZ',
  nif: '000216001234567',
  nis: '000216001234567',
  rc: '16/00-1234567B16',
  taxArticle: '16000123456',
} as unknown as SellerIdentity;

function statusEvent(to: string, from = 'in_progress'): DomainEvent {
  return {
    type: 'orders.OrderStatusChanged',
    payload: {
      orderId: 'ord-1',
      clientAccountId: 'acc-1',
      supplierId: 'sup-1',
      from,
      to,
      amountMinor: 1_190_000,
      currency: 'DZD',
    },
  } as unknown as DomainEvent;
}

function harness(seller: SellerIdentity | null = COMPLETE_SELLER) {
  const issued: unknown[] = [];
  const documents = {
    issueInvoice: async (input: unknown) => {
      issued.push(input);
      return { number: 'FA-2026-000001' } as unknown as DocumentDTO;
    },
  } as unknown as DocumentsPort;
  const sellers = { sellerFor: async () => seller } as unknown as SellerIdentityPort;
  const bus = { subscribe: async () => undefined } as unknown as EventBus;
  return { reactor: new InvoiceReactor(bus, documents, sellers), issued };
}

describe('InvoiceReactor', () => {
  it('issues on the transition into completed', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(statusEvent('completed'));
    expect(issued).toHaveLength(1);
  });

  /*
    It used to issue on orders.OrderCreated, because no endpoint advanced an
    order past `created`. Now that one exists, issuing at creation would put a
    numbered facture in a gapless fiscal series for every order the client
    later abandons — and a number in that series cannot be deleted.
  */
  it('ignores every other transition', async () => {
    for (const to of ['confirmed', 'in_progress', 'cancelled', 'created']) {
      const { reactor, issued } = harness();
      await reactor.handle(statusEvent(to));
      expect(issued).toEqual([]);
    }
  });

  it('refuses rather than issue a facture with no fiscal identity', async () => {
    const incomplete = { ...COMPLETE_SELLER, nif: null } as unknown as SellerIdentity;
    const { reactor, issued } = harness(incomplete);
    await reactor.handle(statusEvent('completed'));
    expect(issued).toEqual([]);
  });

  it('refuses when the seller is unknown', async () => {
    const { reactor, issued } = harness(null);
    await reactor.handle(statusEvent('completed'));
    expect(issued).toEqual([]);
  });

  it('does not invoice an order carrying no amount', async () => {
    const { reactor, issued } = harness();
    const event = statusEvent('completed');
    (event.payload as Record<string, unknown>)['amountMinor'] = null;
    await reactor.handle(event);
    expect(issued).toEqual([]);
  });

  /*
    The quoted figure is the price the client agreed to pay, so it reaches the
    invoice as a TTC unit price and the breakdown is derived backwards from
    it. Passing it as an HT figure would inflate every bill by 19%.
  */
  it('passes the agreed amount through as a TTC line', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(statusEvent('completed'));
    expect(issued[0]).toMatchObject({
      subjectType: 'order',
      subjectId: 'ord-1',
      currency: 'DZD',
      lines: [{ quantity: 1, unitTtcMinor: 1_190_000 }],
    });
  });

  /*
    At-least-once delivery makes a redelivered event a matter of time. The
    unique index on (type, subject_type, subject_id) is the real defence; the
    reactor must treat it as expected so the message is acked rather than
    retried forever.
  */
  it('treats the duplicate index as expected, not as failure', async () => {
    const documents = {
      issueInvoice: async () => {
        throw new Error(
          'duplicate key value violates unique constraint "documents_one_invoice_per_subject"',
        );
      },
    } as unknown as DocumentsPort;
    const reactor = new InvoiceReactor(
      { subscribe: async () => undefined } as unknown as EventBus,
      documents,
      { sellerFor: async () => COMPLETE_SELLER } as unknown as SellerIdentityPort,
    );
    await expect(reactor.handle(statusEvent('completed'))).resolves.toBeUndefined();
  });

  it('rethrows anything else', async () => {
    const documents = {
      issueInvoice: async () => {
        throw new Error('storage unreachable');
      },
    } as unknown as DocumentsPort;
    const reactor = new InvoiceReactor(
      { subscribe: async () => undefined } as unknown as EventBus,
      documents,
      { sellerFor: async () => COMPLETE_SELLER } as unknown as SellerIdentityPort,
    );
    await expect(reactor.handle(statusEvent('completed'))).rejects.toThrow('storage unreachable');
  });
});
