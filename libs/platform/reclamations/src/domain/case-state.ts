import { ConflictError } from '@justgo/kernel';
import type { CaseStatus } from '../contract/dto';

/**
 * Complaint lifecycle.
 *
 *   open -> under_review -> resolved | rejected
 *   open | under_review  -> withdrawn
 *
 * `rejected` is kept distinct from `resolved` deliberately. A single `closed`
 * state would make "we fixed it" and "we did not agree with you" the same
 * fact, and those are the two things anyone reading a complaint history
 * actually needs to tell apart — including a regulator.
 *
 * `withdrawn` is the claimant's own exit. It is not `rejected`: nobody
 * decided against them.
 */
const ALLOWED: Record<CaseStatus, CaseStatus[]> = {
  open: ['under_review', 'resolved', 'rejected', 'withdrawn'],
  under_review: ['resolved', 'rejected', 'withdrawn'],
  resolved: [],
  rejected: [],
  withdrawn: [],
};

/** The states that close a case and therefore demand a stated reason. */
export const CLOSING: readonly CaseStatus[] = ['resolved', 'rejected'];

export function assertCaseTransition(current: CaseStatus, next: CaseStatus): CaseStatus {
  if (!ALLOWED[current].includes(next)) {
    throw new ConflictError(
      'ILLEGAL_CASE_TRANSITION',
      `Cannot move a complaint from "${current}" to "${next}"`,
      { current, next, allowed: ALLOWED[current] },
    );
  }
  return next;
}

export function isOpenCase(status: CaseStatus): boolean {
  return ALLOWED[status].length > 0;
}
