-- Data-driven roles & permissions (§6.1, §11). Idempotent upserts — safe to
-- re-run. Role/permission keys are DATA: adding a role is a seed change, not
-- a code change.

insert into identity.roles (key, label) values
  ('client', 'Client'),
  ('fleet', 'Fleet manager'),
  ('guest', 'Guest'),
  ('supplier_owner', 'Supplier owner'),
  ('branch_manager', 'Branch manager'),
  ('ops_admin', 'Operations admin'),
  ('driver', 'Verified driver')
on conflict (key) do update set label = excluded.label;

insert into identity.permissions (key) values
  ('me.read'), ('me.update'),
  ('vehicle.manage'),
  ('request.create'), ('request.read'), ('request.cancel'),
  ('quote.accept'), ('quote.refuse'),
  ('quote.submit'), ('supplier.requests.read'),
  ('supplier.profile.manage'), ('supplier.catalog.manage'),
  ('order.read'), ('order.create'), ('order.fulfil'), ('order.cancel'),
  ('reservation.create'), ('reservation.manage'),
  ('message.send'),
  ('post.publish'), ('post.interact'),
  ('reclamation.file'), ('reclamation.respond'),
  ('driver.apply'), ('driver.work'),
  ('listing.publish'), ('listing.contact'), ('listing.bid'),
  ('platform.admin')
on conflict (key) do nothing;

-- role → permission map
with role_perm(role_key, perm_key) as (
  values
    ('client', 'me.read'), ('client', 'me.update'),
    ('client', 'vehicle.manage'),
    ('client', 'request.create'), ('client', 'request.read'), ('client', 'request.cancel'),
    ('client', 'quote.accept'), ('client', 'quote.refuse'),
    ('client', 'order.read'), ('client', 'order.create'), ('client', 'order.cancel'),
    ('client', 'reservation.create'),
    ('client', 'message.send'),
    ('client', 'listing.publish'), ('client', 'listing.contact'),

    ('fleet', 'me.read'), ('fleet', 'me.update'),
    ('fleet', 'vehicle.manage'),
    ('fleet', 'request.create'), ('fleet', 'request.read'), ('fleet', 'request.cancel'),
    ('fleet', 'quote.accept'), ('fleet', 'quote.refuse'),
    ('fleet', 'order.read'), ('fleet', 'order.create'), ('fleet', 'order.cancel'),
    ('fleet', 'reservation.create'),
    ('fleet', 'message.send'),

    ('guest', 'request.create'), ('guest', 'request.read'),

    ('supplier_owner', 'me.read'), ('supplier_owner', 'me.update'),
    ('supplier_owner', 'quote.submit'), ('supplier_owner', 'supplier.requests.read'),
    ('supplier_owner', 'supplier.profile.manage'), ('supplier_owner', 'supplier.catalog.manage'),
    ('supplier_owner', 'order.read'),
    ('supplier_owner', 'order.fulfil'), ('supplier_owner', 'order.cancel'),
    ('supplier_owner', 'reservation.manage'),
    ('supplier_owner', 'message.send'),

    ('branch_manager', 'me.read'), ('branch_manager', 'me.update'),
    ('branch_manager', 'quote.submit'), ('branch_manager', 'supplier.requests.read'),
    ('branch_manager', 'supplier.catalog.manage'),
    ('branch_manager', 'order.read'),
    ('branch_manager', 'order.fulfil'), ('branch_manager', 'order.cancel'),
    ('branch_manager', 'reservation.manage'),
    ('branch_manager', 'message.send'),

    ('client', 'post.publish'), ('client', 'post.interact'),
    ('client', 'listing.bid'),
    ('client', 'reclamation.file'), ('client', 'driver.apply'),
    ('fleet', 'post.publish'), ('fleet', 'post.interact'),
    ('fleet', 'listing.bid'),
    ('fleet', 'reclamation.file'), ('fleet', 'driver.apply'),
    ('supplier_owner', 'post.publish'), ('supplier_owner', 'post.interact'),
    ('supplier_owner', 'listing.bid'),
    ('supplier_owner', 'reclamation.file'), ('supplier_owner', 'reclamation.respond'),
    ('supplier_owner', 'driver.apply'),
    ('branch_manager', 'post.publish'), ('branch_manager', 'post.interact'),
    ('branch_manager', 'listing.bid'),
    ('branch_manager', 'reclamation.file'), ('branch_manager', 'reclamation.respond'),
    ('branch_manager', 'driver.apply'),

    -- Granted by DriverVerificationReactor, never seeded onto a person.
    ('driver', 'driver.work'), ('driver', 'driver.apply'),

    ('ops_admin', 'platform.admin')
)
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
from role_perm rp
join identity.roles r on r.key = rp.role_key
join identity.permissions p on p.key = rp.perm_key
on conflict do nothing;
