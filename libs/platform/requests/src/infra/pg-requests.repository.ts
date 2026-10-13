import { Pool, type PoolClient } from 'pg';
import {
  asId,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type AccountId,
  type QuoteId,
  type RequestId,
  type SupplierId,
  type Uuid,
  type VehicleId,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore, type DomainEvent } from '@justgo/events';
import type { RequestStrategy } from '@justgo/contracts';
import type { QuoteStatus, RequestStatus } from '../contract/status';
import { applyQuoteTransition, type QuoteTransition } from '../domain/quote-state';
import { applyRequestTransition, bestPriceQuoteId } from '../domain/request-state';
import type {
  OfferAlternativeDTO,
  PartRequestDetailDTO,
  QuoteDTO,
  SubmitQuoteDTO,
  SubmitRequestDTO,
} from '../contract/dto';
import {
  QUOTE_ACCEPTED,
  QUOTE_ALTERNATIVE_OFFERED,
  QUOTE_REJECTED,
  QUOTE_REQUESTED,
  QUOTE_SUBMITTED,
  REQUEST_EXPIRED,
  REQUEST_SUBMITTED,
} from '../contract/events';

interface RequestRow {
  id: string;
  client_account_id: string;
  vehicle_id: string | null;
  tecdoc_article_id: string | null;
  category_key: string | null;
  free_text: string | null;
  photo_url: string | null;
  quantity: number;
  strategy: string;
  status: string;
  created_at: Date;
  expires_at: Date | null;
}

interface QuoteRow {
  id: string;
  request_id: string;
  supplier_id: string;
  kind: string | null;
  amount_minor: string | null;
  currency: string | null;
  alt_name: string | null;
  alt_reference: string | null;
  alt_tecdoc_article_id: string | null;
  status: string;
  reason: string | null;
  created_at: Date;
}

const REQUEST_COLS = `id, client_account_id, vehicle_id, tecdoc_article_id, category_key,
  free_text, photo_url, quantity, strategy, status, created_at, expires_at`;
const QUOTE_COLS = `id, request_id, supplier_id, kind, amount_minor, currency, alt_name,
  alt_reference, alt_tecdoc_article_id, status, reason, created_at`;

/** bigint arrives as a string from pg — money stays integral (§17.4). */
const toInt = (v: string | null): number | null => (v === null ? null : Number(v));

function toQuoteDTO(row: QuoteRow): QuoteDTO {
  const amountMinor = toInt(row.amount_minor);
  return {
    id: asId<QuoteId>(row.id),
    requestId: asId<RequestId>(row.request_id),
    supplierId: asId<SupplierId>(row.supplier_id),
    kind: row.kind as 'price' | 'alternative' | null,
    amount: amountMinor !== null && row.currency ? { amountMinor, currency: row.currency } : null,
    altName: row.alt_name,
    altReference: row.alt_reference,
    altTecdocArticleId: toInt(row.alt_tecdoc_article_id),
    status: row.status as QuoteStatus,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  };
}

function toRequestDTO(row: RequestRow, quotes: QuoteDTO[]): PartRequestDetailDTO {
  const bestId = bestPriceQuoteId(
    quotes.map((q) => ({
      id: q.id,
      status: q.status,
      amountMinor: q.amount?.amountMinor ?? null,
      currency: q.amount?.currency ?? null,
    })),
  );
  return {
    id: asId<RequestId>(row.id),
    clientAccountId: asId<AccountId>(row.client_account_id),
    vehicleId: row.vehicle_id ? asId<VehicleId>(row.vehicle_id) : null,
    tecdocArticleId: toInt(row.tecdoc_article_id),
    categoryKey: row.category_key,
    freeText: row.free_text,
    photoUrl: row.photo_url,
    quantity: row.quantity,
    strategy: row.strategy as RequestStrategy,
    status: row.status as RequestStatus,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    quotes: quotes.map((q) => ({ ...q, isBest: q.id === bestId })),
    bestQuoteId: bestId ? asId<QuoteId>(bestId) : null,
  };
}

