import { Pool, type PoolClient } from 'pg';
import {
  asId,
  BusinessRuleError,
  NotFoundError,
  type AccountId,
  type Uuid,
  type VehicleId,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import type {
  AddMaintenanceTaskDTO,
  AddVehicleDTO,
  HealthEntryDTO,
  HealthStatus,
  MaintenanceStatus,
  MaintenanceTaskDTO,
  MileageHistoryEntryDTO,
  MileageSource,
  NotificationAccessDTO,
  UpdateVehicleDTO,
  VehicleDTO,
} from '../contract/dto';
import { MAINTENANCE_DUE, VEHICLE_ADDED } from '../contract/events';
import { isMaintenanceDue } from '../domain/maintenance';
import {
  MILEAGE_LOWER,
  MILEAGE_UPDATE_PERIOD_DAYS,
  mileageDueAt,
  mileageGoesBackwards,
} from '../domain/mileage';

interface VehicleRow {
  id: string;
  owner_account_id: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
  plate: string | null;
  mileage_km: number | null;
  tecdoc_manufacturer_id: string | null;
  tecdoc_model_id: string | null;
  tecdoc_vehicle_type_id: string | null;
  health_status: string;
  photo_url: string | null;
  created_at: Date;
  mileage_updated_at: Date;
  /** Computed by V_COLS against the database clock, never in JS. */
  mileage_update_required: boolean;
}

interface MileageRow {
  id: string;
  vehicle_id: string;
  previous_km: number | null;
  new_km: number;
  source: string;
  actor_account_id: string | null;
  recorded_at: Date;
}

interface TaskRow {
  id: string;
  vehicle_id: string;
  title: string;
  interval_km: number | null;
  interval_months: number | null;
  due_at_km: number | null;
  due_date: Date | null;
  status: string;
  created_at: Date;
}

interface HealthRow {
  id: string;
  vehicle_id: string;
  system_area: string | null;
  status: string | null;
  note: string | null;
  mileage_km: number | null;
  at: Date;
}

/*
  `mileage_update_required` is computed HERE, in every read, by the
  database. The comparison has to happen against the same clock that
  wrote `mileage_updated_at`, or a few seconds of drift between Postgres
  and whichever API container answered decides whether somebody is locked
  out of their notifications - and decides it differently per container.
*/
const V_COLS = `id, owner_account_id, name, brand, model, year, vin, plate, mileage_km,
  tecdoc_manufacturer_id, tecdoc_model_id, tecdoc_vehicle_type_id, health_status, photo_url, created_at,
  mileage_updated_at,
  (mileage_updated_at <= now() - make_interval(days => ${MILEAGE_UPDATE_PERIOD_DAYS})) as mileage_update_required`;
const T_COLS = `id, vehicle_id, title, interval_km, interval_months, due_at_km, due_date, status, created_at`;

const toBig = (v: string | null): number | null => (v === null ? null : Number(v));

function toVehicle(r: VehicleRow): VehicleDTO {
  return {
    id: asId<VehicleId>(r.id),
    ownerAccountId: asId<AccountId>(r.owner_account_id),
    name: r.name,
    brand: r.brand,
    model: r.model,
    year: r.year,
    vin: r.vin,
    plate: r.plate,
    mileageKm: r.mileage_km,
    tecdocManufacturerId: toBig(r.tecdoc_manufacturer_id),
    tecdocModelId: toBig(r.tecdoc_model_id),
    tecdocVehicleTypeId: toBig(r.tecdoc_vehicle_type_id),
    healthStatus: r.health_status as HealthStatus,
    photoUrl: r.photo_url,
    createdAt: r.created_at.toISOString(),
    mileageUpdatedAt: r.mileage_updated_at.toISOString(),
    mileageUpdateRequired: r.mileage_update_required,
  };
}

function toMileage(r: MileageRow): MileageHistoryEntryDTO {
  return {
    id: r.id,
    vehicleId: asId<VehicleId>(r.vehicle_id),
    previousKm: r.previous_km,
    newKm: r.new_km,
    source: r.source as MileageSource,
    actorAccountId: r.actor_account_id ? asId<AccountId>(r.actor_account_id) : null,
    recordedAt: r.recorded_at.toISOString(),
  };
}

function toTask(r: TaskRow): MaintenanceTaskDTO {
  return {
    id: r.id,
    vehicleId: asId<VehicleId>(r.vehicle_id),
    title: r.title,
    intervalKm: r.interval_km,
    intervalMonths: r.interval_months,
    dueAtKm: r.due_at_km,
    dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
    status: r.status as MaintenanceStatus,
    createdAt: r.created_at.toISOString(),
  };
}

/** All SQL confined to the `vehicles` schema (§17.4). */
export class PgVehiclesRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'vehicles');
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

  async insert(
    ownerAccountId: AccountId,
    input: AddVehicleDTO,
    tecdoc: { manufacturerId: number | null; modelId: number | null; kType: number | null },
  ): Promise<VehicleDTO> {
    return this.tx(async (c) => {
      const res = await c.query<VehicleRow>(
        `insert into vehicles.vehicles
           (owner_account_id, name, brand, model, year, vin, plate, mileage_km,
            tecdoc_manufacturer_id, tecdoc_model_id, tecdoc_vehicle_type_id, photo_url)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning ${V_COLS}`,
        [
          ownerAccountId,
          input.name ?? null,
          input.brand ?? null,
          input.model ?? null,
          input.year ?? null,
          input.vin ?? null,
          input.plate ?? null,
          input.mileageKm ?? null,
          tecdoc.manufacturerId,
          tecdoc.modelId,
          tecdoc.kType,
          input.photoUrl ?? null,
        ],
      );
      const v = toVehicle(res.rows[0]);
      await this.outbox.appendWith(c, [
        makeEvent({
          type: VEHICLE_ADDED,
          aggregateId: v.id,
          payload: {
            vehicleId: v.id,
            ownerAccountId,
            brand: v.brand,
            model: v.model,
            tecdocVehicleTypeId: v.tecdocVehicleTypeId,
          },
        }),
      ]);
      return v;
    });
  }

  async list(ownerAccountId: AccountId): Promise<VehicleDTO[]> {
    const res = await this.pool.query<VehicleRow>(
      `select ${V_COLS} from vehicles.vehicles where owner_account_id = $1 order by created_at desc`,
      [ownerAccountId],
    );
    return res.rows.map(toVehicle);
  }

  async find(ownerAccountId: AccountId, id: VehicleId): Promise<VehicleDTO> {
    const res = await this.pool.query<VehicleRow>(
      `select ${V_COLS} from vehicles.vehicles where id = $1 and owner_account_id = $2`,
      [id, ownerAccountId],
    );
    if (!res.rows[0]) throw new NotFoundError('Vehicle', id);
    return toVehicle(res.rows[0]);
  }

  async update(
    ownerAccountId: AccountId,
    id: VehicleId,
    patch: UpdateVehicleDTO,
  ): Promise<VehicleDTO> {
    const res = await this.pool.query<VehicleRow>(
      `update vehicles.vehicles set
         name = coalesce($3, name),
         plate = coalesce($4, plate),
         photo_url = coalesce($5, photo_url),
         health_status = coalesce($6, health_status),
         updated_at = now()
       where id = $1 and owner_account_id = $2 returning ${V_COLS}`,
      [
        id,
        ownerAccountId,
        patch.name ?? null,
        patch.plate ?? null,
        patch.photoUrl ?? null,
        patch.healthStatus ?? null,
      ],
    );
    if (!res.rows[0]) throw new NotFoundError('Vehicle', id);
    return toVehicle(res.rows[0]);
  }

  async remove(ownerAccountId: AccountId, id: VehicleId): Promise<void> {
    const res = await this.pool.query(
      `delete from vehicles.vehicles where id = $1 and owner_account_id = $2`,
      [id, ownerAccountId],
    );
    if (res.rowCount === 0) throw new NotFoundError('Vehicle', id);
  }

  /**
   * Record a reading the OWNER states.
   *
   * One transaction, and the first statement takes a row lock. Without it
   * two taps milliseconds apart both read the old value, both pass the
   * "not lower" check and both write — and the history ends up holding two
   * rows that claim the same `previous_km`, one of which is a lie about
   * what the car read when it was written.
   *
   * A refused reading changes NOTHING: not the number, not the date, no
   * history row. Moving `mileage_updated_at` on a rejection would let a
   * typo buy another 30 days without a real reading.
   */
  async setMileage(ownerAccountId: AccountId, id: VehicleId, mileageKm: number): Promise<VehicleDTO> {
    return this.tx(async (c) => {
      const current = await c.query<{ mileage_km: number | null }>(
        `select mileage_km from vehicles.vehicles
           where id = $1 and owner_account_id = $2 for update`,
        [id, ownerAccountId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundError('Vehicle', id);

      if (mileageGoesBackwards(row.mileage_km, mileageKm)) {
        throw new BusinessRuleError(
          MILEAGE_LOWER,
          'The new mileage cannot be lower than the previously recorded mileage.',
          { currentKm: row.mileage_km, submittedKm: mileageKm },
        );
      }

      const res = await c.query<VehicleRow>(
        `update vehicles.vehicles
            set mileage_km = $3, mileage_updated_at = now(), updated_at = now()
          where id = $1 and owner_account_id = $2 returning ${V_COLS}`,
        [id, ownerAccountId, mileageKm],
      );

      await c.query(
        `insert into vehicles.mileage_history
           (vehicle_id, previous_km, new_km, source, actor_account_id)
         values ($1, $2, $3, 'client', $4)`,
        [id, row.mileage_km, mileageKm, ownerAccountId],
      );

      return toVehicle(res.rows[0]);
    });
  }

  /**
   * Record a correction SUPPORT states, which may go down.
   *
   * The owner cannot lower a value, so a typo — 150 000 for 15 000 — is
   * permanent from their side and the desk has to be able to fix it. Two
   * things make that safe to allow: the history row carries
   * `source = 'support'` with the operator's account id, and
   * `mileage_updated_at` is NOT touched. The correction fixes the number;
   * it does not hand the user a fresh 30 days they never earned, and it
   * does not launder a lower reading into a current one.
   */
  async overrideMileage(input: {
    vehicleId: VehicleId;
    mileageKm: number;
    actorAccountId: AccountId;
  }): Promise<VehicleDTO> {
    return this.tx(async (c) => {
      const current = await c.query<{ mileage_km: number | null }>(
        `select mileage_km from vehicles.vehicles where id = $1 for update`,
        [input.vehicleId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundError('Vehicle', input.vehicleId);

      const res = await c.query<VehicleRow>(
        `update vehicles.vehicles set mileage_km = $2, updated_at = now()
          where id = $1 returning ${V_COLS}`,
        [input.vehicleId, input.mileageKm],
      );

      await c.query(
        `insert into vehicles.mileage_history
           (vehicle_id, previous_km, new_km, source, actor_account_id)
         values ($1, $2, $3, 'support', $4)`,
        [input.vehicleId, row.mileage_km, input.mileageKm, input.actorAccountId],
      );

      return toVehicle(res.rows[0]);
    });
  }

  /*
    The owner check is a JOIN, not a read followed by a filter: a history
    of somebody else's odometer is a record of how much they drive and
    when they stopped.
  */
  async listMileageHistory(
    ownerAccountId: AccountId,
    id: VehicleId,
    limit = 50,
  ): Promise<MileageHistoryEntryDTO[]> {
    const res = await this.pool.query<MileageRow>(
      `select h.id, h.vehicle_id, h.previous_km, h.new_km, h.source,
              h.actor_account_id, h.recorded_at
         from vehicles.mileage_history h
         join vehicles.vehicles v on v.id = h.vehicle_id
        where h.vehicle_id = $1 and v.owner_account_id = $2
        order by h.recorded_at desc limit $3`,
      [id, ownerAccountId, Math.min(Math.max(limit, 1), 200)],
    );
    return res.rows.map(toMileage);
  }

  /**
   * Is this account locked out of its notifications?
   *
   * Locked when ANY of its cars is overdue, naming the one overdue
   * longest so the app can open that car instead of a list. One query,
   * one clock: every device the account is signed in on gets the same
   * answer, and all of them clear together the moment a reading is saved.
   *
   * An account with no cars is NOT locked. A rule about stale readings
   * cannot be applied to somebody who has nothing to read.
   */
  async notificationAccess(ownerAccountId: AccountId): Promise<NotificationAccessDTO> {
    const res = await this.pool.query<{ id: string; mileage_updated_at: Date }>(
      `select id, mileage_updated_at from vehicles.vehicles
        where owner_account_id = $1
          and mileage_updated_at <= now() - make_interval(days => ${MILEAGE_UPDATE_PERIOD_DAYS})
        order by mileage_updated_at asc limit 1`,
      [ownerAccountId],
    );
    const stale = res.rows[0];
    if (!stale) {
      return { locked: false, reason: null, vehicleId: null, lastUpdatedAt: null, dueAt: null };
    }
    return {
      locked: true,
      reason: 'MILEAGE_UPDATE_REQUIRED',
      vehicleId: asId<VehicleId>(stale.id),
      lastUpdatedAt: stale.mileage_updated_at.toISOString(),
      dueAt: mileageDueAt(stale.mileage_updated_at),
    };
  }

  async addTask(id: VehicleId, input: AddMaintenanceTaskDTO): Promise<MaintenanceTaskDTO> {
    const res = await this.pool.query<TaskRow>(
      `insert into vehicles.maintenance_tasks
         (vehicle_id, title, interval_km, interval_months, due_at_km, due_date)
       values ($1,$2,$3,$4,$5,$6) returning ${T_COLS}`,
      [
        id,
        input.title,
        input.intervalKm ?? null,
        input.intervalMonths ?? null,
        input.dueAtKm ?? null,
        input.dueDate ?? null,
      ],
    );
    return toTask(res.rows[0]);
  }

  async listTasks(id: VehicleId): Promise<MaintenanceTaskDTO[]> {
    const res = await this.pool.query<TaskRow>(
      `select ${T_COLS} from vehicles.maintenance_tasks where vehicle_id = $1 order by created_at desc`,
      [id],
    );
    return res.rows.map(toTask);
  }

  async listHealth(id: VehicleId): Promise<HealthEntryDTO[]> {
    const res = await this.pool.query<HealthRow>(
      `select id, vehicle_id, system_area, status, note, mileage_km, at
         from vehicles.health_history where vehicle_id = $1 order by at desc`,
      [id],
    );
    return res.rows.map((r) => ({
      id: r.id,
      vehicleId: asId<VehicleId>(r.vehicle_id),
      systemArea: r.system_area,
      status: r.status,
      note: r.note,
      mileageKm: r.mileage_km,
      at: r.at.toISOString().slice(0, 10),
    }));
  }

  /** Flips newly-due tasks to 'due' and emits MaintenanceDue, in one tx (§13). */
  async sweepDue(now: Date): Promise<number> {
    return this.tx(async (c) => {
      const res = await c.query<
        TaskRow & { owner_account_id: string; mileage_km: number | null }
      >(
        `select t.id, t.vehicle_id, t.title, t.interval_km, t.interval_months,
                t.due_at_km, t.due_date, t.status, t.created_at,
                v.owner_account_id, v.mileage_km
           from vehicles.maintenance_tasks t
           join vehicles.vehicles v on v.id = t.vehicle_id
          where t.status = 'pending'
          for update of t skip locked`,
      );
      const due = res.rows.filter((r) =>
        isMaintenanceDue(
          {
            dueAtKm: r.due_at_km,
            dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
            status: 'pending',
          },
          { mileageKm: r.mileage_km, now },
        ),
      );
      if (due.length === 0) return 0;
      await c.query(
        `update vehicles.maintenance_tasks set status = 'due', last_reminded_at = now()
          where id = any($1::uuid[])`,
        [due.map((d) => d.id)],
      );
      await this.outbox.appendWith(
        c,
        due.map((d) =>
          makeEvent({
            type: MAINTENANCE_DUE,
            aggregateId: asId<Uuid>(d.vehicle_id),
            payload: {
              taskId: d.id,
              vehicleId: d.vehicle_id,
              ownerAccountId: d.owner_account_id,
              title: d.title,
            },
          }),
        ),
      );
      return due.length;
    });
  }
}
