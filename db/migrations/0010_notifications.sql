-- notifications bounded context (§7, §13): in-app feed + device registry.
-- Deviation from the representative DDL (§7 allows completing it during
-- build): the recipient is an account XOR a supplier, so supplier-side
-- notifications and badge counters (§13 "per-supplier unread counters") need
-- no cross-module account lookup — every domain event carries either a
-- client account id or a supplier id. Devices likewise carry the supplier
-- scope of the session that registered them, so a push can target a supplier.
create schema if not exists notifications;

create table notifications.notifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid,
  supplier_id uuid,
  type text not null,
  title text,
  body text,
  ref_id uuid,
  read boolean not null default false,
  created_at timestamptz not null default now(),
  constraint one_recipient check ((account_id is not null) <> (supplier_id is not null))
);
create index notifications_account_idx
  on notifications.notifications (account_id, created_at desc) where account_id is not null;
create index notifications_supplier_idx
  on notifications.notifications (supplier_id, created_at desc) where supplier_id is not null;

create table notifications.devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  supplier_id uuid,                          -- set for supplier-scoped sessions
  fcm_token text not null,
  platform text,                             -- 'android' | 'ios' | 'web'
  created_at timestamptz not null default now(),
  unique (account_id, fcm_token)
);
create index devices_supplier_idx on notifications.devices (supplier_id) where supplier_id is not null;

create table notifications.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index notifications_outbox_unpublished_idx
  on notifications.outbox (occurred_at) where published_at is null;

-- RLS (§11): a user reads/updates only their own notifications; a supplier-
-- scoped session reads its supplier's. Writes come from the service role
-- (the reactors), which bypasses RLS.
alter table notifications.notifications enable row level security;
create policy notif_read_own_account on notifications.notifications
  for select to authenticated
  using (account_id = app.account_id());
create policy notif_read_own_supplier on notifications.notifications
  for select to authenticated
  using (supplier_id = app.supplier_id());
create policy notif_update_own_account on notifications.notifications
  for update to authenticated
  using (account_id = app.account_id())
  with check (account_id = app.account_id());
create policy notif_update_own_supplier on notifications.notifications
  for update to authenticated
  using (supplier_id = app.supplier_id())
  with check (supplier_id = app.supplier_id());

alter table notifications.devices enable row level security;
create policy devices_manage_own on notifications.devices
  for all to authenticated
  using (account_id = app.account_id())
  with check (account_id = app.account_id());

grant usage on schema notifications to authenticated, service_role;
grant select, update on notifications.notifications to authenticated;
grant select, insert, delete on notifications.devices to authenticated;
grant all on all tables in schema notifications to service_role;
