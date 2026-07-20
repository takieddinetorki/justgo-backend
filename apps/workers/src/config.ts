import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Comma-separated module schemas whose outboxes the relay drains. */
  OUTBOX_SCHEMAS: z.string().default('demo'),
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
