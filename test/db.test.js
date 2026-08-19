'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase, migrate, SCHEMA_VERSION } = require('../src/db');

test('openDatabase(":memory:") creates app_config with exactly one seeded row', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare('SELECT * FROM app_config').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
});

test('seeded app_config row has the design-mandated defaults', () => {
  const db = openDatabase(':memory:');
  const row = db.prepare('SELECT * FROM app_config WHERE id = 1').get();
  assert.equal(row.currency, 'MXN');
  assert.equal(row.timezone, 'America/Mexico_City');
  assert.equal(row.bot_paused, 0);
});

test('openDatabase(":memory:") seeds exactly the four known integrations, all unconfigured', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare('SELECT id, enabled, status, credentials FROM integrations ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.id), ['gemini', 'google_calendar', 'meta', 'stripe']);
  for (const row of rows) {
    assert.equal(row.enabled, 0);
    assert.equal(row.status, 'unconfigured');
    assert.equal(row.credentials, null);
  }
});

test('migrate() is idempotent — running it twice does not duplicate seed rows or throw', () => {
  const db = openDatabase(':memory:');
  assert.doesNotThrow(() => migrate(db));
  const configRows = db.prepare('SELECT * FROM app_config').all();
  const integrationRows = db.prepare('SELECT * FROM integrations').all();
  assert.equal(configRows.length, 1);
  assert.equal(integrationRows.length, 4);
});

test('migration sets PRAGMA user_version to SCHEMA_VERSION', () => {
  const db = openDatabase(':memory:');
  const version = db.pragma('user_version', { simple: true });
  assert.equal(version, SCHEMA_VERSION);
});

test('two independent in-memory databases are isolated from each other', () => {
  const dbA = openDatabase(':memory:');
  const dbB = openDatabase(':memory:');
  dbA.prepare("UPDATE app_config SET business_name = 'A' WHERE id = 1").run();
  dbB.prepare("UPDATE app_config SET business_name = 'B' WHERE id = 1").run();
  assert.equal(dbA.prepare('SELECT business_name FROM app_config WHERE id = 1').get().business_name, 'A');
  assert.equal(dbB.prepare('SELECT business_name FROM app_config WHERE id = 1').get().business_name, 'B');
});
