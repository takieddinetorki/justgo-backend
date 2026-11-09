-- The hash that goes ON the document, and that verification looks up.
--
-- `sha256` is over the stored PDF bytes. It cannot be printed on the
-- document: printing it changes the bytes it is a hash of. So it can
-- only ever be used by comparing a file the holder already has against
-- the registry — which is a real check, and not one anybody performs
-- from a paper facture in their hand.
--
-- `content_hash` is over what the document SAYS: its number, its type,
-- its issue instant, its position in the chain, and the exact payload it
-- was rendered from. That is computable before the PDF exists, so it can
-- be printed on the page and encoded in the QR, and it is just as
-- sensitive to content — one comma in a line description changes it
-- completely.
--
-- The two are complementary, not alternatives. content_hash answers "is
-- this document real, and what is its status". sha256 answers "is the
-- file in my hand the one you sealed".

alter table documents.documents
  add column if not exists content_hash text;

/*
  NULLABLE, because documents issued before this migration do not have
  one and cannot be given one here: the digest needs canonical JSON,
  which is not something to reimplement in SQL and keep in step with the
  TypeScript forever. Those documents carry their NUMBER in their printed
  QR and keep verifying by it, which is why the verify route resolves
  either. Every document issued from now on has a content hash.
*/
alter table documents.documents
  drop constraint if exists content_hash_is_sha256;
alter table documents.documents
  add constraint content_hash_is_sha256
  check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$');

/*
  UNIQUE, so "no two documents share a hash" is a fact the database
  refuses to break rather than a property we believe we computed
  correctly. Nulls do not collide in a Postgres unique index, so the
  legacy rows coexist.

  A collision here would mean either a repeated document number — the
  gapless counter and `unique_number_per_series` already forbid that —
  or a SHA-256 collision. Either one should fail an insert loudly.
*/
create unique index if not exists documents_content_hash_idx
  on documents.documents (content_hash);

comment on column documents.documents.content_hash is
  'SHA-256 over the canonical content (number, type, issued_at, prev_sha256, payload). Printed on the document and encoded in its QR.';
