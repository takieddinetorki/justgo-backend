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

## 7. Enums & state machines

**Request status:** `pending → awaiting_client → (accepted | refused)`;
also `→ expired` (past `expiresAt`) or `→ cancelled` (client). Terminal states
never reopen.

**Quote status:** `pending → quoted → (accepted | refused)`; a supplier may
`reject` (→ `rejected`); siblings of an accepted quote go `closed`.

**Order status:** `created → confirmed → in_progress → completed`; any live state
`→ cancelled`.

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
