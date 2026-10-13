# JustGo backend — the dev server

A shared development backend, live and seeded. Build against a real API
instead of mocks.

**This is a dev box, not production.** Plain HTTP, throwaway data, and it
can be wiped without warning. Details in §6.

---

## 1. Where it is

| | |
|---|---|
| **API** | `http://168.231.87.48:3100` |
| **Supabase gateway** (GoTrue, Storage, PostgREST, Realtime) | `http://168.231.87.48:8100` |
| **OpenAPI UI** | `http://168.231.87.48:3100/v1/docs` |
| **OpenAPI JSON** | `http://168.231.87.48:3100/v1/docs-json` |
| **Health** | `http://168.231.87.48:3100/v1/health` |

No domain and no TLS yet — use the IP and `http://` exactly as written.

The Supabase **anon key**, which every GoTrue call needs as an `apikey`
header. It is a public key by design — it ships inside client apps:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg1NTQ5MDEzLCJleHAiOjIxMDA5MDkwMTN9.uMhbQJULsTiYl8eM3EqrlvZFT0ebyrRc_DLBL-OnpNo
```

Quick check that you can reach it:

```sh
curl http://168.231.87.48:3100/v1/health
# {"status":"ok","service":"justgo-api","now":"..."}
```

---

## 2. Signing in — two steps, not one

The single most common way to get stuck. Full rules in
[`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) §2; the short version:

**Step 1 — GoTrue establishes who you are.**

```sh
curl -X POST 'http://168.231.87.48:8100/auth/v1/signup' \
  -H 'apikey: <anon key above>' \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"Test-Passw0rd!"}'
```

Email and phone **auto-confirm** on this server — there is no mail server
and no confirmation link will ever arrive. Sign-up returns a usable
`access_token` immediately. Sign in again later with
`/auth/v1/token?grant_type=password`.

**Step 2 — exchange it for a session token.**

```sh
curl -X POST 'http://168.231.87.48:3100/v1/auth/session' \
  -H 'Authorization: Bearer <gotrue access_token>' \
  -H 'Content-Type: application/json' \
  -d '{}'                       # Client app
# -d '{"scope":"supplier"}'     # Supplier app
```

Send the `accessToken` it returns on **every other call**.

Skipping step 2 is not a subtle failure. Roles and permissions live in
the database, so a raw GoTrue token carries none and every endpoint
behind a permission answers **403**:

```
GET /v1/vehicles  with a GoTrue token   -> 403 {"required":["vehicle.manage"]}
GET /v1/vehicles  with a session token  -> 200 {"items":[]}
```

**Re-exchange after every GoTrue refresh.** A session token is capped at
the remaining life of the token it came from, so it never outlives your
sign-in.

### Becoming a supplier

`POST /v1/supplier` registers a business using an ordinary client
session. The supplier role is then granted **asynchronously** — the API
reacts to an event — so exchange again a second later to get a token
carrying `supplier_id`:

```sh
POST /v1/supplier         # with a client session
POST /v1/auth/session     # {"scope":"supplier"}, a moment later
```

If the scope is not there yet, retry once. It travels through the outbox
relay and normally lands in well under a second.

---

## 3. Verified working on this server

Run end-to-end against the public IP, in this order:

| Check | Result |
|---|---|
| `GET /v1/health` | 200 |
| `GET /v1/discovery/suppliers` (public, no auth) | 200 |
| GoTrue sign-up via the gateway | 200, token issued |
| Raw GoTrue token on `/v1/vehicles` | **403** — as designed |
| `POST /v1/auth/session` `{}` | 201 — `client`, 13 permissions |
| Session token on `/v1/vehicles` | 200 |
| `POST /v1/supplier` | 201 |
| `POST /v1/auth/session` `{"scope":"supplier"}` | 201 — `supplier_owner`, `supplier_id` present |
| `GET /v1/supplier/requests` with supplier session | 200 |
| `GET /v1/supplier/requests` with client session | **403** — as designed |

The database is migrated (26 migrations) and seeded with roles,
permissions, verticals and service types.

### Re-verify it yourself in one command

`scripts/smoke.mjs` walks the whole product against a running deployment —
auth exchange, the part-request fan-out, the order lifecycle through to the
sealed facture, messaging with attachments, the social feed, complaints and
driver KYC — and prints PASS or FAIL per check.

```sh
cd /opt/justgo/justgo-backend
ANON=$(grep -E '^SUPABASE_ANON_KEY=' .env.vps | cut -d= -f2- | tr -d '"')
API_URL=http://127.0.0.1:3100 GOTRUE_URL=http://127.0.0.1:8100   ANON_KEY="$ANON" node scripts/smoke.mjs
```

It exits non-zero if anything failed, so it can gate a deploy. It creates
throwaway accounts on each run with random passwords, so point it only at a
development deployment.

