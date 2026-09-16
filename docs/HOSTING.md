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

The database is migrated (17 migrations) and seeded with roles,
permissions, verticals and service types.

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
  justgo-app:dev sh -c "node scripts/migrate.mjs && node scripts/seed.mjs"
```

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
