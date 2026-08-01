import { ConflictError } from '@justgo/kernel';
import { assertOrderTransition, isTerminalOrder } from './order-state';
import type { OrderStatus } from '../contract/dto';

describe('order state machine (§8.2)', () => {
  it('walks created → confirmed → in_progress → completed', () => {
    expect(assertOrderTransition('created', 'confirmed')).toBe('confirmed');
    expect(assertOrderTransition('confirmed', 'in_progress')).toBe('in_progress');
    expect(assertOrderTransition('in_progress', 'completed')).toBe('completed');
  });

  it('allows cancellation from any live state', () => {
    for (const s of ['created', 'confirmed', 'in_progress'] as OrderStatus[]) {
      expect(assertOrderTransition(s, 'cancelled')).toBe('cancelled');
    }
  });

  it('rejects skipping ahead', () => {
    expect(() => assertOrderTransition('created', 'completed')).toThrow(ConflictError);
    expect(() => assertOrderTransition('created', 'in_progress')).toThrow(ConflictError);
  });

  it('never moves out of a terminal state', () => {
    for (const s of ['completed', 'cancelled'] as OrderStatus[]) {
      expect(isTerminalOrder(s)).toBe(true);
      expect(() => assertOrderTransition(s, 'confirmed')).toThrow(ConflictError);
    }
  });

  it('reports a stable code with the allowed set', () => {
    try {
      assertOrderTransition('completed', 'cancelled');
      throw new Error('expected ConflictError');
    } catch (error) {
      const e = error as ConflictError;
      expect(e.code).toBe('ILLEGAL_ORDER_TRANSITION');
      expect(e.httpStatus).toBe(409);
      expect(e.details).toMatchObject({ current: 'completed', allowed: [] });
    }
  });
});
