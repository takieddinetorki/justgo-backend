# JustGo Backend — conventions for coding agents

Authoritative build brief: `../JustGo_Backend_Build_Spec.md` (single source of
truth). This file is the working summary; keep both in sync as Open Questions
(spec §21) get resolved.

## Current status

- **Phase 0 complete** (pushed, CI green): Nx monorepo, api + workers,
  shared kernel/contracts/events/auth, outbox -> relay -> bus, architecture
  fitness tests, CI.
- **Phase 1 complete** (built + verified against the live self-hosted stack;
  push pending): identity, suppliers + part-store vertical, requests (the
  §8.1 core loop with idempotent submit + capability-driven fan-out), orders,
  notifications + realtime (Supabase Realtime broadcast + FCM stub), and the
  catalogue port with a stub TecDoc adapter. RLS isolation and the full
  request -> fan-out -> quote -> accept -> order loop are proven live.
- **Docs**: OpenAPI served at `/v1/docs` (`/v1/docs-json`), built in
  `apps/api/src/openapi.ts`; field-level contract in
  `docs/INTEGRATION_GUIDE.md`.
- **Next: Phase 2** — real TecDoc adapter (circuit breaker + Redis short-TTL
  cache), vehicles/garage + health/maintenance, media + OCR, discovery
  (PostGIS), wholesaler vertical. Do not start a phase before the previous
  DoD is green (spec §19).

### Phase-1 loose ends to revisit
- Reactors (fan-out, order-from-quote, notifications) run in the API process;
  spec §5 intends them in `apps/workers`. Each hop is proven by integration
  tests; consolidating into the worker is a hardening cleanup.
- Supplier-scoped JWT issuance (role -> `supplier_id` claim) is an operational
  step, not yet an endpoint — test tokens are minted by hand.

## Decisions made

- **Supabase is SELF-HOSTED**, vendored in `infra/supabase` (upstream
  `supabase/docker`). See `infra/supabase/README.justgo.md` — critically,
  **this machine also runs a separate Orea Supabase stack**, so JustGo's uses
  `COMPOSE_PROJECT_NAME=justgo-supabase`, renamed containers
  (`docker-compose.justgo.yml`), and remapped ports (Kong **8100**, Postgres
  **55432**, transaction pooler **56543**). Removing that isolation will
  clobber Orea's containers.
- Self-hosted GoTrue signs **HS256** with `JWT_SECRET` — the API verifies with
  the shared secret; JWKS support remains for asymmetric setups.
- Migrations run with `pnpm migrate` (`scripts/migrate.mjs`, plain SQL,
  forward-only, `db/migrations/NNNN_description.sql`), then `pnpm seed`. RLS
  policies live in migrations. Because they are forward-only, fixes ship as
  NEW files (see 0007–0009) rather than edits to applied migrations.
- RLS uses portable `app.*()` claim helpers (migration 0002) instead of
  Supabase's managed-only `auth.*()`, so policies behave identically on plain
  Postgres in CI. The roles need `grant usage on schema app` (0009) or every
  policy fails closed.
- jose is pinned to v5 (v6 is ESM-only and breaks Jest CJS).

## Architecture (enforced — CI fails on violations)

- One module = one bounded context = one Nx package = one Postgres schema.
- Module layout: `contract/` is PUBLIC; `application/`, `domain/`, `infra/`
  are PRIVATE. Other modules import ONLY the package root.
- Modules talk through ports (interfaces) + DTOs and integrate through
  events (outbox → relay → BullMQ bus). Consumers are idempotent (dedupe on
  event id); events are versioned and additive.
- Verticals are plug-ins implementing `SupplierVertical` (libs/shared/
  contracts), registered under the `VERTICAL` multi-token. The core routes by
  capability via `VerticalRegistry` and NEVER names a vertical.
- Nx tags: `scope:shared|platform|vertical|integration|crosscutting|app` —
  depConstraints in `eslint.config.mjs`. Fitness tests in
  `test/architecture` (cycles, deep imports, schema ownership).

## Hard guardrails (spec §17.4 — never violate)

- ❌ cross-schema SQL / FKs — reference by id, validate via ports
- ❌ `switch (vertical)` in platform code — capability + registry
- ❌ bulk caching/persisting TecDoc data — store IDs, short-TTL Redis only
- ❌ business logic in Supabase Edge Functions — NestJS owns orchestration
- ❌ floats for money — integer minor units + `char(3)` currency (`@justgo/kernel` Money)
- ❌ local-time timestamps — `timestamptz` UTC everywhere
- ❌ fan-out/TecDoc/OCR on the HTTP request path — workers + events
- ❌ secrets in code — env only (`.env.example` is the catalogue)

## Code conventions

- TS strict; no `any` except at untyped boundaries with a comment.
- `Result<T,E>` for expected failures; exceptions for bugs; errors extend
  `AppError` with stable machine codes → §17.3 envelope (see
  `apps/api/src/app/all-exceptions.filter.ts`).
- Controllers parse/validate (zod) and call a use-case; domain logic lives in
  `domain/`; state machines are explicit; illegal transitions → 409.
- Repositories return domain objects, never rows; state change + outbox
  append happen in ONE transaction (`PgOutboxStore.appendWith`).

## Commands

- `pnpm infra:up` — Postgres+PostGIS & Redis via docker-compose.dev.yml
- `pnpm migrate` / `pnpm migrate:status`
- `npx nx serve @justgo-backend/api` / `npx nx serve @justgo-backend/workers`
- `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm e2e` · `pnpm build`
- Integration tests self-skip without `DATABASE_URL`/`REDIS_URL`; CI provides
  both via service containers.

## Open Questions (spec §21 — build seams, do NOT hard-code guesses)

Supplier matching rules for fan-out; TecDoc license/caching rights; pricing
model & commission; payment capture flow/provider; supplier KYC; launch
markets/currencies; exact field-level contracts vs the Flutter apps'
`…fromJson`.
