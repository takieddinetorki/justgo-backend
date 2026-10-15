import { Inject, Injectable } from '@nestjs/common';
import { BusinessRuleError, ValidationError, type AccountId } from '@justgo/kernel';
import type { MarketplacePort } from '../contract/marketplace.port';
import type {
  BidDTO,
  CreateListingDTO,
  ListingDTO,
  ListingQuery,
  PlaceBidDTO,
  SetOfferRangeDTO,
} from '../contract/dto';
import { assertRange, type AcceptanceRange } from '../domain/bid-standing';
import { PgMarketplaceRepository } from '../infra/pg-marketplace.repository';

export const MARKETPLACE_REPOSITORY = Symbol('MARKETPLACE_REPOSITORY');

const MAX_PHOTOS = 20;
const MAX_BID_MESSAGE = 1000;

@Injectable()
export class MarketplaceService implements MarketplacePort {
  constructor(@Inject(MARKETPLACE_REPOSITORY) private readonly repo: PgMarketplaceRepository) {}

  publish(sellerAccountId: AccountId, input: CreateListingDTO): Promise<ListingDTO> {
    if (!input.title?.trim()) throw new ValidationError('A listing needs a title');
    if ((input.photoUrls ?? []).length > MAX_PHOTOS) {
      throw new ValidationError(`A listing may carry at most ${MAX_PHOTOS} photos`);
    }
    /*
      A range needs a currency, and it has to be the one the car is priced in.
      Otherwise a seller could ask 1 800 000 DZD and accept offers from
      1 800 EUR, and the comparison that decides whether to notify them would
      be arithmetic across two currencies.
    */
    let range: AcceptanceRange | null = null;
    if (input.offerRange) {
      const currency = input.offerRange.currency ?? input.amount?.currency;
      if (!currency) {
        throw new ValidationError('An offer range needs a currency');
      }
      if (input.amount && input.amount.currency !== currency) {
        throw new ValidationError('The offer range must use the same currency as the asking price');
      }
      range = assertRange({
        minMinor: input.offerRange.minMinor,
        maxMinor: input.offerRange.maxMinor,
        currency,
      });
    }
    // §21.5 seam: beta auto-publishes. A moderation step (status
    // 'pending_review' + review reactor) can gate this without contract change.
    return this.repo.insert(sellerAccountId, input, range);
  }

  browse(query: ListingQuery): Promise<ListingDTO[]> {
    return this.repo.browse(query);
  }

  get(listingId: string): Promise<ListingDTO> {
    return this.repo.find(listingId);
  }

  getAsSeller(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO> {
    return this.repo.findAsSeller(sellerAccountId, listingId);
  }

  async contact(
    buyerAccountId: AccountId,
    listingId: string,
    message?: string,
  ): Promise<{ contacted: true }> {
    await this.repo.contact(buyerAccountId, listingId, message);
    return { contacted: true };
  }

  withdraw(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO> {
    return this.repo.withdraw(sellerAccountId, listingId);
  }

  async setOfferRange(
    sellerAccountId: AccountId,
    listingId: string,
    input: SetOfferRangeDTO,
  ): Promise<ListingDTO> {
    /*
      The currency defaults to the one the car is priced in, so a seller who
      has already named an asking price does not have to repeat it. If the
      listing has no price either, there is nothing to infer from and saying so
      is better than picking one.
    */
    const listing = await this.repo.findAsSeller(sellerAccountId, listingId);
    const currency = input.currency ?? listing.amount?.currency;
    if (!currency) {
      throw new ValidationError(
        'This listing has no asking price, so the offer range needs an explicit currency',
      );
    }
    if (listing.amount && listing.amount.currency !== currency) {
      throw new ValidationError('The offer range must use the same currency as the asking price');
    }
    const range = assertRange({ minMinor: input.minMinor, maxMinor: input.maxMinor, currency });
    return this.repo.setOfferRange(sellerAccountId, listingId, range);
  }

  clearOfferRange(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO> {
    return this.repo.clearOfferRange(sellerAccountId, listingId);
  }

  placeBid(buyerAccountId: AccountId, listingId: string, input: PlaceBidDTO): Promise<BidDTO> {
    if (!Number.isSafeInteger(input.amount?.amountMinor) || input.amount.amountMinor <= 0) {
      throw new ValidationError('A bid needs a positive amount in minor units');
    }
    if (!/^[A-Z]{3}$/.test(input.amount.currency ?? '')) {
      throw new ValidationError('currency must be an ISO-4217 alpha-3 code');
    }
    if ((input.message?.length ?? 0) > MAX_BID_MESSAGE) {
      throw new ValidationError(`A message may not exceed ${MAX_BID_MESSAGE} characters`);
    }
    return this.repo.placeBid(buyerAccountId, listingId, input);
  }

  listBids(callerAccountId: AccountId, listingId: string): Promise<BidDTO[]> {
    return this.repo.listBids(callerAccountId, listingId);
  }

  myBids(buyerAccountId: AccountId, limit = 50): Promise<BidDTO[]> {
    return this.repo.myBids(buyerAccountId, Math.min(Math.max(limit, 1), 200));
  }

  withdrawBid(buyerAccountId: AccountId, bidId: string): Promise<BidDTO> {
    return this.repo.withdrawBid(buyerAccountId, bidId);
  }

  acceptBid(sellerAccountId: AccountId, bidId: string): Promise<BidDTO> {
    return this.repo.acceptBid(sellerAccountId, bidId);
  }

  declineBid(sellerAccountId: AccountId, bidId: string, reason?: string): Promise<BidDTO> {
    const trimmed = reason?.trim();
    if (trimmed !== undefined && trimmed.length > MAX_BID_MESSAGE) {
      throw new ValidationError(`A reason may not exceed ${MAX_BID_MESSAGE} characters`);
    }
    /*
      A reason is optional here, unlike a driver rejection or a voided
      document. Declining an offer on a used car is an ordinary negotiation
      move — "no thanks" is a complete answer, and demanding an explanation
      would push sellers to type nothing useful just to get past the field.
    */
    if (trimmed !== undefined && trimmed.length === 0) {
      throw new BusinessRuleError('EMPTY_REASON', 'Send no reason rather than an empty one');
    }
    return this.repo.declineBid(sellerAccountId, bidId, trimmed);
  }
}
