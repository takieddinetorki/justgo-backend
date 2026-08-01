-- Fix: identity.user_roles used a composite PK containing scope_id, but PK
-- columns are implicitly NOT NULL — which made it impossible to assign a
-- GLOBAL role (scope_id is null by definition). Replace the PK with a
-- surrogate key plus a null-safe uniqueness rule.
alter table identity.user_roles drop constraint user_roles_pkey;

alter table identity.user_roles
  add column if not exists id uuid primary key default gen_random_uuid();

-- one assignment per (account, role, scope); NULL scope_id collapses to a
-- sentinel so global grants are deduped too
create unique index user_roles_assignment_idx
  on identity.user_roles (
    account_id,
    role_id,
    scope_type,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
