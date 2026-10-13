# App ↔ backend gap report

Source: `app32 (1).apk`, read against the live dev server
(`168.231.87.48`) — its 51-route OpenAPI spec and its actual request logs.

**How this was established.** Screen and class names come from the Dart
AOT snapshot, so they prove a screen *ships*; they do not prove what it
renders. Everything about what the app actually *calls* comes from server
logs — real traffic from real use, not inference. Where the two
disagree, trust the logs.

---

## 0. Status — updated 2026-10-13

Everything in §3 below is now **built, deployed and verified on
`168.231.87.48`**, except one piece that is deliberately not built.

| § | Feature | State |
|---|---|---|
| 3.1 | Services Directory | **done** — `GET /v1/discovery/directory`, a separate route so the shipped APK is not broken |
| 3.2 | Social feed | **done** — `/v1/feed`, `/v1/posts`, likes, comments |
| 3.3 | Messaging | **done** — conversations, text / photo / voice, read receipts |
| 3.4 | Reclamations | **done** — case state machine, thread, evidence, internal ops notes |
| 3.5 | Driver — identity + KYC | **done** — apply, documents, submit, ops review, availability |
| 3.5 | Driver — **earnings** | **NOT BUILT, on purpose** — see below |
| 4.1 | Image upload | fixed; buckets created and scripted |

Also built along the way, because the invoice needed them:

- **Documents** — sealed PDFs (Ed25519 + SHA-256), public verification,
  administrative voiding. Invoice, devis, bon de commande, reservation
  confirmation.
- **Order lifecycle** — `PATCH /v1/orders/{id}/status` and
  `POST /v1/orders/{id}/cancel`. Before this, nothing advanced an order past
  `created`, so `completed` was unreachable.
- **`scripts/smoke.mjs`** — an end-to-end test against the real deployment.
  It found four defects on its first run that the unit suite could not see.

### The one thing that is blocked: driver earnings

`DriverEarningsScreen` ships in the app. It has no backend and will not get
one until three questions are answered, because every one of them changes
what a driver is owed:

1. **Who sets the price of a roadside job** — the driver, the platform, or a
   tariff per service type?
2. **What commission does JustGo take**, and is it a percentage, a flat fee
   per job, or a subscription?
3. **When is money captured** — on dispatch, on completion, or on a payout
   run? And by whom: us, or cash in hand between driver and customer?

These are spec §21 #3/#4 and they are **product decisions, not technical
ones**. A number invented here would be acted on by a real driver and then
contradicted by the first real payout run, which is worse than an empty
screen. The driver schema deliberately stops at who may drive, not what they
are owed.

Everything up to that line exists: a verified driver can go online with a
position, which is what dispatch needs.

### Still open from §4–5

- **4.2** vehicle requirement on reservations — still needs the product
  decision (one line of seed either way).
- **4.3** the app does not re-exchange its session after a GoTrue refresh —
  **app-side**, backend needs nothing. 497 × 401 in the logs.
- **4.4** the app polls instead of using Realtime — app-side.
- **§5** the package id is still `com.example.just_go`, which Google Play
  rejects and which cannot be changed after release.

---

## 1. Headline

The build adds a whole **community / social product** — Services
Directory, a feed, messaging, reclamations, and a driver vertical. **None
of it talks to any backend.**

Not "it calls endpoints that 404". It makes **no backend calls at all**:

- the API logs show **zero 404s** — the app never asks for a route we lack
- Kong shows **zero `/rest/v1/` requests** — it has never touched
  PostgREST, so it is not using Supabase tables directly either
- the snapshot is full of `images.unsplash.com` placeholder URLs

So these screens run on local/mock state. The backend work for them is
**greenfield** — nothing to fix, everything to build.

---

## 2. What is wired and working

Confirmed by live traffic (request counts over the integrator's testing):

| Area | Endpoints | Evidence |
|---|---|---|
| Auth exchange | `POST /v1/auth/session` | 223 × 201 |
| Profile | `GET/PUT /v1/me` | 71 × 200 |
| Garage | `/v1/vehicles`, `/health`, `/maintenance`, `/mileage` | 51 + 20 × 200 |
| Requests (core loop) | `GET/POST /v1/requests` | 1 867 × 200, 21 × 201 |
| Orders | `GET /v1/orders` | 2 666 × 200 |
| Reservations | `GET/POST /v1/reservations` | 1 195 × 200, 11 × 201 |
| Marketplace | `GET/POST /v1/marketplace/listings` | 49 × 200, 6 × 201 |
| Discovery | `GET /v1/discovery/suppliers` | 200, with real lat/lng |
| Supplier side | `/v1/supplier/*` (profile, requests, reservations) | 792 × 200 each |
| Media uploads | `POST /v1/media/uploads` | fixed today — see §4.1 |

The core loop, the garage and the supplier inbox are all genuinely
exercised. This half of the product is in good shape.

---

## 3. What has no backend — the new work

Screens present in the build with nothing behind them. Grouped by the
backend module each would need.

### 3.1 Services Directory — *the feature you asked about*
`ServicesDirectoryScreen` · "Services Directory" / "Annuaire des services"

A browsable directory of service providers. The closest thing we have is
`GET /v1/discovery/suppliers`, which is **geo-proximity search** — it
answers "who is near me", not "show me the directory". A directory
usually wants category browse, text search, sorting, pagination, and
provider detail pages independent of distance.

**Probably the cheapest gap to close**: it may be reachable by extending
`discovery` rather than building a module, since the supplier data
already exists. Worth deciding before anything is built.

### 3.2 Social feed
`PostVideoPlayerScreen`, `MediaGalleryScreen`, `MediaViewerScreen`,
`DashboardCarouselScreen`, strings `justgo_social`, "Add photo or video",
"Add some text, photos or a video first"

Posts with text, photos and video. Needs: posts, media attachments,
timeline/feed query, and almost certainly likes/comments. No schema, no
endpoints, no storage buckets for it.

### 3.3 Messaging
`ConversationsListScreen`, `justgo_messages`, `MSG_ATTACH_PHOTO`,
`MSG_PHOTO`, `MSG_PICK_TIME`, and the `record_web` package (**voice
notes**)

Direct messaging with photo and voice-note attachments. The marketplace
has `POST /v1/marketplace/listings/{id}/contact`, which is a one-shot
"contact the seller" — not a conversation. Needs threads, messages, read
state, attachments, and realtime delivery.

### 3.4 Reclamations (complaints / claims)
`ReclamationScreen`, `NewReclamationFormScreen`, `justgo_reclamations`,
"Could not send your refusal."

A complaints workflow. Needs a case entity with a state machine, probably
attachments, and a supplier/ops side to respond.

### 3.5 Driver vertical
`DriverHomeScreen`, `DriverEarningsScreen`, `DriverProfileScreen`,
`DriverVerificationFlowScreen`, `justgo_driver`, `DRV_TAKE_PHOTO`,
`DRV_UPLOAD_PHOTO`, `DRV_LOCATION_PERMISSION_NEEDED`, "A clear photo of
your driving license", "Look directly at the camera"

A driver identity with **KYC** (licence photo + selfie liveness) and
**earnings**. The spec's `roadside` vertical covers dispatch, but not
driver onboarding, verification or payouts. **Earnings implies payments**
— which is Phase 4 and blocked on spec §21 #3/#4 (pricing, commission,
capture model). This is the largest and most blocked item here.

