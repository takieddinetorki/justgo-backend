-- catalogue: data-driven service types + assembly-group taxonomy (§6.1, §7).
-- Service verticals reference service_type_key; adding a service is a seed
-- change, not a code change (§4.6).
create schema if not exists catalogue;

create table catalogue.assembly_groups (
  key text primary key,                 -- our stable category key, mirrors TecDoc
  tecdoc_group_id bigint,
  label_i18n jsonb not null             -- {"en":..,"es":..,"fr":..}
);

create table catalogue.service_types (
  key text primary key,
  vertical_key text not null,           -- which vertical offers it
  label_i18n jsonb not null,
  pricing_model text not null default 'quote'   -- 'fixed' | 'quote' | 'hourly'
    check (pricing_model in ('fixed','quote','hourly')),
  requires_calendar boolean not null default true,
  requires_vehicle boolean not null default true,
  active boolean not null default true
);
create index service_types_vertical_idx on catalogue.service_types (vertical_key) where active;

-- reference data, world-readable; writes are service_role/seed only
alter table catalogue.assembly_groups enable row level security;
alter table catalogue.service_types enable row level security;
create policy assembly_groups_readable on catalogue.assembly_groups
  for select to anon, authenticated using (true);
create policy service_types_readable on catalogue.service_types
  for select to anon, authenticated using (active);

grant usage on schema catalogue to anon, authenticated, service_role;
grant select on catalogue.assembly_groups, catalogue.service_types to anon, authenticated;
grant all on all tables in schema catalogue to service_role;
