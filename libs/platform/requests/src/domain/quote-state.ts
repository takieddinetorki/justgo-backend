import { ConflictError } from '@justgo/kernel';
import type { QuoteStatus } from '../contract/status';

/**
 * Quote lifecycle (§8.1) as an explicit state machine. Every transition is
 * guarded; an illegal one is a 409 (§17.3) — never a silent no-op.
 *
 *   pending ──supplier prices──► quoted ──client accepts──► accepted
 *      │                            │ └──client refuses───► refused
 *      │                            └────another accepted─► closed
 *      ├──supplier offers alt────► quoted (kind='alternative')
 *      ├──supplier rejects───────► rejected   (terminal)
 *      └──request expires────────► closed     (terminal)
 */
export type QuoteTransition =
  | 'submit_price'
  | 'offer_alternative'
  | 'reject'
  | 'accept'
  | 'refuse'
  | 'close';

const ALLOWED: Record<QuoteTransition, { from: QuoteStatus[]; to: QuoteStatus }> = {
  submit_price: { from: ['pending', 'quoted'], to: 'quoted' },
  offer_alternative: { from: ['pending', 'quoted'], to: 'quoted' },
  reject: { from: ['pending', 'quoted'], to: 'rejected' },
  accept: { from: ['quoted'], to: 'accepted' },
  refuse: { from: ['quoted'], to: 'refused' },
  close: { from: ['pending', 'quoted'], to: 'closed' },
};

export const TERMINAL_QUOTE_STATUSES: QuoteStatus[] = ['rejected', 'accepted', 'refused', 'closed'];

export function isTerminalQuote(status: QuoteStatus): boolean {
  return TERMINAL_QUOTE_STATUSES.includes(status);
}

/** Returns the next status, or throws 409 with a stable machine code. */
export function applyQuoteTransition(
  current: QuoteStatus,
  transition: QuoteTransition,
): QuoteStatus {
  const rule = ALLOWED[transition];
  if (!rule.from.includes(current)) {
    throw new ConflictError(
      'ILLEGAL_QUOTE_TRANSITION',
      `Cannot ${transition} a quote in status "${current}"`,
      { current, transition, allowedFrom: rule.from },
    );
  }
  return rule.to;
}
