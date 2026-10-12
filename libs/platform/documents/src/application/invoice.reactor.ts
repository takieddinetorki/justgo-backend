import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import { SELLER_IDENTITY_PORT, type SellerIdentityPort } from '@justgo/contracts';
import { DOCUMENTS_PORT, type DocumentsPort } from '../contract/documents.port';

/** orders.OrderCreated — consumed by name, not by importing orders. */
const ORDER_CREATED = 'orders.OrderCreated';

interface OrderCreatedPayload {
  orderId: string;
  clientAccountId: string;
  supplierId: string;
  amountMinor: number | null;
  currency: string | null;
}

/**
 * Issues a *facture* when an order is created.
 *
 * WHY AT CREATION rather than completion. The order exists because the
 * client accepted a quote — that is the moment the sale is concluded and
 * the price is fixed. Invoicing on completion would be defensible too,
 * but nothing in the product currently advances an order past `created`:
 * there is no endpoint that sets `completed`, so an invoice waiting for
 * it would never be issued at all.
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
    await this.bus.subscribe(ORDER_CREATED, (e) => this.handle(e));
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as unknown as OrderCreatedPayload;

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
