-- What the feed in the supplier app actually shows: a labelled post, a
-- pinned one at the top of a business page, and a share count beside the
-- like and the comment.
--
-- 0024 built posts as one undifferentiated stream. The shipped supplier app
-- puts a chip on every card ("Announcement") and pins one post to the top of
-- a shop's page — neither of which the schema could express, so the chip is
-- hard-coded in the client and the pin does nothing.

/*
  `kind` is a CHECK, not a lookup table.

  These four are a presentation taxonomy — they change what chip is drawn and
  what a filter offers, nothing else. A table would imply they are tenant
  data that somebody administers, and the first consequence would be a feed
  query joining to it on every page for a label the client already has
  translated.

  Defaulted to 'announcement' so every post that already exists stays valid
  and keeps rendering exactly as it does today.
*/
alter table social.posts
  add column if not exists kind text not null default 'announcement'
    check (kind in ('announcement', 'promotion', 'arrival', 'job'));

/*
  Pinning.

  `pinned_at` rather than a boolean, because the only interesting question
  after "is it pinned" is "since when" — and an ordering column lets a future
  "pin up to three" relax the unique index below without a data migration.
*/
alter table social.posts
  add column if not exists pinned_at timestamptz;

/*
  ONE PINNED POST PER AUTHOR, and separately one per business.

  Two partial unique indexes rather than one, because a post has two possible
  owners: a person pins on their own timeline, a business pins on its page.
  The supplier-scoped index covers only rows that speak for a business; the
  account-scoped one covers only rows that do not, so a staff member pinning
  a company post does not consume their personal pin.
*/
create unique index if not exists posts_one_pin_per_supplier_idx
  on social.posts (author_supplier_id)
  where pinned_at is not null and author_supplier_id is not null and status = 'published';

create unique index if not exists posts_one_pin_per_account_idx
  on social.posts (author_account_id)
  where pinned_at is not null and author_supplier_id is null and status = 'published';

-- A business page reads "pinned first, then newest".
create index if not exists posts_supplier_pinned_idx
  on social.posts (author_supplier_id, pinned_at desc nulls last, created_at desc)
  where status = 'published';

-- Browsing one kind — "promotions near me" is the obvious first filter.
create index if not exists posts_kind_idx
  on social.posts (kind, created_at desc)
  where status = 'published';

/*
  Shares are counted from ROWS, like likes, not from a bare counter the
  client increments.

  A naked counter is a number anyone can inflate by calling the endpoint in a
  loop, and there is then no way to tell a real reach number from a scripted
  one or to recover the true value. One row per (post, account) makes the
  count idempotent by construction and keeps the counter correct under
  retries, which on a share sheet are constant — people tap, cancel, tap
  again.

  A share is deliberately NOT retractable: unlike a like, it describes
  something that already happened outside the product.
*/
create table social.post_shares (
  post_id uuid not null references social.posts(id) on delete cascade,
  account_id uuid not null,
  /** Where it went. Null when the client did not say. */
  channel text check (channel is null or channel in ('link', 'whatsapp', 'facebook', 'other')),
  created_at timestamptz not null default now(),
  primary key (post_id, account_id)
);
create index post_shares_account_idx on social.post_shares (account_id, created_at desc);

alter table social.posts
  add column if not exists share_count int not null default 0 check (share_count >= 0);

-- ── RLS (§11) ───────────────────────────────────────────────────────
alter table social.post_shares enable row level security;

-- The count is public anyway; who shared is not interesting enough to hide
-- and is useful to the author. Writes are only ever as yourself.
create policy post_shares_readable on social.post_shares
  for select to authenticated using (true);

create policy post_shares_own_writes on social.post_shares
  for insert to authenticated
  with check (account_id = app.account_id());

grant select on social.post_shares to authenticated;
grant insert on social.post_shares to authenticated;
grant all on social.post_shares to service_role;

/*
  NO NEW PERMISSION. Sharing and pinning are `post.interact` and
  `post.publish` respectively — a share is an interaction with somebody
  else's post, and pinning is something only the author of a post can do to
  their own.
*/
