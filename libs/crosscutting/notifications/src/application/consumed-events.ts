/**
 * Event contracts this module CONSUMES (§12). Redeclared locally on purpose:
 * notifications is crosscutting and must not import platform modules. The
 * emitter and consumer agree only on the wire format (name + payload),
 * versioned and additive — exactly what lets a module be extracted later.
 */
export const USER_REGISTERED = 'identity.UserRegistered';
export const QUOTE_REQUESTED = 'requests.QuoteRequested';
export const QUOTE_SUBMITTED = 'requests.QuoteSubmitted';
export const QUOTE_ALTERNATIVE_OFFERED = 'requests.QuoteAlternativeOffered';
export const QUOTE_REJECTED = 'requests.QuoteRejected';
export const QUOTE_ACCEPTED = 'requests.QuoteAccepted';
export const ORDER_CREATED = 'orders.OrderCreated';
export const ORDER_STATUS_CHANGED = 'orders.OrderStatusChanged';
export const BID_PLACED = 'marketplace.BidPlaced';
export const BID_ACCEPTED = 'marketplace.BidAccepted';
export const BID_DECLINED = 'marketplace.BidDeclined';

export interface UserRegistered {
  accountId: string;
  authUserId: string;
  locale: string;
}
export interface QuoteRequested {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  categoryKey: string | null;
  tecdocArticleId: number | null;
  freeText: string | null;
}
export interface QuoteMoved {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  amountMinor: number | null;
  currency: string | null;
}
export interface QuoteAlternative {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  altName: string;
}
export interface QuoteRejectedEvent {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  reason: string | null;
}
export interface OrderCreated {
  orderId: string;
  requestId: string | null;
  quoteId: string | null;
  clientAccountId: string;
  supplierId: string;
  amountMinor: number | null;
  currency: string | null;
}
export interface OrderStatusChanged {
  orderId: string;
  clientAccountId: string;
  supplierId: string;
  from: string;
  to: string;
}

export interface BidPlaced {
  bidId: string;
  listingId: string;
  listingTitle: string;
  sellerAccountId: string;
  buyerAccountId: string;
  amountMinor: number;
  currency: string;
  standing: 'below_range' | 'in_range' | 'above_range';
  /**
   * Whether the seller asked to hear about a bid this size.
   *
   * DECIDED BY THE EMITTER, not here. The acceptance range is private to the
   * seller, so a notification reactor that had to read it would need access to
   * every seller's floor — and anything holding that is another place it can
   * leak from. The marketplace decides once, at placement, and says so on the
   * event.
   */
  notifiesSeller: boolean;
}

export interface BidAccepted {
  bidId: string;
  listingId: string;
  listingTitle: string;
  sellerAccountId: string;
  buyerAccountId: string;
  amountMinor: number;
  currency: string;
}

export interface BidDeclined {
  bidId: string;
  listingId: string;
  listingTitle: string;
  sellerAccountId: string;
  buyerAccountId: string;
  reason: string | null;
  supersededByAcceptance: boolean;
}
