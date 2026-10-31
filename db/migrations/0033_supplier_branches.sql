-- Branches get endpoints.
--
-- `suppliers.branches` has existed since 0004 and `is_multi_branch` is a
-- column on every supplier, but nothing has ever been able to create, list
-- or change a branch. `branchId` could already be minted into a session
-- token — `POST /v1/auth/session` accepts one — for a branch that no route
-- could bring into existence.
--
-- The table is almost complete; what it lacks is a contact block and a
-- stable sort key.

alter table suppliers.branches
  add column if not exists phone text,
  add column if not exists city text,
  add column if not exists country char(2),
  /*
    Branches are listed in a picker, and a picker whose order changes between
    two reads is a picker people mis-tap. `created_at` gives a total order
    with `id` as the tiebreak; defaulting to now() puts whatever rows already
    exist at the front, which for an empty table is no rows at all.
  */
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  /** Closing a branch, for the same reasons a supplier is closed, not deleted. */
  add column if not exists closed_at timestamptz;

create index if not exists branches_supplier_idx
  on suppliers.branches (supplier_id, created_at, id)
  where closed_at is null;

/*
  `is_multi_branch` is now MAINTAINED rather than declared.

  It was a flag the registering supplier set about itself and nothing ever
  checked. Leaving it writable alongside real branch rows means the two can
  disagree — a supplier claiming to be multi-branch with no branches, or the
  reverse — and every screen then has to decide which to believe. It is
  derived from the branch count in the same transaction that changes it.
*/
update suppliers.suppliers s
   set is_multi_branch = exists (
     select 1 from suppliers.branches b
      where b.supplier_id = s.id and b.closed_at is null
   );

/*
  RLS already covers these columns: `branch_owner_all` grants the owning
  account everything on its own branches, and `branches_visible_when_open`
  makes open branches world-readable. A closed branch keeps `is_open` false,
  so it drops out of the public policy without a new one being needed.
*/
