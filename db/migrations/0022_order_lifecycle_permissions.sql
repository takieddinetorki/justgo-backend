-- `order.fulfil` and `order.cancel` — the permissions that let an order
-- actually move.
--
-- The state machine in libs/platform/orders/src/domain/order-state.ts has
-- described created -> confirmed -> in_progress -> completed since Phase 1,
-- and `changeStatus` has existed on OrdersPort just as long. Nothing ever
-- called it: there was no endpoint, so every order in the database sat at
-- `created` forever and `completed` was unreachable. That is why the invoice
-- had to be issued on creation.
--
-- Permissions are DATA (§4.6), so a new capability is a migration rather than
-- a code change. Seeded here as well as in seed.sql because seed.sql is
-- reference data an existing deployment may never re-run.

insert into identity.permissions (key)
values ('order.fulfil'), ('order.cancel')
on conflict (key) do nothing;

/*
  WHO ADVANCES AN ORDER. `order.fulfil` is the supplier's: they are the ones
  who confirm they can supply, start the work and finish it. A client holding
  it could mark their own order complete, which is the one thing the status is
  supposed to attest.
*/
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key = 'order.fulfil'
 where r.key in ('supplier_owner', 'branch_manager')
on conflict do nothing;

/*
  WHO CANCELS. Both sides, because either can discover the sale cannot
  happen — the client changed their mind, or the supplier has no stock after
  all. The state machine still refuses it once the order is completed or
  already cancelled, so holding the bit is not the same as being able to use
  it at any moment.
*/
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key = 'order.cancel'
 where r.key in ('client', 'fleet', 'supplier_owner', 'branch_manager')
on conflict do nothing;
