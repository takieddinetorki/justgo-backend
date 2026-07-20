/**
 * Integration: real Postgres outbox + real BullMQ bus.
 * Skipped unless DATABASE_URL (and for the BullMQ leg, REDIS_URL) are set —
 * CI provides both via service containers; locally run docker-compose first.
 */
import { Pool } from 'pg';
import { makeEvent, type DomainEvent } from './domain-event';
import { PgOutboxStore } from './pg-outbox-store';
import { BullMqEventBus } from './bullmq-event-bus';
import { InMemoryEventBus } from './in-memory';
import { OutboxRelay } from './outbox-relay';

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];

const describePg = DATABASE_URL ? describe : describe.skip;
const itRedis = REDIS_URL ? it : it.skip;

describePg('PgOutboxStore + relay (integration)', () => {
  let pool: Pool;
  let store: PgOutboxStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`create schema if not exists demo`);
    await pool.query(`
      create table if not exists demo.outbox (
        id uuid primary key,
        aggregate_id uuid,
        type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null default now(),
        published_at timestamptz
      )`);
    store = new PgOutboxStore(pool, 'demo');
  });

  beforeEach(async () => {
    await pool.query(`truncate demo.outbox`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('appends, fetches oldest-first, and marks published', async () => {
    const first = makeEvent({
      type: 'demo.First',
      payload: { n: 1 },
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    });
    const second = makeEvent({
      type: 'demo.Second',
      payload: { n: 2 },
      occurredAt: new Date('2026-01-02T00:00:00Z'),
    });
    await store.append([second, first]);

    const unpublished = await store.fetchUnpublished(10);
    expect(unpublished.map((e) => e.type)).toEqual(['demo.First', 'demo.Second']);
    expect(unpublished[0].payload).toEqual({ n: 1 });

    await store.markPublished([first.id]);
    expect((await store.fetchUnpublished(10)).map((e) => e.type)).toEqual(['demo.Second']);
  });

  it('append is idempotent on event id', async () => {
    const event = makeEvent({ type: 'demo.Dup', payload: {} });
    await store.append([event]);
    await store.append([event]);
    expect(await store.fetchUnpublished(10)).toHaveLength(1);
  });

  it('relays from Postgres to an in-memory bus', async () => {
    const bus = new InMemoryEventBus();
    const relay = new OutboxRelay([store], bus);
    const received: DomainEvent[] = [];
    await bus.subscribe('*', async (e) => {
      received.push(e);
    });

    await store.append([makeEvent({ type: 'demo.PgFlow', payload: { ok: true } })]);
    expect(await relay.tick()).toBe(1);
    expect(received).toHaveLength(1);
    expect(await store.fetchUnpublished(10)).toHaveLength(0);
  });

  itRedis(
    'relays from Postgres through BullMQ to a consumer (full pipeline)',
    async () => {
      const bus = new BullMqEventBus({
        redisUrl: REDIS_URL as string,
        queueName: `test-events-${Date.now()}`,
      });
      try {
        const received: DomainEvent[] = [];
        await bus.subscribe('demo.FullPipeline', async (e) => {
          received.push(e);
        });

        const event = makeEvent({ type: 'demo.FullPipeline', payload: { leg: 'redis' } });
        await store.append([event]);
        const relay = new OutboxRelay([store], bus);
        await relay.tick();

        await waitFor(() => received.length === 1, 10_000);
        expect(received[0].id).toBe(event.id);
        expect(await store.fetchUnpublished(10)).toHaveLength(0);
      } finally {
        await bus.close();
      }
    },
    20_000,
  );
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
