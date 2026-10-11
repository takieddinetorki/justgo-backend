import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';
import type {
  ConversationDTO,
  MessageDTO,
  MessagePage,
  SendMessageDTO,
  StartConversationDTO,
} from './dto';

/**
 * Public port of the messaging context (§6.1).
 *
 * Every method takes the CALLER's account id and resolves access from it.
 * There is deliberately no "read any conversation" method: a port that
 * can bypass participation is one mistaken call away from leaking a
 * private thread.
 */
export interface MessagingPort {
  /**
   * Starts a conversation, or returns the existing one for the same pair
   * and context. Idempotent on purpose — tapping "contact seller" twice
   * must not produce two threads about one listing.
   */
  startConversation(callerAccountId: AccountId, input: StartConversationDTO): Promise<ConversationDTO>;
  listConversations(callerAccountId: AccountId, limit?: number): Promise<ConversationDTO[]>;
  getConversation(callerAccountId: AccountId, conversationId: Uuid): Promise<ConversationDTO | null>;
  listMessages(
    callerAccountId: AccountId,
    conversationId: Uuid,
    opts?: { limit?: number; cursor?: string },
  ): Promise<MessagePage>;
  sendMessage(
    callerAccountId: AccountId,
    conversationId: Uuid,
    input: SendMessageDTO,
  ): Promise<MessageDTO>;
  /** Marks everything up to now as read for the caller. */
  markRead(callerAccountId: AccountId, conversationId: Uuid): Promise<void>;
}

export const MESSAGING_PORT = Symbol('MESSAGING_PORT');

export type { AccountId, SupplierId };
