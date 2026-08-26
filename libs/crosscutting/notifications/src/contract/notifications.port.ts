import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';
import type { NotificationDTO, NotifyInput, Recipient } from './dto';

/**
 * Notifications context (§6.3, §13): the durable in-app feed, badge counters,
 * device registry, and channel dispatch. Reactors call notify(); the apps
 * read the feed and register devices.
 */
export interface NotificationsPort {
  listForAccount(accountId: AccountId, limit?: number): Promise<NotificationDTO[]>;
  listForSupplier(supplierId: SupplierId, limit?: number): Promise<NotificationDTO[]>;
  unreadForAccount(accountId: AccountId): Promise<number>;
  unreadForSupplier(supplierId: SupplierId): Promise<number>;
  markRead(recipient: Recipient, notificationId: Uuid): Promise<void>;
  registerDevice(
    accountId: AccountId,
    supplierId: SupplierId | null,
    input: { fcmToken: string; platform?: string },
  ): Promise<void>;
  /** Persist + dispatch across channels. Used by the reactors. */
  notify(input: NotifyInput): Promise<NotificationDTO>;
}

export const NOTIFICATIONS_PORT = Symbol('NOTIFICATIONS_PORT');