**Run it after every deploy.** Three defects in this codebase were invisible
to the unit suite and appeared only in the bundled build; this is what
catches that class of bug.

### The one check it leaves out

`scripts/smoke.mjs` stops at the gate on driver verification rather than
driving through it, because deciding a verification needs `platform.admin` —
and an account holding that carries read access to every identity document in
the system. A routine test must never have it.

`scripts/verify-driver-verification.mjs` is the by-hand version. It mints an
ops account, verifies a driver, waits for the reactor to grant `driver.work`,
goes online, suspends, waits for the revocation, and **revokes its own ops
grant in a `finally` block**. Dev boxes only:

```sh
cd /opt/justgo/justgo-backend
ANON=$(grep -E '^SUPABASE_ANON_KEY=' .env.vps | cut -d= -f2- | tr -d '"')
ANON_KEY="$ANON" node scripts/verify-driver-verification.mjs
```

The part worth watching is "the reactor granted driver.work". If that fails it
is not a driver problem — it means outbox → relay → BullMQ delivery is broken,
which has happened before and was invisible to every unit test.

---

## 4. What is NOT running, and what it costs you

The box is small, so the stack is trimmed. These absences are deliberate:

| Absent | What you lose |
|---|---|
| **Supabase Studio** | No database GUI. Ask for a SQL dump if you need to inspect data. |
| **Supavisor (pooler)** | Nothing — the API talks to Postgres directly. Ignore port 56543. |
| **Edge Functions, postgres-meta** | Nothing the apps use. |

Running: Postgres+PostGIS, GoTrue, Realtime, Storage, imgproxy, Kong,
Redis, the API and the workers.

### Stubbed features — expected, not bugs

- **TecDoc is a stub.** No licence yet, so catalogue lookups return
  fixture data rather than real parts. The response shapes are correct;
  the contents are invented.
- **Push notifications are a stub.** The notification service logs
  instead of calling FCM. **Realtime works properly** — build live
  updates on that.
- **Payments do not exist.** Phase 4. Orders have no capture step.

---

## 5. Realtime

Broadcast over the same gateway, authenticated with your **session
token**:

```ts
import { createClient } from '@supabase/supabase-js';
const supabase = createClient('http://168.231.87.48:8100', ANON_KEY);
supabase.realtime.setAuth(sessionToken);
```

Channels: `supplier:{supplierId}`, `request:{requestId}`,
`account:{accountId}`. See `INTEGRATION_GUIDE.md` §4.

The session token deliberately preserves GoTrue's `sub`, `role` and `aud`
claims, so it works against Realtime and PostgREST as well as this API.

---

## 6. Caveats — read before filing a bug

- **Plain HTTP.** Tokens cross the wire unencrypted. Fine for dev data;
  put nothing real in here. TLS arrives with a domain.
- **One shared database.** Everyone testing shares it, so expect other
  people's suppliers and requests in list endpoints.
- **It may be wiped.** Treat all data as disposable. Seed scripts restore
  reference data; your test accounts will not come back.
- **The box is small** — 1 vCPU, 4 GB RAM, and it also hosts an unrelated
  production site. Expect modest latency and do not load-test it. If you
  need throughput numbers, ask for a dedicated box.
- **If it stops responding**, check `/v1/health` first, then report it —
  that is the server, not your code.

---

## 7. Operations (for whoever runs the box)

### Backups

A nightly dump runs from root's crontab at 02:17 UTC:

```
17 2 * * * /opt/justgo/backup-db.sh >> /opt/justgo/backups/backup.log 2>&1
```

Each run writes two gzipped files to `/opt/justgo/backups` (mode 700, files
600 — the globals dump contains role password hashes) and keeps 14 days:

| File | What it is |
|---|---|
| `justgo-<stamp>.sql.gz` | every schema and its data |
| `justgo-<stamp>.globals.sql.gz` | roles and their passwords |

**You need both.** Restored without the globals, every grant and RLS policy
references roles that do not exist and silently fails to apply.

The script verifies before it publishes a filename, and rotates only after a
verified write — so a failed run never evicts a good backup. Check the newest
one at any time:

```sh
/opt/justgo/backup-db.sh --verify
```

### Proving a backup actually restores

```sh
bash /opt/justgo/verify-backup-restores.sh
```

It restores the newest backup into a throwaway container and compares it row
for row against the live database: documents, the invoice numbers, the SHA-256
of every document, accounts, `auth.users`, orders, complaints, drivers, posts,
RLS policy count, and whether the unique index that stops a double facture
survived. It then asserts the fiscal series is still gapless. Nothing it does
touches the live stack.

**Run it after any change to the backup script or the Postgres image.** The
first version of these scripts produced backups that restored everything
*except the 44 user accounts* — `auth` is owned by `supabase_admin`, so a
dump taken as `postgres` could not reapply it, and a recovery would have
produced a database where every profile exists and nobody can log in. That is
only visible by actually restoring.

