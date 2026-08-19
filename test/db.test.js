'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

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

test('a fresh database has the v6 conversations columns (pinned/archived/last_read_at)', () => {
  const db = openDatabase(':memory:');
  const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  assert.ok(cols.includes('pinned'));
  assert.ok(cols.includes('archived'));
  assert.ok(cols.includes('last_read_at'));
});

test('migrate() adds pinned/archived/last_read_at to an existing v5-shape conversations table without losing data', () => {
  // Hand-build a v5-shape database (schema BEFORE this PR's column
  // additions) to prove an already-migrated install gets the new columns
  // via migrate(), not just a brand-new database — this is the real bug
  // src/db/index.js's applyColumnMigrations() fixes (schema.sql's own
  // `CREATE TABLE IF NOT EXISTS` is a silent no-op here).
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_config (id INTEGER PRIMARY KEY CHECK (id = 1));
    INSERT INTO app_config (id) VALUES (1);
    CREATE TABLE conversations (
      customer_phone TEXT PRIMARY KEY,
      contact_name TEXT,
      business_name TEXT,
      last_client_message_at TEXT,
      recent_turns TEXT NOT NULL DEFAULT '[]',
      stage_1_sent_at TEXT, stage_2_sent_at TEXT, stage_3_sent_at TEXT, stage_4_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO conversations (customer_phone, last_client_message_at) VALUES ('5215500000001', '2030-01-01T00:00:00.000Z');
  `);
  db.pragma('user_version = 5');

  migrate(db);

  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  const row = db.prepare('SELECT * FROM conversations WHERE customer_phone = ?').get('5215500000001');
  assert.equal(row.last_client_message_at, '2030-01-01T00:00:00.000Z', 'existing data must survive the migration');
  assert.equal(row.pinned, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.last_read_at, null);
});

test('two independent in-memory databases are isolated from each other', () => {
  const dbA = openDatabase(':memory:');
  const dbB = openDatabase(':memory:');
  dbA.prepare("UPDATE app_config SET business_name = 'A' WHERE id = 1").run();
  dbB.prepare("UPDATE app_config SET business_name = 'B' WHERE id = 1").run();
  assert.equal(dbA.prepare('SELECT business_name FROM app_config WHERE id = 1').get().business_name, 'A');
  assert.equal(dbB.prepare('SELECT business_name FROM app_config WHERE id = 1').get().business_name, 'B');
});
