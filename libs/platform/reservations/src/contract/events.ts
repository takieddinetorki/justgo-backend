export const RESERVATION_REQUESTED = 'reservations.ReservationRequested';
export interface ReservationRequestedV1 {
  reservationId: string;
  clientAccountId: string;
  supplierId: string;
  serviceTypeKey: string;
  slotStart: string;
}

export const RESERVATION_STATUS_CHANGED = 'reservations.ReservationStatusChanged';
/**
 * CARRIES THE BOOKING, not just the ids of its parties.
 *
 * `documents` issues the confirmation off this event and may not read
 * the reservations schema to find out what was booked (17.4). With only
 * ids on the wire, the only thing it could print was ids, and the
 * confirmation a customer receives said "Reservation:
 * 4d2fa9fb-e168-4f54-9030-2bd10b973a0c" where the service and the
 * appointment belong.
 *
 * Added fields are optional on the way in so events already sitting in
 * the outbox, emitted before this shape existed, still handle cleanly.
 */
export interface ReservationStatusChangedV1 {
  reservationId: string;
  clientAccountId: string;
  supplierId: string;
  from: string;
  to: string;
  serviceTypeKey?: string;
  slotStart?: string;
  slotEnd?: string;
  vehicleId?: string | null;
  /** Present once the booking has been priced. */
  amountMinor?: number | null;
  currency?: string | null;
}

export const RESERVATION_CHARGED = 'reservations.ReservationCharged';
/**
 * A service was performed AND PRICED. The facture is issued off this.
 *
 * Separate from the status change on purpose. "Finished" and "paid for"
 * are different facts: a booking can be completed with no charge at all
 * (goodwill, warranty, a job that turned out not to be needed), and a
 * charge can be stated minutes after the completion rather than with it.
 * A consumer that has to tell those apart from a status transition ends
 * up re-deriving the amount from a stream that also carries rejections
 * and reschedules.
 *
 * `amountMinor` is always a positive integer here — a zero charge emits
 * nothing, because a facture for nothing is not a document anyone wants.
 */
export interface ReservationChargedV1 {
  reservationId: string;
  clientAccountId: string;
  supplierId: string;
  amountMinor: number;
  currency: string;
  serviceTypeKey: string;
  slotStart: string;
  slotEnd: string;
  vehicleId: string | null;
}
