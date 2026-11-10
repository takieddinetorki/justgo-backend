import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import {
  PARTY_DIRECTORY_PORT,
  SELLER_IDENTITY_PORT,
  SERVICE_CATALOG_PORT,
  VEHICLE_DIRECTORY_PORT,
  type PartyDirectoryPort,
  type SellerIdentityPort,
  type ServiceCatalogPort,
  type VehicleDirectoryPort,
} from '@justgo/contracts';
import { DOCUMENTS_PORT, type DocumentsPort } from '../contract/documents.port';

/** reservations.* — consumed by name, not by importing reservations. */
const RESERVATION_STATUS_CHANGED = 'reservations.ReservationStatusChanged';

interface StatusChangedPayload {
  reservationId: string;
  clientAccountId: string;
  supplierId: string;
  from: string;
  to: string;
  serviceTypeKey?: string;
  slotStart?: string;
  slotEnd?: string;
  vehicleId?: string | null;
}

/**
 * Issues a confirmation when a reservation is accepted.
 *
 * Event-driven rather than a direct port call from `reservations`, for
 * two reasons. Architecturally, it keeps the dependency one-way:
 * documents knows the event's NAME and nothing else, and reservations
 * has no idea documents exists. Practically, it sidesteps the injector
 * trap that silently killed fan-out — a port exported by a
 * non-global module is invisible to the module that wants it.
 *
 * Issuance is idempotent at the series level only, so a redelivered
 * event would mint a second confirmation with a new number. That is
 * acceptable for a confirmation and would NOT be for an invoice; a
 * fiscal type needs a uniqueness guard on (subject_type, subject_id)
 * before it is wired up.
 *
 * WHAT IT PRINTS. The payload is frozen into the document and is the
 * only thing a holder, or a verifier, ever sees of it. It used to be
 * four UUIDs — "Client: 4ab5bb55-1119-…" where a name belongs — which
 * made the confirmation unreadable on paper and made a scan of it
 * unable to say anything worth comparing. The names are resolved here,
 * through the composition root's seams (§21.1), and every one of them
 * degrades to the id rather than failing issuance: a confirmation that
 * exists with a plain id on it beats no confirmation at all.
 */
@Injectable()
export class ReservationDocumentReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReservationDocumentReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(DOCUMENTS_PORT) private readonly documents: DocumentsPort,
    /*
      Optional on purpose: this reactor is constructed in tests and in
      the workers process, where the composition root's directory seams
      are not necessarily bound. A missing directory costs a label, not
      a document.
    */
    @Optional() @Inject(PARTY_DIRECTORY_PORT) private readonly parties?: PartyDirectoryPort,
    @Optional() @Inject(SELLER_IDENTITY_PORT) private readonly sellers?: SellerIdentityPort,
    @Optional() @Inject(SERVICE_CATALOG_PORT) private readonly services?: ServiceCatalogPort,
    @Optional() @Inject(VEHICLE_DIRECTORY_PORT) private readonly vehicles?: VehicleDirectoryPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe(RESERVATION_STATUS_CHANGED, (e) => this.handle(e));
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as unknown as StatusChangedPayload;
    if (p.to !== 'accepted') return;

    const doc = await this.documents.issue({
      type: 'reservation_confirmation',
      subjectType: 'reservation',
      subjectId: p.reservationId,
      issuedToAccountId: p.clientAccountId,
      supplierId: p.supplierId,
      payload: await this.describe(p),
    });
    this.logger.log(`issued ${doc.number} for reservation ${p.reservationId}`);
  }

  /**
   * The frozen contents of the confirmation, in the order they print.
   *
   * Every lookup is wrapped: a directory that is slow, down, or simply
   * does not know degrades that one line to the raw id. The reference
   * stays on the document regardless, because it is what support asks
   * for when the rest of the page is in doubt.
   */
  private async describe(p: StatusChangedPayload): Promise<Record<string, unknown>> {
    const [client, workshop, service, vehicle] = await Promise.all([
      this.safely(() => this.parties?.partyFor(p.clientAccountId)),
      this.safely(() => this.sellers?.sellerFor(p.supplierId)),
      this.safely(() => (p.serviceTypeKey ? this.services?.getServiceType(p.serviceTypeKey) : undefined)),
      this.safely(() =>
        p.vehicleId ? this.vehicles?.vehicleFor(p.clientAccountId, p.vehicleId) : undefined,
      ),
    ]);

    const out: Record<string, unknown> = {
      Statut: 'Confirmée',
      Prestataire: workshop?.legalName ?? p.supplierId,
      Client: client?.name ?? p.clientAccountId,
    };
    if (client?.phone) out['Téléphone'] = client.phone;
    /*
      French label where there is one, then the key. A key is still
      readable — `brake_service` tells a mechanic what is booked — and
      is far better than dropping the line because the catalogue was
      unreachable for a second.
    */
    if (p.serviceTypeKey) {
      out['Prestation'] = service?.labelI18n?.['fr'] ?? service?.labelI18n?.['en'] ?? p.serviceTypeKey;
    }
    if (p.slotStart) out['Rendez-vous'] = formatSlot(p.slotStart, p.slotEnd);
    if (vehicle) {
      const name = [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(' ');
      if (name) out['Véhicule'] = name;
      if (vehicle.plate) out['Immatriculation'] = vehicle.plate;
      if (vehicle.vin) out['VIN'] = vehicle.vin;
    }
    out['Réservation'] = p.reservationId;
    return out;
  }

  private async safely<T>(fn: () => Promise<T> | undefined): Promise<T | null> {
    try {
      return (await fn()) ?? null;
    } catch (error) {
      this.logger.warn(`confirmation detail unavailable: ${(error as Error).message}`);
      return null;
    }
  }
}

/**
 * `10/11/2026 23:12 – 00:12`, in UTC.
 *
 * Deliberately NOT localised to a timezone here. The slot is stored and
 * compared in UTC everywhere else in the system, and a document that
 * silently shifts by an hour depending on where it was rendered is a
 * document whose times cannot be trusted against the booking.
 */
function formatSlot(startIso: string, endIso?: string): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return startIso;
  const dd = String(start.getUTCDate()).padStart(2, '0');
  const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(start.getUTCHours()).padStart(2, '0');
  const mi = String(start.getUTCMinutes()).padStart(2, '0');
  const head = `${dd}/${mm}/${start.getUTCFullYear()} ${hh}:${mi}`;
  if (!endIso) return head;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return head;
  const eh = String(end.getUTCHours()).padStart(2, '0');
  const em = String(end.getUTCMinutes()).padStart(2, '0');
  return `${head} - ${eh}:${em}`;
}
