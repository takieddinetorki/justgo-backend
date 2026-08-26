import { Inject, Injectable } from '@nestjs/common';
import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';
import type { NotificationsPort } from '../contract/notifications.port';
import type { NotificationDTO, NotifyInput, Recipient } from '../contract/dto';
import { PgNotificationsRepository } from '../infra/pg-notifications.repository';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from './channels';

export const NOTIFICATIONS_REPOSITORY = Symbol('NOTIFICATIONS_REPOSITORY');

@Injectable()
export class NotificationsService implements NotificationsPort {
  constructor(
    @Inject(NOTIFICATIONS_REPOSITORY) private readonly repo: PgNotificationsRepository,
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: NotificationChannel[],
  ) {}

  listForAccount(accountId: AccountId, limit = 50): Promise<NotificationDTO[]> {
    return this.repo.listForAccount(accountId, Math.min(limit, 200));
  }

  listForSupplier(supplierId: SupplierId, limit = 50): Promise<NotificationDTO[]> {
    return this.repo.listForSupplier(supplierId, Math.min(limit, 200));
  }

  unreadForAccount(accountId: AccountId): Promise<number> {
    return this.repo.unreadForAccount(accountId);
  }

  unreadForSupplier(supplierId: SupplierId): Promise<number> {
    return this.repo.unreadForSupplier(supplierId);
  }

  async markRead(recipient: Recipient, notificationId: Uuid): Promise<void> {
    await this.repo.markRead(recipient, notificationId);
  }

  async registerDevice(
    accountId: AccountId,
    supplierId: SupplierId | null,
    input: { fcmToken: string; platform?: string },
  ): Promise<void> {
    await this.repo.registerDevice(accountId, supplierId, input);
  }

  /**
   * Persist the in-app row first (system of record), then fan out across the
   * pluggable channels. A channel failure never rolls back the persisted
   * notification — realtime/push are best-effort (§13).
   */
  async notify(input: NotifyInput): Promise<NotificationDTO> {
    const notification = await this.repo.insert(input.recipient, {
      type: input.type,
      title: input.title,
      body: input.body,
      refId: input.refId,
    });
    const devices = await this.repo.devicesFor(input.recipient);
    const ctx = {
      notification,
      recipient: input.recipient,
      devices,
      event: input.event ?? input.type,
      data: input.data ?? {},
      extraChannels: input.extraChannels ?? [],
    };
    await Promise.allSettled(this.channels.map((c) => c.deliver(ctx)));
    return notification;
  }
}
