import { ConflictError } from '@justgo/kernel';
import { assertAssistanceTransition } from './assistance-state';
import type { AssistanceStatus } from '../contract/dto';

describe('assistance state machine', () => {
  it('walks requested to dispatched to en_route to completed', () => {
    expect(assertAssistanceTransition('requested', 'dispatched')).toBe('dispatched');
    expect(assertAssistanceTransition('dispatched', 'en_route')).toBe('en_route');
    expect(assertAssistanceTransition('en_route', 'completed')).toBe('completed');
  });
  it('cancels from any live state but not terminal', () => {
    for (const s of ['requested', 'dispatched', 'en_route'] as AssistanceStatus[]) {
      expect(assertAssistanceTransition(s, 'cancelled')).toBe('cancelled');
    }
    expect(() => assertAssistanceTransition('completed', 'cancelled')).toThrow(ConflictError);
  });
  it('rejects skipping ahead', () => {
    expect(() => assertAssistanceTransition('requested', 'completed')).toThrow(ConflictError);
  });
});
