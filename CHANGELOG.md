# Changelog

**This file starts on 2026-10-13.** Phases 0–3 shipped before it existed and are
not reconstructed here — writing entries for work this file did not witness
would be inventing a record rather than keeping one. For that history, read
`git log` and the phase notes in `CLAUDE.md`.

Dates are the day the work landed on `main`. Anything described as *verified*
was exercised against the live deployment at `168.231.87.48`, not only against
the test suite — a distinction this project has earned the hard way.

---

## 2026-11-07

**No image in the product could be displayed, and never could.** Reported as
"images on the blog and when selling a car don't show"; it turned out to be
one missing half of the media design rather than two bugs.

### The defect

Every storage bucket is private — all nine, checked on the box — and the API
never proxies bytes, so the only way to show an image is a short-lived signed
URL. The DTOs return `(bucket, path)` and say so in their own comments: *"The
client asks for a fresh signed URL when it actually needs the bytes."*

**There was nothing to ask.** `POST /v1/media/uploads` existed; no endpoint
ever turned a stored pair back into a URL. `createSignedDownloadUrl` had been
on the media port since Phase 1 with exactly one caller — `documents`, which
is why factures were the only artefact in the system that ever rendered.

The evidence on the dev box, before the fix:

| | |
|---|---|
| `post-media` | 1 object uploaded, 1 row pointing at it, no way to view it |
| `vehicle-photos` | **2 objects uploaded, and every listing stored with `photo_urls = '{}'`** |
| `supplier-media` | 6 objects, same |
| `documents` | 39 objects, and these worked |

Selling a car failed one step earlier than the blog did. `photoUrls` is typed
`z.array(z.string().url())` — it demands an absolute URL, and after an upload
the app holds a (bucket, path) pair and a write-only handle that expires in
two hours. Neither is a URL. So the screen uploaded the photo and then sent no
photo at all, which is why the bytes are on disk with nothing pointing at them.

### Added

- **`POST /v1/media/downloads`** — the missing read side. Batched: send up to
  50 `(bucket, path)` pairs, get signed URLs back, one call to Storage per
  bucket rather than one per image. The URLs need **no headers**, so they go
  straight into an `<img>`; verified against the deployment by fetching one
  with no `Authorization` at all.

  Readable by any signed-in caller for `post-media`, `avatars`,
  `supplier-media`, `vehicle-photos` and `part-photos` — that content is
  already published to people who did not upload it, so restricting it to the
  uploader is the same as not serving it. Only within your own upload
  namespace for `registrations`, `driver-documents` and `message-attachments`.
  `documents` is refused outright: a facture is reached through
  `/v1/documents/{id}/download`, which checks the order behind it, and routing
  it through a generic media endpoint would quietly downgrade that to "holds
  any session".

- **`MediaPort.createSignedDownloadUrls`** — signs a whole list in one POST.
  A feed page is twenty posts; signing one at a time is hundreds of sequential
  round trips before the page can be returned.

### Fixed

- **The blog.** `PostMedia` now carries `url` and `urlExpiresAt`, signed when
  the post is read, in one batch for the page. `(bucket, path)` is still
  returned, because it does not expire and the URL does.

- **Selling a car.** `CreateListing` accepts `photos: [{bucket, path}]`, stored
  in a new `marketplace.car_listings.photos` jsonb column (migration 0034).
  On read, `photoUrls` is filled with signed URLs from those refs followed by
  any absolute URL an older client stored, so **the field the shipped app
  already reads starts working without the app changing**. `photoUrls` stays
  accepted on write and is marked deprecated in the spec.

- Signing never costs the content. If Storage is unreachable the URL is null
  and the post or the listing still arrives — a card with no picture, not an
  empty feed.

- **The OpenAPI upload enum was three buckets short** (`post-media`,
  `driver-documents`, `supplier-media`), so the spec said the API would reject
  calls it has always accepted.

### Verified

The smoke test now ends at the bytes rather than at the row: it uploads a real
PNG through the signed PUT, attaches it to a post and to a car, reads both
back, and fetches the returned URL **with no headers** asserting
`200 image/png` and the right length. Plus: a missing object is a null URL and
not an error, a facture cannot be signed through the media endpoint, somebody
else's identity document cannot either, and a photo uploaded by another
account is refused on a listing.

### Not done here

