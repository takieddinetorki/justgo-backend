import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { MESSAGING_PORT } from './contract/messaging.port';
import { MessagingService, MESSAGING_REPOSITORY } from './application/messaging.service';
import { PgMessagingRepository } from './infra/pg-messaging.repository';
import { MessagingController } from './messaging.controller';

/** Owns the `messaging` schema. Extract-ready: it keeps its own Pool (§4.8). */
@Module({
  controllers: [MessagingController],
  providers: [
    {
      provide: MESSAGING_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the messaging module');
        return new PgMessagingRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: MESSAGING_PORT, useClass: MessagingService },
    MessagingService,
  ],
  exports: [MESSAGING_PORT],
})
export class MessagingModule {}
