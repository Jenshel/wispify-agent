'use strict';
// RED->GREEN for src/integrations/stripe.js (tasks.md Phase 2.5).
//
// design.md validation table: "GET api.stripe.com/v1/balance (read-only),
// read livemode — key valid; test vs live surfaced in UI".

const { test } = require('node:test');
const assert = require('node:assert/strict');

const stripe = require('../src/integrations/stripe');

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('validate() rejects without hitting the network when secretKey is missing', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const result = await stripe.validate({}, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /secretKey/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('validate() calls GET /v1/balance with HTTP Basic auth using the secret key', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { livemode: false }));
  await stripe.validate({ secretKey: 'sk_test_FAKE' }, { fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.stripe.com/v1/balance');
  const expected = `Basic ${Buffer.from('sk_test_FAKE:').toString('base64')}`;
  assert.equal(opts.headers.Authorization, expected);
});

test('validate() returns ok + publicMeta.livemode + storage-shaped credentials on success', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { livemode: true, object: 'balance' }));
  const result = await stripe.validate({ secretKey: 'sk_live_FAKE' }, { fetchImpl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.publicMeta, { livemode: true });
  assert.deepEqual(result.credentials, { secret_key: 'sk_live_FAKE' });
  assert.equal(JSON.stringify(result.publicMeta).includes('sk_live_FAKE'), false);
});

test('validate() surfaces the provider error message and persists nothing on an invalid key', async () => {
  const fetchImpl = fakeFetch(
    jsonResponse(401, { error: { message: 'Invalid API Key provided: sk_test_***.' } })
  );
  const result = await stripe.validate({ secretKey: 'sk_test_bad' }, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid API Key provided: sk_test_***.');
  assert.equal(result.credentials, undefined);
});

test('validate() never leaks the raw secret key inside an error message', async () => {
  const fetchImpl = fakeFetch(jsonResponse(401, { error: { message: 'Invalid API Key provided.' } }));
  const result = await stripe.validate({ secretKey: 'sk_live_SUPER_SECRET' }, { fetchImpl });
  assert.equal(result.error.includes('sk_live_SUPER_SECRET'), false);
});

test('validate() handles a network failure without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('connect ETIMEDOUT');
  };
  const result = await stripe.validate({ secretKey: 'sk_test_x' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /network error/i);
});

// ── createCheckoutSession() — tasks.md Phase 9.2, design.md "Payments" ────
// Builds dynamic line_items[] from an order's products via the SAME Basic
// auth pattern validate() already uses (no reinvented auth scheme), reusing
// this module rather than duplicating it — same precedent as
// src/channels/whatsapp/client.js reusing src/integrations/meta.js's
// GRAPH_API_BASE.