- **Chat attachments are still invisible**, and it is the same defect.
  `message-attachments` is restricted to your own namespace here, so you can
  see what you sent and not what you received; the correct check is "is a
  participant in this conversation", which lives in the messaging schema and
  therefore needs a route in that module (§17.4). Nothing about the mechanism
  changes, only where the check runs.
- Supplier logos and avatars return `(bucket, path)` and can now be resolved
  through `/v1/media/downloads`, but those DTOs do not yet carry a `url` the
  way posts and listings do.
- The two orphaned objects in `vehicle-photos` are left alone. Nothing records
  which listing they were meant for.

---

## 2026-10-31

Deployed 2026-10-30's work to the dev box and probed the public surface from
outside it, which turned up one defect in the new code and two older ones of
the same shape.

### Fixed

- **A malformed id in a path answered 500 on three PUBLIC routes.** `asId`
  threw a `TypeError`, and a `TypeError` is by definition our bug, not the
  caller's — so the exception filter did the right thing with the wrong
  input and returned `INTERNAL`, with a stack trace in the log, for
  `GET /v1/suppliers/not-a-uuid/reviews`. It now throws `ValidationError`,
  so every `:id` route in the API answers **400** instead, and the log stays
  readable while bots walk the URL space.

  Two of the three did not even reach `asId`: `GET /v1/discovery/suppliers/{id}`
  and `GET /v1/marketplace/listings/{id}` passed the raw path string to
  Postgres, which rejected it as `invalid input syntax for type uuid`. Both
  now narrow the id before the query. Those two have been answering 500 since
  long before this release; the reviews route was a day old.

- **`docs/HOSTING.md` claimed `GET /v1/discovery/suppliers` returns 200 with
  no arguments.** It returns 400, correctly: that route ranks by distance and
  requires `lat`/`lng`. The browse screen's route, where every filter really
  is optional, is `/v1/discovery/directory`. The table now says so, which
  matters because that line is what an integrator tests first.

### Verified

Deployed and re-run on the box: 6 migrations applied, the `supplier-media`
bucket created, both app containers recreated on the new image, and
**194 smoke checks green against the deployment** — including the facture that
survives its buyer closing their account. The smoke test now also asserts the
400 on all three public id routes, so this cannot come back silently.

The dev database holds **12 ghost accounts** from the `/v1/me` defect fixed in
2026-10-30. Nothing here deletes them; the write path that produced them is
closed.

---

## 2026-10-30

The release that makes a profile editable. An audit of the CRUD surface found
that a supplier could be **created and never changed** — `POST /v1/supplier`
wrote a name, a city and a point, `PATCH /v1/supplier/fiscal` reached five
fiscal fields, and that was the entire write surface. The edit pencil in the
shipped supplier app had no endpoint behind it. A client profile reached four
fields, and there was no way to close an account at all.

### Added

**A supplier can edit itself** — `PATCH /v1/supplier/profile`. Name,
description, contact block, address, pin, opening hours, logo and cover.
Images are `{bucket, path}` into the new private `supplier-media` bucket,
never URLs, and a path outside the caller's own upload namespace is refused.
The business is resolved from the token: there is deliberately no route that
names which supplier to edit.

`null` clears a field and an absent key leaves it alone. The fiscal patch
coalesces, because none of its fields may ever be blanked; this one cannot,
because a description that could never be removed once written is a bug.

**Opening hours are jsonb, validated in the domain** — per weekday, zero or
more intervals, because a shop that shuts for lunch has two and Friday may
have none. Overlapping or inverted intervals are rejected rather than merged:
merging would hide a typo (14:00 meant as 16:00) behind a shop that now claims
to be open all afternoon.

**`DELETE /v1/supplier/profile` closes a business** — `closed_at`, never a row
delete. Orders, invoices, reservations and reviews all reference the id, and a
gapless fiscal series may not point at a seller that vanished. `is_open` and
`closed_at` stay separate: a shop shut on a Sunday is not a shop that has gone
out of business.

**The verified badge, decided by JustGo** —
`PATCH /v1/supplier/{id}/verification` under `platform.admin`. It is the only
route that touches the flag, it names the supplier explicitly (unlike every
other write under `/v1/supplier`, which resolves the business from the
caller), and no owner-facing path reaches it. A badge the subject can award
itself tells a reader nothing. Withdrawable, because a business that lost its
registration must not keep the mark saying we checked it. The ops note comes
back on that response and on no other read.

