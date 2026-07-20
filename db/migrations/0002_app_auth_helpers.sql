-- JWT claim helpers usable on ANY Postgres (§11). PostgREST (Supabase) sets
-- request.jwt.claims per-request; RLS tests SET LOCAL it explicitly. We do
-- not depend on the managed-only auth.* helper functions.
create schema if not exists app;

create or replace function app.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function app.auth_user_id() returns uuid
language sql stable as $$
  select nullif(app.jwt()->>'sub', '')::uuid
$$;

create or replace function app.account_id() returns uuid
language sql stable as $$
  select nullif(app.jwt()->>'account_id', '')::uuid
$$;

create or replace function app.supplier_id() returns uuid
language sql stable as $$
  select nullif(app.jwt()->>'supplier_id', '')::uuid
$$;

-- Postgres roles PostgREST switches into. Present on Supabase already;
-- created here so RLS tests run on plain Postgres (CI) identically.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;
