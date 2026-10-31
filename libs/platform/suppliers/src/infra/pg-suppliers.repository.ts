import { Pool, type PoolClient } from 'pg';
import { asId, ConflictError, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { SUPPLIER_REGISTERED, SUPPLIER_UPDATED } from '../contract/events';
import type {
  RegisterSupplierDTO,
  SetVerificationDTO,
  SupplierDTO,
  UpdateSupplierProfileDTO,
} from '../contract/dto';
import {
  SUPPLIER_COLS,
  toSupplierDTO,
  toUpdatedEvent,
  type SupplierRow,
} from './supplier-row';

const SELECT = `select ${SUPPLIER_COLS} from suppliers.suppliers`;

export class PgSuppliersRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'suppliers');
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

  /** The one place `suppliers.SupplierUpdated` is written (§17.2: same tx). */
  private async announce(
    client: PoolClient,
    row: SupplierRow,
    categoryKeys?: string[],
  ): Promise<void> {
    await this.outbox.appendWith(client, [
      makeEvent({
        type: SUPPLIER_UPDATED,
        aggregateId: asId<Uuid>(row.id),
        payload: toUpdatedEvent(row, categoryKeys),
      }),
    ]);
  }

  async insert(
    ownerAccountId: AccountId,
    input: RegisterSupplierDTO,
    enrich: { categoryKeys: string[] } = { categoryKeys: [] },
  ): Promise<SupplierDTO> {
    return this.tx(async (client) => {
      const res = await client.query<SupplierRow>(
        `insert into suppliers.suppliers
           (owner_account_id, vertical_key, name, city, country, geo, profile)
         values ($1, $2, $3, $4, $5,
                 case when $6::float8 is null then null
                      else ST_SetSRID(ST_MakePoint($7::float8, $6::float8), 4326)::geography end,
                 $8)
         returning ${SUPPLIER_COLS}`,
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
      const row = res.rows[0];
      await this.outbox.appendWith(client, [
        makeEvent({
          type: SUPPLIER_REGISTERED,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            supplierId: row.id,
            ownerAccountId,
            verticalKey: row.vertical_key,
            name: row.name,
            lat: input.lat ?? null,
            lng: input.lng ?? null,
            categoryKeys: enrich.categoryKeys,
            city: input.city ?? null,
            country: input.country ?? null,
          },
        }),
      ]);
      return toSupplierDTO(row);
    });
  }

  async findById(id: SupplierId): Promise<SupplierDTO | null> {
    const res = await this.pool.query<SupplierRow>(`${SELECT} where id = $1`, [id]);
    return res.rows[0] ? toSupplierDTO(res.rows[0]) : null;
  }

  /** The ops read: the same row, plus the internal verification note. */
  async findByIdAsAdmin(id: SupplierId): Promise<SupplierDTO | null> {
    const res = await this.pool.query<SupplierRow>(`${SELECT} where id = $1`, [id]);
    return res.rows[0] ? toSupplierDTO(res.rows[0], true) : null;
  }

  async findByOwner(ownerAccountId: AccountId): Promise<SupplierDTO | null> {
    const res = await this.pool.query<SupplierRow>(
      `${SELECT} where owner_account_id = $1 order by created_at limit 1`,
      [ownerAccountId],
    );
    return res.rows[0] ? toSupplierDTO(res.rows[0]) : null;
  }

  /**
   * Phase 1 matching (§21.1 seam): open suppliers in the given verticals;
   * when a category is known, prefer suppliers stocking it but never exclude
   * a vertical entirely because it has no product rows yet.
   *
   * A CLOSED business is excluded outright — `is_open` can be false for a
   * Sunday, but `closed_at` means there is nobody left to answer.
   */
  async eligibleForPartRequest(
    verticalKeys: string[],
    categoryKey: string | null,
  ): Promise<SupplierId[]> {
    if (verticalKeys.length === 0) return [];
    const res = await this.pool.query<{ id: string }>(
      `select s.id
         from suppliers.suppliers s
        where s.is_open and s.closed_at is null and s.vertical_key = any($1)
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
   * Everything a business may change about itself except the fiscal block.
   *
   * Built as a set-list from the keys actually present, NOT as a COALESCE
   * over every column. The fiscal patch can coalesce because none of its
   * fields may ever be blanked — an invoice needs all of them — but a
   * description, a phone number or a cover photo must be clearable, and
   * `coalesce($2, description)` cannot tell "leave it" from "remove it".
   * `null` clears; absent leaves alone.
   */
  async updateProfile(
    id: SupplierId,
    patch: UpdateSupplierProfileDTO,
    enrich: { categoryKeys?: string[] } = {},
  ): Promise<SupplierDTO | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const put = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };

    if (patch.name !== undefined) put('name', patch.name);
    if (patch.description !== undefined) put('description', patch.description);
    if (patch.phone !== undefined) put('phone', patch.phone);
    if (patch.email !== undefined) put('email', patch.email);
    if (patch.city !== undefined) put('city', patch.city);
    if (patch.country !== undefined) put('country', patch.country);
    if (patch.address !== undefined) put('address', patch.address);
    if (patch.isOpen !== undefined) put('is_open', patch.isOpen);
    if (patch.hours !== undefined) put('hours', patch.hours, '::jsonb');
    if (patch.profile !== undefined) put('profile', patch.profile, '::jsonb');
    if (patch.logo !== undefined) {
      put('logo_bucket', patch.logo?.bucket ?? null);
      put('logo_path', patch.logo?.path ?? null);
    }
    if (patch.cover !== undefined) {
      put('cover_bucket', patch.cover?.bucket ?? null);
      put('cover_path', patch.cover?.path ?? null);
    }
    /*
      lat and lng move together or not at all — the controller refuses one
      without the other — so a single `geo` assignment covers both, and
      sending them as null is how a business drops its pin.
    */
    if (patch.lat !== undefined) {
      params.push(patch.lat, patch.lng);
      sets.push(
        `geo = case when $${params.length - 1}::float8 is null then null
                    else ST_SetSRID(ST_MakePoint($${params.length}::float8,
                                                 $${params.length - 1}::float8), 4326)::geography end`,
      );
    }

    return this.tx(async (client) => {
      // Nothing to change is not an error — a client replaying a PATCH gets
      // the current row rather than a 400 it cannot act on.
      const res = await client.query<SupplierRow>(
        sets.length === 0
          ? `${SELECT} where id = $1`
          : `update suppliers.suppliers
                set ${sets.join(', ')}, updated_at = now()
              where id = $1
              returning ${SUPPLIER_COLS}`,
        params,
      );
      const row = res.rows[0];
      if (!row) return null;
      if (sets.length > 0) await this.announce(client, row, enrich.categoryKeys);
      return toSupplierDTO(row);
    });
  }

  /**
   * Close the business for good.
   *
   * `is_open` goes false in the same statement, because every public read —
   * discovery, the directory, the RLS policy on this table — filters on it,
   * and a closed business that is still "open right now" would keep
   * appearing in search results nobody can act on.
   */
  async close(id: SupplierId): Promise<SupplierDTO | null> {
    return this.tx(async (client) => {
      const res = await client.query<SupplierRow>(
        `update suppliers.suppliers
            set closed_at = coalesce(closed_at, now()), is_open = false, updated_at = now()
          where id = $1
          returning ${SUPPLIER_COLS}`,
        [id],
      );
      const row = res.rows[0];
      if (!row) return null;
      await this.announce(client, row);
      return toSupplierDTO(row);
    });
  }

  /** Award or withdraw the badge. Ops only — see the controller. */
  async setVerification(
    id: SupplierId,
    input: SetVerificationDTO,
    decidedByAccountId: AccountId,
  ): Promise<SupplierDTO | null> {
    return this.tx(async (client) => {
      const res = await client.query<SupplierRow>(
        `update suppliers.suppliers
            set verified_at = case when $2::boolean then coalesce(verified_at, now()) else null end,
                verified_by_account_id = $3,
                verification_note = $4,
                updated_at = now()
          where id = $1
          returning ${SUPPLIER_COLS}`,
        [id, input.verified, decidedByAccountId, input.note ?? null],
      );
      const row = res.rows[0];
      if (!row) return null;
      await this.announce(client, row);
      // The decision itself is an ops read: it may see its own note.
      return toSupplierDTO(row, true);
    });
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
    try {
      return await this.applyFiscalIdentity(id, patch);
    } catch (error) {
      /*
        A NIF or an RC already belongs to another supplier.

        This surfaced as a bare 500 with a Postgres constraint name in the
        log and nothing an app could act on. It is a business condition, not
        a bug: fiscal identifiers are unique per company by law, so a
        collision means either a typo or an attempt to invoice under someone
        else's registration. Either way the user needs to be told which
        field, and a 500 tells them to try again later.
      */
      const message = error instanceof Error ? error.message : String(error);
      const field = message.includes('suppliers_nif_unique')
        ? 'nif'
        : message.includes('suppliers_rc_unique')
          ? 'rc'
          : null;
      if (!field) throw error;
      throw new ConflictError(
        'FISCAL_IDENTIFIER_TAKEN',
        `That ${field.toUpperCase()} is already registered to another supplier`,
        { field },
      );
    }
  }

  private async applyFiscalIdentity(
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
         tax_article = coalesce($7, tax_article),
         updated_at  = now()
       where id = $1
       returning ${SUPPLIER_COLS}`,
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
    return res.rows[0] ? toSupplierDTO(res.rows[0]) : null;
  }
}
