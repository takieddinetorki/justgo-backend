import { Pool, type PoolClient } from 'pg';
import {
  asId,
  ConflictError,
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
import {
  ASSISTANCE_CHARGED,
  ASSISTANCE_REQUESTED,
  ASSISTANCE_STATUS_CHANGED,
} from '../contract/events';
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
  amount_minor: string | null;
  currency: string | null;
  charged_at: Date | null;
}

const SELECT = `select id, client_account_id, vehicle_id, service_type, description,
  ST_X(pickup_geo::geometry) as lng, ST_Y(pickup_geo::geometry) as lat,
  pickup_address, assigned_supplier_id, status, created_at,
  amount_minor, currency, charged_at
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
    amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
    currency: r.currency,
    chargedAt: r.charged_at ? r.charged_at.toISOString() : null,
  };
}

/**
 * The money half of a finished call-out, for AssistanceCharged.
 *
 * Built from the UPDATED row, so the facture is issued from what the
 * database holds rather than from what the caller sent.
 */
function chargedPayload(r: Row): Record<string, unknown> {
  return {
    assistanceId: r.id,
    clientAccountId: r.client_account_id,
    supplierId: r.assigned_supplier_id,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    serviceType: r.service_type,
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
   * State what a finished call-out cost.
   *
   * Write-once, for the same reason as a reservation's: the facture is
   * sealed and in the customer's hands the moment it is issued, so
   * re-pricing underneath it would leave two different truths about one
   * supply. A repeat of the same figure is accepted silently so a retry
   * is harmless; a different figure is a credit note's job.
   */
  async charge(
    supplierId: SupplierId,
    id: string,
    input: { amountMinor: number; currency: string },
  ): Promise<AssistanceRequestDTO> {
    return this.tx(async (c) => {
      const cur = await c.query<Row>(`${SELECT} where id = $1 for update`, [id]);
      const row = cur.rows[0];
      if (!row) throw new NotFoundError('AssistanceRequest', id);
      if (row.assigned_supplier_id !== supplierId) {
        throw new ForbiddenError('This request is assigned to another supplier');
      }
      if (row.status !== 'completed') {
        throw new ConflictError(
          'ASSISTANCE_NOT_COMPLETED',
          'A call-out can only be charged once it is completed',
          { status: row.status },
        );
      }
      if (row.amount_minor !== null) {
        if (Number(row.amount_minor) === input.amountMinor && row.currency === input.currency) {
          return toDTO(row);
        }
        throw new ConflictError(
          'ALREADY_CHARGED',
          'This call-out has already been charged; issue a credit note to correct it',
          { amountMinor: Number(row.amount_minor), currency: row.currency },
        );
      }

      const res = await c.query<Row>(
        `with updated as (
           update assistance.assistance_requests
              set amount_minor = $2, currency = $3, charged_at = now(), updated_at = now()
            where id = $1 returning *
         )
         select id, client_account_id, vehicle_id, service_type, description,
                ST_X(pickup_geo::geometry) as lng, ST_Y(pickup_geo::geometry) as lat,
                pickup_address, assigned_supplier_id, status, created_at,
                amount_minor, currency, charged_at
         from updated`,
        [id, input.amountMinor, input.currency],
      );

      if (input.amountMinor > 0) {
        await this.outbox.appendWith(c, [
          makeEvent({
            type: ASSISTANCE_CHARGED,
            aggregateId: asId<Uuid>(id),
            payload: chargedPayload(res.rows[0]),
          }),
        ]);
      }
      return toDTO(res.rows[0]);
    });
  }

  /**
   * Guarded transition. `assignTo` claims an unassigned request for a
   * supplier (dispatch accept); otherwise the actor must already own/serve it.
   */
  async transition(
    id: string,
    next: AssistanceStatus,
    actor: { clientAccountId?: AccountId; supplierId?: SupplierId; assign?: boolean },
    /** What the call-out cost. Only meaningful on the way to `completed`. */
    charge?: { amountMinor: number; currency: string },
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
                  amount_minor = coalesce($4, amount_minor),
                  currency = coalesce($5, currency),
                  charged_at = case when $4 is null then charged_at else now() end,
                  updated_at = now()
            where id = $1 returning *
         )
         select id, client_account_id, vehicle_id, service_type, description,
                ST_X(pickup_geo::geometry) as lng, ST_Y(pickup_geo::geometry) as lat,
                pickup_address, assigned_supplier_id, status, created_at,
                amount_minor, currency, charged_at
         from updated`,
        [
          id,
          next,
          actor.assign ? (actor.supplierId ?? null) : null,
          charge?.amountMinor ?? null,
          charge?.currency ?? null,
        ],
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
        /*
          Money is its own event. A tow that was completed and a tow that
          was PAID FOR are different facts, and `documents` only cares
          about the second one.
        */
        ...(charge && charge.amountMinor > 0
          ? [
              makeEvent({
                type: ASSISTANCE_CHARGED,
                aggregateId: asId<Uuid>(id),
                payload: chargedPayload(res.rows[0]),
              }),
            ]
          : []),
      ]);
      return dto;
    });
  }
}
