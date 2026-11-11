import { Pool, type PoolClient } from 'pg';
import {
  asId,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type AccountId,
  type BranchId,
  type ReservationId,
  type SupplierId,
  type Uuid,
  type VehicleId,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import type { CreateReservationDTO, ReservationDTO, ReservationStatus } from '../contract/dto';
import {
  RESERVATION_CHARGED,
  RESERVATION_REQUESTED,
  RESERVATION_STATUS_CHANGED,
} from '../contract/events';
import { assertReservationTransition } from '../domain/reservation-state';

interface Row {
  id: string;
  client_account_id: string;
  supplier_id: string;
  branch_id: string | null;
  service_type_key: string;
  vehicle_id: string | null;
  slot_start: Date;
  slot_end: Date;
  status: string;
  note: string | null;
  created_at: Date;
  amount_minor: string | null;
  currency: string | null;
  charged_at: Date | null;
}

const COLS = `id, client_account_id, supplier_id, branch_id, service_type_key, vehicle_id,
  slot_start, slot_end, status, note, created_at, amount_minor, currency, charged_at`;

/** Postgres unique-violation SQLSTATE — the double-booking guard fires this. */
const UNIQUE_VIOLATION = '23505';

function toDTO(r: Row): ReservationDTO {
  return {
    id: asId<ReservationId>(r.id),
    clientAccountId: asId<AccountId>(r.client_account_id),
    supplierId: asId<SupplierId>(r.supplier_id),
    branchId: r.branch_id ? asId<BranchId>(r.branch_id) : null,
    serviceTypeKey: r.service_type_key,
    vehicleId: r.vehicle_id ? asId<VehicleId>(r.vehicle_id) : null,
    slotStart: r.slot_start.toISOString(),
    slotEnd: r.slot_end.toISOString(),
    status: r.status as ReservationStatus,
    note: r.note,
    createdAt: r.created_at.toISOString(),
    // bigint arrives as a string from pg; money is integer minor units.
    amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
    currency: r.currency,
    chargedAt: r.charged_at ? r.charged_at.toISOString() : null,
  };
}

/**
 * The money half of a completed booking, for the ReservationCharged event.
 *
 * Built from the UPDATED row rather than the caller's input, so what the
 * facture is issued from is what the database actually holds - including
 * the currency, which may have been set by an earlier call.
 */
function chargedPayload(r: Row): Record<string, unknown> {
  return {
    reservationId: r.id,
    clientAccountId: r.client_account_id,
    supplierId: r.supplier_id,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    serviceTypeKey: r.service_type_key,
    slotStart: r.slot_start.toISOString(),
    slotEnd: r.slot_end.toISOString(),
    vehicleId: r.vehicle_id,
  };
}

/** All SQL confined to the `reservations` schema (§17.4). */
export class PgReservationsRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'reservations');
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  async create(clientAccountId: AccountId, input: CreateReservationDTO): Promise<ReservationDTO> {
    return this.tx(async (c) => {
      let res;
      try {
        res = await c.query<Row>(
          `insert into reservations.reservations
             (client_account_id, supplier_id, branch_id, service_type_key, vehicle_id,
              slot_start, slot_end, note)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${COLS}`,
          [
            clientAccountId,
            input.supplierId,
            input.branchId ?? null,
            input.serviceTypeKey,
            input.vehicleId ?? null,
            input.slotStart,
            input.slotEnd,
            input.note ?? null,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          // the no-double-book partial unique index (§8.3)
          throw new ConflictError('SLOT_TAKEN', 'That slot is already booked', {
            supplierId: input.supplierId,
            slotStart: input.slotStart,
          });
        }
        throw error;
      }
      const dto = toDTO(res.rows[0]);
      await this.outbox.appendWith(c, [
        makeEvent({
          type: RESERVATION_REQUESTED,
          aggregateId: dto.id,
          payload: {
            reservationId: dto.id,
            clientAccountId,
            supplierId: dto.supplierId,
            serviceTypeKey: dto.serviceTypeKey,
            slotStart: dto.slotStart,
          },
        }),
      ]);
      return dto;
    });
  }

  async listForClient(clientAccountId: AccountId, limit: number): Promise<ReservationDTO[]> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from reservations.reservations
        where client_account_id = $1 order by slot_start desc limit $2`,
      [clientAccountId, limit],
    );
    return res.rows.map(toDTO);
  }

  async listForSupplier(supplierId: SupplierId, limit: number): Promise<ReservationDTO[]> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from reservations.reservations
        where supplier_id = $1 order by slot_start desc limit $2`,
      [supplierId, limit],
    );
    return res.rows.map(toDTO);
  }

  /**
   * One booking, scoped to the supplier in the same query.
   *
   * The supplier id is a WHERE clause, not a check after the fact: a
   * read that fetches first and compares second is one early return
   * away from leaking, and the row simply is not theirs to see.
   */
  async byIdForSupplier(supplierId: SupplierId, id: ReservationId): Promise<ReservationDTO | null> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from reservations.reservations where id = $1 and supplier_id = $2`,
      [id, supplierId],
    );
    const row = res.rows[0];
    return row ? toDTO(row) : null;
  }

  /**
   * State what a finished job cost, for a booking that was completed
   * without a figure.
   *
   * WHY THIS EXISTS AT ALL rather than forcing the amount into
   * `complete`. The supplier app has a Terminer button that has never
   * asked for money, and making the amount mandatory would break every
   * copy of it in the field. So completion still works bare, and this is
   * how the bill arrives afterwards — one call, any time.
   *
   * WRITE-ONCE. A second charge with the SAME amount is accepted and
   * emits nothing new, so a retried request is harmless. A second charge
   * with a DIFFERENT amount is refused: the facture has already been
   * issued, sealed and handed to the customer, and silently re-pricing
   * underneath it would leave two different truths about one supply.
   * Correcting a facture is a credit note, not an UPDATE.
   */
  async charge(
    supplierId: SupplierId,
    id: ReservationId,
    input: { amountMinor: number; currency: string },
  ): Promise<ReservationDTO> {
    return this.tx(async (c) => {
      const cur = await c.query<Row>(
        `select ${COLS} from reservations.reservations
          where id = $1 and supplier_id = $2 for update`,
        [id, supplierId],
      );
      const row = cur.rows[0];
      if (!row) throw new NotFoundError('Reservation', id);

      if (row.status !== 'completed') {
        throw new ConflictError(
          'RESERVATION_NOT_COMPLETED',
          'A booking can only be charged once the work is completed',
          { status: row.status },
        );
      }

      if (row.amount_minor !== null) {
        if (Number(row.amount_minor) === input.amountMinor && row.currency === input.currency) {
          return toDTO(row);
        }
        throw new ConflictError(
          'ALREADY_CHARGED',
          'This booking has already been charged; issue a credit note to correct it',
          { amountMinor: Number(row.amount_minor), currency: row.currency },
        );
      }

      const res = await c.query<Row>(
        `update reservations.reservations
            set amount_minor = $3, currency = $4, charged_at = now(), updated_at = now()
          where id = $1 and supplier_id = $2 returning ${COLS}`,
        [id, supplierId, input.amountMinor, input.currency],
      );

      if (input.amountMinor > 0) {
        await this.outbox.appendWith(c, [
          makeEvent({
            type: RESERVATION_CHARGED,
            aggregateId: asId<Uuid>(id),
            payload: chargedPayload(res.rows[0]),
          }),
        ]);
      }
      return toDTO(res.rows[0]);
    });
  }

  /**
   * Guarded status transition. `by` scopes ownership — supplier-side actions
   * check supplier_id, client-side check client_account_id. Emits
   * ReservationStatusChanged in the same tx (§17.2).
   */
  async transition(
    id: ReservationId,
    next: ReservationStatus,
    by: { supplierId?: SupplierId; clientAccountId?: AccountId },
    opts: {
      note?: string;
      reschedule?: { slotStart: string; slotEnd: string };
      /**
       * What the supplier charged. Only meaningful on the way into
       * `completed`: a workshop knows the bill when the car is back on
       * the ground, not when it took the booking.
       */
      charge?: { amountMinor: number; currency: string };
    } = {},
  ): Promise<ReservationDTO> {
    return this.tx(async (c) => {
      const cur = await c.query<Row>(
        `select ${COLS} from reservations.reservations where id = $1 for update`,
        [id],
      );
      const row = cur.rows[0];
      if (!row) throw new NotFoundError('Reservation', id);
      if (by.supplierId && row.supplier_id !== by.supplierId) {
        throw new ForbiddenError('This reservation targets another supplier');
      }
      if (by.clientAccountId && row.client_account_id !== by.clientAccountId) {
        throw new NotFoundError('Reservation', id);
      }

      const from = row.status as ReservationStatus;
      assertReservationTransition(from, next);

      let res;
      try {
        res = await c.query<Row>(
          `update reservations.reservations
              set status = $2,
                  slot_start = coalesce($3, slot_start),
                  slot_end = coalesce($4, slot_end),
                  note = coalesce($5, note),
                  amount_minor = coalesce($6, amount_minor),
                  currency = coalesce($7, currency),
                  charged_at = case when $6 is null then charged_at else now() end,
                  updated_at = now()
            where id = $1 returning ${COLS}`,
          [
            id,
            next,
            opts.reschedule?.slotStart ?? null,
            opts.reschedule?.slotEnd ?? null,
            opts.note ?? null,
            opts.charge?.amountMinor ?? null,
            opts.charge?.currency ?? null,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictError('SLOT_TAKEN', 'That slot is already booked');
        }
        throw error;
      }

      await this.outbox.appendWith(c, [
        makeEvent({
          type: RESERVATION_STATUS_CHANGED,
          aggregateId: asId<Uuid>(id),
          payload: {
            reservationId: id,
            clientAccountId: row.client_account_id,
            supplierId: row.supplier_id,
            from,
            to: next,
            /*
              The booking itself travels with the event. Taken from the
              UPDATED row, so a reschedule announces the new slot rather
              than the one it replaced.
            */
            serviceTypeKey: res.rows[0].service_type_key,
            slotStart: res.rows[0].slot_start.toISOString(),
            slotEnd: res.rows[0].slot_end.toISOString(),
            vehicleId: res.rows[0].vehicle_id,
          },
        }),
        /*
          A SECOND event when there is money, and only then.

          The status change announces that the work is finished; this one
          announces that it was PAID FOR, which is a different fact with
          a different consumer. `documents` issues the facture off this
          and nothing else, so it never has to re-derive "was there an
          amount on that completion?" from a status it also receives for
          rejections and reschedules.

          It is also what makes pricing-after-the-fact work: a supplier
          who completes first and prices later emits exactly this event
          from `charge()`, and the facture comes out the same way.
        */
        ...(opts.charge && opts.charge.amountMinor > 0
          ? [
              makeEvent({
                type: RESERVATION_CHARGED,
                aggregateId: asId<Uuid>(id),
                payload: chargedPayload(res.rows[0]),
              }),
            ]
          : []),
      ]);
      return toDTO(res.rows[0]);
    });
  }
}
