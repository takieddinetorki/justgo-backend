import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import { DOCUMENTS_PORT, type DocumentsPort } from '../contract/documents.port';

/** reservations.* — consumed by name, not by importing reservations. */
const RESERVATION_STATUS_CHANGED = 'reservations.ReservationStatusChanged';

interface StatusChangedPayload {
  reservationId: string;
  clientAccountId: string;
  supplierId: string;
  from: string;
  to: string;
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
 */
@Injectable()
export class ReservationDocumentReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReservationDocumentReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(DOCUMENTS_PORT) private readonly documents: DocumentsPort,
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
      payload: {
        Réservation: p.reservationId,
        Statut: 'Confirmée',
        Prestataire: p.supplierId,
        Client: p.clientAccountId,
      },
    });
    this.logger.log(`issued ${doc.number} for reservation ${p.reservationId}`);
  }
}
