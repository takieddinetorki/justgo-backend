import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { NOTIFICATIONS_PORT } from './contract/notifications.port';
import { NotificationsService, NOTIFICATIONS_REPOSITORY } from './application/notifications.service';
import { PgNotificationsRepository } from './infra/pg-notifications.repository';
import { NotificationReactors } from './application/notification-reactors';
import {
  NOTIFICATION_CHANNELS,
  PushChannel,
  RealtimeChannel,
  type NotificationChannel,
} from './application/channels';
import { FcmPushSender, PUSH_SENDER } from './application/push-sender';
import { NotificationsController } from './notifications.controller';

/**
 * Owns the `notifications` schema. Requires a global RealtimeModule (for
 * RealtimePort) and EventsModule (for EVENT_BUS). Channels are assembled
 * here — add SMS/WhatsApp later by appending to NOTIFICATION_CHANNELS (§13).
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    {
      provide: NOTIFICATIONS_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the notifications module');
        return new PgNotificationsRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: PUSH_SENDER, useClass: FcmPushSender },
    RealtimeChannel,
    PushChannel,
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (realtime: RealtimeChannel, push: PushChannel): NotificationChannel[] => [
        realtime,
        push,
      ],
      inject: [RealtimeChannel, PushChannel],
    },
    { provide: NOTIFICATIONS_PORT, useClass: NotificationsService },
    NotificationsService,
    NotificationReactors,
  ],
  exports: [NOTIFICATIONS_PORT],
})
export class NotificationsModule {}
