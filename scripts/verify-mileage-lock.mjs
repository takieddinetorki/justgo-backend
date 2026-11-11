/**
 * Verifies the two mileage paths scripts/smoke.mjs structurally cannot.
 *
 *  1. THE LOCK ACTUALLY LOCKING. A reading has to be 30 days old, and a
 *     smoke run that finishes in 40 seconds can never produce one. So
 *     this back-dates `mileage_updated_at` on a throwaway account's own
 *     car and checks that the endpoints feeding notifications really do
 *     refuse — and really do open again the instant a reading is saved.
 *
 *     Back-dating the COLUMN rather than faking a clock is the point.
 *     `mileageUpdateRequired` is computed in SQL against the database
 *     clock precisely so no application-side fake can influence it, so a
 *     test that injected a fake clock would be testing the fake.
 *
 *  2. SUPPORT'S CORRECTION, which needs `support.mileage.override`. A
 *     routine smoke run must never hold it — it is the power to lower
 *     somebody's odometer — so this mints it on a scratch account, uses
 *     it, and hands it back at the end.
 *
 * Everything it touches is created here and thrown away. It never reads
 * or writes a real account's data.
 *
 * Run from /opt/justgo/justgo-backend with ANON_KEY set:
 *   ANON_KEY=… node scripts/verify-mileage-lock.mjs
 */
import { execFileSync } from 'node:child_process';

const API = process.env.API_URL ?? 'http://127.0.0.1:3100';
const GOTRUE = process.env.GOTRUE_URL ?? 'http://127.0.0.1:8100';
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

/** A fresh account. Keeps the password, so a token can be re-minted. */
async function makeUser(tag) {
  const email = `mileagecheck-${tag}-${STAMP}@justgo.test`;
  const password = `Mil!${Math.random().toString(36).slice(2, 12)}`;
  const up = await call('POST', '/auth/v1/signup', { base: GOTRUE, body: { email, password } });
  if (!up.data?.access_token) throw new Error(`signup ${tag}: ${JSON.stringify(up.data)}`);
  const user = { email, password };
  user.token = await mintToken(user);
  return user;
}

/**
 * A NEW session token for an existing account.
 *
 * Needed twice over: permissions are baked into the token at exchange
 * time, so a role granted afterwards is invisible until this is called
 * again — and it is also how a "second device" is simulated honestly.
 */
async function mintToken(user) {
  const signin = await call('POST', '/auth/v1/token?grant_type=password', {
    base: GOTRUE,
    body: { email: user.email, password: user.password },
  });
  if (!signin.data?.access_token) throw new Error(`sign-in: ${JSON.stringify(signin.data)}`);
  const s = await call('POST', '/v1/auth/session', { token: signin.data.access_token, body: {} });
  if (!s.data?.accessToken) throw new Error(`exchange: ${JSON.stringify(s.data)}`);
  return s.data.accessToken;
}

