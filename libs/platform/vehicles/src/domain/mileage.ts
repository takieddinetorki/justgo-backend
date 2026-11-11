/**
 * The mileage rules, in one place.
 *
 * Two of them, and both are about trust rather than arithmetic:
 *
 *  - A reading may not go DOWN. Mileage is monotonic in the real world, so
 *    a lower number is either a typo or someone making a car look less
 *    used than it is. Equal is allowed, because the app retries the same
 *    value when a confirmation was interrupted and a retry must not fail.
 *  - A reading goes STALE after 30 days. Everything the platform decides
 *    about a car — what service it is due, what parts fit the wear it has
 *    — is computed from a number the owner typed in, and a number from
 *    eight months ago is not a fact about the car any more.
 *
 * The staleness comparison itself is deliberately NOT done here. It runs
 * in SQL against the database clock (`mileage_updated_at <= now() -
 * interval '30 days'`), because the alternative is comparing a timestamp
 * from Postgres with `Date.now()` on whichever API container answered —
 * and those two clocks are not the same clock. A few seconds of drift
 * decides whether a user is locked out, and it would decide differently
 * on each container.
 */

// Declared in the contract, because the app and the docs need them too.
export {
  MILEAGE_LOWER,
  MILEAGE_UPDATE_PERIOD_DAYS,
  MILEAGE_UPDATE_REQUIRED,
} from '../contract/dto';
import { MILEAGE_UPDATE_PERIOD_DAYS } from '../contract/dto';

/**
 * Is this a reading we can accept over the one we hold?
 *
 * `current === null` is a car added without a mileage, so the first
 * reading has nothing to be lower than.
 */
export function mileageGoesBackwards(current: number | null, next: number): boolean {
  return current !== null && next < current;
}

/**
 * When a reading taken at `updatedAt` falls due.
 *
 * Only for telling the user *when*, never for deciding whether — see the
 * note above about clocks.
 */
export function mileageDueAt(updatedAt: Date | string): string {
  const base = typeof updatedAt === 'string' ? new Date(updatedAt) : updatedAt;
  return new Date(base.getTime() + MILEAGE_UPDATE_PERIOD_DAYS * 86_400_000).toISOString();
}
