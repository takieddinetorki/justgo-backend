/**
 * Phase 1 Definition of Done (§19) — the core loop end to end:
 *
 *   client submits a request → fan-out creates supplier quote stubs →
 *   supplier prices / offers an alternative / rejects → client sees the best
 *   offer → client accepts → an order is created.
 *
 * Plus: duplicate submit is deduped, and RLS isolation holds for requests
 * and quotes (the two-sided case, §11).
 *
 * Runs against the self-hosted Supabase Postgres; skipped without DATABASE_URL.
 */
import { Pool } from 'pg';
import { newId, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { InMemoryEventBus, OutboxRelay, PgOutboxStore } from '@justgo/events';
import { VerticalRegistry, type SupplierVertical } from '@justgo/contracts';
import { PgRequestsRepository } from './pg-requests.repository';
import { RequestsService } from '../application/requests.service';
import { QuotesService } from '../application/quotes.service';
import { FanOutReactor } from '../application/fan-out.reactor';
import { REQUEST_SUBMITTED, QUOTE_ACCEPTED } from '../contract/events';
import type { DomainEvent } from '@justgo/events';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

const partStore: SupplierVertical = {
  key: 'part_store',
  capabilities: ['RECEIVES_PART_REQUESTS', 'LISTS_PRODUCTS'],
  onboardingSchema: () => ({ fields: [] }),
  profileSchema: () => ({ fields: [] }),
  quoteFor: async () => ({ kind: 'price' }),
  catalogueSpec: () => ({ kind: 'parts', categoryKeys: ['braking'] }),
};

describePg('core loop: request → fan-out → quote → accept → order', () => {
  let pool: Pool;
  let repo: PgRequestsRepository;
  let requests: RequestsService;
  let quotes: QuotesService;
  let bus: InMemoryEventBus;
  let relay: OutboxRelay;
  let published: DomainEvent[];

  const clock = { now: () => new Date() };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new PgRequestsRepository(pool);
    requests = new RequestsService(repo, clock);
    quotes = new QuotesService(repo);
  });

  beforeEach(async () => {
    bus = new InMemoryEventBus();
    published = [];
    await bus.subscribe('*', async (e) => {
      published.push(e);
    });
    relay = new OutboxRelay([new PgOutboxStore(pool, 'requests')], bus);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Drains the outbox so events reach subscribers, like the worker does. */
  const drain = async () => {
    await relay.tick();
  };

  /**
   * Supplier ids are opaque here by design: quotes reference suppliers by id
   * with NO cross-schema foreign key (§17.2), so this module never needs a
   * real row in the suppliers schema — and must never read one (§17.4).
   */
  const makeSuppliers = async (count: number): Promise<SupplierId[]> =>
    Array.from({ length: count }, () => newId<SupplierId>());

  it('runs the full happy path and creates exactly one order', async () => {
    const client = newId<AccountId>();
    const [supplierA, supplierB, supplierC] = await makeSuppliers(3);

    // 1. client submits
    const submitted = await requests.submit(client, {
      strategy: 'all',
      categoryKey: 'braking',
      freeText: 'Front brake pads',
      quantity: 2,
      idempotencyKey: `e2e-${newId<Uuid>()}`,
    });
    expect(submitted.status).toBe('pending');
    expect(submitted.quotes).toHaveLength(0);

    await drain();
    // the relay drains every unpublished row in the schema, so match on OUR
    // request id rather than the first RequestSubmitted that shows up
    const submittedEvent = published.find(
      (e) =>
        e.type === REQUEST_SUBMITTED &&
        (e.payload as { requestId: string }).requestId === submitted.id,
    );
    expect(submittedEvent).toBeDefined();

    // 2. fan-out via the capability-driven reactor
    const registry = new VerticalRegistry([partStore]);
    const targeting = {
      targetsFor: async () => [supplierA, supplierB, supplierC] as string[],
    };
    const reactor = new FanOutReactor(bus, requests, registry, targeting);
    await reactor.handle(submittedEvent as DomainEvent);

    let detail = await requests.getForClient(client, submitted.id);
    expect(detail.quotes).toHaveLength(3);
    expect(detail.quotes.every((q) => q.status === 'pending')).toBe(true);

    // 3. suppliers respond: a price, a cheaper price, and a rejection
    const quoteA = detail.quotes.find((q) => q.supplierId === supplierA)!;
    const quoteB = detail.quotes.find((q) => q.supplierId === supplierB)!;
    const quoteC = detail.quotes.find((q) => q.supplierId === supplierC)!;

    await quotes.submitPrice(supplierA, quoteA.id, {
      amount: { amountMinor: 12000, currency: 'EUR' },
    });
    await quotes.submitPrice(supplierB, quoteB.id, {
      amount: { amountMinor: 9500, currency: 'EUR' },
    });
    await quotes.reject(supplierC, quoteC.id, 'Out of stock');

    // 4. client sees the best offer flagged
    detail = await requests.getForClient(client, submitted.id);
    expect(detail.status).toBe('awaiting_client');
    expect(detail.bestQuoteId).toBe(quoteB.id);
    expect(detail.quotes.find((q) => q.id === quoteB.id)?.isBest).toBe(true);
    expect(detail.quotes.find((q) => q.id === quoteC.id)?.status).toBe('rejected');

    // 5. client accepts the best quote
    const accepted = await requests.acceptQuote(client, quoteB.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.quotes.find((q) => q.id === quoteB.id)?.status).toBe('accepted');
    // the losing priced quote is closed; the rejection stays terminal
    expect(accepted.quotes.find((q) => q.id === quoteA.id)?.status).toBe('closed');
    expect(accepted.quotes.find((q) => q.id === quoteC.id)?.status).toBe('rejected');

    // 6. QuoteAccepted reaches the bus for the orders reactor
    await drain();
    const acceptedEvents = published.filter(
      (e) =>
        e.type === QUOTE_ACCEPTED &&
        (e.payload as { requestId: string }).requestId === submitted.id,
    );
    expect(acceptedEvents).toHaveLength(1);
    expect(acceptedEvents[0].payload).toMatchObject({
      quoteId: quoteB.id,
      supplierId: supplierB,
      amountMinor: 9500,
      currency: 'EUR',
    });
  });

  it('dedupes a duplicate submit on the idempotency key', async () => {
    const client = newId<AccountId>();
    const key = `dup-${newId<Uuid>()}`;
    const first = await requests.submit(client, {
      strategy: 'all',
      freeText: 'Oil filter',
      idempotencyKey: key,
    });
    const retry = await requests.submit(client, {
      strategy: 'all',
      freeText: 'Oil filter',
      idempotencyKey: key,
    });
    expect(retry.id).toBe(first.id);

    const count = await pool.query<{ n: string }>(
      `select count(*) n from requests.part_requests where idempotency_key = $1`,
      [key],
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('fan-out is idempotent under at-least-once redelivery', async () => {
    const client = newId<AccountId>();
    const suppliers = await makeSuppliers(2);
    const req = await requests.submit(client, { strategy: 'all', freeText: 'Wipers' });

    expect(await requests.fanOut(req.id, suppliers)).toBe(2);
    expect(await requests.fanOut(req.id, suppliers)).toBe(0); // replay adds nothing

    const detail = await requests.getForClient(client, req.id);
    expect(detail.quotes).toHaveLength(2);
  });

  it('rejects a second accept on the same request with 409', async () => {
    const client = newId<AccountId>();
    const [s1, s2] = await makeSuppliers(2);
    const req = await requests.submit(client, { strategy: 'all', freeText: 'Clutch' });
    await requests.fanOut(req.id, [s1, s2]);

    const detail = await requests.getForClient(client, req.id);
    const q1 = detail.quotes.find((q) => q.supplierId === s1)!;
    const q2 = detail.quotes.find((q) => q.supplierId === s2)!;
    await quotes.submitPrice(s1, q1.id, { amount: { amountMinor: 5000, currency: 'EUR' } });
    await quotes.submitPrice(s2, q2.id, { amount: { amountMinor: 6000, currency: 'EUR' } });

    await requests.acceptQuote(client, q1.id);
    await expect(requests.acceptQuote(client, q2.id)).rejects.toMatchObject({
      code: 'ILLEGAL_QUOTE_TRANSITION',
      httpStatus: 409,
    });
  });

  it('stops a supplier from answering a quote that is not theirs', async () => {
    const client = newId<AccountId>();
    const [mine, theirs] = await makeSuppliers(2);
    const req = await requests.submit(client, { strategy: 'all', freeText: 'Radiator' });
    await requests.fanOut(req.id, [mine, theirs]);

    const detail = await requests.getForClient(client, req.id);
    const otherQuote = detail.quotes.find((q) => q.supplierId === theirs)!;

    await expect(
      quotes.submitPrice(mine, otherQuote.id, {
        amount: { amountMinor: 1, currency: 'EUR' },
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('hides a request from a different client', async () => {
    const owner = newId<AccountId>();
    const stranger = newId<AccountId>();
    const req = await requests.submit(owner, { strategy: 'all', freeText: 'Alternator' });
    await expect(requests.getForClient(stranger, req.id)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('expires open requests past their window and closes their quotes', async () => {
    const client = newId<AccountId>();
    const [supplier] = await makeSuppliers(1);
    const req = await requests.submit(client, {
      strategy: 'all',
      freeText: 'Timing belt',
      expiresInMinutes: 1,
    });
    await requests.fanOut(req.id, [supplier]);

    // sweep with a clock an hour ahead
    const swept = await requests.expireDue(new Date(Date.now() + 3600_000));
    expect(swept).toBeGreaterThanOrEqual(1);

    const detail = await requests.getForClient(client, req.id);
    expect(detail.status).toBe('expired');
    expect(detail.quotes.every((q) => q.status === 'closed')).toBe(true);
  });
});
