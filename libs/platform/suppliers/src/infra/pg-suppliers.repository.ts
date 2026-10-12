import { Pool } from 'pg';
import { asId, type AccountId, type SupplierId } from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { SUPPLIER_REGISTERED } from '../contract/events';
import type { RegisterSupplierDTO, SupplierDTO } from '../contract/dto';

interface SupplierRow {
  id: string;
  owner_account_id: string;
  vertical_key: string;
  name: string;
  is_open: boolean;
  is_multi_branch: boolean;
  city: string | null;
  country: string | null;
  address: string | null;
  legal_name: string | null;
  nif: string | null;
  nis: string | null;
  rc: string | null;
  tax_article: string | null;
  created_at: Date;
}

function toDTO(row: SupplierRow): SupplierDTO {
  return {
    id: asId<SupplierId>(row.id),
    ownerAccountId: asId<AccountId>(row.owner_account_id),
    verticalKey: row.vertical_key,
    name: row.name,
    isOpen: row.is_open,
    isMultiBranch: row.is_multi_branch,
    city: row.city,
    country: row.country,
    address: row.address,
    legalName: row.legal_name,
    nif: row.nif,
    nis: row.nis,
    rc: row.rc,
    taxArticle: row.tax_article,
    createdAt: row.created_at.toISOString(),
  };
}

const SELECT = `select id, owner_account_id, vertical_key, name, is_open,
  is_multi_branch, city, country, address, legal_name, nif, nis, tax_article, rc,
  created_at from suppliers.suppliers`;

export class PgSuppliersRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'suppliers');
  }

  async insert(
    ownerAccountId: AccountId,
    input: RegisterSupplierDTO,
    enrich: { categoryKeys: string[] } = { categoryKeys: [] },
  ): Promise<SupplierDTO> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query<SupplierRow>(
        `insert into suppliers.suppliers
           (owner_account_id, vertical_key, name, city, country, geo, profile)
         values ($1, $2, $3, $4, $5,
                 case when $6::float8 is null then null
                      else ST_SetSRID(ST_MakePoint($7::float8, $6::float8), 4326)::geography end,
                 $8)
         returning id, owner_account_id, vertical_key, name, is_open,
                   is_multi_branch, city, country, address, legal_name, nif, nis,
                   tax_article, rc, created_at`,
        [
          ownerAccountId,
          input.verticalKey,
          input.name,
          input.city ?? null,
          input.country ?? null,
          input.lat ?? null,
          input.lng ?? null,
          input.profile ?? {},
        ],
      );
      const supplier = toDTO(res.rows[0]);
      await this.outbox.appendWith(client, [
        makeEvent({
          type: SUPPLIER_REGISTERED,
          aggregateId: supplier.id,
          payload: {
            supplierId: supplier.id,
            ownerAccountId,
            verticalKey: supplier.verticalKey,
            name: supplier.name,
            lat: input.lat ?? null,
            lng: input.lng ?? null,
            categoryKeys: enrich.categoryKeys,
            city: input.city ?? null,
            country: input.country ?? null,
          },
        }),
      ]);
      await client.query('commit');
      return supplier;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: SupplierId): Promise<SupplierDTO | null> {
    const res = await this.pool.query<SupplierRow>(`${SELECT} where id = $1`, [id]);
    return res.rows[0] ? toDTO(res.rows[0]) : null;
  }

  async findByOwner(ownerAccountId: AccountId): Promise<SupplierDTO | null> {
    const res = await this.pool.query<SupplierRow>(
      `${SELECT} where owner_account_id = $1 order by created_at limit 1`,
      [ownerAccountId],
    );
    return res.rows[0] ? toDTO(res.rows[0]) : null;
  }

  /**
   * Phase 1 matching (§21.1 seam): open suppliers in the given verticals;
   * when a category is known, prefer suppliers stocking it but never exclude
   * a vertical entirely because it has no product rows yet.
   */
  async eligibleForPartRequest(
    verticalKeys: string[],
    categoryKey: string | null,
  ): Promise<SupplierId[]> {
    if (verticalKeys.length === 0) return [];
    const res = await this.pool.query<{ id: string }>(
      `select s.id
         from suppliers.suppliers s
        where s.is_open and s.vertical_key = any($1)
        order by
          case when $2::text is not null and exists (
            select 1 from suppliers.products p
             where p.supplier_id = s.id and p.category_key = $2 and p.quantity > 0
          ) then 0 else 1 end,
          s.created_at`,
      [verticalKeys, categoryKey],
    );
    return res.rows.map((r) => asId<SupplierId>(r.id));
  }

  /**
   * Updates only the fiscal fields, and only those actually supplied.
   * COALESCE rather than a dynamic SQL builder: a partial patch must not
   * blank the identifiers it did not mention, and an invoice depends on
   * all of them being present.
   */
  async updateFiscalIdentity(
    id: string,
    patch: {
      legalName?: string;
      address?: string;
      nif?: string;
      nis?: string;
      rc?: string;
      taxArticle?: string;
    },
  ): Promise<SupplierDTO | null> {
    const res = await this.pool.query<SupplierRow>(
      `update suppliers.suppliers set
         legal_name  = coalesce($2, legal_name),
         address     = coalesce($3, address),
         nif         = coalesce($4, nif),
         nis         = coalesce($5, nis),
         rc          = coalesce($6, rc),
         tax_article = coalesce($7, tax_article)
       where id = $1
       returning id, owner_account_id, vertical_key, name, is_open,
                 is_multi_branch, city, country, address, legal_name, nif, nis,
                 tax_article, rc, created_at`,
      [
        id,
        patch.legalName ?? null,
        patch.address ?? null,
        patch.nif ?? null,
        patch.nis ?? null,
        patch.rc ?? null,
        patch.taxArticle ?? null,
      ],
    );
    return res.rows[0] ? toDTO(res.rows[0]) : null;
  }

}