import { Pool, type PoolClient } from 'pg';
import {
  asId,
  NotFoundError,
  ValidationError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { POST_COMMENTED, POST_LIKED, POST_PUBLISHED } from '../contract/events';
import type {
  CommentPage,
  CreatePostDTO,
  FeedQuery,
  PostCommentDTO,
  PostDTO,
  PostMediaDTO,
  PostMediaKind,
  PostPage,
  PostStatus,
} from '../contract/dto';

interface PostRow {
  id: string;
  author_account_id: string;
  author_supplier_id: string | null;
  body: string | null;
  like_count: number;
  comment_count: number;
  status: PostStatus;
  created_at: Date;
  liked_by_me: boolean;
}

interface MediaRow {
  id: string;
  post_id: string;
  kind: PostMediaKind;
  bucket: string;
  path: string;
  duration_ms: number | null;
  ordinal: number;
}

interface CommentRow {
  id: string;
  post_id: string;
  author_account_id: string;
  author_supplier_id: string | null;
  body: string;
  created_at: Date;
}

const POST_COLS = `p.id, p.author_account_id, p.author_supplier_id, p.body,
  p.like_count, p.comment_count, p.status, p.created_at`;

const COMMENT_COLS = `id, post_id, author_account_id, author_supplier_id, body, created_at`;

function toMedia(r: MediaRow): PostMediaDTO {
  return {
    id: asId<Uuid>(r.id),
    kind: r.kind,
    bucket: r.bucket,
    path: r.path,
    durationMs: r.duration_ms,
    ordinal: r.ordinal,
  };
}

function toPost(r: PostRow, media: PostMediaDTO[]): PostDTO {
  return {
    id: asId<Uuid>(r.id),
    authorAccountId: asId<AccountId>(r.author_account_id),
    authorSupplierId: r.author_supplier_id ? asId<SupplierId>(r.author_supplier_id) : null,
    body: r.body,
    media,
    likeCount: Number(r.like_count),
    commentCount: Number(r.comment_count),
    likedByMe: r.liked_by_me,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}

function toComment(r: CommentRow): PostCommentDTO {
  return {
    id: asId<Uuid>(r.id),
    postId: asId<Uuid>(r.post_id),
    authorAccountId: asId<AccountId>(r.author_account_id),
    authorSupplierId: r.author_supplier_id ? asId<SupplierId>(r.author_supplier_id) : null,
    body: r.body,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * The feed pages newest-first, so the cursor is the OLDEST row already seen.
 * Keyset on (created_at, id) rather than an offset: an offset shifts under
 * you every time somebody posts, which on a feed is constantly — the reader
 * would see duplicates and skip rows. Two posts can also share a
 * millisecond, and a cursor on the timestamp alone silently drops one.
 */
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

/** All SQL confined to the `social` schema (§17.4). */
export class PgSocialRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'social');
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

  private async mediaFor(
    client: PoolClient | Pool,
    postIds: string[],
  ): Promise<Map<string, PostMediaDTO[]>> {
    const byPost = new Map<string, PostMediaDTO[]>();
    if (postIds.length === 0) return byPost;

    // ONE query for the whole page, not one per post: a 20-post feed with
    // per-post media lookups is 21 round trips for one screen.
    const res = await client.query<MediaRow>(
      `select id, post_id, kind, bucket, path, duration_ms, ordinal
         from social.post_media
        where post_id = any($1::uuid[])
        order by post_id, ordinal, id`,
      [postIds],
    );
    for (const row of res.rows) {
      const list = byPost.get(row.post_id);
      if (list) list.push(toMedia(row));
      else byPost.set(row.post_id, [toMedia(row)]);
    }
    return byPost;
  }

  async publish(callerAccountId: AccountId, input: CreatePostDTO): Promise<PostDTO> {
    const media = input.media ?? [];
    const body = input.body?.trim() ?? '';
    if (body.length === 0 && media.length === 0) {
      throw new ValidationError('A post needs text or at least one photo or video');
    }

    return this.tx(async (client) => {
      const inserted = await client.query<PostRow>(
        `insert into social.posts (author_account_id, author_supplier_id, body)
         values ($1, $2, $3)
         returning id, author_account_id, author_supplier_id, body,
                   like_count, comment_count, status, created_at`,
        [callerAccountId, input.asSupplierId ?? null, body.length > 0 ? body : null],
      );
      const row = inserted.rows[0];

      for (const [ordinal, item] of media.entries()) {
        await client.query(
          `insert into social.post_media (post_id, kind, bucket, path, duration_ms, ordinal)
           values ($1, $2, $3, $4, $5, $6)`,
          [row.id, item.kind, item.bucket, item.path, item.durationMs ?? null, ordinal],
        );
      }

      await this.outbox.appendWith(client, [
        makeEvent({
          type: POST_PUBLISHED,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            postId: row.id,
            authorAccountId: row.author_account_id,
            authorSupplierId: row.author_supplier_id,
            preview: body.length > 0 ? body.slice(0, 140) : null,
            mediaCount: media.length,
            occurredAt: row.created_at.toISOString(),
          },
        }),
      ]);

      const withMedia = await this.mediaFor(client, [row.id]);
      // The author has not liked their own brand-new post.
      return toPost({ ...row, liked_by_me: false }, withMedia.get(row.id) ?? []);
    });
  }

  async feed(callerAccountId: AccountId, query: FeedQuery = {}): Promise<PostPage> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const params: unknown[] = [callerAccountId];
    const conditions = [`p.status = 'published'`];

    if (query.authorAccountId) {
      params.push(query.authorAccountId);
      conditions.push(`p.author_account_id = $${params.length}`);
    }
    if (query.authorSupplierId) {
      params.push(query.authorSupplierId);
      conditions.push(`p.author_supplier_id = $${params.length}`);
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      params.push(cursor.at, cursor.id);
      conditions.push(
        `(p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(limit + 1); // one extra row answers "is there a next page?"

    const res = await this.pool.query<PostRow>(
      `select ${POST_COLS},
              exists (
                select 1 from social.post_likes l
                 where l.post_id = p.id and l.account_id = $1
              ) as liked_by_me
         from social.posts p
        where ${conditions.join(' and ')}
        order by p.created_at desc, p.id desc
        limit $${params.length}`,
      params,
    );

    const rows = res.rows.slice(0, limit);
    const media = await this.mediaFor(this.pool, rows.map((r) => r.id));
    const last = rows[rows.length - 1];
    return {
      items: rows.map((r) => toPost(r, media.get(r.id) ?? [])),
      nextCursor:
        res.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async getPost(callerAccountId: AccountId, postId: Uuid): Promise<PostDTO | null> {
    const res = await this.pool.query<PostRow>(
      `select ${POST_COLS},
              exists (
                select 1 from social.post_likes l
                 where l.post_id = p.id and l.account_id = $2
              ) as liked_by_me
         from social.posts p
        where p.id = $1
          and (p.status = 'published' or p.author_account_id = $2)`,
      [postId, callerAccountId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const media = await this.mediaFor(this.pool, [row.id]);
    return toPost(row, media.get(row.id) ?? []);
  }

  /** Is there a published post here at all? No caller needed. */
  async isPublished(postId: Uuid): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from social.posts where id = $1 and status = 'published'`,
      [postId],
    );
    return res.rowCount === 1;
  }

  /**
   * Retract a post. `status = 'removed'`, never a DELETE: a post somebody has
   * commented on or reported should stop being visible without taking the
   * surrounding conversation, or the evidence, with it.
   */
  async remove(postId: Uuid, reason: string, authorAccountId?: AccountId): Promise<PostDTO> {
    const params: unknown[] = [postId, reason];
    let guard = '';
    if (authorAccountId) {
      params.push(authorAccountId);
      guard = ` and author_account_id = $${params.length}`;
    }
    const res = await this.pool.query<PostRow>(
      `update social.posts
          set status = 'removed', removed_at = now(), removed_reason = $2, updated_at = now()
        where id = $1 and status = 'published'${guard}
        returning id, author_account_id, author_supplier_id, body,
                  like_count, comment_count, status, created_at`,
      params,
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundError('Post', postId);
    return toPost({ ...row, liked_by_me: false }, []);
  }

  /**
   * Like, idempotently.
   *
   * `on conflict do nothing` plus a counter bumped only when a row was
   * actually inserted. Double-tapping is how people use a like button, and
   * incrementing on every call would inflate the count permanently with no
   * way to recover the true value.
   */
  async like(callerAccountId: AccountId, postId: Uuid): Promise<PostDTO> {
    await this.tx(async (client) => {
      const ins = await client.query(
        `insert into social.post_likes (post_id, account_id) values ($1, $2)
         on conflict (post_id, account_id) do nothing`,
        [postId, callerAccountId],
      );
      if (ins.rowCount === 0) return; // already liked — nothing to count or announce

      const bumped = await client.query<{ author_account_id: string }>(
        `update social.posts set like_count = like_count + 1, updated_at = now()
          where id = $1 and status = 'published'
          returning author_account_id`,
        [postId],
      );
      if (!bumped.rows[0]) throw new NotFoundError('Post', postId);

      await this.outbox.appendWith(client, [
        makeEvent({
          type: POST_LIKED,
          aggregateId: asId<Uuid>(postId),
          payload: {
            postId,
            accountId: callerAccountId,
            authorAccountId: bumped.rows[0].author_account_id,
          },
        }),
      ]);
    });

    const post = await this.getPost(callerAccountId, postId);
    if (!post) throw new NotFoundError('Post', postId);
    return post;
  }

  async unlike(callerAccountId: AccountId, postId: Uuid): Promise<PostDTO> {
    await this.tx(async (client) => {
      const del = await client.query(
        `delete from social.post_likes where post_id = $1 and account_id = $2`,
        [postId, callerAccountId],
      );
      if (del.rowCount === 0) return; // was not liked — leave the counter alone

      // `greatest(…, 0)` is belt and braces: the column has a non-negative
      // check, and a counter that underflowed would fail the write instead of
      // the read. Clamping keeps a historical drift from bricking unlike.
      await client.query(
        `update social.posts
            set like_count = greatest(like_count - 1, 0), updated_at = now()
          where id = $1`,
        [postId],
      );
    });

    const post = await this.getPost(callerAccountId, postId);
    if (!post) throw new NotFoundError('Post', postId);
    return post;
  }

  async comment(
    callerAccountId: AccountId,
    postId: Uuid,
    input: { body: string; asSupplierId?: string },
  ): Promise<PostCommentDTO> {
    return this.tx(async (client) => {
      const bumped = await client.query<{ author_account_id: string }>(
        `update social.posts set comment_count = comment_count + 1, updated_at = now()
          where id = $1 and status = 'published'
          returning author_account_id`,
        [postId],
      );
      if (!bumped.rows[0]) throw new NotFoundError('Post', postId);

      const res = await client.query<CommentRow>(
        `insert into social.post_comments (post_id, author_account_id, author_supplier_id, body)
         values ($1, $2, $3, $4)
         returning ${COMMENT_COLS}`,
        [postId, callerAccountId, input.asSupplierId ?? null, input.body.trim()],
      );
      const comment = toComment(res.rows[0]);

      await this.outbox.appendWith(client, [
        makeEvent({
          type: POST_COMMENTED,
          aggregateId: asId<Uuid>(postId),
          payload: {
            postId,
            commentId: comment.id,
            authorAccountId: callerAccountId,
            postAuthorAccountId: bumped.rows[0].author_account_id,
            preview: comment.body.slice(0, 140),
          },
        }),
      ]);
      return comment;
    });
  }

  /** Comments read OLDEST first — a thread is read in the order it was said. */
  async listComments(
    postId: Uuid,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CommentPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const params: unknown[] = [postId];
    let keyset = '';
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (cursor) {
      params.push(cursor.at, cursor.id);
      keyset = ` and (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);

    const res = await this.pool.query<CommentRow>(
      `select ${COMMENT_COLS} from social.post_comments
        where post_id = $1 and status = 'published'${keyset}
        order by created_at, id
        limit $${params.length}`,
      params,
    );
    const rows = res.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map(toComment),
      nextCursor: res.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }
}
