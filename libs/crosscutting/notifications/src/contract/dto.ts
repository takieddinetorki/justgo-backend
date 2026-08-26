import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

export interface NotificationDTO {
  id: Uuid;
  type: string;
  title: string | null;
  body: string | null;
  refId: Uuid | null;
  read: boolean;
  createdAt: string; // UTC ISO-8601
}

export interface RegisterDeviceDTO {
  fcmToken: string;
  platform?: 'android' | 'ios' | 'web';
}

/** A notification targets an account (a user) XOR a supplier (its badge). */
export type Recipient = { account: AccountId } | { supplier: SupplierId };

export interface NotifyInput {
  recipient: Recipient;
  type: string;
  title?: string;
  body?: string;
  refId?: string;
  /** Realtime event name; defaults to `type`. */
  event?: string;
  /** Extra realtime payload merged over the notification summary. */
  data?: Record<string, unknown>;
  /** Additional realtime channels to publish to (e.g. request:{id}). */
  extraChannels?: string[];
}
