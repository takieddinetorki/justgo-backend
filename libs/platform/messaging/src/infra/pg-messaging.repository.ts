import { Pool, type PoolClient } from 'pg';
import { asId, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { CONVERSATION_STARTED, MESSAGE_SENT } from '../contract/events';
import type {
  ConversationDTO,
  MessageDTO,
  MessageKind,
  ParticipantDTO,
  SendMessageDTO,
  StartConversationDTO,
} from '../contract/dto';

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_account_id: string;
  kind: MessageKind;
  body: string | null;
  attachment_bucket: string | null;
  attachment_path: string | null;
  duration_ms: number | null;
  created_at: Date;
}

interface ConversationRow {
  id: string;
  context_type: ConversationDTO['contextType'];
  context_id: string | null;
  subject: string | null;
  last_message_at: Date | null;
  created_at: Date;
  unread_count: string;
}

function toMessage(r: MessageRow): MessageDTO {
  return {
    id: asId<Uuid>(r.id),
    conversationId: asId<Uuid>(r.conversation_id),
    senderAccountId: asId<AccountId>(r.sender_account_id),
    kind: r.kind,
    body: r.body,
    attachmentBucket: r.attachment_bucket,
    attachmentPath: r.attachment_path,
    durationMs: r.duration_ms,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Messages page BACKWARDS — newest first — so the cursor is the oldest
 * row already seen. Keyset on (created_at, id): two messages can share a
 * millisecond, and an ambiguous cursor silently drops one.
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

/** All SQL confined to the `messaging` schema (§17.4). */
export class PgMessagingRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'messaging');
  }

  /** The participation check every other method depends on. */
  async isParticipant(conversationId: Uuid, accountId: AccountId): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from messaging.participants
        where conversation_id = $1 and account_id = $2`,
      [conversationId, accountId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private async participantsOf(
    conversationId: string,
    client: Pool | PoolClient = this.pool,
  ): Promise<ParticipantDTO[]> {
    const res = await client.query<{
      account_id: string;
      supplier_id: string | null;
      last_read_at: Date | null;
    }>(
      `select account_id, supplier_id, last_read_at
         from messaging.participants where conversation_id = $1
        order by joined_at`,
      [conversationId],
    );
    return res.rows.map((p) => ({
      accountId: asId<AccountId>(p.account_id),
      supplierId: p.supplier_id ? asId<SupplierId>(p.supplier_id) : null,
      lastReadAt: p.last_read_at ? p.last_read_at.toISOString() : null,
    }));
  }

  private async hydrate(rows: ConversationRow[], _caller: AccountId): Promise<ConversationDTO[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const [parts, lasts] = await Promise.all([
      this.pool.query<{
        conversation_id: string;
        account_id: string;
        supplier_id: string | null;
        last_read_at: Date | null;
      }>(
        `select conversation_id, account_id, supplier_id, last_read_at
           from messaging.participants
          where conversation_id = any($1::uuid[])
          order by joined_at`,
        [ids],
      ),
      // One latest message per conversation, in a single round trip.
      this.pool.query<MessageRow>(
        `select distinct on (conversation_id)
                id, conversation_id, sender_account_id, kind, body,
                attachment_bucket, attachment_path, duration_ms, created_at
           from messaging.messages
          where conversation_id = any($1::uuid[])
          order by conversation_id, created_at desc, id desc`,
        [ids],
      ),
    ]);

    const byConv = new Map<string, ParticipantDTO[]>();
    for (const p of parts.rows) {
      const list = byConv.get(p.conversation_id) ?? [];
      list.push({
        accountId: asId<AccountId>(p.account_id),
        supplierId: p.supplier_id ? asId<SupplierId>(p.supplier_id) : null,
        lastReadAt: p.last_read_at ? p.last_read_at.toISOString() : null,
      });
      byConv.set(p.conversation_id, list);
    }
    const lastByConv = new Map(lasts.rows.map((m) => [m.conversation_id, toMessage(m)]));

    return rows.map((r) => ({
      id: asId<Uuid>(r.id),
      contextType: r.context_type,
      contextId: r.context_id ? asId<Uuid>(r.context_id) : null,
      subject: r.subject,
      participants: byConv.get(r.id) ?? [],
      lastMessage: lastByConv.get(r.id) ?? null,
      unreadCount: Number(r.unread_count),
      lastMessageAt: r.last_message_at ? r.last_message_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /*
    `unread_count` is computed against the CALLER's own last_read_at, so
    the same conversation reports different counts to each participant —
    which is the only correct answer. Messages the caller sent never
    count as unread to themselves.
  */
  private readonly SELECT_CONVERSATIONS = `
    select c.id, c.context_type, c.context_id, c.subject, c.last_message_at, c.created_at,
           (select count(*) from messaging.messages m
             where m.conversation_id = c.id
               and m.sender_account_id <> $1
               and (mine.last_read_at is null or m.created_at > mine.last_read_at)
           ) as unread_count
      from messaging.conversations c
      join messaging.participants mine
        on mine.conversation_id = c.id and mine.account_id = $1
  `;

  async listConversations(caller: AccountId, limit: number): Promise<ConversationDTO[]> {
    const res = await this.pool.query<ConversationRow>(
      `${this.SELECT_CONVERSATIONS}
        order by coalesce(c.last_message_at, c.created_at) desc
        limit $2`,
      [caller, limit],
    );
    return this.hydrate(res.rows, caller);
  }

  async getConversation(caller: AccountId, id: Uuid): Promise<ConversationDTO | null> {
    const res = await this.pool.query<ConversationRow>(
      `${this.SELECT_CONVERSATIONS} where c.id = $2`,
      [caller, id],
    );
    const hydrated = await this.hydrate(res.rows, caller);
    return hydrated[0] ?? null;
  }

  /**
   * Existing thread for the same pair AND context, if any.
   *
   * Scoped to exactly two participants so a future group thread can never
   * be mistaken for a direct one and silently reused.
   */
  async findDirect(
    caller: AccountId,
    other: string,
    contextType: string | null,
    contextId: string | null,
  ): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select c.id
         from messaging.conversations c
        where c.context_type is not distinct from $3::text
          and c.context_id is not distinct from $4::uuid
          and exists (select 1 from messaging.participants p
                       where p.conversation_id = c.id and p.account_id = $1)
          and exists (select 1 from messaging.participants p
                       where p.conversation_id = c.id and p.account_id = $2)
          and (select count(*) from messaging.participants p
                where p.conversation_id = c.id) = 2
        limit 1`,
      [caller, other, contextType, contextId],
    );
    return res.rows[0]?.id ?? null;
  }

  async createConversation(
    caller: AccountId,
    input: StartConversationDTO,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const conv = await client.query<{ id: string }>(
        `insert into messaging.conversations
           (context_type, context_id, subject, created_by)
         values ($1, $2, $3, $4) returning id`,
        [input.contextType ?? null, input.contextId ?? null, input.subject ?? null, caller],
      );
      const id = conv.rows[0]?.id;
      if (!id) throw new Error('conversation insert returned no id');

      await client.query(
        `insert into messaging.participants (conversation_id, account_id, supplier_id)
         values ($1, $2, $3), ($1, $4, null)
         on conflict do nothing`,
        [id, caller, input.asSupplierId ?? null, input.withAccountId],
      );

      await this.outbox.appendWith(client, [
        makeEvent({
          type: CONVERSATION_STARTED,
          aggregateId: asId<Uuid>(id),
          payload: {
            conversationId: id,
            createdBy: caller,
            participantAccountIds: [caller, input.withAccountId],
            contextType: input.contextType ?? null,
            contextId: input.contextId ?? null,
          },
        }),
      ]);
      await client.query('commit');
      return id;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async listMessages(
    conversationId: Uuid,
    limit: number,
    cursor?: string,
  ): Promise<{ rows: MessageDTO[]; hasMore: boolean }> {
    const after = cursor ? decodeCursor(cursor) : null;
    const res = await this.pool.query<MessageRow>(
      `select id, conversation_id, sender_account_id, kind, body,
              attachment_bucket, attachment_path, duration_ms, created_at
         from messaging.messages
        where conversation_id = $1
          and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::uuid))
        order by created_at desc, id desc
        limit $4`,
      [conversationId, after ? after.at : null, after ? after.id : null, limit + 1],
    );
    const hasMore = res.rows.length > limit;
    return { rows: res.rows.slice(0, limit).map(toMessage), hasMore };
  }

  cursorFor(m: MessageDTO): string {
    return encodeCursor(new Date(m.createdAt), m.id);
  }

  /**
   * Insert the message, bump the conversation, and queue the event in ONE
   * transaction (§17.2). A message that is visible but never announced
   * leaves the other participant staring at a stale screen.
   */
  async insertMessage(
    conversationId: Uuid,
    sender: AccountId,
    input: SendMessageDTO & { kind: MessageKind },
  ): Promise<MessageDTO> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query<MessageRow>(
        `insert into messaging.messages
           (conversation_id, sender_account_id, kind, body,
            attachment_bucket, attachment_path, duration_ms)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, conversation_id, sender_account_id, kind, body,
                   attachment_bucket, attachment_path, duration_ms, created_at`,
        [
          conversationId,
          sender,
          input.kind,
          input.body ?? null,
          input.attachmentBucket ?? null,
          input.attachmentPath ?? null,
          input.durationMs ?? null,
        ],
      );
      const row = res.rows[0];
      if (!row) throw new Error('message insert returned no row');

      await client.query(
        `update messaging.conversations set last_message_at = $2 where id = $1`,
        [conversationId, row.created_at],
      );

      const recipients = await client.query<{ account_id: string }>(
        `select account_id from messaging.participants
          where conversation_id = $1 and account_id <> $2`,
        [conversationId, sender],
      );

      await this.outbox.appendWith(client, [
        makeEvent({
          type: MESSAGE_SENT,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            messageId: row.id,
            conversationId,
            senderAccountId: sender,
            kind: row.kind,
            recipientAccountIds: recipients.rows.map((r) => r.account_id),
            // Never the attachment path — a notification preview must not
            // leak a storage location to a push provider.
            preview: row.kind === 'text' ? (row.body ?? '').slice(0, 140) : null,
            occurredAt: row.created_at.toISOString(),
          },
        }),
      ]);
      await client.query('commit');
      return toMessage(row);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async markRead(conversationId: Uuid, accountId: AccountId): Promise<void> {
    await this.pool.query(
      `update messaging.participants set last_read_at = now()
        where conversation_id = $1 and account_id = $2`,
      [conversationId, accountId],
    );
  }

  async conversationParticipants(conversationId: Uuid): Promise<ParticipantDTO[]> {
    return this.participantsOf(conversationId);
  }
}
