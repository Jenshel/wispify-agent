'use strict';
// RED->GREEN for src/integrations/gemini.js (tasks.md Phase 2.2).
//
// design.md validation table: "GET .../v1beta/models?key= then assert
// selected model id present". Also exports the curated static GEMINI_MODELS
// list the setup screen's dropdown renders (spec: "MUST NOT accept free-text
// model identifiers").

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gemini = require('../src/integrations/gemini');

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

test('GEMINI_MODELS is a short curated static list of real current model ids', () => {
  assert.ok(Array.isArray(gemini.GEMINI_MODELS));
  assert.ok(gemini.GEMINI_MODELS.length > 0);
  assert.ok(gemini.GEMINI_MODELS.length <= 10, 'curated list should stay short, not free text');
  for (const id of gemini.GEMINI_MODELS) assert.equal(typeof id, 'string');
  assert.ok(gemini.GEMINI_MODELS.includes('gemini-2.5-flash'));
});

test('validate() rejects a model not in the curated list without hitting the network', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { models: [] }));
  const result = await gemini.validate({ apiKey: 'AIza...', model: 'not-a-real-model' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /model/i);
  assert.equal(fetchImpl.calls.length, 0);
});

test('validate() rejects when apiKey or model is missing', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { models: [] }));
  const result = await gemini.validate({ model: 'gemini-2.5-flash' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('validate() calls the models list endpoint with the api key as a query param', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { models: [{ name: 'models/gemini-2.5-flash' }] }));
  await gemini.validate({ apiKey: 'AIzaFAKE', model: 'gemini-2.5-flash' }, { fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  const { url } = fetchImpl.calls[0];
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?key=AIzaFAKE$/);
});

test('validate() returns ok + publicMeta + storage-shaped credentials when the model is present', async () => {
  const fetchImpl = fakeFetch(
    jsonResponse(200, { models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }] })
  );
  const result = await gemini.validate({ apiKey: 'AIzaFAKE', model: 'gemini-2.5-flash' }, { fetchImpl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.publicMeta, { model: 'gemini-2.5-flash' });
  assert.deepEqual(result.credentials, { api_key: 'AIzaFAKE', model: 'gemini-2.5-flash' });
  assert.equal(JSON.stringify(result.publicMeta).includes('AIzaFAKE'), false);
});

test('validate() fails when the key is valid but the selected model is not in the returned list', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { models: [{ name: 'models/gemini-2.5-pro' }] }));
  const result = await gemini.validate({ apiKey: 'AIzaFAKE', model: 'gemini-2.5-flash' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /not available/i);
});

test('validate() surfaces the provider error message on an invalid key (non-2xx)', async () => {
  const fetchImpl = fakeFetch(jsonResponse(400, { error: { message: 'API key not valid.' } }));
  const result = await gemini.validate({ apiKey: 'bad-key', model: 'gemini-2.5-flash' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API key not valid.');
});

test('validate() handles a network failure without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const result = await gemini.validate({ apiKey: 'x', model: 'gemini-2.5-flash' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /network error/i);
});