**Reviews, and the rating they produce.** `suppliers.rating` had been selected
by the directory and rendered by the app since the first release, and written
by nothing — null for every supplier in the database.

| | |
|---|---|
| `GET /v1/suppliers/{id}/reviews` | **public**; newest first, with the business's average |
| `GET /v1/suppliers/{id}/reviews/me` | my review, and whether I may write one |
| `POST /v1/suppliers/{id}/reviews` | 1–5 stars, text optional |
| `PATCH /v1/reviews/{id}` · `DELETE /v1/reviews/{id}` | edit or retract my own |
| `POST /v1/reviews/{id}/takedown` | `platform.admin`, with a reason |
| `PUT /v1/reviews/{id}/reply` | the business's single answer |

**Only somebody the business actually served may review it.** An open review
box is a review box full of competitors and bots, and requiring a completed
order or reservation is the only defence that survives contact with a real
market. That evidence lives in `orders` and `reservations`, which this module
may not read (§17.4), so it arrives as events and is kept in `suppliers` own
schema as a read model — which also makes "may I review?" one indexed lookup
instead of a cross-schema join.

One live review per person per business, enforced by a partial unique index
rather than a read-then-write: a competitor with one completed order would
otherwise post the same one star fifty times. Retracting frees the slot, which
is the point when a shop has put something right.

The average moves **in the same transaction as the review**, by a delta rather
than a re-aggregate — `AVG()` per row would turn one directory query into N,
and two concurrent reviews recomputing from the same old value would leave it
permanently wrong. `rating_sum` and `rating_count` are stored because an
average cannot be updated incrementally without them.

The business gets **one** reply per review. A thread would turn every bad
review into an argument conducted in public on the shop's own page; `PUT`
rather than `POST` means a retry cannot create a second one.

**Branches get endpoints** — `GET/POST/PATCH/DELETE /v1/supplier/branches`.
The table has existed since the first schema and `POST /v1/auth/session` has
always accepted a `branchId`, for a branch that nothing could create.
`is_multi_branch` is now **derived** from the open branch count in the same
transaction that changes it, rather than a flag a supplier set about itself
that nothing kept true.

**The client profile reaches the rest of the row** — `PUT /v1/me` gains email,
avatar, city, country and `dob`, which had been a column since the first
schema with no route that could write it. Same null-clears-it rule.

**`DELETE /v1/me` closes an account** — see **A deletion that tells the truth**.

**Posts have a kind, a pin and a share count.** The supplier app draws a chip
on every card and pins one post to the top of a business page; neither existed
in the schema, so the chip was hard-coded in the client and the pin did
nothing. `announcement` (the default, and what every existing post is),
`promotion`, `arrival`, `job`. One pin per business and one per person, with
the previous one released in the same transaction. `POST /v1/posts/{id}/share`
counts rows, not a bare counter a loop could inflate, and is deliberately not
retractable — a share describes something that already happened outside the
product.

Pinned-first paging does **not** reorder the feed query. Ordering by
`pinned_at` would disagree with the `(created_at, id)` keyset and make every
page after the first skip or repeat rows; the pinned post is fetched
separately, excluded from the paged query, and put at the front of page one.

### A deletion that tells the truth

`DELETE /v1/me` **anonymises**. The name, email, phone, date of birth, city
and avatar are blanked and every role is dropped, so the person disappears
from the feed, from messages and from reviews, and the next sign-in reaches
nothing. One write does all of that, because every module stores an account id
and reads the name from identity.

The row survives. A hard delete would cascade through orders, reservations,
reclamations and reviews — records that belong to the **other** party as much
as to this one — and a supplier would lose the history of sales they made.

**Issued documents keep the name they were issued under.** An invoice renders
from a snapshot taken at issue, signed over its exact bytes, under a number in
a gapless fiscal series. Erasing a name inside a sealed PDF would break the
signature that proves nobody has edited it; reissuing it without the name
would make it invalid as a tax document. Fiscal records outlive a deletion
request, and the API says so rather than pretending otherwise — the app should
say it on the confirmation screen too.

Refused with 422 `ACCOUNT_OWNS_BUSINESS` while the account still acts for a
supplier: a business is not personal data, it has invoices and reviews of its
own, and orphaning one would leave a shop in discovery that nobody can answer
for. The GoTrue credential is **not** removed — `auth.users` belongs to
GoTrue, not to this module — so a sign-in still succeeds and then reaches
nothing, which is the same outcome by a route that does not cross a schema
boundary.

