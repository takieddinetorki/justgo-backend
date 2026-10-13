-- One bon de commande per order, one devis per quote.
--
-- 0021 did this for invoices, where a duplicate is tax fraud by accident.
-- The same reasoning applies to anything carrying a number out of a gapless
-- series: `POST /v1/orders/{id}/purchase-order` is a request a client can
-- repeat by double-tapping, and without this each tap would burn another
-- BC number on the same order.
--
-- The constraint lives here rather than in a service check because two
-- concurrent requests both pass a "does one exist?" read. `issueOnce` treats
-- a violation as "somebody else just made it" and returns that one.
--
-- DELIBERATELY NOT reservation_confirmation: a reservation that is
-- rescheduled and accepted again should produce a second confirmation,
-- because the first one states a date that is no longer true.

create unique index if not exists documents_one_per_subject
  on documents.documents (type, subject_type, subject_id)
  where type in ('purchase_order', 'quotation');