### What is still NOT protected

The backups are **on the same disk as the database**. They survive a bad
migration or a dropped table; they do not survive losing the box.

Two things need to live somewhere else, and nothing automates that yet:

```sh
scp -r root@168.231.87.48:/opt/justgo/backups ./
scp root@168.231.87.48:/opt/justgo/doc-signing.key ./
```

**The signing key matters as much as the database.** Every invoice is sealed
with it; lose it and every document ever issued becomes unverifiable, which
cannot be repaired after the fact — the signatures are over bytes nobody can
check any more.

### Rate limiting

In the API, keyed per caller: an authenticated request is bucketed by a hash
of its bearer token, an anonymous one by IP.

| Route | Limit (per minute) |
|---|---|
| everything by default | 600 |
| `GET`/`POST /v1/documents/verify/*` | 60 — anonymous, so per ADDRESS |
| `POST /v1/posts`, `POST /v1/posts/{id}/comments` | 30 |
| `POST /v1/reclamations` | 30 |
| `POST /v1/auth/session`, `POST /v1/media/uploads` | 60 |
| `POST /v1/conversations/{id}/messages` | 120 |
| `/v1/health`, `/v1/docs*` | exempt |

**Per token, not per IP, on purpose.** Algerian carriers use CGNAT heavily, so
one public address fronts many real users; an IP-keyed limit tight enough to
stop abuse would lock all of them out at once.

A 429 carries `Retry-After`. The default sits well above what the app already
does when polling, so a client hitting it is misbehaving rather than busy.

**Two things will silently break it.** Running a second API replica doubles
every limit, because the counters are in process memory — move the storage to
Redis in the same change. And putting Caddy or any proxy in front of the API
requires setting Express `trust proxy` in the same change, or every anonymous
request appears to come from the proxy and shares one bucket.

**GoTrue is not covered.** `/auth/v1/signup` and `/auth/v1/token` go through
Kong on :8100 and never reach the API, so sign-up remains unthrottled. Kong
3.9 ships a `rate-limiting` plugin that would close this; it is not enabled,
because a mistake in that config takes the whole gateway — and therefore all
authentication — down with it.


### Running the stack

Everything lives in `/opt/justgo/justgo-backend`.

```sh
# Supabase tier — note --no-deps, see below
cd /opt/justgo/justgo-backend/infra/supabase
docker compose up -d --no-deps db auth rest realtime imgproxy storage kong

# App tier (API, workers, Redis)
cd /opt/justgo/justgo-backend
docker compose -f docker-compose.app.yml up -d

# Logs
docker logs -f justgo-api
docker logs -f justgo-workers

# Redeploy after a code change
docker compose -f docker-compose.app.yml build api
docker compose -f docker-compose.app.yml up -d

# Migrations / seed
docker run --rm --network justgo-supabase_default --env-file .env.vps \
  justgo-app:dev sh -c "node scripts/migrate.mjs && node scripts/seed.mjs && node scripts/create-buckets.mjs"
```

**Storage buckets are not created by migrate or seed.** They live in
Storage's own metadata, and a fresh stack has none — until they exist,
`POST /v1/media/uploads` returns 500 for every bucket because Storage
answers the sign request with HTTP 400. That is what broke image upload
in the sell-car flow. Run `create-buckets.mjs` after any rebuild that
resets the database; it is idempotent.

**`--no-deps` is required.** Kong lists Studio in `depends_on`, so a plain
`docker compose up -d` drags Studio — another Next.js, ~250 MB — onto a
box that cannot spare it.

**Both app processes must run.** `workers` publishes the transactional
outbox; `api` consumes it and runs every reactor — fan-out,
order-from-quote, notifications, supplier-role grants. With only the API
up, writes succeed and nothing downstream of an event ever happens.

**Config.** `infra/supabase/.env` drives the Supabase tier; `.env.vps`
drives the app tier. `.env.vps` is generated and copies the Postgres
password, so regenerate it whenever the Supabase env changes. The API
reaches Postgres as `db:55432` over the Docker network — the db container
publishes no host port, on purpose.

**Build note.** `Dockerfile.vps` pins **pnpm 9** explicitly. `corepack
enable` installs pnpm 10, which no longer reads `pnpm.overrides` from
`package.json`; with a v9 lockfile that records one, every frozen install
dies with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `package.json` now carries
a `packageManager` field for the same reason.

### Sharing the box

An unrelated production site — `steelyou.net`, Next.js under PM2 behind
Caddy on 80/443 — lives on this machine. Do not touch Caddy, PM2, ports
80/443, or anything under `/opt/steelyou-full`. JustGo binds only 3100
and 8100; Redis is bound to loopback. A 4 GB swapfile exists specifically
so memory pressure degrades into swap rather than the kernel OOM-killing
the largest process on the box — which would be their site.
