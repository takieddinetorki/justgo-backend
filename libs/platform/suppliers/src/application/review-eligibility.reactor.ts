import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import { asId, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { REVIEWS_PORT, type ReviewsPort } from '../contract/suppliers.port';

/**
 * Consumed by NAME, not by importing orders or reservations.
 *
 * A review has to be earned by a completed dealing, and the record of that
 * lives in two other modules' schemas which this one may never read (§17.4).
 * Subscribing to the event and keeping the answer here is what lets
 * `mayReview` be a single indexed lookup inside `suppliers` instead of a
 * cross-schema join — and it keeps the dependency pointing the right way: we
 * depend on a string, not on a package.
 */
const ORDER_STATUS_CHANGED = 'orders.OrderStatusChanged';
const RESERVATION_STATUS_CHANGED = 'reservations.ReservationStatusChanged';

interface StatusChangedPayload {
  orderId?: string;
  reservationId?: string;
  clientAccountId: string;
  supplierId: string;
  to: string;
}

@Injectable()
export class ReviewEligibilityReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReviewEligibilityReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(REVIEWS_PORT) private readonly reviews: ReviewsPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe(ORDER_STATUS_CHANGED, (e) => this.handle(e, 'order'));
    await this.bus.subscribe(RESERVATION_STATUS_CHANGED, (e) => this.handle(e, 'reservation'));
  }

  async handle(event: DomainEvent, source: 'order' | 'reservation'): Promise<void> {
    const p = event.payload as unknown as StatusChangedPayload;
    /*
      Only `completed`. A cancelled order is a dealing that did not happen,
      and an accepted-but-not-yet-done reservation is one that has not
      happened YET — reviewing either would be reviewing an expectation.
    */
    if (p.to !== 'completed') return;

    const sourceId = p.orderId ?? p.reservationId;
    if (!sourceId || !p.clientAccountId || !p.supplierId) {
      this.logger.warn(`${event.type} ${event.id}: incomplete payload; eligibility not recorded`);
      return;
    }

    // Idempotent on (account, supplier, source, sourceId) — at-least-once
    // delivery must not look like a second completed dealing.
    await this.reviews.recordEligibility({
      accountId: asId<AccountId>(p.clientAccountId),
      supplierId: asId<SupplierId>(p.supplierId),
      source,
      sourceId: asId<Uuid>(sourceId),
    });
    this.logger.log(`${p.clientAccountId} may now review ${p.supplierId} (${source})`);
  }
}
