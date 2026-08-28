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
import { RESERVATION_REQUESTED, RESERVATION_STATUS_CHANGED } from '../contract/events';
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
}

const COLS = `id, client_account_id, supplier_id, branch_id, service_type_key, vehicle_id,
  slot_start, slot_end, status, note, created_at`;

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
   * Guarded status transition. `by` scopes ownership — supplier-side actions
   * check supplier_id, client-side check client_account_id. Emits
   * ReservationStatusChanged in the same tx (§17.2).
   */
  async transition(
    id: ReservationId,
    next: ReservationStatus,
    by: { supplierId?: SupplierId; clientAccountId?: AccountId },
    opts: { note?: string; reschedule?: { slotStart: string; slotEnd: string } } = {},
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
                  updated_at = now()
            where id = $1 returning ${COLS}`,
          [
            id,
            next,
            opts.reschedule?.slotStart ?? null,
            opts.reschedule?.slotEnd ?? null,
            opts.note ?? null,
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
          },
        }),
      ]);
      return toDTO(res.rows[0]);
    });
  }
}
