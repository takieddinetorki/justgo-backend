import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { CurrentAuth, Public, RequirePermissions, type AuthContext } from '@justgo/auth';
import {
  asId,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import {
  REVIEWS_PORT,
  SUPPLIERS_PORT,
  type ReviewsPort,
  type SuppliersPort,
} from './contract/suppliers.port';
import type { ReviewDTO, ReviewPage } from './contract/dto';

const writeSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    body: z.string().max(2000).optional(),
  })
  .strict();

const editSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    body: z.string().max(2000).nullable().optional(),
  })
  .strict();

const replySchema = z.object({ body: z.string().min(1).max(2000) }).strict();
const takedownSchema = z.object({ reason: z.string().min(1).max(500) }).strict();
const pageSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().max(400).optional(),
});

/**
 * Reviews and the star rating (§15 client + supplier).
 *
 * `suppliers.suppliers.rating` has been selected by the directory and
 * rendered by the app since the first release, and written by nothing. This
 * is where the number comes from.
 *
 * The paths are PLURAL (`/v1/suppliers/{id}/reviews`) because they are about
 * a named business, unlike everything under `/v1/supplier`, which always
 * means "the business I am". The two are different enough to be worth
 * telling apart in a URL.
 */
@Controller()
export class SupplierReviewsController {
  constructor(
    @Inject(REVIEWS_PORT) private readonly reviews: ReviewsPort,
    @Inject(SUPPLIERS_PORT) private readonly suppliers: SuppliersPort,
  ) {}

  /** Public: a rating nobody can read is not a rating. */
  @Get('suppliers/:id/reviews')
  @Public()
  async list(@Param('id') id: string, @Query() query: unknown): Promise<ReviewPage> {
    const parsed = pageSchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError('Invalid page', { issues: parsed.error.issues });
    }
    return this.reviews.list(asId<SupplierId>(id), parsed.data);
  }

  /**
   * "Can I review this, and have I?" — one call, because the app needs both
   * to decide whether to draw a write button, an edit button or nothing.
   */
  @Get('suppliers/:id/reviews/me')
  @RequirePermissions()
  async mine(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ review: ReviewDTO | null; mayReview: boolean }> {
    const supplierId = asId<SupplierId>(id);
    const [review, mayReview] = await Promise.all([
      this.reviews.mine(supplierId, auth.accountId),
      this.reviews.mayReview(supplierId, auth.accountId),
    ]);
    return { review, mayReview };
  }

  /**
   * Write one.
   *
   * 422 `NO_COMPLETED_DEALING` unless an order or a reservation with this
   * business has completed. An open review box is a review box full of
   * competitors, and requiring a completed dealing is the only defence that
   * survives contact with a real market.
   *
   * Throttled below the default because a rating is the first thing anyone
   * will try to game, and because each one notifies a business owner.
   */
  @Post('suppliers/:id/reviews')
  @HttpCode(201)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @RequirePermissions('review.write')
  async write(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReviewDTO> {
    const parsed = writeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid review', { issues: parsed.error.issues });
    }
    return this.reviews.write(asId<SupplierId>(id), auth.accountId, parsed.data);
  }

  /** The author changes their mind. 404 if it is not theirs. */
  @Patch('reviews/:id')
  @RequirePermissions('review.write')
  async edit(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReviewDTO> {
    const parsed = editSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid review patch', { issues: parsed.error.issues });
    }
    return this.reviews.edit(asId<Uuid>(id), auth.accountId, parsed.data);
  }

  /**
   * Retract. The average drops by exactly what this review contributed, and
   * the author is free to write a new one — which is the point when a shop
   * has put something right.
   */
  @Delete('reviews/:id')
  @RequirePermissions('review.write')
  async retract(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<ReviewDTO> {
    return this.reviews.retract(asId<Uuid>(id), auth.accountId);
  }

  /** Administrative takedown — any review, with a stated reason. */
  @Post('reviews/:id/takedown')
  @RequirePermissions('platform.admin')
  async takedown(@Param('id') id: string, @Body() body: unknown): Promise<ReviewDTO> {
    const parsed = takedownSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid takedown', { issues: parsed.error.issues });
    }
    return this.reviews.takedown(asId<Uuid>(id), parsed.data.reason);
  }

  /**
   * The business's right of reply. PUT, not POST: there is one answer and a
   * second call replaces it, so a retried request cannot turn a review page
   * into a thread.
   */
  @Put('reviews/:id/reply')
  @RequirePermissions('supplier.profile.manage')
  async reply(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReviewDTO> {
    const parsed = replySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid reply', { issues: parsed.error.issues });
    }
    const reviewId = asId<Uuid>(id);
    const reviewedSupplier = await this.reviews.supplierOf(reviewId);
    if (!reviewedSupplier) throw new NotFoundError('Review', id);

    /*
      Only the business under review may answer. Resolved from the caller
      and compared, rather than trusting a supplier id in the body — without
      this, any supplier owner could post a reply under any shop's name,
      which is the same failure the social feed's `asSupplierId` check
      exists to prevent.
    */
    const mine =
      auth.supplierScope?.supplierId ??
      (await this.suppliers.getByOwner(auth.accountId as AccountId))?.id;
    if (mine !== reviewedSupplier) {
      throw new ForbiddenError('You may only reply to reviews of your own business');
    }
    return this.reviews.reply(reviewId, reviewedSupplier, auth.accountId, parsed.data.body);
  }
}
