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

**The backend does not issue tokens.** Sign-in is handled by the self-hosted
**Supabase GoTrue**. The flow:

1. The app authenticates the user against GoTrue (email or phone) and receives a
   JWT (access token) + refresh token.
2. The app calls this API with `Authorization: Bearer <access_token>`.
3. This API verifies the JWT (HS256, shared secret) and builds an auth context
   from its claims.

### Signing in (GoTrue, via Kong)

Use `supabase-js` (recommended) or call GoTrue directly. Direct example:

```
POST http://localhost:8100/auth/v1/token?grant_type=password
apikey: <SUPABASE_ANON_KEY>
Content-Type: application/json

{ "email": "user@example.com", "password": "…" }
```

Response contains `access_token` (the JWT you send to this API) and
`refresh_token`. Refresh with `grant_type=refresh_token`. Phone OTP and email
sign-up use the standard GoTrue endpoints (`/auth/v1/signup`, `/auth/v1/otp`, …).

`supabase-js`:

```ts
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const { data } = await supabase.auth.signInWithPassword({ email, password });
const jwt = data.session.access_token; // -> Authorization: Bearer <jwt>
```

### Claims this API reads

| Claim | Meaning |
|---|---|
| `sub` / `account_id` | the user's account id (falls back to `sub` if `account_id` absent) |
| `roles` | string[] of role keys (e.g. `client`, `supplier_owner`) |
| `permissions` | string[] of permission keys the RBAC guard checks |
| `supplier_id` | present for supplier staff — scopes them to one supplier |
| `branch_id` | optional branch scope |
| `locale` | `en` \| `es` \| `fr` (defaults `en`) |

> **First contact:** a freshly-created GoTrue user has no account row yet. The
> first call to `GET /v1/me` self-provisions the account (with the default
> `client` role) and returns it. Call `GET /v1/me` right after sign-in.

> **Supplier sessions:** a supplier staff member's token carries `supplier_id`.
> The same endpoints behave supplier-side when that claim is present (e.g.
> `GET /v1/orders` returns the supplier's orders, `GET /v1/notifications`
> returns the supplier's feed). Provisioning supplier scope onto a token
> (role assignment + claim mapping) is an operational step outside these
> endpoints in Phase 1 — coordinate with backend for test tokens.

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

All endpoints require `Authorization: Bearer <jwt>` except `GET /v1/health`.

### Me
- **`GET /v1/me`** → `Account`. Self-provisions on first call.
- **`PUT /v1/me`** body `{ firstName?, familyName?, phone?, locale? }` → `Account`.

`Account`:
```json
{ "id":"uuid","authUserId":"uuid","firstName":null,"familyName":null,
  "email":"user@example.com","phone":null,"locale":"en",
  "roles":["client"],"createdAt":"2026-08-26T17:00:00.000Z" }
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

> Phase-1 catalogue returns fixture data with a handful of vehicles (VW Golf VII,
> Renault Clio IV, Peugeot 208) and articles. Phase 2 swaps in the live TecDoc
> adapter behind the same shapes — no client changes.

---

## 7. Enums & state machines

**Request status:** `pending → awaiting_client → (accepted | refused)`;
also `→ expired` (past `expiresAt`) or `→ cancelled` (client). Terminal states
never reopen.

**Quote status:** `pending → quoted → (accepted | refused)`; a supplier may
`reject` (→ `rejected`); siblings of an accepted quote go `closed`.

**Order status:** `created → confirmed → in_progress → completed`; any live state
`→ cancelled`.

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
