# JustGo Backend

Shared backend for the JustGo two-sided automotive marketplace — the Client
("Orange") and Supplier ("Green") Flutter apps. NestJS 11 modular monolith in
an Nx monorepo; PostgreSQL 16 + PostGIS via **self-hosted Supabase**; BullMQ on
Redis; transactional outbox event backbone.

Authoritative spec: `../JustGo_Backend_Build_Spec.md` · Working conventions:
[CLAUDE.md](./CLAUDE.md)

## Layout

| Path | What |
|---|---|
| `apps/api` | HTTP API (REST `/v1`, OpenAPI later) |
| `apps/workers` | Outbox relay + BullMQ consumers |
| `libs/shared/kernel` | Result, branded ids, Money (integer minor units), Clock, AppError |
| `libs/shared/contracts` | Cross-module DTOs, `SupplierVertical` capability model, `VerticalRegistry` |
| `libs/shared/events` | DomainEvent, EventBus (in-memory/BullMQ), OutboxStore (in-memory/Postgres), OutboxRelay |
| `libs/shared/auth` | AuthContext, JWKS JWT verification, RBAC guard |
| `test/architecture` | Fitness functions: no cycles, no deep imports, schema ownership |
| `db/migrations` | Plain SQL, forward-only (`pnpm migrate`) |

Future modules land as `libs/platform/*` (bounded contexts),
`libs/verticals/*` (plug-ins), `libs/integrations/*`, `libs/crosscutting/*` —
boundaries enforced by Nx tags + ESLint + architecture tests.

## Quickstart

```sh
pnpm install
pnpm infra:up        # Postgres+PostGIS & Redis (docker compose)
cp .env.example .env # then point SUPABASE_URL at the self-hosted stack
pnpm migrate
npx nx serve @justgo-backend/api      # http://localhost:3000/v1/health
npx nx serve @justgo-backend/workers  # outbox relay + demo consumer
```

## Verify

```sh
pnpm lint       # includes module-boundary enforcement
pnpm typecheck
pnpm test       # unit + architecture; integration tests need DATABASE_URL/REDIS_URL
pnpm e2e        # builds the api, boots it, hits /v1/health
```

Build phases and Definitions of Done: spec §19. Phase 0 ✅ — next is Phase 1
(identity + the request → quote → order core loop).