### 3.6 Smaller ones
- `BusinessProfileScreen` — a public supplier profile. We expose
  `GET /v1/supplier/profile` (the owner's own, private). No public one.
- `FleetSetupScreen` — the `fleet` role is seeded but has no fleet
  endpoints; vehicles are per-account only.
- `/v1/functions` is configured in the app but **edge-functions is not
  running** on the dev box (deliberately trimmed). Anything calling it
  fails.

---

## 4. Defects found in live traffic

### 4.1 Image upload — FIXED today
`POST /v1/media/uploads` returned **500 for every bucket**. A fresh
Supabase stack has **zero storage buckets**, and neither `migrate` nor
`seed` creates them — Storage keeps them in its own metadata. Storage
answered the sign request with HTTP 400; the API surfaced a bare
`INTERNAL`.

Created all four (`registrations`, `vehicle-photos`, `part-photos`,
`avatars`) as private, verified sign → PUT → object row. Added
`scripts/create-buckets.mjs` (`pnpm buckets`, idempotent) so a rebuild
does not reintroduce it. **Tell the integrator to retry.**

### 4.2 Reservations fail 422 — 107 occurrences
Every booking without a `vehicleId` is rejected:

```
422 VEHICLE_REQUIRED — Service "oil_change" requires a vehicle
```

Because **all ten seeded service types have `requiresVehicle: true`** —
including `pre_purchase_inspection`, which by definition concerns a car
the user does not own yet.

Two ways to fix, and it is a product decision, not a bug:
- the app requires a garage vehicle before booking, or
- the seed marks some services `requiresVehicle: false`

Worth deciding now — 107 failed bookings is the single biggest error
count on the server.

### 4.3 Sessions expiring unhandled — 497 occurrences
`GET /v1/orders` returned **401 on 497 requests**. Session tokens are
capped at the life of the GoTrue token they came from, so the app must
**re-exchange after every refresh**. This pattern says it is not doing
that, and users will see silent failures an hour into a session.

Also `POST /v1/auth/session` → **403 × 41**: `{"scope":"supplier"}` on
accounts holding no supplier role. Expected if the Supplier app asks
before registering a business, but the app should handle it rather than
retry.

### 4.4 Polling instead of Realtime
`/v1/orders?limit=100` × **2 666**, `/v1/requests` × **1 867**,
`/v1/reservations` × **1 195**, each supplier list × 792.

That is aggressive polling of endpoints that have Realtime channels. On
the current dev box (1 vCPU, shared with another site) it is the main
load. The core-loop realtime path exists — `supplier:{id}`,
`request:{id}`, `account:{id}` — and the app already has the Supabase
client wired.

---

## 5. Also worth fixing

**The package is `com.example.just_go`.** That is the unmodified Flutter
template id, and **Google Play rejects `com.example.*`**. It cannot be
changed after release — a new package id is a different app. Rename
before any store submission.

---

## 6. Suggested order

1. **Decide 4.2** (vehicle requirement) — one line of seed or one app
   change, unblocks the single biggest error count.
2. **Fix 4.3** in the app — re-exchange on refresh. Backend needs nothing.
3. **Services Directory** — decide extend-`discovery` vs new module
   before building. Likely the cheapest of the new features.
4. **Messaging** — the most self-contained new module, and the one the
   marketplace most obviously wants.
5. **Social feed** — needs a storage bucket and a media strategy; bigger
   than it looks.
6. **Reclamations** — a workflow module; scope it with whoever handles
   complaints operationally.
7. **Driver vertical** — largest, and partly blocked on payments (Phase
   4 / spec §21). Do not start the earnings half before the pricing and
   commission model is settled.

**Items 3–7 are done as of 2026-10-13**, other than driver earnings. See §0
for what remains and for the three questions that block it.

None of items 3–7 exist in the spec's §19 build plan. They are **new
scope beyond Phase 4**, and the spec should be amended rather than having
them appear as surprises.
