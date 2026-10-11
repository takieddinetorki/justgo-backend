-- `message.send` — the permission gating /v1/conversations.
--
-- Permissions are DATA (§4.6), so a new capability is a migration, not a
-- code change. Seeded here rather than only in seed.sql because seed.sql
-- is idempotent reference data that an existing deployment may not re-run,
-- and the roles below already exist in production-shaped databases.

insert into identity.permissions (key) values ('message.send')
on conflict (key) do nothing;

/*
  Who gets it: everyone who can already be on either side of a trade.

  - client / fleet  — buyers contacting sellers and suppliers
  - supplier_owner / branch_manager — the business replying
  - ops_admin       — holds platform.admin, not per-feature bits

  NOT `guest`: a guest can raise a request but has no durable identity to
  hold a conversation against.
*/
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key = 'message.send'
 where r.key in ('client', 'fleet', 'supplier_owner', 'branch_manager')
on conflict do nothing;
