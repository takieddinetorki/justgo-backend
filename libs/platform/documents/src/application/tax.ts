/**
 * Algerian TVA arithmetic, in integer minor units.
 *
 * WHY THE QUOTED AMOUNT IS TREATED AS TTC. A quote shown to a client is
 * the price they agree to pay — nothing in the app ever told them tax
 * would be added on top. So the invoice derives HT and TVA *backwards*
 * from that figure rather than adding tax to it. Reading the stored
 * amount as HT would silently inflate every bill by 19%.
 *
 * WHY TVA IS THE REMAINDER, NOT A SEPARATE ROUNDING. Computing
 * `HT = round(TTC / 1.19)` and `TVA = round(HT * 0.19)` independently
 * lets the two rounded values disagree with the total by a unit — and an
 * invoice whose lines do not sum to its total is rejected by any
 * accountant and by most tax software. Taking TVA as `TTC - HT`
 * guarantees they reconcile exactly, always.
 */

/** Standard Algerian rate. The reduced rate is 9% where it applies. */
export const TVA_STANDARD = 19;
export const TVA_REDUCED = 9;

export interface TaxBreakdown {
  /** Base, excluding tax. */
  htMinor: number;
  tvaMinor: number;
  /** Including tax — equals the amount the client agreed to pay. */
  ttcMinor: number;
  ratePercent: number;
}

export function breakdownFromTtc(ttcMinor: number, ratePercent = TVA_STANDARD): TaxBreakdown {
  if (!Number.isSafeInteger(ttcMinor) || ttcMinor < 0) {
    throw new TypeError(`ttcMinor must be a non-negative integer, got ${ttcMinor}`);
  }
  if (ratePercent < 0 || ratePercent > 100) {
    throw new TypeError(`ratePercent out of range: ${ratePercent}`);
  }

  // Round half-up on the base; the remainder absorbs the difference so
  // ht + tva === ttc for every possible input.
  const htMinor = Math.round((ttcMinor * 100) / (100 + ratePercent));
  return {
    htMinor,
    tvaMinor: ttcMinor - htMinor,
    ttcMinor,
    ratePercent,
  };
}

/**
 * `1 234,56 DZD` — French grouping, which is what the invoice prints.
 *
 * A PLAIN space, not the narrow no-break space (U+202F) French
 * typography would prefer. pdf-lib's standard fonts use WinAnsi
 * encoding, which cannot represent it: the renderer throws
 * `WinAnsi cannot encode " " (0x202f)` and the invoice silently fails to
 * issue. Embedding a Unicode font to win the typography would add a
 * megabyte to every PDF for one character.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const negative = amountMinor < 0;
  const major = (Math.abs(amountMinor) / 100).toFixed(2).replace('.', ',');
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '-' : ''}${grouped} ${currency}`;
}
