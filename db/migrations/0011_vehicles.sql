-- vehicles bounded context (§7): the client's garage, plus health history and
-- maintenance tasks. TecDoc linkage stores only reference IDs (§10.4).
create schema if not exists vehicles;

create table vehicles.vehicles (
  id uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null,           -- identity.accounts.id (by id, no cross-schema FK)
  name text,
  brand text,
  model text,
  year int,
  vin text,
  plate text,
  mileage_km int check (mileage_km is null or mileage_km >= 0),
  -- TecDoc linkage for accurate part matching (IDs only):
  tecdoc_manufacturer_id bigint,
  tecdoc_model_id bigint,
  tecdoc_vehicle_type_id bigint,            -- KType
  health_status text not null default 'good'
    check (health_status in ('optimal','good','warning','critical','urgent')),
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index vehicles_owner_idx on vehicles.vehicles (owner_account_id, created_at desc);

create table vehicles.maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles.vehicles(id) on delete cascade,
  title text not null,
  interval_km int,
  interval_months int,
  due_at_km int,
  due_date date,
  status text not null default 'pending'
    check (status in ('pending','due','done','dismissed')),
  last_reminded_at timestamptz,
  created_at timestamptz not null default now()
);
create index maintenance_vehicle_idx on vehicles.maintenance_tasks (vehicle_id);
create index maintenance_due_idx on vehicles.maintenance_tasks (status, due_date);

create table vehicles.health_history (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles.vehicles(id) on delete cascade,
  system_area text,
  status text,
  note text,
  mileage_km int,
  at date not null default current_date,
  created_at timestamptz not null default now()
);
create index health_vehicle_idx on vehicles.health_history (vehicle_id, at desc);

create table vehicles.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index vehicles_outbox_unpublished_idx
  on vehicles.outbox (occurred_at) where published_at is null;

-- RLS (§11): an owner sees and manages only their own vehicles and the
-- child rows hanging off them.
alter table vehicles.vehicles enable row level security;
create policy vehicle_owner_all on vehicles.vehicles
  for all to authenticated
  using (owner_account_id = app.account_id())
  with check (owner_account_id = app.account_id());

alter table vehicles.maintenance_tasks enable row level security;
create policy maintenance_owner_all on vehicles.maintenance_tasks
  for all to authenticated
  using (vehicle_id in (select id from vehicles.vehicles where owner_account_id = app.account_id()))
  with check (vehicle_id in (select id from vehicles.vehicles where owner_account_id = app.account_id()));

alter table vehicles.health_history enable row level security;
create policy health_owner_all on vehicles.health_history
  for all to authenticated
  using (vehicle_id in (select id from vehicles.vehicles where owner_account_id = app.account_id()))
  with check (vehicle_id in (select id from vehicles.vehicles where owner_account_id = app.account_id()));

grant usage on schema vehicles to authenticated, service_role;
grant select, insert, update, delete on vehicles.vehicles, vehicles.maintenance_tasks,
  vehicles.health_history to authenticated;
grant all on all tables in schema vehicles to service_role;
