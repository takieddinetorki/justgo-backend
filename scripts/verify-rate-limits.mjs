/**
 * Proves the rate limiter actually bites, and — more importantly — that it
 * bites the right thing: two users behind one address must NOT share a bucket.
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3100';
const GOTRUE = process.env.GOTRUE_URL ?? 'http://127.0.0.1:8100';
const ANON = process.env.ANON_KEY ?? '';
const STAMP = Date.now();

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? `  ${d}` : ''}`);
const bad = (l, d = '') => { console.log(`  FAIL  ${l}${d ? `  ${d}` : ''}`); failures += 1; };
const check = (l, c, d = '') => (c ? ok(l, d) : bad(l, d));

async function call(path, { token, base = API, method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(base === GOTRUE && ANON ? { apikey: ANON } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

async function makeToken(tag) {
  const email = `thr-${tag}-${STAMP}@justgo.test`;
  const password = `Thr!${Math.random().toString(36).slice(2, 12)}`;
  const up = await fetch(`${GOTRUE}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  const s = await fetch(`${API}/v1/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${up.access_token}` },
    body: '{}',
  }).then((r) => r.json());
  return s.accessToken;
}

console.log(`rate limit check against ${API}\n`);

// ── the probe must never be throttled ────────────────────────────────
let healthStatuses = new Set();
for (let i = 0; i < 80; i += 1) healthStatuses.add((await call('/v1/health')).status);
check('health is never throttled', !healthStatuses.has(429), [...healthStatuses].join(','));

// ── the public verify endpoint is the enumeration target ─────────────
let first429 = null;
for (let i = 1; i <= 75; i += 1) {
  const r = await call(`/v1/documents/verify/FA-2026-00000${i % 10}`);
  if (r.status === 429) { first429 = { at: i, retryAfter: r.retryAfter }; break; }
}
check('public verification throttles', first429 !== null,
  first429 ? `429 on request ${first429.at}` : 'never throttled in 75 requests');
check('the 429 carries Retry-After', Boolean(first429?.retryAfter),
  first429?.retryAfter ? `${first429.retryAfter}s` : 'missing');
check('it throttles at roughly the configured 60', first429 !== null && first429.at >= 60 && first429.at <= 64,
  first429 ? `first 429 at ${first429.at}` : 'n/a');

// ── THE POINT: one address, two users, separate buckets ──────────────
const a = await makeToken('a');
const b = await makeToken('b');
if (!a || !b) {
  bad('could not mint two tokens for the CGNAT check');
} else {
  // Burn user A down on a route they share with B, from the same address.
  let aHit429 = false;
  for (let i = 0; i < 40; i += 1) {
    const r = await call('/v1/posts', {
      token: a, method: 'POST', body: { body: `throttle probe ${i}` },
    });
    if (r.status === 429) { aHit429 = true; break; }
  }
  check('user A is throttled on writes', aHit429, aHit429 ? 'hit 429' : 'never hit the limit');

  const bAfter = await call('/v1/posts', {
    token: b, method: 'POST', body: { body: 'user B should still be served' },
  });
  check('user B is UNAFFECTED from the same address', bAfter.status !== 429,
    `status ${bAfter.status}`);

  const anon = await call('/v1/catalogue/service-types');
  check('an anonymous read still works', anon.status !== 429, `status ${anon.status}`);
}

console.log(`\n${failures === 0 ? 'RESULT: the limiter works and keys per caller' : `RESULT: ${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
