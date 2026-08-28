import { ConflictError } from '@justgo/kernel';
import { assertReservationTransition, isTerminalReservation } from './reservation-state';
import type { ReservationStatus } from '../contract/dto';

describe('reservation state machine (§8.3)', () => {
  it('accepts, rejects, or reschedules a pending booking', () => {
    expect(assertReservationTransition('pending', 'accepted')).toBe('accepted');
    expect(assertReservationTransition('pending', 'rejected')).toBe('rejected');
    expect(assertReservationTransition('pending', 'rescheduled')).toBe('rescheduled');
  });

  it('completes or cancels only an accepted booking', () => {
    expect(assertReservationTransition('accepted', 'completed')).toBe('completed');
    expect(assertReservationTransition('accepted', 'cancelled')).toBe('cancelled');
    expect(() => assertReservationTransition('pending', 'completed')).toThrow(ConflictError);
  });

  it('lets a rescheduled booking be accepted or rejected', () => {
    expect(assertReservationTransition('rescheduled', 'accepted')).toBe('accepted');
    expect(assertReservationTransition('rescheduled', 'rejected')).toBe('rejected');
  });

  it('never reopens a terminal booking', () => {
    for (const s of ['rejected', 'completed', 'cancelled'] as ReservationStatus[]) {
      expect(isTerminalReservation(s)).toBe(true);
      expect(() => assertReservationTransition(s, 'accepted')).toThrow(ConflictError);
    }
  });

  it('reports a stable code on illegal transitions', () => {
    try {
      assertReservationTransition('completed', 'accepted');
      throw new Error('expected ConflictError');
    } catch (e) {
      const err = e as ConflictError;
      expect(err.code).toBe('ILLEGAL_RESERVATION_TRANSITION');
      expect(err.httpStatus).toBe(409);
    }
  });
});
