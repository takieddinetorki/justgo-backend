import {
  MILEAGE_UPDATE_PERIOD_DAYS,
  mileageDueAt,
  mileageGoesBackwards,
} from './mileage';

/**
 * The monotonic rule, and the one case where equal has to be allowed.
 *
 * The app retries a mileage confirmation with the SAME value when the
 * first attempt was interrupted — a dropped connection, a backgrounded
 * app. Rejecting equal would make that retry fail and leave the user
 * looking at an error for a reading that was already correct, so
 * "cannot go backwards" is strictly lower-than, not less-than-or-equal.
 */
describe('a mileage reading', () => {
  it('cannot go backwards', () => {
    expect(mileageGoesBackwards(15_000, 14_999)).toBe(true);
    expect(mileageGoesBackwards(15_000, 0)).toBe(true);
  });

  it('may be stated again unchanged, because the app retries', () => {
    expect(mileageGoesBackwards(15_000, 15_000)).toBe(false);
  });

  it('may go up', () => {
    expect(mileageGoesBackwards(15_000, 15_001)).toBe(false);
  });

  /*
    A car added with no mileage has nothing for the first reading to be
    lower than. Treating null as 0 would be the same answer by luck;
    treating it as "no constraint" is the same answer on purpose.
  */
  it('has nothing to be lower than when the car has no reading yet', () => {
    expect(mileageGoesBackwards(null, 0)).toBe(false);
    expect(mileageGoesBackwards(null, 250_000)).toBe(false);
  });

  it('falls due a period after it was taken', () => {
    const due = mileageDueAt('2026-11-11T09:00:00.000Z');
    expect(due).toBe('2026-12-11T09:00:00.000Z');
    expect(MILEAGE_UPDATE_PERIOD_DAYS).toBe(30);
  });

  it('accepts a Date as readily as an ISO string', () => {
    expect(mileageDueAt(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-31T00:00:00.000Z');
  });
});
