import { assertRange, notifiesSeller, standingOf, type AcceptanceRange } from './bid-standing';

/*
  Two failures matter here and both are silent. If the floor stops holding, a
  seller drowns in lowballs and mutes the channel the real offer arrives on.
  If the ceiling swallows the best offer, the seller is never told about the
  one bid they would certainly have taken.
*/

const range = (minMinor: number, maxMinor: number | null = null): AcceptanceRange => ({
  minMinor,
  maxMinor,
  currency: 'DZD',
});

// A seller asking 1 800 000–2 000 000 DZD, in minor units.
const ASKED = range(180_000_000, 200_000_000);

describe('standingOf', () => {
  it('places a bid inside the range', () => {
    expect(standingOf(190_000_000, ASKED)).toBe('in_range');
  });

  it('places a lowball below it', () => {
    expect(standingOf(100_000_000, ASKED)).toBe('below_range');
  });

  it('places a generous bid above it', () => {
    expect(standingOf(220_000_000, ASKED)).toBe('above_range');
  });

  /*
    BOTH ENDS INCLUSIVE. A seller who says "from 1 800 000" means that number
    is acceptable. An exclusive floor would reject the exact figure they named,
    which is the one number they are guaranteed to be offered.
  */
  it('counts both ends of the range as inside it', () => {
    expect(standingOf(180_000_000, ASKED)).toBe('in_range');
    expect(standingOf(200_000_000, ASKED)).toBe('in_range');
  });

  it('puts a single unit either side on the right side', () => {
    expect(standingOf(179_999_999, ASKED)).toBe('below_range');
    expect(standingOf(200_000_001, ASKED)).toBe('above_range');
  });

  describe('with a floor and no ceiling', () => {
    const openEnded = range(180_000_000);

    it('treats anything from the floor up as in range', () => {
      expect(standingOf(180_000_000, openEnded)).toBe('in_range');
      expect(standingOf(500_000_000, openEnded)).toBe('in_range');
    });

    it('still rejects below the floor', () => {
      expect(standingOf(179_999_999, openEnded)).toBe('below_range');
    });
  });

  it('handles a zero floor, where every bid is in range', () => {
    expect(standingOf(1, range(0))).toBe('in_range');
    expect(standingOf(0, range(0))).toBe('in_range');
  });

  /*
    A degenerate range is a seller naming one exact price. It must stay
    meaningful rather than becoming unsatisfiable.
  */
  it('handles a range of a single price', () => {
    const exact = range(180_000_000, 180_000_000);
    expect(standingOf(180_000_000, exact)).toBe('in_range');
    expect(standingOf(179_999_999, exact)).toBe('below_range');
    expect(standingOf(180_000_001, exact)).toBe('above_range');
  });
});

describe('notifiesSeller', () => {
  it('stays quiet only below the floor', () => {
    expect(notifiesSeller('below_range')).toBe(false);
    expect(notifiesSeller('in_range')).toBe(true);
    expect(notifiesSeller('above_range')).toBe(true);
  });

  /*
    The property that matters, stated as one: a bid reaching the floor always
    reaches the seller, and nothing below it ever does. Checked across the
    whole neighbourhood of the boundary rather than at a couple of points.
  */
  it('notifies for exactly the bids at or above the floor', () => {
    for (let amount = 179_999_990; amount <= 200_000_010; amount += 1) {
      const reaches = notifiesSeller(standingOf(amount, ASKED));
      expect(reaches).toBe(amount >= ASKED.minMinor);
    }
  });
});

describe('assertRange', () => {
  it('accepts a floor alone', () => {
    expect(assertRange({ minMinor: 100, currency: 'DZD' })).toEqual({
      minMinor: 100,
      maxMinor: null,
      currency: 'DZD',
    });
  });

  it('accepts a floor and a ceiling', () => {
    expect(assertRange({ minMinor: 100, maxMinor: 200, currency: 'DZD' }).maxMinor).toBe(200);
  });

  it('refuses a ceiling below the floor', () => {
    expect(() => assertRange({ minMinor: 200, maxMinor: 100, currency: 'DZD' })).toThrow(
      /cannot be below/i,
    );
  });

  it('refuses a negative or fractional floor', () => {
    expect(() => assertRange({ minMinor: -1, currency: 'DZD' })).toThrow();
    expect(() => assertRange({ minMinor: 1.5, currency: 'DZD' })).toThrow();
  });

  it('refuses a currency that is not ISO-4217 alpha-3', () => {
    for (const currency of ['dzd', 'DZ', 'DZDX', '']) {
      expect(() => assertRange({ minMinor: 100, currency })).toThrow(/ISO-4217/i);
    }
  });
});
