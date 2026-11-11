# JustGo Backend — Frontend Integration Guide

Audience: the engineer integrating the Client ("Orange") and Supplier ("Green")
apps with the backend. This is the **field-level contract**. The interactive
OpenAPI spec (`GET /v1/docs`, raw at `GET /v1/docs-json`) is the machine-readable
companion — generate typed clients from it.

Status: **Phase 1** (identity, the request → quote → order core loop, notifications
+ realtime, and a stubbed catalogue). Endpoints and shapes below are stable;
later phases add modules (vehicles/garage, discovery, reservations, payments)
without breaking these.

---

## 1. Base URL & environments

- All endpoints are under the `/v1` prefix.
- Local dev API: `http://localhost:3000` (so requests go to `http://localhost:3000/v1/...`).
- Auth/Realtime/Storage are served by the **self-hosted Supabase stack** behind
  its Kong gateway: local `http://localhost:8100`.

There are no hard-coded hosts — everything is environment-driven. The apps should
read the API base URL and the Supabase URL/anon key from config.

---

## 2. Authentication

Authentication is **two steps**, and skipping the second is the most common
way to get stuck.

1. **Sign in against the self-hosted Supabase GoTrue.** It returns an access
   token proving *who* the user is.
2. **Exchange that token at `POST /v1/auth/session`.** You get back a JustGo
   session token that also carries *what they may do* — and, for supplier
   staff, *which supplier they act for*. Send **this** token on every other
   call.

> **Why two steps.** Roles and permissions are rows in the `identity` schema,
> not something an authentication server knows. A raw GoTrue token therefore
> arrives with no `roles` and no `permissions`, and every endpoint behind a
> permission answers **403** — including the whole core loop. The exchange is
> where authorisation gets attached.

### Step 1 — sign in (GoTrue, via Kong)

Use `supabase-js` (recommended) or call GoTrue directly:

```
POST http://localhost:8100/auth/v1/token?grant_type=password
apikey: <SUPABASE_ANON_KEY>
Content-Type: application/json

{ "email": "user@example.com", "password": "…" }
```

Response contains `access_token` and `refresh_token`. Refresh with
`grant_type=refresh_token`. Phone OTP and sign-up use the standard GoTrue
endpoints (`/auth/v1/signup`, `/auth/v1/otp`, …).

```ts
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const { data } = await supabase.auth.signInWithPassword({ email, password });
const gotrueToken = data.session.access_token;
```

### Step 2 — exchange for a session token

```
POST /v1/auth/session
Authorization: Bearer <gotrue access_token>
Content-Type: application/json

{}                          // Client app
{ "scope": "supplier" }     // Supplier app
{ "supplierId": "…" }       // Supplier app, explicit business
```

```json
{
  "accessToken": "eyJhbGciOi…",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "account": { "id": "…", "authUserId": "…", "locale": "en", "roles": ["supplier_owner"], … },
  "roles": ["supplier_owner"],
  "permissions": ["order.read", "quote.submit", "supplier.requests.read", …],
  "supplier": { "supplierId": "…", "branchId": null },
  "supplierScopes": [{ "supplierId": "…", "branchId": null, "roleKey": "supplier_owner" }]
}
```

Use `accessToken` as `Authorization: Bearer …` for everything else.

**Rules worth knowing:**

- **Self-provisioning.** A brand-new GoTrue user gets their account row here.
  You do not have to call `GET /v1/me` first.
- **Scoping is opt-in.** Owning a supplier never silently turns a client
  session into a supplier one. The Client app sends `{}`; the Supplier app
  asks. `{"scope":"supplier"}` auto-selects when the account acts for exactly
  one supplier; with several it returns **400** listing them, and you re-send
  with an explicit `supplierId`. `supplierScopes` in the response tells you
  what is available.
- **Permissions are scope-specific**, not the union of every role. A person
  who is both a client and a garage owner gets `request.create` in their
  client session and `quote.submit` in their supplier session — never both in
  one token.
- **A session never outlives its GoTrue token.** `expiresIn` is the lesser of
  the server's TTL and the remaining life of the token you exchanged, so
  **re-exchange after every GoTrue refresh**, not once at install.
- **The session token still works against Supabase.** `sub`, `role` and `aud`
  are carried through untouched, so Realtime and PostgREST keep accepting it.

### Becoming a supplier

`POST /v1/supplier` registers a business using an ordinary client session.
The supplier role is granted asynchronously (the API reacts to
`suppliers.SupplierRegistered`), so **exchange again** afterwards to get a
token carrying `supplier_id`:

```
POST /v1/supplier          → { id: "sup-1", … }        (client session)
POST /v1/auth/session      → { "scope": "supplier" }   (a moment later)
```

If the new scope is not there yet, retry once — the grant travels through the
outbox relay.

### Claims the API reads

| Claim | Meaning |
|---|---|
| `sub` | Supabase `auth.users.id`. Read by RLS as `app.auth_user_id()`. |
| `account_id` | `identity.accounts.id`. Added by the exchange. |
| `roles` | string[] of role keys (e.g. `client`, `supplier_owner`) |
| `permissions` | string[] the RBAC guard checks |
| `supplier_id` | present for a supplier session — scopes the caller to one supplier |
| `branch_id` | optional branch scope |
| `locale` | `en` \| `es` \| `fr` (defaults `en`) |

> **Supplier sessions:** the same endpoints behave supplier-side when
> `supplier_id` is present — `GET /v1/orders` returns the supplier's orders,
> `GET /v1/notifications` its feed.

### Roles → permissions (Phase 1 seed)

Roles and permissions are **data**, not code. Current seed:

- `client` / `fleet`: `me.*`, `vehicle.manage`, `request.create|read|cancel`,
  `quote.accept|refuse`, `order.read|create`, `reservation.create`, `listing.*`,
  `post.publish|interact`, `review.write`, `reclamation.file`, `driver.apply`
- `guest`: `request.create`, `request.read`
- `supplier_owner`: `me.*`, `quote.submit`, `supplier.requests.read`,
  `supplier.profile.manage`, `supplier.catalog.manage`, `order.read`,
  `reservation.manage`, `post.publish|interact`, `review.write`
- `branch_manager`: like `supplier_owner` minus profile management
- `ops_admin`: `platform.admin`

`review.write` is its own bit rather than part of `post.interact`: a review
changes a business's rating and sits on its page for good, a like reaches
nobody. Holding it is not enough on its own — a review also needs a completed
order or reservation with that business.

A missing permission returns **403** with the required permission in `details`.

---

## 3. Conventions

### Money
Always an object of **integer minor units** + ISO-4217 currency. Never a float.

```json
{ "amountMinor": 9500, "currency": "EUR" }   // = €95.00
```

### Timestamps
UTC ISO-8601 strings, e.g. `2026-08-26T17:27:45.101Z`.

### Idempotency
Creating POSTs accept an `Idempotency-Key` header. Retrying with the same key
returns the original result instead of creating a duplicate. Use it on
`POST /v1/requests` (generate a UUID per user action, resend on network retry).

### Error envelope
Every error (any 4xx/5xx) has this shape:

```json
{
  "error": { "code": "STABLE_CODE", "message": "human message", "details": { } },
  "traceId": "…"
}
```

Branch on `error.code` (stable, localizable), not on the message. Common codes:

| HTTP | code | when |
|---|---|---|
| 400 | `VALIDATION_FAILED` | body/query failed validation (`details.issues` has specifics) |
| 401 | `UNAUTHENTICATED` | missing/invalid/expired token |
| 403 | `FORBIDDEN` | authenticated but missing a permission (`details.required`) |
| 404 | `NOT_FOUND` | resource absent, or not visible to you |
| 409 | `ILLEGAL_QUOTE_TRANSITION` / `ILLEGAL_REQUEST_TRANSITION` / `ILLEGAL_ORDER_TRANSITION` / `REQUEST_CLOSED` | illegal state-machine move |
| 422 | `REQUEST_UNDESCRIBED` / `TARGET_SUPPLIER_REQUIRED` / `UNKNOWN_VERTICAL` / `SUPPLIER_ALREADY_REGISTERED` / `WORKSHOP_REQUIRED` / `INVALID_AMOUNT` | well-formed but violates a business rule |

### Lists
List endpoints return `{ "items": [ ... ] }`. `?limit=` is supported; cursor
pagination arrives when data volume needs it.

### Locales
`en`, `es`, `fr`. i18n content (e.g. catalogue labels) is returned as
`{ "en": "…", "es": "…", "fr": "…" }`.

---

## 4. Realtime

Live updates broadcast over the self-hosted **Supabase Realtime** using
**broadcast** messages. Subscribe with `supabase-js`:

```ts
const channel = supabase
  .channel('request:' + requestId)          // or 'supplier:' + supplierId
  .on('broadcast', { event: '*' }, (msg) => {
    // msg.event = e.g. 'quote.received'; msg.payload = the notification payload
  })
  .subscribe();
```

