#!/usr/bin/env node
/**
 * Plain-SQL forward-only migration runner (§17.2, §20).
 *
 *   DATABASE_URL=postgres://… node scripts/migrate.mjs           # apply pending
 *   DATABASE_URL=postgres://… node scripts/migrate.mjs --status  # list state
 *
 * Files: db/migrations/NNNN_description.sql, applied in filename order,
 * each inside a transaction, tracked in public.schema_migrations.
 * Compatible with `supabase db push` layouts if we adopt the CLI later —
 * the runner has no dependency on managed Supabase (ours is self-hosted).
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await client.query('select filename from public.schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  if (process.argv.includes('--status')) {
    for (const f of files) console.log(`${applied.has(f) ? 'applied' : 'pending'}  ${f}`);
    process.exit(0);
  }

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public.schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied  ${file}`);
      count += 1;
    } catch (error) {
      await client.query('rollback');
      console.error(`FAILED   ${file}: ${error.message}`);
      process.exit(1);
    }
  }
  console.log(count === 0 ? 'nothing to migrate' : `done — ${count} migration(s) applied`);
} finally {
  await client.end();
}
