import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

export type PostStatus = 'published' | 'removed';
export type PostMediaKind = 'photo' | 'video';

/**
 * What a post IS, which is the chip drawn on its card.
 *
 * A presentation taxonomy, fixed in the contract rather than administered as
 * tenant data: these four change a label and what a filter offers, nothing
 * else, and a lookup table would put a join on every feed page for a string
 * the client has already translated.
 *
 * - `announcement` — the default, and what every existing post is.
 * - `promotion` — a price or an offer, the one worth filtering for.
 * - `arrival` — new stock in.
 * - `job` — hiring.
 */
export type PostKind = 'announcement' | 'promotion' | 'arrival' | 'job';

/** Where a share went, when the client says. */
export type ShareChannel = 'link' | 'whatsapp' | 'facebook' | 'other';

export interface PostMediaDTO {
  id: Uuid;
  kind: PostMediaKind;
  bucket: string;
  path: string;
  /**
   * A URL that will actually load the bytes — put `<img src>` here.
   *
   * `post-media` is a private bucket, so (bucket, path) alone renders
   * nothing; this is signed when the post is read. It EXPIRES, which is
   * why the pair above is still returned: re-read the post, or re-sign
   * the pair through `POST /v1/media/downloads`.
   *
   * null means Storage had no such object — an image that was deleted
   * under a post that still exists. Show the post without it.
   */
  url: string | null;
  /** When `url` stops working. null whenever `url` is null. */
  urlExpiresAt: string | null;
  /** Video only. */
  durationMs: number | null;
  ordinal: number;
}

export interface PostDTO {
  id: Uuid;
  /** Who actually pressed post. Always set. */
  authorAccountId: AccountId;
  /**
   * The business they pressed it on behalf of, if any. A client posting about
   * their own car has none; a *fournisseur*'s staff posting a promotion has
   * both this and the account above.
   */
  authorSupplierId: SupplierId | null;
  body: string | null;
  kind: PostKind;
  media: PostMediaDTO[];
  likeCount: number;
  commentCount: number;
  shareCount: number;
  /** Whether the CALLER has liked it — drives the filled heart. */
  likedByMe: boolean;
  /**
   * Set while this post is pinned to the top of its author's page. One per
   * business and one per person, so pinning another replaces it.
   */
  pinnedAt: string | null;
  status: PostStatus;
  createdAt: string;
}

export interface PostCommentDTO {
  id: Uuid;
  postId: Uuid;
  authorAccountId: AccountId;
  authorSupplierId: SupplierId | null;
  body: string;
  createdAt: string;
}

export interface CreatePostMediaDTO {
  kind: PostMediaKind;
  bucket: string;
  path: string;
  durationMs?: number;
}

export interface CreatePostDTO {
  body?: string;
  /** Defaults to `announcement`, which is what every post was before kinds. */
  kind?: PostKind;
  media?: CreatePostMediaDTO[];
  /** Post as this business. Requires the caller to hold its scope. */
  asSupplierId?: string;
}

export interface FeedQuery {
  limit?: number;
  cursor?: string;
  /** Only this account's posts — a profile timeline. */
  authorAccountId?: string;
  /** Only posts made on behalf of this business — a business page. */
  authorSupplierId?: string;
  /** Only this kind — "promotions" is the obvious first filter. */
  kind?: PostKind;
  /**
   * Put the author's pinned post first.
   *
   * Only meaningful on a timeline — a profile or a business page — which is
   * why it is opt-in rather than the default: on the global feed "pinned
   * first" would mean every business's pin ahead of everything written
   * today, which is not a feed, it is an advertising board.
   */
  pinnedFirst?: boolean;
}

export interface PostPage {
  items: PostDTO[];
  nextCursor: string | null;
}

export interface CommentPage {
  items: PostCommentDTO[];
  nextCursor: string | null;
}
