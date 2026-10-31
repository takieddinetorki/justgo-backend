-- The supplier profile a *fournisseur* can actually EDIT.
--
-- Until now a supplier could be created and never changed. `POST /v1/supplier`
-- wrote name, city, country and a point; `PATCH /v1/supplier/fiscal` reached
-- the five fiscal fields; and that was the entire write surface. The shipped
-- supplier app draws an edit pencil on a profile screen with a logo, a cover
-- photo, a description, opening hours and a contact block — none of which had
-- a column, let alone a route. A business that moves premises, changes its
-- phone number or closes for August had no way to say so.
--
-- Every column here is nullable or defaulted, so no existing supplier is
-- invalidated by this migration.

alter table suppliers.suppliers
  -- The "about" text on a business page. Separate from `profile jsonb`,
  -- which is vertical-specific plug-in data nobody renders as prose.
  add column if not exists description text,
  add column if not exists phone text,
  add column if not exists email text,

  /*
    Logo and cover live as (bucket, path) pairs, never as URLs.

    A stored URL is a signed URL that expires, or a public URL that defeats
    the private-bucket rule the whole media design rests on (§14). The client
    uploads through POST /v1/media/uploads and sends back the path; reads go
    out as short-lived signed URLs.
  */
  add column if not exists logo_bucket text,
  add column if not exists logo_path text,
  add column if not exists cover_bucket text,
  add column if not exists cover_path text,

  /*
    Opening hours as jsonb, not seven pairs of columns.

    The shape the app needs is "per weekday, zero or more open intervals" —
    a shop that shuts for lunch has two, Friday may have none, and Ramadan
    hours are a different set again. Columns cannot express a variable number
    of intervals without a child table that is only ever read whole, and
    nothing queries hours in SQL: the client renders them and the directory
    does not filter on them. Validated in code against a documented shape.
  */
  add column if not exists hours jsonb,

  /*
    Closing a business is `closed_at`, never a DELETE.

    Orders, invoices, reservations and reviews all reference a supplier by
    id, and a gapless fiscal series cannot point at a seller that vanished.
    `is_open` already exists but means "open right now" — a shop that is shut
    on a Sunday is not a shop that has gone out of business, and collapsing
    the two would make an August holiday indistinguishable from a closure.
  */
  add column if not exists closed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- A closed business is out of discovery and out of the directory. The
-- partial index on (vertical_key) where is_open already exists; this one
-- keeps "my live suppliers" cheap for ops.
create index if not exists suppliers_closed_idx
  on suppliers.suppliers (closed_at) where closed_at is not null;

/*
  `suppliers.suppliers` already had an owner-writes-everything RLS policy
  (`supplier_owner_all`), so the new columns are covered by it. Nothing here
  widens visibility: the public policy is still `select … using (is_open)`,
  and closing a business sets is_open false along with closed_at.
*/
