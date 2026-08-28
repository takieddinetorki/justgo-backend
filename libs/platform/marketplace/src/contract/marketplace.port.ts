import type { AccountId } from '@justgo/kernel';
import type { CreateListingDTO, ListingDTO, ListingQuery } from './dto';

export interface MarketplacePort {
  publish(sellerAccountId: AccountId, input: CreateListingDTO): Promise<ListingDTO>;
  browse(query: ListingQuery): Promise<ListingDTO[]>;
  get(listingId: string): Promise<ListingDTO>;
  contact(buyerAccountId: AccountId, listingId: string, message?: string): Promise<{ contacted: true }>;
  withdraw(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO>;
}

export const MARKETPLACE_PORT = Symbol('MARKETPLACE_PORT');
