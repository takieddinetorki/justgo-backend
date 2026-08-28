-- marketplace bounded context (§7): used-car listings + buyer contact.
create schema if not exists marketplace;

create table marketplace.car_listings (
  id uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null,          -- identity.accounts.id (private seller)
  supplier_id uuid,                          -- set when a showroom lists it
  title text not null,
  brand text, model text, year int,
  mileage_km int check (mileage_km is null or mileage_km >= 0),
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency char(3),
  description text,
  photo_urls text[] not null default '{}',
  city text, country char(2),
  geo geography(Point,4326),
  -- moderation seam (§21.5): beta auto-publishes; a review step can gate this
  status text not null default 'published'
    check (status in ('draft','published','pending_review','sold','withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index car_listings_seller_idx on marketplace.car_listings (seller_account_id, created_at desc);
create index car_listings_browse_idx on marketplace.car_listings (status, created_at desc);
create index car_listings_geo_idx on marketplace.car_listings using gist (geo);

create table marketplace.listing_contacts (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references marketplace.car_listings(id) on delete cascade,
  buyer_account_id uuid not null,
  message text,
  created_at timestamptz not null default now(),
  unique (listing_id, buyer_account_id)     -- one contact record per buyer per listing
);

create table marketplace.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index marketplace_outbox_unpublished_idx
  on marketplace.outbox (occurred_at) where published_at is null;

-- RLS (§11): published listings are world-readable; a seller manages their
-- own; a buyer's contact rows are private to them and the seller.
alter table marketplace.car_listings enable row level security;
create policy listings_public_read on marketplace.car_listings
  for select to anon, authenticated using (status = 'published');
create policy listings_seller_all on marketplace.car_listings
  for all to authenticated
  using (seller_account_id = app.account_id())
  with check (seller_account_id = app.account_id());

alter table marketplace.listing_contacts enable row level security;
create policy contacts_buyer_insert on marketplace.listing_contacts
  for insert to authenticated with check (buyer_account_id = app.account_id());
create policy contacts_visible_to_parties on marketplace.listing_contacts
  for select to authenticated
  using (
    buyer_account_id = app.account_id()
    or listing_id in (select id from marketplace.car_listings where seller_account_id = app.account_id())
  );

grant usage on schema marketplace to anon, authenticated, service_role;
grant select on marketplace.car_listings to anon, authenticated;
grant insert, update, delete on marketplace.car_listings to authenticated;
grant select, insert on marketplace.listing_contacts to authenticated;
grant all on all tables in schema marketplace to service_role;
