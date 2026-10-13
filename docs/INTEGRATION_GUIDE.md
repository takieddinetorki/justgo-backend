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
  `quote.accept|refuse`, `order.read|create`, `reservation.create`, `listing.*`
- `guest`: `request.create`, `request.read`
- `supplier_owner`: `me.*`, `quote.submit`, `supplier.requests.read`,
  `supplier.profile.manage`, `supplier.catalog.manage`, `order.read`,
  `reservation.manage`
- `branch_manager`: like `supplier_owner` minus profile management
- `ops_admin`: `platform.admin`

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
- **`PUT /v1/me`** body `{ firstName?, familyName?, phone?, locale? }` → `Account`.

`Account`:
```json
{ "id":"uuid","authUserId":"uuid","firstName":null,"familyName":null,
  "email":"user@example.com","phone":null,"locale":"en",
  "roles":["client"],"createdAt":"2026-08-26T17:00:00.000Z" }
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
  "tecdocVehicleTypeId":12345,"tecdocManufacturerId":11,"tecdocModelId":22,
  "healthStatus":"good","photoUrl":null,"createdAt":"…" }
```
`healthStatus` ∈ `optimal | good | warning | critical | urgent`.
`MaintenanceTask.status` ∈ `pending | due | done | dismissed`.

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

### Client · Assistance (roadside) — Phase 3
- **`POST /v1/assistance`** body
  `{ serviceType:"breakdown|tow|battery|tyre|fuel|lockout", lat, lng, vehicleId?, description?, pickupAddress? }`
  → `AssistanceRequest` (status `requested`).
- **`GET /v1/assistance?limit=`** → `{ items: AssistanceRequest[] }`.
- **`DELETE /v1/assistance/{id}`** → `AssistanceRequest` (status `cancelled`).

`AssistanceRequest` status: `requested → dispatched → en_route → completed`; any
live state `→ cancelled`. (Which supplier is offered a job — dispatch matching —
is not yet finalised; the request/status flow is live.)

### Client · Marketplace (used cars) — Phase 3
- **`GET /v1/marketplace/listings?brand=&maxAmountMinor=&limit=`** → `{ items: Listing[] }`
  (public; published listings only).
- **`GET /v1/marketplace/listings/{id}`** → `Listing` (public).
- **`POST /v1/marketplace/listings`** body
  `{ title, brand?, model?, year?, mileageKm?, amount?, description?, photoUrls?, city?, country?, lat?, lng? }`
  → `Listing` (auto-published in beta). Needs `listing.publish`.
- **`POST /v1/marketplace/listings/{id}/contact`** body `{ message? }` →
  `{ contacted:true }` (one contact per buyer per listing; can't contact your own).
  Needs `listing.contact`.

`Listing`:
```json
{ "id":"uuid","sellerAccountId":"uuid","supplierId":null,"title":"BMW 320d 2016",
  "brand":"BMW","model":"320d","year":2016,"mileageKm":120000,
  "amount":{"amountMinor":1500000,"currency":"EUR"},"description":null,
  "photoUrls":[],"city":"Paris","country":"FR","status":"published","createdAt":"…" }
```

### Supplier · Calendar (reservations) — Phase 3 (supplier-scoped)
- **`GET /v1/supplier/reservations?limit=`** → `{ items: Reservation[] }`.
- **`PATCH /v1/supplier/reservations/{id}`** body
  `{ action:"accept|reject|reschedule|complete", reason?, slotStart?, slotEnd? }`
  → `Reservation`. `reschedule` needs `slotStart`+`slotEnd`. Needs `reservation.manage`.

### Supplier · Dispatch (assistance) — Phase 3 (supplier-scoped)
- **`PATCH /v1/supplier/assistance/{id}`** body `{ action:"accept|en_route|complete" }`
  → `AssistanceRequest`. `accept` claims the job. Needs `reservation.manage`.

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
Uploads never stream through the API — you get a short-lived pre-signed URL and
`PUT` the bytes straight to storage.
- **`POST /v1/media/uploads`** body
  `{ bucket:"registrations|vehicle-photos|part-photos|avatars", filename, contentType? }`
  → `{ uploadUrl, path, token, expiresInSeconds }`. `PUT` the file to `uploadUrl`,
  then persist the returned `path` (e.g. as a vehicle `photoUrl`, or feed it to scan).
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

- **`GET /v1/feed?limit=&cursor=&author=&supplier=`** →
  `{ items: Post[], nextCursor }`.
  - **There is no follow graph.** The feed is every published post, newest
    first. That is a deliberate starting point, not an unfinished one: nothing
    in the app lets a user follow anyone, so a graph nobody could populate
    would just make the feed empty.
  - `author` gives a profile timeline, `supplier` a business page.
  - Keyset pagination, so posts arriving while the user scrolls do not cause
    duplicates or skipped rows the way an offset would.
- **`POST /v1/posts`** body
  `{ body?, media?: [{ kind, bucket, path, durationMs? }], asSupplierId? }`
  → `Post`. Needs `post.publish`.
  - Needs text **or** at least one media item (422 otherwise).
  - Media goes up through **`POST /v1/media/uploads`** to the **`post-media`**
    bucket first; send the returned `path` values here **in display order**.
    Bytes never pass through this endpoint, and a path outside your own upload
    namespace is **403**.
  - `asSupplierId` requires a supplier-scoped token for that exact supplier.
    **403** otherwise — the badge is what readers trust, so it is not a
    free-text field.
  - `durationMs` is video only.
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

`Post`:
```json
{ "id":"uuid","authorAccountId":"uuid","authorSupplierId":null,
  "body":"Nouvelle arrivée : plaquettes Bosch",
  "media":[{"id":"uuid","kind":"photo","bucket":"post-media",
            "path":"<accountId>/1739357000_1.jpg","durationMs":null,"ordinal":0}],
  "likeCount":12,"commentCount":3,"likedByMe":true,
  "status":"published","createdAt":"…" }
```

### Documents — Phase 3

Invoices, reservation confirmations and the rest, as **PDFs the server
signed**. Every document is hashed (SHA-256) and signed (Ed25519) over its
exact stored bytes, and kept in a private bucket unchanged.

**There is no endpoint that creates a document from a request body, and there
will not be one.** A signature over content the client supplied would certify
nothing — a supplier could mint a facture for any amount against any NIF and
our own key would vouch for it. Documents are issued by the server off events
it already trusts. Your job is to list, download and verify them.

- **`GET /v1/documents?limit=`** → `{ items: Document[] }` — documents issued
  to the caller.
- **`GET /v1/documents/{id}/download`** → `{ url }`, a **short-lived** signed
  URL. The bucket is private; there is no permanent public link. Fetch the URL
  when the user taps, do not cache it.
- **`GET /v1/documents/verify/{number}`** → `VerificationResult`. **Public.**
  This is the QR target printed on every document, so anyone holding a paper
  copy can check it. Returns status and authenticity only — no amounts, no
  parties — because document numbers are guessable.
- **`POST /v1/documents/verify/{number}`** body `{ "file":"<base64 pdf>" }` →
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
