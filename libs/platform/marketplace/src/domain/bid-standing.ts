import { ValidationError } from '@justgo/kernel';

/** Where a bid fell against the seller's acceptance range. */
export type BidStanding = 'below_range' | 'in_range' | 'above_range';

export interface AcceptanceRange {
  minMinor: number;
  /** Null means "anything from the floor up". */
  maxMinor: number | null;
  currency: string;
}

/**
 * The rule the whole feature rests on.
 *
 * A seller names a range they would seriously consider. A bid that reaches it
 * is worth interrupting them for; a bid below it is not. THE SILENCE BELOW
 * THE FLOOR IS THE POINT — a seller pinged for every lowball stops reading
 * the pings, and then the one real offer arrives into a muted channel.
 *
 * ABOVE the range notifies too. That is not what "on the interval" literally
 * says, but a bid over the top is better news than the range asked for, and a
 * seller who was not told about the best offer they received would rightly
 * call that a bug. The upper bound exists to describe what the seller hoped
 * for, not to cap what they will hear about.
 *
 * Boundaries are INCLUSIVE at both ends: a seller who says "from 1 800 000"
 * means that number is acceptable, not that it just misses.
 */
export function standingOf(amountMinor: number, range: AcceptanceRange): BidStanding {
  if (amountMinor < range.minMinor) return 'below_range';
  if (range.maxMinor !== null && amountMinor > range.maxMinor) return 'above_range';
  return 'in_range';
}

/** Whether a bid of this standing should reach the seller. */
export function notifiesSeller(standing: BidStanding): boolean {
  return standing !== 'below_range';
}

export function assertRange(input: {
  minMinor: number;
  maxMinor?: number | null;
  currency: string;
}): AcceptanceRange {
  const { minMinor, currency } = input;
  const maxMinor = input.maxMinor ?? null;

  if (!Number.isSafeInteger(minMinor) || minMinor < 0) {
    throw new ValidationError('minAcceptable must be a non-negative integer in minor units');
  }
  if (maxMinor !== null && (!Number.isSafeInteger(maxMinor) || maxMinor < 0)) {
    throw new ValidationError('maxAcceptable must be a non-negative integer in minor units');
  }
  if (maxMinor !== null && maxMinor < minMinor) {
    throw new ValidationError('maxAcceptable cannot be below minAcceptable');
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('currency must be an ISO-4217 alpha-3 code');
  }
  return { minMinor, maxMinor, currency };
}
