import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type AccountId,
  type Uuid,
} from '@justgo/kernel';
import type { MessagingPort } from '../contract/messaging.port';
import type {
  ConversationDTO,
  MessageDTO,
  MessageKind,
  MessagePage,
  SendMessageDTO,
  StartConversationDTO,
} from '../contract/dto';
import { PgMessagingRepository } from '../infra/pg-messaging.repository';

export const MESSAGING_REPOSITORY = Symbol('MESSAGING_REPOSITORY');

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;
const MAX_BODY = 4000;

/**
 * Buckets a message attachment may point at.
 *
 * An allow-list, not a free string: `attachmentBucket` comes from the
 * client, and without this a sender could address `registrations` and
 * turn a chat message into a read handle for somebody's scanned vehicle
 * papers. Mirrors the enum in media.controller.ts.
 *
 * An ARRAY, deliberately — see the note where it is used.
 */
const ATTACHMENT_BUCKETS: readonly string[] = ['message-attachments'];

@Injectable()
export class MessagingService implements MessagingPort {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repo: PgMessagingRepository,
  ) {}

  /** Every read and write funnels through this. */
  private async assertParticipant(conversationId: Uuid, caller: AccountId): Promise<void> {
    if (!(await this.repo.isParticipant(conversationId, caller))) {
      /*
        404, not 403. Telling a stranger "this exists but is not yours"
        confirms a conversation id they guessed; an outsider should not be
        able to distinguish a private thread from a nonexistent one.
      */
      throw new NotFoundError('Conversation', conversationId);
    }
  }

  async startConversation(
    caller: AccountId,
    input: StartConversationDTO,
  ): Promise<ConversationDTO> {
    if (input.withAccountId === (caller as unknown as string)) {
      throw new ValidationError('Cannot start a conversation with yourself');
    }
    if ((input.contextType === undefined) !== (input.contextId === undefined)) {
      throw new ValidationError('contextType and contextId must be provided together');
    }

    // Idempotent: tapping "contact seller" twice must not fork the thread.
    const existing = await this.repo.findDirect(
      caller,
      input.withAccountId,
      input.contextType ?? null,
      input.contextId ?? null,
    );
    const id = existing ?? (await this.repo.createConversation(caller, input));

    const conv = await this.repo.getConversation(caller, id as Uuid);
    if (!conv) throw new NotFoundError('Conversation', id);
    return conv;
  }

  async listConversations(caller: AccountId, limit = DEFAULT_PAGE): Promise<ConversationDTO[]> {
    return this.repo.listConversations(caller, Math.min(limit, MAX_PAGE));
  }

  async getConversation(caller: AccountId, conversationId: Uuid): Promise<ConversationDTO | null> {
    await this.assertParticipant(conversationId, caller);
    return this.repo.getConversation(caller, conversationId);
  }

  async listMessages(
    caller: AccountId,
    conversationId: Uuid,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<MessagePage> {
    await this.assertParticipant(conversationId, caller);
    const limit = Math.min(opts.limit ?? DEFAULT_PAGE, MAX_PAGE);
    const { rows, hasMore } = await this.repo.listMessages(conversationId, limit, opts.cursor);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: hasMore && last ? this.repo.cursorFor(last) : null,
    };
  }

  async sendMessage(
    caller: AccountId,
    conversationId: Uuid,
    input: SendMessageDTO,
  ): Promise<MessageDTO> {
    await this.assertParticipant(conversationId, caller);
    const kind = resolveKind(input);
    validateMessage(kind, input);
    return this.repo.insertMessage(conversationId, caller, { ...input, kind });
  }

  async markRead(caller: AccountId, conversationId: Uuid): Promise<void> {
    await this.assertParticipant(conversationId, caller);
    await this.repo.markRead(conversationId, caller);
  }
}

/**
 * Infers the kind when the client does not state one, so a plain
 * `{ body }` keeps working and an attachment does not have to be
 * labelled twice.
 */
export function resolveKind(input: SendMessageDTO): MessageKind {
  if (input.kind) return input.kind;
  if (input.attachmentPath) return input.durationMs === undefined ? 'photo' : 'voice';
  return 'text';
}

/**
 * Mirrors the `messages_payload_present` CHECK in the migration.
 *
 * Duplicated on purpose: the database constraint is the guarantee, but it
 * surfaces as a 500 with a Postgres error string. Checking here turns the
 * same rule into a 400 that names the missing field.
 */
export function validateMessage(kind: MessageKind, input: SendMessageDTO): void {
  if (kind === 'text') {
    if (!input.body || input.body.trim().length === 0) {
      throw new ValidationError('A text message needs a body');
    }
    if (input.body.length > MAX_BODY) {
      throw new ValidationError(`A message body may not exceed ${MAX_BODY} characters`);
    }
    return;
  }

  if (!input.attachmentBucket || !input.attachmentPath) {
    throw new ValidationError(`A ${kind} message needs attachmentBucket and attachmentPath`);
  }
  if (!ATTACHMENT_BUCKETS.includes(input.attachmentBucket)) {
    throw new ForbiddenError('That bucket may not be attached to a message', {
      bucket: input.attachmentBucket,
      // A plain array, NOT a spread Set. SWC's loose downlevel turns
      // `[...someSet]` into the Set object itself in the bundled app —
      // this shipped as `"allowed":[{}]` before it was caught, and the
      // same rewrite silently broke the whole event bus once already.
      allowed: ATTACHMENT_BUCKETS,
    });
  }
  if (kind === 'voice' && (input.durationMs === undefined || input.durationMs <= 0)) {
    throw new ValidationError('A voice note needs a positive durationMs');
  }
}
