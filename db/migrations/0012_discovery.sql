-- discovery bounded context (§6.1): a PostGIS read model of supplier
-- locations, populated from suppliers events. Owns ONLY reference ids + geo,
-- never reaches into the suppliers schema (§17.4).
create schema if not exists discovery;

create table discovery.supplier_locations (
  supplier_id uuid primary key,
  vertical_key text not null,
  name text not null,
  geo geography(Point,4326),
  category_keys text[] not null default '{}',
  is_open boolean not null default true,
  updated_at timestamptz not null default now()
);
create index supplier_locations_geo_idx on discovery.supplier_locations using gist (geo);
create index supplier_locations_vertical_idx on discovery.supplier_locations (vertical_key);

-- public read model: anyone may discover open suppliers nearby.
alter table discovery.supplier_locations enable row level security;
create policy locations_readable on discovery.supplier_locations
  for select to anon, authenticated using (is_open);

grant usage on schema discovery to anon, authenticated, service_role;
grant select on discovery.supplier_locations to anon, authenticated;
grant all on discovery.supplier_locations to service_role;
