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

    const outsider2 = await makeUser('outsider2');
    const theirDelete = await call('DELETE', `/v1/posts/${postId}`, { token: outsider2.token });
    check('only the author may retract', theirDelete.status >= 400, `status ${theirDelete.status}`);
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
