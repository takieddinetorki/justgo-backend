-- Mileage becomes a dated, append-only fact instead of a bare number.
--
-- The client app enforces "update your mileage every 30 days or
-- notifications are locked", and until now it had to fake the date part:
-- it wrote a `JG-MILEAGE:<km>` row into vehicles.maintenance_tasks after
-- every confirmed update and read the newest one back. That worked only
-- for clients that chose to play along — anything calling
-- PATCH /v1/vehicles/:id/mileage directly skipped the record entirely,
-- and `updated_at` was useless as a substitute because renaming a car or
-- changing its health status moves it too.
--
-- After this migration the server owns the rule.

alter table vehicles.vehicles
  add column mileage_updated_at timestamptz;

-- EVERYONE STARTS A FRESH PERIOD AT RELEASE TIME. Backfilling null, or the
-- row's created_at, would lock out every existing user the moment this
-- ships — the one outcome worse than not having the rule at all.
update vehicles.vehicles set mileage_updated_at = now();

alter table vehicles.vehicles
  alter column mileage_updated_at set default now(),
  alter column mileage_updated_at set not null;

/*
  Every change, kept.

  Two reasons it is a table and not a column:

  1. Users cannot lower a value (see MILEAGE_LOWER in the repository), so a
     typo - 150000 for 15000 - is permanent from the user's side and has to
     be corrected by support. A correction that overwrites the only copy of
     the number leaves nothing to audit, and this is the number a workshop
     uses to decide what a car is due for.
  2. `source` separates a reading the owner confirmed from one support
     typed in on their behalf. They are not the same evidence.
*/
create table vehicles.mileage_history (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles.vehicles(id) on delete cascade,
  previous_km int,
  new_km int not null check (new_km >= 0),
  source text not null default 'client' check (source in ('client', 'support')),
  actor_account_id uuid,
  recorded_at timestamptz not null default now()
);

-- The only read this table gets is "newest first for one car".
create index mileage_history_vehicle_idx
  on vehicles.mileage_history (vehicle_id, recorded_at desc);

-- Same shape as the other vehicles.* child tables: reachable through the
-- owning vehicle, and only by its owner.
alter table vehicles.mileage_history enable row level security;
create policy mileage_history_owner_all on vehicles.mileage_history
  using (vehicle_id in (select id from vehicles.vehicles where owner_account_id = app.account_id()))
  with check (vehicle_id in (select id from vehicles.vehicles where owner_account_id = app.account_id()));

/*
  Support's correction key.

  Deliberately NOT folded into platform.admin: lowering a recorded mileage
  is exactly the capability someone would want in order to make a car look
  less used than it is, and it should be grantable to the support desk
  without handing over the rest of the platform.
*/
insert into identity.permissions (key) values ('support.mileage.override')
on conflict (key) do nothing;

insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
from identity.roles r
join identity.permissions p on p.key = 'support.mileage.override'
where r.key = 'ops_admin'
on conflict do nothing;
