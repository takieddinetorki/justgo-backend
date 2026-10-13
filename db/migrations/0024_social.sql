-- social bounded context (§7): the community feed — posts with text, photos
-- and video, plus likes and comments.
--
-- The app ships PostVideoPlayerScreen, MediaGalleryScreen, MediaViewerScreen,
-- DashboardCarouselScreen and the `justgo_social` strings against nothing at
-- all: the API logs show zero 404s for any feed route and Kong shows zero
-- /rest/v1/ traffic, so those screens run entirely on local mock state and
-- the snapshot is full of images.unsplash.com placeholders.
create schema if not exists social;

/*
  A POST BELONGS TO AN ACCOUNT, optionally SPEAKING FOR a business.

  The alternative was a post owned by a business, with a separate kind for
  people. That forces two tables, two timeline queries and a union on every
  read, and it cannot express the common case at all: a *fournisseur*'s staff
  member posting a promotion is one human acting for one company, and both
  facts matter — the company for branding, the human for accountability.

  So `author_account_id` is always who actually pressed post, and
  `author_supplier_id` is the business they pressed it on behalf of. The
  account owns the row either way, because a supplier is not a login. This
  mirrors messaging.participants, where the same distinction already exists.
*/
create table social.posts (
  id uuid primary key default gen_random_uuid(),
  author_account_id uuid not null,            -- identity.accounts.id
  author_supplier_id uuid,                     -- suppliers.suppliers.id, when posting as a business
  body text,
  /*
    Denormalised counters. The feed renders a like and comment count on every
    row, and counting two child tables per post turns one query into 1+2N.
    Maintained in the same transaction as the like/comment itself, so they
    cannot drift — never recomputed on read.
  */
  like_count int not null default 0 check (like_count >= 0),
  comment_count int not null default 0 check (comment_count >= 0),
  /*
    `removed` rather than DELETE: a post that someone has commented on or
    reported should stop being visible without taking the surrounding
    conversation, or the evidence, with it.
  */
  status text not null default 'published' check (status in ('published', 'removed')),
  removed_at timestamptz,
  removed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  /*
    A post must say something — text, or at least one media row. That cannot
    be a table constraint: the media lives in a child table inserted in the
    same transaction, so at the moment the post row is written there is
    nothing to check against. The API enforces it before either insert.
  */
  constraint posts_removal_is_explained check (
    (status = 'published' and removed_at is null)
    or (status = 'removed' and removed_at is not null)
  )
);
-- THE feed query: published posts, newest first, keyset-paginated.
create index posts_feed_idx
  on social.posts (created_at desc, id desc)
  where status = 'published';
-- A profile timeline — "everything this account posted".
create index posts_author_idx on social.posts (author_account_id, created_at desc);
-- A business page — "everything posted as this supplier".
create index posts_supplier_idx
  on social.posts (author_supplier_id, created_at desc)
  where author_supplier_id is not null;

/*
  Media lives in rows, not columns, because a post carries several items and
  their ORDER is part of the content — a gallery the author arranged.

  The bytes are not here. The client uploads through POST /v1/media/uploads
  to a private bucket and sends the path; reads go back out as short-lived
  signed URLs (§14). Blobs in Postgres would make every feed page drag
  megabytes.
*/
create table social.post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references social.posts(id) on delete cascade,
  kind text not null check (kind in ('photo', 'video')),
  bucket text not null,
  path text not null,
  /** Video only — lets the client show a length before fetching the file. */
  duration_ms int check (duration_ms is null or duration_ms >= 0),
  ordinal int not null default 0,
  created_at timestamptz not null default now()
);
create index post_media_post_idx on social.post_media (post_id, ordinal);

/*
  One like per account per post, enforced by the primary key rather than by a
  read-then-write. Double-tapping is the normal way people use a like button,
  and two rows would inflate the counter permanently.
*/
create table social.post_likes (
  post_id uuid not null references social.posts(id) on delete cascade,
  account_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (post_id, account_id)
);
-- "Did I like this?" on a feed page, and "what have I liked".
create index post_likes_account_idx on social.post_likes (account_id, created_at desc);

create table social.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references social.posts(id) on delete cascade,
  author_account_id uuid not null,
  author_supplier_id uuid,
  body text not null check (length(btrim(body)) > 0),
  status text not null default 'published' check (status in ('published', 'removed')),
  created_at timestamptz not null default now()
);
create index post_comments_post_idx
  on social.post_comments (post_id, created_at)
  where status = 'published';

create table social.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index social_outbox_unpublished_idx
  on social.outbox (occurred_at) where published_at is null;

-- ── RLS (§11) ───────────────────────────────────────────────────────
-- The feed is PUBLIC-ish: any authenticated account reads any published
-- post. That is what a community feed is. The policies below are the second
-- line of defence for the parts that are not public — authorship.
alter table social.posts enable row level security;
alter table social.post_media enable row level security;
alter table social.post_likes enable row level security;
alter table social.post_comments enable row level security;

create policy posts_published_are_readable on social.posts
  for select to authenticated
  using (status = 'published' or author_account_id = app.account_id());

create policy posts_author_writes on social.posts
  for insert to authenticated
  with check (author_account_id = app.account_id());

-- An author edits or retracts their own post, and nobody else's. Removal by
-- an administrator goes through the API as service_role.
create policy posts_author_updates on social.posts
  for update to authenticated
  using (author_account_id = app.account_id())
  with check (author_account_id = app.account_id());

create policy post_media_follows_post on social.post_media
  for select to authenticated
  using (exists (
    select 1 from social.posts p
     where p.id = social.post_media.post_id
       and (p.status = 'published' or p.author_account_id = app.account_id())
  ));

-- Likes are readable (the count is public anyway) but only ever written as
-- yourself: without the check, anyone could like on someone else's behalf.
create policy post_likes_readable on social.post_likes
  for select to authenticated using (true);

create policy post_likes_own_writes on social.post_likes
  for insert to authenticated
  with check (account_id = app.account_id());

create policy post_likes_own_deletes on social.post_likes
  for delete to authenticated
  using (account_id = app.account_id());

create policy post_comments_published_are_readable on social.post_comments
  for select to authenticated
  using (status = 'published' or author_account_id = app.account_id());

create policy post_comments_own_writes on social.post_comments
  for insert to authenticated
  with check (author_account_id = app.account_id());

grant usage on schema social to authenticated, service_role;
grant select on social.posts, social.post_media, social.post_likes, social.post_comments
  to authenticated;
grant insert on social.posts, social.post_likes, social.post_comments to authenticated;
grant update on social.posts to authenticated;
grant delete on social.post_likes to authenticated;
grant all on all tables in schema social to service_role;

-- ── permissions (§4.6 — permissions are data) ───────────────────────
insert into identity.permissions (key)
values ('post.publish'), ('post.interact')
on conflict (key) do nothing;

/*
  Publishing and interacting are separated because they are different risks.
  A spam post reaches every user in the product; a spam like reaches nobody.
  Splitting them means a future "read-only until verified" state is a
  permission change rather than a code change.

  NOT `guest`: a guest can raise a part request but has no durable identity
  to attach a post to.
*/
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r
  join identity.permissions p on p.key in ('post.publish', 'post.interact')
 where r.key in ('client', 'fleet', 'supplier_owner', 'branch_manager')
on conflict do nothing;
