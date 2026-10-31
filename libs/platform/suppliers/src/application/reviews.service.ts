import { Inject, Injectable } from '@nestjs/common';
import {
  ValidationError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import type { ReviewsPort } from '../contract/suppliers.port';
import type {
  CreateReviewDTO,
  ReviewDTO,
  ReviewPage,
  UpdateReviewDTO,
} from '../contract/dto';
import { PgReviewsRepository } from '../infra/pg-reviews.repository';

export const REVIEWS_REPOSITORY = Symbol('REVIEWS_REPOSITORY');

const MAX_BODY = 2000;

/*
  Every method here is `async`, including the ones whose only work is a
  validation that happens before any I/O.

  A method that throws SYNCHRONOUSLY from an async-looking signature gives
  its callers two failure shapes for one kind of failure — `try/catch` round
  the call and `.catch()` on the promise — and the one they did not write is
  the one that escapes. It also makes the obvious test
  (`expect(...).rejects`) silently inapplicable, which is how a validation
  rule ends up asserted nowhere.
*/

function assertRating(rating: number | undefined): void {
  if (rating === undefined) return;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ValidationError('A rating is a whole number of stars from 1 to 5', { rating });
  }
}

function assertBody(body: string | null | undefined): void {
  if (body === undefined || body === null) return;
  if (body.length > MAX_BODY) {
    throw new ValidationError(`A review may not exceed ${MAX_BODY} characters`);
  }
}

@Injectable()
export class ReviewsService implements ReviewsPort {
  constructor(@Inject(REVIEWS_REPOSITORY) private readonly repo: PgReviewsRepository) {}

  async list(
    supplierId: SupplierId,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<ReviewPage> {
    return this.repo.list(supplierId, opts);
  }

  async mine(supplierId: SupplierId, accountId: AccountId): Promise<ReviewDTO | null> {
    return this.repo.mine(supplierId, accountId);
  }

  async mayReview(supplierId: SupplierId, accountId: AccountId): Promise<boolean> {
    return this.repo.mayReview(supplierId, accountId);
  }

  async write(
    supplierId: SupplierId,
    authorAccountId: AccountId,
    input: CreateReviewDTO,
  ): Promise<ReviewDTO> {
    assertRating(input.rating);
    if (input.rating === undefined) {
      throw new ValidationError('A review needs a rating');
    }
    assertBody(input.body);
    return this.repo.write(supplierId, authorAccountId, input);
  }

  async edit(reviewId: Uuid, authorAccountId: AccountId, patch: UpdateReviewDTO): Promise<ReviewDTO> {
    assertRating(patch.rating);
    assertBody(patch.body);
    return this.repo.edit(reviewId, authorAccountId, patch);
  }

  /*
    Retracting your own review is not an administrative act, so it needs no
    reason — "I changed my mind" is the whole of it. A takedown does, and the
    reason is stored on the row, because a business that loses a one-star
    review is entitled to a record of why it went.
  */
  async retract(reviewId: Uuid, authorAccountId: AccountId): Promise<ReviewDTO> {
    return this.repo.remove(reviewId, 'retracted by the author', authorAccountId);
  }

  async takedown(reviewId: Uuid, reason: string): Promise<ReviewDTO> {
    const trimmed = reason.trim();
    if (!trimmed) throw new ValidationError('A takedown needs a reason');
    return this.repo.remove(reviewId, trimmed);
  }

  async reply(
    reviewId: Uuid,
    supplierId: SupplierId,
    authorAccountId: AccountId,
    body: string,
  ): Promise<ReviewDTO> {
    const trimmed = body.trim();
    if (!trimmed) throw new ValidationError('A reply needs something to say');
    assertBody(trimmed);
    return this.repo.reply(reviewId, supplierId, authorAccountId, trimmed);
  }

  /** Which business a review is about, so a reply can be owner-scoped. */
  async supplierOf(reviewId: Uuid): Promise<SupplierId | null> {
    return this.repo.supplierOf(reviewId);
  }

  async recordEligibility(input: {
    accountId: AccountId;
    supplierId: SupplierId;
    source: 'order' | 'reservation';
    sourceId: Uuid;
  }): Promise<void> {
    return this.repo.recordEligibility(input);
  }
}
