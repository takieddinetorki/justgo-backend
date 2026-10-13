import { ConflictError } from '@justgo/kernel';
import type { DriverDocumentKind, DriverStatus } from '../contract/dto';

/**
 * Driver verification lifecycle.
 *
 *   draft -> pending_review -> verified | rejected
 *   rejected -> pending_review        (fix the photo and resubmit)
 *   verified -> suspended -> pending_review
 *
 * `rejected` and `suspended` are deliberately distinct. Rejected means we
 * never accepted this person; suspended means we did and have stopped
 * trusting it — an expired licence, or a complaint upheld against them.
 * Collapsing the two would lose whether someone ever passed a check at all,
 * which is exactly what anyone investigating an incident needs to know.
 *
 * There is no path back to `draft`. A profile that has been looked at has a
 * history, and returning it to draft would imply it never was.
 */
const ALLOWED: Record<DriverStatus, DriverStatus[]> = {
  draft: ['pending_review'],
  pending_review: ['verified', 'rejected'],
  verified: ['suspended'],
  rejected: ['pending_review'],
  suspended: ['pending_review'],
};

export function assertDriverTransition(current: DriverStatus, next: DriverStatus): DriverStatus {
  if (!ALLOWED[current].includes(next)) {
    throw new ConflictError(
      'ILLEGAL_DRIVER_TRANSITION',
      `Cannot move a driver from "${current}" to "${next}"`,
      { current, next, allowed: ALLOWED[current] },
    );
  }
  return next;
}

/**
 * What a reviewer needs before a decision is possible.
 *
 * The licence front proves the person holds one; the selfie is what ties the
 * licence to whoever is holding the phone. Without BOTH, "verified" would
 * mean only that someone photographed a licence — not necessarily their own.
 *
 * `licence_back` and `id_card` are accepted but not demanded: the back of an
 * Algerian permis carries the categories, which matters for a tow truck and
 * not for a car, and that distinction is a dispatch rule we do not have yet.
 *
 * A PLAIN ARRAY, never a Set. SWC's loose downlevelling turns a Set spread
 * into `[].concat(set)` — appending the object instead of its members — and
 * the gate would silently accept an empty submission in the bundle only.
 */
export const REQUIRED_DOCUMENTS: readonly DriverDocumentKind[] = ['licence_front', 'selfie'];

export function missingDocuments(present: readonly DriverDocumentKind[]): DriverDocumentKind[] {
  return REQUIRED_DOCUMENTS.filter((kind) => !present.includes(kind));
}

/** Is this licence still valid on the given day? */
export function licenceExpired(expiresOn: string | null, today = new Date()): boolean {
  if (!expiresOn) return false; // unknown is not the same as expired
  // Compare dates, not instants: a licence expires on a day.
  return expiresOn < today.toISOString().slice(0, 10);
}
