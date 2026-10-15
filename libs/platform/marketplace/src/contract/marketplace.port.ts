import type { AccountId } from '@justgo/kernel';
import type {
  BidDTO,
  CreateListingDTO,
  ListingDTO,
  ListingQuery,
  PlaceBidDTO,
  SetOfferRangeDTO,
} from './dto';

export interface MarketplacePort {
  publish(sellerAccountId: AccountId, input: CreateListingDTO): Promise<ListingDTO>;
  browse(query: ListingQuery): Promise<ListingDTO[]>;
  /**
   * The public view. Carries no acceptance range and no bid count — see
   * `getAsSeller` for the owner's view.
   */
  get(listingId: string): Promise<ListingDTO>;
  /** The owner's view, including their private range and live bid count. */
  getAsSeller(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO>;
  contact(buyerAccountId: AccountId, listingId: string, message?: string): Promise<{ contacted: true }>;
  withdraw(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO>;

  /** Set or move the acceptance range. Setting it is what opens bidding. */
  setOfferRange(
    sellerAccountId: AccountId,
    listingId: string,
    input: SetOfferRangeDTO,
  ): Promise<ListingDTO>;
  /** Close bidding. Bids already placed keep their recorded standing. */
  clearOfferRange(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO>;

  /**
   * Place a bid. Supersedes any live bid this buyer already had on the
   * listing, so the seller only ever sees one current number per buyer.
   */
  placeBid(buyerAccountId: AccountId, listingId: string, input: PlaceBidDTO): Promise<BidDTO>;
  /** The seller sees every bid; a buyer sees only their own. */
  listBids(callerAccountId: AccountId, listingId: string): Promise<BidDTO[]>;
  /** Every bid this buyer has placed, across listings. */
  myBids(buyerAccountId: AccountId, limit?: number): Promise<BidDTO[]>;
  withdrawBid(buyerAccountId: AccountId, bidId: string): Promise<BidDTO>;
  /** Accepting declines every other live bid on the listing, in one transaction. */
  acceptBid(sellerAccountId: AccountId, bidId: string): Promise<BidDTO>;
  declineBid(sellerAccountId: AccountId, bidId: string, reason?: string): Promise<BidDTO>;
}

export const MARKETPLACE_PORT = Symbol('MARKETPLACE_PORT');
