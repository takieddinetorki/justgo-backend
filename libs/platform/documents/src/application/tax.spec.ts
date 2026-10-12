import { breakdownFromTtc, formatMoney, TVA_REDUCED, TVA_STANDARD } from './tax';

describe('breakdownFromTtc', () => {
  /*
    THE property. Independent rounding of HT and TVA lets them disagree
    with the total by a unit, and an invoice whose parts do not sum to
    its total is rejected by any accountant. Taking TVA as the remainder
    makes this hold for every input, not merely for convenient ones.
  */
  it('always reconciles: ht + tva === ttc', () => {
    for (let ttc = 0; ttc <= 20000; ttc += 7) {
      const b = breakdownFromTtc(ttc);
      expect(b.htMinor + b.tvaMinor).toBe(ttc);
    }
    for (const ttc of [1, 2, 3, 99, 101, 119, 4_500_00, 999_999_99]) {
      for (const rate of [TVA_STANDARD, TVA_REDUCED, 0]) {
        const b = breakdownFromTtc(ttc, rate);
        expect(b.htMinor + b.tvaMinor).toBe(ttc);
      }
    }
  });

  it('derives 19% backwards from the agreed price', () => {
    // 11 900 DZD TTC at 19% is exactly 10 000 HT + 1 900 TVA.
    const b = breakdownFromTtc(1_190_000);
    expect(b.htMinor).toBe(1_000_000);
    expect(b.tvaMinor).toBe(190_000);
    expect(b.ratePercent).toBe(19);
  });

  it('never adds tax on top of the quoted figure', () => {
    // The client agreed to 4 500,00 — that is what they owe, full stop.
    const b = breakdownFromTtc(450_000);
    expect(b.ttcMinor).toBe(450_000);
    expect(b.htMinor).toBeLessThan(450_000);
  });

  it('handles a zero-rated supply', () => {
    const b = breakdownFromTtc(450_000, 0);
    expect(b.htMinor).toBe(450_000);
    expect(b.tvaMinor).toBe(0);
  });

  it('handles zero', () => {
    expect(breakdownFromTtc(0)).toMatchObject({ htMinor: 0, tvaMinor: 0, ttcMinor: 0 });
  });

  it('rejects nonsense rather than inventing a total', () => {
    expect(() => breakdownFromTtc(-1)).toThrow(/non-negative/);
    expect(() => breakdownFromTtc(1.5)).toThrow(/integer/);
    expect(() => breakdownFromTtc(100, 101)).toThrow(/out of range/);
  });
});

describe('formatMoney', () => {
  /*
    Plain spaces, not U+202F: pdf-lib's WinAnsi-encoded standard fonts
    cannot render the narrow no-break space, and the renderer throws
    rather than substituting — which killed invoice issuance until it
    was caught on the server.
  */
  it('groups thousands and uses a decimal comma', () => {
    expect(formatMoney(1_190_000, 'DZD')).toBe('11 900,00 DZD');
    expect(formatMoney(450_000, 'DZD')).toBe('4 500,00 DZD');
    expect(formatMoney(99, 'DZD')).toBe('0,99 DZD');
  });

  it('keeps a negative sign outside the grouping', () => {
    expect(formatMoney(-1_190_000, 'DZD')).toBe('-11 900,00 DZD');
  });
});
