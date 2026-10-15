export const LISTING_PUBLISHED = 'marketplace.ListingPublished';
export interface ListingPublishedV1 {
  listingId: string;
  sellerAccountId: string;
  title: string;
}

export const BUYER_CONTACTED = 'marketplace.BuyerContacted';
export interface BuyerContactedV1 {
  listingId: string;
  sellerAccountId: string;
  buyerAccountId: string;
}

export const BID_PLACED = 'marketplace.BidPlaced';
export interface BidPlacedV1 {
  bidId: string;
  listingId: string;
  listingTitle: string;
  sellerAccountId: string;
  buyerAccountId: string;
  amountMinor: number;
  currency: string;
  /**
   * Where it fell against the seller's range.
   *
   * ON THE EVENT RATHER THAN RECOMPUTED BY THE CONSUMER, because the range is
   * private: a notification reactor that had to read it would need access to
   * the seller's floor, and anything with that access is another place it can
   * leak from. The domain decides the standing once, at placement; everyone
   * downstream just reads it.
   */
  standing: 'below_range' | 'in_range' | 'above_range';
  /** False for a lowball — the silence below the floor is the point. */
  notifiesSeller: boolean;
}

export const BID_ACCEPTED = 'marketplace.BidAccepted';
export interface BidAcceptedV1 {
  bidId: string;
  listingId: string;
  listingTitle: string;
  sellerAccountId: string;
  buyerAccountId: string;
  amountMinor: number;
  currency: string;
}

export const BID_DECLINED = 'marketplace.BidDeclined';
export interface BidDeclinedV1 {
  bidId: string;
  listingId: string;
  listingTitle: string;
  sellerAccountId: string;
  buyerAccountId: string;
  reason: string | null;
  /** True when it was declined because another bid on the listing won. */
  supersededByAcceptance: boolean;
}