Channels:

| Channel | Who subscribes | Fires on |
|---|---|---|
| `supplier:{supplierId}` | a supplier's inbox screen | a new request targets them (`request.received`), their quote is accepted (`quote.accepted`), order events |
| `request:{requestId}` | a client watching one request | a supplier prices (`quote.received`), offers an alternative (`quote.alternative`), or rejects (`quote.rejected`) |
| `account:{accountId}` | a user's app shell (badge/toasts) | any notification addressed to that account |

Payloads mirror the notification: `{ id, type, title, body, refId, createdAt, ... }`
plus event-specific fields (e.g. `amountMinor`, `currency`, `quoteId`, `supplierId`).

Realtime is best-effort and a **convenience layer**. The durable source of truth
is the notification feed (`GET /v1/notifications`) and the resource endpoints —
always reconcile against those on reconnect/foreground.

---

## 5. The core loop (walkthrough)

**Client side**
1. (optional) Browse the catalogue to pick a part → get a `tecdocArticleId` or
   `categoryKey`.
2. `POST /v1/requests` with an `Idempotency-Key`. Returns the request `pending`
   with no quotes yet (fan-out is async).
3. Subscribe to `request:{id}`. As suppliers respond you receive `quote.received`
   / `quote.alternative` / `quote.rejected`.
4. `GET /v1/requests/{id}` any time for the full picture; `bestQuoteId` flags the
   current lowest price and each quote carries `isBest`.
5. `POST /v1/quotes/{quoteId}/accept` → the request becomes `accepted`, the other
   quotes `closed`, and an **order** is created. (Or `POST /v1/quotes/{id}/refuse`
   to decline one and keep waiting.)
6. `GET /v1/orders` / `PATCH /v1/orders/{id}/fulfilment`.

**Supplier side**
1. `POST /v1/supplier` once to register the business (vertical `part_store`).
2. Subscribe to `supplier:{supplierId}`; receive `request.received` when targeted.
3. `GET /v1/supplier/requests` — the inbox (one quote stub per request targeting you).
4. Respond with exactly one of:
   - `POST /v1/supplier/requests/{quoteId}/quote` → a price
   - `POST /v1/supplier/requests/{quoteId}/alternative` → an alternative part
   - `POST /v1/supplier/requests/{quoteId}/reject` → decline
5. If the client accepts you, you get `quote.accepted` and an order.

---

## 6. Endpoint reference

All endpoints require `Authorization: Bearer <session token>` (see §2) except
the public ones: `GET /v1/health` and `GET /v1/discovery/suppliers`.

### Auth
- **`POST /v1/auth/session`** body `{ scope?: 'client'|'supplier', supplierId?, branchId? }`
  → `Session`. Takes a **GoTrue** token; returns the session token every other
  endpoint expects. See §2 for the rules.

`Session`:
```json
{ "accessToken":"eyJhbGciOi…","tokenType":"Bearer","expiresIn":3600,
  "account":{ "id":"uuid","authUserId":"uuid","locale":"en","roles":["supplier_owner"] },
  "roles":["supplier_owner"],
  "permissions":["order.read","quote.submit","supplier.requests.read"],
  "supplier":{ "supplierId":"uuid","branchId":null },
  "supplierScopes":[{ "supplierId":"uuid","branchId":null,"roleKey":"supplier_owner" }] }
```

Errors: **403** if you name a supplier the account holds no role on (details
list what it may use); **400** if `scope:"supplier"` matches several
suppliers; **501** if the deployment verifies via JWKS rather than a shared
secret, in which case the API holds no key it may sign with.

### Me
- **`GET /v1/me`** → `Account`. Self-provisions on first call.
- **`PUT /v1/me`** body
  `{ firstName?, familyName?, phone?, email?, dob?, city?, country?, avatar?, locale? }`
  → `Account`.
  - **`null` clears a field; leaving the key out leaves it alone.** They are
    different answers — without the first there would be no way to remove a
    phone number or an avatar once set.
  - `avatar` is `{ bucket: "avatars", path }`, never a URL. Upload through
    **`POST /v1/media/uploads`** to the `avatars` bucket and send the returned
    `path`; a path outside your own upload namespace is **400**.
  - `email` here is a **contact** address. GoTrue owns the sign-in credential,
    so changing this does **not** change what the user logs in with.
  - `dob` is `YYYY-MM-DD`. A future date is **400**.
- **`DELETE /v1/me`** → `Account` with `deletedAt` set. **Close the account.**
  - **Anonymisation, not deletion**, and the difference matters to the app.
    Name, email, phone, date of birth, city and avatar are blanked and every
    role is dropped, so the person disappears from the feed, from messages and
    from reviews, and the next sign-in reaches nothing. The row itself stays,
    because orders, reservations and reclamations belong to the other party as
    much as to this one — deleting it would destroy a supplier's record of
    sales they made.
  - **Invoices and the other sealed documents keep the name they were issued
    under.** They render from a snapshot taken at issue, signed over their
    exact bytes, under a number in a gapless fiscal series. A tax document is
    not ours to rewrite, and editing the bytes would break the signature that
    proves nobody has. Say so in the confirmation screen rather than promising
    an erasure the law does not allow.
  - **422 `ACCOUNT_OWNS_BUSINESS`** while the account still acts for a
    supplier. Close the business first (`DELETE /v1/supplier/profile`).
  - Idempotent, and irreversible. **Drop the session token as soon as this
    returns**: permissions are baked into a token at exchange, so one already
    issued keeps working until it expires.

`Account`:
```json
{ "id":"uuid","authUserId":"uuid","firstName":null,"familyName":null,
  "email":"user@example.com","phone":null,"dob":null,"city":null,
  "country":null,"avatar":null,"locale":"en",
  "roles":["client"],"deletedAt":null,
  "createdAt":"2026-08-26T17:00:00.000Z" }
```

### Client · Garage (vehicles) — Phase 2
All require the `vehicle.manage` permission (client/fleet roles).
- **`GET /v1/vehicles`** → `{ items: Vehicle[] }`.
- **`POST /v1/vehicles`** body:
  ```json
  { "brand":"Renault","model":"Clio","year":2015,"name":"Daily",
    "vin":null,"plate":"AB-123-CD","mileageKm":90000,"photoUrl":null,
    "resolveTecDoc":true }
  ```
  Needs at least one of `name` / `brand` / `vin` (else `422 VEHICLE_UNDESCRIBED`).
  When `resolveTecDoc` isn't `false` and `brand` is present, the backend resolves
  the **KType** via TecDoc and stores the reference IDs. Resolution is best-effort —
  a TecDoc outage never blocks adding a car; you just get `tecdocVehicleTypeId:null`.
  → `Vehicle`.
- **`GET /v1/vehicles/{id}`** → `Vehicle` (404 if not yours).
- **`PATCH /v1/vehicles/{id}`** body `{ name?, plate?, photoUrl?, healthStatus? }` → `Vehicle`.
- **`DELETE /v1/vehicles/{id}`** → `{ deleted:true }` (cascades tasks + health).
- **`PATCH /v1/vehicles/{id}/mileage`** body `{ mileageKm }` → `Vehicle`.
  **A reading may not go down** — see *The 30-day mileage rule* below.
- **`GET /v1/vehicles/{id}/mileage-history?limit=`** → `{ items: MileageHistoryEntry[] }`,
  newest first.
- **`GET /v1/vehicles/{id}/maintenance`** → `{ items: MaintenanceTask[] }`.
- **`POST /v1/vehicles/{id}/maintenance`** body
  `{ title, intervalKm?, intervalMonths?, dueAtKm?, dueDate? }` → `MaintenanceTask`.
  Tasks flip to `due` automatically (odometer or date) and raise a `maintenance.due`
  notification.
- **`GET /v1/vehicles/{id}/health`** → `{ items: HealthEntry[] }`.
- **`POST /v1/vehicles/scan`** — see **Media & scan** below.

`Vehicle`:
```json
{ "id":"uuid","ownerAccountId":"uuid","name":"Daily","brand":"Renault",
  "model":"Clio","year":2015,"vin":null,"plate":"AB-123-CD","mileageKm":90000,
  "mileageUpdatedAt":"2026-11-11T09:00:00.000Z","mileageUpdateRequired":false,
  "tecdocVehicleTypeId":12345,"tecdocManufacturerId":11,"tecdocModelId":22,
  "healthStatus":"good","photoUrl":null,"createdAt":"…" }
```
`healthStatus` ∈ `optimal | good | warning | critical | urgent`.
`MaintenanceTask.status` ∈ `pending | due | done | dismissed`.

#### The 30-day mileage rule

The server owns this now. You can stop writing the `JG-MILEAGE:<km>`
maintenance task as soon as `mileageUpdatedAt` comes back from
`PATCH /mileage`; the rows already written are harmless and can stay.

