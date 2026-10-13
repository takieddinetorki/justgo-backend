import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type AccountId,
  type Uuid,
} from '@justgo/kernel';
import type { SocialPort } from '../contract/social.port';
import type {
  CommentPage,
  CreatePostDTO,
  FeedQuery,
  PostCommentDTO,
  PostDTO,
  PostPage,
} from '../contract/dto';
import { PgSocialRepository } from '../infra/pg-social.repository';

export const SOCIAL_REPOSITORY = Symbol('SOCIAL_REPOSITORY');

const MAX_BODY = 5000;
const MAX_COMMENT = 2000;
const MAX_MEDIA = 10;

/**
 * Buckets a post's media may point at.
 *
 * An allow-list, not a free string: `bucket` comes from the client, and
 * without this an author could address `registrations` and turn a public feed
 * post into a read handle for somebody's scanned vehicle papers.
 *
 * A PLAIN ARRAY, not a Set. SWC's loose downlevelling rewrites
 * `[...someSet]` as `[].concat(set)`, which appends the Set OBJECT instead of
 * its members — so the allow-list silently becomes `[{}]` and matches
 * nothing, in the webpack bundle only. That shipped twice in this codebase.
 * Mirrors the enum in media.controller.ts.
 */
const MEDIA_BUCKETS: readonly string[] = ['post-media'];

@Injectable()
export class SocialService implements SocialPort {
  constructor(@Inject(SOCIAL_REPOSITORY) private readonly repo: PgSocialRepository) {}

  async publish(caller: AccountId, input: CreatePostDTO): Promise<PostDTO> {
    /*
      A post must say something. This is a business rule, so it lives here
      rather than only in the repository — the repository keeps its own copy
      as the last line of defence, but a rule only enforced next to the SQL
      cannot be tested without a database and is easy to bypass by adding a
      second write path.
    */
    if ((input.body?.trim() ?? '').length === 0 && (input.media ?? []).length === 0) {
      throw new ValidationError('A post needs text or at least one photo or video');
    }
    if (input.body && input.body.length > MAX_BODY) {
      throw new ValidationError(`A post may not exceed ${MAX_BODY} characters`);
    }
    const media = input.media ?? [];
    if (media.length > MAX_MEDIA) {
      throw new ValidationError(`A post may carry at most ${MAX_MEDIA} items`);
    }
    for (const item of media) {
      if (!MEDIA_BUCKETS.includes(item.bucket)) {
        throw new ValidationError(`Attachments may not come from the "${item.bucket}" bucket`);
      }
      /*
        The uploader namespaces every object under the caller's account id
        (see media.controller.ts). Re-checking it here is what stops an author
        from pasting somebody else's upload path into their own post.
      */
      if (!item.path.startsWith(`${caller}/`)) {
        throw new ForbiddenError('Attachments must be your own uploads');
      }
      if (item.kind !== 'video' && item.durationMs !== undefined) {
        throw new ValidationError('durationMs applies to video only');
      }
    }
    return this.repo.publish(caller, input);
  }

  async feed(caller: AccountId, query: FeedQuery = {}): Promise<PostPage> {
    /*
      THERE IS NO FOLLOW GRAPH, so the feed is every published post, newest
      first. That is a deliberate starting point rather than an oversight: the
      shipped app has no follow or friend affordance anywhere in it, and a
      graph nobody can populate would just make the feed empty. Narrowing it
      later is additive — `authorAccountId` and `authorSupplierId` already
      give the profile and business timelines.
    */
    return this.repo.feed(caller, query);
  }

  async getPost(caller: AccountId, postId: Uuid): Promise<PostDTO | null> {
    return this.repo.getPost(caller, postId);
  }

  async remove(caller: AccountId, postId: Uuid): Promise<PostDTO> {
    // The author guard is in the WHERE clause, so a post that is not theirs
    // comes back as 404 rather than confirming it exists.
    return this.repo.remove(postId, 'retracted by author', caller);
  }

  async removeAsAdmin(postId: Uuid, reason: string): Promise<PostDTO> {
    if (!reason.trim()) {
      throw new ValidationError('A takedown needs a reason');
    }
    return this.repo.remove(postId, reason.trim());
  }

  async like(caller: AccountId, postId: Uuid): Promise<PostDTO> {
    return this.repo.like(caller, postId);
  }

  async unlike(caller: AccountId, postId: Uuid): Promise<PostDTO> {
    return this.repo.unlike(caller, postId);
  }

  async comment(
    caller: AccountId,
    postId: Uuid,
    input: { body: string; asSupplierId?: string },
  ): Promise<PostCommentDTO> {
    const body = input.body.trim();
    if (body.length === 0) throw new ValidationError('A comment needs a body');
    if (body.length > MAX_COMMENT) {
      throw new ValidationError(`A comment may not exceed ${MAX_COMMENT} characters`);
    }
    return this.repo.comment(caller, postId, { ...input, body });
  }

  async listComments(
    postId: Uuid,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CommentPage> {
    // A removed post's comments go with it; an unknown id is a 404 either way.
    if (!(await this.repo.isPublished(postId))) throw new NotFoundError('Post', postId);
    return this.repo.listComments(postId, opts);
  }
}
