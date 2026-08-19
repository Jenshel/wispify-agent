'use strict';
// RED->GREEN for src/routes/payments.js (tasks.md Phase 9.1/9.2/9.3).
//
// threat-matrix (a): Stripe webhook HMAC verification on raw bytes,
// enforce mode default ON — same secure-by-default posture and
// length-check-before-timingSafeEqual discipline as
// src/channels/whatsapp/webhook.js's Meta HMAC verification.
//
// Stripe's signature scheme differs from Meta's (a `t=...,v1=...` header,
// HMAC over `${timestamp}.${rawBody}`, plus a replay-age freshness check)
// but the same fail-closed/timing-safe rigor applies throughout.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const { httpGet } = require('./helper');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');
const store = require('../src/config/store');
const orders = require('../src/db/orders');
const { verifyStripeSignature } = require('../src/routes/payments');

const WEBHOOK_SECRET = 'whsec_test_123';

let prevKey;
before(() => {
  prevKey = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (prevKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = prevKey;
});

function activateStripe(db, overrides = {}) {
  store.activateIntegration(db, 'stripe', {
    credentials: { secret_key: 'sk_test_FAKE', webhook_secret: WEBHOOK_SECRET, ...overrides },
    publicMeta: { livemode: false },
  });
}

function activateMeta(db) {
  store.activateIntegration(db, 'meta', {
    credentials: { access_token: 'EAAB_TEST', phone_number_id: '999888777', app_secret: 's', verify_token: 'v' },
    publicMeta: {},
  });
}

function signStripe(bodyStr, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const signedPayload = `${timestamp}.${bodyStr}`;
  const v1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

async function bootServer({ db, fetchImpl } = {}) {
  const database = db || openDatabase(':memory:');
  const app = createApp({ db: database, fetchImpl });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${s.address().port}`,
        db: database,
        close: () => new Promise((r) => s.close(() => r())),
      })
    );
  });
  return server;
}

function rawPost(server, urlPath, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      server.base + urlPath,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpGetNoFollow(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(server.base + urlPath, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── verifyStripeSignature() — pure unit tests (threat-matrix a) ──────────

test('verifyStripeSignature() accepts a correctly-signed, fresh body', () => {
  const bodyStr = JSON.stringify({ id: 'evt_1' });
  const header = signStripe(bodyStr);
  const result = verifyStripeSignature(Buffer.from(bodyStr), header, WEBHOOK_SECRET);
  assert.equal(result.ok, true);
});

test('verifyStripeSignature() rejects a tampered body', () => {
  const bodyStr = JSON.stringify({ id: 'evt_1' });
  const header = signStripe(bodyStr);
  const result = verifyStripeSignature(Buffer.from(JSON.stringify({ id: 'evt_2' })), header, WEBHOOK_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'hmac_mismatch');
});

test('verifyStripeSignature() rejects when no secret is configured — fails closed', () => {
  const bodyStr = JSON.stringify({ id: 'evt_1' });
  const header = signStripe(bodyStr);
  const result = verifyStripeSignature(Buffer.from(bodyStr), header, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_secret_configured');
});

test('verifyStripeSignature() rejects a missing signature header', () => {
  const result = verifyStripeSignature(Buffer.from('{}'), undefined, WEBHOOK_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_header');
});

test('verifyStripeSignature() rejects a malformed signature header', () => {
  const result = verifyStripeSignature(Buffer.from('{}'), 'garbage-not-t-v1-format', WEBHOOK_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed_header');
});

test('verifyStripeSignature() fails closed on a length mismatch WITHOUT throwing', () => {
  const bodyStr = JSON.stringify({ id: 'evt_1' });
  const header = `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`; // way shorter than a real 64-hex-char HMAC
  assert.doesNotThrow(() => {
    const result = verifyStripeSignature(Buffer.from(bodyStr), header, WEBHOOK_SECRET);
    assert.equal(result.ok, false);
  });
});

test('verifyStripeSignature() rejects an event older than the max age (replay-age check)', () => {
  const bodyStr = JSON.stringify({ id: 'evt_1' });
  const staleTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1h old, default max is 300s
  const header = signStripe(bodyStr, { timestamp: staleTimestamp });
  const result = verifyStripeSignature(Buffer.from(bodyStr), header, WEBHOOK_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'event_too_old');
});

test('verifyStripeSignature() rejects a timestamp implausibly far in the future (clock-skew/tamper guard)', () => {
  const bodyStr = JSON.stringify({ id: 'evt_1' });
  const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
  const header = signStripe(bodyStr, { timestamp: futureTimestamp });
  const result = verifyStripeSignature(Buffer.from(bodyStr), header, WEBHOOK_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'event_from_future');
});

test('verifyStripeSignature() rejects an empty body', () => {
  const result = verifyStripeSignature(Buffer.alloc(0), 't=1,v1=abc', WEBHOOK_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_body');
});

// ── GET /pay/:orderId ──────────────────────────────────────────────────────

test('GET /pay/:orderId returns 404 for an unknown order', async () => {
  const server = await bootServer();
  try {
    const res = await httpGetNoFollow(server, '/pay/does-not-exist');
    assert.equal(res.statusCode, 404);
  } finally {
    await server.close();
  }
});

test('GET /pay/:orderId returns 500 when Stripe is not configured', async () => {
  const server = await bootServer();
  try {
    orders.createOrder(server.db, { id: 'ord-1', customerPhone: '5215500000001', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
    const res = await httpGetNoFollow(server, '/pay/ord-1');
    assert.equal(res.statusCode, 500);
  } finally {
    await server.close();
  }
});

test('GET /pay/:orderId already paid redirects straight to the result page without calling Stripe', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const server = await bootServer({ fetchImpl });
  try {
    activateStripe(server.db);
    orders.createOrder(server.db, { id: 'ord-2', customerPhone: '5215500000001', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
    orders.markPaid(server.db, 'ord-2');
    const res = await httpGetNoFollow(server, '/pay/ord-2');
    assert.equal(res.statusCode, 302);
    assert.match(res.headers.location, /\/pay\/ord-2\/result/);
    assert.equal(calls.length, 0);
  } finally {
    await server.close();
  }
});

test('GET /pay/:orderId builds a real Checkout Session with dynamic line_items and redirects to it, caching the session on the order', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/pay/cs_test_abc' }) };
  };
  const server = await bootServer({ fetchImpl });
  try {
    activateStripe(server.db);
    orders.createOrder(server.db, {
      id: 'ord-3',
      customerPhone: '5215500000001',
      products: [{ name: 'Camisa', qty: 2, price: 150 }],
      total: 300,
      currency: 'MXN',
    });
    const res = await httpGetNoFollow(server, '/pay/ord-3');
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, 'https://checkout.stripe.com/pay/cs_test_abc');

    const sessionCall = calls.find((c) => c.url.includes('checkout/sessions'));
    assert.ok(sessionCall);
    const body = new URLSearchParams(sessionCall.opts.body);
    assert.equal(body.get('client_reference_id'), 'ord-3');
    assert.equal(body.get('metadata[orderId]'), 'ord-3');
    assert.equal(body.get('line_items[0][price_data][currency]'), 'mxn');
    assert.match(body.get('success_url'), /\/pay\/ord-3\/result\?paid=1$/);
    assert.match(body.get('cancel_url'), /\/pay\/ord-3\/result$/);

    const stored = orders.getOrderById(server.db, 'ord-3');
    assert.equal(stored.stripeSessionId, 'cs_test_abc');
    assert.equal(stored.stripeSessionUrl, 'https://checkout.stripe.com/pay/cs_test_abc');
  } finally {
    await server.close();
  }
});

test('GET /pay/:orderId reuses a freshly-cached Checkout Session without calling Stripe again', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ id: 'cs_new', url: 'https://checkout.stripe.com/pay/cs_new' }) };
  };
  const server = await bootServer({ fetchImpl });
  try {
    activateStripe(server.db);
    orders.createOrder(server.db, { id: 'ord-4', customerPhone: '5215500000001', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
    orders.setStripeSession(server.db, 'ord-4', { stripeSessionId: 'cs_cached', stripeSessionUrl: 'https://checkout.stripe.com/pay/cs_cached' });

    const res = await httpGetNoFollow(server, '/pay/ord-4');
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, 'https://checkout.stripe.com/pay/cs_cached');
    assert.equal(calls.filter((u) => u.includes('checkout/sessions')).length, 0);
  } finally {
    await server.close();
  }
});

// ── GET /pay/:orderId/result — placeholder confirmation page ─────────────
// No public-facing pago.html-equivalent page exists yet anywhere in this
// repo (flagged explicitly — see this router's own header comment); this is
// a minimal, honest placeholder so success_url/cancel_url never 404, not a
// finished UI.

test('GET /pay/:orderId/result reflects the real DB status, not just the query string', async () => {
  const server = await bootServer();
  try {
    orders.createOrder(server.db, { id: 'ord-5', customerPhone: '5215500000001', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
    const pending = await httpGetNoFollow(server, '/pay/ord-5/result?paid=1'); // query string LIES — DB still says pending
    assert.match(pending.body, /no.*completad/i);

    orders.markPaid(server.db, 'ord-5');
    const paid = await httpGetNoFollow(server, '/pay/ord-5/result');
    assert.match(paid.body, /confirmado/i);
  } finally {
    await server.close();
  }
});

// ── POST /webhook/stripe ───────────────────────────────────────────────────

test('POST /webhook/stripe rejects an incorrectly-signed event — 400, no order mutated', async () => {
  const server = await bootServer();
  try {
    activateStripe(server.db);
    orders.createOrder(server.db, { id: 'ord-6', customerPhone: '5215500000001', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
    const bodyStr = JSON.stringify({
      id: 'evt_1', type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', client_reference_id: 'ord-6' } },
    });
    const res = await rawPost(server, '/webhook/stripe', bodyStr, { 'stripe-signature': 't=1,v1=deadbeef' });
    assert.equal(res.statusCode, 400);
    assert.equal(orders.getOrderById(server.db, 'ord-6').status, 'pending');
  } finally {
    await server.close();
  }
});

test('POST /webhook/stripe rejects a stale (replayed) event — 400', async () => {
  const server = await bootServer();
  try {
    activateStripe(server.db);
    const bodyStr = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
    const staleHeader = signStripe(bodyStr, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await rawPost(server, '/webhook/stripe', bodyStr, { 'stripe-signature': staleHeader });
    assert.equal(res.statusCode, 400);
  } finally {
    await server.close();
  }
});

test('POST /webhook/stripe returns 500 (fails closed) when no webhook secret is configured yet', async () => {
  const server = await bootServer();
  try {
    const bodyStr = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const header = signStripe(bodyStr);
    const res = await rawPost(server, '/webhook/stripe', bodyStr, { 'stripe-signature': header });
    assert.equal(res.statusCode, 500);
  } finally {
    await server.close();
  }
});

test('POST /webhook/stripe on a valid checkout.session.completed: marks the order paid via client_reference_id and sends a WhatsApp confirmation', async () => {
  let resolveConfirm;
  const confirmed = new Promise((resolve) => { resolveConfirm = resolve; });
  const graphCalls = [];
  const fetchImpl = async (url, opts) => {
    graphCalls.push({ url, opts });
    if (url.includes('/messages')) resolveConfirm();
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };

  const server = await bootServer({ fetchImpl });
  try {
    activateStripe(server.db);
    activateMeta(server.db);
    orders.createOrder(server.db, {
      id: 'ord-7', customerPhone: '5215500000001',
      products: [{ name: 'Camisa', qty: 1, price: 150 }], total: 150, currency: 'MXN',
    });

    const bodyStr = JSON.stringify({
      id: 'evt_paid',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_paid_1', client_reference_id: 'ord-7', metadata: {} } },
    });
    const header = signStripe(bodyStr);
    const res = await rawPost(server, '/webhook/stripe', bodyStr, { 'stripe-signature': header });
    assert.equal(res.statusCode, 200);

    await Promise.race([confirmed, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);

    const stored = orders.getOrderById(server.db, 'ord-7');
    assert.equal(stored.status, 'paid');
    assert.equal(stored.stripeSessionId, 'cs_paid_1');

    const confirmCall = graphCalls.find((c) => c.url.includes('/messages'));
    const body = JSON.parse(confirmCall.opts.body);
    assert.equal(body.to, '5215500000001');
    assert.match(body.text.body, /[Pp]ago confirmado/);
  } finally {
    await server.close();
  }
});

test('POST /webhook/stripe matches via metadata.orderId when client_reference_id is absent', async () => {
  let resolveConfirm;
  const confirmed = new Promise((resolve) => { resolveConfirm = resolve; });
  const fetchImpl = async (url, opts) => {
    if (url.includes('/messages')) resolveConfirm();
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };

  const server = await bootServer({ fetchImpl });
  try {
    activateStripe(server.db);
    activateMeta(server.db);
    orders.createOrder(server.db, { id: 'ord-8', customerPhone: '5215500000002', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });

    const bodyStr = JSON.stringify({
      id: 'evt_paid2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_paid_2', metadata: { orderId: 'ord-8' } } },
    });
    const header = signStripe(bodyStr);
    const res = await rawPost(server, '/webhook/stripe', bodyStr, { 'stripe-signature': header });
    assert.equal(res.statusCode, 200);
    await Promise.race([confirmed, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    assert.equal(orders.getOrderById(server.db, 'ord-8').status, 'paid');
  } finally {
    await server.close();
  }
});

test('POST /webhook/stripe ignores an unrelated event type without error', async () => {
  const server = await bootServer();
  try {
    activateStripe(server.db);
    const bodyStr = JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: {} } });
    const header = signStripe(bodyStr);
    const res = await rawPost(server, '/webhook/stripe', bodyStr, { 'stripe-signature': header });
    assert.equal(res.statusCode, 200);
  } finally {
    await server.close();
  }
});

test('POST /webhook/stripe does not re-notify or crash on a duplicate checkout.session.completed for an already-paid order', async () => {
  const graphCalls = [];
  const fetchImpl = async (url, opts) => {
    graphCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };
  const server = await bootServer({ fetchImpl });
  try {
    activateStripe(server.db);
    activateMeta(server.db);
    orders.createOrder(server.db, { id: 'ord-9', customerPhone: '5215500000003', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
    orders.markPaid(server.db, 'ord-9', { stripeSessionId: 'cs_already' });

    const bodyStr = JSON.stringify({
      id: 'evt_dup',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_already', client_reference_id: 'ord-9' } },
    });
    const header = signStripe(bodyStr);
    const res = await rawPost(server, '/webhook/stripe', bodyStr, { 'stripe-signature': header });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(graphCalls.filter((c) => c.url.includes('/messages')).length, 0);
  } finally {
    await server.close();
  }
});

test('POST /webhook/stripe logs and does not crash when no order matches the event', async () => {
  const server = await bootServer();
  try {
    activateStripe(server.db);
    const bodyStr = JSON.stringify({
      id: 'evt_nomatch', type: 'checkout.session.completed',
      data: { object: { id: 'cs_nomatch', client_reference_id: 'does-not-exist' } },
    });
    const header = signStripe(bodyStr);
    const res = await rawPost(server, '/webhook/stripe', bodyStr, { 'stripe-signature': header });
    assert.equal(res.statusCode, 200); // Meta-style: ack immediately, process async
  } finally {
    await server.close();
  }
});
