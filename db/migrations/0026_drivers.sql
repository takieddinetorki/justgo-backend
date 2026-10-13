-- drivers bounded context (§7): driver identity, licence/selfie verification
-- and availability for dispatch.
--
-- The app ships DriverHomeScreen, DriverProfileScreen,
-- DriverVerificationFlowScreen, the `justgo_driver` strings, DRV_TAKE_PHOTO,
-- DRV_UPLOAD_PHOTO, DRV_LOCATION_PERMISSION_NEEDED and the prompts "A clear
-- photo of your driving license" / "Look directly at the camera" — against
-- no route and no schema.
--
-- WHAT IS DELIBERATELY NOT HERE: EARNINGS. DriverEarningsScreen implies
-- payouts, and payouts need the pricing, commission and capture model that
-- spec §21 #3/#4 leaves open. Inventing a commission rate would be worse
-- than leaving the screen empty: a driver who is shown a number will act on
-- it, and the first real payout run would contradict it. The schema below
-- stops at who may drive, not what they are owed.
create schema if not exists drivers;

create table drivers.drivers (
  id uuid primary key default gen_random_uuid(),
  /*
    One driver record per account. A person is a driver or is not; two records
    would mean two verification states for one human, and dispatch would have
    to guess which one to trust.
  */
  account_id uuid not null unique,              -- identity.accounts.id

  /*
    The business they drive for, if any. Nullable because an independent tow
    operator is a real case in this market, and forcing a supplier here would
    make them unrepresentable. Dispatch reads it to prefer a company's own
    drivers; it is a loose reference, never a foreign key (§17.4).
  */
  supplier_id uuid,                             -- suppliers.suppliers.id

  full_name text not null check (length(btrim(full_name)) > 0),
  phone text,
  licence_number text,
  /*
    Stored as a DATE, not a timestamp: a licence expires on a day, in the
    holder's own country, and pinning it to an instant would make it expire
    at a different moment depending on where the server is.
  */
  licence_expires_on date,

  /*
    draft -> pending_review -> verified | rejected
    rejected -> pending_review        (fix the photo, resubmit)
    verified -> suspended -> pending_review

    `rejected` and `suspended` are separate states on purpose. Rejected means
    "we never accepted you"; suspended means "we did, and we have stopped
    trusting it" — for an expired licence, or a complaint. Collapsing them
    would lose whether this person ever passed a check.
  */
  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'verified', 'rejected', 'suspended')),
  /** Required on rejected/suspended: a refusal the driver cannot act on is useless. */
  decision_reason text,
  decided_by_account_id uuid,
  decided_at timestamptz,
  verified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint drivers_decision_is_explained check (
    (status in ('draft', 'pending_review') and decision_reason is null)
    or (status = 'verified' and verified_at is not null)
    or (status in ('rejected', 'suspended')
        and decision_reason is not null
        and length(btrim(decision_reason)) > 0
        and decided_at is not null)
  )
);
-- The ops review queue: oldest submission first, because the person waiting
-- longest is the one most likely to give up.
create index drivers_review_queue_idx
  on drivers.drivers (updated_at)
  where status = 'pending_review';
create index drivers_supplier_idx
  on drivers.drivers (supplier_id)
  where supplier_id is not null;
-- Dispatch asks "which verified drivers are there", never "all drivers".
create index drivers_verified_idx on drivers.drivers (status) where status = 'verified';

/*
  KYC documents: licence photos and a selfie.

  The bytes are NOT here and must never be. These are identity documents —
  the most sensitive thing this product handles. They go to a private bucket
  through POST /v1/media/uploads and are read back only as short-lived signed
  URLs, and only by the driver themselves or by ops.

  `kind` is an enum rather than free text because the submission gate counts
  specific kinds: without it "did they send a selfie?" becomes a guess.
*/
create table drivers.verification_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers.drivers(id) on delete cascade,
  kind text not null check (kind in ('licence_front', 'licence_back', 'selfie', 'id_card')),
  bucket text not null,
  path text not null,
  uploaded_at timestamptz not null default now()
);
/*
  Latest-wins per kind. A driver whose licence photo was too dark uploads
  another one, and the reviewer must see the new one — not both with no way to
  tell which is current. Replacing the row keeps "one current document per
  kind" true by construction.
*/
create unique index verification_documents_current_idx
  on drivers.verification_documents (driver_id, kind);

