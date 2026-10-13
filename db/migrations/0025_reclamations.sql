-- reclamations bounded context (§7): complaints and claims, with a case
-- state machine and a thread each side can answer in.
--
-- The app ships ReclamationScreen, NewReclamationFormScreen and the
-- `justgo_reclamations` strings against nothing at all — no route, no schema.
create schema if not exists reclamations;

/*
  A readable case number, because people quote it on the phone.

  A SEQUENCE, not the gapless counter the documents schema uses. A fiscal
  series may not have gaps, so issuing an invoice number takes a row lock; a
  complaint reference has no such rule, and a sequence hands out numbers
  without serialising every filing behind one lock. A gap here means somebody
  started filing and gave up, which is true and harmless.
*/
create sequence if not exists reclamations.case_seq;

create table reclamations.cases (
  id uuid primary key default gen_random_uuid(),
  /** RCL-2026-000123 — unique, readable, not gapless. */
  reference text not null unique,
  claimant_account_id uuid not null,            -- identity.accounts.id

  /*
    WHO IS BEING COMPLAINED ABOUT. Nullable, because not every complaint is
    about a supplier: "the app charged me twice" is against the platform, and
    forcing a supplier here would either lose those or misfile them.
  */
  respondent_supplier_id uuid,                  -- suppliers.suppliers.id

  /*
    What the complaint concerns, as a LOOSE reference — never a foreign key.
    A case may concern an order, a reservation, a roadside job, a listing or
    nothing concrete, and reclamations must not depend on any of those
    schemas (§17.4).
  */
  subject_type text check (subject_type in ('order','reservation','assistance','listing','quote')),
  subject_id uuid,

  category text not null check (category in (
    'not_delivered',        -- paid or agreed, never arrived
    'wrong_part',           -- not what was quoted
    'damaged',              -- arrived broken
    'quality',              -- work done badly
    'overcharged',          -- price does not match the quote
    'no_show',              -- the other side never turned up
    'behaviour',            -- how someone was treated
    'other'
  )),
  title text not null check (length(btrim(title)) > 0),
  body text not null check (length(btrim(body)) > 0),

  /*
    open -> under_review -> resolved | rejected
    open | under_review -> withdrawn

    `rejected` is not a judgement that the claimant lied; it records that the
    claim was not upheld, with a reason. Keeping it distinct from `resolved`
    is what lets anyone later tell "we fixed it" from "we disagreed", which a
    single `closed` state destroys.
  */
  status text not null default 'open'
    check (status in ('open','under_review','resolved','rejected','withdrawn')),
  /** Required on resolved/rejected: a closed case must say why. */
  resolution text,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cases_closure_is_explained check (
    (status in ('open','under_review') and closed_at is null and resolution is null)
    or (status = 'withdrawn' and closed_at is not null)
    or (status in ('resolved','rejected')
        and closed_at is not null
        and resolution is not null
        and length(btrim(resolution)) > 0)
  )
);
-- "My complaints", newest first.
create index cases_claimant_idx on reclamations.cases (claimant_account_id, created_at desc);
-- "Complaints against my business" — the supplier-side queue, open ones first.
create index cases_respondent_idx
  on reclamations.cases (respondent_supplier_id, status, created_at desc)
  where respondent_supplier_id is not null;
-- The ops queue: everything still live, oldest first, because the oldest
-- untouched complaint is the one doing the most damage.
create index cases_open_idx
  on reclamations.cases (created_at)
  where status in ('open','under_review');
create index cases_subject_idx
  on reclamations.cases (subject_type, subject_id)
  where subject_id is not null;

/*
  The thread. Both sides and ops write here.

  `author_role` is stored rather than derived, because a reader needs to know
  who said what AFTER the fact: an account can lose a supplier scope, or an
  ops admin can stop being one, and a thread that re-derives the role from
  today's permissions would silently rewrite its own history.
*/
create table reclamations.case_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references reclamations.cases(id) on delete cascade,
  author_account_id uuid not null,
  author_role text not null check (author_role in ('claimant','respondent','ops')),
  body text not null check (length(btrim(body)) > 0),
  /*
    Internal ops notes. Never returned to the claimant or the supplier — the
    API filters on read. Without somewhere to put these, ops would either
    keep case notes outside the system or accidentally show them to the
    person being complained about.
  */
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index case_messages_case_idx on reclamations.case_messages (case_id, created_at);

