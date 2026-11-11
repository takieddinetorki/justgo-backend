#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING deployment.
 *
 *   API_URL=http://127.0.0.1:3100 GOTRUE_URL=http://127.0.0.1:8100 \
 *   ANON_KEY=… node scripts/smoke.mjs
 *
 * WHY THIS EXISTS. Three separate defects in this codebase were invisible to
 * the unit suite and only appeared in the bundled deployment: SWC rewriting a
 * Set spread so no event handler was ever a function, an outbox whose schema
 * list missed four modules so 38 events were never published, and a narrow
 * no-break space that pdf-lib's WinAnsi fonts cannot encode, which killed
 * invoice issuance silently inside a reactor. Jest passed for all three.
 * Only a real request through the real bundle finds that class of bug.
 *
 * It walks the whole product: auth exchange, the core part-request loop, the
 * order lifecycle through to the facture, messaging with attachments, and the
 * social feed. Each step prints PASS or FAIL and the script exits non-zero if
 * anything failed, so it can gate a deploy.
 *
 * Accounts are created with throwaway credentials on each run. Point it only
 * at a development deployment.
 *
 * DO NOT RUN THIS AND THE UNIT SUITE AT THE SAME TIME.
 * `bullmq-event-bus.spec.ts` subscribes on the default `domain-events`
 * queue, and on BullMQ subscribing is what spins up a consumer — so the jest
 * process becomes a COMPETING CONSUMER against the API under test. Jobs
 * complete, the API's reactors never see them, and every event-driven step
 * here fails with "still not true after 25 tries", which is
 * indistinguishable from the real bug it is there to catch.
 */

