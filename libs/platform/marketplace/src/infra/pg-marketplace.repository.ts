import { Pool, type PoolClient } from 'pg';
import {
  asId,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { notifiesSeller, standingOf, type AcceptanceRange } from '../domain/bid-standing';
import type {
  BidDTO,
  BidStanding,
  BidStatus,
  BodyType,
  CreateListingDTO,
  FuelType,
  ListingDTO,
  ListingQuery,
  ListingStatus,
  PlaceBidDTO,
  Transmission,
  VehicleCondition,
} from '../contract/dto';
import {
  BID_ACCEPTED,
  BID_DECLINED,
  BID_PLACED,
  BUYER_CONTACTED,
  LISTING_PUBLISHED,
} from '../contract/events';

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
  fuel_type: string | null;
  transmission: string | null;
  body_type: string | null;
  colour: string | null;
  doors: number | null;
  engine_hp: number | null;
  condition: string | null;
  is_customs_cleared: boolean | null;
  papers_in_order: boolean | null;
  owner_count: number | null;
  accident_free: boolean | null;
  /** Joined from listing_offer_ranges — present only on a seller-scoped read. */
  accepts_offers?: boolean;
  range_min_minor?: string | null;
  range_max_minor?: string | null;
  range_currency?: string | null;
  pending_bid_count?: string;
}

interface BidRow {
  id: string;
  listing_id: string;
  buyer_account_id: string;
  amount_minor: string;
  currency: string;
  message: string | null;
  status: string;
  standing: string;
  decline_reason: string | null;
  decided_at: Date | null;
  created_at: Date;
}

const COLS = `id, seller_account_id, supplier_id, title, brand, model, year, mileage_km,
  amount_minor, currency, description, photo_urls, city, country, status, created_at,
  fuel_type, transmission, body_type, colour, doors, engine_hp, condition,
  is_customs_cleared, papers_in_order, owner_count, accident_free`;

const BID_COLS = `id, listing_id, buyer_account_id, amount_minor, currency, message,
  status, standing, decline_reason, decided_at, created_at`;

/**
 * The PUBLIC shape of a listing.
 *
 * `acceptsOffers` says bidding is open; the range itself is absent. A buyer who
 * learns the floor bids exactly the floor, so the number never leaves the
 * seller's own view — see `toSellerDTO`.
 */
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
    fuelType: r.fuel_type as FuelType | null,
    transmission: r.transmission as Transmission | null,
    bodyType: r.body_type as BodyType | null,
    colour: r.colour,
    doors: r.doors,
    engineHp: r.engine_hp,
    condition: r.condition as VehicleCondition | null,
    isCustomsCleared: r.is_customs_cleared,
    papersInOrder: r.papers_in_order,
    ownerCount: r.owner_count,
    accidentFree: r.accident_free,
    acceptsOffers: r.accepts_offers === true,
  };
}

/** The owner's view: the public shape plus the private range and bid count. */
function toSellerDTO(r: Row): ListingDTO {
  const base = toDTO(r);
  const min = r.range_min_minor == null ? null : Number(r.range_min_minor);
  const max = r.range_max_minor == null ? null : Number(r.range_max_minor);
  const currency = r.range_currency ?? r.currency ?? 'DZD';
  return {
    ...base,
    offerRange:
      min === null
        ? null
        : {
            min: { amountMinor: min, currency },
            max: max === null ? null : { amountMinor: max, currency },
          },
    pendingBidCount: Number(r.pending_bid_count ?? 0),
  };
}

/**
 * `standing` is withheld unless the reader is the seller. Telling a buyer
 * their bid landed `below_range` hands them the floor by bisection: bid, read
 * the standing, halve the interval, repeat.
 */
