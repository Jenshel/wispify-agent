'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../src/db');
const store = require('../src/config/store');
const { deriveCapabilities, capabilities, isIntegrationActive } = require('../src/config/capabilities');

// See test/config-store.test.js for why this is required: without it,
// activateIntegration() would seal credentials using the real data/.keyfile.
let previousEncryptionKey;
before(() => {
  previousEncryptionKey = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (previousEncryptionKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = previousEncryptionKey;
});

function activate(db, id, creds = { fake: 'value' }) {
  store.activateIntegration(db, id, { credentials: creds });
  store.setIntegrationEnabled(db, id, true);
}

// ── deriveCapabilities() — pure function, no db ─────────────────────────────

test('deriveCapabilities() is all-false when nothing is active', () => {
  const caps = deriveCapabilities({});
  assert.deepEqual(caps, { chat: false, scheduling: false, payments: false });
});

test('deriveCapabilities() requires BOTH meta and gemini active for chat', () => {
  const onlyMeta = deriveCapabilities({ meta: { enabled: true, status: 'active' } });
  assert.equal(onlyMeta.chat, false);

  const both = deriveCapabilities({
    meta: { enabled: true, status: 'active' },
    gemini: { enabled: true, status: 'active' },
  });
  assert.equal(both.chat, true);
});

test('deriveCapabilities() treats enabled=false as inactive even when status is "active"', () => {
  const caps = deriveCapabilities({
    meta: { enabled: false, status: 'active' },
    gemini: { enabled: true, status: 'active' },
  });
  assert.equal(caps.chat, false);
});

test('deriveCapabilities() gates scheduling on google_calendar and payments on stripe independently', () => {
  const caps = deriveCapabilities({
    google_calendar: { enabled: true, status: 'active' },
    stripe: { enabled: false, status: 'active' },
  });
  assert.equal(caps.scheduling, true);
  assert.equal(caps.payments, false);
});

// ── capabilities(db) / isIntegrationActive(db, id) — real db wiring ────────

test('capabilities(db) is all-false on a fresh, unconfigured database', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(capabilities(db), { chat: false, scheduling: false, payments: false });
});

test('capabilities(db) flips to chat:true once meta+gemini are activated AND enabled', () => {
  const db = openDatabase(':memory:');
  activate(db, 'meta');
  activate(db, 'gemini');
  const caps = capabilities(db);
  assert.equal(caps.chat, true);
  assert.equal(caps.scheduling, false);
  assert.equal(caps.payments, false);
});

test('capabilities(db) does not grant chat when active but still disabled (enabled=false)', () => {
  const db = openDatabase(':memory:');
  store.activateIntegration(db, 'meta', { credentials: { access_token: 'x' } });
  store.activateIntegration(db, 'gemini', { credentials: { api_key: 'y' } });
  // deliberately NOT calling setIntegrationEnabled — status is active but enabled stays false
  assert.equal(capabilities(db).chat, false);
});

test('isIntegrationActive(db, id) matches capabilities() for google_calendar', () => {
  const db = openDatabase(':memory:');
  assert.equal(isIntegrationActive(db, 'google_calendar'), false);
  activate(db, 'google_calendar');
  assert.equal(isIntegrationActive(db, 'google_calendar'), true);
  assert.equal(capabilities(db).scheduling, true);
});
