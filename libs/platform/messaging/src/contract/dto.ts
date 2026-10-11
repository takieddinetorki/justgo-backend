import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

/** What a conversation is about. Loose reference — never a foreign key. */
export type ConversationContextType = 'listing' | 'request' | 'order';

export type MessageKind = 'text' | 'photo' | 'voice';

export interface ParticipantDTO {
  accountId: AccountId;
  /** Set when this participant speaks as a business rather than as themselves. */
  supplierId: SupplierId | null;
  lastReadAt: string | null;
}

export interface MessageDTO {
  id: Uuid;
  conversationId: Uuid;
  senderAccountId: AccountId;
  kind: MessageKind;
  body: string | null;
  /**
   * Attachments are returned as a bucket/path pair, NOT a URL.
   *
   * The buckets are private, so any URL we minted here would be a
   * short-lived signed one — baked into a message history the client
   * caches and re-renders hours later, long after it expired. The client
   * asks for a fresh signed URL when it actually needs the bytes.
   */
  attachmentBucket: string | null;
  attachmentPath: string | null;
  /** Voice notes only, so the client can size the waveform before fetching. */
  durationMs: number | null;
  createdAt: string;
}

export interface ConversationDTO {
  id: Uuid;
  contextType: ConversationContextType | null;
  contextId: Uuid | null;
  subject: string | null;
  participants: ParticipantDTO[];
  lastMessage: MessageDTO | null;
  /** Messages after this participant's `lastReadAt`. */
  unreadCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface StartConversationDTO {
  /** The other party. A conversation is always with someone. */
  withAccountId: string;
  contextType?: ConversationContextType;
  contextId?: string;
  subject?: string;
  /** Speak as this business (must be a supplier the caller may act for). */
  asSupplierId?: string;
}

export interface SendMessageDTO {
  kind?: MessageKind;
  body?: string;
  attachmentBucket?: string;
  attachmentPath?: string;
  durationMs?: number;
}

export interface MessagePage {
  items: MessageDTO[];
  /** Null on the last page. Messages page backwards through history. */
  nextCursor: string | null;
}
