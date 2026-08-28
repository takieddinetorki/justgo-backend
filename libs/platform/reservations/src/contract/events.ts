export const RESERVATION_REQUESTED = 'reservations.ReservationRequested';
export interface ReservationRequestedV1 {
  reservationId: string;
  clientAccountId: string;
  supplierId: string;
  serviceTypeKey: string;
  slotStart: string;
}

export const RESERVATION_STATUS_CHANGED = 'reservations.ReservationStatusChanged';
export interface ReservationStatusChangedV1 {
  reservationId: string;
  clientAccountId: string;
  supplierId: string;
  from: string;
  to: string;
}
