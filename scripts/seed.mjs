#!/usr/bin/env node
/**
 * Applies db/seed/*.sql (idempotent reference data: roles, permissions,
 * verticals, service types). Run after `pnpm migrate`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

// Load the repo-root .env (relative to this script, not the cwd) so
// `pnpm migrate` works from any directory and any shell. Real env vars
// already set (e.g. in CI) win — we only fill DATABASE_URL when it's missing.
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
if (!process.env.DATABASE_URL && existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../db/seed');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(SEED_DIR, file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('commit');
      console.log(`seeded   ${file}`);
    } catch (error) {
      await client.query('rollback');
      console.error(`FAILED   ${file}: ${error.message}`);
      process.exit(1);
    }
  }
} finally {
  await client.end();
}
