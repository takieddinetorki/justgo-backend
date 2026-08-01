import { ConflictError } from '@justgo/kernel';
import type { QuoteStatus, RequestStatus } from '../contract/status';
import { applyQuoteTransition, isTerminalQuote, TERMINAL_QUOTE_STATUSES } from './quote-state';
import { applyRequestTransition, bestPriceQuoteId, isTerminalRequest } from './request-state';

describe('quote state machine (§8.1)', () => {
  it('walks the happy path pending → quoted → accepted', () => {
    expect(applyQuoteTransition('pending', 'submit_price')).toBe('quoted');
    expect(applyQuoteTransition('quoted', 'accept')).toBe('accepted');
  });

  it('allows a supplier to revise a price while still quoted', () => {
    expect(applyQuoteTransition('quoted', 'submit_price')).toBe('quoted');
    expect(applyQuoteTransition('quoted', 'offer_alternative')).toBe('quoted');
  });

  it('lets a supplier reject from pending or quoted', () => {
    expect(applyQuoteTransition('pending', 'reject')).toBe('rejected');
    expect(applyQuoteTransition('quoted', 'reject')).toBe('rejected');
  });

  it('closes losing quotes when another is accepted', () => {
    expect(applyQuoteTransition('quoted', 'close')).toBe('closed');
    expect(applyQuoteTransition('pending', 'close')).toBe('closed');
  });

  it('refuses to accept a quote the supplier never priced', () => {
    expect(() => applyQuoteTransition('pending', 'accept')).toThrow(ConflictError);
  });

  it('treats terminal states as terminal — every transition 409s', () => {
    for (const status of TERMINAL_QUOTE_STATUSES) {
      expect(isTerminalQuote(status)).toBe(true);
      for (const t of ['submit_price', 'offer_alternative', 'reject', 'accept', 'refuse', 'close'] as const) {
        expect(() => applyQuoteTransition(status, t)).toThrow(ConflictError);
      }
    }
  });

  it('reports a stable machine code and context on illegal transitions', () => {
    try {
      applyQuoteTransition('accepted' as QuoteStatus, 'accept');
      throw new Error('expected a ConflictError');
    } catch (error) {
      const e = error as ConflictError;
      expect(e.code).toBe('ILLEGAL_QUOTE_TRANSITION');
      expect(e.httpStatus).toBe(409);
      expect(e.details).toMatchObject({ current: 'accepted', transition: 'accept' });
    }
  });
});

describe('request state machine (§8.1)', () => {
  it('moves to awaiting_client on the first quote and stays there for more', () => {
    expect(applyRequestTransition('pending', 'quote_received')).toBe('awaiting_client');
    expect(applyRequestTransition('awaiting_client', 'quote_received')).toBe('awaiting_client');
  });

  it('accepts or refuses only once a quote has arrived', () => {
    expect(applyRequestTransition('awaiting_client', 'accept')).toBe('accepted');
    expect(applyRequestTransition('awaiting_client', 'refuse')).toBe('refused');
    expect(() => applyRequestTransition('pending', 'accept')).toThrow(ConflictError);
  });

  it('expires or cancels only while still open', () => {
    expect(applyRequestTransition('pending', 'expire')).toBe('expired');
    expect(applyRequestTransition('awaiting_client', 'cancel')).toBe('cancelled');
    expect(() => applyRequestTransition('accepted' as RequestStatus, 'expire')).toThrow(
      ConflictError,
    );
  });

  it('never reopens a terminal request', () => {
    for (const status of ['accepted', 'refused', 'expired', 'cancelled'] as RequestStatus[]) {
      expect(isTerminalRequest(status)).toBe(true);
      expect(() => applyRequestTransition(status, 'quote_received')).toThrow(ConflictError);
    }
  });
});

describe('best price selection (§8.1)', () => {
  const q = (id: string, status: QuoteStatus, amountMinor: number | null, currency = 'EUR') => ({
    id,
    status,
    amountMinor,
    currency: amountMinor === null ? null : currency,
  });

  it('picks the lowest priced quote', () => {
    expect(
      bestPriceQuoteId([q('a', 'quoted', 12000), q('b', 'quoted', 9500), q('c', 'quoted', 14000)]),
    ).toBe('b');
  });

  it('ignores rejected, pending and unpriced quotes', () => {
    expect(
      bestPriceQuoteId([
        q('rejected', 'rejected', 100),
        q('pending', 'pending', null),
        q('alt', 'quoted', null),
        q('real', 'quoted', 8000),
      ]),
    ).toBe('real');
  });

  it('returns null when nothing is priced yet', () => {
    expect(bestPriceQuoteId([q('a', 'pending', null)])).toBeNull();
    expect(bestPriceQuoteId([])).toBeNull();
  });

  it('never ranks across currencies', () => {
    // 5000 JPY must not beat 9000 EUR just by being a smaller integer
    const winner = bestPriceQuoteId([q('eur', 'quoted', 9000, 'EUR'), q('jpy', 'quoted', 5000, 'JPY')]);
    expect(winner).toBe('eur');
  });
});
