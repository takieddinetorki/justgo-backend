import { ConflictError } from '@justgo/kernel';
import type { ReservationStatus } from '../contract/dto';

/**
 * Reservation lifecycle (§8.3):
 *   pending → accepted | rejected | rescheduled
 *   rescheduled → accepted | rejected | cancelled
 *   accepted → completed | cancelled
 * Slots are held while pending/accepted/rescheduled (see the partial unique
 * index); rejected/cancelled free them.
 */
const ALLOWED: Record<ReservationStatus, ReservationStatus[]> = {
  pending: ['accepted', 'rejected', 'rescheduled', 'cancelled'],
  rescheduled: ['accepted', 'rejected', 'cancelled'],
  accepted: ['completed', 'cancelled'],
  rejected: [],
  completed: [],
  cancelled: [],
};

export function assertReservationTransition(
  current: ReservationStatus,
  next: ReservationStatus,
): ReservationStatus {
  if (!ALLOWED[current].includes(next)) {
    throw new ConflictError(
      'ILLEGAL_RESERVATION_TRANSITION',
      `Cannot move a reservation from "${current}" to "${next}"`,
      { current, next, allowed: ALLOWED[current] },
    );
  }
  return next;
}

export function isTerminalReservation(status: ReservationStatus): boolean {
  return ALLOWED[status].length === 0;
}
