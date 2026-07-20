-- identity bounded context (§7): accounts + data-driven roles/permissions.
create schema if not exists identity;

create table identity.accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique not null,        -- Supabase auth.users.id
  first_name text,
  family_name text,
  dob date,
  phone text,
  email text,
  locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table identity.roles (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,                 -- 'client','fleet','supplier_owner',...
  label text not null
);

create table identity.permissions (
  id uuid primary key default gen_random_uuid(),
  key text unique not null                  -- 'request.create','quote.submit',...
);

create table identity.role_permissions (
  role_id uuid not null references identity.roles(id) on delete cascade,
  permission_id uuid not null references identity.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table identity.user_roles (
  account_id uuid not null references identity.accounts(id) on delete cascade,
  role_id uuid not null references identity.roles(id) on delete cascade,
  scope_type text not null default 'global',  -- 'global' | 'supplier' | 'branch'
  scope_id uuid,
  primary key (account_id, role_id, scope_type, scope_id)
);

-- transactional outbox (§12) — same shape in every module schema
create table identity.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index identity_outbox_unpublished_idx
  on identity.outbox (occurred_at) where published_at is null;

-- RLS (§11): a user reads/updates only their own account row.
alter table identity.accounts enable row level security;
create policy account_reads_own on identity.accounts
  for select to authenticated
  using (auth_user_id = app.auth_user_id());
create policy account_updates_own on identity.accounts
  for update to authenticated
  using (auth_user_id = app.auth_user_id())
  with check (auth_user_id = app.auth_user_id());

-- reference data is world-readable, tenant tables are not
alter table identity.roles enable row level security;
alter table identity.permissions enable row level security;
alter table identity.role_permissions enable row level security;
create policy roles_readable on identity.roles for select to authenticated, anon using (true);
create policy permissions_readable on identity.permissions for select to authenticated, anon using (true);
create policy role_permissions_readable on identity.role_permissions for select to authenticated, anon using (true);

alter table identity.user_roles enable row level security;
create policy user_roles_read_own on identity.user_roles
  for select to authenticated
  using (account_id in (select id from identity.accounts where auth_user_id = app.auth_user_id()));

grant usage on schema identity to anon, authenticated, service_role;
grant select on identity.roles, identity.permissions, identity.role_permissions to anon, authenticated;
grant select, update on identity.accounts to authenticated;
grant select on identity.user_roles to authenticated;
grant all on all tables in schema identity to service_role;
