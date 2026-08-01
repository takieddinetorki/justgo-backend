# Self-hosted Supabase (JustGo)

Vendored from `supabase/supabase` (`docker/`). Provides Postgres 17 + PostGIS,
GoTrue (auth), PostgREST, Realtime, Storage, Kong, Studio.

## ⚠️ This machine hosts two Supabase stacks

A **separate** Supabase stack belongs to the Orea project at
`F:\Excellist\Orea\supabase\docker`. Upstream's compose file hardcodes
`container_name: supabase-*` and derives its project name from the folder
name (`supabase`) — so without isolation, running this stack **recreates
Orea's containers**. Two guards prevent that; do not remove them:

1. `COMPOSE_PROJECT_NAME=justgo-supabase` in `.env`
2. `docker-compose.justgo.yml` renames every container to `justgo-supabase-*`
   and is layered via `COMPOSE_FILE` (with `COMPOSE_PATH_SEPARATOR=:` so the
   `:` separator works on Windows too)

Ports are remapped for the same reason:

| Service | JustGo | upstream default |
|---|---|---|
| Kong HTTP (API gateway) | **8100** | 8000 |
| Kong HTTPS | **8543** | 8443 |
| Postgres (session pooler) | **55432** | 5432 |
| Postgres (transaction pooler) | **56543** | 6543 |

Never edit `docker-compose.yml` — put changes in `docker-compose.justgo.yml`
so the upstream file stays updatable.

## Run

```sh
cd infra/supabase
docker compose up -d
docker compose ps          # 11 services, all healthy
docker compose down        # stop (volumes persist)
```

Studio: http://localhost:8100 (credentials: `DASHBOARD_USERNAME` /
`DASHBOARD_PASSWORD` in `.env`).

## Secrets

`.env` is **gitignored** and generated with fresh random secrets
(`POSTGRES_PASSWORD`, `JWT_SECRET`, and HS256-signed `ANON_KEY` /
`SERVICE_ROLE_KEY`). The backend's own `../../.env` mirrors the values it
needs — regenerate it after rotating anything here.

Self-hosted GoTrue signs JWTs with **HS256** using `JWT_SECRET`, so the API
verifies with that shared secret rather than JWKS (see
`libs/shared/auth/src/lib/jwt-verifier.ts`).

## Apply the schema

```sh
cd ../..            # repo root
pnpm migrate        # db/migrations/*.sql, forward-only
pnpm seed           # roles, permissions
```
