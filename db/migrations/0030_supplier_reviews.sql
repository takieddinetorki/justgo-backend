-- Reviews and the star rating.
--
-- `suppliers.suppliers.rating` has existed since 0004 and has never been
-- written by anything. The directory selects it, the app renders it, and it
-- is null for every supplier in the database. This is where the number comes
-- from.
--
-- Reviews live in the `suppliers` schema rather than in a context of their
-- own because what is being reviewed IS the supplier aggregate: the rating
-- is a column on that row, maintained in the same transaction as the review
-- that changed it, which a separate schema could not do without either a
-- cross-schema write (forbidden, §17.4) or an eventually-consistent average
-- that disagrees with the reviews listed beneath it.

create table suppliers.reviews (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers.suppliers(id) on delete cascade,
  author_account_id uuid not null,              -- identity.accounts.id

  /*
    1 to 5, integer. Not a numeric: a half-star average is a presentation
    choice, but a half-star VOTE makes two scales (some clients send 4.5,
    some 4) and the average then depends on which app you used.
  */
  rating int not null check (rating between 1 and 5),
  -- Optional. A star with no words is still a review.
  body text,

  /*
    What this review is EVIDENCE OF. Copied from the eligibility row that
    allowed it, so a review can still say "verified purchase" after the
    order it came from has been archived.
  */
  source text not null check (source in ('order', 'reservation')),
  source_id uuid not null,

  status text not null default 'published' check (status in ('published', 'removed')),
  removed_at timestamptz,
  removed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint reviews_removal_is_explained check (
    (status = 'published' and removed_at is null)
    or (status = 'removed' and removed_at is not null)
  )
);

/*
  ONE LIVE REVIEW PER PERSON PER BUSINESS, enforced here rather than by a
  read-then-write. Without it, a competitor with one completed order can post
  the same one star fifty times and the average is theirs. Editing an
  existing review is a PATCH; it does not create a second row.

  Partial on `published` so that retracting a review frees the slot — which
  is what lets somebody who had a bad experience, complained, and was then
  looked after write a new one.
*/
create unique index reviews_one_per_author_idx
  on suppliers.reviews (supplier_id, author_account_id)
  where status = 'published';

-- THE listing query: a business page, newest first, keyset-paginated.
create index reviews_supplier_idx
  on suppliers.reviews (supplier_id, created_at desc, id desc)
  where status = 'published';
create index reviews_author_idx on suppliers.reviews (author_account_id, created_at desc);

/*
  The business's right of reply.

  One reply per review, and only from the business being reviewed. A thread
  would turn every bad review into an argument conducted in public on the
  shop's own page; a single answer is enough to say "we refunded this" and
  stops there by construction.
*/
create table suppliers.review_replies (
  review_id uuid primary key references suppliers.reviews(id) on delete cascade,
  supplier_id uuid not null references suppliers.suppliers(id) on delete cascade,
  author_account_id uuid not null,
  body text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/*
  WHO MAY REVIEW: somebody this business actually served.

  An open review box is a review box full of competitors and bots, and the
  only defence that survives contact with a real market is requiring a
  completed dealing. The evidence lives in `orders` and `reservations`, which
  this module may not read (§17.4) — so it arrives as events and is kept
  here, in suppliers' own schema, as a read model.

  Keyed per (account, supplier, source, source_id): a second completed order
  does not grant a second review — the unique index above stops that — but it
  does keep the right to review alive if the first one is ever purged.
*/
create table suppliers.review_eligibility (
  account_id uuid not null,
  supplier_id uuid not null,
  source text not null check (source in ('order', 'reservation')),
  source_id uuid not null,
  completed_at timestamptz not null default now(),
  primary key (account_id, supplier_id, source, source_id)
);
create index review_eligibility_lookup_idx
  on suppliers.review_eligibility (account_id, supplier_id);

/*
  The average, maintained in the SAME TRANSACTION as the review.

  Not recomputed on read: the directory pages hundreds of suppliers and an
  AVG() per row turns one query into N. Not a nightly job either — a shop
  that answers a complaint and earns a five star an hour later should see it.

  `rating_sum` and `rating_count` are kept rather than just the average,
  because an average cannot be updated incrementally without them: changing
  a 2 into a 5 needs the old value and the count, and re-deriving those from
  the rows is the scan these columns exist to avoid.
*/
alter table suppliers.suppliers
  add column if not exists rating_count int not null default 0 check (rating_count >= 0),
  add column if not exists rating_sum int not null default 0 check (rating_sum >= 0);

-- ── RLS (§11) ───────────────────────────────────────────────────────
alter table suppliers.reviews enable row level security;
alter table suppliers.review_replies enable row level security;
alter table suppliers.review_eligibility enable row level security;

-- Published reviews are public: a rating nobody can read is not a rating.
create policy reviews_published_are_readable on suppliers.reviews
  for select to anon, authenticated
  using (status = 'published' or author_account_id = app.account_id());

create policy reviews_author_writes on suppliers.reviews
  for insert to authenticated
  with check (author_account_id = app.account_id());

create policy reviews_author_updates on suppliers.reviews
  for update to authenticated
  using (author_account_id = app.account_id())
  with check (author_account_id = app.account_id());

create policy review_replies_readable on suppliers.review_replies
  for select to anon, authenticated using (true);

-- Only the reviewed business may answer, and only as itself.
create policy review_replies_owner_writes on suppliers.review_replies
  for all to authenticated
  using (supplier_id in (select id from suppliers.suppliers where owner_account_id = app.account_id()))
  with check (supplier_id in (select id from suppliers.suppliers where owner_account_id = app.account_id()));

/*
  Eligibility is NOT public. It is a list of who bought what from whom, and
  exposing it would turn a review page into a customer list. Readable only
  by the person it concerns; written only by the reactor, as service_role.
*/
create policy review_eligibility_reads_own on suppliers.review_eligibility
  for select to authenticated
  using (account_id = app.account_id());

grant select on suppliers.reviews, suppliers.review_replies to anon, authenticated;
grant select on suppliers.review_eligibility to authenticated;
grant insert, update on suppliers.reviews to authenticated;
grant insert, update, delete on suppliers.review_replies to authenticated;

-- ── permissions (§4.6 — permissions are data) ───────────────────────
insert into identity.permissions (key) values ('review.write')
on conflict (key) do nothing;

/*
  Its own bit, not `post.interact`.

  A review changes a business's rating and sits on its page for good; a like
  reaches nobody. Separating them means "accounts under review may comment
  but may not rate" is a data change rather than a code change — and the
  rating is the first thing anyone will try to game.

  Suppliers hold it too: a garage buying parts from a parts dealer is that
  dealer's customer, and the eligibility rule already decides whether any
  given person may review any given business.
*/
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key = 'review.write'
 where r.key in ('client', 'fleet', 'supplier_owner', 'branch_manager')
on conflict do nothing;
