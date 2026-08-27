import { Pool } from 'pg';
import { asId, type SupplierId } from '@justgo/kernel';
import type { NearbyQuery, NearbySupplierDTO } from '../contract/dto';

interface NearbyRow {
  supplier_id: string;
  vertical_key: string;
  name: string;
  category_keys: string[];
  distance_m: number;
}

/** All SQL confined to the `discovery` schema (§17.4). */
export class PgDiscoveryRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(input: {
    supplierId: string;
    verticalKey: string;
    name: string;
    lat: number | null;
    lng: number | null;
    categoryKeys: string[];
    isOpen: boolean;
  }): Promise<void> {
    await this.pool.query(
      `insert into discovery.supplier_locations
         (supplier_id, vertical_key, name, geo, category_keys, is_open, updated_at)
       values ($1, $2, $3,
               case when $4::float8 is null then null
                    else ST_SetSRID(ST_MakePoint($5::float8, $4::float8), 4326)::geography end,
               $6, $7, now())
       on conflict (supplier_id) do update set
         vertical_key = excluded.vertical_key,
         name = excluded.name,
         geo = excluded.geo,
         category_keys = excluded.category_keys,
         is_open = excluded.is_open,
         updated_at = now()`,
      [input.supplierId, input.verticalKey, input.name, input.lat, input.lng, input.categoryKeys, input.isOpen],
    );
  }

  /**
   * Distance-ranked nearby search (§16 geo target). ST_DWithin uses the GIST
   * index to bound the candidate set, then ST_Distance orders by real metres.
   */
  async nearby(q: NearbyQuery, radiusM: number, limit: number): Promise<NearbySupplierDTO[]> {
    const res = await this.pool.query<NearbyRow>(
      `with ref as (
         select ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography as g
       )
       select l.supplier_id, l.vertical_key, l.name, l.category_keys,
              ST_Distance(l.geo, ref.g) as distance_m
         from discovery.supplier_locations l, ref
        where l.is_open
          and l.geo is not null
          and ST_DWithin(l.geo, ref.g, $3::float8)
          and ($4::text[] is null or l.vertical_key = any($4))
          and ($5::text is null or $5 = any(l.category_keys))
        order by distance_m asc
        limit $6`,
      [
        q.lng,
        q.lat,
        radiusM,
        q.verticalKeys && q.verticalKeys.length > 0 ? q.verticalKeys : null,
        q.categoryKey ?? null,
        limit,
      ],
    );
    return res.rows.map((r) => ({
      supplierId: asId<SupplierId>(r.supplier_id),
      verticalKey: r.vertical_key,
      name: r.name,
      categoryKeys: r.category_keys,
      distanceM: Math.round(Number(r.distance_m)),
    }));
  }
}