### Changed

- **One event keeps the discovery read model current.**
  `suppliers.SupplierUpdated` is emitted by a profile edit, a verification
  decision and a rating recomputation alike, and the index reactor handles it
  with the same code as `SupplierRegistered`. Three event types would mean
  three subscriptions and three chances to disagree about what the row says.
- **Every optional field on that event means *unknown*, not *cleared*.** A
  rating change has no reason to consult the vertical registry, so it carries
  no `categoryKeys` — and without that rule, every review anybody wrote would
  wipe the category coverage that decides which quote requests a supplier is
  shown. The read model coalesces accordingly; `rating` is the one exception,
  because a supplier whose last review is retracted has to go back to *never
  rated*, which is a real null.
- **The directory carries `isVerified` and `ratingCount`**, and takes
  `?verified=true`. A 5.0 from one person must not render identically to a 4.9
  from four hundred.
- **The session's `account` object is built by the shared mapper**, not by a
  hand-written literal beside it. Two literals kept in step by hand is how
  they stop being in step — every field added to `AccountDTO` in this change
  had to be remembered in a second place, and would not have been.
- **`ReviewsService` methods are all `async`**, including the ones whose only
  work is validation. A method that throws synchronously from an async-looking
  signature gives its callers two failure shapes for one failure, and makes
  `expect(...).rejects` silently inapplicable — which is how a validation rule
  ends up asserted nowhere. Caught by the tests in this change.
- **A closed supplier is excluded from quote fan-out.**

### Fixed

Both of these were found by the live smoke test, not by the unit suite — the
first had been shipping for months.

- **`/v1/me` was reading and writing a GHOST ACCOUNT.** `AuthContext.accountId`
  is `account_id ?? sub`: an identity account id when the caller holds a
  JustGo session token, a Supabase auth user id when they hold a raw GoTrue
  one. All three `/v1/me` routes passed it to `ensureAccount`, which keys on
  `auth_user_id` **alone** — so with a session token it inserted a *second*
  account whose `auth_user_id` was the first one's primary key, gave it the
  default role, and returned that. Every call the apps make after the
  exchange carries a session token, so that was every `/v1/me` call: a user's
  name and phone number went onto a row that none of their orders, documents
  or reviews pointed at.

  It passed unnoticed because the ghost was self-consistent — `PUT` then `GET`
  agreed, so nothing looked wrong. The database on the dev box has **four**
  such rows. `/v1/me` now goes through `currentAccount`, which resolves
  **either** id first and self-provisions only on genuine first contact, and
  the smoke test compares `/v1/me`'s id against the id in the session it was
  issued.

  No migration deletes the existing ghosts. They hold no orders and no
  documents, but they are rows a person's data was once written to, and
  deciding what to do with them is not a thing to settle inside an unrelated
  change.

- **An enum-keyed Zod record is EXHAUSTIVE in Zod 4.** `z.record(z.enum([…]))`
  for opening hours demanded all seven weekdays and rejected `{ mon: […] }`
  with six "expected array, received undefined" issues naming days the caller
  never mentioned. `z.partialRecord` keeps the key validation and makes each
  day optional.

- **`pg-discovery.repository.ts` contained a literal NUL byte** (the cursor
  separator), so git classified the file as binary and every diff of it was
  unreviewable. Same byte, written as `\u0000`.

### Migrations

`0028` supplier profile · `0029` supplier verification · `0030` reviews ·
`0031` post kinds, pins and shares · `0032` account profile and closure ·
`0033` branches

33 applied in total. One new permission: `review.write` — its own bit rather
than part of `post.interact`, because a review changes a rating and a like
reaches nobody, and the rating is the first thing anyone will try to game.
Verification deliberately adds **no** permission: `platform.admin` already
means "ops", and a second name for the same authority is a rule nobody can
resolve the first time the two drift apart.

New bucket: `supplier-media` (`pnpm buckets`).

### Verified