**A reading may not go down.** A lower value is `422 MILEAGE_LOWER` and
changes **nothing at all** — not the number, not `mileageUpdatedAt`, no
history row — so a typo cannot buy another 30 days. An **equal** value is
accepted on purpose, because you retry with the same figure when a
confirmation was interrupted.

**`mileageUpdatedAt` is the date of the READING.** Not `updatedAt`, which
moves when a car is renamed or its health status changes.
**`mileageUpdateRequired`** is computed in SQL against the database clock,
so every container and every device agrees, and it clears everywhere the
instant a valid reading is saved. Prefer both fields over anything you
derive yourself.

A correction downwards is support's: `PATCH /v1/admin/vehicles/{id}/mileage`
with `{ mileageKm, reason }` under `support.mileage.override`. It may lower
the value, records `source:"support"` with the operator's id, and does
**not** touch `mileageUpdatedAt`.

`MileageHistoryEntry`:
```json
{ "id":"uuid","vehicleId":"uuid","previousKm":120000,"newKm":121500,
  "source":"client","actorAccountId":"uuid","recordedAt":"…" }
```
`source` ∈ `client | support` — what the owner confirmed and what the desk
typed in on their behalf are not the same evidence.

#### The notification lock

- **`GET /v1/me/notification-access`** →
  ```json
  { "locked":true, "reason":"MILEAGE_UPDATE_REQUIRED", "vehicleId":"uuid",
    "lastUpdatedAt":"…", "dueAt":"…" }
  ```
  Locked when **any** of the account's cars is overdue; it names the one
  overdue longest so you can open that car instead of a list. An account
  with **no cars is never locked**. Readable while locked — it is what
  tells you why.

The lock is also enforced on the endpoints that feed your notifications:
`GET /v1/requests`, `GET /v1/reservations` and `GET /v1/orders` answer
**403 `MILEAGE_UPDATE_REQUIRED`**, with `vehicleId` and `dueAt` in
`error.details`. Branch on the **code**, not on the 403: plain `FORBIDDEN`
means "you may not", this one means "do this and you may".

Everything needed to get out stays reachable while locked: sign-in,
`GET /v1/vehicles*`, the mileage endpoints, and the route above.

### Client · Discovery — Phase 2 (public)
- **`GET /v1/discovery/suppliers?lat=&lng=&radius=&vertical=&category=&limit=`** →
  `{ items: NearbySupplier[] }`, nearest first.
  - `lat`/`lng` required; `radius` in **metres** (default 10 000, max 100 000);
    `vertical` and `category` optional filters; `limit` ≤ 100.
  - Public — no token needed. Returns only **open** suppliers.

`NearbySupplier`:
```json
{ "supplierId":"uuid","verticalKey":"part_store","name":"AutoParts Paris",
  "categoryKeys":["braking","engine"],"distanceM":842 }
```

- **`GET /v1/discovery/directory?q=&vertical=&category=&city=&lat=&lng=&limit=&cursor=`** →
  `{ items: DirectorySupplier[], nextCursor }` — the **Services Directory**.
  - **Every parameter is optional, including location.** That is the whole
    point of this route: `/discovery/suppliers` above demands a `lat`/`lng`,
    and a user who never granted location permission could not browse at all.
  - `q` is a fuzzy name match (trigram), so `garag`, `Garge` and `GARAGE` all
    find *Garage Central*.
  - Supply `lat` **and** `lng` to get `distanceM` on each row and proximity
    ordering; omit them and results order by rating then name.
  - `cursor` is keyset pagination — pass back the `nextCursor` you were given.
    `null` means you are on the last page.
  - Public — no token needed.
  - This is a **separate route** from `/discovery/suppliers` on purpose. The
    shipped app already calls that one; changing its contract would break
    builds in the field.

`DirectorySupplier`:
```json
{ "supplierId":"uuid","verticalKey":"garage","name":"Garage Central",
  "categoryKeys":["braking","engine"],"city":"Alger","country":"DZ",
  "rating":4.6,"distanceM":1240 }
```

### Client · Requests
- **`POST /v1/requests`** (header `Idempotency-Key`) body:
  ```json
  { "strategy":"all", "categoryKey":"braking", "tecdocArticleId":1001,
    "freeText":"Front brake pads", "quantity":2, "vehicleId":null,
    "photoUrl":null, "expiresInMinutes":1440 }
  ```
  - `strategy`: `all` fans out to eligible suppliers; `single` targets exactly one
    (`targetSupplierId` required).
  - At least one of `tecdocArticleId` / `categoryKey` / `freeText` is required
    (else `422 REQUEST_UNDESCRIBED`).
  - → `PartRequest` (status `pending`, `quotes: []`).
- **`GET /v1/requests?limit=`** → `{ items: PartRequest[] }`
- **`GET /v1/requests/{id}`** → `PartRequest` (with `quotes` + `bestQuoteId`).
  404 if not yours.
- **`DELETE /v1/requests/{id}`** → `PartRequest` (status `cancelled`).
- **`POST /v1/quotes/{quoteId}/accept`** → `PartRequest` (status `accepted`).
  409 if the request/quote isn't in an acceptable state.
- **`POST /v1/quotes/{quoteId}/refuse`** body `{ reason? }` → `PartRequest`.
- **`POST /v1/quotes/{quoteId}/document`** → `Document` — the **devis** for a
  quote you received, sealed. Takes no body; issued at most once per quote.
  404 if the quote is not on one of your own requests.

`PartRequest`:
```json
{ "id":"uuid","clientAccountId":"uuid","vehicleId":null,"tecdocArticleId":1001,
  "categoryKey":"braking","freeText":"Front brake pads","photoUrl":null,
  "quantity":2,"strategy":"all","status":"awaiting_client",
  "createdAt":"…","expiresAt":"…",
  "bestQuoteId":"uuid-of-cheapest",
  "quotes":[ /* Quote objects, isBest flagged */ ] }
```

`Quote`:
```json
{ "id":"uuid","requestId":"uuid","supplierId":"uuid",
  "kind":"price","amount":{"amountMinor":9500,"currency":"EUR"},
  "altName":null,"altReference":null,"altTecdocArticleId":null,
  "status":"quoted","reason":null,"createdAt":"…","isBest":true }
```

### Supplier · Business
- **`POST /v1/supplier`** body `{ verticalKey:"part_store", name, city?, country?, lat?, lng?, profile? }`
  → `Supplier`. 422 `UNKNOWN_VERTICAL` / `SUPPLIER_ALREADY_REGISTERED`.
- **`GET /v1/supplier/profile`** → `Supplier`.
- **`PATCH /v1/supplier/fiscal`** body
  `{ legalName?, address?, nif?, nis?, rc?, taxArticle? }` → `Supplier`.
  - **Required before any invoice can be issued for this supplier.** Algerian
    law makes NIF, NIS, RC and the *article d'imposition* mandatory mentions
    on a facture, so while any of them is missing the backend **refuses to
    issue** rather than produce a document that merely looks official. The
    refusal is logged server-side naming the missing fields.
  - Fields are **merged**, not replaced — sending only `nif` leaves the rest
    alone, so the app can collect them over several screens.
  - `legalName` is the registered name as it must appear on the invoice, which
    is often not the trading name in `name`.
- **`PATCH /v1/supplier/profile`** body
  `{ name?, description?, phone?, email?, city?, country?, address?, lat?, lng?,
     isOpen?, hours?, logo?, cover?, profile? }` → `Supplier`.
  Needs `supplier.profile.manage`. **This is the edit pencil.**
  - The business is resolved **from your token**. There is deliberately no
    route that names which supplier to edit.
  - `null` clears, an absent key leaves alone — same rule as `PUT /v1/me`.
  - `logo` and `cover` are `{ bucket: "supplier-media", path }`. Upload through
    **`POST /v1/media/uploads`** to `supplier-media` first; a path outside your
    own upload namespace is **400**.
  - `lat`/`lng` move together, and both `null` drops the pin.
  - `hours` is per weekday: `{ "mon": [{"from":"09:00","to":"12:30"},
    {"from":"14:00","to":"18:00"}], "fri": [] }`. A missing day is closed, a
    day with two intervals is a shop that shuts for lunch. Overlapping or
    inverted intervals are **400** rather than silently merged — merging would
    hide a typo behind a shop that claims to be open all afternoon.
  - **Not editable here**: `isVerified` (JustGo awards it), `rating` (customers
    earn it) and `verticalKey` (it decides the catalogue and the matching
    rules, so changing it is a re-registration).
  - **422 `SUPPLIER_CLOSED`** once the business has been closed.
- **`DELETE /v1/supplier/profile`** → `Supplier` with `closedAt` set.
  **Close the business.** A soft close: the row stays because orders,
  invoices, reservations and reviews point at it and a gapless fiscal series
  may not reference a seller that vanished. What goes away is visibility —
  discovery, the directory and quote fan-out all drop it, and the profile
  becomes read-only.
