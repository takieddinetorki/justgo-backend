/**
 * Money is ALWAYS integer minor units + ISO-4217 currency (§17.4).
 * No floats, ever. Persisted as bigint; safe-integer range is asserted here.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(`Money amount must be a safe integer of minor units, got ${amountMinor}`);
  }
  if (!CURRENCY_RE.test(currency)) {
    throw new TypeError(`Currency must be an ISO-4217 alpha-3 code, got "${currency}"`);
  }
  return Object.freeze({ amountMinor, currency });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function multiplyMoney(m: Money, qty: number): Money {
  if (!Number.isSafeInteger(qty)) throw new TypeError(`Quantity must be an integer, got ${qty}`);
  return money(m.amountMinor * qty, m.currency);
}

/** Negative if a < b, 0 if equal, positive if a > b. Same-currency only. */
export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amountMinor - b.amountMinor;
}
