import { toBid, type BidRow } from './pg-marketplace.repository';

/*
  `standing` is the one field in this module that must not reach the wrong
  reader. A buyer who learns where their offer landed can find the seller
  private floor by bisection — bid, read the standing, halve the interval,
  repeat — which is the single thing the acceptance range exists to prevent.

  This file exists because that leak SHIPPED. `placeBid` passed the seller
  projection to the buyer who had just placed the bid. Nothing about the
  response shape was wrong, so no type and no existing test could see it; it
  took a live smoke check comparing what a buyer gets back. These assertions
  make the rule cost milliseconds instead.
*/

const row: BidRow = {
  // Real UUIDs: asId() validates, so placeholders fail before the assertion.
  id: '11111111-1111-4111-8111-111111111111',
  listing_id: '22222222-2222-4222-8222-222222222222',
  buyer_account_id: '33333333-3333-4333-8333-333333333333',
  amount_minor: '17500000',
  currency: 'DZD',
  message: 'Je peux passer ce week-end.',
  status: 'pending',
  standing: 'below_range',
  decline_reason: null,
  decided_at: null,
  created_at: new Date('2026-10-15T10:00:00Z'),
};

describe('toBid', () => {
  it('HIDES the standing by default', () => {
    // The dangerous option has to be asked for. A careless call leaks nothing.
    expect(toBid(row).standing).toBeUndefined();
  });

  it('hides it when the reader is not the seller', () => {
    expect(toBid(row, false).standing).toBeUndefined();
  });

  it('shows it to the seller', () => {
    expect(toBid(row, true).standing).toBe('below_range');
  });

  it('omits the key entirely rather than nulling it', () => {
    // `"standing": null` would still tell a buyer the field exists and invite
    // a client to render something; absence says nothing at all.
    expect(Object.keys(toBid(row))).not.toContain('standing');
  });

  it('leaks nothing else about the range', () => {
    const asBuyer = JSON.stringify(toBid(row));
    for (const forbidden of ['below_range', 'in_range', 'above_range', 'range_min', 'range_max']) {
      expect(asBuyer).not.toContain(forbidden);
    }
  });

  it('still returns everything the buyer legitimately owns', () => {
    expect(toBid(row)).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      listingId: '22222222-2222-4222-8222-222222222222',
      amount: { amountMinor: 17_500_000, currency: 'DZD' },
      message: 'Je peux passer ce week-end.',
      status: 'pending',
      declineReason: null,
      decidedAt: null,
    });
  });

  it('converts the amount out of a string without losing precision', () => {
    const big = toBid({ ...row, amount_minor: '999999999999' });
    expect(big.amount.amountMinor).toBe(999_999_999_999);
  });
});
