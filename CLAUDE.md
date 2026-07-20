# JustGo Backend — conventions for coding agents

Authoritative build brief: `../JustGo_Backend_Build_Spec.md` (single source of
truth). This file is the working summary; keep both in sync as Open Questions
(spec §21) get resolved.

## Current status

- **Phase 0 complete**: Nx monorepo, `apps/api` + `apps/workers`,
  `libs/shared/{kernel,contracts,events,auth}`, outbox → relay → bus pipeline,
  architecture fitness tests, CI.
- **Next: Phase 1** — identity, suppliers core, part-store vertical, requests
  (core loop §8.1), orders, notifications/realtime. Do not start a phase
  before the previous phase's DoD is green (spec §19).

## Decisions made

- **Supabase is SELF-HOSTED.** Never assume managed Supabase; auth/realtime/
  storage URLs come from `SUPABASE_URL` env. JWTs verified via JWKS
  (`JWT_JWKS_URL`, defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`).
- Migrations run with `pnpm migrate` (`scripts/migrate.mjs`, plain SQL,
  forward-only, `db/migrations/NNNN_description.sql`). RLS policies live in
  migrations.
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
