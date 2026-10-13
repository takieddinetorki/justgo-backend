import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import { SELLER_IDENTITY_PORT, type SellerIdentityPort } from '@justgo/contracts';
import { DOCUMENTS_PORT, type DocumentsPort } from '../contract/documents.port';

/** orders.OrderStatusChanged — consumed by name, not by importing orders. */
const ORDER_STATUS_CHANGED = 'orders.OrderStatusChanged';

interface OrderStatusChangedPayload {
  orderId: string;
  clientAccountId: string;
  supplierId: string;
  from: string;
  to: string;
  amountMinor: number | null;
  currency: string | null;
}

/**
 * Issues a *facture* when an order COMPLETES.
 *
 * It used to issue on creation, for a bad reason: no endpoint advanced an
 * order past `created`, so an invoice waiting for completion would never
 * have been issued at all. `PATCH /v1/orders/{id}/status` closes that, and
 * completion is the right trigger — a facture attests a supply that
 * happened, and an order can still be cancelled after it is created. Issuing
 * at creation meant every abandoned order left a numbered invoice in a
 * gapless fiscal series, which cannot be deleted and now has to be voided by
 * hand.
 *
 * Only the transition INTO `completed` issues. `completed` is terminal and
 * the transition is taken under a row lock, so exactly one caller can ever
 * win it.
 *
 * REFUSES SILENTLY-ISH rather than emitting a broken invoice. If the
 * seller has not supplied its fiscal identifiers, or the order carries
 * no amount, this logs and stops. A facture without a NIF is not a tax
 * document, and handing the client one that merely looks official is
 * worse than handing them nothing.
 *
 * Duplicate protection is in the DATABASE, not here: a unique index on
 * (type, subject_type, subject_id) for invoices. At-least-once delivery
 * makes a redelivered event a matter of time, and two factures for one
 * sale is tax fraud by accident.
 */
@Injectable()
export class InvoiceReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(InvoiceReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(DOCUMENTS_PORT) private readonly documents: DocumentsPort,
    @Inject(SELLER_IDENTITY_PORT) private readonly sellers: SellerIdentityPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe(ORDER_STATUS_CHANGED, (e) => this.handle(e));
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as unknown as OrderStatusChangedPayload;

    // Every other transition is somebody else's business.
    if (p.to !== 'completed') return;

    if (p.amountMinor === null || !p.currency) {
      this.logger.warn(`order ${p.orderId}: no amount — cannot invoice`);
      return;
    }

    const seller = await this.sellers.sellerFor(p.supplierId);
    if (!seller) {
      this.logger.warn(`order ${p.orderId}: supplier ${p.supplierId} not found`);
      return;
    }

    const missing = (['legalName', 'nif', 'nis', 'rc', 'taxArticle'] as const).filter(
      (k) => !seller[k],
    );
    if (missing.length > 0) {
      this.logger.warn(
        `order ${p.orderId}: supplier ${p.supplierId} has no ${missing.join('/')} — ` +
          'invoice NOT issued. Complete the fiscal profile via PATCH /v1/supplier/fiscal.',
      );
      return;
    }

    try {
      const doc = await this.documents.issueInvoice({
        subjectType: 'order',
        subjectId: p.orderId,
        issuedToAccountId: p.clientAccountId,
        supplierId: p.supplierId,
        seller: {
          legalName: seller.legalName as string,
          address: seller.address,
          city: seller.city,
          country: seller.country,
          nif: seller.nif as string,
          nis: seller.nis as string,
          rc: seller.rc as string,
          taxArticle: seller.taxArticle as string,
        },
        buyerName: p.clientAccountId,
        currency: p.currency,
        // One line until orders carry an itemised basket. The quoted
        // figure is the agreed price INCLUDING tax — see application/tax.ts.
        lines: [
          { description: `Commande ${p.orderId}`, quantity: 1, unitTtcMinor: p.amountMinor },
        ],
      });
      this.logger.log(`issued ${doc.number} for order ${p.orderId}`);
    } catch (error) {
      /*
        A duplicate is the unique index doing its job on a redelivered
        event — expected, not a failure. Anything else should surface.
      */
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('documents_one_invoice_per_subject')) {
        this.logger.log(`order ${p.orderId}: invoice already issued, ignoring redelivery`);
        return;
      }
      throw error;
    }
  }
}
