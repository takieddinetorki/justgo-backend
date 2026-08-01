-- orders bounded context (§7, §8.2): created when a client accepts a quote.
create schema if not exists orders;

create table orders.orders (
  id uuid primary key default gen_random_uuid(),
  request_id uuid,
  quote_id uuid unique,                     -- one order per accepted quote (idempotent reactor)
  client_account_id uuid not null,
  supplier_id uuid not null,
  fulfilment text not null default 'pickup'
    check (fulfilment in ('home','pickup','carrier','install')),
  pickup_geo geography(Point,4326),
  dropoff_geo geography(Point,4326),
  workshop_supplier_id uuid,
  appointment_at timestamptz,
  amount_minor bigint,
  currency char(3),
  status text not null default 'created'
    check (status in ('created','confirmed','in_progress','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 'install' fulfilment requires a workshop appointment (§8.2)
  constraint install_needs_workshop check (
    fulfilment <> 'install' or workshop_supplier_id is not null
  )
);
create index orders_client_idx on orders.orders (client_account_id, created_at desc);
create index orders_supplier_idx on orders.orders (supplier_id, created_at desc);

create table orders.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index orders_outbox_unpublished_idx
  on orders.outbox (occurred_at) where published_at is null;

-- RLS (§11): both sides of the deal can read it; neither can see others'.
alter table orders.orders enable row level security;
create policy client_reads_own_orders on orders.orders
  for select to authenticated
  using (client_account_id = app.account_id());
create policy supplier_reads_own_orders on orders.orders
  for select to authenticated
  using (supplier_id = app.supplier_id());
create policy client_updates_own_orders on orders.orders
  for update to authenticated
  using (client_account_id = app.account_id())
  with check (client_account_id = app.account_id());

grant usage on schema orders to authenticated, service_role;
grant select, update on orders.orders to authenticated;
grant all on all tables in schema orders to service_role;