/*
  Evidence. A photo of the wrong part settles more complaints than any amount
  of description.

  Bytes are not here: the client uploads through POST /v1/media/uploads to a
  private bucket and sends the path (§14). Attachments hang off the CASE, not
  a message, because the first thing a claimant does is file with photos
  before any conversation exists.
*/
create table reclamations.case_attachments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references reclamations.cases(id) on delete cascade,
  uploaded_by_account_id uuid not null,
  bucket text not null,
  path text not null,
  created_at timestamptz not null default now()
);
create index case_attachments_case_idx on reclamations.case_attachments (case_id, created_at);

create table reclamations.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index reclamations_outbox_unpublished_idx
  on reclamations.outbox (occurred_at) where published_at is null;

-- ── RLS (§11) ───────────────────────────────────────────────────────
-- A case is visible to its claimant and to the supplier it is against.
-- Ops reach it as service_role through the API.
alter table reclamations.cases enable row level security;
alter table reclamations.case_messages enable row level security;
alter table reclamations.case_attachments enable row level security;

create policy cases_party_reads on reclamations.cases
  for select to authenticated
  using (
    claimant_account_id = app.account_id()
    or respondent_supplier_id = app.supplier_id()
  );

create policy cases_claimant_writes on reclamations.cases
  for insert to authenticated
  with check (claimant_account_id = app.account_id());

/*
  Internal notes are excluded here as well as in the API. The API is what
  actually filters them, but a policy that returned them would make any
  future direct PostgREST read a leak of ops commentary to the person being
  complained about.
*/
create policy case_messages_party_reads on reclamations.case_messages
  for select to authenticated
  using (
    internal = false
    and exists (
      select 1 from reclamations.cases c
       where c.id = reclamations.case_messages.case_id
         and (c.claimant_account_id = app.account_id()
              or c.respondent_supplier_id = app.supplier_id())
    )
  );

-- You may only ever post as yourself, into a case you are party to.
create policy case_messages_party_writes on reclamations.case_messages
  for insert to authenticated
  with check (
    author_account_id = app.account_id()
    and internal = false
    and exists (
      select 1 from reclamations.cases c
       where c.id = reclamations.case_messages.case_id
         and (c.claimant_account_id = app.account_id()
              or c.respondent_supplier_id = app.supplier_id())
    )
  );

create policy case_attachments_party_reads on reclamations.case_attachments
  for select to authenticated
  using (exists (
    select 1 from reclamations.cases c
     where c.id = reclamations.case_attachments.case_id
       and (c.claimant_account_id = app.account_id()
            or c.respondent_supplier_id = app.supplier_id())
  ));

grant usage on schema reclamations to authenticated, service_role;
grant select on reclamations.cases, reclamations.case_messages,
                reclamations.case_attachments to authenticated;
grant insert on reclamations.cases, reclamations.case_messages,
                reclamations.case_attachments to authenticated;
grant usage on sequence reclamations.case_seq to authenticated, service_role;
grant all on all tables in schema reclamations to service_role;

-- ── permissions (§4.6 — permissions are data) ───────────────────────
insert into identity.permissions (key)
values ('reclamation.file'), ('reclamation.respond')
on conflict (key) do nothing;

/*
  Filing and responding are separate because they sit on opposite sides of
  the case. A supplier gets `reclamation.respond` so it can answer complaints
  against it, and `reclamation.file` as well — a business is also somebody's
  customer, and a supplier whose own order never arrived needs the same
  recourse.

  Ops hold `platform.admin`, which the API treats as reaching every case
  rather than only its own; they are not given a per-feature bit.
*/
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key = 'reclamation.file'
 where r.key in ('client', 'fleet', 'supplier_owner', 'branch_manager')
on conflict do nothing;

insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key = 'reclamation.respond'
 where r.key in ('supplier_owner', 'branch_manager')
on conflict do nothing;
