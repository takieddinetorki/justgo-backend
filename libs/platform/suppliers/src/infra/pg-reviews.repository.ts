import { Pool, type PoolClient } from 'pg';
import {
  asId,
  BusinessRuleError,
  NotFoundError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { SUPPLIER_REVIEWED, SUPPLIER_UPDATED } from '../contract/events';
import type {
  CreateReviewDTO,
  ReviewDTO,
  ReviewPage,
  ReviewReplyDTO,
  ReviewSource,
  ReviewStatus,
  UpdateReviewDTO,
} from '../contract/dto';
import { SUPPLIER_COLS, toUpdatedEvent, type SupplierRow } from './supplier-row';

interface ReviewRow {
  id: string;
  supplier_id: string;
  author_account_id: string;
  rating: number;
  body: string | null;
  status: ReviewStatus;
  source: ReviewSource;
  source_id: string;
  created_at: Date;
  updated_at: Date;
  reply_body: string | null;
  reply_author_account_id: string | null;
  reply_created_at: Date | null;
}

const REVIEW_COLS = `r.id, r.supplier_id, r.author_account_id, r.rating, r.body,
  r.status, r.source, r.source_id, r.created_at, r.updated_at,
  rr.body as reply_body, rr.author_account_id as reply_author_account_id,
  rr.created_at as reply_created_at`;

const REVIEW_FROM = `from suppliers.reviews r
  left join suppliers.review_replies rr on rr.review_id = r.id`;

function toReply(row: ReviewRow): ReviewReplyDTO | null {
  if (row.reply_body === null || row.reply_author_account_id === null) return null;
  return {
    reviewId: asId<Uuid>(row.id),
    supplierId: asId<SupplierId>(row.supplier_id),
    authorAccountId: asId<AccountId>(row.reply_author_account_id),
    body: row.reply_body,
    createdAt: (row.reply_created_at ?? row.created_at).toISOString(),
  };
}

function toReview(row: ReviewRow): ReviewDTO {
  return {
    id: asId<Uuid>(row.id),
    supplierId: asId<SupplierId>(row.supplier_id),
    authorAccountId: asId<AccountId>(row.author_account_id),
    rating: Number(row.rating),
    body: row.body,
    status: row.status,
    source: row.source,
    reply: toReply(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Newest-first keyset, same shape as the feed's — see social for why. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}\u0000${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000');
    return at && id ? { at, id } : null;
  } catch {
    return null;
  }
}

/** All SQL confined to the `suppliers` schema (§17.4). */
export class PgReviewsRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'suppliers');
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Move the average by a known delta, and announce the new row.
   *
   * The deltas, not a re-aggregate: `update … set rating = (select avg(…))`
   * would scan every review of a busy supplier on each write, and would
   * deadlock against itself under two concurrent reviews. `greatest(…, 0)`
   * guards the non-negative CHECK so a historical drift cannot brick the
   * write path entirely.
   *
   * It runs inside the caller's transaction, so the review and the number
   * printed above it can never disagree.
   */
  private async applyRating(
    client: PoolClient,
    supplierId: SupplierId,
    deltaSum: number,
    deltaCount: number,
  ): Promise<SupplierRow> {
    const res = await client.query<SupplierRow>(
      `update suppliers.suppliers
          set rating_sum = greatest(rating_sum + $2, 0),
              rating_count = greatest(rating_count + $3, 0),
              rating = case
                when greatest(rating_count + $3, 0) = 0 then null
                else round(
                  greatest(rating_sum + $2, 0)::numeric
                  / greatest(rating_count + $3, 0), 1)
              end,
              updated_at = now()
        where id = $1
        returning ${SUPPLIER_COLS}`,
      [supplierId, deltaSum, deltaCount],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundError('Supplier', supplierId);
    await this.outbox.appendWith(client, [
      makeEvent({
        type: SUPPLIER_UPDATED,
        aggregateId: asId<Uuid>(row.id),
        payload: toUpdatedEvent(row),
      }),
    ]);
    return row;
  }

  private async loadReview(client: PoolClient | Pool, reviewId: Uuid): Promise<ReviewDTO | null> {
    const res = await client.query<ReviewRow>(
      `select ${REVIEW_COLS} ${REVIEW_FROM} where r.id = $1`,
      [reviewId],
    );
    return res.rows[0] ? toReview(res.rows[0]) : null;
  }

  async list(
    supplierId: SupplierId,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<ReviewPage> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const params: unknown[] = [supplierId];
    let keyset = '';
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (cursor) {
      params.push(cursor.at, cursor.id);
      keyset = ` and (r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);

    const res = await this.pool.query<ReviewRow>(
      `select ${REVIEW_COLS} ${REVIEW_FROM}
        where r.supplier_id = $1 and r.status = 'published'${keyset}
        order by r.created_at desc, r.id desc
        limit $${params.length}`,
      params,
    );
    const rows = res.rows.slice(0, limit);
    const last = rows[rows.length - 1];

    /*
      The average comes from the supplier row, not from AVG() over this page.
      A page is 20 reviews; the rating is over all of them, and computing it
      here would make the number change as you scrolled.
    */
    const summary = await this.pool.query<{ rating: string | null; rating_count: number }>(
      `select rating, rating_count from suppliers.suppliers where id = $1`,
      [supplierId],
    );

    return {
      items: rows.map(toReview),
      nextCursor:
        res.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      summary: {
        rating: summary.rows[0]?.rating == null ? null : Number(summary.rows[0].rating),
        ratingCount: Number(summary.rows[0]?.rating_count ?? 0),
      },
    };
  }

  async mine(supplierId: SupplierId, accountId: AccountId): Promise<ReviewDTO | null> {
    const res = await this.pool.query<ReviewRow>(
      `select ${REVIEW_COLS} ${REVIEW_FROM}
        where r.supplier_id = $1 and r.author_account_id = $2 and r.status = 'published'`,
      [supplierId, accountId],
    );
    return res.rows[0] ? toReview(res.rows[0]) : null;
  }

  /**
   * The oldest completed dealing with this business, if any.
   *
   * Oldest rather than newest so the evidence a review cites stays the same
   * one across edits — a review that said "order" and later says
   * "reservation" because a newer booking completed would be rewriting its
   * own provenance.
   */
  private async eligibilityFor(
    client: PoolClient | Pool,
    supplierId: SupplierId,
    accountId: AccountId,
  ): Promise<{ source: ReviewSource; source_id: string } | null> {
    const res = await client.query<{ source: ReviewSource; source_id: string }>(
      `select source, source_id from suppliers.review_eligibility
        where account_id = $1 and supplier_id = $2
        order by completed_at, source_id
        limit 1`,
      [accountId, supplierId],
    );
    return res.rows[0] ?? null;
  }

  async mayReview(supplierId: SupplierId, accountId: AccountId): Promise<boolean> {
    return (await this.eligibilityFor(this.pool, supplierId, accountId)) !== null;
  }

  async recordEligibility(input: {
    accountId: AccountId;
    supplierId: SupplierId;
    source: ReviewSource;
    sourceId: Uuid;
  }): Promise<void> {
    // Idempotent: the relay delivers at least once, and a redelivered
    // "order completed" must not look like a second dealing.
    await this.pool.query(
      `insert into suppliers.review_eligibility (account_id, supplier_id, source, source_id)
       values ($1, $2, $3, $4)
       on conflict (account_id, supplier_id, source, source_id) do nothing`,
      [input.accountId, input.supplierId, input.source, input.sourceId],
    );
  }

  async write(
    supplierId: SupplierId,
    authorAccountId: AccountId,
    input: CreateReviewDTO,
  ): Promise<ReviewDTO> {
    return this.tx(async (client) => {
      const evidence = await this.eligibilityFor(client, supplierId, authorAccountId);
      if (!evidence) {
        throw new BusinessRuleError(
          'NO_COMPLETED_DEALING',
          'You can review a business once an order or a reservation with it has completed',
          { supplierId },
        );
      }

      const existing = await client.query<{ id: string }>(
        `select id from suppliers.reviews
          where supplier_id = $1 and author_account_id = $2 and status = 'published'`,
        [supplierId, authorAccountId],
      );
      if (existing.rows[0]) {
        throw new BusinessRuleError(
          'ALREADY_REVIEWED',
          'You have already reviewed this business — edit your review instead',
          { reviewId: existing.rows[0].id },
        );
      }

      const inserted = await client.query<{ id: string }>(
        `insert into suppliers.reviews
           (supplier_id, author_account_id, rating, body, source, source_id)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [
          supplierId,
          authorAccountId,
          input.rating,
          input.body?.trim() || null,
          evidence.source,
          evidence.source_id,
        ],
      );
      const reviewId = asId<Uuid>(inserted.rows[0].id);
      const supplier = await this.applyRating(client, supplierId, input.rating, 1);

      await this.outbox.appendWith(client, [
        makeEvent({
          type: SUPPLIER_REVIEWED,
          aggregateId: reviewId,
          payload: {
            supplierId,
            reviewId,
            ownerAccountId: supplier.owner_account_id,
            authorAccountId,
            rating: input.rating,
            preview: input.body?.trim().slice(0, 140) || null,
          },
        }),
      ]);

      const review = await this.loadReview(client, reviewId);
      if (!review) throw new NotFoundError('Review', reviewId);
      return review;
    });
  }

  async edit(
    reviewId: Uuid,
    authorAccountId: AccountId,
    patch: UpdateReviewDTO,
  ): Promise<ReviewDTO> {
    return this.tx(async (client) => {
      /*
        `for update` on the review row, because the rating delta is computed
        from the value we just read. Two concurrent edits of one review
        without it would both compute from the same old rating and leave the
        average permanently wrong.
      */
      const current = await client.query<{ supplier_id: string; rating: number }>(
        `select supplier_id, rating from suppliers.reviews
          where id = $1 and author_account_id = $2 and status = 'published'
          for update`,
        [reviewId, authorAccountId],
      );
      const before = current.rows[0];
      if (!before) throw new NotFoundError('Review', reviewId);

      const nextRating = patch.rating ?? Number(before.rating);
      await client.query(
        `update suppliers.reviews
            set rating = $2,
                body = case when $4::boolean then $3 else body end,
                updated_at = now()
          where id = $1`,
        [reviewId, nextRating, patch.body?.trim() || null, patch.body !== undefined],
      );

      if (nextRating !== Number(before.rating)) {
        await this.applyRating(
          client,
          asId<SupplierId>(before.supplier_id),
          nextRating - Number(before.rating),
          0,
        );
      }

      const review = await this.loadReview(client, reviewId);
      if (!review) throw new NotFoundError('Review', reviewId);
      return review;
    });
  }

  /**
   * Retract or take down.
   *
   * `status = 'removed'` rather than a DELETE, for the same reason a post is:
   * a review the business has already answered, or that a complaint refers
   * to, should stop counting without taking the reply or the evidence with
   * it. The partial unique index is on `published`, so retracting also frees
   * the author to write a new one — which is the point when a shop has put
   * something right.
   */
  async remove(
    reviewId: Uuid,
    reason: string,
    authorAccountId?: AccountId,
  ): Promise<ReviewDTO> {
    return this.tx(async (client) => {
      const params: unknown[] = [reviewId];
      let guard = '';
      if (authorAccountId) {
        params.push(authorAccountId);
        guard = ` and author_account_id = $${params.length}`;
      }
      const res = await client.query<{ supplier_id: string; rating: number }>(
        `select supplier_id, rating from suppliers.reviews
          where id = $1 and status = 'published'${guard}
          for update`,
        params,
      );
      const before = res.rows[0];
      if (!before) throw new NotFoundError('Review', reviewId);

      await client.query(
        `update suppliers.reviews
            set status = 'removed', removed_at = now(), removed_reason = $2, updated_at = now()
          where id = $1`,
        [reviewId, reason],
      );
      await this.applyRating(
        client,
        asId<SupplierId>(before.supplier_id),
        -Number(before.rating),
        -1,
      );

      const review = await this.loadReview(client, reviewId);
      if (!review) throw new NotFoundError('Review', reviewId);
      return review;
    });
  }

  /**
   * The business answers. One reply per review — a second call replaces the
   * first rather than starting a thread, which is how a review page becomes
   * an argument.
   */
  async reply(
    reviewId: Uuid,
    supplierId: SupplierId,
    authorAccountId: AccountId,
    body: string,
  ): Promise<ReviewDTO> {
    const belongs = await this.pool.query(
      `select 1 from suppliers.reviews
        where id = $1 and supplier_id = $2 and status = 'published'`,
      [reviewId, supplierId],
    );
    if (belongs.rowCount === 0) throw new NotFoundError('Review', reviewId);

    await this.pool.query(
      `insert into suppliers.review_replies (review_id, supplier_id, author_account_id, body)
       values ($1, $2, $3, $4)
       on conflict (review_id) do update
         set body = excluded.body,
             author_account_id = excluded.author_account_id,
             updated_at = now()`,
      [reviewId, supplierId, authorAccountId, body.trim()],
    );

    const review = await this.loadReview(this.pool, reviewId);
    if (!review) throw new NotFoundError('Review', reviewId);
    return review;
  }

  /** Which business a review is about — the controller needs it to scope a reply. */
  async supplierOf(reviewId: Uuid): Promise<SupplierId | null> {
    const res = await this.pool.query<{ supplier_id: string }>(
      `select supplier_id from suppliers.reviews where id = $1`,
      [reviewId],
    );
    return res.rows[0] ? asId<SupplierId>(res.rows[0].supplier_id) : null;
  }
}
