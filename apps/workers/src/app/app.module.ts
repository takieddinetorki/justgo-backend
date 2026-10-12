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
 * With DATABASE_URL: one PgOutboxStore per module schema. Without: an
 * in-memory demo store, so `nx serve workers` works with no infra.
 *
 * When OUTBOX_SCHEMAS is `auto` the schemas are DISCOVERED from the
 * database rather than listed by hand — see the note in config.ts for
 * why a hand-maintained list is a trap.
 */
async function buildStores(): Promise<OutboxStore[]> {
  if (!config.DATABASE_URL) {
    return [new InMemoryOutboxStore('demo')];
  }
  const pool = new Pool({ connectionString: config.DATABASE_URL });

  let schemas = config.outboxSchemas;
  if (schemas.length === 1 && schemas[0] === 'auto') {
    const found = await pool.query<{ table_schema: string }>(
      `select table_schema from information_schema.tables
        where table_name = 'outbox' and table_schema not in ('demo')
        order by table_schema`,
    );
    schemas = found.rows.map((r) => r.table_schema);
  }
  return schemas.map((schema) => new PgOutboxStore(pool, schema));
}

@Module({
  imports: [EventsModule.forRoot({ redisUrl: config.REDIS_URL })],
  providers: [{ provide: OUTBOX_STORE, useFactory: buildStores }, OutboxRelayRunner],
})
export class AppModule {}
