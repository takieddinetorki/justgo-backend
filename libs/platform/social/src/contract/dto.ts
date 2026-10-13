import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

export type PostStatus = 'published' | 'removed';
export type PostMediaKind = 'photo' | 'video';

export interface PostMediaDTO {
  id: Uuid;
  kind: PostMediaKind;
  bucket: string;
  path: string;
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
  media: PostMediaDTO[];
  likeCount: number;
  commentCount: number;
  /** Whether the CALLER has liked it — drives the filled heart. */
  likedByMe: boolean;
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
}

export interface PostPage {
  items: PostDTO[];
  nextCursor: string | null;
}

export interface CommentPage {
  items: PostCommentDTO[];
  nextCursor: string | null;
}
