'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../src/db');
const store = require('../src/config/store');

// store.js's seal/open calls never pass an explicit key, so without this
// they'd fall through to secrets.js's default resolveKey() and touch the
// REAL data/.keyfile on every test run. Force an explicit in-memory key for
// the whole file so activateIntegration()/getIntegrationCredentials() never
// hit the filesystem.
let previousEncryptionKey;
before(() => {
  previousEncryptionKey = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (previousEncryptionKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = previousEncryptionKey;
});

function freshDb() {
  return openDatabase(':memory:');
}

// ── app_config ────────────────────────────────────────────────────────────

test('getAppConfig() returns the seeded defaults on a fresh database', () => {
  const db = freshDb();
  const config = store.getAppConfig(db);
  assert.equal(config.currency, 'MXN');
  assert.equal(config.timezone, 'America/Mexico_City');
  assert.equal(config.botPaused, false);
});

test('updateAppConfig() persists a partial patch and leaves other fields untouched', () => {
  const db = freshDb();
  store.updateAppConfig(db, { businessName: 'Wispify Demo', currency: 'USD' });
  const config = store.getAppConfig(db);
  assert.equal(config.businessName, 'Wispify Demo');
  assert.equal(config.currency, 'USD');
  assert.equal(config.timezone, 'America/Mexico_City'); // untouched
});

test('updateAppConfig() coerces botPaused to a real boolean on read-back', () => {
  const db = freshDb();
  store.updateAppConfig(db, { botPaused: true });
  assert.equal(store.getAppConfig(db).botPaused, true);
  store.updateAppConfig(db, { botPaused: false });
  assert.equal(store.getAppConfig(db).botPaused, false);
});

// ── integrations: activation / errors / enable ──────────────────────────────

test('activateIntegration() seals credentials and flips status to active', () => {
  const db = freshDb();
  store.activateIntegration(db, 'meta', {
    credentials: { access_token: 'EAAB...', phone_number_id: '123456' },
    publicMeta: { display_phone_number: '+52 55 0000 0000' },
  });
  const pub = store.getIntegrationPublic(db, 'meta');
  assert.equal(pub.status, 'active');
  assert.equal(pub.publicMeta.display_phone_number, '+52 55 0000 0000');
});

test('getIntegrationCredentials() decrypts back the exact object that was activated with', () => {
  const db = freshDb();
  const creds = { api_key: 'AIzaSyFAKE', model: 'gemini-2.0-flash' };
  store.activateIntegration(db, 'gemini', { credentials: creds });
  assert.deepEqual(store.getIntegrationCredentials(db, 'gemini'), creds);
});

test('setIntegrationError() records the error and does not touch a previously-persisted credential', () => {
  const db = freshDb();
  store.activateIntegration(db, 'stripe', { credentials: { secret_key: 'sk_test_1' } });
  store.setIntegrationError(db, 'stripe', 'balance check failed: 401');
  const pub = store.getIntegrationPublic(db, 'stripe');
  assert.equal(pub.status, 'error');
  assert.equal(pub.lastError, 'balance check failed: 401');
  // credential from the earlier activation is still there, untouched
  assert.deepEqual(store.getIntegrationCredentials(db, 'stripe'), { secret_key: 'sk_test_1' });
});

test('setIntegrationEnabled(true) refuses when the integration is not active', () => {
  const db = freshDb();
  assert.throws(() => store.setIntegrationEnabled(db, 'meta', true));
});

test('setIntegrationEnabled(true) succeeds once the integration is active', () => {
  const db = freshDb();
  store.activateIntegration(db, 'meta', { credentials: { access_token: 'x' } });
  const pub = store.setIntegrationEnabled(db, 'meta', true);
  assert.equal(pub.enabled, true);
});

test('setIntegrationEnabled(false) always succeeds, even when never activated', () => {
  const db = freshDb();
  const pub = store.setIntegrationEnabled(db, 'stripe', false);
  assert.equal(pub.enabled, false);
});

test('getIntegrationRow()/activateIntegration() reject an unknown integration id', () => {
  const db = freshDb();
  assert.throws(() => store.getIntegrationRow(db, 'not-a-real-integration'));
  assert.throws(() => store.activateIntegration(db, 'not-a-real-integration', { credentials: {} }));
});

// ── threat-matrix (c): the settings read path never returns a secret ───────
// design.md: "GET /api/settings/integrations returns status + public_meta +
// masked hint only — no endpoint ever returns a secret." Phase 1 builds the
// data-layer function Phase 2/3's route will call for that GET; this test
// pins its contract now so the route can never regress it later.

test('getIntegrationPublic() never exposes credentials, even after activation with a real secret', () => {
  const db = freshDb();
  store.activateIntegration(db, 'stripe', {
    credentials: { secret_key: 'sk_live_THIS_MUST_NEVER_LEAK' },
    publicMeta: { livemode: true, credentialHint: 'sk_live_••••LEAK' },
  });
  const pub = store.getIntegrationPublic(db, 'stripe');

  assert.equal('credentials' in pub, false);
  assert.equal(JSON.stringify(pub).includes('sk_live_THIS_MUST_NEVER_LEAK'), false);
  // the caller-supplied non-secret hint IS allowed through, inside publicMeta
  assert.equal(pub.publicMeta.credentialHint, 'sk_live_••••LEAK');
});

test('listIntegrationsPublic() never exposes credentials for any integration', () => {
  const db = freshDb();
  store.activateIntegration(db, 'meta', { credentials: { access_token: 'META_SECRET_TOKEN' } });
  store.activateIntegration(db, 'gemini', { credentials: { api_key: 'GEMINI_SECRET_KEY' } });

  const rows = store.listIntegrationsPublic(db);
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal('credentials' in row, false);
  assert.equal(JSON.stringify(rows).includes('META_SECRET_TOKEN'), false);
  assert.equal(JSON.stringify(rows).includes('GEMINI_SECRET_KEY'), false);
});

// ── DB > .env seed-once precedence ──────────────────────────────────────────

test('seedIntegrationsFromEnv() seeds a credential from env vars when the DB has none yet', () => {
  const db = freshDb();
  const env = { GEMINI_API_KEY: 'AIzaFromEnv', GEMINI_MODEL: 'gemini-2.0-flash' };
  const seeded = store.seedIntegrationsFromEnv(db, env);
  assert.deepEqual(seeded, ['gemini']);
  assert.deepEqual(store.getIntegrationCredentials(db, 'gemini'), {
    api_key: 'AIzaFromEnv',
    model: 'gemini-2.0-flash',
  });
  // seeding alone must NOT activate — no live validation ran
  assert.equal(store.getIntegrationPublic(db, 'gemini').status, 'unconfigured');
});

test('seedIntegrationsFromEnv() never overwrites a credential already stored in the DB', () => {
  const db = freshDb();
  store.activateIntegration(db, 'gemini', { credentials: { api_key: 'FROM_DB_WINS' } });
  const env = { GEMINI_API_KEY: 'FROM_ENV_LOSES' };
  const seeded = store.seedIntegrationsFromEnv(db, env);
  assert.deepEqual(seeded, []);
  assert.deepEqual(store.getIntegrationCredentials(db, 'gemini'), { api_key: 'FROM_DB_WINS' });
});

test('seedIntegrationsFromEnv() skips integrations with no matching env vars set', () => {
  const db = freshDb();
  const seeded = store.seedIntegrationsFromEnv(db, {});
  assert.deepEqual(seeded, []);
});
