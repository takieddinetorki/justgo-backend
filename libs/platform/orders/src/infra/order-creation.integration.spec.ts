/**
 * Closes the Phase 1 loop (§19 DoD): requests emits requests.QuoteAccepted
 * (proven in the requests package) and this reactor turns it into an order.
 * Skipped without DATABASE_URL.
 */
import { Pool } from 'pg';
import { makeEvent, InMemoryEventBus } from '@justgo/events';
import { newId, type AccountId, type QuoteId, type RequestId, type SupplierId } from '@justgo/kernel';
import { PgOrdersRepository } from './pg-orders.repository';
import { OrdersService } from '../application/orders.service';
import { OrderFromQuoteReactor } from '../application/order-from-quote.reactor';
import { ORDER_CREATED } from '../contract/events';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

describePg('QuoteAccepted → order', () => {
  let pool: Pool;
  let orders: OrdersService;
  let reactor: OrderFromQuoteReactor;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    orders = new OrdersService(new PgOrdersRepository(pool));
    reactor = new OrderFromQuoteReactor(new InMemoryEventBus(), orders);
  });

  afterAll(async () => {
    await pool.end();
  });

  const acceptedEvent = (over: Partial<Record<string, unknown>> = {}) =>
    makeEvent({
      type: 'requests.QuoteAccepted',
      payload: {
        quoteId: newId<QuoteId>(),
        requestId: newId<RequestId>(),
        supplierId: newId<SupplierId>(),
        clientAccountId: newId<AccountId>(),
        amountMinor: 9500,
        currency: 'EUR',
        ...over,
      },
    });

  it('creates an order carrying the accepted quote’s money', async () => {
    const event = acceptedEvent();
    await reactor.handle(event);

    const p = event.payload as Record<string, string>;
    const res = await pool.query(
      `select client_account_id, supplier_id, amount_minor, currency, status, fulfilment
         from orders.orders where quote_id = $1`,
      [p['quoteId']],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      client_account_id: p['clientAccountId'],
      supplier_id: p['supplierId'],
      amount_minor: '9500',
      currency: 'EUR',
      status: 'created',
      fulfilment: 'pickup',
    });
  });

  it('is idempotent — redelivery yields one order, one OrderCreated event', async () => {
    const event = acceptedEvent();
    await reactor.handle(event);
    await reactor.handle(event); // at-least-once redelivery

    const p = event.payload as Record<string, string>;
    const rows = await pool.query(`select id from orders.orders where quote_id = $1`, [
      p['quoteId'],
    ]);
    expect(rows.rows).toHaveLength(1);

    const events = await pool.query(
      `select type from orders.outbox where aggregate_id = $1`,
      [rows.rows[0].id],
    );
    expect(events.rows.map((r) => r.type)).toEqual([ORDER_CREATED]);
  });

  it('walks the fulfilment lifecycle and blocks illegal jumps', async () => {
    const event = acceptedEvent();
    await reactor.handle(event);
    const p = event.payload as Record<string, string>;
    const row = await pool.query<{ id: string }>(
      `select id from orders.orders where quote_id = $1`,
      [p['quoteId']],
    );
    const orderId = row.rows[0].id as never;

    expect((await orders.changeStatus(orderId, 'confirmed')).status).toBe('confirmed');
    expect((await orders.changeStatus(orderId, 'in_progress')).status).toBe('in_progress');
    await expect(orders.changeStatus(orderId, 'confirmed')).rejects.toMatchObject({
      code: 'ILLEGAL_ORDER_TRANSITION',
      httpStatus: 409,
    });
    expect((await orders.changeStatus(orderId, 'completed')).status).toBe('completed');
  });

  it('requires a workshop for install fulfilment (§8.2)', async () => {
    const event = acceptedEvent();
    await reactor.handle(event);
    const p = event.payload as Record<string, string>;
    const row = await pool.query<{ id: string }>(
      `select id from orders.orders where quote_id = $1`,
      [p['quoteId']],
    );
    await expect(
      orders.chooseFulfilment(p['clientAccountId'] as never, row.rows[0].id as never, {
        fulfilment: 'install',
      }),
    ).rejects.toMatchObject({ code: 'WORKSHOP_REQUIRED' });
  });
});