/*
  Availability, as its own row rather than columns on the driver.

  It is written constantly — every heartbeat while someone is online — and
  the driver record is read by ops and dispatch. Keeping them apart means a
  location ping does not touch the row that holds the verification decision.
*/
create table drivers.availability (
  driver_id uuid primary key references drivers.drivers(id) on delete cascade,
  is_online boolean not null default false,
  lat double precision check (lat is null or (lat between -90 and 90)),
  lng double precision check (lng is null or (lng between -180 and 180)),
  /*
    When the driver last told us anything. Dispatch must treat a stale
    heartbeat as offline no matter what `is_online` says — an app killed by
    the OS never gets to set it false.
  */
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index availability_online_idx
  on drivers.availability (last_seen_at desc)
  where is_online = true;

create table drivers.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index drivers_outbox_unpublished_idx
  on drivers.outbox (occurred_at) where published_at is null;

-- ── RLS (§11) ───────────────────────────────────────────────────────
alter table drivers.drivers enable row level security;
alter table drivers.verification_documents enable row level security;
alter table drivers.availability enable row level security;

-- A driver reads their own record. Ops reach every record as service_role
-- through the API; there is no "read any driver" policy for `authenticated`,
-- because that would expose licence numbers across the whole user base.
create policy drivers_own_reads on drivers.drivers
  for select to authenticated
  using (account_id = app.account_id());

create policy drivers_own_writes on drivers.drivers
  for insert to authenticated
  with check (account_id = app.account_id());

/*
  A driver may edit their own record, but the VERIFICATION DECISION is not
  theirs. Postgres cannot express "any column except status" in a policy, so
  the API owns that rule and performs decisions as service_role. This policy
  is the second line of defence on ownership only.
*/
create policy drivers_own_updates on drivers.drivers
  for update to authenticated
  using (account_id = app.account_id())
  with check (account_id = app.account_id());

create policy documents_own_reads on drivers.verification_documents
  for select to authenticated
  using (exists (
    select 1 from drivers.drivers d
     where d.id = drivers.verification_documents.driver_id
       and d.account_id = app.account_id()
  ));

create policy documents_own_writes on drivers.verification_documents
  for insert to authenticated
  with check (exists (
    select 1 from drivers.drivers d
     where d.id = drivers.verification_documents.driver_id
       and d.account_id = app.account_id()
  ));

create policy availability_own_reads on drivers.availability
  for select to authenticated
  using (exists (
    select 1 from drivers.drivers d
     where d.id = drivers.availability.driver_id
       and d.account_id = app.account_id()
  ));

create policy availability_own_writes on drivers.availability
  for all to authenticated
  using (exists (
    select 1 from drivers.drivers d
     where d.id = drivers.availability.driver_id
       and d.account_id = app.account_id()
  ))
  with check (exists (
    select 1 from drivers.drivers d
     where d.id = drivers.availability.driver_id
       and d.account_id = app.account_id()
  ));

grant usage on schema drivers to authenticated, service_role;
grant select on drivers.drivers, drivers.verification_documents, drivers.availability
  to authenticated;
grant insert, update on drivers.drivers to authenticated;
grant insert on drivers.verification_documents to authenticated;
grant insert, update on drivers.availability to authenticated;
grant all on all tables in schema drivers to service_role;

-- ── permissions (§4.6 — permissions are data) ───────────────────────
insert into identity.permissions (key)
values ('driver.apply'), ('driver.work')
on conflict (key) do nothing;

/*
  TWO BITS, because applying and driving are different states of the world.

  `driver.apply` lets someone create a profile and submit documents — anybody
  with an account may ask. `driver.work` is what lets them go online and be
  dispatched, and it is granted by a REACTOR when verification succeeds, not
  by a role. That is the whole point: being allowed to drive is the outcome
  of a check, so it cannot be something a role handed out at signup.

  Ops decide verification through `platform.admin`.
*/
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key = 'driver.apply'
 where r.key in ('client', 'fleet', 'supplier_owner', 'branch_manager')
on conflict do nothing;

/*
  The `driver` role exists so that `driver.work` has somewhere to live.
  Permissions reach an account through a role (identity.user_roles ->
  role_permissions), so a bit granted on verification needs a role to carry
  it. Nobody is seeded into this role: DriverVerificationReactor assigns it
  when a verification succeeds, and a suspension takes it away.
*/
insert into identity.roles (key, label)
values ('driver', 'Verified driver')
on conflict (key) do update set label = excluded.label;

insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key in ('driver.work', 'driver.apply')
 where r.key = 'driver'
on conflict do nothing;
