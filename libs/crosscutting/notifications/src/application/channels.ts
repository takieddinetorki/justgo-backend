import { Inject, Injectable } from '@nestjs/common';
import {
  accountChannel,
  REALTIME_PORT,
  supplierChannel,
  type RealtimePort,
} from '@justgo/realtime';
import type { NotificationDTO, Recipient } from '../contract/dto';
import type { DeviceRow } from '../infra/pg-notifications.repository';
import { PUSH_SENDER, type PushSender } from './push-sender';

export interface DeliverContext {
  notification: NotificationDTO;
  recipient: Recipient;
  devices: DeviceRow[];
  event: string;
  data: Record<string, unknown>;
  extraChannels: string[];
}

/** A pluggable delivery transport for an already-persisted notification. */
export interface NotificationChannel {
  deliver(ctx: DeliverContext): Promise<void>;
}

export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

function recipientChannel(recipient: Recipient): string {
  return 'account' in recipient
    ? accountChannel(recipient.account)
    : supplierChannel(recipient.supplier);
}

/** Live delivery: broadcast to the recipient's channel + any extra channels. */
@Injectable()
export class RealtimeChannel implements NotificationChannel {
  constructor(@Inject(REALTIME_PORT) private readonly realtime: RealtimePort) {}

  async deliver(ctx: DeliverContext): Promise<void> {
    const payload = {
      id: ctx.notification.id,
      type: ctx.notification.type,
      title: ctx.notification.title,
      body: ctx.notification.body,
      refId: ctx.notification.refId,
      createdAt: ctx.notification.createdAt,
      ...ctx.data,
    };
    const channels = new Set<string>([recipientChannel(ctx.recipient), ...ctx.extraChannels]);
    await Promise.all([...channels].map((ch) => this.realtime.publish(ch, ctx.event, payload)));
  }
}

/** Native push to the recipient's registered devices (FCM stub for now). */
@Injectable()
export class PushChannel implements NotificationChannel {
  constructor(@Inject(PUSH_SENDER) private readonly sender: PushSender) {}

  async deliver(ctx: DeliverContext): Promise<void> {
    await this.sender.push(
      ctx.devices.map((d) => d.fcm_token),
      {
        type: ctx.notification.type,
        title: ctx.notification.title ?? ctx.notification.type,
        body: ctx.notification.body ?? '',
        refId: ctx.notification.refId ?? undefined,
      },
    );
  }
}
