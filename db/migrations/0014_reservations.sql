-- reservations bounded context (§7, §8.3): bookings against a supplier's
-- calendar. Slots are held; double-booking is impossible by constraint.
create schema if not exists reservations;

create table reservations.reservations (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  supplier_id uuid not null,
  branch_id uuid,
  service_type_key text not null,           -- catalogue.service_types.key (validated in code)
  vehicle_id uuid,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected','rescheduled','completed','cancelled')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint slot_order check (slot_end > slot_start)
);
create index reservations_client_idx on reservations.reservations (client_account_id, slot_start desc);
create index reservations_supplier_idx on reservations.reservations (supplier_id, slot_start desc);

-- No double-booking (§8.3): one active reservation per supplier+branch+start.
-- branch_id is nullable, so collapse null to a sentinel; only live statuses
-- hold a slot (rejected/cancelled free it).
create unique index reservations_no_double_book
  on reservations.reservations (
    supplier_id,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    slot_start
  )
  where status in ('pending','accepted','rescheduled');

create table reservations.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index reservations_outbox_unpublished_idx
  on reservations.outbox (occurred_at) where published_at is null;

-- RLS (§11): the client owns their bookings; the supplier sees bookings
-- targeting it. Either side updates via their own policy.
alter table reservations.reservations enable row level security;
create policy client_reads_own_reservations on reservations.reservations
  for select to authenticated
  using (client_account_id = app.account_id());
create policy client_writes_own_reservations on reservations.reservations
  for all to authenticated
  using (client_account_id = app.account_id())
  with check (client_account_id = app.account_id());
create policy supplier_reads_targeted_reservations on reservations.reservations
  for select to authenticated
  using (supplier_id = app.supplier_id());
create policy supplier_updates_targeted_reservations on reservations.reservations
  for update to authenticated
  using (supplier_id = app.supplier_id())
  with check (supplier_id = app.supplier_id());

grant usage on schema reservations to authenticated, service_role;
grant select, insert, update on reservations.reservations to authenticated;
grant all on all tables in schema reservations to service_role;
