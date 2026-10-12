-- documents bounded context (§7): every PDF the platform issues, sealed
-- and verifiable.
--
-- One module owns issuance for ALL document types. Not each module
-- rendering its own: the signing key, the hash chain, the verification
-- endpoint and the void registry have to be one thing, or there are N
-- half-verifications and no way to answer "is this real" uniformly.
create schema if not exists documents;

create table documents.documents (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in (
    'reservation_confirmation',
    'quotation',
    'purchase_order',
    'invoice',
    'credit_note',
    'receipt'
  )),

  /*
    Human-facing reference, unique and gapless per (series, year).
    `series` is the type's short code; see the numbering table below.
  */
  series text not null,
  year int not null,
  seq int not null,
  number text not null unique,

  -- What the document is about. A loose reference, never a foreign key:
  -- documents must not depend on six other schemas (§17.4), and a sealed
  -- document outlives whatever it described.
  subject_type text not null,
  subject_id uuid not null,

  issued_to_account_id uuid,
  issued_by_account_id uuid,
  supplier_id uuid,

  -- Where the bytes live. WRITE-ONCE: never overwritten, never deleted.
  bucket text not null,
  path text not null,
  byte_size int not null check (byte_size > 0),

  /*
    Integrity. `sha256` is over the EXACT stored bytes, so verification is
    "re-hash what is in the bucket and compare" with no re-rendering.
  */
  sha256 text not null,
  signature text not null,
  algo text not null default 'ed25519',
  key_id text not null,
  /*
    'detached' — signature stored beside the original bytes (Ed25519 now).
    'embedded' — the signature lives INSIDE the PDF (PAdES, when a
    qualified seal replaces this). The stored bytes are canonical either
    way, which is what lets the signer change without migrating history.
  */
  signature_format text not null default 'detached'
    check (signature_format in ('detached', 'embedded')),

  /*
    Hash chain. One signature proves THIS document is untouched; the chain
    proves nothing was deleted or back-dated, which is the fraud that
    matters for a numbered fiscal series.
  */
  prev_sha256 text,

  /*
    What it was rendered FROM. An invoice must render identically in five
    years, after the order, the prices and the supplier name have all
    changed. Rendering from live data is how documents silently rewrite
    history.
  */
  payload_snapshot jsonb not null,

  status text not null default 'issued' check (status in ('issued', 'void')),
  issued_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,

  -- Voiding must say who and why, or the audit trail is worthless.
  constraint void_is_explained check (
    status = 'issued'
    or (voided_at is not null and voided_by is not null and void_reason is not null)
  ),
  constraint unique_number_per_series unique (series, year, seq)
);

create index documents_subject_idx on documents.documents (subject_type, subject_id);
create index documents_recipient_idx on documents.documents (issued_to_account_id, issued_at desc);
create index documents_chain_idx on documents.documents (series, year, seq desc);

/*
  Gapless numbering. A counter row per (series, year) taken with
  `for update`, NOT a Postgres sequence: sequences deliberately leak
  numbers on rollback, and a fiscal series may not have gaps.
*/
create table documents.number_counters (
  series text not null,
  year int not null,
  next_seq int not null default 1,
  primary key (series, year)
);

create table documents.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz
);
create index documents_outbox_unpublished_idx
  on documents.outbox (occurred_at) where published_at is null;

-- ── RLS (§11) ───────────────────────────────────────────────────────
alter table documents.documents enable row level security;

-- You may read documents issued TO you. Nothing else: a document is
-- evidence about a transaction, not public reference data.
create policy documents_recipient_reads on documents.documents
  for select to authenticated
  using (issued_to_account_id = app.account_id());

-- Issuance, voiding and verification all run through the API with the
-- service role; there is deliberately no client-side write path.
grant usage on schema documents to authenticated, service_role;
grant select on documents.documents to authenticated;
grant all on all tables in schema documents to service_role;
