import { ConflictError } from '@justgo/kernel';
import type { QuoteStatus, RequestStatus } from '../contract/status';

/**
 * Request lifecycle (§8.1). The request-level status AGGREGATES its quotes:
 *
 *   pending ──any quote quoted──► awaiting_client ──accept──► accepted
 *      │                                 └──────────refuse──► refused
 *      ├──expires_at passed────────────────────────────────► expired
 *      └──client cancels───────────────────────────────────► cancelled
 */
export type RequestTransition = 'quote_received' | 'accept' | 'refuse' | 'expire' | 'cancel';

const ALLOWED: Record<RequestTransition, { from: RequestStatus[]; to: RequestStatus }> = {
  quote_received: { from: ['pending', 'awaiting_client'], to: 'awaiting_client' },
  accept: { from: ['awaiting_client'], to: 'accepted' },
  refuse: { from: ['awaiting_client'], to: 'refused' },
  expire: { from: ['pending', 'awaiting_client'], to: 'expired' },
  cancel: { from: ['pending', 'awaiting_client'], to: 'cancelled' },
};

export const TERMINAL_REQUEST_STATUSES: RequestStatus[] = [
  'accepted',
  'refused',
  'expired',
  'cancelled',
];

export function isTerminalRequest(status: RequestStatus): boolean {
  return TERMINAL_REQUEST_STATUSES.includes(status);
}

export function applyRequestTransition(
  current: RequestStatus,
  transition: RequestTransition,
): RequestStatus {
  const rule = ALLOWED[transition];
  if (!rule.from.includes(current)) {
    throw new ConflictError(
      'ILLEGAL_REQUEST_TRANSITION',
      `Cannot ${transition} a request in status "${current}"`,
      { current, transition, allowedFrom: rule.from },
    );
  }
  return rule.to;
}

/** "Best price" = lowest amount among quoted price offers (§8.1). */
export function bestPriceQuoteId(
  quotes: { id: string; status: QuoteStatus; amountMinor: number | null; currency: string | null }[],
): string | null {
  const priced = quotes.filter(
    (q) => q.status === 'quoted' && q.amountMinor !== null && q.currency !== null,
  );
  if (priced.length === 0) return null;
  // comparing across currencies is meaningless — only rank within the
  // dominant currency (multi-currency pricing is Open Question §21.3)
  const currency = priced[0].currency;
  const comparable = priced.filter((q) => q.currency === currency);
  return comparable.reduce((best, q) =>
    (q.amountMinor as number) < (best.amountMinor as number) ? q : best,
  ).id;
}
