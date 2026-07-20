-- Phase 0 demo module: proves the outbox → relay → bus pipeline (§12, §19).
-- Every module schema gets an outbox table of EXACTLY this shape.
create schema if not exists demo;

create table if not exists demo.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists outbox_unpublished_idx
  on demo.outbox (occurred_at)
  where published_at is null;
