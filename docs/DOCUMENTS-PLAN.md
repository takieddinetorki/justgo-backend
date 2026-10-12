# Signed documents — investigation and plan

Two separate things in one brief: a live bug stopping quotations reaching
suppliers, and a new document/PDF subsystem. **Nothing here is
implemented.**

---

# Part 1 — Quotations never reach suppliers

## Diagnosed: a dependency-injection scope error

**The core loop has never worked through the running application.**

Evidence from the live server:

| | |
|---|---|
| `requests.part_requests` | 21 **expired**, 4 pending |
| `requests.quotes` | **0 rows, ever** |
| `requests.outbox` | 25 `RequestSubmitted`, all published |
| Open suppliers | 4 × `part_store`, 3 × `workshop`, 1 × `body_paint` |
| API log | **`No SupplierTargetingPort wired` ×3** |

Requests are created, the event is written and relayed correctly. Then
`FanOutReactor` finds no targeting port and returns, so no quote stub is
ever written, no supplier ever sees the request, and 30 minutes later it
expires.

## Why the port is null

`SUPPLIER_TARGETING_PORT` is provided in **`AppModule`'s own `providers`
array**. `FanOutReactor` lives inside **`RequestsModule`**.

Nest's injector hierarchy is one-directional: a module sees its own
providers, the *exports* of modules it imports, and global modules.
`AppModule` imports `RequestsModule` — not the reverse — so
`RequestsModule` cannot see `AppModule`'s providers. The injection is
marked `@Optional()`, so instead of failing at boot it resolves to
`null`, logs a warning, and silently drops every request.

`ContractsModule` is `global: true`, which is why `VerticalRegistry`
injects fine in the same constructor. That contrast is the tell.

## Why no test caught it

The Phase 1 DoD was proven by integration specs that construct
`FanOutReactor` **directly** and hand it a targeting double. They never
build the Nest DI graph, so the wiring they exercise is not the wiring
that runs. Every layer is individually correct; only the composition is
broken.

## Targeting itself is fine

`eligibleForPartRequest` filters on `is_open AND vertical_key = any(...)`
and uses `category_key` only in the `ORDER BY`. `part_store` and
`wholesaler` both declare `RECEIVES_PART_REQUESTS`, and four open
`part_store` suppliers exist. **Once wired, fan-out will target four
suppliers immediately.** There is one bug here, not two.

## Fix (small)

1. Move the adapter into a tiny `global: true` module provided by the
   composition root, so any module can inject the seam — the same shape
   `ContractsModule` already uses.
2. **Make it fail loudly.** Drop `@Optional()`, or keep it and refuse to
   boot when `DATABASE_URL` is set but no targeting port is bound. A
   mis-wired core loop must not look like an idle one.
3. Add a boot-time assertion test that builds the real `AppModule` and
   asserts `FanOutReactor` receives a non-null port — the gap class the
   current tests cannot see.
4. Re-run the expired requests, or accept the loss on a dev box.

**Do this before the document work.** It is hours, not days, and the
product's central promise is broken until it lands.

---

# Part 2 — Signed documents

## What exists today

**Nothing.** No PDF renderer, no invoice, no document table, no
signing — and none of it in the build spec either. This is new scope
beyond Phase 4. What does exist and will be reused:

- **`media`** — pre-signed uploads to private Supabase buckets, with
  signed short-lived reads. The storage pattern is already right.
- **`orders`** — `amount_minor`, `currency`, client, supplier,
  fulfilment. The data an invoice needs, minus tax and line items.
- **`Money`** — integer minor units, already the house rule.

## The central distinction

The requirement "show it was valid but got nullified" is the whole
design, so state it precisely:

> **Authenticity** — *we issued these exact bytes, and they have not
> changed.* Proven by cryptography. Permanent, never revoked.
>
> **Validity** — *this document still stands.* A registry lookup.
> Revocable at any time.

A voided invoice is still perfectly **authentic**. Conflating the two
leads to deleting or regenerating files, which destroys the audit trail
the system exists to provide. **Stored bytes are never altered, never
overwritten, never deleted.**

## Proposed architecture

### One `documents` bounded context

Every document type goes through one module. Not each module rolling its
own: the signing key, the hash chain, the verification endpoint and the
void registry must be one thing, or there are N half-verifications.

Other modules stay the source of truth for their data and call a port:

```
DocumentsPort.issue({ type, subjectRef, payload }) -> DocumentDTO
```

- `orders` → **facture**, **bon de commande**
- `reservations` → **confirmation de réservation**
- `requests` → **devis** (quotation)
- later `payments` → **reçu**, **avoir** (credit note)

### Data model (`documents` schema)

