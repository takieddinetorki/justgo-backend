import type { DomainEvent, EventBus } from '@justgo/events';
import type {
  PartyDirectoryPort,
  SellerIdentity,
  SellerIdentityPort,
  ServiceCatalogPort,
} from '@justgo/contracts';
import type { DocumentDTO } from '../contract/dto';
import type { DocumentsPort } from '../contract/documents.port';
import { FactureReactor } from './facture.reactor';

/*
  These guard what a facture gets wrong most expensively: issuing at the
  wrong moment, issuing one that is not a legal document, issuing two for
  one supply — and, since this reactor covers all of them, issuing for
  one kind of paid interaction while silently skipping the others.

  Every one of those has been a live defect in this codebase except the
  last, which was a live ABSENCE: two of the three paid interactions
  produced no facture at all.
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

function orderEvent(to: string, from = 'in_progress'): DomainEvent {
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

function reservationCharged(over: Record<string, unknown> = {}): DomainEvent {
  return {
    type: 'reservations.ReservationCharged',
    payload: {
      reservationId: 'res-1',
      clientAccountId: 'acc-1',
      supplierId: 'sup-1',
      amountMinor: 450_000,
      currency: 'DZD',
      serviceTypeKey: 'brake_service',
      slotStart: '2026-11-10T23:12:00.000Z',
      slotEnd: '2026-11-11T00:12:00.000Z',
      vehicleId: 'veh-1',
      ...over,
    },
  } as unknown as DomainEvent;
}

function assistanceCharged(over: Record<string, unknown> = {}): DomainEvent {
  return {
    type: 'assistance.AssistanceCharged',
    payload: {
      assistanceId: 'asi-1',
      clientAccountId: 'acc-1',
      supplierId: 'sup-1',
      amountMinor: 800_000,
      currency: 'DZD',
      serviceType: 'tow',
      ...over,
    },
  } as unknown as DomainEvent;
}

function harness(
  opts: {
    seller?: SellerIdentity | null;
    issueInvoice?: () => Promise<DocumentDTO>;
    parties?: PartyDirectoryPort | null;
    services?: ServiceCatalogPort | null;
  } = {},
) {
  const issued: Array<Record<string, unknown>> = [];
  const documents = {
    issueInvoice: async (input: Record<string, unknown>) => {
      if (opts.issueInvoice) return opts.issueInvoice();
      issued.push(input);
      return { number: 'FA-2026-000001' } as unknown as DocumentDTO;
    },
  } as unknown as DocumentsPort;
  const sellers = {
    sellerFor: async () => ('seller' in opts ? opts.seller : COMPLETE_SELLER),
  } as unknown as SellerIdentityPort;
  const parties = (
    'parties' in opts
      ? opts.parties
      : { partyFor: async () => ({ accountId: 'acc-1', name: 'Riyad Benali', phone: null }) }
  ) as PartyDirectoryPort | null;
  const services = (
    'services' in opts
      ? opts.services
      : {
          getServiceType: async () => ({
            key: 'brake_service',
            labelI18n: { fr: 'Freinage', en: 'Brakes' },
          }),
        }
  ) as ServiceCatalogPort | null;
  const bus = { subscribe: async () => undefined } as unknown as EventBus;
  return {
    reactor: new FactureReactor(bus, documents, sellers, parties, services),
    issued,
  };
}

describe('a facture for every paid interaction', () => {
  it('issues for a completed order', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(orderEvent('completed'));
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ subjectType: 'order', subjectId: 'ord-1' });
  });

  /*
    THE GAP THIS CLOSES. A workshop service was performed and paid for and
    the platform issued nothing, because nothing recorded the amount. Now
    the charge is its own event and this is what it produces.
  */
  it('issues for a charged workshop service', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(reservationCharged());
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      subjectType: 'reservation',
      subjectId: 'res-1',
      currency: 'DZD',
      lines: [{ quantity: 1, unitTtcMinor: 450_000 }],
    });
  });

  it('issues for a charged roadside call-out', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(assistanceCharged());
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      subjectType: 'assistance',
      subjectId: 'asi-1',
      lines: [{ quantity: 1, unitTtcMinor: 800_000 }],
    });
  });

  /*
    It used to issue on orders.OrderCreated, because no endpoint advanced
    an order past `created`. Issuing at creation puts a numbered facture in
    a gapless fiscal series for every order the client later abandons —
    and a number in that series cannot be deleted, only voided by hand.
  */
  it('ignores every order transition except into completed', async () => {
    for (const to of ['confirmed', 'in_progress', 'cancelled', 'created']) {
      const { reactor, issued } = harness();
      await reactor.handle(orderEvent(to));
      expect(issued).toEqual([]);
    }
  });

  /*
    A completion is not a sale. A booking finished for nothing — goodwill,
    warranty, a job that turned out not to be needed — must not burn a
    number out of the series, so the STATUS change is not a trigger at
    all. Only the charge is.
  */
  it('does not issue off a mere completion', async () => {
    const { reactor, issued } = harness();
    await reactor.handle({
      type: 'reservations.ReservationStatusChanged',
      payload: {
        reservationId: 'res-1',
        clientAccountId: 'acc-1',
        supplierId: 'sup-1',
        from: 'accepted',
        to: 'completed',
      },
    } as unknown as DomainEvent);
    expect(issued).toEqual([]);
  });

  it('does not issue a facture for nothing', async () => {
    for (const event of [
      reservationCharged({ amountMinor: 0 }),
      assistanceCharged({ amountMinor: 0 }),
    ]) {
      const { reactor, issued } = harness();
      await reactor.handle(event);
      expect(issued).toEqual([]);
    }
  });

  it('refuses rather than issue a facture with no fiscal identity', async () => {
    const incomplete = { ...COMPLETE_SELLER, nif: null } as unknown as SellerIdentity;
    for (const event of [orderEvent('completed'), reservationCharged(), assistanceCharged()]) {
      const { reactor, issued } = harness({ seller: incomplete });
      await reactor.handle(event);
      expect(issued).toEqual([]);
    }
  });

  it('refuses when the seller is unknown', async () => {
    const { reactor, issued } = harness({ seller: null });
    await reactor.handle(reservationCharged());
    expect(issued).toEqual([]);
  });

  it('does not invoice an order carrying no amount', async () => {
    const { reactor, issued } = harness();
    const event = orderEvent('completed');
    (event.payload as Record<string, unknown>)['amountMinor'] = null;
    await reactor.handle(event);
    expect(issued).toEqual([]);
  });

  /*
    An unassigned call-out has no business to invoice on behalf of. Better
    to log and stop than to put somebody's fiscal identity on a supply
    they did not make.
  */
  it('does not invoice a call-out with no supplier', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(assistanceCharged({ supplierId: null }));
    expect(issued).toEqual([]);
  });

  /*
    `buyerName: p.clientAccountId` is what every facture this platform has
    issued was addressed to. On a tax document the buyer is one of the
    parties it attests, so a UUID there is not a cosmetic problem.
  */
  it('addresses the buyer by name', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(orderEvent('completed'));
    expect(issued[0]['buyerName']).toBe('Riyad Benali');
  });

  it('falls back to the account id when there is no name to use', async () => {
    for (const parties of [
      null,
      { partyFor: async () => null } as unknown as PartyDirectoryPort,
      {
        partyFor: async () => ({ accountId: 'acc-1', name: '  ', phone: null }),
      } as unknown as PartyDirectoryPort,
      {
        partyFor: async () => {
          throw new Error('identity down');
        },
      } as unknown as PartyDirectoryPort,
    ]) {
      const { reactor, issued } = harness({ parties });
      await reactor.handle(orderEvent('completed'));
      expect(issued[0]['buyerName']).toBe('acc-1');
    }
  });

  /*
    `brake_service` is a database value. A customer keeping this document
    should read "Freinage du 10/11/2026".
  */
  it('describes the line in words, not in keys', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(reservationCharged());
    expect((issued[0]['lines'] as Array<{ description: string }>)[0].description).toBe(
      'Freinage du 10/11/2026',
    );
  });

  it('still issues when the catalogue cannot name the service', async () => {
    const { reactor, issued } = harness({ services: null });
    await reactor.handle(reservationCharged());
    expect((issued[0]['lines'] as Array<{ description: string }>)[0].description).toBe(
      'brake_service du 10/11/2026',
    );
  });

  it('names the kind of assistance in French', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(assistanceCharged({ serviceType: 'battery' }));
    expect((issued[0]['lines'] as Array<{ description: string }>)[0].description).toBe(
      'Assistance — batterie',
    );
  });

  /*
    The quoted or charged figure is the price the client agreed to pay, so
    it reaches the facture as a TTC unit price and HT/TVA are derived
    backwards from it. Passing it as HT would inflate every bill by 19%.
  */
  it('passes the agreed amount through as a TTC line', async () => {
    const { reactor, issued } = harness();
    await reactor.handle(orderEvent('completed'));
    expect(issued[0]).toMatchObject({
      currency: 'DZD',
      lines: [{ quantity: 1, unitTtcMinor: 1_190_000 }],
    });
  });

  /*
    At-least-once delivery makes a redelivered event a matter of time. The
    unique index on (type, subject_type, subject_id) is the real defence —
    and it is subject-type agnostic, so it already covers all three. The
    reactor must treat it as expected so the message is acked rather than
    retried forever.
  */
  it('treats the duplicate index as expected, not as failure', async () => {
    const { reactor } = harness({
      issueInvoice: async () => {
        throw new Error(
          'duplicate key value violates unique constraint "documents_one_invoice_per_subject"',
        );
      },
    });
    await expect(reactor.handle(reservationCharged())).resolves.toBeUndefined();
  });

  it('rethrows anything else', async () => {
    const { reactor } = harness({
      issueInvoice: async () => {
        throw new Error('storage unreachable');
      },
    });
    await expect(reactor.handle(assistanceCharged())).rejects.toThrow('storage unreachable');
  });

  /*
    A marketplace car sale is between two private individuals. We are the
    classifieds, not the seller, and a numbered facture out of OUR fiscal
    series for their transaction would be inventing a tax document for a
    supply we are not party to. If a commission is ever taken, THAT is the
    paid interaction and it gets a reader of its own.
  */
  it('issues nothing for events it does not know', async () => {
    const { reactor, issued } = harness();
    for (const type of [
      'marketplace.BidAccepted',
      'marketplace.ListingSold',
      'social.PostPublished',
    ]) {
      await reactor.handle({
        type,
        payload: { amountMinor: 5_000_000, currency: 'DZD', supplierId: 'sup-1' },
      } as unknown as DomainEvent);
    }
    expect(issued).toEqual([]);
  });

  it('subscribes to every paid interaction it knows, and only those', async () => {
    const subscribed: string[] = [];
    const bus = {
      subscribe: async (type: string) => {
        subscribed.push(type);
      },
    } as unknown as EventBus;
    const reactor = new FactureReactor(
      bus,
      { issueInvoice: async () => ({}) as unknown as DocumentDTO } as unknown as DocumentsPort,
      { sellerFor: async () => COMPLETE_SELLER } as unknown as SellerIdentityPort,
      null,
      null,
    );
    await reactor.onApplicationBootstrap();
    expect(subscribed.sort()).toEqual([
      'assistance.AssistanceCharged',
      'orders.OrderStatusChanged',
      'reservations.ReservationCharged',
    ]);
  });
});
