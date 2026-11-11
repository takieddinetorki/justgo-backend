-- A facture for EVERY paid interaction, which first means every paid
-- interaction has to carry a price.
--
-- Until now exactly one did. `orders.orders.amount_minor` comes off the
-- accepted quote, and completing an order issues a facture. The other two
-- things a supplier gets paid for recorded no money at all:
--
--   reservations.reservations      a workshop service, completed, unpriced
--   assistance.assistance_requests a tow or a jump start, completed, unpriced
--
-- So the service was performed, the client paid at the counter, and the
-- platform held no record a facture could be built from. Nothing was wrong
-- with the documents pipeline; there was simply no amount to put in one.
--
-- WHY THE AMOUNT ARRIVES AT COMPLETION, NOT AT BOOKING. A workshop does not
-- know the bill when it accepts the appointment — it knows it when the car
-- is back on the ground. A tow's price depends on the distance actually
-- driven. Booking-time pricing would have meant either guessing or
-- re-writing the figure later, and a facture must be built from what was
-- charged, once, at the moment the supply is finished.
--
-- The platform does NOT take the money. It records what the supplier
-- charged so the client gets a sealed, verifiable facture for it; the
-- payment itself happens between them (§21 open question).

alter table reservations.reservations
  add column amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  add column currency char(3),
  -- When the amount was stated. Separate from the status change, because a
  -- supplier may complete the job first and price it minutes later.
  add column charged_at timestamptz;

-- A currency with no amount, or an amount with no currency, is a bug that
-- reaches the facture renderer as a blank line. Refuse it at the table.
alter table reservations.reservations
  add constraint reservation_amount_needs_currency check (
    (amount_minor is null and currency is null)
    or (amount_minor is not null and currency is not null)
  );

alter table assistance.assistance_requests
  add column amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  add column currency char(3),
  add column charged_at timestamptz;

alter table assistance.assistance_requests
  add constraint assistance_amount_needs_currency check (
    (amount_minor is null and currency is null)
    or (amount_minor is not null and currency is not null)
  );