`scripts/smoke.mjs` grew from 129 checks to **194**, and the whole run is
green against a live deployment — including the two defects above, which it
found on its first run over this change. New ground it covers: the profile
patch and its null-clears-it rule, opening-hours rejection, branch CRUD with
`isMultiBranch` following the count both ways, the review eligibility gate,
the average moving with the review and back on retraction, the discovery read
model hearing about a rating, post kinds, pins and shares — and that **closing
an account leaves an already-issued facture byte-for-byte intact**, checked
through the public verify endpoint, which re-reads the object and re-hashes it
rather than trusting the stored hash.

One operational note, because it cost an hour of misdiagnosis: the unit suite
and the smoke test **cannot run at the same time**. `bullmq-event-bus.spec.ts`
subscribes on the default `domain-events` queue, which makes the jest process
a competing consumer against the running API — jobs complete, reactors never
see them, and events appear to vanish exactly as they would in a real bug.

### Not done here

- **No public branch list.** A business page cannot yet show its branches to a
  customer; only the owner can read them. It wants a public route on the
  discovery read model rather than a second public path into `suppliers`.
- **Review abuse beyond the eligibility gate.** No rate-based detection, no
  review of reviews. The gate plus `platform.admin` takedown is the whole of
  it for now.
- **Re-opening a closed business** is an ops action with no endpoint.

---

## 2026-10-15

### Added

**Selling a car takes a real spec sheet** — fuel type, transmission, body type,
colour, doors, engine power, condition, owner count, accident history, and two
this market cares about that most templates omit: whether the car is
customs-cleared (*dédouanée*) and whether its papers are in order. All
three-state (`true` / `false` / absent), because "unknown" and "no" are
different answers to a buyer. Browse filters on the ones people actually filter
by.

**Offers against a private acceptance range.** A seller names a range they
would accept; buyers make offers; the seller is notified only when an offer
reaches it.

| | |
|---|---|
| `PUT /v1/marketplace/listings/{id}/offer-range` | opens bidding |
| `DELETE /v1/marketplace/listings/{id}/offer-range` | closes it |
| `POST /v1/marketplace/listings/{id}/bids` | make an offer |
| `GET /v1/marketplace/listings/{id}/bids` | seller: all, best first; buyer: own |
| `GET /v1/marketplace/listings/{id}/private` | the owner view |
| `GET /v1/marketplace/bids` | every offer I made |
| `DELETE /v1/marketplace/bids/{id}` | withdraw mine |
| `POST /v1/marketplace/bids/{id}/accept` | seller accepts |
| `POST /v1/marketplace/bids/{id}/decline` | seller declines |

**The range is private, and that is the security of the whole feature.** A
buyer who can see the floor offers exactly the floor, and every offer above it
is lost. So it is not a column on `car_listings`: Postgres RLS is row-level,
not column-level, and that table is world-readable, so a floor stored there
would be readable by anyone through PostgREST. It lives in its own table with
its own policy; the public reads join it only to learn *whether* offers are
open. Placing an offer does not tell the buyer where it landed either —
otherwise the floor falls to bisection.

**Below the floor is recorded but silent.** That silence is the feature: a
seller pinged for every lowball stops reading the pings, and the one real offer
then arrives in a muted channel. **Above** the range notifies too — a bid over
the top is better news than the range asked for, and a seller not told about
the best offer they received would rightly call that a bug. Both ends
inclusive.

Accepting an offer declines every other live one in the same transaction — one
car, one buyer — and tells those buyers why. It deliberately does **not** mark
the listing sold: a car sale here finishes with paperwork days later, so
claiming the sale at the moment a price is agreed is something the seller then
has to undo.

### Migrations

`0027` marketplace bidding. New permission: `listing.bid`, its own bit rather
than reusing `listing.contact`, so bidding can be withheld from unverified
accounts as a data change.

---

## 2026-10-13

The release that closes the gap between what the shipped Flutter app contains
and what the backend could answer. Everything in `docs/APP-BACKEND-GAP.md` §3
is now built, except driver earnings, which is blocked on decisions that are
not technical — see **Deliberately not built**.

### Added

**Documents — sealed, verifiable PDFs**

Invoices, *devis*, *bons de commande* and reservation confirmations, each hashed
(SHA-256) and signed (Ed25519) over its exact stored bytes and kept in a private
bucket unaltered.