function toBid(r: BidRow, forSeller: boolean): BidDTO {
  return {
    id: r.id,
    listingId: r.listing_id,
    buyerAccountId: asId<AccountId>(r.buyer_account_id),
    amount: { amountMinor: Number(r.amount_minor), currency: r.currency },
    message: r.message,
    status: r.status as BidStatus,
    ...(forSeller ? { standing: r.standing as BidStanding } : {}),
    declineReason: r.decline_reason,
    decidedAt: r.decided_at?.toISOString() ?? null,
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

  /**
   * `range` arrives already resolved and validated by the service, rather
   * than half-filled on `input`. The currency on a range may be inherited
   * from the asking price, and a repository that had to work that out would
   * be the second place that rule lives.
   */
  async insert(
    sellerAccountId: AccountId,
    input: CreateListingDTO,
    range: AcceptanceRange | null = null,
  ): Promise<ListingDTO> {
    return this.tx(async (c) => {
      const res = await c.query<Row>(
        `insert into marketplace.car_listings
           (seller_account_id, title, brand, model, year, mileage_km, amount_minor, currency,
            description, photo_urls, city, country, geo,
            fuel_type, transmission, body_type, colour, doors, engine_hp, condition,
            is_customs_cleared, papers_in_order, owner_count, accident_free)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 case when $13::float8 is null then null
                      else ST_SetSRID(ST_MakePoint($14::float8, $13::float8), 4326)::geography end,
                 $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
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
          input.fuelType ?? null,
          input.transmission ?? null,
          input.bodyType ?? null,
          input.colour ?? null,
          input.doors ?? null,
          input.engineHp ?? null,
          input.condition ?? null,
          input.isCustomsCleared ?? null,
          input.papersInOrder ?? null,
          input.ownerCount ?? null,
          input.accidentFree ?? null,
        ],
      );
      /*
        The range goes in in the SAME transaction as the listing. A listing
        that exists while its floor does not would be open to bids with
        nothing to judge them against, and every one of them would notify.
      */
      if (range) {
        await c.query(
          `insert into marketplace.listing_offer_ranges
             (listing_id, seller_account_id, min_minor, max_minor, currency)
           values ($1,$2,$3,$4,$5)`,
          [res.rows[0].id, sellerAccountId, range.minMinor, range.maxMinor, range.currency],
        );
      }
      const dto = { ...toDTO(res.rows[0]), acceptsOffers: range !== null };
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

  /**
   * The public browse. Joins the range table only to learn WHETHER offers are
   * open — the amounts are never selected, so they cannot leak through a
   * forgotten column.
   */
  async browse(query: ListingQuery): Promise<ListingDTO[]> {
    const res = await this.pool.query<Row>(
      `select ${COLS.split(',')
        .map((x) => `l.${x.trim()}`)
        .join(', ')},
              (r.listing_id is not null) as accepts_offers
         from marketplace.car_listings l
         left join marketplace.listing_offer_ranges r on r.listing_id = l.id
        where l.status = 'published'
          and ($1::text is null or l.brand ilike $1)
          and ($2::bigint is null or (l.amount_minor is not null and l.amount_minor <= $2))
          and ($3::text is null or l.model ilike $3)
          and ($4::text is null or l.fuel_type = $4)
          and ($5::text is null or l.transmission = $5)
          and ($6::text is null or l.body_type = $6)
          and ($7::text is null or l.condition = $7)
          and ($8::text is null or l.city ilike $8)
          and ($9::int is null or (l.year is not null and l.year >= $9))
          and ($10::int is null or (l.mileage_km is not null and l.mileage_km <= $10))
          and ($11::boolean is null or (r.listing_id is not null) = $11)
        order by l.created_at desc limit $12`,
      [
        query.brand ? `%${query.brand}%` : null,
        query.maxAmountMinor ?? null,
        query.model ? `%${query.model}%` : null,
        query.fuelType ?? null,
        query.transmission ?? null,
        query.bodyType ?? null,
        query.condition ?? null,
        query.city ? `%${query.city}%` : null,
        query.minYear ?? null,
        query.maxMileageKm ?? null,
        query.acceptsOffers ?? null,
        Math.min(query.limit ?? 50, 200),
      ],
    );
    return res.rows.map(toDTO);
  }

  async find(listingId: string): Promise<ListingDTO> {
    const res = await this.pool.query<Row>(
      `select ${COLS.split(',')
        .map((x) => `l.${x.trim()}`)
        .join(', ')},
              (r.listing_id is not null) as accepts_offers
         from marketplace.car_listings l
         left join marketplace.listing_offer_ranges r on r.listing_id = l.id
        where l.id = $1`,
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

  // ── the acceptance range ──────────────────────────────────────────

  /** Read the range for internal use. Never reaches a public response. */
  private async rangeFor(
    c: PoolClient | Pool,
    listingId: string,
  ): Promise<AcceptanceRange | null> {
    const res = await c.query<{ min_minor: string; max_minor: string | null; currency: string }>(
      `select min_minor, max_minor, currency
         from marketplace.listing_offer_ranges where listing_id = $1`,
      [listingId],
    );
    const row = res.rows[0];
    return row
      ? {
          minMinor: Number(row.min_minor),
          maxMinor: row.max_minor === null ? null : Number(row.max_minor),
          currency: row.currency,
        }
      : null;
  }

  async setOfferRange(
    sellerAccountId: AccountId,
    listingId: string,
    range: AcceptanceRange,
  ): Promise<ListingDTO> {
    return this.tx(async (c) => {
      // The ownership check IS the authorisation: a listing that is not
      // theirs is 404 rather than 403, so a stranger cannot confirm it exists.
      const owned = await c.query<{ id: string }>(
        `select id from marketplace.car_listings where id = $1 and seller_account_id = $2`,
        [listingId, sellerAccountId],
      );
      if (!owned.rows[0]) throw new NotFoundError('Listing', listingId);

      await c.query(
        `insert into marketplace.listing_offer_ranges
           (listing_id, seller_account_id, min_minor, max_minor, currency)
         values ($1,$2,$3,$4,$5)
         on conflict (listing_id) do update
           set min_minor = excluded.min_minor,
               max_minor = excluded.max_minor,
               currency  = excluded.currency,
               updated_at = now()`,
        [listingId, sellerAccountId, range.minMinor, range.maxMinor, range.currency],
      );
      return this.findForSeller(c, sellerAccountId, listingId);
    });
  }

  async clearOfferRange(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO> {
    return this.tx(async (c) => {
      const deleted = await c.query(
        `delete from marketplace.listing_offer_ranges
          where listing_id = $1 and seller_account_id = $2 returning listing_id`,
        [listingId, sellerAccountId],
      );
      if (!deleted.rows[0]) {
        // Either it is not theirs or there was no range. Both are 404 here:
        // distinguishing them would tell a stranger a listing exists.
        const owned = await c.query<{ id: string }>(
          `select id from marketplace.car_listings where id = $1 and seller_account_id = $2`,
          [listingId, sellerAccountId],
        );
        if (!owned.rows[0]) throw new NotFoundError('Listing', listingId);
      }
      return this.findForSeller(c, sellerAccountId, listingId);
    });
  }

  private async findForSeller(
    c: PoolClient | Pool,
    sellerAccountId: AccountId,
    listingId: string,
  ): Promise<ListingDTO> {
    const res = await c.query<Row>(
      `select ${COLS.split(',')
        .map((x) => `l.${x.trim()}`)
        .join(', ')},
              (r.listing_id is not null) as accepts_offers,
              r.min_minor as range_min_minor,
              r.max_minor as range_max_minor,
              r.currency  as range_currency,
              (select count(*) from marketplace.listing_bids b
                where b.listing_id = l.id and b.status = 'pending') as pending_bid_count
         from marketplace.car_listings l
         left join marketplace.listing_offer_ranges r on r.listing_id = l.id
        where l.id = $1 and l.seller_account_id = $2`,
      [listingId, sellerAccountId],
    );
    if (!res.rows[0]) throw new NotFoundError('Listing', listingId);
    return toSellerDTO(res.rows[0]);
  }

  async findAsSeller(sellerAccountId: AccountId, listingId: string): Promise<ListingDTO> {
    return this.findForSeller(this.pool, sellerAccountId, listingId);
  }

  // ── bids ──────────────────────────────────────────────────────────

  /**
   * Place a bid, superseding any live bid this buyer already had.
   *
   * The whole thing is one transaction under a row lock on the listing. Two
   * taps arriving together would otherwise both pass the "no live bid" check
   * and the partial unique index would reject the loser with a bare 500; with
   * the lock, the second one supersedes the first cleanly.
   */
  async placeBid(
    buyerAccountId: AccountId,
    listingId: string,
    input: PlaceBidDTO,
  ): Promise<BidDTO> {
    return this.tx(async (c) => {
      const listing = await c.query<Row>(
        `select ${COLS} from marketplace.car_listings
          where id = $1 and status = 'published' for update`,
        [listingId],
      );
      const row = listing.rows[0];
      if (!row) throw new NotFoundError('Listing', listingId);
      if (row.seller_account_id === (buyerAccountId as unknown as string)) {
        throw new BusinessRuleError('CANNOT_BID_ON_OWN_LISTING', 'You cannot bid on your own listing');
      }

      const range = await this.rangeFor(c, listingId);
      if (!range) {
        throw new BusinessRuleError(
          'OFFERS_NOT_ACCEPTED',
          'This listing is not taking offers',
        );
      }
      if (range.currency !== input.amount.currency) {
        throw new BusinessRuleError(
          'CURRENCY_MISMATCH',
          `This listing takes offers in ${range.currency}`,
          { expected: range.currency, received: input.amount.currency },
        );
      }

      /*
        The standing is computed HERE and stored, not derived on read. A seller
        may move their range afterwards, and a bid that was in range when it
        was made does not retroactively stop having been — the notification
        already went out.
      */
      const standing = standingOf(input.amount.amountMinor, range);

      await c.query(
        `update marketplace.listing_bids
            set status = 'superseded', decided_at = now()
          where listing_id = $1 and buyer_account_id = $2 and status = 'pending'`,
        [listingId, buyerAccountId],
      );

      const inserted = await c.query<BidRow>(
        `insert into marketplace.listing_bids
           (listing_id, buyer_account_id, seller_account_id, amount_minor, currency,
            message, standing, range_min_minor, range_max_minor)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning ${BID_COLS}`,
        [
          listingId,
          buyerAccountId,
          row.seller_account_id,
          input.amount.amountMinor,
          input.amount.currency,
          input.message ?? null,
          standing,
          range.minMinor,
          range.maxMinor,
        ],
      );
      const bid = toBid(inserted.rows[0], true);

      await this.outbox.appendWith(c, [
        makeEvent({
          type: BID_PLACED,
          aggregateId: asId<Uuid>(listingId),
          payload: {
            bidId: bid.id,
            listingId,
            listingTitle: row.title,
            sellerAccountId: row.seller_account_id,
            buyerAccountId,
            amountMinor: input.amount.amountMinor,
            currency: input.amount.currency,
            standing,
            notifiesSeller: notifiesSeller(standing),
          },
        }),
      ]);
      return bid;
    });
  }

  async listBids(callerAccountId: AccountId, listingId: string): Promise<BidDTO[]> {
    const listing = await this.pool.query<{ seller_account_id: string }>(
      `select seller_account_id from marketplace.car_listings where id = $1`,
      [listingId],
    );
    if (!listing.rows[0]) throw new NotFoundError('Listing', listingId);
    const isSeller = listing.rows[0].seller_account_id === (callerAccountId as unknown as string);

    // The seller sees every bid, best first; anyone else sees only their own.
    const res = await this.pool.query<BidRow>(
      `select ${BID_COLS} from marketplace.listing_bids
        where listing_id = $1 and ($2::boolean or buyer_account_id = $3)
        order by amount_minor desc, created_at`,
      [listingId, isSeller, callerAccountId],
    );
    return res.rows.map((r) => toBid(r, isSeller));
  }

  async myBids(buyerAccountId: AccountId, limit: number): Promise<BidDTO[]> {
    const res = await this.pool.query<BidRow>(
      `select ${BID_COLS} from marketplace.listing_bids
        where buyer_account_id = $1 order by created_at desc limit $2`,
      [buyerAccountId, limit],
    );
    return res.rows.map((r) => toBid(r, false));
  }

  async withdrawBid(buyerAccountId: AccountId, bidId: string): Promise<BidDTO> {
    const res = await this.pool.query<BidRow>(
      `update marketplace.listing_bids
          set status = 'withdrawn', decided_at = now()
        where id = $1 and buyer_account_id = $2 and status = 'pending'
        returning ${BID_COLS}`,
      [bidId, buyerAccountId],
    );
    if (!res.rows[0]) {
      throw new NotFoundError('Bid', bidId);
    }
    return toBid(res.rows[0], false);
  }

  /**
   * Accept a bid, and decline every other live bid on the listing.
   *
   * ONE CAR, ONE BUYER. Both halves are in the same transaction under a row
   * lock on the bid: without it two concurrent accepts on different bids would
   * each decline the other and the listing would end up with two accepted
   * offers, which is a dispute rather than a sale.
   *
   * The listing status is deliberately NOT changed. A car sale here concludes
   * with paperwork at a notary, days later — marking it sold the moment a
   * price is agreed would be a lie the seller has to undo. Accepting agrees a
   * price; the seller marks the listing sold themselves.
   */
  async acceptBid(sellerAccountId: AccountId, bidId: string): Promise<BidDTO> {
    return this.tx(async (c) => {
      const found = await c.query<BidRow & { seller_account_id: string; title: string }>(
        `select b.${BID_COLS.split(',').map((x) => x.trim()).join(', b.')},
                b.seller_account_id, l.title
           from marketplace.listing_bids b
           join marketplace.car_listings l on l.id = b.listing_id
          where b.id = $1 and b.seller_account_id = $2
          for update of b`,
        [bidId, sellerAccountId],
      );
      const bid = found.rows[0];
      if (!bid) throw new NotFoundError('Bid', bidId);
      if (bid.status !== 'pending') {
        throw new ConflictError(
          'BID_ALREADY_DECIDED',
          `That offer is already ${bid.status}`,
          { status: bid.status },
        );
      }

      const accepted = await c.query<BidRow>(
        `update marketplace.listing_bids set status = 'accepted', decided_at = now()
          where id = $1 returning ${BID_COLS}`,
        [bidId],
      );

      const losers = await c.query<BidRow>(
        `update marketplace.listing_bids
            set status = 'declined', decided_at = now(),
                decline_reason = 'Another offer was accepted'
          where listing_id = $1 and id <> $2 and status = 'pending'
          returning ${BID_COLS}`,
        [bid.listing_id, bidId],
      );

      const events = [
        makeEvent({
          type: BID_ACCEPTED,
          aggregateId: asId<Uuid>(bid.listing_id),
          payload: {
            bidId,
            listingId: bid.listing_id,
            listingTitle: bid.title,
            sellerAccountId,
            buyerAccountId: bid.buyer_account_id,
            amountMinor: Number(bid.amount_minor),
            currency: bid.currency,
          },
        }),
        // Everyone who lost hears why. Silence after bidding is the thing
        // buyers complain about on every marketplace.
        ...losers.rows.map((l) =>
          makeEvent({
            type: BID_DECLINED,
            aggregateId: asId<Uuid>(bid.listing_id),
            payload: {
              bidId: l.id,
              listingId: bid.listing_id,
              listingTitle: bid.title,
              sellerAccountId,
              buyerAccountId: l.buyer_account_id,
              reason: 'Another offer was accepted',
              supersededByAcceptance: true,
            },
          }),
        ),
      ];
      await this.outbox.appendWith(c, events);
      return toBid(accepted.rows[0], true);
    });
  }

  async declineBid(
    sellerAccountId: AccountId,
    bidId: string,
    reason: string | undefined,
  ): Promise<BidDTO> {
    return this.tx(async (c) => {
      const found = await c.query<BidRow & { title: string }>(
        `select b.${BID_COLS.split(',').map((x) => x.trim()).join(', b.')}, l.title
           from marketplace.listing_bids b
           join marketplace.car_listings l on l.id = b.listing_id
          where b.id = $1 and b.seller_account_id = $2
          for update of b`,
        [bidId, sellerAccountId],
      );
      const bid = found.rows[0];
      if (!bid) throw new NotFoundError('Bid', bidId);
      if (bid.status !== 'pending') {
        throw new ConflictError(
          'BID_ALREADY_DECIDED',
          `That offer is already ${bid.status}`,
          { status: bid.status },
        );
      }

      const res = await c.query<BidRow>(
        `update marketplace.listing_bids
            set status = 'declined', decided_at = now(), decline_reason = $2
          where id = $1 returning ${BID_COLS}`,
        [bidId, reason ?? null],
      );
      await this.outbox.appendWith(c, [
        makeEvent({
          type: BID_DECLINED,
          aggregateId: asId<Uuid>(bid.listing_id),
          payload: {
            bidId,
            listingId: bid.listing_id,
            listingTitle: bid.title,
            sellerAccountId,
            buyerAccountId: bid.buyer_account_id,
            reason: reason ?? null,
            supersededByAcceptance: false,
          },
        }),
      ]);
      return toBid(res.rows[0], true);
    });
  }
}