test('createCheckoutSession() rejects without hitting the network when secretKey is missing', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const result = await stripe.createCheckoutSession(
    {},
    { orderId: 'ord-1', products: [{ name: 'X', qty: 1, price: 10 }], currency: 'mxn', successUrl: 'https://x/s', cancelUrl: 'https://x/c' },
    { fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /secretKey/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('createCheckoutSession() rejects an order with no products, without hitting the network', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const result = await stripe.createCheckoutSession(
    { secretKey: 'sk_test_FAKE' },
    { orderId: 'ord-1', products: [], currency: 'mxn', successUrl: 'https://x/s', cancelUrl: 'https://x/c' },
    { fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /products/i);
  assert.equal(fetchImpl.calls.length, 0);
});

test('createCheckoutSession() POSTs form-encoded dynamic line_items with Basic auth, client_reference_id, and metadata.orderId', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123' }));
  const result = await stripe.createCheckoutSession(
    { secretKey: 'sk_test_FAKE' },
    {
      orderId: 'ord-42',
      products: [
        { name: 'Camisa', qty: 2, price: 150 },
        { name: 'Gorra', qty: 1, price: 80 },
      ],
      currency: 'mxn',
      successUrl: 'https://bot.example.com/pay/ord-42/result?paid=1',
      cancelUrl: 'https://bot.example.com/pay/ord-42/result',
    },
    { fetchImpl }
  );

  assert.equal(result.ok, true);
  assert.equal(result.id, 'cs_test_123');
  assert.equal(result.url, 'https://checkout.stripe.com/pay/cs_test_123');

  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(opts.method, 'POST');
  const expectedAuth = `Basic ${Buffer.from('sk_test_FAKE:').toString('base64')}`;
  assert.equal(opts.headers.Authorization, expectedAuth);
  assert.equal(opts.headers['Content-Type'], 'application/x-www-form-urlencoded');

  const body = new URLSearchParams(opts.body);
  assert.equal(body.get('mode'), 'payment');
  assert.equal(body.get('success_url'), 'https://bot.example.com/pay/ord-42/result?paid=1');
  assert.equal(body.get('cancel_url'), 'https://bot.example.com/pay/ord-42/result');
  assert.equal(body.get('client_reference_id'), 'ord-42');
  assert.equal(body.get('metadata[orderId]'), 'ord-42');
  assert.equal(body.get('line_items[0][quantity]'), '2');
  assert.equal(body.get('line_items[0][price_data][currency]'), 'mxn');
  assert.equal(body.get('line_items[0][price_data][unit_amount]'), '15000');
  assert.equal(body.get('line_items[0][price_data][product_data][name]'), 'Camisa');
  assert.equal(body.get('line_items[1][quantity]'), '1');
  assert.equal(body.get('line_items[1][price_data][unit_amount]'), '8000');
});

test('createCheckoutSession() skips zero/negative-price line items and still succeeds if at least one valid item remains', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { id: 'cs_test_x', url: 'https://checkout.stripe.com/pay/cs_test_x' }));
  const result = await stripe.createCheckoutSession(
    { secretKey: 'sk_test_FAKE' },
    {
      orderId: 'ord-3',
      products: [{ name: 'Gratis', qty: 1, price: 0 }, { name: 'Real', qty: 1, price: 50 }],
      currency: 'mxn',
      successUrl: 'https://x/s',
      cancelUrl: 'https://x/c',
    },
    { fetchImpl }
  );
  assert.equal(result.ok, true);
  const body = new URLSearchParams(fetchImpl.calls[0].opts.body);
  // only ONE line item made it through (index 0 == 'Real', the zero-price one was skipped)
  assert.equal(body.get('line_items[0][price_data][product_data][name]'), 'Real');
  assert.equal(body.get('line_items[1][price_data][product_data][name]'), null);
});

test('createCheckoutSession() rejects when every line item is zero/negative price, without hitting the network', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const result = await stripe.createCheckoutSession(
    { secretKey: 'sk_test_FAKE' },
    { orderId: 'ord-4', products: [{ name: 'Gratis', qty: 1, price: 0 }], currency: 'mxn', successUrl: 'https://x/s', cancelUrl: 'https://x/c' },
    { fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /line item/i);
  assert.equal(fetchImpl.calls.length, 0);
});

test('createCheckoutSession() surfaces the Stripe error message on a failed session creation', async () => {
  const fetchImpl = fakeFetch(jsonResponse(402, { error: { message: 'Your card was declined.' } }));
  const result = await stripe.createCheckoutSession(
    { secretKey: 'sk_test_FAKE' },
    { orderId: 'ord-5', products: [{ name: 'X', qty: 1, price: 10 }], currency: 'mxn', successUrl: 'https://x/s', cancelUrl: 'https://x/c' },
    { fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Your card was declined.');
});

test('createCheckoutSession() handles a network failure without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('connect ETIMEDOUT');
  };
  const result = await stripe.createCheckoutSession(
    { secretKey: 'sk_test_FAKE' },
    { orderId: 'ord-6', products: [{ name: 'X', qty: 1, price: 10 }], currency: 'mxn', successUrl: 'https://x/s', cancelUrl: 'https://x/c' },
    { fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /network error/i);
});
