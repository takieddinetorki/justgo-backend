import { Inject, Injectable, Logger } from '@nestjs/common';
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
  ShareChannel,
} from '../contract/dto';
import { MEDIA_PORT, type MediaPort } from '@justgo/media';
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

/** The one bucket in that list, named once so the signer cannot drift from it. */
const MEDIA_BUCKET = 'post-media';

/**
 * An hour. Long enough that scrolling back up a feed still shows pictures,
 * short enough that a URL copied out of a response stops working the same
 * afternoon.
 */
const MEDIA_URL_TTL = 3600;

@Injectable()
export class SocialService implements SocialPort {
  private readonly logger = new Logger(SocialService.name);

  constructor(
    @Inject(SOCIAL_REPOSITORY) private readonly repo: PgSocialRepository,
    @Inject(MEDIA_PORT) private readonly media: MediaPort,
  ) {}

  /**
   * Put a usable `url` on every image before the post leaves the service.
   *
   * WHY HERE AND NOT IN THE CLIENT. `post-media` is a private bucket, so
   * the (bucket, path) the feed used to return could not be rendered by
   * anything — and the endpoint that would have turned it into a URL did
   * not exist. The feed is also the worst place to make the client fetch
   * them one by one: a page is twenty posts, so it is one batch call to
   * Storage here, or hundreds of round trips from a phone.
   *
   * The URL expires; `(bucket, path)` does not, and both are returned.
   * A client holding a page longer than the hour re-reads the page, or
   * re-signs what it still needs through `POST /v1/media/downloads`.
   */
  private async withUrls<T extends PostDTO | null>(post: T): Promise<T>;
  private async withUrls(posts: PostDTO[]): Promise<PostDTO[]>;
  private async withUrls(input: PostDTO | PostDTO[] | null): Promise<PostDTO | PostDTO[] | null> {
    if (input === null) return null;
    const posts = Array.isArray(input) ? input : [input];
    /*
      `?? []` because a post is not required to carry media at all — a
      text-only post is the common case, and a caller that hands us a DTO
      without the array should get a post back, not a TypeError.
    */
    const paths = posts.flatMap((post) =>
      (post.media ?? []).filter((m) => m.bucket === MEDIA_BUCKET).map((m) => m.path),
    );
    if (paths.length > 0) {
      /*
        Signing must never cost us the post. Storage being down is a reason
        for a card with no picture, not for an empty feed, so a failure
        here leaves `url` null and the text still arrives.
      */
      let urls = new Map<string, string>();
      try {
        urls = await this.media.createSignedDownloadUrls({
          bucket: MEDIA_BUCKET,
          paths,
          expiresInSeconds: MEDIA_URL_TTL,
        });
      } catch (e) {
        this.logger.warn(`could not sign ${paths.length} post image(s): ${String(e)}`);
      }
      const expiresAt = new Date(Date.now() + MEDIA_URL_TTL * 1000).toISOString();
      for (const post of posts) {
        for (const item of post.media ?? []) {
          const url = urls.get(item.path) ?? null;
          item.url = url;
          item.urlExpiresAt = url ? expiresAt : null;
        }
      }
    }
    return Array.isArray(input) ? posts : posts[0];
  }

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
    return this.withUrls(await this.repo.publish(caller, input));
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
    const page = await this.repo.feed(caller, query);
    return { ...page, items: await this.withUrls(page.items) };
  }

  async getPost(caller: AccountId, postId: Uuid): Promise<PostDTO | null> {
    return this.withUrls(await this.repo.getPost(caller, postId));
  }

  async remove(caller: AccountId, postId: Uuid): Promise<PostDTO> {
    // The author guard is in the WHERE clause, so a post that is not theirs
    // comes back as 404 rather than confirming it exists.
    return this.withUrls(await this.repo.remove(postId, 'retracted by author', caller));
  }

  async removeAsAdmin(postId: Uuid, reason: string): Promise<PostDTO> {
    if (!reason.trim()) {
      throw new ValidationError('A takedown needs a reason');
    }
    return this.withUrls(await this.repo.remove(postId, reason.trim()));
  }

  async like(caller: AccountId, postId: Uuid): Promise<PostDTO> {
    return this.withUrls(await this.repo.like(caller, postId));
  }

  async unlike(caller: AccountId, postId: Uuid): Promise<PostDTO> {
    return this.withUrls(await this.repo.unlike(caller, postId));
  }

  async share(caller: AccountId, postId: Uuid, channel?: ShareChannel): Promise<PostDTO> {
    return this.withUrls(await this.repo.share(caller, postId, channel));
  }

  /*
    Pinning is the AUTHOR's act, and which pin it occupies depends on how the
    post was written: a post made on behalf of a business takes that
    business's single pin, a personal one takes the author's. The repository
    reads that from the row rather than taking it from the request, so a
    staff member cannot pin a personal post into a company's slot.
  */
  async pin(caller: AccountId, postId: Uuid): Promise<PostDTO> {
    return this.withUrls(await this.repo.setPinned(caller, postId, true));
  }

  async unpin(caller: AccountId, postId: Uuid): Promise<PostDTO> {
    return this.withUrls(await this.repo.setPinned(caller, postId, false));
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
