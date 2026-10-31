import { Pool, type PoolClient } from 'pg';
import { asId, type SupplierId, type Uuid } from '@justgo/kernel';
import type {
  BranchDTO,
  CreateBranchDTO,
  OpeningHoursDTO,
  UpdateBranchDTO,
} from '../contract/dto';

interface BranchRow {
  id: string;
  supplier_id: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  is_open: boolean;
  hours: OpeningHoursDTO | null;
  closed_at: Date | null;
  created_at: Date;
  lat: number | null;
  lng: number | null;
}

const BRANCH_COLS = `id, supplier_id, name, address, city, country, phone,
  is_open, hours, closed_at, created_at,
  ST_Y(geo::geometry) as lat, ST_X(geo::geometry) as lng`;

function toDTO(row: BranchRow): BranchDTO {
  return {
    id: asId<Uuid>(row.id),
    supplierId: asId<SupplierId>(row.supplier_id),
    name: row.name,
    address: row.address,
    city: row.city,
    country: row.country,
    phone: row.phone,
    isOpen: row.is_open,
    hours: row.hours,
    lat: row.lat,
    lng: row.lng,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** All SQL confined to the `suppliers` schema (§17.4). */
export class PgBranchesRepository {
  constructor(private readonly pool: Pool) {}

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

  /**
   * `is_multi_branch` is DERIVED, in the same transaction as the change that
   * decides it.
   *
   * It used to be a flag the supplier set about itself at registration,
   * which nothing ever checked and nothing kept true. Two sources for one
   * fact means every screen has to pick which to believe; there is now one.
   */
  private async syncMultiBranch(client: PoolClient, supplierId: SupplierId): Promise<void> {
    await client.query(
      `update suppliers.suppliers s
          set is_multi_branch = exists (
                select 1 from suppliers.branches b
                 where b.supplier_id = s.id and b.closed_at is null
              ),
              updated_at = now()
        where s.id = $1`,
      [supplierId],
    );
  }

  async list(supplierId: SupplierId, includeClosed = false): Promise<BranchDTO[]> {
    const res = await this.pool.query<BranchRow>(
      `select ${BRANCH_COLS} from suppliers.branches
        where supplier_id = $1 ${includeClosed ? '' : 'and closed_at is null'}
        order by created_at, id`,
      [supplierId],
    );
    return res.rows.map(toDTO);
  }

  async create(supplierId: SupplierId, input: CreateBranchDTO): Promise<BranchDTO> {
    return this.tx(async (client) => {
      const res = await client.query<BranchRow>(
        `insert into suppliers.branches
           (supplier_id, name, address, city, country, phone, is_open, hours, geo)
         values ($1, $2, $3, $4, $5, $6, coalesce($7, true), $8::jsonb,
                 case when $9::float8 is null then null
                      else ST_SetSRID(ST_MakePoint($10::float8, $9::float8), 4326)::geography end)
         returning ${BRANCH_COLS}`,
        [
          supplierId,
          input.name,
          input.address ?? null,
          input.city ?? null,
          input.country ?? null,
          input.phone ?? null,
          input.isOpen ?? null,
          input.hours ?? null,
          input.lat ?? null,
          input.lng ?? null,
        ],
      );
      await this.syncMultiBranch(client, supplierId);
      return toDTO(res.rows[0]);
    });
  }

  /**
   * Owner-scoped by construction: `supplier_id` is in the WHERE, so a branch
   * belonging to somebody else is not "forbidden", it simply does not exist
   * as far as this caller is concerned — which is the right answer, because
   * a 403 would confirm the id is real.
   */
  async update(
    supplierId: SupplierId,
    branchId: Uuid,
    patch: UpdateBranchDTO,
  ): Promise<BranchDTO | null> {
    const sets: string[] = [];
    const params: unknown[] = [branchId, supplierId];
    const put = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };

    if (patch.name !== undefined) put('name', patch.name);
    if (patch.address !== undefined) put('address', patch.address);
    if (patch.city !== undefined) put('city', patch.city);
    if (patch.country !== undefined) put('country', patch.country);
    if (patch.phone !== undefined) put('phone', patch.phone);
    if (patch.isOpen !== undefined) put('is_open', patch.isOpen);
    if (patch.hours !== undefined) put('hours', patch.hours, '::jsonb');
    if (patch.lat !== undefined) {
      params.push(patch.lat, patch.lng);
      sets.push(
        `geo = case when $${params.length - 1}::float8 is null then null
                    else ST_SetSRID(ST_MakePoint($${params.length}::float8,
                                                 $${params.length - 1}::float8), 4326)::geography end`,
      );
    }

    const res = await this.pool.query<BranchRow>(
      sets.length === 0
        ? `select ${BRANCH_COLS} from suppliers.branches where id = $1 and supplier_id = $2`
        : `update suppliers.branches
              set ${sets.join(', ')}, updated_at = now()
            where id = $1 and supplier_id = $2 and closed_at is null
            returning ${BRANCH_COLS}`,
      params,
    );
    return res.rows[0] ? toDTO(res.rows[0]) : null;
  }

  /**
   * Soft close. A session token minted earlier can already carry this branch
   * id, and products reference it; deleting the row would leave both
   * pointing at nothing.
   */
  async close(supplierId: SupplierId, branchId: Uuid): Promise<BranchDTO | null> {
    return this.tx(async (client) => {
      const res = await client.query<BranchRow>(
        `update suppliers.branches
            set closed_at = coalesce(closed_at, now()), is_open = false, updated_at = now()
          where id = $1 and supplier_id = $2
          returning ${BRANCH_COLS}`,
        [branchId, supplierId],
      );
      const row = res.rows[0];
      if (!row) return null;
      await this.syncMultiBranch(client, supplierId);
      return toDTO(row);
    });
  }
}
