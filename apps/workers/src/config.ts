import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /**
   * Which module outboxes the relay drains.
   *
   * `auto` (the default) DISCOVERS them: every schema in the database
   * with a table named `outbox`. A hand-maintained list was wrong twice
   * — `messaging` was missing when it shipped, and `reservations`,
   * `marketplace` and `vehicles` were never in it at all, so 38 events
   * sat unpublished and no reactor downstream of them ever fired. The
   * failure is invisible, because an undrained outbox looks exactly like
   * an idle one.
   *
   * An explicit comma-separated list still overrides, for pinning a
   * subset deliberately.
   */
  OUTBOX_SCHEMAS: z.string().default('auto'),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
});

export type WorkersConfig = z.infer<typeof envSchema> & { outboxSchemas: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkersConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    outboxSchemas: parsed.OUTBOX_SCHEMAS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
