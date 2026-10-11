/** Events emitted by messaging (§12). Versioned and additive. */

export const MESSAGE_SENT = 'messaging.MessageSent';
export interface MessageSentV1 {
  messageId: string;
  conversationId: string;
  senderAccountId: string;
  kind: 'text' | 'photo' | 'voice';
  /** Everyone who should be notified — the sender is NOT included. */
  recipientAccountIds: string[];
  /** Short preview for a push/notification body; never the attachment. */
  preview: string | null;
  occurredAt: string;
}

export const CONVERSATION_STARTED = 'messaging.ConversationStarted';
export interface ConversationStartedV1 {
  conversationId: string;
  createdBy: string;
  participantAccountIds: string[];
  contextType: 'listing' | 'request' | 'order' | null;
  contextId: string | null;
}
