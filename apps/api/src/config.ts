import { z } from 'zod';

/**
 * All config via env (§20) — the deploy targets a self-hosted Supabase, so
 * every Supabase-ish URL is explicit. Nothing here has a hard-coded host.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  TECDOC_BASE_URL: z.string().url().optional(),
  TECDOC_API_KEY: z.string().optional(),
  TECDOC_PROVIDER_ID: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  /** service_role key — used server-side for Realtime broadcast. */
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  /** HS256 secret of the self-hosted GoTrue (takes precedence over JWKS). */
  JWT_SECRET: z.string().min(32).optional(),
  /** Defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` when unset. */
  JWT_JWKS_URL: z.string().url().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),
  /**
   * Lifetime of the session tokens POST /v1/auth/session mints. Capped in
   * practice by the GoTrue token it was exchanged from — a session never
   * outlives the authentication behind it.
   */
  SESSION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SENTRY_DSN: z.string().url().optional(),
});

export type ApiConfig = z.infer<typeof envSchema> & { jwksUrl?: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.parse(env);
  const jwksUrl =
    parsed.JWT_JWKS_URL ??
    (parsed.SUPABASE_URL ? `${parsed.SUPABASE_URL}/auth/v1/.well-known/jwks.json` : undefined);
  return { ...parsed, jwksUrl };
}
