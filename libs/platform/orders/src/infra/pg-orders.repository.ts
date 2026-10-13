import { Pool, type PoolClient } from 'pg';
import {
  asId,
  NotFoundError,
  type AccountId,
  type OrderId,
  type QuoteId,
  type RequestId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import type {
  CreateOrderFromQuoteDTO,
  Fulfilment,
  OrderDTO,
  OrderStatus,
} from '../contract/dto';
import { ORDER_CREATED, ORDER_STATUS_CHANGED } from '../contract/events';
import { assertOrderTransition } from '../domain/order-state';

interface OrderRow {
  id: string;
  request_id: string | null;
  quote_id: string | null;
  client_account_id: string;
  supplier_id: string;
  fulfilment: string;
  workshop_supplier_id: string | null;
  appointment_at: Date | null;
  amount_minor: string | null;
  currency: string | null;
  status: string;
  created_at: Date;
}

const COLS = `id, request_id, quote_id, client_account_id, supplier_id, fulfilment,
  workshop_supplier_id, appointment_at, amount_minor, currency, status, created_at`;

function toDTO(row: OrderRow): OrderDTO {
  const amountMinor = row.amount_minor === null ? null : Number(row.amount_minor);
  return {
    id: asId<OrderId>(row.id),
    requestId: row.request_id ? asId<RequestId>(row.request_id) : null,
    quoteId: row.quote_id ? asId<QuoteId>(row.quote_id) : null,
    clientAccountId: asId<AccountId>(row.client_account_id),
    supplierId: asId<SupplierId>(row.supplier_id),
    fulfilment: row.fulfilment as Fulfilment,
    workshopSupplierId: row.workshop_supplier_id
      ? asId<SupplierId>(row.workshop_supplier_id)
      : null,
    appointmentAt: row.appointment_at?.toISOString() ?? null,
    amount: amountMinor !== null && row.currency ? { amountMinor, currency: row.currency } : null,
    status: row.status as OrderStatus,
    createdAt: row.created_at.toISOString(),
  };
}

export class PgOrdersRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'orders');
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Idempotent on quote_id: a redelivered QuoteAccepted returns the same order. */
  async createFromAcceptedQuote(input: CreateOrderFromQuoteDTO): Promise<OrderDTO> {
    return this.tx(async (client) => {
      const inserted = await client.query<OrderRow>(
        `insert into orders.orders
           (request_id, quote_id, client_account_id, supplier_id, amount_minor, currency)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (quote_id) do nothing
         returning ${COLS}`,
        [
          input.requestId,
          input.quoteId,
          input.clientAccountId,
          input.supplierId,
          input.amount?.amountMinor ?? null,
          input.amount?.currency ?? null,
        ],
      );

      if (inserted.rows.length === 0) {
        const existing = await client.query<OrderRow>(
          `select ${COLS} from orders.orders where quote_id = $1`,
          [input.quoteId],
        );
        return toDTO(existing.rows[0]);
      }

      const order = toDTO(inserted.rows[0]);
      await this.outbox.appendWith(client, [
        makeEvent({
          type: ORDER_CREATED,
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            requestId: order.requestId,
            quoteId: order.quoteId,
            clientAccountId: order.clientAccountId,
            supplierId: order.supplierId,
            amountMinor: order.amount?.amountMinor ?? null,
            currency: order.amount?.currency ?? null,
          },
        }),
      ]);
      return order;
    });
  }

  async findForClient(clientAccountId: AccountId, orderId: OrderId): Promise<OrderDTO> {
    const res = await this.pool.query<OrderRow>(
      `select ${COLS} from orders.orders where id = $1 and client_account_id = $2`,
      [orderId, clientAccountId],
    );
    if (!res.rows[0]) throw new NotFoundError('Order', orderId);
    return toDTO(res.rows[0]);
  }

  async listForClient(clientAccountId: AccountId, limit: number): Promise<OrderDTO[]> {
    const res = await this.pool.query<OrderRow>(
      `select ${COLS} from orders.orders where client_account_id = $1
        order by created_at desc limit $2`,
      [clientAccountId, limit],
    );
    return res.rows.map(toDTO);
  }

  async listForSupplier(supplierId: SupplierId, limit: number): Promise<OrderDTO[]> {
    const res = await this.pool.query<OrderRow>(
      `select ${COLS} from orders.orders where supplier_id = $1
        order by created_at desc limit $2`,
      [supplierId, limit],
    );
    return res.rows.map(toDTO);
  }

  async setFulfilment(
    clientAccountId: AccountId,
    orderId: OrderId,
    input: { fulfilment: Fulfilment; workshopSupplierId?: SupplierId; appointmentAt?: string },
  ): Promise<OrderDTO> {
    const res = await this.pool.query<OrderRow>(
      `update orders.orders
          set fulfilment = $3, workshop_supplier_id = $4, appointment_at = $5, updated_at = now()
        where id = $1 and client_account_id = $2
        returning ${COLS}`,
      [
        orderId,
        clientAccountId,
        input.fulfilment,
        input.workshopSupplierId ?? null,
        input.appointmentAt ?? null,
      ],
    );
    if (!res.rows[0]) throw new NotFoundError('Order', orderId);
    return toDTO(res.rows[0]);
  }

  /**
   * Move an order, under a row lock.
   *
   * `guard` restricts the row to a party of the order, so someone who is
   * neither buyer nor seller gets a 404 rather than a 403 — the endpoint does
   * not confirm the order exists to a stranger.
   *
   * The `for update` matters more than it looks now that completion issues an
   * invoice. Two concurrent completes both read `in_progress` without it, and
   * both would pass the state machine; with it the second one reads
   * `completed` and the transition is refused. That is the first of three
   * defences, the others being that `completed` is terminal and the unique
   * index on (type, subject_type, subject_id) in the documents schema.
   */
  async changeStatus(
    orderId: OrderId,
    next: OrderStatus,
    guard?: { clientAccountId?: AccountId; supplierId?: SupplierId },
  ): Promise<OrderDTO> {
    return this.tx(async (client) => {
      const params: unknown[] = [orderId];
      let where = 'id = $1';
      if (guard?.clientAccountId) {
        params.push(guard.clientAccountId);
        where += ` and client_account_id = $${params.length}`;
      }
      if (guard?.supplierId) {
        params.push(guard.supplierId);
        where += ` and supplier_id = $${params.length}`;
      }

      const current = await client.query<OrderRow>(
        `select ${COLS} from orders.orders where ${where} for update`,
        params,
      );
      if (!current.rows[0]) throw new NotFoundError('Order', orderId);
      const from = current.rows[0].status as OrderStatus;
      assertOrderTransition(from, next);

      const res = await client.query<OrderRow>(
        `update orders.orders set status = $2, updated_at = now() where id = $1 returning ${COLS}`,
        [orderId, next],
      );
      const order = toDTO(res.rows[0]);
      await this.outbox.appendWith(client, [
        makeEvent({
          type: ORDER_STATUS_CHANGED,
          aggregateId: asId<Uuid>(order.id),
          payload: {
            orderId: order.id,
            clientAccountId: order.clientAccountId,
            supplierId: order.supplierId,
            from,
            to: next,
            amountMinor: order.amount?.amountMinor ?? null,
            currency: order.amount?.currency ?? null,
          },
        }),
      ]);
      return order;
    });
  }
}