- **`PATCH /v1/supplier/{id}/verification`** body `{ verified, note? }` →
  `Supplier`. **Requires `platform.admin`** — this is the ops route behind the
  blue check, and the only one that touches it. A badge the subject can award
  itself tells a reader nothing. Withdrawable with `{"verified": false}`.
  `note` is internal and comes back on this response only.

`isOpen` vs `closedAt`: the first means *open right now* — a Sunday, a holiday
— and the second means the business is gone. Collapsing them would make an
August closure indistinguishable from a bankruptcy.

#### Branches

`suppliers.branches` and `is_multi_branch` have existed since the first
schema, and `POST /v1/auth/session` has always accepted a `branchId` — for a
branch nothing could create. These are the missing half. All need
`supplier.profile.manage`, and all resolve the business from your token, so a
branch of another supplier is **404**, never 403.

- **`GET /v1/supplier/branches?includeClosed=`** → `{ items: Branch[] }`,
  ordered by creation so a picker does not reshuffle between reads.
- **`POST /v1/supplier/branches`** body
  `{ name, address?, city?, country?, phone?, lat?, lng?, hours?, isOpen? }`
  → **201** `Branch`.
- **`PATCH /v1/supplier/branches/{id}`** → `Branch`. Same null-clears-it rule.
- **`DELETE /v1/supplier/branches/{id}`** → `Branch` with `closedAt` set. Soft,
  because a session token issued earlier can already carry this branch id and
  products reference it.

**`isMultiBranch` is derived now**, from the open branch count, in the same
transaction that changes it. It used to be a flag the supplier set about
itself that nothing kept true; do not send it and do not cache it.

### Reviews & ratings — Phase 4

`Supplier.rating` has been rendered by the app since the first release and
written by nothing. This is where the number comes from.

**Who may review: somebody the business actually served.** A review is only
accepted once an order or a reservation with that supplier has reached
`completed`. An open review box is a review box full of competitors, and this
is the only defence that survives contact with a real market. Every review
therefore carries a `source` of `order` or `reservation`, which is safe to
render as a verified-purchase mark.

- **`GET /v1/suppliers/{id}/reviews?limit=&cursor=`** → `ReviewPage`.
  **Public — no token needed.** Newest first, keyset-paginated. `summary`
  carries the whole business's average and count, not this page's, so a
  profile header renders from this one call.
- **`GET /v1/suppliers/{id}/reviews/me`** → `{ review, mayReview }`.
  Both answers at once, because the app needs both to decide between a write
  button, an edit button and nothing.
- **`POST /v1/suppliers/{id}/reviews`** body `{ rating, body? }` → **201**
  `Review`. Needs `review.write`.
  - `rating` is a whole number, 1–5. Half stars are rejected: two scales would
    make the average depend on which app the reviewer used.
  - **422 `NO_COMPLETED_DEALING`** without a completed order or reservation.
  - **422 `ALREADY_REVIEWED`** — one live review per person per business. Edit
    the existing one instead; the response names its id.
  - A star with no words is a valid review.
- **`PATCH /v1/reviews/{id}`** body `{ rating?, body? }` → `Review`. Yours
  only, **404** otherwise.
- **`DELETE /v1/reviews/{id}`** → `Review` with status `removed`. Retract your
  own. The average drops by exactly what it contributed and you are free to
  write a new one — which is the point when a shop has put something right.
- **`POST /v1/reviews/{id}/takedown`** body `{ reason }` → `Review`. Any
  review, requires `platform.admin`.
- **`PUT /v1/reviews/{id}/reply`** body `{ body }` → `Review` with `reply` set.
  Needs `supplier.profile.manage`, and only for reviews **of your own
  business** (403 otherwise). **PUT, not POST**: there is one answer and a
  second call replaces it, so a retry cannot turn a review page into a thread.

`Review`:
```json
{ "id":"uuid","supplierId":"uuid","authorAccountId":"uuid",
  "rating":5,"body":"Piece trouvee en une heure.",
  "status":"published","source":"order",
  "reply":{"reviewId":"uuid","supplierId":"uuid","authorAccountId":"uuid",
           "body":"Merci !","createdAt":"…"},
  "createdAt":"…","updatedAt":"…" }
```

`ReviewPage`:
```json
{ "items":[/* Review */], "nextCursor":null,
  "summary":{ "rating":4.6, "ratingCount":42 } }
```

The average and the count move **in the same transaction as the review**, so
the number above a list can never disagree with the list beneath it. Use the
`summary` the API returns rather than averaging the page you were given.

### Supplier · Inbox (requires `supplier_id` in the token)
- **`GET /v1/supplier/requests?limit=`** → `{ items: Quote[] }` (your quote stubs).
- **`POST /v1/supplier/requests/{quoteId}/quote`** body `{ amount:{amountMinor,currency} }` → `Quote`.
- **`POST /v1/supplier/requests/{quoteId}/alternative`** body
  `{ altName, altReference?, altTecdocArticleId?, amount? }` → `Quote`.
- **`POST /v1/supplier/requests/{quoteId}/reject`** body `{ reason? }` → `Quote`.

Answering a quote that isn't yours → 403. Answering when the request is already
closed → 409 `REQUEST_CLOSED`.

### Orders
- **`GET /v1/orders?limit=`** → `{ items: Order[] }` (client's, or supplier's when
  supplier-scoped).
- **`GET /v1/orders/{id}`** → `Order`.
- **`PATCH /v1/orders/{id}/fulfilment`** body
  `{ fulfilment:"home|pickup|carrier|install", workshopSupplierId?, appointmentAt? }`
  → `Order`. `install` requires `workshopSupplierId` (else 422 `WORKSHOP_REQUIRED`).
- **`PATCH /v1/orders/{id}/status`** body `{ action:"confirm|start|complete" }`
  → `Order`. **Supplier side only** — needs `order.fulfil` *and* a
  supplier-scoped token.
  - `confirm` → `confirmed`, `start` → `in_progress`, `complete` → `completed`,
    in that order. Anything else is **409 `ILLEGAL_ORDER_TRANSITION`** and the
    response names the transitions that *are* allowed from the current state.
  - **`complete` is what issues the facture.** Make sure the supplier's fiscal
    identity is filled in first (`PATCH /v1/supplier/fiscal`) or no invoice is
    produced — the order still completes, there is simply no document.
- **`POST /v1/orders/{id}/cancel`** body `{ reason? }` → `Order`.
  - Either party; needs `order.cancel`. A supplier-scoped token cancels *as*
    the supplier, anyone else as the buyer. **409** once the order is
    completed or already cancelled.
- **`POST /v1/orders/{id}/purchase-order`** → `Document` — the **bon de
  commande**, sealed. Takes no body; idempotent per order.

`Order`:
```json
{ "id":"uuid","requestId":"uuid","quoteId":"uuid","clientAccountId":"uuid",
  "supplierId":"uuid","fulfilment":"pickup","workshopSupplierId":null,
  "appointmentAt":null,"amount":{"amountMinor":9500,"currency":"EUR"},
  "status":"created","createdAt":"…" }
```

### Client · Reservations (bookable services) — Phase 3
Bookable-service verticals: `workshop`, `body_paint`, `diagnostics`. Discover
their service types via **`GET /v1/catalogue/service-types?vertical=workshop`**
(public) → `{ items: ServiceType[] }`.
- **`POST /v1/reservations`** body
  `{ supplierId, serviceTypeKey, slotStart, slotEnd, vehicleId?, branchId?, note? }`
  → `Reservation` (status `pending`). `slotStart`/`slotEnd` are UTC ISO; the slot
  must be in the future. A service type whose `requiresVehicle` is true needs
  `vehicleId` (else 422 `VEHICLE_REQUIRED`). Booking a taken slot → **409 SLOT_TAKEN**.
- **`GET /v1/reservations?limit=`** → `{ items: Reservation[] }`.
- **`DELETE /v1/reservations/{id}`** → `Reservation` (status `cancelled`).

`Reservation`:
```json
{ "id":"uuid","clientAccountId":"uuid","supplierId":"uuid","branchId":null,
  "serviceTypeKey":"oil_change","vehicleId":"uuid","slotStart":"…","slotEnd":"…",
  "status":"pending","note":null,"createdAt":"…" }
```
Status: `pending → accepted | rejected | rescheduled`; `accepted → completed | cancelled`.

Once the job is finished and priced, `Reservation` carries
`amountMinor`, `currency` and `chargedAt`, and a **facture** appears in
`GET /v1/documents` for it. `amountMinor` is `null` until then — including
for a job completed at no charge, which is a real outcome and not missing
data. `0` means exactly that and issues no facture.

### Client · Assistance (roadside) — Phase 3
- **`POST /v1/assistance`** body
  `{ serviceType:"breakdown|tow|battery|tyre|fuel|lockout", lat, lng, vehicleId?, description?, pickupAddress? }`
  → `AssistanceRequest` (status `requested`).
