-- The verified badge — decided by JustGo, never by the business.
--
-- The supplier app draws a blue check beside a shop's name. A badge is only
-- worth anything if the subject cannot award it to itself, so verification
-- is NOT a column a supplier may patch: it is set through
-- `PATCH /v1/supplier/{id}/verification` behind `platform.admin`, and the
-- API has no path that lets an owner's own token reach it.
--
-- This mirrors driver verification (0026) rather than inventing a second
-- shape: a decision, who made it, when, and a note. The difference is that a
-- driver's state machine gates whether they may work at all, while a badge
-- only changes how a business is presented — so this is two timestamps and a
-- note rather than a status enum.

alter table suppliers.suppliers
  -- Null means "not verified". A timestamp rather than a boolean because
  -- "since when" is the first question anyone asks of a badge, and a
  -- boolean would have to be joined to an audit log to answer it.
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by_account_id uuid,
  /*
    The note is for OPS, and it is deliberately not exposed on any public
    read. "Registre de commerce seen, 2026-10-30" is an internal record of
    what was checked; publishing it would leak what documents a business
    handed over.
  */
  add column if not exists verification_note text;

-- "Who is verified" is a filter the directory will want, and a partial
-- index is the right shape: verified suppliers are the minority.
create index if not exists suppliers_verified_idx
  on suppliers.suppliers (verified_at) where verified_at is not null;

/*
  The discovery read model carries the badge too.

  Discovery owns its own schema and never reads suppliers (§17.4), so the
  flag arrives on `suppliers.SupplierUpdated` — the same event that already
  carries a name or a city change. Without it the directory would have to
  join across schemas to draw a check mark, which is exactly the coupling
  the read model exists to avoid.
*/
alter table discovery.supplier_locations
  add column if not exists is_verified boolean not null default false,
  -- Review count beside the average, so a 5.0 from one person does not
  -- render identically to a 4.9 from four hundred.
  add column if not exists rating_count int not null default 0;

create index if not exists supplier_locations_verified_idx
  on discovery.supplier_locations (is_verified) where is_verified;

/*
  NO NEW PERMISSION. Verification is an ops action and `platform.admin`
  already means exactly that. A `supplier.verify` bit would be a second name
  for the same authority, and the first time the two drifted apart somebody
  would hold one and not the other with no rule saying which wins.
*/
