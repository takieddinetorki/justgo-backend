import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import {
  PARTY_DIRECTORY_PORT,
  SELLER_IDENTITY_PORT,
  SERVICE_CATALOG_PORT,
  type PartyDirectoryPort,
  type SellerIdentityPort,
  type ServiceCatalogPort,
} from '@justgo/contracts';
import { DOCUMENTS_PORT, type DocumentsPort } from '../contract/documents.port';

/**
 * A facture for EVERY paid interaction, under one rule.
 *
 * It used to be one: an order completing. The platform's other two paid
 * interactions issued nothing at all, and not because the documents
 * pipeline was missing anything — there was simply no amount recorded to
 * build a facture from. A workshop finished a service, the client paid
 * at the counter, and the platform held a row that said `completed` and
 * nothing about money. Same for a tow.
 *
 * So the rule is stated once, here, and each paid interaction is a row
 * in the table below rather than a reactor of its own. Adding the next
 * one — a delivery fee, a subscription — is an entry, not a new class,
 * and it cannot accidentally be given different tax arithmetic or a
 * different idempotency story than the others.
 *
 * WHAT COUNTS AS A PAID INTERACTION. Money moving to a BUSINESS for a
 * supply it made. Deliberately not the marketplace: a private individual
 * selling their own car is not making a business supply, we are the
 * classifieds and not the seller, and issuing a numbered facture out of
 * our fiscal series for their sale would be inventing a tax document for
 * a transaction we are not party to. If a commission is ever taken on
 * those, THAT is the paid interaction and it gets a row here.
 *
 * WHEN. On the event that says the thing was priced, never on the one
 * that says it finished. A completion with no charge is a real outcome
 * (goodwill, warranty, a job that turned out unnecessary) and issuing a
 * 0,00 facture for it would burn a number out of a gapless series for a
 * document nobody wants. Orders are the exception only in shape: their
 * amount comes off the accepted quote, so their completion IS the
 * pricing event.
 *
 * REFUSES rather than emitting a broken facture. Missing fiscal
 * identifiers, no amount, no supplier — it logs and stops. A facture
 * without a NIF is not a tax document, and handing a client one that
 * merely looks official is worse than handing them nothing.
 *
 * Duplicate protection is in the DATABASE: a unique index on
 * (type, subject_type, subject_id) for invoices, which is subject-type
 * agnostic and therefore already covers all three. At-least-once
 * delivery makes a redelivered event a matter of time, and two factures
 * for one supply is tax fraud by accident.
 */

/** What any paid interaction boils down to, once its event is read. */
interface PaidSupply {
  /** `subject_type` on the document: what the facture is ABOUT. */
  subjectType: string;
  subjectId: string;
  clientAccountId: string;
  supplierId: string;
  amountMinor: number;
  currency: string;
  /** The single line description. Resolved labels where we have them. */
  describe: () => Promise<string>;
}

type Reader = (payload: Record<string, unknown>) => PaidSupply | null;

