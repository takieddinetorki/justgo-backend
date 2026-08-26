import { Logger } from '@nestjs/common';

export interface PushMessage {
  title: string;
  body: string;
  /** Deep-link / entity reference the app opens on tap. */
  refId?: string;
  type: string;
}

/**
 * Native push transport (§13). Behind a port so FCM can be swapped for
 * SMS/WhatsApp/APNs later without touching the notifications core.
 */
export interface PushSender {
  push(tokens: string[], message: PushMessage): Promise<void>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * Phase-1 FCM STUB (§19 "FCM stub"). Real credentials aren't wired yet, so
 * this logs what it would send and drops. Swap for a real FCM sender in
 * Phase 4 — the port and every caller stay unchanged.
 */
export class FcmPushSender implements PushSender {
  private readonly logger = new Logger('FcmPushSender');
  async push(tokens: string[], message: PushMessage): Promise<void> {
    if (tokens.length === 0) return;
    this.logger.debug(
      `FCM (stub) would push "${message.type}" to ${tokens.length} device(s): ${message.title}`,
    );
  }
}