| | |
|---|---|
| `GET /v1/documents` | documents issued to the caller |
| `GET /v1/documents/{id}/download` | short-lived signed URL; the bucket is private |
| `GET /v1/documents/verify/{number}` | **public** — the QR target on every document |
| `POST /v1/documents/verify/{number}` | compares the bytes *you* hold against what we sealed |
| `GET /v1/documents/keys` | **public** — so a third party can verify offline |
| `POST /v1/documents/{id}/void` | `platform.admin`, with a reason |
| `POST /v1/orders/{id}/purchase-order` | the bon de commande for an order |
| `POST /v1/quotes/{id}/document` | the devis for a quote you received |

There is **no endpoint that creates a document from a request body**, and there
will not be one. A signature over client-supplied content certifies nothing — a
supplier could mint a facture for any amount against any NIF with our own key
vouching for it. The two on-demand routes take an id and nothing else; the
server reads what the document says out of its own tables.

`authentic` and `status` are separate questions and a UI must not conflate them.
A voided document still verifies, because voiding never touches the stored bytes.
Voiding is **purely administrative** — no credit note, no accounting entry.

Invoice numbers are gapless per series and year (`FA-2026-000001`), which is what
a fiscal series requires. The facture carries the mentions Algerian law makes
mandatory, and issuance **refuses** rather than emit a non-compliant one when the
seller's NIF, NIS, RC or *article d'imposition* is missing.

**The order lifecycle** — `PATCH /v1/orders/{id}/status`,
`POST /v1/orders/{id}/cancel`. `completed` had been unreachable since Phase 1:
the state machine described it and `changeStatus` sat on the port, but nothing
called either, so every order in the database stayed at `created` forever.

**Services Directory** — `GET /v1/discovery/directory`. Every parameter optional,
**including location**, which is the whole point: `/discovery/suppliers` demands
a lat/lng that a user may never have granted. Fuzzy name search, keyset
pagination. A separate route on purpose, so the shipped APK is not broken.

**Messaging** — conversations with text, photos and voice notes, read receipts,
and idempotent conversation creation per (participants, context).

**Social feed** — `/v1/feed`, posts with up to ten media items, idempotent likes,
comments, author retraction and administrative takedown.

**Reclamations** — a complaint case machine with a thread both sides can answer
in, photo evidence, and internal ops notes neither party can see.

**Driver identity and KYC** — apply, attach a licence photo and a selfie, submit,
an ops review queue, a verification decision, and availability for dispatch.
`driver.work` is granted by a reactor **on verification** and revoked on
suspension, because being allowed to drive is the outcome of a check rather than
something a role hands out at signup.

**Rate limiting** — 600/min by default, tighter on public reads and content
creation. Keyed on a hash of the bearer token rather than the address: Algerian
carriers use CGNAT heavily, so one public address fronts many real users and an
IP-keyed limit tight enough to stop abuse would lock all of them out at once.

**Nightly backups** — `scripts/backup-db.sh` at 02:17, 14 days, verified before
it publishes a filename and rotating only after a verified write, so a failed run
never evicts a good backup.

**Four verification scripts**, because this codebase has repeatedly shipped
defects that every unit test passed:

- `scripts/smoke.mjs` — 79 checks across the whole product against a live
  deployment. **It found four defects on its first run.**
- `scripts/verify-backup-restores.sh` — restores the newest backup into a
  throwaway container and compares it row for row against the live database.
  **It found that the backups did not restore a single user account.**
- `scripts/verify-rate-limits.mjs` — proves the limiter bites, and that two users
  behind one address do not share a bucket.
- `scripts/verify-driver-verification.mjs` — the ops decision path, which
  `smoke.mjs` deliberately stops short of because it would need
  `platform.admin`.

**An OpenAPI coverage gate** — `test/architecture/src/lib/openapi-coverage.spec.ts` fails
the build on a route with no documentation, and on a documentation block matching
no route.

### Changed

- **The facture is issued on order completion, not creation.** Issuing at
  creation put a numbered invoice into a gapless fiscal series for every order a
  client later abandoned, and such a number can only be voided by hand, never
  deleted.
- **A quoted amount is treated as TTC.** The client agreed to that figure, so HT
  and TVA are derived backwards from it; TVA is the remainder, so `ht + tva` equals
  the total for every possible input rather than disagreeing by a unit.
- **The OpenAPI spec went from 26 documented operations to 102 of 103.** Paths
  were always reflected off the controllers, so nothing was ever missing from
  `/v1/docs` — but request bodies are validated with zod rather than class DTOs,
  so there is nothing to reflect *into* an operation and every schema is attached
  by hand. 53 endpoints had shipped as a bare verb and path.
