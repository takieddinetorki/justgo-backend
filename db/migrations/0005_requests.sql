-- requests bounded context (§7, §8.1): the core marketplace loop.
create schema if not exists requests;

create table requests.part_requests (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,          -- identity.accounts.id (by id, no cross-schema FK)
  vehicle_id uuid,
  tecdoc_article_id bigint,
  category_key text,
  free_text text,
  photo_url text,
  quantity int not null default 1 check (quantity > 0),
  strategy text not null check (strategy in ('all','single')),
  target_supplier_id uuid,
  status text not null default 'pending'
    check (status in ('pending','awaiting_client','accepted','refused','expired','cancelled')),
  idempotency_key text unique,              -- dedupes client retries (§16)
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  -- strategy='single' targets exactly one supplier; 'all' fans out
  constraint single_needs_target check (strategy <> 'single' or target_supplier_id is not null)
);
create index part_requests_client_idx on requests.part_requests (client_account_id, created_at desc);
create index part_requests_open_idx on requests.part_requests (expires_at)
  where status in ('pending','awaiting_client');

create table requests.quotes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests.part_requests(id) on delete cascade,
  supplier_id uuid not null,
  kind text check (kind in ('price','alternative')),
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency char(3),
  alt_name text,
  alt_reference text,
  alt_tecdoc_article_id bigint,
  status text not null default 'pending'
    check (status in ('pending','quoted','rejected','accepted','refused','closed')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- one live quote per supplier per request (§16 concurrency)
  unique (request_id, supplier_id),
  -- a priced quote must carry money; money is always minor units + currency
  constraint price_needs_amount check (
    kind is distinct from 'price' or status <> 'quoted' or (amount_minor is not null and currency is not null)
  )
);
create index quotes_supplier_inbox_idx on requests.quotes (supplier_id, status, created_at desc);
create index quotes_request_idx on requests.quotes (request_id);

create table requests.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index requests_outbox_unpublished_idx
  on requests.outbox (occurred_at) where published_at is null;

-- RLS (§11) — the highest-risk area: a client sees only their own requests;
-- a supplier sees a request ONLY through a quote row targeting it.
alter table requests.part_requests enable row level security;
create policy client_reads_own_requests on requests.part_requests
  for select to authenticated
  using (client_account_id = app.account_id());
create policy client_writes_own_requests on requests.part_requests
  for all to authenticated
  using (client_account_id = app.account_id())
  with check (client_account_id = app.account_id());
create policy supplier_reads_targeted_requests on requests.part_requests
  for select to authenticated
  using (exists (
    select 1 from requests.quotes q
     where q.request_id = part_requests.id
       and q.supplier_id = app.supplier_id()
  ));

alter table requests.quotes enable row level security;
create policy client_reads_quotes_on_own_requests on requests.quotes
  for select to authenticated
  using (exists (
    select 1 from requests.part_requests r
     where r.id = quotes.request_id
       and r.client_account_id = app.account_id()
  ));
create policy supplier_reads_own_quotes on requests.quotes
  for select to authenticated
  using (supplier_id = app.supplier_id());
create policy supplier_updates_own_quotes on requests.quotes
  for update to authenticated
  using (supplier_id = app.supplier_id())
  with check (supplier_id = app.supplier_id());

grant usage on schema requests to authenticated, service_role;
grant select, insert, update on requests.part_requests to authenticated;
grant select, update on requests.quotes to authenticated;
grant all on all tables in schema requests to service_role;