const API = (process.env.API_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const GOTRUE = (process.env.GOTRUE_URL ?? 'http://127.0.0.1:8100').replace(/\/$/, '');
const ANON = process.env.ANON_KEY ?? '';
const STAMP = Date.now();

let passed = 0;
const failures = [];

function ok(label, detail = '') {
  passed += 1;
  console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
}

function bad(label, detail) {
  failures.push(`${label}: ${detail}`);
  console.log(`  FAIL  ${label}  ${detail}`);
}

function check(label, condition, detail = '') {
  if (condition) ok(label, detail);
  else bad(label, detail || 'condition not met');
  return condition;
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
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
  return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
}

/** A throwaway account, plus the session token the rest of the API needs. */
async function makeUser(tag) {
  const email = `smoke-${tag}-${STAMP}@justgo.test`;
  // Random per run; never reused, never written anywhere.
  const password = `Sm0ke!${Math.random().toString(36).slice(2, 12)}`;

  const signup = await call('POST', '/auth/v1/signup', {
    base: GOTRUE,
    body: { email, password },
  });
  const upstream = signup.data?.access_token;
  if (!upstream) {
    throw new Error(`signup failed for ${tag}: ${signup.status} ${JSON.stringify(signup.data)}`);
  }
  const user = { tag, email, password };
  await exchange(user);
  return user;
}

/**
 * Sign in and exchange, mutating the user in place.
 *
 * Needed as its OWN step because roles arrive asynchronously: the
 * `supplier_owner` role is granted by a reactor on
 * suppliers.SupplierRegistered, so a token minted before that event is
 * handled carries neither the role nor a supplier scope. Re-exchanging is
 * also exactly what the mobile app must do after every GoTrue refresh.
 */
async function exchange(user, scope) {
  const signin = await call('POST', '/auth/v1/token?grant_type=password', {
    base: GOTRUE,
    body: { email: user.email, password: user.password },
  });
  const upstream = signin.data?.access_token;
  if (!upstream) {
    throw new Error(`sign-in failed for ${user.tag}: ${signin.status} ${JSON.stringify(signin.data)}`);
  }
  const session = await call('POST', '/v1/auth/session', {
    token: upstream,
    body: scope ? { scope } : {},
  });
  if (!session.data?.accessToken) {
    throw new Error(
      `session exchange failed for ${user.tag}: ${session.status} ${JSON.stringify(session.data)}`,
    );
  }
  user.token = session.data.accessToken;
  user.accountId = session.data.account?.id ?? null;
  user.permissions = session.data.permissions ?? [];
  user.supplierId = session.data.supplier?.supplierId ?? null;
  return user;
}

/**
 * GET a verification, riding out the per-ADDRESS rate limit.
 *
 * The endpoint is anonymous, so the limiter keys on the address and
 * everything else running from this host shares the bucket. A 429 here
 * means the limiter works, not that verification is broken.
 */
async function verifyRetrying(fingerprint) {
  let res = await call('GET', `/v1/documents/verify/${fingerprint}`);
  for (let i = 0; res.status === 429 && i < 3; i += 1) {
    const wait = Number(res.retryAfter ?? 60) * 1000;
    console.log(`  ..    rate limited, waiting ${wait / 1000}s (the limiter is doing its job)`);
    await new Promise((r) => setTimeout(r, wait + 1000));
    res = await call('GET', `/v1/documents/verify/${fingerprint}`);
  }
  return res;
}

/** Poll until a condition holds — events travel outbox -> relay -> bus. */
async function eventually(label, fn, { tries = 25, waitMs = 600 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const out = await fn();
    if (out) return out;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  bad(label, `still not true after ${tries} tries`);
  return null;
}


/*
  The smallest real PNG: a 1x1 transparent pixel, 67 bytes. Storage is
  asked to serve it back byte for byte, so the test needs actual image
  bytes rather than a text file with a .png name — Storage records the
  content type it was given, and an <img> is what has to accept it.
*/
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Upload a real image the way the app does: ask for a signed PUT, then
 * send the bytes straight to Storage. Returns the (bucket, path) ref the
 * app would then attach to a post or a listing.
 */
async function uploadPixel(user, bucket, filename) {
  const signed = await call('POST', '/v1/media/uploads', {
    token: user.token,
    body: { bucket, filename, contentType: 'image/png' },
  });
  if (!signed.data?.uploadUrl) {
    return { ok: false, detail: `sign failed: ${signed.status} ${JSON.stringify(signed.data)}` };
  }
  const put = await fetch(signed.data.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: PIXEL_PNG,
  });
  return {
    ok: put.ok,
    detail: `upload HTTP ${put.status}`,
    ref: { bucket, path: signed.data.path },
  };
}

/** Fetch a URL with NO headers — exactly what an <img> tag does. */
async function fetchAsImage(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type'), bytes: buf.length };
}

async function main() {
  console.log(`JustGo smoke test\n  api     ${API}\n  gotrue  ${GOTRUE}`);

  section('health & docs');
  const health = await call('GET', '/v1/health');
  check('health is ok', health.data?.status === 'ok', `status ${health.status}`);
  const spec = await call('GET', '/v1/docs-json');
  check('OpenAPI 3 document served', /^3\./.test(spec.data?.openapi ?? ''),
    `${Object.keys(spec.data?.paths ?? {}).length} paths`);

  /*
    Public routes that take an id in the path. A path parameter comes from
    whoever typed the URL, so a malformed one is a 400 — it used to be a
    500 with a stack trace in the log, on three unauthenticated routes,
    because `asId` threw a TypeError and the filter could only read that
    as our bug. Unauthenticated on purpose here: these are reachable by
    anyone, which is exactly why the status has to be right.
  */
  for (const [label, path] of [
    ['a public supplier profile', '/v1/discovery/suppliers/not-a-uuid'],
    ['a public car listing', '/v1/marketplace/listings/not-a-uuid'],
    ['a public review list', '/v1/suppliers/not-a-uuid/reviews'],
  ]) {
    const res = await call('GET', path);
    check(`${label} rejects a malformed id with 400, not 500`,
      res.status === 400 && res.data?.error?.code === 'VALIDATION_FAILED',
      `status ${res.status} ${res.data?.error?.code ?? ''}`);
  }
  {
    // Well-formed but reserved — the nil UUID has no version nibble.
    const res = await call('GET', '/v1/suppliers/00000000-0000-0000-0000-000000000000/reviews');
    check('and the nil UUID is a malformed id too', res.status === 400,
      `status ${res.status}`);
  }

  section('auth exchange');
  const client = await makeUser('client');
  ok('client signed up and exchanged', `${client.permissions.length} permissions`);
  const seller = await makeUser('seller');
  ok('seller signed up and exchanged');

  // A GoTrue token alone must NOT open a permissioned endpoint.
  const raw = await call('POST', '/auth/v1/token?grant_type=password', {
    base: GOTRUE,
    body: { email: client.email, password: 'wrong-on-purpose' },
  });
  check('a bad password is refused', raw.status >= 400, `status ${raw.status}`);

  section('/v1/me resolves the REAL account');
  {
    /*
      THE GHOST ACCOUNT. `AuthContext.accountId` is `account_id ?? sub`, so
      it is an identity account id for a session token and a GoTrue user id
      for a raw one. `/v1/me` used to pass it to a helper that keys on
      `auth_user_id` alone, which INSERTED A SECOND ACCOUNT whose
      auth_user_id was the first one's primary key — with its own default
      role. Every call the apps make after the exchange carries a session
      token, so every `/v1/me` read and wrote that ghost while the caller's
      orders, documents and reviews hung off the original.

      It passed unnoticed because the ghost was consistent with itself: PUT
      then GET agreed. Comparing against the session's own account id is
      what catches it.
    */
    const me = await call('GET', '/v1/me', { token: client.token });
    check('GET /v1/me returns the account the session is for',
      me.data?.id === client.accountId, `${me.data?.id} vs ${client.accountId}`);

    const named = await call('PUT', '/v1/me', {
      token: client.token,
      body: { firstName: 'Taki', city: 'Alger' },
    });
    check('PUT /v1/me writes that same account', named.data?.id === client.accountId,
      `${named.data?.id} vs ${client.accountId}`);

    const reread = await call('GET', '/v1/me', { token: client.token });
    check('and the write is visible on the account the session names',
      reread.data?.firstName === 'Taki' && reread.data?.id === client.accountId,
      `${reread.data?.firstName} on ${reread.data?.id}`);

    const cleared = await call('PUT', '/v1/me', { token: client.token, body: { city: null } });
    check('null clears a profile field', cleared.data?.city === null, String(cleared.data?.city));
    check('and leaves the keys it did not mention', cleared.data?.firstName === 'Taki',
      String(cleared.data?.firstName));

    const futureDob = await call('PUT', '/v1/me', {
      token: client.token,
      body: { dob: '2099-01-01' },
    });
    check('a date of birth in the future is refused', futureDob.status === 400,
      `status ${futureDob.status}`);

    const stolenAvatar = await call('PUT', '/v1/me', {
      token: client.token,
      body: { avatar: { bucket: 'avatars', path: 'somebody-else/face.jpg' } },
    });
    check('an avatar path outside your namespace is refused', stolenAvatar.status === 400,
      `status ${stolenAvatar.status}`);
  }

  section('supplier registration & fiscal identity');
  const reg = await call('POST', '/v1/supplier', {
    token: seller.token,
    body: { verticalKey: 'part_store', name: `Smoke Parts ${STAMP}`, city: 'Alger', country: 'DZ' },
  });
  const supplierId = reg.data?.id;
  check('supplier registered', Boolean(supplierId), `status ${reg.status}`);

  /*
    The supplier_owner role is granted by a reactor on
    suppliers.SupplierRegistered, which travels outbox -> relay -> BullMQ.
    So the scope is not available the instant the POST returns, and polling
    the re-exchange is the honest way to wait for it. A failure HERE means
    cross-process events are not being delivered at all — which is exactly
    the defect that once made every quote silently vanish.
  */
  const scoped = await eventually('supplier scope granted by the reactor', async () => {
    try {
      await exchange(seller, 'supplier');
    } catch {
      // 403 "no supplier role" until the reactor has run — keep waiting.
      return null;
    }
    return seller.supplierId ? seller : null;
  });
  if (scoped) ok('supplier scope granted by the reactor', `supplierId ${seller.supplierId}`);

  const fiscal = await call('PATCH', '/v1/supplier/fiscal', {
    token: seller.token,
    body: {
      legalName: `SARL SMOKE PARTS ${STAMP}`,
      address: '12 rue Didouche Mourad',
      // Unique per run: NIF and RC are unique per company, so reusing a
      // fixed value would make the SECOND run of this script fail with a
      // perfectly correct 409.
      nif: `0002160${String(STAMP).slice(-8)}`,
      nis: `0002160${String(STAMP).slice(-8)}`,
      rc: `16/00-${String(STAMP).slice(-7)}B16`,
      taxArticle: `160${String(STAMP).slice(-8)}`,
    },
  });
  check('fiscal identity accepted', Boolean(fiscal.data?.nif),
    `status ${fiscal.status} ${fiscal.data?.nif ?? JSON.stringify(fiscal.data).slice(0, 120)}`);

  // The same NIF belongs to one company by law, so a collision must be an
  // actionable 409 and not the bare 500 this used to produce.
  const other = await makeUser('seller2');
  await call('POST', '/v1/supplier', {
    token: other.token,
    body: { verticalKey: 'part_store', name: `Smoke Parts B ${STAMP}`, city: 'Oran', country: 'DZ' },
  });
  await eventually('second supplier scoped', async () => {
    try {
      await exchange(other, 'supplier');
    } catch {
      return null;
    }
    return other.supplierId ? other : null;
  });
  const clash = await call('PATCH', '/v1/supplier/fiscal', {
    token: other.token,
    body: { nif: fiscal.data?.nif },
  });
  check('a duplicate NIF is a 409, not a 500',
    clash.status === 409 && clash.data?.error?.code === 'FISCAL_IDENTIFIER_TAKEN',
    `status ${clash.status} code ${clash.data?.error?.code}`);

  section('the supplier profile, branches & the verified badge');
  {
    const patched = await call('PATCH', '/v1/supplier/profile', {
      token: seller.token,
      body: {
        description: 'Pieces detachees toutes marques.',
        phone: '+213555000111',
        address: 'Rue des Freres Bouadou, Bir Mourad Rais',
        hours: { mon: [{ from: '09:00', to: '12:30' }, { from: '14:00', to: '18:00' }] },
      },
    });
    check('profile edited', patched.data?.description === 'Pieces detachees toutes marques.',
      `status ${patched.status}`);
    check('opening hours stored as sent', patched.data?.hours?.mon?.length === 2,
      JSON.stringify(patched.data?.hours ?? null));

    // null clears, absent leaves alone. Without the first, a description
    // would be permanent once written.
    const cleared = await call('PATCH', '/v1/supplier/profile', {
      token: seller.token,
      body: { description: null },
    });
    check('null clears a field', cleared.data?.description === null,
      JSON.stringify(cleared.data?.description));
    check('an absent key leaves its field alone', cleared.data?.phone === '+213555000111',
      String(cleared.data?.phone));

    const badHours = await call('PATCH', '/v1/supplier/profile', {
      token: seller.token,
      body: { hours: { mon: [{ from: '18:00', to: '09:00' }] } },
    });
    check('hours that end before they start are refused', badHours.status === 400,
      `status ${badHours.status}`);

    const overlap = await call('PATCH', '/v1/supplier/profile', {
      token: seller.token,
      body: {
        hours: { tue: [{ from: '09:00', to: '15:00' }, { from: '14:00', to: '18:00' }] },
      },
    });
    check('overlapping intervals are refused, not merged', overlap.status === 400,
      `status ${overlap.status}`);

    const stolenLogo = await call('PATCH', '/v1/supplier/profile', {
      token: seller.token,
      body: { logo: { bucket: 'supplier-media', path: 'somebody-else/logo.png' } },
    });
    check('a logo path outside your namespace is refused', stolenLogo.status === 400,
      `status ${stolenLogo.status}`);

    const otherBucket = await call('PATCH', '/v1/supplier/profile', {
      token: seller.token,
      body: { logo: { bucket: 'driver-documents', path: `${seller.accountId}/x.png` } },
    });
    check('a logo cannot point at another bucket', otherBucket.status === 400,
      `status ${otherBucket.status}`);

    const notASupplier = await call('PATCH', '/v1/supplier/profile', {
      token: client.token,
      body: { name: 'Hostile Takeover' },
    });
    check('a client cannot edit a business they do not own', notASupplier.status >= 400,
      `status ${notASupplier.status}`);

    /*
      THE WHOLE POINT OF THE BADGE: the subject cannot award it. There is no
      owner-facing route that reaches the field, and the ops route is behind
      platform.admin, which nothing in this run holds.
    */
    const selfVerify = await call('PATCH', `/v1/supplier/${supplierId}/verification`, {
      token: seller.token,
      body: { verified: true },
    });
    check('a supplier cannot verify itself', selfVerify.status === 403,
      `status ${selfVerify.status}`);
    check('the profile reports itself unverified', patched.data?.isVerified === false,
      String(patched.data?.isVerified));
    check('the ops note is not on an ordinary read',
      !('verificationNote' in (patched.data ?? {})),
      JSON.stringify(Object.keys(patched.data ?? {}).filter((k) => k.includes('verification'))));

    // -- branches -----------------------------------------------------
    const branch = await call('POST', '/v1/supplier/branches', {
      token: seller.token,
      body: { name: `Succursale ${STAMP}`, city: 'Oran', country: 'DZ', phone: '+213555222333' },
    });
    const branchId = branch.data?.id;
    check('branch opened', branch.status === 201 && Boolean(branchId), `status ${branch.status}`);

    const afterOpen = await call('GET', '/v1/supplier/profile', { token: seller.token });
    check('isMultiBranch is derived, not declared', afterOpen.data?.isMultiBranch === true,
      String(afterOpen.data?.isMultiBranch));

    const branches = await call('GET', '/v1/supplier/branches', { token: seller.token });
    check('branch lists back', (branches.data?.items ?? []).some((b) => b.id === branchId),
      `${branches.data?.items?.length} items`);

    if (branchId) {
      const renamed = await call('PATCH', `/v1/supplier/branches/${branchId}`, {
        token: seller.token,
        body: { name: 'Succursale Oran', phone: null },
      });
      check('branch edited', renamed.data?.name === 'Succursale Oran', `status ${renamed.status}`);
      check('null clears on a branch too', renamed.data?.phone === null, String(renamed.data?.phone));

      const foreign = await call('PATCH', `/v1/supplier/branches/${branchId}`, {
        token: client.token,
        body: { name: 'Mine now' },
      });
      check('another account cannot touch your branch', foreign.status >= 400,
        `status ${foreign.status}`);

      const closedBranch = await call('DELETE', `/v1/supplier/branches/${branchId}`, {
        token: seller.token,
      });
      check('branch closed, not deleted', Boolean(closedBranch.data?.closedAt),
        `status ${closedBranch.status}`);

      const stillThere = await call('GET', '/v1/supplier/branches?includeClosed=true', {
        token: seller.token,
      });
      check('a closed branch is still addressable',
        (stillThere.data?.items ?? []).some((b) => b.id === branchId),
        `${stillThere.data?.items?.length} items`);

      const afterClose = await call('GET', '/v1/supplier/profile', { token: seller.token });
      check('isMultiBranch follows the branch count back down',
        afterClose.data?.isMultiBranch === false, String(afterClose.data?.isMultiBranch));
    }
  }

  section('the core loop: request -> quote -> accept -> order');
  const request = await call('POST', '/v1/requests', {
    token: client.token,
    body: { strategy: 'all', categoryKey: 'braking', freeText: 'Plaquettes avant', quantity: 2 },
  });
  const requestId = request.data?.id;
  check('part request submitted', Boolean(requestId), `status ${request.status}`);

  /*
    FAN-OUT IS THE PRODUCT'S CORE LOOP and it has been broken twice: once
    because the targeting port resolved to null in the composed app and
    dropped every request, once because an SWC-rewritten Map spread made the
    vertical registry return garbage. Both passed every unit test.
  */
  const inbox = await eventually('fan-out reached the supplier', async () => {
    const res = await call('GET', '/v1/supplier/requests?limit=20', { token: seller.token });
    const mine = (res.data?.items ?? []).filter((q) => q.requestId === requestId);
    return mine.length > 0 ? mine : null;
  });
  if (inbox) ok('fan-out reached the supplier', `${inbox.length} quote stub(s)`);

  let orderId = null;
  /*
    Remembered so that closing the buyer's account at the end of this run can
    prove the facture is UNTOUCHED by it — the sha256 is over the exact
    stored bytes, so an unchanged hash is proof the buyer's printed name is
    still in there.
  */
  let factureNumber = null;
  let factureSha = null;
  if (inbox) {
    const quoteId = inbox[0].id;
    const priced = await call('POST', `/v1/supplier/requests/${quoteId}/quote`, {
      token: seller.token,
      body: { amount: { amountMinor: 1_190_000, currency: 'DZD' } },
    });
    check('supplier quoted a price', priced.status < 400, `status ${priced.status}`);

    const accepted = await call('POST', `/v1/quotes/${quoteId}/accept`, { token: client.token });
    check('client accepted the quote', accepted.status < 400, `status ${accepted.status}`);

    const order = await eventually('order created from the accepted quote', async () => {
      const res = await call('GET', '/v1/orders?limit=10', { token: client.token });
      const found = (res.data?.items ?? []).find((o) => o.quoteId === quoteId);
      return found ?? null;
    });
    if (order) {
      orderId = order.id;
      ok('order created from the accepted quote', `${orderId} status ${order.status}`);
      check('the order carries the agreed price',
        order.amount?.amountMinor === 1_190_000, JSON.stringify(order.amount));
    }

    const devis = await call('POST', `/v1/quotes/${quoteId}/document`, { token: client.token });
    check('devis issued', /^DEV-/.test(devis.data?.number ?? ''),
      `${devis.status} ${devis.data?.number ?? JSON.stringify(devis.data).slice(0, 120)}`);
    const devisAgain = await call('POST', `/v1/quotes/${quoteId}/document`, { token: client.token });
    check('asking for the devis twice returns the same one',
      devisAgain.data?.number === devis.data?.number,
      `${devisAgain.data?.number} vs ${devis.data?.number}`);
  }

  section('the order lifecycle, through to the facture');
  if (orderId) {
    const bc = await call('POST', `/v1/orders/${orderId}/purchase-order`, { token: client.token });
    check('bon de commande issued', /^BC-/.test(bc.data?.number ?? ''),
      `${bc.status} ${bc.data?.number ?? JSON.stringify(bc.data).slice(0, 120)}`);

    // A client must not be able to drive fulfilment — that is the whole
    // point of order.fulfil being the supplier's permission.
    const forged = await call('PATCH', `/v1/orders/${orderId}/status`, {
      token: client.token,
      body: { action: 'complete' },
    });
    check('a client cannot complete their own order', forged.status === 403,
      `status ${forged.status}`);

    // Out-of-order transitions must be refused by the state machine.
    const tooSoon = await call('PATCH', `/v1/orders/${orderId}/status`, {
      token: seller.token,
      body: { action: 'complete' },
    });
    check('created -> completed is refused', tooSoon.status === 409, `status ${tooSoon.status}`);

    for (const action of ['confirm', 'start', 'complete']) {
      const step = await call('PATCH', `/v1/orders/${orderId}/status`, {
        token: seller.token,
        body: { action },
      });
      check(`supplier can ${action}`, step.status < 400,
        `status ${step.status} -> ${step.data?.status}`);
    }

    const after = await call('POST', `/v1/orders/${orderId}/cancel`, { token: client.token });
    check('a completed order cannot be cancelled', after.status === 409, `status ${after.status}`);

    /*
      THE POINT OF ALL OF THE ABOVE. Completion is what issues the facture,
      and the one bug that killed issuance before was invisible to tests: a
      narrow no-break space the PDF font could not encode, thrown inside a
      reactor where nobody was watching.
    */
    const invoice = await eventually('facture issued on completion', async () => {
      const res = await call('GET', '/v1/documents?limit=20', { token: client.token });
      return (res.data?.items ?? []).find(
        (d) => d.type === 'invoice' && d.subjectId === orderId,
      ) ?? null;
    });
    if (invoice) {
      ok('facture issued on completion', `${invoice.number}, ${invoice.byteSize} bytes`);
      factureNumber = invoice.number;
      factureSha = invoice.sha256;
      check('the facture is signed', invoice.algo === 'ed25519' && invoice.sha256?.length === 64,
        `${invoice.algo} sha256:${invoice.sha256?.slice(0, 12)}…`);

      /*
        Retried on 429, because this endpoint is rate limited per ADDRESS (it
        is anonymous, so there is no caller to key on) and anything else
        running from this host shares that bucket — including the throttle
        check next door. A 429 here means the limiter is working, not that
        verification is broken, and a gate that reports the two the same way
        stops being trusted.
      */
      let verify = await call('GET', `/v1/documents/verify/${invoice.number}`);
      for (let i = 0; verify.status === 429 && i < 3; i += 1) {
        const wait = Number(verify.retryAfter ?? 60) * 1000;
        console.log(`  ..    rate limited, waiting ${wait / 1000}s (the limiter is doing its job)`);
        await new Promise((r) => setTimeout(r, wait + 1000));
        verify = await call('GET', `/v1/documents/verify/${invoice.number}`);
      }
      check('public verification says authentic',
        verify.data?.authentic === true && verify.data?.status === 'issued',
        `authentic ${verify.data?.authentic} status ${verify.data?.status}`);

      /*
        THE FINGERPRINT ON THE PAGE. The document carries a SHA-256 over
        its own content, printed in full and encoded in the QR, and that
        is the value verification resolves. Checked here rather than only
        in a unit test because the thing that matters is that the hash a
        holder reads off paper reaches a real record.
      */
      check('the facture carries a content fingerprint',
        /^[0-9a-f]{64}$/.test(invoice.contentHash ?? ''),
        `${invoice.contentHash?.slice(0, 16)}…`);

      if (invoice.contentHash) {
        const byHash = await verifyRetrying(invoice.contentHash);
        check('and verification resolves it',
          byHash.data?.found === true && byHash.data?.authentic === true,
          `found ${byHash.data?.found} authentic ${byHash.data?.authentic}`);
        check('…naming the same document the number does',
          byHash.data?.number === invoice.number,
          `${byHash.data?.number} vs ${invoice.number}`);

        /*
          Typed off the page, not pasted: the hash is printed in eight
          groups of eight, and somebody reading it aloud will produce
          spaces and may use capitals.
          */
        const groups = invoice.contentHash.toUpperCase().match(/.{1,8}/g).join(' ');
        const typed = await verifyRetrying(encodeURIComponent(groups));
        check('a fingerprint typed in its printed groups also resolves',
          typed.data?.found === true && typed.data?.number === invoice.number,
          `found ${typed.data?.found}`);

        // One character off is a different document, and there is no such one.
        const wrong = invoice.contentHash.slice(0, 63) + (invoice.contentHash.endsWith('0') ? '1' : '0');
        const miss = await verifyRetrying(wrong);
        check('a fingerprint that is one character off finds nothing',
          miss.data?.found === false && miss.data?.verdict === 'not_found',
          `found ${miss.data?.found} verdict ${miss.data?.verdict}`);

        /*
          THE COPIED-CODE ATTACK, which is the one that matters.

          Nothing stops a forger lifting a valid fingerprint off a 6 000
          DZD facture and printing it on a page that says 10 000 - they
          own the printer, and the code is just ink. So a scan with no
          file supplied must NOT answer "authentic and unaltered", which
          it did, and which read back to the scanner as confirmation of
          the forgery. It has to say only what it knows, and show the
          real figures so the holder can compare them with the paper.
        */
        check('a scan with no file does not claim the holder copy is unaltered',
          byHash.data?.verdict === 'exists_unchecked' &&
            !/unaltered/i.test(byHash.data?.message ?? ''),
          `verdict ${byHash.data?.verdict}`);
        check('...and says so in as many words',
          /does NOT confirm the copy you hold/i.test(byHash.data?.message ?? ''),
          `${(byHash.data?.message ?? '').slice(0, 56)}...`);
        check('...and returns the real total, to compare against the paper',
          typeof byHash.data?.content?.totalMinor === 'number' &&
            byHash.data.content.totalMinor > 0 &&
            Boolean(byHash.data.content.issuedOn),
          `${byHash.data?.content?.totalMinor} ${byHash.data?.content?.currency} on ${byHash.data?.content?.issuedOn}`);

        /*
          The figures must NOT come back for a document NUMBER. Numbers
          are sequential, so content against one would let anybody walk a
          business's turnover one request at a time.
        */
        const byNumber = await verifyRetrying(invoice.number);
        check('but a NUMBER lookup discloses no figures',
          byNumber.data?.found === true && byNumber.data?.content === undefined,
          `content ${JSON.stringify(byNumber.data?.content)}`);

        // Only an uploaded file earns the unqualified pass.
        const notIt = await call('POST', `/v1/documents/verify/${invoice.contentHash}`, {
          body: { file: Buffer.from('not a facture').toString('base64') },
        });
        check('a file that is not the document is file_altered, never a pass',
          notIt.data?.verdict === 'file_altered' && notIt.data?.matchesSuppliedFile === false,
          `verdict ${notIt.data?.verdict}`);
      }

      const download = await call('GET', `/v1/documents/${invoice.id}/download`, {
        token: client.token,
      });
      check('a signed download URL is issued', Boolean(download.data?.url),
        `status ${download.status}`);

      const keys = await call('GET', '/v1/documents/keys');
      check('public signing keys are published', (keys.data?.keys ?? []).length > 0,
        `${keys.data?.keys?.length} key(s)`);
    }
  }

  section('reviews & the rating they produce');
  if (supplierId) {
    // The public read needs no token at all: a rating nobody can read is
    // not a rating.
    const publicBefore = await call('GET', `/v1/suppliers/${supplierId}/reviews`);
    check('reviews are readable without a token', publicBefore.status === 200,
      `status ${publicBefore.status}`);
    check('an unrated business reports null, not zero',
      publicBefore.data?.summary?.rating === null,
      JSON.stringify(publicBefore.data?.summary));

    /*
      THE GATE. An outsider has never bought anything from this business, so
      they may not review it — which is the only defence against a review box
      full of competitors that survives contact with a real market.
    */
    const outsider = await makeUser('reviewer-outsider');
    const uninvited = await call('POST', `/v1/suppliers/${supplierId}/reviews`, {
      token: outsider.token,
      body: { rating: 1, body: 'never bought anything here' },
    });
    check('a stranger cannot review a business', uninvited.status === 422,
      `status ${uninvited.status} ${uninvited.data?.error?.code}`);
    check('…and is told why', uninvited.data?.error?.code === 'NO_COMPLETED_DEALING',
      String(uninvited.data?.error?.code));

    const theirs = await call('GET', `/v1/suppliers/${supplierId}/reviews/me`, {
      token: outsider.token,
    });
    check('the app can ask before it offers the button', theirs.data?.mayReview === false,
      String(theirs.data?.mayReview));

    /*
      The client completed an order with this supplier earlier in this run.
      Eligibility travels orders -> outbox -> relay -> bus -> suppliers, so
      it is not true the instant the order completes.
    */
    const eligible = await eventually('the completed order grants the right to review', async () => {
      const res = await call('GET', `/v1/suppliers/${supplierId}/reviews/me`, {
        token: client.token,
      });
      return res.data?.mayReview === true ? res.data : null;
    });
    if (eligible) {
      ok('the completed order grants the right to review');

      const halfStar = await call('POST', `/v1/suppliers/${supplierId}/reviews`, {
        token: client.token,
        body: { rating: 4.5 },
      });
      check('half stars are refused', halfStar.status === 400, `status ${halfStar.status}`);

      const written = await call('POST', `/v1/suppliers/${supplierId}/reviews`, {
        token: client.token,
        body: { rating: 4, body: 'Piece trouvee en une heure.' },
      });
      const reviewId = written.data?.id;
      check('review written', written.status === 201 && Boolean(reviewId),
        `status ${written.status} ${JSON.stringify(written.data).slice(0, 120)}`);
      check('it carries the dealing it was earned by',
        written.data?.source === 'order', String(written.data?.source));

      const again = await call('POST', `/v1/suppliers/${supplierId}/reviews`, {
        token: client.token,
        body: { rating: 1 },
      });
      check('one live review per person per business', again.status === 422,
        `status ${again.status} ${again.data?.error?.code}`);

      /*
        The average moves in the SAME TRANSACTION as the review, so this is
        not an eventually() — if it has not moved by the time the POST
        returns, it is broken, not slow.
      */
      const rated = await call('GET', '/v1/supplier/profile', { token: seller.token });
      check('the rating moved with the review', rated.data?.rating === 4,
        `rating ${rated.data?.rating} over ${rated.data?.ratingCount}`);
      check('the count moved too', rated.data?.ratingCount === 1,
        String(rated.data?.ratingCount));

      if (reviewId) {
        const edited = await call('PATCH', `/v1/reviews/${reviewId}`, {
          token: client.token,
          body: { rating: 5 },
        });
        check('a review can be edited', edited.data?.rating === 5, `status ${edited.status}`);

        const reRated = await call('GET', '/v1/supplier/profile', { token: seller.token });
        check('the average follows the edit by exactly the difference',
          reRated.data?.rating === 5 && reRated.data?.ratingCount === 1,
          `rating ${reRated.data?.rating} over ${reRated.data?.ratingCount}`);

        const foreignEdit = await call('PATCH', `/v1/reviews/${reviewId}`, {
          token: outsider.token,
          body: { rating: 1 },
        });
        check('only the author may edit their review', foreignEdit.status >= 400,
          `status ${foreignEdit.status}`);

        const strangerReply = await call('PUT', `/v1/reviews/${reviewId}/reply`, {
          token: outsider.token,
          body: { body: 'speaking for a shop I do not own' },
        });
        check('only the reviewed business may answer', strangerReply.status >= 400,
          `status ${strangerReply.status}`);

        const replied = await call('PUT', `/v1/reviews/${reviewId}/reply`, {
          token: seller.token,
          body: { body: 'Merci, a bientot.' },
        });
        check('the business answered', replied.data?.reply?.body === 'Merci, a bientot.',
          `status ${replied.status}`);

        const replacedReply = await call('PUT', `/v1/reviews/${reviewId}/reply`, {
          token: seller.token,
          body: { body: 'Merci beaucoup.' },
        });
        check('a second answer REPLACES the first rather than threading',
          replacedReply.data?.reply?.body === 'Merci beaucoup.',
          String(replacedReply.data?.reply?.body));

        const listed = await call('GET', `/v1/suppliers/${supplierId}/reviews`);
        check('the public page shows the review and the reply',
          (listed.data?.items ?? []).some((r) => r.id === reviewId && r.reply),
          `${listed.data?.items?.length} items`);
        check('the summary is the business average, not this page',
          listed.data?.summary?.rating === 5 && listed.data?.summary?.ratingCount === 1,
          JSON.stringify(listed.data?.summary));

        /*
          The directory is a READ MODEL in another schema, fed by
          suppliers.SupplierUpdated. The rating on the supplier row moved
          synchronously; this is the other half — that the thing a customer
          actually browses hears about it.
        */
        const indexed = await eventually('the directory hears about the new rating', async () => {
          const res = await call('GET', `/v1/discovery/directory?q=Smoke%20Parts&limit=50`);
          const row = (res.data?.items ?? []).find((r) => r.supplierId === supplierId);
          return row && row.rating === 5 ? row : null;
        });
        if (indexed) {
          ok('the directory hears about the new rating',
            `rating ${indexed.rating} over ${indexed.ratingCount}`);
          check('…and carries the review count beside it', indexed.ratingCount === 1,
            String(indexed.ratingCount));
          check('…and the badge, unset', indexed.isVerified === false,
            String(indexed.isVerified));
        }

        const noTakedown = await call('POST', `/v1/reviews/${reviewId}/takedown`, {
          token: client.token,
          body: { reason: 'because I say so' },
        });
        check('a takedown needs platform.admin', noTakedown.status === 403,
          `status ${noTakedown.status}`);

        const retracted = await call('DELETE', `/v1/reviews/${reviewId}`, { token: client.token });
        check('a review can be retracted', retracted.data?.status === 'removed',
          `status ${retracted.status}`);

        const unrated = await call('GET', '/v1/supplier/profile', { token: seller.token });
        check('retracting returns the business to never-rated, not to zero',
          unrated.data?.rating === null && unrated.data?.ratingCount === 0,
          `rating ${unrated.data?.rating} over ${unrated.data?.ratingCount}`);

        // Retracting frees the slot — the point when a shop has put
        // something right.
        const rewritten = await call('POST', `/v1/suppliers/${supplierId}/reviews`, {
          token: client.token,
          body: { rating: 5, body: 'Probleme regle, merci.' },
        });
        check('retracting frees you to write a new one', rewritten.status === 201,
          `status ${rewritten.status}`);
      }
    }
  }

  section('messaging');
  const convo = await call('POST', '/v1/conversations', {
    token: client.token,
    body: { withAccountId: seller.accountId, subject: `Smoke ${STAMP}` },
  });
  check('conversation started', convo.status < 400, `status ${convo.status}`);
  const convoId = convo.data?.id;

  if (convoId) {
    const again = await call('POST', '/v1/conversations', {
      token: client.token,
      body: { withAccountId: seller.accountId, subject: `Smoke ${STAMP}` },
    });
    check('starting it twice is idempotent', again.data?.id === convoId,
      `${again.data?.id} vs ${convoId}`);

    const text = await call('POST', `/v1/conversations/${convoId}/messages`, {
      token: client.token,
      body: { kind: 'text', body: 'Bonjour — message de test' },
    });
    check('text message sent', text.status < 400, `status ${text.status}`);

    const upload = await call('POST', '/v1/media/uploads', {
      token: client.token,
      body: { bucket: 'message-attachments', filename: 'smoke.jpg', contentType: 'image/jpeg' },
    });
    check('attachment upload URL issued',
      Boolean(upload.data?.uploadUrl) && Boolean(upload.data?.path),
      `status ${upload.status}`);

    if (upload.data?.path) {
      const photo = await call('POST', `/v1/conversations/${convoId}/messages`, {
        token: client.token,
        body: {
          kind: 'photo',
          attachmentBucket: 'message-attachments',
          attachmentPath: upload.data.path,
        },
      });
      check('photo message sent', photo.status < 400, `status ${photo.status}`);

      const voice = await call('POST', `/v1/conversations/${convoId}/messages`, {
        token: client.token,
        body: {
          kind: 'voice',
          attachmentBucket: 'message-attachments',
          attachmentPath: upload.data.path,
          durationMs: 4200,
        },
      });
      check('voice note sent', voice.status < 400, `status ${voice.status}`);
    }

    const empty = await call('POST', `/v1/conversations/${convoId}/messages`, {
      token: client.token,
      body: { kind: 'text' },
    });
    check('a message with no content is refused', empty.status >= 400, `status ${empty.status}`);

    const page = await call('GET', `/v1/conversations/${convoId}/messages?limit=2`, {
      token: client.token,
    });
    check('messages paginate', Array.isArray(page.data?.items), `${page.data?.items?.length} items`);

    const read = await call('POST', `/v1/conversations/${convoId}/read`, { token: client.token });
    check('marked read', read.status < 400, `status ${read.status}`);

    const list = await call('GET', '/v1/conversations', { token: client.token });
    check('conversation appears in the list',
      (list.data?.items ?? []).some((c) => c.id === convoId), `status ${list.status}`);

    const outsider = await makeUser('outsider');
    const peek = await call('GET', `/v1/conversations/${convoId}`, { token: outsider.token });
    check('an outsider gets 404, not 403', peek.status === 404, `status ${peek.status}`);
  }

  /*
    IMAGES. The one thing this suite could not see before: uploads worked,
    rows were written, and nothing in the product could display a picture,
    because every bucket is private and no endpoint turned a stored
    (bucket, path) into a URL. Each check below ends at the bytes.
  */
  section('images actually load');
  let postPhoto = null;
  let carPhoto = null;
  {
    const up = await uploadPixel(client, 'post-media', 'feed.png');
    check('a photo uploads to the private post bucket', up.ok, up.detail);
    postPhoto = up.ref ?? null;

    const car = await uploadPixel(client, 'vehicle-photos', 'car.png');
    check('and one to the car bucket', car.ok, car.detail);
    carPhoto = car.ref ?? null;

    if (postPhoto) {
      const signed = await call('POST', '/v1/media/downloads', {
        token: client.token,
        body: { items: [postPhoto] },
      });
      const url = signed.data?.items?.[0]?.url;
      check('the API hands back a URL for it', Boolean(url),
        `status ${signed.status} ${JSON.stringify(signed.data).slice(0, 100)}`);

      if (url) {
        /*
          No Authorization header on purpose. A signed storage URL has to
          work from a bare <img src>, or the phone cannot render it.
        */
        const img = await fetchAsImage(url);
        check('and the URL serves the IMAGE, with no auth header',
          img.status === 200 && img.type === 'image/png' && img.bytes === PIXEL_PNG.length,
          `HTTP ${img.status} ${img.type} ${img.bytes}B`);
      }

      const missing = await call('POST', '/v1/media/downloads', {
        token: client.token,
        body: { items: [{ bucket: 'post-media', path: `${client.accountId}/nope.png` }] },
      });
      check('a path with no object is a null url, not an error',
        missing.status === 201 || missing.status === 200,
        `status ${missing.status}`);

      const forbidden = await call('POST', '/v1/media/downloads', {
        token: client.token,
        body: { items: [{ bucket: 'documents', path: 'anything.pdf' }] },
      });
      check('but a facture cannot be signed through the media endpoint',
        forbidden.status === 400, `status ${forbidden.status}`);

      const notMine = await call('POST', '/v1/media/downloads', {
        token: client.token,
        body: { items: [{ bucket: 'driver-documents', path: 'somebody-else/licence.jpg' }] },
      });
      check('nor somebody else identity document', notMine.status === 400,
        `status ${notMine.status}`);
    }
  }

  section('social feed');
  const post = await call('POST', '/v1/posts', {
    token: client.token,
    body: {
      body: `Post de test ${STAMP}`,
      ...(postPhoto ? { media: [{ kind: 'photo', ...postPhoto }] } : {}),
    },
  });
  check('post published', post.status < 400, `status ${post.status} ${JSON.stringify(post.data).slice(0, 120)}`);
  const postId = post.data?.id;

  const emptyPost = await call('POST', '/v1/posts', { token: client.token, body: {} });
  check('an empty post is refused', emptyPost.status >= 400, `status ${emptyPost.status}`);

  if (postId) {
    const liked = await call('POST', `/v1/posts/${postId}/like`, { token: client.token });
    check('post liked', liked.data?.likeCount === 1 && liked.data?.likedByMe === true,
      `count ${liked.data?.likeCount} likedByMe ${liked.data?.likedByMe}`);

    const twice = await call('POST', `/v1/posts/${postId}/like`, { token: client.token });
    check('liking twice stays at one', twice.data?.likeCount === 1, `count ${twice.data?.likeCount}`);

    const unliked = await call('DELETE', `/v1/posts/${postId}/like`, { token: client.token });
    check('unliked', unliked.data?.likeCount === 0 && unliked.data?.likedByMe === false,
      `count ${unliked.data?.likeCount}`);

    const comment = await call('POST', `/v1/posts/${postId}/comments`, {
      token: client.token,
      body: { body: 'Commentaire de test' },
    });
    check('comment added', comment.status === 201, `status ${comment.status}`);

    const comments = await call('GET', `/v1/posts/${postId}/comments`, { token: client.token });
    check('comment reads back', (comments.data?.items ?? []).length === 1,
      `${comments.data?.items?.length} items`);

    const detail = await call('GET', `/v1/posts/${postId}`, { token: client.token });
    check('comment count kept in step', detail.data?.commentCount === 1,
      `count ${detail.data?.commentCount}`);

    const feed = await call('GET', '/v1/feed?limit=5', { token: client.token });
    check('post appears in the feed',
      (feed.data?.items ?? []).some((p) => p.id === postId), `status ${feed.status}`);

    if (postPhoto) {
      /*
        The blog bug, end to end: the feed used to return (bucket, path)
        into a private bucket and nothing else, so the card had no image
        to draw. The URL has to come back ON THE FEED — making the client
        fetch one per photo would be a round trip per picture on screen.
      */
      const mine = (feed.data?.items ?? []).find((p) => p.id === postId);
      const shot = mine?.media?.[0];
      check('the feed carries a URL for the photo, not just a path',
        Boolean(shot?.url) && Boolean(shot?.urlExpiresAt),
        `url ${String(shot?.url).slice(0, 48)}…`);
      if (shot?.url) {
        const img = await fetchAsImage(shot.url);
        check('and that URL renders the photo on the card',
          img.status === 200 && img.type === 'image/png',
          `HTTP ${img.status} ${img.type} ${img.bytes}B`);
      }
    }

    const forged = await call('POST', '/v1/posts', {
      token: client.token,
      body: { body: 'forged', asSupplierId: supplierId ?? STAMP.toString() },
    });
    check('posting as a business you do not own is refused', forged.status === 403,
      `status ${forged.status}`);

    const stolen = await call('POST', '/v1/posts', {
      token: client.token,
      body: {
        body: 'stolen upload',
        media: [{ kind: 'photo', bucket: 'post-media', path: 'somebody-else/1.jpg' }],
      },
    });
    check('an upload path outside your namespace is refused', stolen.status === 403,
      `status ${stolen.status}`);

    check('a post without a kind is an announcement', post.data?.kind === 'announcement',
      String(post.data?.kind));

    const promo = await call('POST', '/v1/posts', {
      token: client.token,
      body: { body: `Promo ${STAMP}`, kind: 'promotion' },
    });
    check('a post can declare its kind', promo.data?.kind === 'promotion', `status ${promo.status}`);

    const filtered = await call('GET', '/v1/feed?limit=20&kind=promotion', { token: client.token });
    check('the feed filters by kind',
      (filtered.data?.items ?? []).every((p) => p.kind === 'promotion'),
      `${filtered.data?.items?.length} items`);

    const shared = await call('POST', `/v1/posts/${postId}/share`, {
      token: client.token,
      body: { channel: 'whatsapp' },
    });
    check('post shared', shared.data?.shareCount === 1, `count ${shared.data?.shareCount}`);

    const sharedTwice = await call('POST', `/v1/posts/${postId}/share`, { token: client.token });
    check('sharing twice stays at one', sharedTwice.data?.shareCount === 1,
      `count ${sharedTwice.data?.shareCount}`);

    const pinned = await call('PUT', `/v1/posts/${postId}/pin`, { token: client.token });
    check('post pinned', Boolean(pinned.data?.pinnedAt), `status ${pinned.status}`);

    const promoId = promo.data?.id;
    if (promoId) {
      const movedPin = await call('PUT', `/v1/posts/${promoId}/pin`, { token: client.token });
      check('pinning another releases the first', Boolean(movedPin.data?.pinnedAt),
        `status ${movedPin.status}`);
      const wasPinned = await call('GET', `/v1/posts/${postId}`, { token: client.token });
      check('one pin per person, enforced not merely intended',
        wasPinned.data?.pinnedAt === null, String(wasPinned.data?.pinnedAt));

      const timeline = await call(
        'GET',
        `/v1/feed?limit=5&author=${client.accountId}&pinnedFirst=true`,
        { token: client.token },
      );
      check('pinnedFirst puts the pin at the front of a timeline',
        timeline.data?.items?.[0]?.id === promoId,
        `first ${timeline.data?.items?.[0]?.id}`);

      const unpinned = await call('DELETE', `/v1/posts/${promoId}/pin`, { token: client.token });
      check('unpinned', unpinned.data?.pinnedAt === null, String(unpinned.data?.pinnedAt));
    }

    const theirPin = await call('PUT', `/v1/posts/${postId}/pin`, { token: seller.token });
    check('only the author may pin their post', theirPin.status >= 400, `status ${theirPin.status}`);

    const outsider2 = await makeUser('outsider2');
    const theirDelete = await call('DELETE', `/v1/posts/${postId}`, { token: outsider2.token });
    check('only the author may retract', theirDelete.status >= 400, `status ${theirDelete.status}`);
  }

  section('selling a car: richer listing + bidding on a range');
  const bidder = await makeUser('bidder');
  const bidder2 = await makeUser('bidder2');

  const listed = await call('POST', '/v1/marketplace/listings', {
    token: client.token,
    body: {
      title: `Renault Clio IV ${STAMP}`,
      ...(carPhoto ? { photos: [carPhoto] } : {}),
      brand: 'Renault',
      model: 'Clio IV',
      year: 2018,
      mileageKm: 84000,
      amount: { amountMinor: 185_000_00, currency: 'DZD' },
      city: 'Alger',
      country: 'DZ',
      fuelType: 'diesel',
      transmission: 'manual',
      bodyType: 'citadine',
      colour: 'Gris',
      doors: 5,
      engineHp: 90,
      condition: 'used',
      isCustomsCleared: true,
      papersInOrder: true,
      ownerCount: 2,
      accidentFree: true,
    },
  });
  const listingId = listed.data?.id;
  check('listing published with the full spec',
    listed.status < 400 && listed.data?.fuelType === 'diesel' && listed.data?.isCustomsCleared === true,
    `${listed.status} fuel=${listed.data?.fuelType} customs=${listed.data?.isCustomsCleared}`);
  check('a listing starts closed to offers', listed.data?.acceptsOffers === false,
    `acceptsOffers ${listed.data?.acceptsOffers}`);

  if (carPhoto) {
    /*
      The sell-a-car bug. `photoUrls` demanded an absolute URL and the app
      had none to give, so photos were uploaded and then dropped on the
      floor — on the dev box, objects in `vehicle-photos` and every single
      listing stored with an empty array. A ref goes in, a URL comes out,
      and the bytes are at the end of it.
    */
    check('the car photo is stored as a ref, not thrown away',
      (listed.data?.photos ?? []).length === 1,
      `photos ${JSON.stringify(listed.data?.photos ?? [])}`);
    check('and comes back in photoUrls as a URL',
      (listed.data?.photoUrls ?? []).length === 1 &&
        String(listed.data.photoUrls[0]).startsWith('http'),
      `${String(listed.data?.photoUrls?.[0]).slice(0, 48)}…`);
    if (listed.data?.photoUrls?.[0]) {
      const img = await fetchAsImage(listed.data.photoUrls[0]);
      check('which serves the picture of the car',
        img.status === 200 && img.type === 'image/png',
        `HTTP ${img.status} ${img.type} ${img.bytes}B`);
    }

    // The public view of the same car — the one a buyer scrolling sees.
    const publicView = await call('GET', `/v1/marketplace/listings/${listingId}`);
    check('a buyer who is not signed in sees the photo too',
      (publicView.data?.photoUrls ?? []).length === 1,
      `status ${publicView.status} photos ${(publicView.data?.photoUrls ?? []).length}`);

    const foreign = await call('POST', '/v1/marketplace/listings', {
      token: seller.token,
      body: { title: 'Pas ma voiture', photos: [carPhoto] },
    });
    check('and a photo uploaded by somebody else is refused',
      foreign.status === 403, `status ${foreign.status}`);
  }

  if (listingId) {
    const tooSoon = await call('POST', `/v1/marketplace/listings/${listingId}/bids`, {
      token: bidder.token,
      body: { amount: { amountMinor: 100_000_00, currency: 'DZD' } },
    });
    check('a listing with no range refuses offers',
      tooSoon.status === 422 && tooSoon.data?.error?.code === 'OFFERS_NOT_ACCEPTED',
      `${tooSoon.status} ${tooSoon.data?.error?.code}`);

    // 1 700 000 .. 1 850 000 DZD, in minor units.
    const FLOOR = 170_000_00;
    const CEILING = 185_000_00;
    const ranged = await call('PUT', `/v1/marketplace/listings/${listingId}/offer-range`, {
      token: client.token,
      body: { minMinor: FLOOR, maxMinor: CEILING },
    });
    check('the seller can set an acceptance range',
      ranged.status < 400 && ranged.data?.offerRange?.min?.amountMinor === FLOOR,
      `${ranged.status} min=${ranged.data?.offerRange?.min?.amountMinor}`);
    check('the currency is inherited from the asking price',
      ranged.data?.offerRange?.min?.currency === 'DZD',
      `${ranged.data?.offerRange?.min?.currency}`);

    const upsideDown = await call('PUT', `/v1/marketplace/listings/${listingId}/offer-range`, {
      token: client.token,
      body: { minMinor: CEILING, maxMinor: FLOOR },
    });
    check('a ceiling below the floor is refused', upsideDown.status >= 400,
      `status ${upsideDown.status}`);

    /*
      THE SECURITY PROPERTY OF THE WHOLE FEATURE. If a buyer can read the
      floor they bid exactly the floor, and every offer above it that the
      seller would have received is lost. Checked anonymously AND as a
      logged-in buyer, because those are two different code paths.
    */
    const publicView = await call('GET', `/v1/marketplace/listings/${listingId}`);
    check('the range does NOT leak on an anonymous read',
      publicView.data?.offerRange === undefined && publicView.data?.pendingBidCount === undefined,
      `offerRange ${JSON.stringify(publicView.data?.offerRange)}`);
    check('but the public view does say offers are open',
      publicView.data?.acceptsOffers === true, `acceptsOffers ${publicView.data?.acceptsOffers}`);

    const buyerView = await call('GET', `/v1/marketplace/listings/${listingId}`, {
      token: bidder.token,
    });
    check('nor to a logged-in buyer', buyerView.data?.offerRange === undefined,
      `offerRange ${JSON.stringify(buyerView.data?.offerRange)}`);

    const stranger = await call('GET', `/v1/marketplace/listings/${listingId}/private`, {
      token: bidder.token,
    });
    check('the owner view is 404 to anyone else', stranger.status === 404,
      `status ${stranger.status}`);

    const ownBid = await call('POST', `/v1/marketplace/listings/${listingId}/bids`, {
      token: client.token,
      body: { amount: { amountMinor: FLOOR, currency: 'DZD' } },
    });
    check('a seller cannot bid on their own listing',
      ownBid.data?.error?.code === 'CANNOT_BID_ON_OWN_LISTING', `${ownBid.status}`);

    const wrongCurrency = await call('POST', `/v1/marketplace/listings/${listingId}/bids`, {
      token: bidder.token,
      body: { amount: { amountMinor: FLOOR, currency: 'EUR' } },
    });
    check('a mismatched currency is refused',
      wrongCurrency.data?.error?.code === 'CURRENCY_MISMATCH', `${wrongCurrency.status}`);

    const before = await call('GET', '/v1/notifications?limit=100', { token: client.token });
    const bidNotesBefore = (before.data?.items ?? []).filter((n) => n.type === 'listing.bid').length;

    // ── a lowball: recorded, and the seller is NOT interrupted ──────────
    const lowball = await call('POST', `/v1/marketplace/listings/${listingId}/bids`, {
      token: bidder.token,
      body: { amount: { amountMinor: 90_000_00, currency: 'DZD' }, message: 'cash tout de suite' },
    });
    check('a lowball is accepted and recorded', lowball.status === 201, `status ${lowball.status}`);
    check('and the buyer is not told where it landed',
      lowball.data?.standing === undefined, `standing ${lowball.data?.standing}`);

    const sellerSees = await call('GET', `/v1/marketplace/listings/${listingId}/bids`, {
      token: client.token,
    });
    const low = (sellerSees.data?.items ?? [])[0];
    check('the seller can see it, with its standing', low?.standing === 'below_range',
      `standing ${low?.standing}`);

    /*
      Give the relay a fair chance to deliver a notification that should NOT
      exist, rather than declaring success because we looked too early.
    */
    await new Promise((r) => setTimeout(r, 6000));
    const afterLow = await call('GET', '/v1/notifications?limit=100', { token: client.token });
    check('THE SELLER IS NOT NOTIFIED about a bid below the range',
      (afterLow.data?.items ?? []).filter((n) => n.type === 'listing.bid').length === bidNotesBefore,
      `${(afterLow.data?.items ?? []).filter((n) => n.type === 'listing.bid').length} vs ${bidNotesBefore}`);

    // ── in range: the seller hears about it ────────────────────────────
    const inRange = await call('POST', `/v1/marketplace/listings/${listingId}/bids`, {
      token: bidder.token,
      body: { amount: { amountMinor: 175_000_00, currency: 'DZD' } },
    });
    check('raising an offer is accepted', inRange.status === 201, `status ${inRange.status}`);

    const afterRaise = await call('GET', `/v1/marketplace/listings/${listingId}/bids`, {
      token: client.token,
    });
    const live = (afterRaise.data?.items ?? []).filter((b) => b.status === 'pending');
    check('raising supersedes the old offer, so the seller sees one per buyer',
      live.length === 1 && live[0].amount.amountMinor === 175_000_00,
      `${live.length} live, ${live[0]?.amount?.amountMinor}`);
    check('the superseded one is kept in the history',
      (afterRaise.data?.items ?? []).some((b) => b.status === 'superseded'));

    const notified = await eventually('the seller IS notified about a bid in range', async () => {
      const res = await call('GET', '/v1/notifications?limit=100', { token: client.token });
      const notes = (res.data?.items ?? []).filter((n) => n.type === 'listing.bid');
      return notes.length > bidNotesBefore ? notes : null;
    });
    if (notified) ok('the seller IS notified about a bid in range', `${notified.length} notification(s)`);

    // ── above the range: better news, still notified ───────────────────
    const generous = await call('POST', `/v1/marketplace/listings/${listingId}/bids`, {
      token: bidder2.token,
      body: { amount: { amountMinor: 200_000_00, currency: 'DZD' } },
    });
    check('a bid above the range is accepted', generous.status === 201, `status ${generous.status}`);

    const sellerAll = await call('GET', `/v1/marketplace/listings/${listingId}/bids`, {
      token: client.token,
    });
    const top = (sellerAll.data?.items ?? [])[0];
    check('the seller list is highest first', top?.amount?.amountMinor === 200_000_00,
      `top ${top?.amount?.amountMinor}`);
    check('and marks it above the range', top?.standing === 'above_range', `${top?.standing}`);

    const aboveNotified = await eventually(
      'the seller is notified about a bid ABOVE the range too',
      async () => {
        const res = await call('GET', '/v1/notifications?limit=100', { token: client.token });
        const notes = (res.data?.items ?? []).filter((n) => n.type === 'listing.bid');
        return notes.length > bidNotesBefore + 1 ? notes : null;
      },
    );
    if (aboveNotified) ok('the seller is notified about a bid ABOVE the range too');

    // ── a bidder must not see a rival's offer ──────────────────────────
    const rivalView = await call('GET', `/v1/marketplace/listings/${listingId}/bids`, {
      token: bidder.token,
    });
    const mine = rivalView.data?.items ?? [];
    check('a buyer sees only their own offers',
      mine.length > 0 && mine.every((b) => b.buyerAccountId === bidder.accountId),
      `${mine.length} item(s)`);
    check('and never a standing', mine.every((b) => b.standing === undefined));

    // ── accepting one declines the rest ───────────────────────────────
    const winnerId = top?.id;
    const accepted = await call('POST', `/v1/marketplace/bids/${winnerId}/accept`, {
      token: client.token,
    });
    check('the seller can accept an offer', accepted.data?.status === 'accepted',
      `${accepted.status} -> ${accepted.data?.status}`);

    const afterAccept = await call('GET', `/v1/marketplace/listings/${listingId}/bids`, {
      token: client.token,
    });
    const stillPending = (afterAccept.data?.items ?? []).filter((b) => b.status === 'pending');
    check('ONE CAR, ONE BUYER: every other live offer is declined',
      stillPending.length === 0, `${stillPending.length} still pending`);

    const twice = await call('POST', `/v1/marketplace/bids/${winnerId}/accept`, {
      token: client.token,
    });
    check('accepting twice is a 409', twice.status === 409,
      `${twice.status} ${twice.data?.error?.code}`);

    const loserTold = await eventually('the losing bidder is told the car went elsewhere', async () => {
      const res = await call('GET', '/v1/notifications?limit=100', { token: bidder.token });
      return (res.data?.items ?? []).find((n) => n.type === 'listing.bid.declined') ?? null;
    });
    if (loserTold) ok('the losing bidder is told the car went elsewhere');

    const winnerTold = await eventually('the winning bidder is told', async () => {
      const res = await call('GET', '/v1/notifications?limit=100', { token: bidder2.token });
      return (res.data?.items ?? []).find((n) => n.type === 'listing.bid.accepted') ?? null;
    });
    if (winnerTold) ok('the winning bidder is told');

    const filtered = await call('GET', '/v1/marketplace/listings?fuelType=diesel&transmission=manual&minYear=2015');
    check('the new browse filters work',
      (filtered.data?.items ?? []).some((l) => l.id === listingId), `status ${filtered.status}`);
  }

  /*
    BOOKING A WORKSHOP, through to the scan of the confirmation.

    None of this was covered here, which is how two things shipped. The
    supplier-facing calendar handed out `clientAccountId` and a
    `vehicleId` and nothing else, so the app had no customer to show and
    printed "Client - 4ab5bb55" out of the id. And a scanned
    confirmation answered "genuine" without saying what it was FOR, so
    the app could only list the whole calendar and ask the workshop to
    find the booking by hand.
  */
  section('booking a workshop: accept -> confirmation -> scan');
  {
    const whoami = await call('PUT', '/v1/me', {
      token: client.token,
      body: { firstName: 'Riyad', familyName: 'Benali', phone: '+213555112233' },
    });
    check('the customer has a name on file',
      whoami.data?.firstName === 'Riyad' && whoami.data?.familyName === 'Benali',
      `status ${whoami.status}`);

    const car = await call('POST', '/v1/vehicles', {
      token: client.token,
      body: {
        brand: 'Kia',
        model: 'Picanto',
        year: 2010,
        vin: `VF1${String(STAMP).slice(-14)}`,
        plate: `16-${String(STAMP).slice(-5)}-119`,
        mileageKm: 100,
        resolveTecDoc: false,
      },
    });
    check('and a car in the garage', Boolean(car.data?.id), `status ${car.status}`);

    const slotStart = new Date(Date.now() + 86_400_000).toISOString();
    const slotEnd = new Date(Date.now() + 86_400_000 + 3_600_000).toISOString();
    const booked = await call('POST', '/v1/reservations', {
      token: client.token,
      body: { supplierId, serviceTypeKey: 'brake_service', vehicleId: car.data?.id, slotStart, slotEnd },
    });
    const bookingId = booked.data?.id;
    check('the client books a brake service', booked.status < 400 && booked.data?.status === 'pending',
      `status ${booked.status} ${JSON.stringify(booked.data).slice(0, 100)}`);

    const accepted = await call('PATCH', `/v1/supplier/reservations/${bookingId}`, {
      token: seller.token,
      body: { action: 'accept' },
    });
    check('the workshop accepts it', accepted.data?.status === 'accepted', `status ${accepted.status}`);

    /*
      THE CALENDAR. A workshop looking at tomorrow needs to know who is
      coming and in what - not two UUIDs.
    */
    const calendar = await call('GET', '/v1/supplier/reservations?limit=20', { token: seller.token });
    const row = (calendar.data?.items ?? []).find((r) => r.id === bookingId);
    check('the calendar names the customer instead of printing an id',
      row?.customer?.name === 'Riyad Benali',
      `customer ${JSON.stringify(row?.customer)}`);
    check('and gives a number to call them on', row?.customer?.phone === '+213555112233',
      String(row?.customer?.phone));
    check('and says which car is coming in',
      row?.vehicle?.brand === 'Kia' && row?.vehicle?.model === 'Picanto' && row?.vehicle?.mileageKm === 100,
      `vehicle ${JSON.stringify(row?.vehicle)}`);

    const one = await call('GET', `/v1/supplier/reservations/${bookingId}`, { token: seller.token });
    check('one booking can be opened by id', one.status === 200 && one.data?.id === bookingId,
      `status ${one.status}`);

    /*
      Another business must not be able to open it, and must not learn
      that it exists: 404, never 403.
    */
    const nosy = await call('GET', `/v1/supplier/reservations/${bookingId}`, { token: other.token });
    check("another workshop cannot open somebody else's booking", nosy.status === 404,
      `status ${nosy.status}`);

    const malformed = await call('GET', '/v1/supplier/reservations/not-a-uuid', { token: seller.token });
    check('a malformed booking id is a 400, not a 500', malformed.status === 400,
      `status ${malformed.status}`);

    // The confirmation is issued by a reactor: outbox -> relay -> bus.
    const confirmation = await eventually('a confirmation is issued for the booking', async () => {
      const res = await call('GET', '/v1/documents?limit=50', { token: client.token });
      return (res.data?.items ?? []).find(
        (d) => d.type === 'reservation_confirmation' && d.subjectId === bookingId,
      ) ?? null;
    });

    if (confirmation) {
      ok('a confirmation is issued for the booking', `${confirmation.number}`);
      check('it carries a fingerprint to scan', /^[0-9a-f]{64}$/.test(confirmation.contentHash ?? ''),
        String(confirmation.contentHash).slice(0, 16));

      const scanned = await verifyRetrying(confirmation.contentHash);
      check('the scan confirms it is genuine', scanned.data?.found === true && scanned.data?.authentic === true,
        `verdict ${scanned.data?.verdict}`);

      /*
        AND SAYS WHERE TO GO. This is what turns a scan into navigation
        rather than a verdict the workshop then has to act on by hand.
      */
      check('the scan says WHAT the document is about',
        scanned.data?.subject?.type === 'reservation' && scanned.data?.subject?.id === bookingId,
        `subject ${JSON.stringify(scanned.data?.subject)}`);

      /*
        A confirmation has no total, so the comparison the holder is
        asked to make has to be the things printed on it.
      */
      const labels = (scanned.data?.content?.fields ?? []).map((f) => `${f.label}=${f.value}`).join(' | ');
      check('and reads back what the confirmation actually says',
        labels.includes('Client=Riyad Benali') && labels.includes('Prestation='),
        labels.slice(0, 110));

      // The subject is a navigation hint, not an authorisation.
      const anonymous = await fetch(`${API}/v1/supplier/reservations/${scanned.data?.subject?.id}`);
      check('following it without a token gets you nowhere', anonymous.status === 401,
        `HTTP ${anonymous.status}`);

      const landed = await call('GET', `/v1/supplier/reservations/${scanned.data?.subject?.id}`, {
        token: seller.token,
      });
      check('the workshop lands straight on the booking the scan pointed at',
        landed.status === 200 && landed.data?.id === bookingId && landed.data?.customer?.name === 'Riyad Benali',
        `status ${landed.status} customer ${landed.data?.customer?.name}`);

      /*
        Document numbers are sequential (RES-2026-000013, 000014...), so
        a lookup by number must not hand out subject ids - that would
        turn the public route into an index of everything a business has
        booked.
      */
      const byNumber = await verifyRetrying(confirmation.number);
      check('but a NUMBER lookup points at nothing',
        byNumber.data?.found === true && byNumber.data?.subject === undefined,
        `subject ${JSON.stringify(byNumber.data?.subject)}`);
    }

    /*
      AND THEN THE MONEY.

      The service was performed and paid for, and until now the platform
      recorded no amount for it, so no facture could exist. There was
      nothing wrong with the documents pipeline - there was simply
      nothing to build a facture FROM. The supplier now states what they
      charged, and the facture follows.
    */
    const completed = await call('PATCH', `/v1/supplier/reservations/${bookingId}`, {
      token: seller.token,
      body: { action: 'complete' },
    });
    check('the workshop finishes the job', completed.data?.status === 'completed',
      `status ${completed.status} ${completed.data?.status}`);
    check('and it is not priced yet, which is honest rather than zero',
      completed.data?.amountMinor === null && completed.data?.chargedAt === null,
      `amountMinor ${JSON.stringify(completed.data?.amountMinor)}`);

    const priced = await call('PATCH', `/v1/supplier/reservations/${bookingId}`, {
      token: seller.token,
      body: { action: 'charge', amountMinor: 450000, currency: 'DZD' },
    });
    check('the bill is stated after the fact', priced.data?.amountMinor === 450000
      && priced.data?.currency === 'DZD' && Boolean(priced.data?.chargedAt),
      `status ${priced.status} ${JSON.stringify(priced.data?.amountMinor)}`);

    // Retried request: same figure, accepted, nothing new happens.
    const retried = await call('PATCH', `/v1/supplier/reservations/${bookingId}`, {
      token: seller.token,
      body: { action: 'charge', amountMinor: 450000, currency: 'DZD' },
    });
    check('re-sending the same charge is safe', retried.status === 200
      && retried.data?.amountMinor === 450000, `status ${retried.status}`);

    /*
      A DIFFERENT figure is refused. The facture is already sealed and in
      the customer's hands; re-pricing underneath it would leave two
      truths about one supply. Correcting it is a credit note.
    */
    const repriced = await call('PATCH', `/v1/supplier/reservations/${bookingId}`, {
      token: seller.token,
      body: { action: 'charge', amountMinor: 900000, currency: 'DZD' },
    });
    check('but re-pricing it is refused', repriced.status === 409
      && repriced.data?.error?.code === 'ALREADY_CHARGED',
      `status ${repriced.status} ${repriced.data?.error?.code}`);

    const serviceFacture = await eventually('a facture is issued for the service', async () => {
      const res = await call('GET', '/v1/documents?limit=50', { token: client.token });
      return (res.data?.items ?? []).find(
        (d) => d.type === 'invoice' && d.subjectId === bookingId,
      ) ?? null;
    });

    if (serviceFacture) {
      ok('a facture is issued for the service', `${serviceFacture.number}`);
      const scan = await verifyRetrying(serviceFacture.contentHash);
      check('it totals what the workshop charged',
        scan.data?.content?.totalMinor === 450000 && scan.data?.content?.currency === 'DZD',
        `total ${JSON.stringify(scan.data?.content?.totalMinor)}`);
      /*
        buyerName used to be the client's account id, so every facture
        this platform ever issued was addressed to a UUID. On a tax
        document the buyer is one of the parties it attests.
      */
      const says = (scan.data?.content?.fields ?? []).map((f) => `${f.label}=${f.value}`).join(' | ');
      check('and is addressed to a person, not a primary key',
        scan.data?.message?.includes('Riyad Benali') || says.includes('Riyad Benali'),
        `${says.slice(0, 90)} :: ${String(scan.data?.message).slice(0, 90)}`);
    }

    /*
      WHO CAN RETRIEVE IT.

      Both parties, and the second one was missing entirely. The listing
      answers by RECIPIENT, so a facture was visible to the client and
      invisible to the business whose NIF, NIS, RC and article
      d'imposition are printed on it - a business could not read its own
      sales ledger. supplier_id had been written on every row since
      migration 0020 and read by nothing.
    */
    const distinct = (xs) => xs.filter((v, i, all) => all.indexOf(v) === i);

    const clientFactures = await call('GET', '/v1/documents?type=invoice&limit=50', {
      token: client.token,
    });
    const mine = clientFactures.data?.items ?? [];
    check('the client lists its factures, and only factures',
      mine.length > 0 && mine.every((d) => d.type === 'invoice'),
      `${mine.length} items, types ${distinct(mine.map((d) => d.type)).join(',')}`);

    const ledger = await call('GET', '/v1/supplier/documents?type=invoice&limit=50', {
      token: seller.token,
    });
    const issued = ledger.data?.items ?? [];
    check('and the business lists what it ISSUED',
      ledger.status === 200 && issued.some((d) => d.subjectId === bookingId),
      `status ${ledger.status} ${issued.length} items`);
    check('its ledger is factures only when asked for factures',
      issued.every((d) => d.type === 'invoice'),
      distinct(issued.map((d) => d.type)).join(','));

    // Scoped to the token's own business - there is no id to tamper with.
    const otherLedger = await call('GET', '/v1/supplier/documents?limit=50', {
      token: other.token,
    });
    check("another business sees none of this business's documents",
      !(otherLedger.data?.items ?? []).some((d) => d.subjectId === bookingId),
      `${(otherLedger.data?.items ?? []).length} items`);

    const junk = await call('GET', '/v1/documents?type=not-a-type', { token: client.token });
    check('an unknown type is a 400, not silently ignored', junk.status === 400,
      `status ${junk.status}`);

    /*
      THE PDF. Both parties get a short-lived signed URL; anybody else
      gets 404, not 403 - a document id should not be confirmable by
      someone with no claim to it.
    */
    if (serviceFacture) {
      const byClient = await call('GET', `/v1/documents/${serviceFacture.id}/download`, {
        token: client.token,
      });
      check('the client can download the PDF',
        byClient.status === 200 && String(byClient.data?.url).startsWith('http'),
        `status ${byClient.status}`);

      const byIssuer = await call('GET', `/v1/documents/${serviceFacture.id}/download`, {
        token: seller.token,
      });
      check('so can the business that issued it',
        byIssuer.status === 200 && String(byIssuer.data?.url).startsWith('http'),
        `status ${byIssuer.status}`);

      const byStranger = await call('GET', `/v1/documents/${serviceFacture.id}/download`, {
        token: other.token,
      });
      check('a third party gets 404, not 403', byStranger.status === 404,
        `status ${byStranger.status}`);

      // A signed URL that 404s is the failure this would otherwise hide.
      const pdf = await fetch(String(byClient.data?.url));
      const bytes = Buffer.from(await pdf.arrayBuffer());
      check('and the URL really serves the sealed PDF',
        pdf.status === 200 && bytes.subarray(0, 5).toString('latin1') === '%PDF-',
        `HTTP ${pdf.status}, ${bytes.length} bytes, starts ${JSON.stringify(bytes.subarray(0, 5).toString('latin1'))}`);
    }

    /*
      A job done for nothing is a real outcome - goodwill, warranty, a
      repair that turned out not to be needed. It is recorded, and it
      must NOT burn a number out of a gapless fiscal series.
    */
    const freebie = await call('POST', '/v1/reservations', {
      token: client.token,
      body: {
        supplierId,
        serviceTypeKey: 'brake_service',
        vehicleId: car.data?.id,
        slotStart: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        slotEnd: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString(),
      },
    });
    await call('PATCH', `/v1/supplier/reservations/${freebie.data?.id}`, {
      token: seller.token, body: { action: 'accept' },
    });
    const gratis = await call('PATCH', `/v1/supplier/reservations/${freebie.data?.id}`, {
      token: seller.token,
      body: { action: 'complete', amountMinor: 0, currency: 'DZD' },
    });
    check('a job done for nothing is recorded as such', gratis.data?.amountMinor === 0,
      `status ${gratis.status} ${JSON.stringify(gratis.data?.amountMinor)}`);

    const noFacture = await call('GET', '/v1/documents?limit=50', { token: client.token });
    check('and issues no facture for 0,00',
      !(noFacture.data?.items ?? []).some(
        (d) => d.type === 'invoice' && d.subjectId === freebie.data?.id,
      ),
      'no invoice for the free job');

    // Charging a booking that is not finished is a conflict, not a 500.
    const early = await call('PATCH', `/v1/supplier/reservations/${bookingId}`, {
      token: seller.token,
      body: { action: 'charge' },
    });
    check('a charge with no amount is rejected at the edge', early.status === 400,
      `status ${early.status}`);
  }

  /*
    THE OTHER PAID INTERACTION. A tow is a supply a business makes and
    gets paid for, and it recorded no money either.
  */
  section('a roadside call-out, charged');
  {
    const called = await call('POST', '/v1/assistance', {
      token: client.token,
      body: { serviceType: 'tow', lat: 36.7538, lng: 3.0588, pickupAddress: 'Rue Hassiba, Alger' },
    });
    const jobId = called.data?.id;
    check('the client calls for a tow', called.status === 201 && called.data?.status === 'requested',
      `status ${called.status}`);

    const claimed = await call('PATCH', `/v1/supplier/assistance/${jobId}`, {
      token: seller.token, body: { action: 'accept' },
    });
    check('the supplier claims it', claimed.data?.status === 'dispatched', `status ${claimed.status}`);

    await call('PATCH', `/v1/supplier/assistance/${jobId}`, {
      token: seller.token, body: { action: 'en_route' },
    });

    /*
      Priced in the SAME call as the completion here, which is the other
      of the two routes - the price of a tow depends on the distance
      actually driven, so it is known exactly when the job closes.
    */
    const done = await call('PATCH', `/v1/supplier/assistance/${jobId}`, {
      token: seller.token,
      body: { action: 'complete', amountMinor: 800000, currency: 'DZD' },
    });
    check('and finishes it with the bill attached',
      done.data?.status === 'completed' && done.data?.amountMinor === 800000,
      `status ${done.status} ${JSON.stringify(done.data?.amountMinor)}`);

    const towFacture = await eventually('a facture is issued for the tow', async () => {
      const res = await call('GET', '/v1/documents?limit=50', { token: client.token });
      return (res.data?.items ?? []).find((d) => d.type === 'invoice' && d.subjectId === jobId) ?? null;
    });

    if (towFacture) {
      ok('a facture is issued for the tow', `${towFacture.number}`);
      const scan = await verifyRetrying(towFacture.contentHash);
      check('for the amount charged', scan.data?.content?.totalMinor === 800000,
        `total ${JSON.stringify(scan.data?.content?.totalMinor)}`);
      check('and it scans as genuine', scan.data?.authentic === true, `verdict ${scan.data?.verdict}`);
    }

    /*
      One facture per supply. The unique index is the real defence, and
      it is what makes a redelivered event harmless.
    */
    const again = await call('PATCH', `/v1/supplier/assistance/${jobId}`, {
      token: seller.token,
      body: { action: 'charge', amountMinor: 800000, currency: 'DZD' },
    });
    check('re-charging the same amount changes nothing', again.status === 200,
      `status ${again.status}`);

    const all = await call('GET', '/v1/documents?limit=100', { token: client.token });
    const forJob = (all.data?.items ?? []).filter((d) => d.type === 'invoice' && d.subjectId === jobId);
    check('and there is exactly ONE facture for the job', forJob.length === 1,
      `${forJob.length} factures`);
  }

  /*
    THE 30-DAY MILEAGE RULE.

    The client app enforces "update your mileage every 30 days or
    notifications are locked" and had to fake the date half of it, by
    writing a JG-MILEAGE:<km> maintenance task after every confirmed
    update and reading the newest one back. Any client calling the API
    directly skipped the record entirely, so the rule was a screen and
    not a rule.
  */
  section('mileage: monotonic, dated, and enforced');
  {
    const car = await call('POST', '/v1/vehicles', {
      token: client.token,
      body: { brand: 'Dacia', model: 'Logan', year: 2016, mileageKm: 120000, resolveTecDoc: false },
    });
    const carId = car.data?.id;
    check('a new car starts its 30-day period now', Boolean(car.data?.mileageUpdatedAt)
      && car.data?.mileageUpdateRequired === false,
      `updatedAt ${car.data?.mileageUpdatedAt} required ${car.data?.mileageUpdateRequired}`);

    const up = await call('PATCH', `/v1/vehicles/${carId}/mileage`, {
      token: client.token, body: { mileageKm: 121500 },
    });
    check('a higher reading is accepted', up.data?.mileageKm === 121500, `status ${up.status}`);

    // The app retries with the same value when a confirmation was interrupted.
    const same = await call('PATCH', `/v1/vehicles/${carId}/mileage`, {
      token: client.token, body: { mileageKm: 121500 },
    });
    check('the same reading again is accepted, because the app retries',
      same.status === 200 && same.data?.mileageKm === 121500, `status ${same.status}`);

    const down = await call('PATCH', `/v1/vehicles/${carId}/mileage`, {
      token: client.token, body: { mileageKm: 90000 },
    });
    check('a LOWER reading is refused with the code the app looks for',
      down.status === 422 && down.data?.error?.code === 'MILEAGE_LOWER',
      `status ${down.status} ${down.data?.error?.code}`);

    const after = await call('GET', `/v1/vehicles/${carId}`, { token: client.token });
    check('and the refusal changed nothing at all', after.data?.mileageKm === 121500
      && after.data?.mileageUpdatedAt === same.data?.mileageUpdatedAt,
      `km ${after.data?.mileageKm}`);

    const history = await call('GET', `/v1/vehicles/${carId}/mileage-history`, { token: client.token });
    const rows = history.data?.items ?? [];
    check('every accepted reading is on the record', rows.length === 2
      && rows.every((r) => r.source === 'client'),
      `${rows.length} rows: ${rows.map((r) => `${r.previousKm}->${r.newKm}`).join(', ')}`);
    check('and the refused one is not', !rows.some((r) => r.newKm === 90000),
      'no row for the rejected value');

    /*
      Somebody else's odometer history is a record of how much they
      drive and when they stopped. Refused outright, or empty - never
      the rows. (`other` is a supplier-owner, so it is the permission
      that refuses first; the owner check in the query is the second
      line, and that is the one the unit tests pin.)
    */
    const nosy = await call('GET', `/v1/vehicles/${carId}/mileage-history`, { token: other.token });
    check("another account cannot read somebody else's odometer history",
      nosy.status >= 400 || (nosy.data?.items ?? []).length === 0,
      `status ${nosy.status} items ${(nosy.data?.items ?? []).length}`);

    /*
      The lock. Nothing here is overdue yet, so the honest answer is
      "not locked" - and the notification-feeding endpoints answer.
    */
    const access = await call('GET', '/v1/me/notification-access', { token: client.token });
    check('a compliant account is not locked', access.status === 200 && access.data?.locked === false,
      `${JSON.stringify(access.data)}`);
    for (const path of ['/v1/requests?limit=1', '/v1/reservations?limit=1', '/v1/orders?limit=1']) {
      const res = await call('GET', path, { token: client.token });
      check(`${path.split('?')[0]} answers while compliant`, res.status === 200, `status ${res.status}`);
    }

    /*
      An account with NO cars must never be locked. A rule about stale
      readings cannot be applied to somebody who has nothing to read -
      and `other` is a supplier-owner account with an empty garage,
      which is also why the guard never locks a business out of its own
      work queue.
    */
    const carless = await call('GET', '/v1/me/notification-access', { token: other.token });
    check('an account with no cars is never locked', carless.data?.locked === false,
      `${JSON.stringify(carless.data)}`);

    /*
      SUPPORT'S CORRECTION. The owner cannot lower a value, so a typo is
      permanent from their side; the app says "contact JustGo Support".
      A client token must not be able to do it.
    */
    const sneaky = await call('PATCH', `/v1/admin/vehicles/${carId}/mileage`, {
      token: client.token,
      body: { mileageKm: 1000, reason: 'I would like my car to look newer' },
    });
    check('an owner cannot reach the support override', sneaky.status === 403,
      `status ${sneaky.status}`);
  }

  section('reclamations');
  const filed = await call('POST', '/v1/reclamations', {
    token: client.token,
    body: {
      category: 'wrong_part',
      title: `Mauvaise référence ${STAMP}`,
      body: 'La référence livrée ne correspond pas au devis.',
      respondentSupplierId: supplierId,
      ...(orderId ? { subjectType: 'order', subjectId: orderId } : {}),
    },
  });
  check('complaint filed', /^RCL-/.test(filed.data?.reference ?? ''),
    `${filed.status} ${filed.data?.reference ?? JSON.stringify(filed.data).slice(0, 140)}`);
  const caseId = filed.data?.id;

  if (caseId) {
    const mine = await call('GET', '/v1/reclamations', { token: client.token });
    check('it appears in my complaints',
      (mine.data?.items ?? []).some((c) => c.id === caseId), `status ${mine.status}`);

    const theirs = await call('GET', '/v1/reclamations', { token: seller.token });
    check('and in the queue of the business it is against',
      (theirs.data?.items ?? []).some((c) => c.id === caseId), `status ${theirs.status}`);

    const outsider = await makeUser('outsider3');
    const peek = await call('GET', `/v1/reclamations/${caseId}`, { token: outsider.token });
    check('an outsider gets 404, not 403', peek.status === 404, `status ${peek.status}`);

    const reply = await call('POST', `/v1/reclamations/${caseId}/messages`, {
      token: seller.token,
      body: { body: 'Nous renvoyons la bonne pièce.' },
    });
    check('the business can answer', reply.status === 201 && reply.data?.authorRole === 'respondent',
      `status ${reply.status} role ${reply.data?.authorRole}`);

    const sneaky = await call('POST', `/v1/reclamations/${caseId}/messages`, {
      token: client.token,
      body: { body: 'note', internal: true },
    });
    check('only ops may leave an internal note', sneaky.status === 403, `status ${sneaky.status}`);

    const thread = await call('GET', `/v1/reclamations/${caseId}/messages`, {
      token: client.token,
    });
    check('the claimant sees the reply', (thread.data?.items ?? []).length === 1,
      `${thread.data?.items?.length} message(s)`);

    const noReason = await call('PATCH', `/v1/reclamations/${caseId}`, {
      token: seller.token,
      body: { status: 'resolved' },
    });
    check('closing without a resolution is refused', noReason.status >= 400,
      `status ${noReason.status}`);

    const claimantDecides = await call('PATCH', `/v1/reclamations/${caseId}`, {
      token: client.token,
      body: { status: 'resolved', resolution: 'je decide moi-meme' },
    });
    check('a claimant cannot resolve their own complaint', claimantDecides.status === 403,
      `status ${claimantDecides.status}`);

    const resolved = await call('PATCH', `/v1/reclamations/${caseId}`, {
      token: seller.token,
      body: { status: 'resolved', resolution: 'Bonne pièce expédiée le lendemain.' },
    });
    check('the business can resolve it',
      resolved.data?.status === 'resolved' && Boolean(resolved.data?.closedAt),
      `status ${resolved.status} -> ${resolved.data?.status}`);

    const reopen = await call('PATCH', `/v1/reclamations/${caseId}`, {
      token: seller.token,
      body: { status: 'under_review' },
    });
    check('a closed complaint cannot be reopened', reopen.status === 409,
      `status ${reopen.status}`);

    const afterClose = await call('POST', `/v1/reclamations/${caseId}/messages`, {
      token: client.token,
      body: { body: 'encore un mot' },
    });
    check('a closed complaint stops accepting messages', afterClose.status >= 400,
      `status ${afterClose.status}`);
  }

  section('driver identity & KYC');
  const driver = await makeUser('driver');
  const applied = await call('POST', '/v1/driver', {
    token: driver.token,
    body: { fullName: `Karim Benali ${STAMP}`, licenceExpiresOn: '2031-04-30' },
  });
  check('driver profile created', applied.status === 201 && applied.data?.status === 'draft',
    `${applied.status} ${applied.data?.status ?? JSON.stringify(applied.data).slice(0, 140)}`);
  const driverId = applied.data?.id;

  if (driverId) {
    const again = await call('POST', '/v1/driver', {
      token: driver.token,
      body: { fullName: 'Someone Else' },
    });
    check('re-applying returns the same profile', again.data?.id === driverId,
      `${again.data?.id} vs ${driverId}`);

    check('it reports which documents are still needed',
      JSON.stringify(applied.data?.missingDocuments) === JSON.stringify(['licence_front', 'selfie']),
      JSON.stringify(applied.data?.missingDocuments));

    const tooSoon = await call('POST', '/v1/driver/me/submit', { token: driver.token });
    check('submitting with no documents is refused', tooSoon.status === 422,
      `status ${tooSoon.status} ${tooSoon.data?.error?.code}`);

    const upload = await call('POST', '/v1/media/uploads', {
      token: driver.token,
      body: { bucket: 'driver-documents', filename: 'licence.jpg', contentType: 'image/jpeg' },
    });
    check('a driver-documents upload URL is issued', Boolean(upload.data?.uploadUrl),
      `status ${upload.status}`);

    const stolen = await call('POST', '/v1/driver/me/documents', {
      token: driver.token,
      body: { kind: 'licence_front', bucket: 'driver-documents', path: 'another-account/l.jpg' },
    });
    check("somebody else's licence photo is refused", stolen.status === 403,
      `status ${stolen.status}`);

    const wrongBucket = await call('POST', '/v1/driver/me/documents', {
      token: driver.token,
      body: { kind: 'selfie', bucket: 'avatars', path: upload.data?.path ?? 'x' },
    });
    check('a KYC document from the wrong bucket is refused', wrongBucket.status >= 400,
      `status ${wrongBucket.status}`);

    if (upload.data?.path) {
      for (const kind of ['licence_front', 'selfie']) {
        const attached = await call('POST', '/v1/driver/me/documents', {
          token: driver.token,
          body: { kind, bucket: 'driver-documents', path: upload.data.path },
        });
        check(`${kind} attached`, attached.status < 400, `status ${attached.status}`);
      }

      const complete = await call('GET', '/v1/driver/me', { token: driver.token });
      check('nothing is missing now', (complete.data?.missingDocuments ?? ['x']).length === 0,
        JSON.stringify(complete.data?.missingDocuments));

      const offline = await call('PATCH', '/v1/driver/me/availability', {
        token: driver.token,
        body: { isOnline: true, lat: 36.7538, lng: 3.0588 },
      });
      check('an unverified driver cannot go online', offline.status === 403,
        `status ${offline.status}`);

      const submitted = await call('POST', '/v1/driver/me/submit', { token: driver.token });
      check('submitted for review', submitted.data?.status === 'pending_review',
        `status ${submitted.status} -> ${submitted.data?.status}`);

      const frozen = await call('PATCH', '/v1/driver/me', {
        token: driver.token,
        body: { licenceNumber: 'CHANGED-AFTER-SUBMIT' },
      });
      check('details freeze while under review', frozen.status === 422,
        `status ${frozen.status} ${frozen.data?.error?.code}`);

      const notOps = await call('GET', '/v1/driver/review', { token: driver.token });
      check('the ops queue is not open to a driver', notOps.status === 403,
        `status ${notOps.status}`);

      /*
        The verification DECISION needs platform.admin, which no account in
        this run has — granting it would mean handing a smoke test the keys
        to every document in the system. So the decision path is exercised
        only as far as it can be without ops: everything above it is checked,
        and the 403 below proves the gate itself is wired.
      */
      const decide = await call('PATCH', `/v1/driver/${driverId}/verification`, {
        token: driver.token,
        body: { status: 'verified' },
      });
      check('a driver cannot verify themselves', decide.status === 403,
        `status ${decide.status}`);
    }
  }

  section('closing an account, and closing a business');
  {
    /*
      A business is not personal data: it has invoices and reviews of its
      own, and orphaning one would leave a shop in discovery that nobody can
      answer for. So closing an account that owns one is refused rather than
      cascading.
    */
    const ownsBusiness = await call('DELETE', '/v1/me', { token: seller.token });
    check('an account that owns a business cannot be closed', ownsBusiness.status === 422,
      `status ${ownsBusiness.status} ${ownsBusiness.data?.error?.code}`);
    check('…and is told to close the business first',
      ownsBusiness.data?.error?.code === 'ACCOUNT_OWNS_BUSINESS',
      String(ownsBusiness.data?.error?.code));

    const leaver = await makeUser('leaver');
    await call('PUT', '/v1/me', {
      token: leaver.token,
      body: { firstName: 'Amine', familyName: 'B', phone: '+213555999888', city: 'Alger' },
    });
    const beforeClose = await call('GET', '/v1/me', { token: leaver.token });
    check('profile fields beyond the original four are writable',
      beforeClose.data?.city === 'Alger', JSON.stringify(beforeClose.data?.city));

    const closed = await call('DELETE', '/v1/me', { token: leaver.token });
    check('account closed', closed.status === 200 && Boolean(closed.data?.deletedAt),
      `status ${closed.status}`);
    check('the name is gone', closed.data?.firstName === null && closed.data?.familyName === null,
      JSON.stringify([closed.data?.firstName, closed.data?.familyName]));
    check('so are the contact details',
      closed.data?.phone === null && closed.data?.email === null && closed.data?.city === null,
      JSON.stringify([closed.data?.phone, closed.data?.email, closed.data?.city]));
    check('every role was dropped', (closed.data?.roles ?? ['x']).length === 0,
      JSON.stringify(closed.data?.roles));

    const again = await call('DELETE', '/v1/me', { token: leaver.token });
    check('closing twice is idempotent', again.status === 200, `status ${again.status}`);

    /*
      A token already issued keeps working until it expires — permissions are
      baked in at exchange — which is why the app must drop it. What must NOT
      work is getting a new one with anything on it.
    */
    const signin = await call('POST', '/auth/v1/token?grant_type=password', {
      base: GOTRUE,
      body: { email: leaver.email, password: leaver.password },
    });
    const reissued = await call('POST', '/v1/auth/session', {
      token: signin.data?.access_token,
      body: {},
    });
    check('a closed account can still sign in but reaches nothing',
      reissued.status >= 400 || (reissued.data?.permissions ?? ['x']).length === 0,
      `status ${reissued.status} permissions ${JSON.stringify(reissued.data?.permissions)}`);

    /*
      THE PROMISE THE API MAKES ABOUT INVOICES, checked rather than asserted
      in prose: closing an account anonymises the person everywhere EXCEPT
      inside documents already issued to them.

      The buyer here is `client`, which nothing after this section uses. The
      sha256 is over the exact stored bytes, so an unchanged hash after the
      closure is proof that the name printed on the facture — and the gapless
      number it was issued under — are still exactly what was sealed.
    */
    if (factureNumber) {
      const beforeClose = await call('GET', `/v1/documents/verify/${factureNumber}`);
      check('the facture verifies before the buyer leaves',
        beforeClose.data?.authentic === true, `status ${beforeClose.status}`);

      const buyerClosed = await call('DELETE', '/v1/me', { token: client.token });
      check('the buyer closed their account', Boolean(buyerClosed.data?.deletedAt),
        `status ${buyerClosed.status}`);

      const afterClose = await call('GET', `/v1/documents/verify/${factureNumber}`);
      check('the facture is still there, under the same number',
        afterClose.data?.number === factureNumber, `status ${afterClose.status}`);
      /*
        `authentic` is the byte-level proof, not a flag we set: the server
        re-reads the object out of the bucket, re-hashes it and checks the
        signature. True after the closure means the stored bytes never
        changed — so the buyer's name is still printed on the facture,
        exactly as issued.
      */
      check('its bytes are untouched, so the buyer name is still printed on it',
        afterClose.data?.authentic === true,
        `authentic ${afterClose.data?.authentic} (sha at issue ${factureSha?.slice(0, 12)}…)`);
      check('…and is still issued, not voided', afterClose.data?.status === 'issued',
        String(afterClose.data?.status));
    }

    // Closing a business: a THROWAWAY one, so nothing above depends on it.
    const quitter = await makeUser('quitter');
    const biz = await call('POST', '/v1/supplier', {
      token: quitter.token,
      body: { verticalKey: 'part_store', name: `Smoke Quitter ${STAMP}`, city: 'Alger', country: 'DZ' },
    });
    if (biz.data?.id) {
      await eventually('the throwaway business got its scope', async () => {
        try {
          await exchange(quitter, 'supplier');
        } catch {
          return null;
        }
        return quitter.supplierId ? quitter : null;
      });
      const shut = await call('DELETE', '/v1/supplier/profile', { token: quitter.token });
      check('business closed, not deleted',
        Boolean(shut.data?.closedAt) && shut.data?.isOpen === false,
        `status ${shut.status}`);

      const frozen = await call('PATCH', '/v1/supplier/profile', {
        token: quitter.token,
        body: { name: 'back from the dead' },
      });
      check('a closed business is read-only', frozen.status === 422,
        `status ${frozen.status} ${frozen.data?.error?.code}`);

      /*
        The directory is a READ MODEL fed by suppliers.SupplierUpdated, so it
        catches up through outbox -> relay -> bus rather than instantly. A
        bare assertion here would be a flake that only fires on a slow box.
      */
      const dropped = await eventually('a closed business leaves the public directory', async () => {
        const res = await call('GET', `/v1/discovery/suppliers/${biz.data.id}`);
        return res.status === 404 ? res : null;
      });
      if (dropped) ok('a closed business leaves the public directory');
    }
  }

  section('summary');
  console.log(`  ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\nsmoke test aborted: ${error.message}`);
  process.exit(1);
});
