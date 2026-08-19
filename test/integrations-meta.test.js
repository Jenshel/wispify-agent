'use strict';
// RED->GREEN for src/integrations/meta.js (tasks.md Phase 2.1).
//
// design.md validation table: "GET graph.facebook.com/{phoneNumberId}?
// fields=display_phone_number,verified_name (Bearer) — proves token valid +
// number owned". No real network call ever happens in this suite — a fake
// fetchImpl is injected so the test runs offline and deterministically.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const meta = require('../src/integrations/meta');

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

test('validate() rejects without hitting the network when accessToken is missing', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const result = await meta.validate({ phoneNumberId: '123' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /accessToken/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('validate() rejects without hitting the network when phoneNumberId is missing', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const result = await meta.validate({ accessToken: 'EAAB...' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /phoneNumberId/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('validate() calls the Graph API phone-number endpoint with Bearer auth', async () => {
  const fetchImpl = fakeFetch(
    jsonResponse(200, { display_phone_number: '+52 55 0000 0000', verified_name: 'Demo Biz' })
  );
  await meta.validate({ accessToken: 'EAAB_TOKEN', phoneNumberId: '999888777' }, { fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.match(url, /^https:\/\/graph\.facebook\.com\/v\d+(\.\d+)?\/999888777\?/);
  assert.match(url, /fields=display_phone_number,verified_name/);
  assert.equal(opts.headers.Authorization, 'Bearer EAAB_TOKEN');
});

test('validate() returns ok + normalized publicMeta + storage-shaped credentials on success', async () => {
  const fetchImpl = fakeFetch(
    jsonResponse(200, { display_phone_number: '+52 55 0000 0000', verified_name: 'Demo Biz' })
  );
  const result = await meta.validate({ accessToken: 'EAAB_TOKEN', phoneNumberId: '999888777' }, { fetchImpl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.publicMeta, {
    display_phone_number: '+52 55 0000 0000',
    verified_name: 'Demo Biz',
  });
  assert.deepEqual(result.credentials, { access_token: 'EAAB_TOKEN', phone_number_id: '999888777' });
  // the raw token must never appear inside publicMeta
  assert.equal(JSON.stringify(result.publicMeta).includes('EAAB_TOKEN'), false);
});

test('validate() surfaces the provider error message and persists nothing on a non-2xx response', async () => {
  const fetchImpl = fakeFetch(jsonResponse(401, { error: { message: 'Invalid OAuth access token.' } }));
  const result = await meta.validate({ accessToken: 'bad-token', phoneNumberId: '999' }, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid OAuth access token.');
  assert.equal(result.credentials, undefined);
  assert.equal(result.publicMeta, undefined);
});

test('validate() never leaks the raw access token inside an error message', async () => {
  const fetchImpl = fakeFetch(jsonResponse(401, { error: { message: 'Invalid OAuth access token.' } }));
  const result = await meta.validate({ accessToken: 'SUPER_SECRET_TOKEN', phoneNumberId: '999' }, { fetchImpl });
  assert.equal(result.error.includes('SUPER_SECRET_TOKEN'), false);
});

test('validate() handles a network failure without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND graph.facebook.com');
  };
  const result = await meta.validate({ accessToken: 'x', phoneNumberId: '999' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /network error/i);
});

test('validate() passes optional appSecret/verifyToken through into storage-shaped credentials', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { display_phone_number: '+52 55 0000 0000' }));
  const result = await meta.validate(
    { accessToken: 'EAAB', phoneNumberId: '999', appSecret: 'sec123', verifyToken: 'verify123' },
    { fetchImpl }
  );
  assert.equal(result.ok, true);
  assert.equal(result.credentials.app_secret, 'sec123');
  assert.equal(result.credentials.verify_token, 'verify123');
});