```
documents
  id, type, number, series,
  subject_type, subject_id,          -- loose ref, no FK across schemas
  issuer_account_id, issued_to_account_id,
  bucket, path,                      -- where the bytes live, write-once
  sha256,                            -- hash of the exact stored bytes
  signature, key_id, algo,           -- detached Ed25519 signature
  prev_sha256,                       -- hash chain, see below
  payload_snapshot jsonb,            -- what it was rendered FROM
  status: issued | void
  issued_at, voided_at, voided_by, void_reason
```

**`payload_snapshot` matters.** An invoice must still render identically
in five years when the order, prices and supplier name have all changed.
Rendering from live data is how documents silently rewrite history.

### Signing

- **Ed25519 detached signature over the SHA-256 of the file bytes.**
  Small, fast, no certificate authority.
- `key_id` on every row so keys rotate without invalidating old
  documents.
- Private key from env/secret manager. **Never in the repo, never in the
  database.**
- **Publish the public keys** at a well-known endpoint. If verification
  only works because our API says "valid", it proves nothing to a
  sceptical third party. Published keys make the signature verifiable
  offline, by anyone, forever.

### Hash chain

Each document stores the `sha256` of the previous document in its
series. One signature proves *this* document is untouched; the chain
proves **nothing was deleted or back-dated**, which is the fraud that
matters for invoices. Cheap to add now, impossible to retrofit over
history later.

### Verification

```
GET  /v1/documents/verify/{number}       public
POST /v1/documents/verify                public, body: the file
```

The first returns issuer, type, number, issue date and status. The
second is stronger: the holder sends the PDF **they** have, we hash it
and compare — proving their copy is the authentic one rather than asking
them to trust our screen.

**Public verification must not leak contents.** No amounts, no parties
beyond the issuer, no line items — a document number is guessable and
anyone can call this. Status and authenticity only.

Every PDF carries a **QR code** to its verify URL plus the human-readable
number.

### Voiding

Admin-only (`platform.admin`, held by `ops_admin`). Writes
`status='void'` plus who, when and why. **The stored PDF is untouched.**

Verification then answers, unambiguously:

```json
{ "authentic": true,
  "status": "void",
  "voidedAt": "...", "reason": "...",
  "message": "This document was genuinely issued but has been annulled." }
```

### Rendering

**`pdfkit`** or `pdf-lib`, not headless Chromium. Chromium is 300MB+ and
would not fit beside the other client's site on the current box.
Invoices are structured documents; a programmatic renderer suits them.

**The renderer must be deterministic** — no render timestamp, no random
ids, no non-embedded fonts. The hash is over exact bytes. And we render
**once**: every later read serves the stored object, never a
regeneration.

### Storage

New private bucket `documents`, path
`{type}/{yyyy}/{id}.pdf`, write-once, read via short-lived signed URLs —
the same pattern `media` already uses. Add it to
`scripts/create-buckets.mjs`.

## Suggested sequence

1. Fix the fan-out wiring (Part 1) — unrelated, but it blocks the product.
2. `documents` module: schema, port, Ed25519 signing, hash chain, storage.
3. One document type end-to-end — **reservation confirmation**, the
   simplest, no tax or fiscal weight.
4. Verification endpoints + published public keys + QR on the PDF.
5. Void flow + admin permission.
6. **Then** invoices — only after the fiscal questions below are answered.

---

## Questions I cannot answer for you

These change the design, so I would rather ask than guess.

1. **Are these legally fiscal documents in Algeria?** If a *facture* must
   satisfy Algerian tax law, it likely carries mandatory mentions, a
   gapless legal numbering sequence, retention duties, and possibly a
   qualified electronic signature (PAdES/X.509 from a recognised
   authority) rather than our own Ed25519 key. That is a different and
   much larger build. **If invoices are fiscal, this must be settled
   before anything is written.**

2. **Can an issued invoice actually be voided?** In most accounting
   regimes it cannot — you issue a **credit note (avoir)** that reverses
   it, and both documents survive. "Nullify" as requested is right for
   quotations and confirmations; for invoices it may be illegal. Should
   voiding an invoice *force* a corrective document?

3. **Who is "the JustGo Team"?** There is an `ops_admin` role with
   `platform.admin`, but **no admin surface exists** — no endpoints, no
   app. Voiding needs one, plus an audit log of who voided what.

4. **Tax.** Orders carry `amount_minor` and `currency` and nothing else.
   Invoices need VAT/TVA rates, per-line breakdown and totals. That is a
   schema change in `orders`/`payments`, not in `documents`.

5. **Numbering.** Gapless per-series-per-year sequences under concurrency
   are a classic trap. Legal requirement, or is a UUID plus a readable
   reference enough?

6. **Retention.** How long must documents survive, and does a user
   deleting their account delete them? Fiscal retention usually beats
   erasure requests — worth knowing before the first byte is stored.

Answer 1 and 2 and I can start; the rest can be settled as we go.
