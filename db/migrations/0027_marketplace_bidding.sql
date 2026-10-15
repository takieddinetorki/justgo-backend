-- Richer car listings, and bidding against a private acceptance range.
--
-- Two changes to the marketplace:
--
-- 1. A listing describes the car properly. The fields below are the ones an
--    Algerian buyer actually filters on, including two this market cares about
--    and most templates omit: whether the car is customs-cleared
--    (*dédouanée*) and whether its papers are in order.
--
-- 2. A seller states a RANGE of prices they would accept, buyers bid, and the
--    seller is notified only when a bid reaches that range. The point of the
--    range is the silence below it: a seller who is pinged for every lowball
--    stops reading the pings.

-- ── 1. a listing that describes the car ──────────────────────────────
alter table marketplace.car_listings
  -- GPL first after the two obvious ones: conversions are everywhere here.
  add column if not exists fuel_type text
    check (fuel_type is null or fuel_type in ('essence','diesel','gpl','hybrid','electric')),
  add column if not exists transmission text
    check (transmission is null or transmission in ('manual','automatic')),
  add column if not exists body_type text
    check (body_type is null or body_type in
      ('citadine','berline','break','suv','monospace','utilitaire','coupe','cabriolet','pickup')),
  add column if not exists colour text,
  add column if not exists doors int check (doors is null or doors between 1 and 9),
  add column if not exists engine_hp int check (engine_hp is null or engine_hp between 1 and 2000),
  add column if not exists condition text
    check (condition is null or condition in ('new','used','damaged')),
  /*
    Customs and paperwork. Nullable rather than defaulted false, because
    "unknown" and "no" are different answers to a buyer and a default would
    silently assert the worse one about every listing that already exists.
  */
  add column if not exists is_customs_cleared boolean,
  add column if not exists papers_in_order boolean,
  add column if not exists owner_count int check (owner_count is null or owner_count >= 0),
  add column if not exists accident_free boolean;

-- Buyers filter on these together, and the browse query is the hottest read.
create index if not exists car_listings_filter_idx
  on marketplace.car_listings (status, fuel_type, transmission, body_type, year desc)
  where status = 'published';

/*
  ── 2. the acceptance range, in its OWN TABLE ─────────────────────────

  NOT a column on car_listings, and this is the whole security of the
  feature. POSTGRES RLS IS ROW-LEVEL, NOT COLUMN-LEVEL, and
  `listings_public_read` grants every column of that table to `anon` — so a
  floor stored there would be readable by anyone through PostgREST, and a
  buyer who can see the floor bids exactly the floor. A separate table gets
  its own policy, and the only rows it ever yields are the seller's own.
*/
create table if not exists marketplace.listing_offer_ranges (
  listing_id uuid primary key
    references marketplace.car_listings(id) on delete cascade,
  seller_account_id uuid not null,          -- denormalised so RLS needs no join
  /** The least the seller would seriously consider. Setting it opens bidding. */
  min_minor bigint not null check (min_minor >= 0),
  /*
    The top of the range. Optional: a seller who names only a floor is saying
    "anything from here up", and a bid above the top is better news than the
    range asked for, so there is nothing to cap.
  */
  max_minor bigint check (max_minor is null or max_minor >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint offer_range_is_ordered check (max_minor is null or max_minor >= min_minor)
);

/*
  ── bids ──────────────────────────────────────────────────────────────

  `status` and `standing` are separate columns because they answer separate
  questions: what HAPPENED to the bid, and WHERE it landed relative to the
  range. Collapsing them would lose the difference between "we declined a
  good offer" and "it was never in range", which is the first thing a seller
  looking back at a sale wants to know.
*/
create table if not exists marketplace.listing_bids (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references marketplace.car_listings(id) on delete cascade,
  buyer_account_id uuid not null,
  seller_account_id uuid not null,          -- denormalised so RLS needs no join
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  message text,

  status text not null default 'pending'
    check (status in ('pending','accepted','declined','withdrawn','superseded')),
  /** Where it fell against the range AS IT STOOD when the bid was placed. */
  standing text not null
    check (standing in ('below_range','in_range','above_range')),
  /*
    Recorded at placement rather than recomputed on read. A seller may move
    their range afterwards, and a bid that was in range when it was made does
    not retroactively stop having been — the notification already went out.
  */
  range_min_minor bigint,
  range_max_minor bigint,

  decided_at timestamptz,
  decline_reason text,
  created_at timestamptz not null default now(),

  constraint bid_decision_is_recorded check (
    (status = 'pending' and decided_at is null)
    or (status <> 'pending' and decided_at is not null)
  )
);

/*
  AT MOST ONE LIVE BID PER BUYER PER LISTING. Raising an offer is a new row
  that supersedes the old one, so the history survives while the seller only
  ever sees one current number per buyer. Without this a buyer could stack
  twenty pending bids and the seller would have no idea which one counts.
*/
create unique index if not exists listing_bids_one_pending_idx
  on marketplace.listing_bids (listing_id, buyer_account_id)
  where status = 'pending';

-- The seller's view: live bids on one listing, best first.
create index if not exists listing_bids_listing_idx
  on marketplace.listing_bids (listing_id, status, amount_minor desc);
-- "my offers", for the buyer.
create index if not exists listing_bids_buyer_idx
  on marketplace.listing_bids (buyer_account_id, created_at desc);

-- ── RLS (§11) ───────────────────────────────────────────────────────
alter table marketplace.listing_offer_ranges enable row level security;
alter table marketplace.listing_bids enable row level security;

/*
  THE RANGE IS THE SELLER'S ALONE. No policy for `anon`, and none for other
  authenticated accounts: a buyer who learns the floor bids the floor, and
  every offer above it that the seller would have got is lost.
*/
create policy offer_ranges_seller_only on marketplace.listing_offer_ranges
  for select to authenticated
  using (seller_account_id = app.account_id());

create policy offer_ranges_seller_writes on marketplace.listing_offer_ranges
  for all to authenticated
  using (seller_account_id = app.account_id())
  with check (seller_account_id = app.account_id());

/*
  A bid is visible to the buyer who made it and the seller who received it —
  never to a rival bidder. Seeing other people's offers is how an auction gets
  gamed, and nothing here is an auction.
*/
create policy bids_visible_to_parties on marketplace.listing_bids
  for select to authenticated
  using (
    buyer_account_id = app.account_id()
    or seller_account_id = app.account_id()
  );

-- Only ever as yourself, and never on your own listing.
create policy bids_buyer_places on marketplace.listing_bids
  for insert to authenticated
  with check (
    buyer_account_id = app.account_id()
    and seller_account_id <> app.account_id()
  );

grant select, insert, update, delete on marketplace.listing_offer_ranges to authenticated;
grant select, insert on marketplace.listing_bids to authenticated;
grant all on marketplace.listing_offer_ranges, marketplace.listing_bids to service_role;

-- ── permissions (§4.6 — permissions are data) ───────────────────────
insert into identity.permissions (key) values ('listing.bid')
on conflict (key) do nothing;

/*
  Its own bit rather than reusing `listing.contact`. A bid is a stronger act
  than a message — it names a price the seller may hold you to — and keeping
  it separate means bidding can be withheld from unverified accounts later as
  a data change rather than a code change.
*/
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key = 'listing.bid'
 where r.key in ('client', 'fleet', 'supplier_owner', 'branch_manager')
on conflict do nothing;
