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
