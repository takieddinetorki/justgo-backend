-- The issuer's own copy.
--
-- `documents.documents.supplier_id` has been written since 0020 and read by
-- nothing. Every facture the platform issues is listed and downloadable by
-- the CLIENT it was issued to, and invisible to the business that issued it:
-- `listForAccount` filters on issued_to_account_id, and `downloadUrl`
-- answers 404 to anyone else.
--
-- That is the wrong way round for a facture. The issuer is the party the
-- document commits — it carries their NIF, their NIS, their RC and their
-- article d'imposition — and a copy of every one they have issued is their
-- own sales ledger. A business being unable to retrieve its own invoices is
-- not a missing convenience.
--
-- Mirrors documents_recipient_idx, for the same query shape read from the
-- other side.
create index documents_issuer_idx
  on documents.documents (supplier_id, issued_at desc)
  where supplier_id is not null;

-- A business listing factures only, which is the common case, should not
-- walk every confirmation it has ever issued to find them.
create index documents_issuer_type_idx
  on documents.documents (supplier_id, type, issued_at desc)
  where supplier_id is not null;