@Injectable()
export class FactureReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(FactureReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(DOCUMENTS_PORT) private readonly documents: DocumentsPort,
    @Inject(SELLER_IDENTITY_PORT) private readonly sellers: SellerIdentityPort,
    /*
      Optional, and degrading to the id, for the same reason the
      confirmation reactor's are: a facture that names the buyer by id is
      a worse document than one that names them, but it is a far better
      outcome than no facture for a supply that happened.
    */
    @Optional() @Inject(PARTY_DIRECTORY_PORT) private readonly parties: PartyDirectoryPort | null,
    @Optional() @Inject(SERVICE_CATALOG_PORT) private readonly services: ServiceCatalogPort | null,
  ) {}

  /**
   * Every paid interaction on the platform, by the event that prices it.
   *
   * Consumed BY NAME. `documents` imports nothing from orders,
   * reservations or assistance, and none of them know this exists.
   */
  private readers(): Record<string, Reader> {
    return {
      /*
        An order's amount comes off the accepted quote, so it is already
        known when the supply finishes — its completion is its pricing
        event, and there is no separate "charged" moment to wait for.
      */
      'orders.OrderStatusChanged': (p) => {
        if (p['to'] !== 'completed') return null;
        const amountMinor = p['amountMinor'];
        if (typeof amountMinor !== 'number' || amountMinor <= 0) return null;
        const orderId = String(p['orderId']);
        return {
          subjectType: 'order',
          subjectId: orderId,
          clientAccountId: String(p['clientAccountId']),
          supplierId: String(p['supplierId']),
          amountMinor,
          currency: String(p['currency'] ?? ''),
          describe: async () => `Commande ${orderId}`,
        };
      },

      'reservations.ReservationCharged': (p) => {
        const amountMinor = p['amountMinor'];
        if (typeof amountMinor !== 'number' || amountMinor <= 0) return null;
        const key = p['serviceTypeKey'] ? String(p['serviceTypeKey']) : null;
        return {
          subjectType: 'reservation',
          subjectId: String(p['reservationId']),
          clientAccountId: String(p['clientAccountId']),
          supplierId: String(p['supplierId']),
          amountMinor,
          currency: String(p['currency'] ?? ''),
          /*
            The LABEL, not the key. `brake_service` is a database value;
            "Freinage" is what belongs on a document a customer keeps.
          */
          describe: async () => {
            const label = key ? await this.serviceLabel(key) : null;
            const slot = p['slotStart'] ? formatDay(String(p['slotStart'])) : null;
            const base = label ?? key ?? 'Prestation';
            return slot ? `${base} du ${slot}` : base;
          },
        };
      },

      'assistance.AssistanceCharged': (p) => {
        const amountMinor = p['amountMinor'];
        if (typeof amountMinor !== 'number' || amountMinor <= 0) return null;
        const supplierId = p['supplierId'];
        // An unassigned call-out has nobody to invoice on behalf of.
        if (typeof supplierId !== 'string' || supplierId.length === 0) return null;
        const serviceType = String(p['serviceType'] ?? 'assistance');
        return {
          subjectType: 'assistance',
          subjectId: String(p['assistanceId']),
          clientAccountId: String(p['clientAccountId']),
          supplierId,
          amountMinor,
          currency: String(p['currency'] ?? ''),
          describe: async () => `Assistance — ${ASSISTANCE_FR[serviceType] ?? serviceType}`,
        };
      },
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const type of Object.keys(this.readers())) {
      await this.bus.subscribe(type, (e) => this.handle(e));
    }
  }

  async handle(event: DomainEvent): Promise<void> {
    const read = this.readers()[event.type];
    if (!read) return;

    const supply = read(event.payload as unknown as Record<string, unknown>);
    if (!supply) return;

    if (!supply.currency) {
      this.logger.warn(`${supply.subjectType} ${supply.subjectId}: no currency — cannot invoice`);
      return;
    }

    const seller = await this.sellers.sellerFor(supply.supplierId);
    if (!seller) {
      this.logger.warn(
        `${supply.subjectType} ${supply.subjectId}: supplier ${supply.supplierId} not found`,
      );
      return;
    }

    const missing = (['legalName', 'nif', 'nis', 'rc', 'taxArticle'] as const).filter(
      (k) => !seller[k],
    );
    if (missing.length > 0) {
      this.logger.warn(
        `${supply.subjectType} ${supply.subjectId}: supplier ${supply.supplierId} has no ` +
          `${missing.join('/')} — facture NOT issued. Complete the fiscal profile via ` +
          'PATCH /v1/supplier/fiscal.',
      );
      return;
    }

    try {
      const doc = await this.documents.issueInvoice({
        subjectType: supply.subjectType,
        subjectId: supply.subjectId,
        issuedToAccountId: supply.clientAccountId,
        supplierId: supply.supplierId,
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
        buyerName: await this.buyerName(supply.clientAccountId),
        currency: supply.currency,
        /*
          One line. The quoted or charged figure is the price the client
          agreed to pay, INCLUDING tax — see application/tax.ts for why
          HT and TVA are derived backwards out of it rather than added on
          top of it.
        */
        lines: [
          { description: await supply.describe(), quantity: 1, unitTtcMinor: supply.amountMinor },
        ],
      });
      this.logger.log(`issued ${doc.number} for ${supply.subjectType} ${supply.subjectId}`);
    } catch (error) {
      /*
        A duplicate is the unique index doing its job on a redelivered
        event — expected, not a failure. Anything else should surface.
      */
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('documents_one_invoice_per_subject')) {
        this.logger.log(
          `${supply.subjectType} ${supply.subjectId}: facture already issued, ignoring redelivery`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * The buyer's NAME, falling back to their account id.
   *
   * It used to be the account id unconditionally — `buyerName:
   * p.clientAccountId` — so every facture this platform has ever issued
   * is addressed to a UUID. That is not a cosmetic problem on a tax
   * document: the buyer is one of the parties it attests.
   */
  private async buyerName(accountId: string): Promise<string> {
    if (!this.parties) return accountId;
    try {
      const party = await this.parties.partyFor(accountId);
      return party?.name?.trim() || accountId;
    } catch {
      return accountId;
    }
  }

  private async serviceLabel(key: string): Promise<string | null> {
    if (!this.services) return null;
    try {
      const type = await this.services.getServiceType(key);
      const i18n = type?.labelI18n as Record<string, string> | undefined;
      return i18n?.['fr'] ?? i18n?.['en'] ?? null;
    } catch {
      return null;
    }
  }
}

/** Service keys as a customer should read them on a facture. */
const ASSISTANCE_FR: Record<string, string> = {
  breakdown: 'panne',
  tow: 'remorquage',
  battery: 'batterie',
  tyre: 'pneumatique',
  fuel: 'carburant',
  lockout: 'ouverture de porte',
};

/** dd/mm/yyyy in UTC — the same clock the slot was stored on. */
function formatDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
