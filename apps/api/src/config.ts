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
  SUPABASE_URL: z.string().url().optional(),
  /** Defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` when unset. */
  JWT_JWKS_URL: z.string().url().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),
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