- **`GET /v1/assistance?limit=`** → `{ items: AssistanceRequest[] }`.
- **`DELETE /v1/assistance/{id}`** → `AssistanceRequest` (status `cancelled`).

`AssistanceRequest` status: `requested → dispatched → en_route → completed`; any
live state `→ cancelled`. (Which supplier is offered a job — dispatch matching —
is not yet finalised; the request/status flow is live.)

`AssistanceRequest` also carries `amountMinor`, `currency` and `chargedAt`
once the call-out is priced, with a **facture** in `GET /v1/documents` for
it. Same rules as a booking.

### Client · Marketplace (used cars) — Phase 3
- **`GET /v1/marketplace/listings`** → `{ items: Listing[] }` (public; published
  listings only). Filters: `brand`, `model`, `maxAmountMinor`, `fuelType`,
  `transmission`, `bodyType`, `condition`, `city`, `minYear`, `maxMileageKm`,
  `acceptsOffers`, `limit`.
- **`GET /v1/marketplace/listings/{id}`** → `Listing` (public).
- **`POST /v1/marketplace/listings`** body
  `{ title, brand?, model?, year?, mileageKm?, amount?, description?, photos?,
     city?, country?, lat?, lng?, fuelType?, transmission?, bodyType?, colour?,
     doors?, engineHp?, condition?, isCustomsCleared?, papersInOrder?,
     ownerCount?, accidentFree?, offerRange? }`
  → `Listing` (auto-published in beta). Needs `listing.publish`.
  - **`photos`** is `[{ bucket:"vehicle-photos", path }]` — the pairs returned
    by `POST /v1/media/uploads`, in gallery order, and they must be your own
    uploads. Up to 20.
  - **`photoUrls` is deprecated as an input.** It asks for an absolute URL
    and the buckets are private, so there is none to give; it is still
    accepted only for a client already in the field. Sending it is why
    listings used to be created with no photos at all.
  - `fuelType`: `essence | diesel | gpl | hybrid | electric`
  - `transmission`: `manual | automatic`
  - `bodyType`: `citadine | berline | break | suv | monospace | utilitaire |
    coupe | cabriolet | pickup`
  - `condition`: `new | used | damaged`
  - **`isCustomsCleared` (*dédouanée*) and `papersInOrder` are three-state:**
    `true`, `false`, or absent. Absent means the seller did not say, which is
    not the same as "no" — render the three differently rather than collapsing
    the last two, or you will label honest listings as problem cars.
  - `offerRange` opens bidding on creation. See **Offers** below.