function say(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const GUARDED = ['/v1/requests?limit=1', '/v1/reservations?limit=1', '/v1/orders?limit=1'];
const backDate = (id, days) =>
  sql(`update vehicles.vehicles set mileage_updated_at = now() - interval '${days} days' where id = '${id}'`);

// ── 1. the lock, with a reading that really is 30 days old ──────────
console.log('\n-- the lock, with a reading that really IS 30 days old --------');

const owner = await makeUser('owner');
const car = await call('POST', '/v1/vehicles', {
  token: owner.token,
  body: { brand: 'Peugeot', model: '208', year: 2019, mileageKm: 64000, resolveTecDoc: false },
});
const carId = car.data?.id;
say('a car to go stale', car.status === 201 && Boolean(carId), carId ?? JSON.stringify(car.data));

// 31 days: a day past the period, so there is nothing to argue about.
backDate(carId, 31);

const stale = await call('GET', `/v1/vehicles/${carId}`, { token: owner.token });
say('the car reports it needs an update', stale.data?.mileageUpdateRequired === true,
  `mileageUpdateRequired ${stale.data?.mileageUpdateRequired}`);

const locked = await call('GET', '/v1/me/notification-access', { token: owner.token });
say('the account is locked, naming the car and the due date',
  locked.data?.locked === true
    && locked.data?.reason === 'MILEAGE_UPDATE_REQUIRED'
    && locked.data?.vehicleId === carId
    && Boolean(locked.data?.dueAt),
  JSON.stringify(locked.data));

for (const path of GUARDED) {
  const res = await call('GET', path, { token: owner.token });
  say(`${path.split('?')[0]} is refused`,
    res.status === 403 && res.data?.error?.code === 'MILEAGE_UPDATE_REQUIRED',
    `status ${res.status} ${res.data?.error?.code}`);
}

/*
  A 403 with no reason leaves the app nothing to put on screen, and the
  status alone cannot tell "you may not" from "do this and you may".
*/
const refused = await call('GET', GUARDED[0], { token: owner.token });
say('the refusal says which car, and when it fell due',
  refused.data?.error?.details?.vehicleId === carId && Boolean(refused.data?.error?.details?.dueAt),
  JSON.stringify(refused.data?.error?.details));

/*
  IT IS DATABASE STATE, NOT PER-DEVICE STATE. A token minted on a second
  device sees the same verdict without anything being pushed to it.
*/
const secondDevice = await mintToken(owner);
const onPhoneTwo = await call('GET', '/v1/me/notification-access', { token: secondDevice });
say('a second device sees the same lock', onPhoneTwo.data?.locked === true
  && onPhoneTwo.data?.vehicleId === carId, JSON.stringify(onPhoneTwo.data));

/*
  WHAT MUST STAY OPEN. A lock whose own key is behind it leaves the user
  permanently stuck, so these have to answer while locked.
*/
say('notification-access itself answers while locked', locked.status === 200, `status ${locked.status}`);
const garage = await call('GET', `/v1/vehicles/${carId}`, { token: owner.token });
say('and so does the garage', garage.status === 200, `status ${garage.status}`);

const unlock = await call('PATCH', `/v1/vehicles/${carId}/mileage`, {
  token: owner.token,
  body: { mileageKm: 69000 },
});
say('the mileage endpoint answers while locked - it is the way out',
  unlock.status === 200 && unlock.data?.mileageKm === 69000, `status ${unlock.status}`);
say('and saving a reading clears the flag on the spot',
  unlock.data?.mileageUpdateRequired === false,
  `mileageUpdateRequired ${unlock.data?.mileageUpdateRequired}`);

for (const path of GUARDED) {
  const res = await call('GET', path, { token: owner.token });
  say(`${path.split('?')[0]} answers again`, res.status === 200, `status ${res.status}`);
}

// Cleared for the OTHER device too, with no new token and no push.
const phoneTwoAfter = await call('GET', '/v1/me/notification-access', { token: secondDevice });
say('and it cleared on the second device at the same moment',
  phoneTwoAfter.data?.locked === false, JSON.stringify(phoneTwoAfter.data));

// ── 2. support corrects a typo ──────────────────────────────────────
console.log('\n-- support corrects a typo the owner cannot undo --------------');

// 150 000 instead of 15 000: the mistake that is permanent from the
// owner's side, which is exactly why the desk needs a way in.
await call('PATCH', `/v1/vehicles/${carId}/mileage`, {
  token: owner.token,
  body: { mileageKm: 150000 },
});
const stuck = await call('PATCH', `/v1/vehicles/${carId}/mileage`, {
  token: owner.token,
  body: { mileageKm: 15000 },
});
say('the owner cannot undo it themselves',
  stuck.status === 422 && stuck.data?.error?.code === 'MILEAGE_LOWER',
  `status ${stuck.status} ${stuck.data?.error?.code}`);

const desk = await makeUser('support');
const deskAccountId = sql(`select id from identity.accounts where email = '${desk.email}'`);
say('a scratch support account exists', deskAccountId.length === 36, deskAccountId);

const beforeGrant = await call('PATCH', `/v1/admin/vehicles/${carId}/mileage`, {
  token: desk.token,
  body: { mileageKm: 15000, reason: 'before the grant' },
});
say('and cannot correct anything until it is granted the permission',
  beforeGrant.status === 403, `status ${beforeGrant.status}`);

// identity.user_roles, and the grant is SCOPED - 'global' with a null
// scope_id, the same shape verify-driver-verification.mjs uses.
sql(`insert into identity.user_roles (account_id, role_id, scope_type, scope_id)
     select '${deskAccountId}', id, 'global', null from identity.roles where key = 'ops_admin'
     on conflict do nothing`);
// Permissions are baked in at exchange time, so the token is re-minted.
desk.token = await mintToken(desk);

const beforeCorrection = await call('GET', `/v1/vehicles/${carId}`, { token: owner.token });
const corrected = await call('PATCH', `/v1/admin/vehicles/${carId}/mileage`, {
  token: desk.token,
  body: { mileageKm: 15000, reason: `Client typed 150000 instead of 15000 (check ${STAMP})` },
});
say('support may set a LOWER value',
  corrected.status === 200 && corrected.data?.mileageKm === 15000,
  `status ${corrected.status} ${JSON.stringify(corrected.data?.mileageKm ?? corrected.data)}`);

/*
  And it must NOT hand the user a fresh 30 days they never earned, or a
  correction becomes a way to launder a stale reading into a current one.
*/
say('without touching the 30-day clock',
  corrected.data?.mileageUpdatedAt === beforeCorrection.data?.mileageUpdatedAt,
  `${beforeCorrection.data?.mileageUpdatedAt} -> ${corrected.data?.mileageUpdatedAt}`);

const trail = sql(
  `select source || ':' || coalesce(previous_km::text,'-') || '->' || new_km
     from vehicles.mileage_history where vehicle_id = '${carId}' order by recorded_at`,
).split('\n').map((r) => r.trim()).filter(Boolean);
say('the correction is on the record as support, not as the owner',
  trail.some((r) => r === 'support:150000->15000'), trail.join(' | '));

const actor = sql(
  `select actor_account_id from vehicles.mileage_history
    where vehicle_id = '${carId}' and source = 'support' limit 1`,
);
say('and names who did it', actor === deskAccountId, `${actor} vs ${deskAccountId}`);

const reasonless = await call('PATCH', `/v1/admin/vehicles/${carId}/mileage`, {
  token: desk.token,
  body: { mileageKm: 16000 },
});
say('a correction with no stated reason is refused', reasonless.status === 400,
  `status ${reasonless.status}`);

// ── the scratch permission goes back ────────────────────────────────
sql(`delete from identity.user_roles where account_id = '${deskAccountId}'
       and role_id = (select id from identity.roles where key = 'ops_admin')`);
const left = sql(
  `select count(*) from identity.user_roles ur
     join identity.roles r on r.id = ur.role_id
    where r.key = 'ops_admin' and ur.account_id = '${deskAccountId}'`,
);
say('the scratch admin rights are handed back', left === '0', `${left} left`);

console.log('');
