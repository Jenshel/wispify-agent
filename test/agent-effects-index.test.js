'use strict';
// RED->GREEN for src/agent/effects/index.js — the dispatch map + helper
// that turns src/agent/pipeline.js's `effectCalls` list (name + payload
// descriptors) into actual function invocations. Kept separate from
// pipeline.js itself so pipeline.js stays a pure, provider/db-free function
// (design.md: "gating is unit-testable").

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const conversations = require('../src/db/conversations');
const effects = require('../src/agent/effects');

test('effects.dispatch exposes a handler for every effect name runPipeline() can emit', () => {
  for (const name of ['escalateHuman', 'captureContactData', 'confirmAppointment', 'confirmOrder', 'sendPhoto']) {
    assert.equal(typeof effects.dispatch[name], 'function', `missing dispatch handler for ${name}`);
  }
});

test('dispatchEffectCalls() invokes each effectCall payload through the matching handler and returns the results', async () => {
  const effectCalls = [
    { effect: 'captureContactData', payload: { name: 'Ana', business: 'Bella Studio', from: '5215500000001' } },
  ];
  const results = await effects.dispatchEffectCalls(effectCalls, {});
  assert.equal(results.length, 1);
  assert.equal(results[0].effect, 'captureContactData');
  assert.equal(results[0].result.captured, true);
});

test('dispatchEffectCalls() merges the shared ctx (db/fetchImpl/from) into every payload dispatch', async () => {
  const effectCalls = [{ effect: 'sendPhoto', payload: { productName: 'Camisa' } }];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const results = await effects.dispatchEffectCalls(effectCalls, { fetchImpl });
  assert.equal(results[0].result.stub, true);
  assert.equal(calls.length, 0); // stub never calls out
});

test('dispatchEffectCalls() never throws on an unknown effect name — logs and continues', async () => {
  const effectCalls = [{ effect: 'not_a_real_effect', payload: {} }];
  await assert.doesNotReject(() => effects.dispatchEffectCalls(effectCalls, {}));
});

test('dispatchEffectCalls() returns an empty array for an empty effectCalls list', async () => {
  const results = await effects.dispatchEffectCalls([], {});
  assert.deepEqual(results, []);
});

test('dispatchEffectCalls() persists a real captureContactData round-trip onto the conversations table when db is in ctx (PR17)', async () => {
  const db = openDatabase(':memory:');
  const effectCalls = [{ effect: 'captureContactData', payload: { name: 'Ana', business: 'Bella Studio' } }];
  const results = await effects.dispatchEffectCalls(effectCalls, { db, from: '5215500000001' });
  assert.equal(results[0].result.captured, true);
  assert.equal(results[0].result.persisted, true);

  const conv = conversations.getConversation(db, '5215500000001');
  assert.equal(conv.contactName, 'Ana');
  assert.equal(conv.businessName, 'Bella Studio');
});

test('dispatchEffectCalls() degrades captureContactData gracefully (persisted:false, no throw) when ctx has no db/from', async () => {
  const effectCalls = [{ effect: 'captureContactData', payload: { name: 'Ana', business: 'Bella Studio', from: '5215500000001' } }];
  const results = await effects.dispatchEffectCalls(effectCalls, {});
  assert.equal(results[0].result.captured, true);
  assert.equal(results[0].result.persisted, false);
});

test('dispatchEffectCalls() runs multiple effect calls and preserves order in the results array', async () => {
  const effectCalls = [
    { effect: 'escalateHuman', payload: { reason: 'a', from: '1' } },
    { effect: 'captureContactData', payload: { name: 'B', business: '', from: '1' } },
  ];
  const results = await effects.dispatchEffectCalls(effectCalls, {});
  assert.deepEqual(results.map((r) => r.effect), ['escalateHuman', 'captureContactData']);
});
