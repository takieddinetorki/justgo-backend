# Changelog

**This file starts on 2026-10-13.** Phases 0–3 shipped before it existed and are
not reconstructed here — writing entries for work this file did not witness
would be inventing a record rather than keeping one. For that history, read
`git log` and the phase notes in `CLAUDE.md`.

Dates are the day the work landed on `main`. Anything described as *verified*
was exercised against the live deployment at `168.231.87.48`, not only against
the test suite — a distinction this project has earned the hard way.

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
