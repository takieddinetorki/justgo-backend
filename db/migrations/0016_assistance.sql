-- assistance bounded context (§7 roadside dispatch): a client raises a
-- roadside-assistance request; a PROVIDES_DISPATCH supplier is matched and
-- works it. Dispatch MATCHING rules are an Open Question (§21.1/§21.4) — the
-- request + status flow live here; matching is a seam consumed downstream.
create schema if not exists assistance;

create table assistance.assistance_requests (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  vehicle_id uuid,
  service_type text not null default 'breakdown'
    check (service_type in ('breakdown','tow','battery','tyre','fuel','lockout')),
  description text,
  pickup_geo geography(Point,4326) not null,
  pickup_address text,
  assigned_supplier_id uuid,
  status text not null default 'requested'
    check (status in ('requested','dispatched','en_route','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistance_client_idx on assistance.assistance_requests (client_account_id, created_at desc);
create index assistance_open_idx on assistance.assistance_requests (status) where status in ('requested','dispatched','en_route');
create index assistance_geo_idx on assistance.assistance_requests using gist (pickup_geo);

create table assistance.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index assistance_outbox_unpublished_idx
  on assistance.outbox (occurred_at) where published_at is null;

-- RLS (§11): client owns their requests; the assigned supplier sees/updates
-- the ones dispatched to it.
alter table assistance.assistance_requests enable row level security;
create policy assistance_client_all on assistance.assistance_requests
  for all to authenticated
  using (client_account_id = app.account_id())
  with check (client_account_id = app.account_id());
create policy assistance_supplier_read on assistance.assistance_requests
  for select to authenticated
  using (assigned_supplier_id = app.supplier_id());
create policy assistance_supplier_update on assistance.assistance_requests
  for update to authenticated
  using (assigned_supplier_id = app.supplier_id())
  with check (assigned_supplier_id = app.supplier_id());

grant usage on schema assistance to authenticated, service_role;
grant select, insert, update on assistance.assistance_requests to authenticated;
grant all on all tables in schema assistance to service_role;
