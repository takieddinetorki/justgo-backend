/**
 * Injectable clock so domain logic never calls Date.now() directly —
 * time-dependent rules (expiry, slots, reminders) stay testable.
 * All timestamps are UTC (§17.4).
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(next: Date): void {
    this.current = next;
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