- **`POST /v1/marketplace/listings/{id}/contact`** body `{ message? }` →
  `{ contacted:true }` (one contact per buyer per listing; can't contact your own).
  Needs `listing.contact`.

`Listing`:
```json
{ "id":"uuid","sellerAccountId":"uuid","supplierId":null,"title":"BMW 320d 2016",
  "brand":"BMW","model":"320d","year":2016,"mileageKm":120000,
  "amount":{"amountMinor":1500000,"currency":"EUR"},"description":null,
  "photoUrls":["http://…/storage/v1/object/sign/vehicle-photos/…?token=…"],
  "photos":[{"bucket":"vehicle-photos","path":"8f1c…/1730300000_front.jpg"}],
  "city":"Paris","country":"FR","status":"published","createdAt":"…",
  "fuelType":"diesel","transmission":"automatic","bodyType":"berline",
  "colour":"Noir","doors":5,"engineHp":190,"condition":"used",
  "isCustomsCleared":true,"papersInOrder":true,"ownerCount":2,"accidentFree":true,
  "acceptsOffers":true }
```

**`photoUrls` are signed and expire** (about an hour); `photos` are the
durable refs behind them. Render `photoUrls`; when one stops working, re-read
the listing or re-sign `photos` through `POST /v1/media/downloads`.

`offerRange` and `pendingBidCount` appear **only** on
`GET /v1/marketplace/listings/{id}/private`, the owner's own view.


#### Offers (bidding) — Phase 3

A seller names a **range of prices they would accept**, buyers make offers, and
the seller is notified only when an offer reaches that range.

**The range is private and must stay that way in your UI too.** It is returned
only from `GET /v1/marketplace/listings/{id}/private`, never from the public
read or the browse list. A buyer who learns the floor offers exactly the floor,
and every offer above it that the seller would have got is lost. For the same
reason, the response to placing an offer does **not** tell the buyer whether it
reached the range.

- **`PUT /v1/marketplace/listings/{id}/offer-range`** body
  `{ minMinor, maxMinor?, currency? }` → `Listing`. Needs `listing.publish`.
  - **Setting a range is what opens bidding.** A listing without one answers
    **422 `OFFERS_NOT_ACCEPTED`**.
  - `currency` may be omitted when the listing has an asking price, and is then
    taken from it. It must match that price.
  - `maxMinor` is optional and **does not cap what the seller hears about** —
    see the table below.
  - PUT, not POST: this is one value you replace, so a retried request leaves
    the same range rather than a second one.
- **`DELETE /v1/marketplace/listings/{id}/offer-range`** → `Listing`. Closes
  bidding. Offers already placed keep the standing they were given.
- **`GET /v1/marketplace/listings/{id}/private`** → `Listing` with
  `offerRange` and `pendingBidCount`. **404 if it is not yours.**
- **`POST /v1/marketplace/listings/{id}/bids`** body
  `{ amount: { amountMinor, currency }, message? }` → **201** `Bid`. Needs
  `listing.bid`.
  - **Raising an offer is another POST.** It supersedes your previous one, so
    the seller only ever sees one current number from you. There is no update
    endpoint and you do not need to withdraw first.
  - 422 `OFFERS_NOT_ACCEPTED` · `CURRENCY_MISMATCH` ·
    `CANNOT_BID_ON_OWN_LISTING`.
  - Throttled to 20/min.
- **`GET /v1/marketplace/listings/{id}/bids`** → `{ items: Bid[] }`.
  - The **seller** sees every offer, highest first, each with `standing`.
  - Anyone else sees **only their own**, with no `standing`.
- **`GET /v1/marketplace/bids?limit=`** → every offer the caller has made.
- **`DELETE /v1/marketplace/bids/{id}`** → `Bid`. The buyer takes it back; 404
  once the seller has decided it.
- **`POST /v1/marketplace/bids/{id}/accept`** → `Bid`. Seller only.
  - **Declines every other live offer on the listing**, in the same
    transaction, and notifies those buyers. One car, one buyer.
  - **409 `BID_ALREADY_DECIDED`** if it is not pending.
  - **The listing status does not change.** A car sale here finishes with
    paperwork days later; marking it `sold` the moment a price is agreed would
    be a claim the seller has to undo. Accepting agrees a price — mark the
    listing sold yourself when it is actually done.
- **`POST /v1/marketplace/bids/{id}/decline`** body `{ reason? }` → `Bid`.
  Seller only. A reason is optional; the buyer is notified either way.

**Who gets notified, and when:**

| The offer is | `standing` | Seller notified | Why |
|---|---|---|---|
| below `minMinor` | `below_range` | **no** | The silence is the point. A seller pinged for every lowball stops reading the pings, and the one real offer then lands in a muted channel. The offer is still recorded and still visible on the listing. |
| from `minMinor` to `maxMinor` | `in_range` | yes | What the seller asked to hear about. |
| above `maxMinor` | `above_range` | **yes** | Better news than the range asked for. The ceiling describes what the seller hoped for; it does not cap what reaches them. |

Both ends are **inclusive** — a seller who says "from 1 700 000" means that
number is acceptable.

`standing` is recorded when the offer is placed, not worked out when you read
it. If the seller moves their range afterwards, an offer that was in range when
it arrived keeps saying so — the notification already went out.

Notification types to expect: `listing.bid` (seller), `listing.bid.accepted`
and `listing.bid.declined` (buyer). A decline carries
`supersededByAcceptance: true` when the car went to someone else.

`Bid`:
```json
{ "id":"uuid","listingId":"uuid","buyerAccountId":"uuid",
  "amount":{"amountMinor":17500000,"currency":"DZD"},
  "message":"Je peux passer ce week-end.",
  "status":"pending","standing":"in_range",
  "declineReason":null,"decidedAt":null,"createdAt":"…" }
```

`status` is `pending | accepted | declined | withdrawn | superseded`.
`superseded` means that buyer raised their offer and the newer one replaced it.

### Supplier · Calendar (reservations) — Phase 3 (supplier-scoped)
- **`GET /v1/supplier/reservations?limit=`** → `{ items: SupplierReservation[] }`.
- **`GET /v1/supplier/reservations/{id}`** → `SupplierReservation`. **Where a
  scanned confirmation lands** — see Documents below. A booking made with
  another business is **404**, never 403.
- **`PATCH /v1/supplier/reservations/{id}`** body
  `{ action:"accept|reject|reschedule|complete|charge", reason?, slotStart?, slotEnd?, amountMinor?, currency? }`
  → `Reservation`. `reschedule` needs `slotStart`+`slotEnd`. Needs `reservation.manage`.

A `SupplierReservation` is the booking **plus who is bringing which car**:

```json
{ "id":"uuid","clientAccountId":"uuid","supplierId":"uuid",
  "serviceTypeKey":"brake_service","vehicleId":"uuid",
  "slotStart":"…","slotEnd":"…","status":"accepted","note":null,"createdAt":"…",
  "customer": { "accountId":"uuid", "name":"Riyad Benali", "phone":"+213…" },
  "vehicle":  { "id":"uuid","name":null,"brand":"Kia","model":"Picanto",
                "year":2010,"vin":"…","plate":"…","mileageKm":100 } }
```

**Do not build a label out of `clientAccountId`.** `customer` and `vehicle`
are `null` when there is nothing to resolve — a service that needs no
vehicle has none, and an account that was never asked for a name has none.
`customer.name` is `null` on its own in that second case. Render the null as
*unknown* (or prompt for the name); a card reading `Client · 4ab5bb55` is the
first eight characters of a primary key, and that is what this field exists
to stop. The client's own `GET /v1/reservations` returns the plain
`Reservation` — there is no customer block on it, because the caller **is**
the customer.

`vehicle` is resolved **owner-scoped on the client named on the booking**, so
a workshop can only ever see a car that was booked in with it.

#### A facture for every paid interaction

Whenever money reaches a business for a supply it made, the client gets a
sealed, numbered **facture** — no exceptions, and nothing for you to
request. What changed is that two of the three paid interactions had no
amount recorded at all, so there was nothing to build one from.

| paid interaction | priced by | facture subject |
|---|---|---|
| a parts order | the accepted quote; completing the order | `order` |
| a workshop service | `complete` or `charge` below | `reservation` |
| a roadside call-out | `complete` or `charge` on dispatch | `assistance` |

A marketplace car sale is **not** on this list. A private individual
selling their own car is not making a business supply, and a numbered
facture out of our fiscal series for their transaction would be inventing
a tax document for something we are not party to.

**Two ways to state the bill**, because the Terminer button never asked
for money and does not have to start:

```json
PATCH /v1/supplier/reservations/{id}
{ "action":"complete", "amountMinor":450000, "currency":"DZD" }
```
```json
PATCH /v1/supplier/reservations/{id}
{ "action":"charge", "amountMinor":450000, "currency":"DZD" }
```

`amountMinor` is **integer minor units** — `450000` is 4 500,00 DZD — and
is the price the client agreed to pay, **including tax**; HT and TVA are
derived backwards from it on the document. `0` records a job done for
nothing and issues no facture.

**Write-once.** Sending the same amount again is accepted and changes
nothing, so retries are safe. A **different** amount is
`409 ALREADY_CHARGED`: the facture is already sealed and in the customer's
hands, and correcting it is a credit note, not an `UPDATE`. Charging a
booking that is not completed is `409 RESERVATION_NOT_COMPLETED`.

#### Automatically, never on demand

**You never ask for a facture.** There is no endpoint that creates one,
and there will not be: a signature over content the client supplied would
certify nothing — a supplier could mint a facture for any amount against
any NIF and our own key would vouch for it. The server issues them off
events it already trusts, within a few seconds of the charge being
recorded. Poll the list, or just read it next time the screen opens.

It is **not** issued if the supplier's fiscal profile is incomplete — NIF,
NIS, RC and the article d'imposition are mandatory mentions in Algeria, and
a facture without them is not a tax document. Fill them in with
`PATCH /v1/supplier/fiscal`. Nothing fails loudly here: the charge is
recorded and no document appears, so a business with an incomplete profile
quietly accumulates uninvoiced work. Check the profile before you let them
start charging.

Issuance is **exactly once per supply**, enforced by a unique index on
(type, subject_type, subject_id) rather than by a check in code, so a
redelivered event cannot produce a second facture for one sale.

#### Retrieving them

| who | endpoint |
|---|---|
| the **client** — factures issued to them | `GET /v1/documents?type=invoice` |
| the **business** — factures it issued | `GET /v1/supplier/documents?type=invoice` |
| either party — the PDF | `GET /v1/documents/{id}/download` |

Two listings because they answer different questions. `GET /v1/documents`
answers **by recipient**, and a business is not the recipient of its own
facture — so the supplier-scoped one is how a business reads its own
ledger, the set of documents that carry its fiscal identity and that it is
required to keep. Both take `?limit=` (max 100, newest first) and
`?type=`; drop `type` to get confirmations and the rest alongside.

`GET /v1/documents/{id}/download` → `{ url }`, a **short-lived signed
URL** to the stored PDF. The bucket is private and there is no permanent
public link, so fetch it when the user taps and do not cache it. Either
party may download; anyone else gets **404**, not 403.

To show a total without downloading the PDF, scan it:
`GET /v1/documents/verify/{contentHash}` returns `content.totalMinor`,
`content.currency` and the printed lines. See **Documents** below.

### Supplier · Dispatch (assistance) — Phase 3 (supplier-scoped)
- **`PATCH /v1/supplier/assistance/{id}`** body
  `{ action:"accept|en_route|complete|charge", amountMinor?, currency? }`
  → `AssistanceRequest`. `accept` claims the job. Needs `reservation.manage`.
  Charging works exactly as it does for a booking — see *A facture for every
  paid interaction* under **Supplier · Calendar** above. `charge` requires
  `amountMinor`; an unfinished job is `409 ASSISTANCE_NOT_COMPLETED`.

### Supplier · Catalogue (products / offers / deals) — Phase 3 (supplier-scoped)
All need `supplier.catalog.manage`.
- **`GET /v1/supplier/products`** → `{ items: Product[] }`; **`POST`** body
  `{ name, tecdocArticleId?, reference?, categoryKey?, amount?, quantity?, isDeal? }`;
  **`PATCH /v1/supplier/products/{id}`** (same fields, partial); **`DELETE …/{id}`**.
- **`GET /v1/supplier/deals`** → `{ items: Product[] }` (products with `isDeal:true`).
- **`GET /v1/supplier/offers`** → `{ items: ServiceOffer[] }`; **`POST`** body
  `{ serviceTypeKey, name, description?, amount?, durationMins? }`; **`DELETE …/{id}`**.

### Notifications
- **`GET /v1/notifications?limit=`** → `{ items: Notification[], unread: number }`.
  Supplier session → supplier feed; otherwise account feed.
- **`PATCH /v1/notifications/{id}/read`** → `{ ok: true }`.
- **`POST /v1/devices`** body `{ fcmToken, platform?:"android|ios|web" }` → `{ ok: true }`.
  Register on login and on token refresh; registering the same token upserts.

`Notification`:
```json
{ "id":"uuid","type":"quote.received","title":"New quote received",
  "body":null,"refId":"request-uuid","read":false,"createdAt":"…" }
```

Notification `type` values you'll see: `welcome`, `request.received`,
`quote.received`, `quote.alternative`, `quote.rejected`, `quote.accepted`,
`order.created`, `order.status`. `refId` points at the related request/order.

### Catalogue (TecDoc-backed; fixtures in Phase 1)
- **`GET /v1/catalogue/vehicles/resolve?manufacturer=&model=&year=&vin=`** →
  `{ items: VehicleType[] }` (KType candidates).
- **`GET /v1/catalogue/assembly-groups?kType=`** → `{ items: AssemblyGroup[] }`.
- **`GET /v1/catalogue/articles?kType=&group=&oe=&text=&limit=`** → `{ items: ArticleRef[] }`.
- **`GET /v1/catalogue/articles/{id}`** → `ArticleRef` + `{ attributes, images, oeNumbers }`.
- **`GET /v1/catalogue/cross-refs?oe=` or `?articleId=`** → `{ items: ArticleRef[] }`
  (equivalents — powers "Find Best Alternative").

> The catalogue is served by the TecDoc anti-corruption adapter. When
> `TECDOC_BASE_URL` + `TECDOC_API_KEY` are configured the backend uses the **live
> TecDoc adapter** (circuit breaker + short-TTL Redis cache, degrading to
> fixtures on outage); otherwise it serves the **fixture stub** (VW Golf VII,
> Renault Clio IV, Peugeot 208). The response shapes are identical either way —
> no client changes.

### Media & scan — Phase 2

Bytes never stream through the API, in either direction. **Every bucket is
private**, so an image is always two steps: a pre-signed `PUT` to upload, and
a short-lived signed URL to display.

#### Uploading
- **`POST /v1/media/uploads`** body
  `{ bucket, filename, contentType? }` where `bucket` is one of
  `registrations`, `vehicle-photos`, `part-photos`, `avatars`,
  `message-attachments`, `post-media`, `driver-documents`, `supplier-media`
  → `{ uploadUrl, path, token, expiresInSeconds }`.

  `PUT` the file to `uploadUrl`, then **persist the returned `path` together
  with the bucket** — that pair is the durable reference. `uploadUrl` is a
  write handle that expires in two hours; it is not a way to read the file
  back and must never be stored as one.

#### Displaying
- **`POST /v1/media/downloads`** body
  `{ items: [{ bucket, path }], expiresInSeconds? }` (up to 50 items)
  → `{ items: [{ bucket, path, url, expiresAt }] }`.

  `url` needs **no headers** — put it straight in an `<img>` or
  `Image.network`. It expires (default one hour), so sign when you are about
  to render, not when you store. `url: null` means storage has no such
  object; draw the rest of the card without it.

  Batch it. One call carries everything on screen; the server makes one
  request to storage per bucket, however many images you asked for.

  **You do not need this for a feed or a listing** — those already carry
  signed URLs in their own responses (`PostMedia.url`, `Listing.photoUrls`).
  Use it to refresh a URL that has expired, or for images whose DTO still
  returns only the pair (a supplier logo, an avatar).

  Who may read what: `post-media`, `avatars`, `supplier-media`,
  `vehicle-photos` and `part-photos` are readable by any signed-in caller,
  because that content is already published to people who did not upload it.
  `registrations`, `driver-documents` and `message-attachments` only within
  your own upload namespace. `documents` is **not** served here — a facture
  comes from `GET /v1/documents/{id}/download`.
- **`POST /v1/vehicles/scan`** body `{ bucket:"registrations", path }` →
  `{ draft: { vin, brand, model, plate, year, confidence } }`.
  OCR of a registration document. The result is a **draft only** — show it for
  confirmation, then create the vehicle via `POST /v1/vehicles`. Never auto-commit;
  `confidence` (0..1) is low in the current stub. `path` must be within your own
  upload namespace (it is, if it came from `POST /v1/media/uploads`).

---

### Messaging — Phase 3

Text, photos and voice notes, between two accounts, optionally *about*
something (a listing, a part request, an order).

- **`GET /v1/conversations?limit=`** → `{ items: Conversation[] }`, most
  recently active first. `unreadCount` is computed per caller.
- **`POST /v1/conversations`** body:
  ```json
  { "withAccountId":"uuid", "contextType":"listing", "contextId":"uuid",
    "subject":"Clio IV 2018", "asSupplierId":null }
  ```
  → `Conversation`.
  - **Idempotent per (participants, context).** Tapping "contact seller"
    twice on the same listing returns the conversation that already exists
    rather than creating a second one. Do not try to deduplicate client-side.
  - `asSupplierId` makes the caller take part **as a business**; it requires
    the caller to hold that supplier's scope in the token.
  - `contextType` ∈ `listing` | `request` | `order`, and may be omitted for a
    conversation about nothing in particular.
- **`GET /v1/conversations/{id}`** → `Conversation`. 404 if you are not a
  participant — not 403, so the endpoint does not confirm a conversation
  exists to someone outside it.
- **`GET /v1/conversations/{id}/messages?limit=&cursor=`** →
  `{ items: Message[], nextCursor }`, **newest first**. Keyset pagination;
  `nextCursor: null` means you have reached the beginning of the thread.
- **`POST /v1/conversations/{id}/messages`** body:
  ```json
  { "kind":"text", "body":"Bonjour, je passe demain matin." }
  ```
  → `Message`. Requires the `message.send` permission.
  - **A text message needs `body`.** A `photo` or `voice` message needs
    `attachmentBucket` + `attachmentPath` instead — upload the file through
    `POST /v1/media/uploads` to the `message-attachments` bucket first, then
    send the `path` you got back. Bytes never go through this endpoint.
  - Send `durationMs` on voice notes. The client needs it to draw the
    waveform and show a length without downloading the audio.
- **`POST /v1/conversations/{id}/read`** → `204`. Moves the caller's read
  marker to now, which is what clears `unreadCount` for them. It does not
  affect the other participant's marker.

`Conversation`:
```json
{ "id":"uuid","contextType":"listing","contextId":"uuid","subject":"Clio IV 2018",
  "participants":[
    {"accountId":"uuid","supplierId":null,"lastReadAt":"…"},
    {"accountId":"uuid","supplierId":"uuid","lastReadAt":null}],
  "lastMessage":{ /* Message */ },"unreadCount":3,
  "lastMessageAt":"…","createdAt":"…" }
```

`Message`:
```json
{ "id":"uuid","conversationId":"uuid","senderAccountId":"uuid","kind":"voice",
  "body":null,"attachmentBucket":"message-attachments",
  "attachmentPath":"<accountId>/1739357000_note.m4a","durationMs":4200,
  "createdAt":"…" }
```

### Social feed — Phase 3

Posts with text, photos and video, plus likes and comments.

**A post belongs to an ACCOUNT, optionally speaking for a BUSINESS.**
`authorAccountId` is always who pressed post; `authorSupplierId` is the
business they pressed it on behalf of. Render the business badge from the
second and keep the first for accountability. A client posting about their own
car has no supplier; a *fournisseur* staff member posting a promotion has both.

- **`GET /v1/feed?limit=&cursor=&author=&supplier=&kind=&pinnedFirst=`** →
  `{ items: Post[], nextCursor }`.
  - **There is no follow graph.** The feed is every published post, newest
    first. That is a deliberate starting point, not an unfinished one: nothing
    in the app lets a user follow anyone, so a graph nobody could populate
    would just make the feed empty.
  - `author` gives a profile timeline, `supplier` a business page.
  - Keyset pagination, so posts arriving while the user scrolls do not cause
    duplicates or skipped rows the way an offset would.
- **`POST /v1/posts`** body
  `{ body?, kind?, media?: [{ kind, bucket, path, durationMs? }], asSupplierId? }`
  → `Post`. Needs `post.publish`.
  - `kind` is `announcement` (default) | `promotion` | `arrival` | `job` — the
    chip on the card. Filter the feed with `?kind=`.
  - Needs text **or** at least one media item (422 otherwise).
  - Media goes up through **`POST /v1/media/uploads`** to the **`post-media`**
    bucket first; send the returned `path` values here **in display order**.
    Bytes never pass through this endpoint, and a path outside your own upload
    namespace is **403**.
  - `asSupplierId` requires a supplier-scoped token for that exact supplier.
    **403** otherwise — the badge is what readers trust, so it is not a
    free-text field.
  - `durationMs` is video only.

**Rendering a post's media.** Each item in `Post.media` carries a signed
`url` alongside `(bucket, path)` — the feed signs the whole page in one go,
so there is no second request to make. Put `url` straight in an `<img>`; it
needs no headers and expires at `urlExpiresAt` (about an hour). `url: null`
means the object is gone from storage — show the post without the picture.
`(bucket, path)` does not expire, so keep it if you cache, and re-sign
through `POST /v1/media/downloads` when you come back to it.

- **`GET /v1/posts/{id}`** → `Post`.
- **`DELETE /v1/posts/{id}`** → `Post` with status `removed`. Author only;
  **404** if it is not yours. Not a delete: a post somebody has commented on
  or reported stops being visible without taking the conversation, or the
  evidence, with it.
- **`POST /v1/posts/{id}/takedown`** body `{ reason }` → `Post`. Any post,
  requires `platform.admin`.
- **`POST /v1/posts/{id}/like`** / **`DELETE /v1/posts/{id}/like`** → `Post`.
  Needs `post.interact`. **Both idempotent** — double-tapping is how people
  use a like button, so a second call leaves the count where it was. Use the
  returned `likeCount` and `likedByMe` rather than adjusting locally.
- **`GET /v1/posts/{id}/comments?limit=&cursor=`** →
  `{ items: Comment[], nextCursor }`, **oldest first** — a thread is read in
  the order it was said.
- **`POST /v1/posts/{id}/comments`** body `{ body, asSupplierId? }` → **201**
  `Comment`. Needs `post.interact`.
- **`POST /v1/posts/{id}/share`** body `{ channel? }` → `Post`. Needs
  `post.interact`. Idempotent and **not retractable**: a share describes
  something that already happened outside the app, so `shareCount` is a reach
  number rather than a mood. `channel` is `link` | `whatsapp` | `facebook` |
  `other`.
- **`PUT /v1/posts/{id}/pin`** / **`DELETE /v1/posts/{id}/pin`** → `Post`.
  Needs `post.publish`, your own post only (**404** otherwise).
  - **One pin per business and one per person.** Pinning another releases the
    previous one in the same transaction, so there is never a moment with two.
    Which slot a post takes is read from the post: one written on behalf of a
    business takes that business's, a personal one takes its author's.
  - Read a timeline with its pin at the front using
    **`GET /v1/feed?supplier=…&pinnedFirst=true`** (or `author=`). It is opt-in
    because on the global feed "pinned first" would put every business's pin
    ahead of everything written today — an advertising board, not a feed. The
    pin appears on the **first page only**, and that page carries one item
    more than `limit` when a pin exists — dropping a real post to make room
    for it would be worse. Keyset paging over the rest is unaffected.

`Post`:
```json
{ "id":"uuid","authorAccountId":"uuid","authorSupplierId":null,
  "body":"Nouvelle arrivée : plaquettes Bosch",
  "media":[{"id":"uuid","kind":"photo","bucket":"post-media",
            "path":"<accountId>/1739357000_1.jpg","durationMs":null,"ordinal":0}],
  "kind":"arrival",
  "likeCount":12,"commentCount":3,"shareCount":4,"likedByMe":true,
  "pinnedAt":null,"status":"published","createdAt":"…" }
```

### Documents — Phase 3

Invoices, reservation confirmations and the rest, as **PDFs the server
signed**. Every document is hashed (SHA-256) and signed (Ed25519) over its
exact stored bytes, and kept in a private bucket unchanged.

**Rendered once, at issue.** The PDF is produced inside the issuing
transaction from a frozen payload snapshot, signed, and written to storage;
the download endpoint hands out a signed URL to *that stored object*. Nothing
is re-rendered on download, so a document cannot change after it is issued —
not when a supplier edits their profile, not when a buyer closes their
account, and not when the document is voided. That is what makes the stored
hash meaningful.

**Every document carries its own fingerprint**, printed in full and encoded
in a QR, bottom-right. Both are drawn into the sealed bytes, so they are part
of what the signature covers. You do not need to render a QR anywhere.

`contentHash` is a SHA-256 over what the document *says* — its number, type,
issue instant, place in the chain, and the exact payload it was rendered
from. One comma changed in a line description gives a completely different
digest, and **no two documents share one**, including two that say exactly
the same thing: the number and the issue instant are part of the pre-image,
and the column has a unique index.

It is **not** the hash of the PDF file, and it cannot be: a file hash printed
inside the file changes the bytes it was taken over. The file hash is
`sha256`, and it has its own use — see the `POST` verify below.

| | over | use it to |
|---|---|---|
| `contentHash` | the content | look the document up: scan the QR, or let someone type the printed value |
| `sha256` | the stored bytes | check a file somebody hands you, by uploading it |

**There is no endpoint that creates a document from a request body, and there
will not be one.** A signature over content the client supplied would certify
nothing — a supplier could mint a facture for any amount against any NIF and
our own key would vouch for it. Documents are issued by the server off events
it already trusts. Your job is to list, download and verify them.

- **`GET /v1/documents?limit=&type=`** → `{ items: Document[] }` — documents
  issued **to** the caller, newest first. `?type=invoice` for factures only.
  This is where a client finds its factures.
- **`GET /v1/supplier/documents?limit=&type=`** → `{ items: Document[] }` —
  documents this business **issued**. Supplier-scoped; needs `order.read`.
  `?type=invoice` is its sales ledger. It exists because the listing above
  answers by recipient, and a business is not the recipient of its own
  facture — which left every facture visible to the client and invisible to
  the party whose NIF is printed on it.
- **`GET /v1/documents/{id}/download`** → `{ url }`, a **short-lived** signed
  URL. The bucket is private; there is no permanent public link. Fetch the URL
  when the user taps, do not cache it. **Either party** may download it: the
  client it was issued to, or the issuing business on a supplier-scoped
  token. Anyone else gets 404, not 403.
- **`GET /v1/documents/verify/{fingerprint}`** → `VerificationResult`.
  **Public.** This is what the QR opens, so anyone holding a paper copy can
  check it. `fingerprint` is the document's `contentHash`; **separators and
  case are ignored**, so you can pass what somebody typed off the page
  (`6B89C31D C3D56279 …`) without cleaning it up first. A document **number**
  works on the same path — use it for documents issued before 2026-11-09,
  which have no fingerprint. A lookup **by number** returns status and
  authenticity only — no amounts, no parties, no `subject` — because numbers
  are sequential and guessable.

#### A scan is navigation, not just a verdict

On a **fingerprint** lookup the answer also carries `subject`:

```json
"subject": { "type": "reservation", "id": "4d2fa9fb-…" }
```

That is what the document is **about**, and it is the whole point of
scanning one. A workshop pointing a camera at a confirmation wants the
booking on screen — customer, car, slot — not a badge saying GENUINE. Route
on it:

| `subject.type` | go to |
|---|---|
| `reservation` | `GET /v1/supplier/reservations/{subject.id}` (supplier) |
| `order` | the order screen for that id |

It is a **pointer, not an authorisation**. Following it still needs a token
the owning endpoint accepts, and that endpoint answers 404 if the booking is
not yours, so an anonymous scanner learns a UUID and nothing else. Never
show a booking's contents off the back of a scan alone — fetch them.

`content.fields` carries the document's own label/value lines, as printed.
That is what a confirmation offers in place of a total: service,
appointment, car. Show them beside the paper — it is how a holder catches a
fingerprint that was copied onto a page saying something else.
- **`POST /v1/documents/verify/{fingerprint}`** body `{ "file":"<base64 pdf>" }` →
  `VerificationResult` with `matchesSuppliedFile`. The stronger check: it
  compares the bytes *the holder has* against the bytes we sealed, which
  proves their copy is the real one rather than asking them to trust our
  screen. Public.
- **`GET /v1/documents/keys`** → `{ algo, keys[] }`, the public signing keys,
  so a third party can verify a document **offline**. Retired keys stay listed
  so old documents keep verifying after a rotation. Public.
- **`POST /v1/documents/{id}/void`** body `{ reason }` → `Document`. Requires
  `platform.admin`.

**`authentic` and `status` are different questions, and the UI must not
conflate them.** A voided document is still authentic — we really did issue
it — but it is no longer valid. Voiding never deletes or alters the stored
bytes, which is exactly why a voided document keeps verifying. Render
`message`, which states both facts in one sentence, rather than deriving your
own wording from the booleans.

Voiding is **purely administrative**: no credit note, no accounting entry, no
reversal document. The status flips and the verifier starts saying so.

`Document`:
```json
{ "id":"uuid","type":"invoice","number":"FA-2026-000001",
  "subjectType":"order","subjectId":"uuid",
  "issuedToAccountId":"uuid","supplierId":"uuid","status":"issued",
  "contentHash":"96340dd3…",
  "sha256":"9f2b…","algo":"ed25519","keyId":"k1","signatureFormat":"detached",
  "byteSize":3001,"issuedAt":"…","voidedAt":null,"voidReason":null }
```

Document numbers are **gapless per series and per year**, which is what a
fiscal series requires:

| Type | Series | Example |
|---|---|---|
| `invoice` | `FA` | `FA-2026-000001` |
| `credit_note` | `AV` | `AV-2026-000001` |
| `quotation` | `DEV` | `DEV-2026-000001` |
| `purchase_order` | `BC` | `BC-2026-000001` |
| `reservation_confirmation` | `RES` | `RES-2026-000001` |
| `receipt` | `REC` | `REC-2026-000001` |

## 7. Enums & state machines

**Request status:** `pending → awaiting_client → (accepted | refused)`;
also `→ expired` (past `expiresAt`) or `→ cancelled` (client). Terminal states
never reopen.

**Quote status:** `pending → quoted → (accepted | refused)`; a supplier may
`reject` (→ `rejected`); siblings of an accepted quote go `closed`.

**Order status:** `created → confirmed → in_progress → completed`; any live state
`→ cancelled`. Driven by `PATCH /v1/orders/{id}/status` (supplier) and
`POST /v1/orders/{id}/cancel` (either party). **Completion issues the facture**,
so it is not a cosmetic flag.

**Vehicle health:** `optimal | good | warning | critical | urgent` (worst wins).
**Maintenance task:** `pending → due → (done | dismissed)`.

**Reservation:** `pending → accepted | rejected | rescheduled`;
`accepted → completed | cancelled`.
**Assistance:** `requested → dispatched → en_route → completed`; any live `→ cancelled`.
**Listing:** `draft | published | pending_review | sold | withdrawn`.

**Verticals (8):** `part_store`, `wholesaler` (receive part requests);
`workshop`, `body_paint`, `diagnostics` (bookable services); `showroom`
(vehicle listings); `roadside` (dispatch); `insurance` (published offers).
`GET /v1/catalogue/service-types` lists the bookable service types per vertical.

Illegal transitions return **409** — surface them as "this changed, refresh"
rather than hard errors.

---

## 8. OpenAPI & codegen

- Interactive docs (Swagger UI): `GET /v1/docs`
- Raw spec (OpenAPI 3): `GET /v1/docs-json`

Generate a typed client, e.g.:

```bash
npx openapi-typescript http://localhost:3000/v1/docs-json -o src/api/schema.ts
# or openapi-generator-cli for a full client
```

The spec is the source of truth for shapes; this guide is the source of truth for
behavior (auth, realtime, idempotency, state machines). When they disagree, tell
backend — they should never disagree.
