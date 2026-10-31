-- The client profile, and closing an account.
--
-- `PUT /v1/me` reached four fields — first name, family name, phone, locale.
-- The app's profile screen also has an avatar, an email and a city, and the
-- `dob` column has existed since 0003 with no route that can write it. There
-- was no way to close an account at all, which is both a store-review
-- requirement and the thing a person is most entitled to ask for.

alter table identity.accounts
  /*
    Avatar as (bucket, path), never a URL — same rule as every other image
    in this system (§14). The `avatars` bucket already exists.
  */
  add column if not exists avatar_bucket text,
  add column if not exists avatar_path text,
  add column if not exists city text,
  add column if not exists country char(2),

  /*
    CLOSING AN ACCOUNT IS ANONYMISATION, NOT DELETION.

    A DELETE here would be a lie in both directions. It cannot actually
    remove the person from the system — their name is printed inside signed
    invoice PDFs that may not be altered — and it would cascade through
    orders, reservations, reclamations and reviews, destroying the other
    party's records of transactions they were equally part of. A supplier
    would lose the history of sales they made.

    So the row survives with its identifiers stripped. Everything elsewhere
    references this account by id and reads its NAME from here, so blanking
    these columns anonymises the person everywhere at once — the feed, the
    messages, the reviews — without touching a single other schema.

    WHAT IS DELIBERATELY NOT ANONYMISED: issued documents. An invoice is
    rendered from `documents.payload_snapshot`, a copy of the facts as they
    stood at issue, precisely so it still renders correctly in five years.
    The buyer's name stays printed there, under the number of a gapless
    fiscal series, because that is what makes it a tax document. Erasing the
    name inside a sealed, signed PDF would break its signature; reissuing it
    without the name would make it invalid. Fiscal records outlive a deletion
    request, and this one says so out loud rather than pretending otherwise.
  */
  add column if not exists anonymised_at timestamptz,
  add column if not exists deleted_at timestamptz;

/*
  A closed account must not be found by anything that looks people up.

  Partial, because the overwhelming majority of rows are live and an index
  over all of them to find the few that are not is wasted.
*/
create index if not exists accounts_deleted_idx
  on identity.accounts (deleted_at) where deleted_at is not null;

/*
  The GoTrue user is NOT removed here, and could not be: `auth.users` belongs
  to GoTrue, and identity never writes another schema (§17.4). The effect of
  closing is carried by this row instead — every role assignment is dropped,
  so a sign-in still succeeds and lands on an account that holds no
  permission and therefore reaches no endpoint.

  Removing the credential itself is an operations action against GoTrue's own
  admin API, and belongs with the admin dashboard rather than inside a
  request a user makes about their own data.
*/