- **`DocumentsModule` is global**, so `orders` and `requests` can issue documents.
- **`INTEGRATION_GUIDE.md`** gains messaging, documents, the social feed, the
  directory and the fiscal endpoint. It had been untouched since September.

### Fixed

- **A duplicate NIF returned a bare 500** with a Postgres constraint name in the
  log. Fiscal identifiers are unique per company by law, so a collision is a typo
  or an attempt to invoice under someone else's registration, and the user has to
  be told *which* field. Now `409 FISCAL_IDENTIFIER_TAKEN`.
- **The documented upload response was wrong** — `url`, where the API returns
  `uploadUrl`, `token` and `expiresInSeconds`. An integrator following the spec
  would have had an undefined URL.
- **Invoice issuance was silently failing.** `formatMoney` grouped thousands with
  U+202F, the narrow no-break space French typography wants; pdf-lib's standard
  fonts are WinAnsi-encoded and cannot represent it, so the renderer threw inside
  a reactor where nobody was watching.
- **`backup-db.sh --verify` checked the wrong file.** Its glob also matched the
  globals dump, so it applied database-dump rules to the 1.7 KB roles file and
  reported a healthy backup as broken.
- **The API crash-looped on one deploy** — see **Incidents**.

### Deliberately not built

**Driver earnings.** `DriverEarningsScreen` ships in the app and will stay empty
until three questions are answered, because every one of them changes what a
driver is owed:

1. Who sets the price of a roadside job — the driver, the platform, or a tariff
   per service type?
2. What commission does JustGo take, and is it a percentage, a flat fee per job,
   or a subscription?
3. When is money captured, and by whom — or is it cash in hand between driver and
   customer?

These are spec §21 #3/#4 and they are **product decisions**. A number invented
here would be acted on by a real driver and then contradicted by the first real
payout run, which is worse than an empty screen.

**`credit_note` (avoir).** Settled: voiding stays purely administrative. The
series code and numbering exist; nothing issues one.

**`receipt`.** Waits on payments — a receipt attests that money moved.

### Incidents

**The rate-limiting deploy took the API down for roughly ten minutes.** The guard
subclassed `ThrottlerGuard`; Nx configures `swc-loader` with `loose: true` and no
`jsc.target`, so SWC falls back to ES5 and compiles `class extends` into prototype
calls, which cannot construct a native class from a package shipping modern
output. `tsc`, 16 unit tests and lint were all green — none of them see the
webpack bundle. Fixed by passing a plain tracker function instead of subclassing.

**That same loader config is the shared root cause of four defects now**, the
others being three separate occasions where spreading a `Set` or a `Map` iterator
silently produced `[{}]` in the bundle only. Setting `jsc.target` is outstanding
and deserves its own change with a full smoke run behind it.

There was **no image to roll back to** — the build overwrites `justgo-app:dev` and
the previous image had been pruned, so the only way out was a full rebuild. The
box now keeps `justgo-app:rollback`.

### Known blockers, not in this repo

- **The package id is `com.example.just_go`.** Google Play rejects `com.example.*`
  and it cannot be changed after release. App-side, before any submission.
- **The app does not re-exchange its session after a GoTrue refresh** — 497 × 401
  in the logs. App-side; the backend needs nothing.
- **No TLS**, no domain. Passwords, tokens, invoices and licence photos cross the
  internet in cleartext. Caddy already runs on the box for another tenant, so this
  is a DNS record and a vhost.
- **No email.** SMTP is `fake_mail_user`, so there is no password reset and a user
  who forgets theirs is locked out permanently.
- **The signing key and the backups live only on that box.** Lose it and every
  invoice ever issued becomes unverifiable, which cannot be repaired afterwards.
- **GoTrue sign-up is unthrottled** — it goes through Kong and never reaches the
  API.
- **The catalogue runs on fixtures** — no TecDoc credentials.

### Migrations

`0022` order lifecycle permissions · `0023` one document per subject ·
`0024` social · `0025` reclamations · `0026` drivers

27 applied in total. New permissions: `order.fulfil`, `order.cancel`,
`post.publish`, `post.interact`, `reclamation.file`, `reclamation.respond`,
`driver.apply`, `driver.work`. New role: `driver`, granted only by a reactor.
