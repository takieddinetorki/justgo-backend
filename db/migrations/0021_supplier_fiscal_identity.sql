-- Fiscal identity for suppliers, so a facture can carry the mentions
-- Algerian law requires of it.
--
-- A facture that omits the seller's NIF, NIS, RC or article d'imposition
-- is not a valid tax document, so `documents` REFUSES to issue one when
-- these are absent rather than emitting something that looks official and
-- is not. That is why they are nullable here but mandatory there: an
-- existing supplier is not broken by this migration, it simply cannot be
-- invoiced until it completes its profile.

alter table suppliers.suppliers
  -- Numéro d'Identification Fiscale
  add column if not exists nif text,
  -- Numéro d'Identification Statistique
  add column if not exists nis text,
  -- Registre de Commerce
  add column if not exists rc text,
  -- Article d'imposition
  add column if not exists tax_article text,
  -- Legal name, where it differs from the trading name shown in the app
  add column if not exists legal_name text;

-- A tax identifier is only useful if it identifies ONE entity. Partial
-- indexes so the many suppliers without one yet do not collide on null.
create unique index if not exists suppliers_nif_unique
  on suppliers.suppliers (nif) where nif is not null;
create unique index if not exists suppliers_rc_unique
  on suppliers.suppliers (rc) where rc is not null;

/*
  One invoice per order, enforced in the database.

  The reservation reactor can tolerate a redelivered event minting a
  second confirmation; an invoice cannot. Duplicate factures for one sale
  is tax fraud by accident, and at-least-once delivery makes it a matter
  of time rather than chance.

  Scoped to invoices and credit notes: other types may legitimately be
  re-issued for the same subject.
*/
create unique index if not exists documents_one_invoice_per_subject
  on documents.documents (type, subject_type, subject_id)
  where type in ('invoice', 'credit_note');
