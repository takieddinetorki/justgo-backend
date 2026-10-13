/**
 * Verifies the one path scripts/smoke.mjs deliberately cannot: the ops
 * verification decision, and the reactor that turns it into `driver.work`.
 *
 * It needs an account holding platform.admin — which a routine smoke test
 * must never have, since it would carry read access to every identity
 * document in the system. So this is a by-hand check on a dev box: it mints
 * one, uses it, and revokes it again at the end.
 *
 * Run from /opt/justgo/justgo-backend with ANON_KEY set.
 */
import { execFileSync } from 'node:child_process';

const API = 'http://127.0.0.1:3100';
const GOTRUE = 'http://127.0.0.1:8100';
const ANON = process.env.ANON_KEY ?? '';
const STAMP = Date.now();

function sql(statement) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'justgo-supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement],
    { encoding: 'utf8' },
  ).trim();
}

async function call(method, path, { token, body, base = API } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(base === GOTRUE && ANON ? { apikey: ANON } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function makeUser(tag) {
  const email = `drvcheck-${tag}-${STAMP}@justgo.test`;
  const password = `Drv!${Math.random().toString(36).slice(2, 12)}`;
  const up = await call('POST', '/auth/v1/signup', { base: GOTRUE, body: { email, password } });
  if (!up.data?.access_token) throw new Error(`signup ${tag}: ${JSON.stringify(up.data)}`);
  return { email, password };
}

async function session(user) {
  const signin = await call('POST', '/auth/v1/token?grant_type=password', {
    base: GOTRUE,
    body: { email: user.email, password: user.password },
  });
  if (!signin.data?.access_token) throw new Error(`sign-in: ${JSON.stringify(signin.data)}`);
  const s = await call('POST', '/v1/auth/session', { token: signin.data.access_token, body: {} });
  if (!s.data?.accessToken) throw new Error(`exchange: ${JSON.stringify(s.data)}`);
  return s.data;
}

function say(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

// ── a driver, walked to pending_review ───────────────────────────────
const driverUser = await makeUser('driver');
let driverSession = await session(driverUser);
const applied = await call('POST', '/v1/driver', {
  token: driverSession.accessToken,
  body: { fullName: `Check Driver ${STAMP}`, licenceExpiresOn: '2032-01-31' },
});
const driverId = applied.data?.id;
say('driver profile created', applied.status === 201, driverId ?? JSON.stringify(applied.data));

const upload = await call('POST', '/v1/media/uploads', {
  token: driverSession.accessToken,
  body: { bucket: 'driver-documents', filename: 'l.jpg', contentType: 'image/jpeg' },
});
for (const kind of ['licence_front', 'selfie']) {
  await call('POST', '/v1/driver/me/documents', {
    token: driverSession.accessToken,
    body: { kind, bucket: 'driver-documents', path: upload.data.path },
  });
}
const submitted = await call('POST', '/v1/driver/me/submit', { token: driverSession.accessToken });
say('submitted for review', submitted.data?.status === 'pending_review', submitted.data?.status);

// ── an ops account, minted for this check only ───────────────────────
const opsUser = await makeUser('ops');
const opsSession0 = await session(opsUser);
const opsAccount = opsSession0.account.id;
sql(
  `insert into identity.user_roles (account_id, role_id, scope_type, scope_id)
   select '${opsAccount}', id, 'global', null from identity.roles where key = 'ops_admin'
   on conflict do nothing`,
);
const ops = await session(opsUser);
say('ops holds platform.admin', ops.permissions.includes('platform.admin'),
  `${ops.permissions.length} permissions`);

try {
  const queue = await call('GET', '/v1/driver/review', { token: ops.accessToken });
  say('ops can read the review queue', queue.status === 200,
    `${queue.data?.items?.length} pending`);
  say('our driver is in it',
    (queue.data?.items ?? []).some((d) => d.id === driverId));

  const decided = await call('PATCH', `/v1/driver/${driverId}/verification`, {
    token: ops.accessToken,
    body: { status: 'verified' },
  });
  say('ops can verify', decided.data?.status === 'verified' && Boolean(decided.data?.verifiedAt),
    `${decided.status} -> ${decided.data?.status}`);

  /*
    THE REAL TEST. The role arrives through outbox -> relay -> BullMQ ->
    DriverRoleReactor. A failure here is not a driver problem: it means
    cross-process event delivery is broken, which has happened before and was
    invisible to every unit test.
  */
  let granted = null;
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 800));
    const s = await session(driverUser);
    if (s.permissions.includes('driver.work')) {
      granted = s;
      break;
    }
  }
  say('the reactor granted driver.work', granted !== null,
    granted ? `roles ${granted.roles.join(',')}` : 'never arrived');

  if (granted) {
    const online = await call('PATCH', '/v1/driver/me/availability', {
      token: granted.accessToken,
      body: { isOnline: true, lat: 36.7538, lng: 3.0588 },
    });
    say('a verified driver can go online', online.data?.availability?.isOnline === true,
      `${online.status} at ${online.data?.availability?.lat},${online.data?.availability?.lng}`);
  }

  const noReason = await call('PATCH', `/v1/driver/${driverId}/verification`, {
    token: ops.accessToken,
    body: { status: 'suspended' },
  });
  say('a refusal with no reason is refused', noReason.status >= 400, `status ${noReason.status}`);

  const suspended = await call('PATCH', `/v1/driver/${driverId}/verification`, {
    token: ops.accessToken,
    body: { status: 'suspended', reason: 'Licence revoked by the authority' },
  });
  say('ops can suspend', suspended.data?.status === 'suspended', `${suspended.status}`);
  say('suspension forces the driver offline',
    suspended.data?.availability?.isOnline === false,
    `isOnline ${suspended.data?.availability?.isOnline}`);
  say('and records why', Boolean(suspended.data?.decisionReason),
    `"${suspended.data?.decisionReason}"`);

  let revoked = false;
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 800));
    const s = await session(driverUser);
    if (!s.permissions.includes('driver.work')) {
      revoked = true;
      break;
    }
  }
  say('the reactor revoked driver.work', revoked);

  const resubmit = await call('POST', '/v1/driver/me/submit', {
    token: (await session(driverUser)).accessToken,
  });
  say('a suspended driver can resubmit', resubmit.data?.status === 'pending_review',
    `${resubmit.status} -> ${resubmit.data?.status}`);
} finally {
  // Never leave platform.admin lying around on a test account.
  sql(
    `delete from identity.user_roles
      where account_id = '${opsAccount}'
        and role_id = (select id from identity.roles where key = 'ops_admin')`,
  );
  const after = await session(opsUser);
  say('the temporary ops grant was removed', !after.permissions.includes('platform.admin'));
}
