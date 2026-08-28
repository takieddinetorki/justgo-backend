import { Pool, type PoolClient } from 'pg';
import {
  asId,
  ForbiddenError,
  NotFoundError,
  type AccountId,
  type SupplierId,
  type Uuid,
  type VehicleId,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import type {
  AssistanceRequestDTO,
  AssistanceServiceType,
  AssistanceStatus,
  CreateAssistanceDTO,
} from '../contract/dto';
import { ASSISTANCE_REQUESTED, ASSISTANCE_STATUS_CHANGED } from '../contract/events';
import { assertAssistanceTransition } from '../domain/assistance-state';

interface Row {
  id: string;
  client_account_id: string;
  vehicle_id: string | null;
  service_type: string;
  description: string | null;
  lng: number;
  lat: number;
  pickup_address: string | null;
  assigned_supplier_id: string | null;
  status: string;
  created_at: Date;
}

const SELECT = `select id, client_account_id, vehicle_id, service_type, description,
  ST_X(pickup_geo::geometry) as lng, ST_Y(pickup_geo::geometry) as lat,
  pickup_address, assigned_supplier_id, status, created_at
  from assistance.assistance_requests`;

function toDTO(r: Row): AssistanceRequestDTO {
  return {
    id: r.id,
    clientAccountId: asId<AccountId>(r.client_account_id),
    vehicleId: r.vehicle_id ? asId<VehicleId>(r.vehicle_id) : null,
    serviceType: r.service_type as AssistanceServiceType,
    description: r.description,
    lat: Number(r.lat),
    lng: Number(r.lng),
    pickupAddress: r.pickup_address,
    assignedSupplierId: r.assigned_supplier_id ? asId<SupplierId>(r.assigned_supplier_id) : null,
    status: r.status as AssistanceStatus,
    createdAt: r.created_at.toISOString(),
  };
}

/** All SQL confined to the `assistance` schema (§17.4). */
export class PgAssistanceRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'assistance');
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

  async create(clientAccountId: AccountId, input: CreateAssistanceDTO): Promise<AssistanceRequestDTO> {
    return this.tx(async (c) => {
      const res = await c.query<Row>(
        `with inserted as (
           insert into assistance.assistance_requests
             (client_account_id, vehicle_id, service_type, description, pickup_geo, pickup_address)
           values ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5::float8, $6::float8), 4326)::geography, $7)
           returning *
         )
         select id, client_account_id, vehicle_id, service_type, description,
                ST_X(pickup_geo::geometry) as lng, ST_Y(pickup_geo::geometry) as lat,
                pickup_address, assigned_supplier_id, status, created_at
         from inserted`,
        [
          clientAccountId,
          input.vehicleId ?? null,
          input.serviceType,
          input.description ?? null,
          input.lng,
          input.lat,
          input.pickupAddress ?? null,
        ],
      );
      const dto = toDTO(res.rows[0]);
      await this.outbox.appendWith(c, [
        makeEvent({
          type: ASSISTANCE_REQUESTED,
          aggregateId: asId<Uuid>(dto.id),
          payload: {
            assistanceId: dto.id,
            clientAccountId,
            serviceType: dto.serviceType,
            lat: dto.lat,
            lng: dto.lng,
          },
        }),
      ]);
      return dto;
    });
  }

  async listForClient(clientAccountId: AccountId, limit: number): Promise<AssistanceRequestDTO[]> {
    const res = await this.pool.query<Row>(
      `${SELECT} where client_account_id = $1 order by created_at desc limit $2`,
      [clientAccountId, limit],
    );
    return res.rows.map(toDTO);
  }

  /**
   * Guarded transition. `assignTo` claims an unassigned request for a
   * supplier (dispatch accept); otherwise the actor must already own/serve it.
   */
  async transition(
    id: string,
    next: AssistanceStatus,
    actor: { clientAccountId?: AccountId; supplierId?: SupplierId; assign?: boolean },
  ): Promise<AssistanceRequestDTO> {
    return this.tx(async (c) => {
      const cur = await c.query<Row>(`${SELECT} where id = $1 for update`, [id]);
      const row = cur.rows[0];
      if (!row) throw new NotFoundError('AssistanceRequest', id);
      if (actor.clientAccountId && row.client_account_id !== actor.clientAccountId) {
        throw new NotFoundError('AssistanceRequest', id);
      }
      if (actor.supplierId && !actor.assign && row.assigned_supplier_id !== actor.supplierId) {
        throw new ForbiddenError('This request is assigned to another supplier');
      }

      const from = row.status as AssistanceStatus;
      assertAssistanceTransition(from, next);

      const res = await c.query<Row>(
        `with updated as (
           update assistance.assistance_requests
              set status = $2,
                  assigned_supplier_id = coalesce($3, assigned_supplier_id),
                  updated_at = now()
            where id = $1 returning *
         )
         select id, client_account_id, vehicle_id, service_type, description,
                ST_X(pickup_geo::geometry) as lng, ST_Y(pickup_geo::geometry) as lat,
                pickup_address, assigned_supplier_id, status, created_at
         from updated`,
        [id, next, actor.assign ? (actor.supplierId ?? null) : null],
      );
      const dto = toDTO(res.rows[0]);
      await this.outbox.appendWith(c, [
        makeEvent({
          type: ASSISTANCE_STATUS_CHANGED,
          aggregateId: asId<Uuid>(id),
          payload: {
            assistanceId: id,
            clientAccountId: row.client_account_id,
            assignedSupplierId: dto.assignedSupplierId,
            from,
            to: next,
          },
        }),
      ]);
      return dto;
    });
  }
}
