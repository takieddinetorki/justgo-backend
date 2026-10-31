import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { Throttle } from '@nestjs/throttler';
import { asId, ForbiddenError, NotFoundError, ValidationError, type Uuid } from '@justgo/kernel';
import { SOCIAL_PORT, type SocialPort } from './contract/social.port';
import type { CommentPage, PostCommentDTO, PostDTO, PostPage } from './contract/dto';

const mediaSchema = z
  .object({
    kind: z.enum(['photo', 'video']),
    bucket: z.string().max(64),
    path: z.string().min(1).max(300),
    durationMs: z.coerce.number().int().positive().max(30 * 60_000).optional(),
  })
  .strict();

const KINDS = ['announcement', 'promotion', 'arrival', 'job'] as const;

const createSchema = z
  .object({
    body: z.string().max(5000).optional(),
    kind: z.enum(KINDS).optional(),
    media: z.array(mediaSchema).max(10).optional(),
    asSupplierId: z.string().uuid().optional(),
  })
  .strict();

const shareSchema = z
  .object({ channel: z.enum(['link', 'whatsapp', 'facebook', 'other']).optional() })
  .strict();

const commentSchema = z
  .object({
    body: z.string().min(1).max(2000),
    asSupplierId: z.string().uuid().optional(),
  })
  .strict();

const feedSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().max(400).optional(),
  author: z.string().uuid().optional(),
  supplier: z.string().uuid().optional(),
  kind: z.enum(KINDS).optional(),
  pinnedFirst: z.coerce.boolean().optional(),
});

const pageSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().max(400).optional(),
});

const takedownSchema = z.object({ reason: z.string().min(1).max(500) }).strict();

/** Community feed (§15 client — social). */
@Controller()
export class SocialController {
  constructor(@Inject(SOCIAL_PORT) private readonly social: SocialPort) {}

  /**
   * Asserts the caller may speak for a business.
   *
   * Without this, `asSupplierId` is a free-text field that would let anyone
   * post a promotion under any shop's name — the single most damaging thing
   * a feed can get wrong, because readers trust the badge.
   */
  private assertMaySpeakFor(auth: AuthContext, supplierId?: string): void {
    if (!supplierId) return;
    if (auth.supplierScope?.supplierId !== supplierId) {
      throw new ForbiddenError('You may only post on behalf of your own business');
    }
  }

  @Get('feed')
  @RequirePermissions()
  async feed(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<PostPage> {
    const parsed = feedSchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError('Invalid feed query', { issues: parsed.error.issues });
    }
    return this.social.feed(auth.accountId, {
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
      authorAccountId: parsed.data.author,
      authorSupplierId: parsed.data.supplier,
      kind: parsed.data.kind,
      pinnedFirst: parsed.data.pinnedFirst,
    });
  }

  /*
    A spam POST reaches everyone who opens the feed, which is what makes
    this worth a tighter limit than a read. Thirty a minute is far above
    anyone composing real posts and far below anything worth automating.
  */
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('posts')
  @RequirePermissions('post.publish')
  async publish(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<PostDTO> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid post', { issues: parsed.error.issues });
    }
    this.assertMaySpeakFor(auth, parsed.data.asSupplierId);
    return this.social.publish(auth.accountId, parsed.data);
  }

  @Get('posts/:id')
  @RequirePermissions()
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<PostDTO> {
    const post = await this.social.getPost(auth.accountId, asId<Uuid>(id));
    if (!post) throw new NotFoundError('Post', id);
    return post;
  }

  /** The author retracts their own post. 404 if it is not theirs. */
  @Delete('posts/:id')
  @RequirePermissions('post.publish')
  async remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<PostDTO> {
    return this.social.remove(auth.accountId, asId<Uuid>(id));
  }

  /** Administrative takedown — any post, with a stated reason. */
  @Post('posts/:id/takedown')
  @RequirePermissions('platform.admin')
  async takedown(@Param('id') id: string, @Body() body: unknown): Promise<PostDTO> {
    const parsed = takedownSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid takedown', { issues: parsed.error.issues });
    }
    return this.social.removeAsAdmin(asId<Uuid>(id), parsed.data.reason);
  }

  /** Idempotent — liking twice leaves one like and one count. */
  @Post('posts/:id/like')
  @RequirePermissions('post.interact')
  async like(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<PostDTO> {
    return this.social.like(auth.accountId, asId<Uuid>(id));
  }

  @Delete('posts/:id/like')
  @RequirePermissions('post.interact')
  async unlike(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<PostDTO> {
    return this.social.unlike(auth.accountId, asId<Uuid>(id));
  }

  /**
   * Share. Idempotent and not retractable — the count is a reach number, so
   * it describes something that happened outside the app rather than a mood
   * that can be changed back.
   */
  @Post('posts/:id/share')
  @RequirePermissions('post.interact')
  async share(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PostDTO> {
    const parsed = shareSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid share', { issues: parsed.error.issues });
    }
    return this.social.share(auth.accountId, asId<Uuid>(id), parsed.data.channel);
  }

  /**
   * Pin this post to the top of its author's page.
   *
   * PUT because there is one pin and this replaces whatever held it — a
   * retried request leaves exactly the same state, which POST would not
   * promise. The author's own post only: 404 otherwise, rather than a 403
   * that would confirm the id is real.
   */
  @Put('posts/:id/pin')
  @RequirePermissions('post.publish')
  async pin(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<PostDTO> {
    return this.social.pin(auth.accountId, asId<Uuid>(id));
  }

  @Delete('posts/:id/pin')
  @RequirePermissions('post.publish')
  async unpin(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<PostDTO> {
    return this.social.unpin(auth.accountId, asId<Uuid>(id));
  }

  @Get('posts/:id/comments')
  @RequirePermissions()
  async comments(@Param('id') id: string, @Query() query: unknown): Promise<CommentPage> {
    const parsed = pageSchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError('Invalid page', { issues: parsed.error.issues });
    }
    return this.social.listComments(asId<Uuid>(id), parsed.data);
  }

  /* Same reasoning as publishing: a comment is visible to everyone. */
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('posts/:id/comments')
  @HttpCode(201)
  @RequirePermissions('post.interact')
  async comment(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PostCommentDTO> {
    const parsed = commentSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid comment', { issues: parsed.error.issues });
    }
    this.assertMaySpeakFor(auth, parsed.data.asSupplierId);
    return this.social.comment(auth.accountId, asId<Uuid>(id), parsed.data);
  }
}
