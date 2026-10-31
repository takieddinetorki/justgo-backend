import { ValidationError } from '@justgo/kernel';
import type { OpeningHoursDTO, OpeningIntervalDTO, Weekday } from '../contract/dto';

export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes since midnight, for comparing two `HH:MM` strings. */
function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Validates opening hours.
 *
 * The column is jsonb, so Postgres will store literally anything — which
 * means the only thing standing between a client typo and a shop that
 * appears to open at 99:99 is this function. It is a domain rule, not
 * controller plumbing: "closes before it opens" is wrong regardless of which
 * route the value arrived on, and branches use the same shape.
 *
 * `null` is a valid value and means "hours not published", which is
 * different from a day with an empty list (open on no interval: closed).
 */
export function assertOpeningHours(hours: OpeningHoursDTO | null | undefined): void {
  if (hours === null || hours === undefined) return;

  for (const [day, intervals] of Object.entries(hours)) {
    if (!WEEKDAYS.includes(day as Weekday)) {
      throw new ValidationError(`"${day}" is not a weekday`, { expected: WEEKDAYS });
    }
    if (!Array.isArray(intervals)) {
      throw new ValidationError(`Hours for ${day} must be a list of intervals`);
    }
    if (intervals.length > 4) {
      throw new ValidationError(`${day} has more than four opening intervals`);
    }

    const sorted = [...(intervals as OpeningIntervalDTO[])].sort(
      (a, b) => minutes(a?.from ?? '') - minutes(b?.from ?? ''),
    );
    let previousEnd = -1;
    for (const interval of sorted) {
      if (!HHMM.test(interval?.from ?? '') || !HHMM.test(interval?.to ?? '')) {
        throw new ValidationError(`${day} has an interval that is not HH:MM`, { interval });
      }
      const from = minutes(interval.from);
      const to = minutes(interval.to);
      /*
        Equal is rejected along with inverted. A zero-length interval reads
        as "open at 09:00 and closed at 09:00", which no UI can render as
        anything useful, and is almost always a half-finished edit.
      */
      if (to <= from) {
        throw new ValidationError(`${day}: ${interval.from}–${interval.to} ends before it starts`);
      }
      // Overlaps are rejected rather than merged: silently joining two
      // intervals would hide a typo (14:00 meant as 16:00) behind a shop
      // that now claims to be open all afternoon.
      if (from < previousEnd) {
        throw new ValidationError(`${day} has overlapping opening intervals`);
      }
      previousEnd = to;
    }
  }
}

/**
 * lat and lng are one fact in two numbers.
 *
 * One without the other is not half a location, it is a point somewhere on
 * the equator or the prime meridian — so the pair moves together, and
 * sending both as null is how a business drops its pin.
 */
export function assertCoordinatePair(
  lat: number | null | undefined,
  lng: number | null | undefined,
): void {
  if ((lat === undefined) !== (lng === undefined)) {
    throw new ValidationError('lat and lng must be provided together');
  }
  if ((lat === null) !== (lng === null)) {
    throw new ValidationError('lat and lng must be cleared together');
  }
}
