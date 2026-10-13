import type { AccountId, Uuid } from '@justgo/kernel';
import type {
  CommentPage,
  CreatePostDTO,
  FeedQuery,
  PostCommentDTO,
  PostDTO,
  PostPage,
} from './dto';

/**
 * Public port of the social context (§6.1).
 *
 * Every read takes the caller's account id even though the feed is open to
 * any authenticated account, because `likedByMe` is per-caller. A feed
 * method without it would force the client to fetch likes separately on
 * every page.
 */
export interface SocialPort {
  publish(callerAccountId: AccountId, input: CreatePostDTO): Promise<PostDTO>;
  feed(callerAccountId: AccountId, query?: FeedQuery): Promise<PostPage>;
  getPost(callerAccountId: AccountId, postId: Uuid): Promise<PostDTO | null>;
  /** The author retracts their own post. */
  remove(callerAccountId: AccountId, postId: Uuid): Promise<PostDTO>;
  /** Administrative takedown — `platform.admin`, any post. */
  removeAsAdmin(postId: Uuid, reason: string): Promise<PostDTO>;

  /** Idempotent: liking twice leaves one like and one count. */
  like(callerAccountId: AccountId, postId: Uuid): Promise<PostDTO>;
  unlike(callerAccountId: AccountId, postId: Uuid): Promise<PostDTO>;

  comment(
    callerAccountId: AccountId,
    postId: Uuid,
    input: { body: string; asSupplierId?: string },
  ): Promise<PostCommentDTO>;
  listComments(postId: Uuid, opts?: { limit?: number; cursor?: string }): Promise<CommentPage>;
}

export const SOCIAL_PORT = Symbol('SOCIAL_PORT');
