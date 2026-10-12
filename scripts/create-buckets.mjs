#!/usr/bin/env node
/**
 * Creates the Storage buckets the media module writes to.
 *
 * WHY THIS EXISTS: a fresh Supabase stack ships with ZERO buckets, and
 * nothing in `pnpm migrate` or `pnpm seed` creates them — they live in
 * Storage's own metadata, not in our migrations. Until they exist,
 * `POST /v1/media/uploads` returns 500 for every bucket, because
 * Storage answers the sign request with HTTP 400. That took down image
 * upload on the dev server and is invisible from the API's own logs
 * unless you read the adapter's error.
 *
 * Buckets are PRIVATE: `supabase-storage.adapter.ts` serves every read
 * through a short-lived signed URL and the API never proxies bytes.
 *
 * Idempotent — an existing bucket reports "exists" and is left alone.
 *
 *   node scripts/create-buckets.mjs
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_KEY (repo-root .env is loaded
 * automatically, same as migrate/seed).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors the `bucket` enum in libs/crosscutting/media/src/media.controller.ts.
// Keep the two in step: a bucket named there and missing here fails at runtime.
const BUCKETS = [
  'registrations',
  'vehicle-photos',
  'part-photos',
  'avatars',
  'message-attachments',
  'documents',
];

function loadEnv() {
  if (process.env['SUPABASE_URL'] && process.env['SUPABASE_SERVICE_KEY']) return;
  for (const file of ['.env.vps', '.env']) {
    try {
      for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
    } catch {
      // Not every checkout has every env file; the next one may have it.
    }
  }
}

loadEnv();

const url = process.env['SUPABASE_URL'];
const key = process.env['SUPABASE_SERVICE_KEY'];
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  process.exit(1);
}

let failed = 0;
for (const id of BUCKETS) {
  const res = await fetch(`${url.replace(/\/$/, '')}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id, name: id, public: false }),
  });

  if (res.ok) {
    console.log(`created  ${id}`);
    continue;
  }

  const body = await res.text();
  // Storage reports an existing bucket as 409, or 400 with this code.
  if (res.status === 409 || body.includes('already exists') || body.includes('Duplicate')) {
    console.log(`exists   ${id}`);
    continue;
  }

  console.error(`FAILED   ${id} -> HTTP ${res.status} ${body}`);
  failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} bucket(s) could not be created.`);
  process.exit(1);
}
console.log(`\ndone — ${BUCKETS.length} bucket(s) ready`);