/**
 * All SQL confined to the `requests` schema (§17.4). Every state change and
 * its events commit in ONE transaction (§17.2), with the aggregate row
 * locked FOR UPDATE so concurrent quoting cannot lose updates (§16).
 */
export class PgRequestsRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'requests');
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadQuotes(client: PoolClient | Pool, requestId: string): Promise<QuoteDTO[]> {
    const res = await client.query<QuoteRow>(
      `select ${QUOTE_COLS} from requests.quotes where request_id = $1 order by created_at`,
      [requestId],
    );
    return res.rows.map(toQuoteDTO);
  }

  async submit(
    clientAccountId: AccountId,
    input: SubmitRequestDTO,
    expiresAt: Date | null,
  ): Promise<PartRequestDetailDTO> {
    return this.tx(async (client) => {
      // idempotent create: a retry with the same key returns the original
      const inserted = await client.query<RequestRow>(
        `insert into requests.part_requests
           (client_account_id, vehicle_id, tecdoc_article_id, category_key, free_text,
            photo_url, quantity, strategy, target_supplier_id, idempotency_key, expires_at)
         values ($1,$2,$3,$4,$5,$6,coalesce($7,1),$8,$9,$10,$11)
         on conflict (idempotency_key) do nothing
         returning ${REQUEST_COLS}`,
        [
          clientAccountId,
          input.vehicleId ?? null,
          input.tecdocArticleId ?? null,
          input.categoryKey ?? null,
          input.freeText ?? null,
          input.photoUrl ?? null,
          input.quantity ?? null,
          input.strategy,
          input.targetSupplierId ?? null,
          input.idempotencyKey ?? null,
          expiresAt,
        ],
      );

      if (inserted.rows.length === 0) {
        // conflict → the client retried; return what already exists
        const existing = await client.query<RequestRow>(
          `select ${REQUEST_COLS} from requests.part_requests where idempotency_key = $1`,
          [input.idempotencyKey],
        );
        if (existing.rows.length === 0) {
          throw new ConflictError('REQUEST_CONFLICT', 'Could not create or resolve the request');
        }
        return toRequestDTO(existing.rows[0], await this.loadQuotes(client, existing.rows[0].id));
      }

      const row = inserted.rows[0];
      await this.outbox.appendWith(client, [
        makeEvent({
          type: REQUEST_SUBMITTED,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            requestId: row.id,
            clientAccountId,
            categoryKey: row.category_key,
            tecdocArticleId: toInt(row.tecdoc_article_id),
            strategy: row.strategy,
            targetSupplierId: input.targetSupplierId ?? null,
          },
        }),
      ]);
      return toRequestDTO(row, []);
    });
  }

  /**
   * Creates one pending quote stub per targeted supplier and emits a
   * QuoteRequested event per NEW stub (§13 supplier signal). Idempotent:
   * `on conflict do nothing` means a replay adds no rows and no events.
   */
  async fanOut(requestId: RequestId, supplierIds: SupplierId[]): Promise<number> {
    if (supplierIds.length === 0) return 0;
    return this.tx(async (client) => {
      const req = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests where id = $1`,
        [requestId],
      );
      const request = req.rows[0];
      if (!request) throw new NotFoundError('Request', requestId);

      const inserted = await client.query<{ id: string; supplier_id: string }>(
        `insert into requests.quotes (request_id, supplier_id)
         select $1, unnest($2::uuid[])
         on conflict (request_id, supplier_id) do nothing
         returning id, supplier_id`,
        [requestId, supplierIds],
      );
      if (inserted.rows.length === 0) return 0;

      await this.outbox.appendWith(
        client,
        inserted.rows.map((r) =>
          makeEvent({
            type: QUOTE_REQUESTED,
            aggregateId: asId<Uuid>(requestId),
            payload: {
              quoteId: r.id,
              requestId,
              supplierId: r.supplier_id,
              clientAccountId: request.client_account_id,
              categoryKey: request.category_key,
              tecdocArticleId: toInt(request.tecdoc_article_id),
              freeText: request.free_text,
            },
          }),
        ),
      );
      return inserted.rows.length;
    });
  }

  async findForClient(
    clientAccountId: AccountId,
    requestId: RequestId,
  ): Promise<PartRequestDetailDTO> {
    const res = await this.pool.query<RequestRow>(
      `select ${REQUEST_COLS} from requests.part_requests where id = $1`,
      [requestId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundError('Request', requestId);
    if (row.client_account_id !== clientAccountId) {
      // do not leak existence to a different client
      throw new NotFoundError('Request', requestId);
    }
    return toRequestDTO(row, await this.loadQuotes(this.pool, row.id));
  }

  async listForClient(clientAccountId: AccountId, limit: number): Promise<PartRequestDetailDTO[]> {
    const res = await this.pool.query<RequestRow>(
      `select ${REQUEST_COLS} from requests.part_requests
        where client_account_id = $1 order by created_at desc limit $2`,
      [clientAccountId, limit],
    );
    const out: PartRequestDetailDTO[] = [];
    for (const row of res.rows) out.push(toRequestDTO(row, await this.loadQuotes(this.pool, row.id)));
    return out;
  }

  async inbox(supplierId: SupplierId, limit: number): Promise<QuoteDTO[]> {
    const res = await this.pool.query<QuoteRow>(
      `select ${QUOTE_COLS} from requests.quotes
        where supplier_id = $1 order by created_at desc limit $2`,
      [supplierId, limit],
    );
    return res.rows.map(toQuoteDTO);
  }

  /**
   * Supplier-side transition. Locks the quote AND its request, applies the
   * guarded transition, and emits the matching event in the same tx.
   */
  async supplierTransition(
    supplierId: SupplierId,
    quoteId: QuoteId,
    transition: Extract<QuoteTransition, 'submit_price' | 'offer_alternative' | 'reject'>,
    payload: { price?: SubmitQuoteDTO; alternative?: OfferAlternativeDTO; reason?: string },
  ): Promise<QuoteDTO> {
    return this.tx(async (client) => {
      const quoteRes = await client.query<QuoteRow>(
        `select ${QUOTE_COLS} from requests.quotes where id = $1 for update`,
        [quoteId],
      );
      const quote = quoteRes.rows[0];
      if (!quote) throw new NotFoundError('Quote', quoteId);
      if (quote.supplier_id !== supplierId) {
        throw new ForbiddenError('This quote belongs to another supplier');
      }

      const reqRes = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests where id = $1 for update`,
        [quote.request_id],
      );
      const request = reqRes.rows[0];
      const requestStatus = request.status as RequestStatus;
      if (requestStatus !== 'pending' && requestStatus !== 'awaiting_client') {
        throw new ConflictError(
          'REQUEST_CLOSED',
          `Cannot respond to a request in status "${requestStatus}"`,
          { status: requestStatus },
        );
      }

      const nextStatus = applyQuoteTransition(quote.status as QuoteStatus, transition);
      const events: DomainEvent[] = [];
      let updated: QuoteRow;

      if (transition === 'submit_price') {
        const amount = payload.price?.amount;
        if (!amount) throw new ConflictError('PRICE_REQUIRED', 'A price quote needs an amount');
        const res = await client.query<QuoteRow>(
          `update requests.quotes
              set kind = 'price', amount_minor = $2, currency = $3, status = $4,
                  alt_name = null, alt_reference = null, alt_tecdoc_article_id = null,
                  reason = null, updated_at = now()
            where id = $1 returning ${QUOTE_COLS}`,
          [quoteId, amount.amountMinor, amount.currency, nextStatus],
        );
        updated = res.rows[0];
        events.push(
          makeEvent({
            type: QUOTE_SUBMITTED,
            aggregateId: asId<Uuid>(quote.request_id),
            payload: {
              quoteId,
              requestId: quote.request_id,
              supplierId,
              clientAccountId: request.client_account_id,
              amountMinor: amount.amountMinor,
              currency: amount.currency,
            },
          }),
        );
      } else if (transition === 'offer_alternative') {
        const alt = payload.alternative;
        if (!alt) throw new ConflictError('ALTERNATIVE_REQUIRED', 'An alternative needs a part');
        const res = await client.query<QuoteRow>(
          `update requests.quotes
              set kind = 'alternative', alt_name = $2, alt_reference = $3,
                  alt_tecdoc_article_id = $4, amount_minor = $5, currency = $6,
                  status = $7, reason = null, updated_at = now()
            where id = $1 returning ${QUOTE_COLS}`,
          [
            quoteId,
            alt.altName,
            alt.altReference ?? null,
            alt.altTecdocArticleId ?? null,
            alt.amount?.amountMinor ?? null,
            alt.amount?.currency ?? null,
            nextStatus,
          ],
        );
        updated = res.rows[0];
        events.push(
          makeEvent({
            type: QUOTE_ALTERNATIVE_OFFERED,
            aggregateId: asId<Uuid>(quote.request_id),
            payload: {
              quoteId,
              requestId: quote.request_id,
              supplierId,
              clientAccountId: request.client_account_id,
              altName: alt.altName,
            },
          }),
        );
      } else {
        const res = await client.query<QuoteRow>(
          `update requests.quotes set status = $2, reason = $3, updated_at = now()
            where id = $1 returning ${QUOTE_COLS}`,
          [quoteId, nextStatus, payload.reason ?? null],
        );
        updated = res.rows[0];
        events.push(
          makeEvent({
            type: QUOTE_REJECTED,
            aggregateId: asId<Uuid>(quote.request_id),
            payload: {
              quoteId,
              requestId: quote.request_id,
              supplierId,
              clientAccountId: request.client_account_id,
              reason: payload.reason ?? null,
            },
          }),
        );
      }

      // a real offer moves the request to awaiting_client
      if (transition !== 'reject' && requestStatus === 'pending') {
        await client.query(`update requests.part_requests set status = $2 where id = $1`, [
          quote.request_id,
          applyRequestTransition(requestStatus, 'quote_received'),
        ]);
      }

      await this.outbox.appendWith(client, events);
      return toQuoteDTO(updated);
    });
  }

  /**
   * Client accepts a quote: the winner goes ACCEPTED, every sibling is
   * CLOSED, the request goes ACCEPTED — atomically (§8.1).
   */
  /**
   * A quote, but only if it is on the caller's own request.
   *
   * The join is what makes this safe: quote ids are opaque but guessable in
   * bulk, and a quote carries a supplier's price. 404 rather than 403, so the
   * endpoint does not confirm a quote exists to someone it does not belong to.
   */
  async quoteForClient(clientAccountId: AccountId, quoteId: QuoteId): Promise<QuoteDTO> {
    const res = await this.pool.query<QuoteRow>(
      `select ${QUOTE_COLS.split(',').map((c) => `q.${c.trim()}`).join(', ')}
         from requests.quotes q
         join requests.part_requests r on r.id = q.request_id
        where q.id = $1 and r.client_account_id = $2`,
      [quoteId, clientAccountId],
    );
    if (!res.rows[0]) throw new NotFoundError('Quote', quoteId);
    return toQuoteDTO(res.rows[0]);
  }

  async acceptQuote(clientAccountId: AccountId, quoteId: QuoteId): Promise<PartRequestDetailDTO> {
    return this.tx(async (client) => {
      const quoteRes = await client.query<QuoteRow>(
        `select ${QUOTE_COLS} from requests.quotes where id = $1 for update`,
        [quoteId],
      );
      const quote = quoteRes.rows[0];
      if (!quote) throw new NotFoundError('Quote', quoteId);

      const reqRes = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests where id = $1 for update`,
        [quote.request_id],
      );
      const request = reqRes.rows[0];
      if (request.client_account_id !== clientAccountId) {
        throw new NotFoundError('Quote', quoteId);
      }

      const nextQuote = applyQuoteTransition(quote.status as QuoteStatus, 'accept');
      const nextRequest = applyRequestTransition(request.status as RequestStatus, 'accept');

      await client.query(`update requests.quotes set status = $2, updated_at = now() where id = $1`, [
        quoteId,
        nextQuote,
      ]);
      // losing quotes close; already-terminal ones stay as they are
      await client.query(
        `update requests.quotes set status = 'closed', updated_at = now()
          where request_id = $1 and id <> $2 and status in ('pending','quoted')`,
        [quote.request_id, quoteId],
      );
      await client.query(`update requests.part_requests set status = $2 where id = $1`, [
        quote.request_id,
        nextRequest,
      ]);

      await this.outbox.appendWith(client, [
        makeEvent({
          type: QUOTE_ACCEPTED,
          aggregateId: asId<Uuid>(quote.request_id),
          payload: {
            quoteId,
            requestId: quote.request_id,
            supplierId: quote.supplier_id,
            clientAccountId,
            amountMinor: toInt(quote.amount_minor),
            currency: quote.currency,
          },
        }),
      ]);

      const fresh = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests where id = $1`,
        [quote.request_id],
      );
      return toRequestDTO(fresh.rows[0], await this.loadQuotes(client, quote.request_id));
    });
  }

  /** Client refuses one offer; the request stays open for other suppliers. */
  async refuseQuote(
    clientAccountId: AccountId,
    quoteId: QuoteId,
    reason: string | undefined,
  ): Promise<PartRequestDetailDTO> {
    return this.tx(async (client) => {
      const quoteRes = await client.query<QuoteRow>(
        `select ${QUOTE_COLS} from requests.quotes where id = $1 for update`,
        [quoteId],
      );
      const quote = quoteRes.rows[0];
      if (!quote) throw new NotFoundError('Quote', quoteId);

      const reqRes = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests where id = $1 for update`,
        [quote.request_id],
      );
      const request = reqRes.rows[0];
      if (request.client_account_id !== clientAccountId) throw new NotFoundError('Quote', quoteId);

      const next = applyQuoteTransition(quote.status as QuoteStatus, 'refuse');
      await client.query(
        `update requests.quotes set status = $2, reason = $3, updated_at = now() where id = $1`,
        [quoteId, next, reason ?? null],
      );

      const fresh = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests where id = $1`,
        [quote.request_id],
      );
      return toRequestDTO(fresh.rows[0], await this.loadQuotes(client, quote.request_id));
    });
  }

  async cancel(clientAccountId: AccountId, requestId: RequestId): Promise<PartRequestDetailDTO> {
    return this.tx(async (client) => {
      const reqRes = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests where id = $1 for update`,
        [requestId],
      );
      const request = reqRes.rows[0];
      if (!request || request.client_account_id !== clientAccountId) {
        throw new NotFoundError('Request', requestId);
      }
      const next = applyRequestTransition(request.status as RequestStatus, 'cancel');
      await client.query(`update requests.part_requests set status = $2 where id = $1`, [
        requestId,
        next,
      ]);
      await client.query(
        `update requests.quotes set status = 'closed', updated_at = now()
          where request_id = $1 and status in ('pending','quoted')`,
        [requestId],
      );
      const fresh = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests where id = $1`,
        [requestId],
      );
      return toRequestDTO(fresh.rows[0], await this.loadQuotes(client, requestId));
    });
  }

  /** Sweeps every request past its expiry (worker-driven, §8.1). */
  async expireDue(now: Date): Promise<number> {
    return this.tx(async (client) => {
      const due = await client.query<RequestRow>(
        `select ${REQUEST_COLS} from requests.part_requests
          where status in ('pending','awaiting_client')
            and expires_at is not null and expires_at <= $1
          for update skip locked`,
        [now],
      );
      if (due.rows.length === 0) return 0;
      const ids = due.rows.map((r) => r.id);
      await client.query(
        `update requests.part_requests set status = 'expired' where id = any($1::uuid[])`,
        [ids],
      );
      await client.query(
        `update requests.quotes set status = 'closed', updated_at = now()
          where request_id = any($1::uuid[]) and status in ('pending','quoted')`,
        [ids],
      );
      await this.outbox.appendWith(
        client,
        due.rows.map((row) =>
          makeEvent({
            type: REQUEST_EXPIRED,
            aggregateId: asId<Uuid>(row.id),
            payload: { requestId: row.id, clientAccountId: row.client_account_id },
          }),
        ),
      );
      return ids.length;
    });
  }
}
