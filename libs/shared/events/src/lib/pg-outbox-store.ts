import type { Pool, PoolClient } from 'pg';
import { asId, type EventId, type Uuid } from '@justgo/kernel';
import type { DomainEvent } from './domain-event';
import type { OutboxStore } from './outbox';

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

interface OutboxRow {
  id: string;
  aggregate_id: string | null;
  type: string;
  payload: { version: number; data: unknown };
  occurred_at: Date;
}

/**
 * Postgres outbox bound to one module schema (§12). The schema name is a
 * code-level constant, never user input; the regex guard makes that safe to
 * interpolate.
 *
 * `appendWith(client, …)` is the transactional path: pass the same client
 * that performs the state change so both commit or roll back together.
 */
export class PgOutboxStore implements OutboxStore {
  constructor(
    private readonly pool: Pool,
    readonly schema: string,
  ) {
    if (!SCHEMA_RE.test(schema)) throw new TypeError(`Invalid schema name: ${schema}`);
  }

  private get table(): string {
    return `${this.schema}.outbox`;
  }

  async append(events: DomainEvent[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.appendWith(client, events);
    } finally {
      client.release();
    }
  }

  async appendWith(client: PoolClient, events: DomainEvent[]): Promise<void> {
    for (const e of events) {
      await client.query(
        `insert into ${this.table} (id, aggregate_id, type, payload, occurred_at)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do nothing`,
        [e.id, e.aggregateId, e.type, { version: e.version, data: e.payload }, e.occurredAt],
      );
    }
  }

  async fetchUnpublished(limit: number): Promise<DomainEvent[]> {
    const res = await this.pool.query<OutboxRow>(
      `select id, aggregate_id, type, payload, occurred_at
         from ${this.table}
        where published_at is null
        order by occurred_at asc
        limit $1`,
      [limit],
    );
    return res.rows.map((row) => ({
      id: asId<EventId>(row.id),
      type: row.type,
      version: row.payload.version ?? 1,
      aggregateId: row.aggregate_id ? asId<Uuid>(row.aggregate_id) : null,
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload.data,
    }));
  }

  async markPublished(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.pool.query(
      `update ${this.table} set published_at = now() where id = any($1::uuid[])`,
      [eventIds],
    );
  }
}
