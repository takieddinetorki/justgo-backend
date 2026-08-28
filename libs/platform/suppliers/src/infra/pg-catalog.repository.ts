import { Pool } from 'pg';
import { asId, NotFoundError, type SupplierId } from '@justgo/kernel';
import type {
  CreateOfferDTO,
  CreateProductDTO,
  ServiceOfferDTO,
  ProductDTO,
  UpdateProductDTO,
} from '../contract/catalog-dto';

interface ProductRow {
  id: string;
  supplier_id: string;
  branch_id: string | null;
  tecdoc_article_id: string | null;
  name: string;
  reference: string | null;
  category_key: string | null;
  amount_minor: string | null;
  currency: string | null;
  quantity: number;
  is_deal: boolean;
  created_at: Date;
}

interface OfferRow {
  id: string;
  supplier_id: string;
  service_type_key: string;
  name: string;
  description: string | null;
  amount_minor: string | null;
  currency: string | null;
  duration_mins: number | null;
  active: boolean;
}

const P_COLS = `id, supplier_id, branch_id, tecdoc_article_id, name, reference, category_key,
  amount_minor, currency, quantity, is_deal, created_at`;
const O_COLS = `id, supplier_id, service_type_key, name, description, amount_minor, currency, duration_mins, active`;

const toInt = (v: string | null): number | null => (v === null ? null : Number(v));

function toProduct(r: ProductRow): ProductDTO {
  const amountMinor = toInt(r.amount_minor);
  return {
    id: r.id,
    supplierId: asId<SupplierId>(r.supplier_id),
    tecdocArticleId: toInt(r.tecdoc_article_id),
    name: r.name,
    reference: r.reference,
    categoryKey: r.category_key,
    amount: amountMinor !== null && r.currency ? { amountMinor, currency: r.currency } : null,
    quantity: r.quantity,
    isDeal: r.is_deal,
    createdAt: r.created_at.toISOString(),
  };
}

function toOffer(r: OfferRow): ServiceOfferDTO {
  const amountMinor = toInt(r.amount_minor);
  return {
    id: r.id,
    supplierId: asId<SupplierId>(r.supplier_id),
    serviceTypeKey: r.service_type_key,
    name: r.name,
    description: r.description,
    amount: amountMinor !== null && r.currency ? { amountMinor, currency: r.currency } : null,
    durationMins: r.duration_mins,
    active: r.active,
  };
}

/** Supplier catalogue writes — products + service offers. All SQL stays in
 *  the `suppliers` schema (§17.4); every write is scoped to the caller's
 *  supplier_id (belt-and-braces with RLS). */
export class PgCatalogRepository {
  constructor(private readonly pool: Pool) {}

  async listProducts(supplierId: SupplierId, dealsOnly: boolean): Promise<ProductDTO[]> {
    const res = await this.pool.query<ProductRow>(
      `select ${P_COLS} from suppliers.products
        where supplier_id = $1 ${dealsOnly ? 'and is_deal' : ''}
        order by created_at desc`,
      [supplierId],
    );
    return res.rows.map(toProduct);
  }

  async createProduct(supplierId: SupplierId, input: CreateProductDTO): Promise<ProductDTO> {
    const res = await this.pool.query<ProductRow>(
      `insert into suppliers.products
         (supplier_id, tecdoc_article_id, name, reference, category_key, amount_minor, currency, quantity, is_deal)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,0),coalesce($9,false)) returning ${P_COLS}`,
      [
        supplierId,
        input.tecdocArticleId ?? null,
        input.name,
        input.reference ?? null,
        input.categoryKey ?? null,
        input.amount?.amountMinor ?? null,
        input.amount?.currency ?? null,
        input.quantity ?? null,
        input.isDeal ?? null,
      ],
    );
    return toProduct(res.rows[0]);
  }

  async updateProduct(supplierId: SupplierId, id: string, patch: UpdateProductDTO): Promise<ProductDTO> {
    const res = await this.pool.query<ProductRow>(
      `update suppliers.products set
         name = coalesce($3, name),
         reference = coalesce($4, reference),
         category_key = coalesce($5, category_key),
         amount_minor = coalesce($6, amount_minor),
         currency = coalesce($7, currency),
         quantity = coalesce($8, quantity),
         is_deal = coalesce($9, is_deal)
       where id = $1 and supplier_id = $2 returning ${P_COLS}`,
      [
        id,
        supplierId,
        patch.name ?? null,
        patch.reference ?? null,
        patch.categoryKey ?? null,
        patch.amount?.amountMinor ?? null,
        patch.amount?.currency ?? null,
        patch.quantity ?? null,
        patch.isDeal ?? null,
      ],
    );
    if (!res.rows[0]) throw new NotFoundError('Product', id);
    return toProduct(res.rows[0]);
  }

  async deleteProduct(supplierId: SupplierId, id: string): Promise<void> {
    const res = await this.pool.query(
      `delete from suppliers.products where id = $1 and supplier_id = $2`,
      [id, supplierId],
    );
    if (res.rowCount === 0) throw new NotFoundError('Product', id);
  }

  async listOffers(supplierId: SupplierId): Promise<ServiceOfferDTO[]> {
    const res = await this.pool.query<OfferRow>(
      `select ${O_COLS} from suppliers.service_offers where supplier_id = $1 order by name`,
      [supplierId],
    );
    return res.rows.map(toOffer);
  }

  async createOffer(supplierId: SupplierId, input: CreateOfferDTO): Promise<ServiceOfferDTO> {
    const res = await this.pool.query<OfferRow>(
      `insert into suppliers.service_offers
         (supplier_id, service_type_key, name, description, amount_minor, currency, duration_mins)
       values ($1,$2,$3,$4,$5,$6,$7) returning ${O_COLS}`,
      [
        supplierId,
        input.serviceTypeKey,
        input.name,
        input.description ?? null,
        input.amount?.amountMinor ?? null,
        input.amount?.currency ?? null,
        input.durationMins ?? null,
      ],
    );
    return toOffer(res.rows[0]);
  }

  async deleteOffer(supplierId: SupplierId, id: string): Promise<void> {
    const res = await this.pool.query(
      `delete from suppliers.service_offers where id = $1 and supplier_id = $2`,
      [id, supplierId],
    );
    if (res.rowCount === 0) throw new NotFoundError('ServiceOffer', id);
  }
}
