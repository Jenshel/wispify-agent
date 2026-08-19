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
