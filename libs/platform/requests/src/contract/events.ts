/** Events emitted by requests (§12). Versioned and additive. */

export const REQUEST_SUBMITTED = 'requests.RequestSubmitted';
export interface RequestSubmittedV1 {
  requestId: string;
  clientAccountId: string;
  categoryKey: string | null;
  tecdocArticleId: number | null;
  strategy: 'all' | 'single';
  targetSupplierId: string | null;
}

export const QUOTE_SUBMITTED = 'requests.QuoteSubmitted';
export interface QuoteSubmittedV1 {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  amountMinor: number | null;
  currency: string | null;
}

export const QUOTE_ALTERNATIVE_OFFERED = 'requests.QuoteAlternativeOffered';
export interface QuoteAlternativeOfferedV1 {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  altName: string;
}

export const QUOTE_REJECTED = 'requests.QuoteRejected';
export interface QuoteRejectedV1 {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  reason: string | null;
}

export const QUOTE_ACCEPTED = 'requests.QuoteAccepted';
export interface QuoteAcceptedV1 {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  amountMinor: number | null;
  currency: string | null;
}

export const REQUEST_EXPIRED = 'requests.RequestExpired';
export interface RequestExpiredV1 {
  requestId: string;
  clientAccountId: string;
}
