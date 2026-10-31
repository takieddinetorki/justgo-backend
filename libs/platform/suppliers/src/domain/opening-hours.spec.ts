import { ValidationError } from '@justgo/kernel';
import { assertCoordinatePair, assertOpeningHours } from './opening-hours';

describe('opening hours', () => {
  it('accepts a day that shuts for lunch', () => {
    expect(() =>
      assertOpeningHours({
        mon: [
          { from: '09:00', to: '12:30' },
          { from: '14:00', to: '18:00' },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts null — hours not published is not the same as closed', () => {
    expect(() => assertOpeningHours(null)).not.toThrow();
    expect(() => assertOpeningHours(undefined)).not.toThrow();
  });

  it('accepts a day with no intervals, which means closed that day', () => {
    expect(() => assertOpeningHours({ fri: [] })).not.toThrow();
  });

  it('rejects an interval that ends before it starts', () => {
    expect(() => assertOpeningHours({ mon: [{ from: '18:00', to: '09:00' }] })).toThrow(
      ValidationError,
    );
  });

  it('rejects a zero-length interval', () => {
    // "Open at 09:00 and closed at 09:00" is not something a UI can render,
    // and it is almost always a half-finished edit.
    expect(() => assertOpeningHours({ mon: [{ from: '09:00', to: '09:00' }] })).toThrow(
      ValidationError,
    );
  });

  it('rejects overlapping intervals rather than merging them', () => {
    // Merging would hide a typo — 14:00 meant as 16:00 — behind a shop that
    // now claims to be open all afternoon.
    expect(() =>
      assertOpeningHours({
        sat: [
          { from: '09:00', to: '15:00' },
          { from: '14:00', to: '18:00' },
        ],
      }),
    ).toThrow(/overlapping/);
  });

  it('catches overlaps whatever order the intervals arrive in', () => {
    expect(() =>
      assertOpeningHours({
        sat: [
          { from: '14:00', to: '18:00' },
          { from: '09:00', to: '15:00' },
        ],
      }),
    ).toThrow(/overlapping/);
  });

  it('rejects a time that is not HH:MM on a 24-hour clock', () => {
    expect(() => assertOpeningHours({ mon: [{ from: '9:00', to: '17:00' }] })).toThrow(/HH:MM/);
    expect(() => assertOpeningHours({ mon: [{ from: '24:00', to: '25:00' }] })).toThrow(/HH:MM/);
  });

  it('rejects a key that is not a weekday', () => {
    expect(() => assertOpeningHours({ lundi: [] } as never)).toThrow(/not a weekday/);
  });
});

describe('coordinate pairs', () => {
  it('accepts both, neither, or both cleared', () => {
    expect(() => assertCoordinatePair(36.75, 3.06)).not.toThrow();
    expect(() => assertCoordinatePair(undefined, undefined)).not.toThrow();
    expect(() => assertCoordinatePair(null, null)).not.toThrow();
  });

  it('rejects one without the other', () => {
    // One coordinate alone is not half a location — it is a point on the
    // equator or the prime meridian.
    expect(() => assertCoordinatePair(36.75, undefined)).toThrow(ValidationError);
    expect(() => assertCoordinatePair(undefined, 3.06)).toThrow(ValidationError);
    expect(() => assertCoordinatePair(36.75, null)).toThrow(ValidationError);
  });
});
