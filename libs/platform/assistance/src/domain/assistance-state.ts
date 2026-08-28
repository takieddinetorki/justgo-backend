import { ConflictError } from '@justgo/kernel';
import type { AssistanceStatus } from '../contract/dto';

/** Roadside assistance lifecycle: requested → dispatched → en_route →
 *  completed; any live state → cancelled. */
const ALLOWED: Record<AssistanceStatus, AssistanceStatus[]> = {
  requested: ['dispatched', 'cancelled'],
  dispatched: ['en_route', 'cancelled'],
  en_route: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function assertAssistanceTransition(
  current: AssistanceStatus,
  next: AssistanceStatus,
): AssistanceStatus {
  if (!ALLOWED[current].includes(next)) {
    throw new ConflictError(
      'ILLEGAL_ASSISTANCE_TRANSITION',
      `Cannot move assistance from "${current}" to "${next}"`,
      { current, next, allowed: ALLOWED[current] },
    );
  }
  return next;
}
