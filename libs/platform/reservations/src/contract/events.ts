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
}
