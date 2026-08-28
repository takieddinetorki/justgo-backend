import { Pool, type PoolClient } from 'pg';
import {
  asId,
  BusinessRuleError,
  NotFoundError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import type { CreateListingDTO, ListingDTO, ListingQuery, ListingStatus } from '../contract/dto';
import { BUYER_CONTACTED, LISTING_PUBLISHED } from '../contract/events';

interface Row {
  id: string;
  seller_account_id: string;
  supplier_id: string | null;
  title: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  mileage_km: number | null;
  amount_minor: string | null;
  currency: string | null;
  description: string | null;
  photo_urls: string[];
  city: string | null;
  country: string | null;
  status: string;
  created_at: Date;
}

const COLS = `id, seller_account_id, supplier_id, title, brand, model, year, mileage_km,
  amount_minor, currency, description, photo_urls, city, country, status, created_at`;

function toDTO(r: Row): ListingDTO {
  const amountMinor = r.amount_minor === null ? null : Number(r.amount_minor);
  return {
    id: r.id,
    sellerAccountId: asId<AccountId>(r.seller_account_id),
    supplierId: r.supplier_id ? asId<SupplierId>(r.supplier_id) : null,
    title: r.title,
    brand: r.brand,
    model: r.model,
    year: r.year,
    mileageKm: r.mileage_km,
    amount: amountMinor !== null && r.currency ? { amountMinor, currency: r.currency } : null,
    description: r.description,
    photoUrls: r.photo_urls,
    city: r.city,
    country: r.country,
    status: r.status as ListingStatus,
    createdAt: r.created_at.toISOString(),
  };
}

/** All SQL confined to the `marketplace` schema (§17.4). */
export class PgMarketplaceRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'marketplace');
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

  async insert(sellerAccountId: AccountId, input: CreateListingDTO): Promise<ListingDTO> {
    return this.tx(async (c) => {
      const res = await c.query<Row>(
        `insert into marketplace.car_listings
           (seller_account_id, title, brand, model, year, mileage_km, amount_minor, currency,
            description, photo_urls, city, country, geo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 case when $13::float8 is null then null
                      else ST_SetSRID(ST_MakePoint($14::float8, $13::float8), 4326)::geography end)
         returning ${COLS}`,
        [
          sellerAccountId,
          input.title,
          input.brand ?? null,
          input.model ?? null,
          input.year ?? null,
          input.mileageKm ?? null,
          input.amount?.amountMinor ?? null,
          input.amount?.currency ?? null,
          input.description ?? null,
          input.photoUrls ?? [],
          input.city ?? null,
          input.country ?? null,
          input.lat ?? null,
          input.lng ?? null,
        ],
      );
      const dto = toDTO(res.rows[0]);
      await this.outbox.appendWith(c, [
        makeEvent({
          type: LISTING_PUBLISHED,
          aggregateId: asId<Uuid>(dto.id),
          payload: { listingId: dto.id, sellerAccountId, title: dto.title },
        }),
      ]);
      return dto;
    });
  }

  async browse(query: ListingQuery): Promise<ListingDTO[]> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from marketplace.car_listings
        where status = 'published'
          and ($1::text is null or brand ilike $1)
          and ($2::bigint is null or (amount_minor is not null and amount_minor <= $2))
        order by created_at desc limit $3`,
      [query.brand ? `%${query.brand}%` : null, query.maxAmountMinor ?? null, Math.min(query.limit ?? 50, 200)],
    );
    return res.rows.map(toDTO);
  }

  async find(listingId: string): Promise<ListingDTO> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from marketplace.car_listings where id = $1`,
      [listingId],
    );
    if (!res.rows[0]) throw new NotFoundError('Listing', listingId);
    return toDTO(res.rows[0]);
  }

  async contact(buyerAccountId: AccountId, listingId: string, message: string | undefined): Promise<void> {
    await this.tx(async (c) => {
      const listing = await c.query<Row>(
        `select ${COLS} from marketplace.car_listings where id = $1 and status = 'published'`,
        [listingId],
      );
      if (!listing.rows[0]) throw new NotFoundError('Listing', listingId);
      if (listing.rows[0].seller_account_id === buyerAccountId) {
        throw new BusinessRuleError('CANNOT_CONTACT_OWN_LISTING', 'You cannot contact your own listing');
      }
      const inserted = await c.query(
        `insert into marketplace.listing_contacts (listing_id, buyer_account_id, message)
         values ($1,$2,$3) on conflict (listing_id, buyer_account_id) do nothing returning id`,
        [listingId, buyerAccountId, message ?? null],
      );
      if (inserted.rows[0]) {
        await this.outbox.appendWith(c, [
          makeEvent({
            type: BUYER_CONTACTED,
            aggregateId: asId<Uuid>(listingId),
            payload: {
              listingId,
              sellerAccountId: listing.rows[0].seller_account_id,
              buyerAccountId,
            },
          }),
        ]);
      }
    });
  }

  async withdraw(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO> {
    const res = await this.pool.query<Row>(
      `update marketplace.car_listings set status = 'withdrawn', updated_at = now()
        where id = $1 and seller_account_id = $2 returning ${COLS}`,
      [listingId, sellerAccountId],
    );
    if (!res.rows[0]) throw new NotFoundError('Listing', listingId);
    return toDTO(res.rows[0]);
  }
}
