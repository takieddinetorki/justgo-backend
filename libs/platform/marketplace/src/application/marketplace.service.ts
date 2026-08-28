import { Inject, Injectable } from '@nestjs/common';
import { ValidationError, type AccountId } from '@justgo/kernel';
import type { MarketplacePort } from '../contract/marketplace.port';
import type { CreateListingDTO, ListingDTO, ListingQuery } from '../contract/dto';
import { PgMarketplaceRepository } from '../infra/pg-marketplace.repository';

export const MARKETPLACE_REPOSITORY = Symbol('MARKETPLACE_REPOSITORY');

@Injectable()
export class MarketplaceService implements MarketplacePort {
  constructor(@Inject(MARKETPLACE_REPOSITORY) private readonly repo: PgMarketplaceRepository) {}

  publish(sellerAccountId: AccountId, input: CreateListingDTO): Promise<ListingDTO> {
    if (!input.title?.trim()) throw new ValidationError('A listing needs a title');
    // §21.5 seam: beta auto-publishes. A moderation step (status
    // 'pending_review' + review reactor) can gate this without contract change.
    return this.repo.insert(sellerAccountId, input);
  }

  browse(query: ListingQuery): Promise<ListingDTO[]> {
    return this.repo.browse(query);
  }

  get(listingId: string): Promise<ListingDTO> {
    return this.repo.find(listingId);
  }

  async contact(buyerAccountId: AccountId, listingId: string, message?: string): Promise<{ contacted: true }> {
    await this.repo.contact(buyerAccountId, listingId, message);
    return { contacted: true };
  }

  withdraw(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO> {
    return this.repo.withdraw(sellerAccountId, listingId);
  }
}
