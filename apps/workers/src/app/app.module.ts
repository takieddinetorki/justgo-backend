import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import {
  EventsModule,
  InMemoryOutboxStore,
  OUTBOX_STORE,
  PgOutboxStore,
  type OutboxStore,
} from '@justgo/events';
import { loadConfig } from '../config';
import { OutboxRelayRunner } from './outbox-relay.runner';

const config = loadConfig();

/**
 * With DATABASE_URL: one PgOutboxStore per module schema (OUTBOX_SCHEMAS).
 * Without: an in-memory demo store, so `nx serve workers` works with no infra.
 */
function buildStores(): OutboxStore[] {
  if (!config.DATABASE_URL) {
    return [new InMemoryOutboxStore('demo')];
  }
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  return config.outboxSchemas.map((schema) => new PgOutboxStore(pool, schema));
}

@Module({
  imports: [EventsModule.forRoot({ redisUrl: config.REDIS_URL })],
  providers: [{ provide: OUTBOX_STORE, useFactory: buildStores }, OutboxRelayRunner],
})
export class AppModule {}
