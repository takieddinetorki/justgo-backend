/** Events emitted by social (§12). Versioned and additive. */

export const POST_PUBLISHED = 'social.PostPublished';
export interface PostPublishedV1 {
  postId: string;
  authorAccountId: string;
  authorSupplierId: string | null;
  /** Short preview for a notification body; never the media. */
  preview: string | null;
  mediaCount: number;
  occurredAt: string;
}

export const POST_LIKED = 'social.PostLiked';
export interface PostLikedV1 {
  postId: string;
  /** Who liked it. */
  accountId: string;
  /** Who wrote the post — the one who should hear about it. */
  authorAccountId: string;
}

export const POST_COMMENTED = 'social.PostCommented';
export interface PostCommentedV1 {
  postId: string;
  commentId: string;
  authorAccountId: string;
  /** The post's author, who should hear about it — may be the commenter. */
  postAuthorAccountId: string;
  preview: string;
}
