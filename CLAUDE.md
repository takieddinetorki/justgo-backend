# JustGo Backend — conventions for coding agents

Authoritative build brief: `../JustGo_Backend_Build_Spec.md` (single source of
truth). This file is the working summary; keep both in sync as Open Questions
(spec §21) get resolved.

## Current status

- **Phases 0-3 complete**, pushed, CI green. Phase 0 skeleton + guardrails;
  Phase 1 identity, suppliers + part-store, requests (§8.1 core loop),
  orders, notifications/realtime, catalogue port; Phase 2 real TecDoc
  adapter (breaker + cache), vehicles, discovery (PostGIS), media + OCR,
  wholesaler; Phase 3 reservations, the remaining verticals, marketplace,
  assistance, supplier catalogue CRUD, and the 9th-vertical proof.
- **Docs**: OpenAPI at `/v1/docs` (`/v1/docs-json`), built in
  `apps/api/src/openapi.ts`; field-level contract in
  `docs/INTEGRATION_GUIDE.md` (the handoff artefact for the frontend
  integrator).
- **Session issuance is done** — see below. The Phase-1 loose end about
  hand-minted supplier tokens is closed.
- **Beyond the spec (2026-10-13)**, driven by what the shipped APK contains
  and `docs/APP-BACKEND-GAP.md`: `documents` (sealed PDFs — invoice, devis,
  bon de commande, reservation confirmation, with public verification and
  administrative voiding), the Services Directory, `messaging`, `social`,
  `reclamations`, `drivers` (identity + KYC only), and the order lifecycle
  endpoints without which `completed` was unreachable. None of this is in
  the §19 build plan; the spec should be amended rather than surprised.
- **`scripts/smoke.mjs` runs against a live deployment**, and is the gate
  that matters. Three defects here were invisible to jest and appeared only
  in the webpack bundle (SWC Set-spread, an incomplete outbox schema list, a
  font encoding error inside a reactor); the smoke test found four more on
  its first run. Run it after every deploy:
  `API_URL=… GOTRUE_URL=… ANON_KEY=… node scripts/smoke.mjs`
- **Driver earnings is deliberately unbuilt**, not forgotten: it needs the
  pricing, commission and capture decisions in spec §21 #3/#4. See
  `docs/APP-BACKEND-GAP.md` §0 for the three questions.
- **Next: Phase 4** — payments (provider port + sandbox, ledger,
  commission), real notification channels, analytics read models,
  multi-branch, multi-market/currency, k6 load tests to the §16 targets,
  security/RLS review, and extracting one hot module as a separate
  deployable. Do not start a phase before the previous DoD is green
  (spec §19). Payments is blocked on spec §21 #3, #4 and #6 — do not guess
  a pricing or capture model.

### Authentication is a TWO-step flow

GoTrue proves identity; it knows nothing about roles, permissions or
suppliers, because those are rows in the `identity` schema. So a raw
GoTrue token has `roles: []` / `permissions: []` and **every route behind
`@RequirePermissions('…')` returns 403**.

`POST /v1/auth/session` (`libs/platform/identity`) is the exchange: it
verifies the GoTrue token, self-provisions the account, resolves roles and
permissions **for the requested scope**, and mints an HS256 token with the
same `JWT_SECRET`. Rules that are load-bearing:

- It carries GoTrue's `sub`, `role` and `aud` through untouched. `sub` is
  what `app.auth_user_id()` reads in every RLS policy, `role` is what
  PostgREST switches into, and the apps send the same token to Supabase
  Realtime. Dropping any of them breaks something far from here.
- Permissions are scoped, never unioned. A client who also owns a garage
  must not get `quote.submit` in their client session.
- A session never outlives the GoTrue token it came from (`expiryFor`), so
  clients must re-exchange after every refresh.
- Signing is symmetric-only. Under JWKS the API holds no private key and
  issuance returns 501 rather than minting something that fails on use.
- Supplier scope comes from `identity.user_roles` rows with
  `scope_type='supplier'`, granted by `SupplierRoleReactor` reacting to
  `suppliers.SupplierRegistered`. Identity never reads the suppliers
  schema.

### The event backbone was broken end-to-end (fixed 2026-09-07)

Three bugs stacked on top of each other meant **no cross-process domain
event had ever been delivered in a built app**. Nothing caught it because
every integration test drives `InMemoryEventBus` in-process under ts-jest;
the BullMQ path only exists in the webpack bundles, and nothing tested a
bundle.

1. **`[...setA, ...setB]` in `BullMqEventBus`.** SWC's loose downlevel
   rewrote it as `[].concat(setA, setB)`, and `Array.concat` appends a Set
   rather than spreading it. Every job died with `handler is not a
   function`. Now collected with `Set.forEach`, plus an explicit
   `typeof handler === 'function'` guard so the next variant of this fails
   with a message that names the cause. **Never spread a Set or Map in code
   that reaches a bundled app.**
2. **`apps/workers` subscribed to `'*'` to log.** On this bus, subscribing
   is what creates a consumer — so the worker competed with the API for
   every job, and the API is where all the reactors live. Whether an event
   took effect depended on which process won the race. Removed.
3. **Removing (2) killed the worker.** `OutboxRelay` `unref()`s its poll
   timer on purpose, and the process has no HTTP listener, so that
   subscription's Redis socket was the only thing holding the event loop
   open — the worker had been staying alive by accident. `OutboxRelayRunner`
   now holds an explicit ref'd keep-alive it clears on shutdown.

Both processes must run for events to flow: `nx serve @justgo-backend/api`
AND `nx serve @justgo-backend/workers`. The relay publishes; the API
consumes.

### Remaining loose end
- Reactors (fan-out, order-from-quote, notifications, supplier-role) run in
  the API process; spec §5 intends them in `apps/workers`, which today holds
  only the outbox relay. That split is what made bug (2) above possible.
  Consolidating is hardening — and the natural warm-up for Phase 4's
  "extract one module" DoD.

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
  `test/architecture` (cycles, deep imports, schema ownership, OpenAPI
  coverage).
- **A new route needs a `set()` block in `apps/api/src/openapi.ts`.** Paths
  are reflected off the controllers, but bodies are validated with zod rather
  than class DTOs, so there is nothing for Nest to reflect INTO an operation:
  every schema, example and summary is hand-attached there. Without one, the
  endpoint ships as a bare verb-and-path. `openapi-coverage.spec.ts` fails the
  build on an undocumented route, and on a `set()` key that matches no route
  (`enrich()` applies with `if (op) …`, so a stale key silently documents
  nothing).

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
