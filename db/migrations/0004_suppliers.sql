-- suppliers bounded context (§7): businesses, branches, products, offers.
create schema if not exists suppliers;

create table suppliers.suppliers (
  id uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null,           -- identity.accounts.id (by id, no FK across schemas)
  vertical_key text not null,               -- SupplierVertical.key (validated in code)
  name text not null,
  is_multi_branch boolean not null default false,
  is_open boolean not null default true,
  services_offered text[] not null default '{}',
  geo geography(Point,4326),
  address text, city text, country char(2),
  rating numeric(2,1),
  profile jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index suppliers_geo_idx on suppliers.suppliers using gist (geo);
create index suppliers_vertical_idx on suppliers.suppliers (vertical_key) where is_open;

create table suppliers.branches (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers.suppliers(id) on delete cascade,
  name text not null,
  geo geography(Point,4326),
  address text,
  is_open boolean not null default true,
  hours jsonb
);
create index branches_geo_idx on suppliers.branches using gist (geo);

create table suppliers.products (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers.suppliers(id) on delete cascade,
  branch_id uuid,
  tecdoc_article_id bigint,
  name text not null,
  reference text,
  category_key text,
  amount_minor bigint,
  currency char(3),
  quantity int not null default 0,
  is_deal boolean not null default false,
  created_at timestamptz not null default now()
);
create index products_supplier_idx on suppliers.products (supplier_id);
create index products_category_idx on suppliers.products (category_key);

create table suppliers.service_offers (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers.suppliers(id) on delete cascade,
  service_type_key text not null,
  name text not null,
  description text,
  amount_minor bigint,
  currency char(3),
  duration_mins int,
  active boolean not null default true
);

create table suppliers.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index suppliers_outbox_unpublished_idx
  on suppliers.outbox (occurred_at) where published_at is null;

-- RLS (§11): open suppliers are world-visible (discovery); owners manage
-- their own business. account linkage comes from the account_id JWT claim.
alter table suppliers.suppliers enable row level security;
create policy suppliers_visible_when_open on suppliers.suppliers
  for select to authenticated, anon using (is_open);
create policy supplier_owner_all on suppliers.suppliers
  for all to authenticated
  using (owner_account_id = app.account_id())
  with check (owner_account_id = app.account_id());

alter table suppliers.branches enable row level security;
create policy branches_visible_when_open on suppliers.branches
  for select to authenticated, anon using (is_open);
create policy branch_owner_all on suppliers.branches
  for all to authenticated
  using (supplier_id in (select id from suppliers.suppliers where owner_account_id = app.account_id()))
  with check (supplier_id in (select id from suppliers.suppliers where owner_account_id = app.account_id()));

alter table suppliers.products enable row level security;
create policy products_visible on suppliers.products
  for select to authenticated, anon using (true);
create policy products_owner_all on suppliers.products
  for all to authenticated
  using (supplier_id in (select id from suppliers.suppliers where owner_account_id = app.account_id()))
  with check (supplier_id in (select id from suppliers.suppliers where owner_account_id = app.account_id()));

alter table suppliers.service_offers enable row level security;
create policy offers_visible_active on suppliers.service_offers
  for select to authenticated, anon using (active);
create policy offers_owner_all on suppliers.service_offers
  for all to authenticated
  using (supplier_id in (select id from suppliers.suppliers where owner_account_id = app.account_id()))
  with check (supplier_id in (select id from suppliers.suppliers where owner_account_id = app.account_id()));

grant usage on schema suppliers to anon, authenticated, service_role;
grant select on all tables in schema suppliers to anon, authenticated;
grant insert, update, delete on suppliers.suppliers, suppliers.branches,
  suppliers.products, suppliers.service_offers to authenticated;
grant all on all tables in schema suppliers to service_role;
