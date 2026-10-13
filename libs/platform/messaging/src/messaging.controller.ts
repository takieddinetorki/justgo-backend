import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { Throttle } from '@nestjs/throttler';
import { asId, NotFoundError, ValidationError, type Uuid } from '@justgo/kernel';
import { MESSAGING_PORT, type MessagingPort } from './contract/messaging.port';
import type { ConversationDTO, MessageDTO, MessagePage } from './contract/dto';

const startSchema = z
  .object({
    withAccountId: z.string().uuid(),
    contextType: z.enum(['listing', 'request', 'order']).optional(),
    contextId: z.string().uuid().optional(),
    subject: z.string().max(200).optional(),
    asSupplierId: z.string().uuid().optional(),
  })
  .strict();

const sendSchema = z
  .object({
    kind: z.enum(['text', 'photo', 'voice']).optional(),
    body: z.string().max(4000).optional(),
    attachmentBucket: z.string().max(64).optional(),
    attachmentPath: z.string().max(300).optional(),
    durationMs: z.coerce.number().int().positive().max(600_000).optional(),
  })
  .strict();

const pageSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().max(400).optional(),
});

/**
 * Conversations (§15 client). Gated on `message.send`, a new permission
 * bit — messaging is not something every role should have by default.
 */
@Controller('conversations')
export class MessagingController {
  constructor(@Inject(MESSAGING_PORT) private readonly messaging: MessagingPort) {}

  @Get()
  @RequirePermissions('message.send')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: ConversationDTO[] }> {
    return {
      items: await this.messaging.listConversations(auth.accountId, limit ? Number(limit) : undefined),
    };
  }

  @Post()
  @RequirePermissions('message.send')
  async start(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ConversationDTO> {
    const parsed = startSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid conversation', { issues: parsed.error.issues });
    }
    return this.messaging.startConversation(auth.accountId, parsed.data);
  }

  @Get(':id')
  @RequirePermissions('message.send')
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<ConversationDTO> {
    const conv = await this.messaging.getConversation(auth.accountId, asId<Uuid>(id));
    if (!conv) throw new NotFoundError('Conversation', id);
    return conv;
  }

  @Get(':id/messages')
  @RequirePermissions('message.send')
  async messages(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<MessagePage> {
    const parsed = pageSchema.safeParse(query);
    if (!parsed.success) throw new ValidationError('Invalid query', { issues: parsed.error.issues });
    return this.messaging.listMessages(auth.accountId, asId<Uuid>(id), parsed.data);
  }

  /*
    Higher than the other writes: a real conversation is bursty, and
    someone typing fast should never meet a limit. Still bounded, because
    each message notifies the person on the other end.
  */
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Post(':id/messages')
  @RequirePermissions('message.send')
  async send(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MessageDTO> {
    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid message', { issues: parsed.error.issues });
    return this.messaging.sendMessage(auth.accountId, asId<Uuid>(id), parsed.data);
  }

  @Post(':id/read')
  @RequirePermissions('message.send')
  async read(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.messaging.markRead(auth.accountId, asId<Uuid>(id));
    return { ok: true };
  }
}
