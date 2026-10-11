-- messaging bounded context (§7): conversations between accounts, with
-- photo and voice-note attachments.
--
-- The app ships ConversationsListScreen, MSG_ATTACH_PHOTO and the
-- record_web package (voice notes) with nothing behind them. The only
-- thing resembling messaging today is
-- POST /v1/marketplace/listings/{id}/contact, which is a one-shot
-- "the buyer pinged you" with no reply path.
create schema if not exists messaging;

create table messaging.conversations (
  id uuid primary key default gen_random_uuid(),
  /*
    What the conversation is ABOUT, as a loose reference — never a foreign
    key. A conversation may concern a marketplace listing, a request, an
    order, or nothing at all, and messaging must not take a dependency on
    any of those schemas (§17.4). Nullable context = a plain direct chat.
  */
  context_type text check (context_type in ('listing','request','order')),
  context_id uuid,
  subject text,
  created_by uuid not null,                 -- identity.accounts.id
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);
create index conversations_context_idx
  on messaging.conversations (context_type, context_id)
  where context_id is not null;

create table messaging.participants (
  conversation_id uuid not null references messaging.conversations(id) on delete cascade,
  account_id uuid not null,                 -- identity.accounts.id
  /*
    Set when this participant is speaking AS a business rather than as
    themselves, so the supplier app can show "you, as Garage Benali".
    The account still owns the row — a supplier is not a login.
  */
  supplier_id uuid,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, account_id)
);
-- Drives "my conversations", ordered by recency: the single hottest query.
create index participants_account_idx on messaging.participants (account_id);

create table messaging.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references messaging.conversations(id) on delete cascade,
  sender_account_id uuid not null,
  kind text not null default 'text' check (kind in ('text','photo','voice')),
  body text,
  /*
    Attachments are NOT bytes in this table. The client uploads through
    POST /v1/media/uploads to a private bucket and sends the path; reads
    go back out as short-lived signed URLs (§14). Storing blobs in
    Postgres would make every conversation query drag megabytes.
  */
  attachment_bucket text,
  attachment_path text,
  /** Voice notes only — lets the client draw the waveform before fetching. */
  duration_ms int check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),

  -- A message has to say something: text needs a body, an attachment
  -- needs somewhere to fetch it from.
  constraint messages_payload_present check (
    (kind = 'text'  and body is not null and length(btrim(body)) > 0)
    or (kind in ('photo','voice') and attachment_bucket is not null and attachment_path is not null)
  )
);
-- Message history is always read newest-first within one conversation.
create index messages_conversation_idx
  on messaging.messages (conversation_id, created_at desc, id desc);

create table messaging.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index messaging_outbox_unpublished_idx
  on messaging.outbox (occurred_at) where published_at is null;

-- ── RLS (§11) ───────────────────────────────────────────────────────
-- Everything here is "am I a participant". The API enforces the same rule
-- before it writes; this is the second line of defence.
alter table messaging.conversations enable row level security;
alter table messaging.participants enable row level security;
alter table messaging.messages enable row level security;

create policy conversations_participant_reads on messaging.conversations
  for select to authenticated
  using (exists (
    select 1 from messaging.participants p
     where p.conversation_id = messaging.conversations.id
       and p.account_id = app.account_id()
  ));

create policy participants_reads_own_threads on messaging.participants
  for select to authenticated
  using (exists (
    select 1 from messaging.participants mine
     where mine.conversation_id = messaging.participants.conversation_id
       and mine.account_id = app.account_id()
  ));

create policy messages_participant_reads on messaging.messages
  for select to authenticated
  using (exists (
    select 1 from messaging.participants p
     where p.conversation_id = messaging.messages.conversation_id
       and p.account_id = app.account_id()
  ));

-- A participant may only ever post AS THEMSELVES, into a thread they are
-- in. Without the sender check, a member of the thread could forge a
-- message from the other party.
create policy messages_participant_writes on messaging.messages
  for insert to authenticated
  with check (
    sender_account_id = app.account_id()
    and exists (
      select 1 from messaging.participants p
       where p.conversation_id = messaging.messages.conversation_id
         and p.account_id = app.account_id()
    )
  );

-- Marking your own thread read.
create policy participants_updates_own on messaging.participants
  for update to authenticated
  using (account_id = app.account_id())
  with check (account_id = app.account_id());

grant usage on schema messaging to authenticated, service_role;
grant select on messaging.conversations, messaging.messages to authenticated;
grant select, update on messaging.participants to authenticated;
grant insert on messaging.messages to authenticated;
grant all on all tables in schema messaging to service_role;
