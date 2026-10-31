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

  section('social feed');
  const post = await call('POST', '/v1/posts', {
    token: client.token,
    body: { body: `Post de test ${STAMP}` },
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
