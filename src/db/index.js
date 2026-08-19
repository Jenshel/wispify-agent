'use strict';
// src/db/index.js — better-sqlite3 connection + migration runner.
//
// better-sqlite3 is fully synchronous: a read and its follow-up write inside
// one JS function run back-to-back with no `await` in between, so the class
// of "stale read across an async gap" bugs the old JSON-file store needed
// hand-rolled locks for (see WhiteLabel_WA_System's context.js
// withConversationLock/atomicWriteJSON) cannot happen here structurally —
// this is why design.md picked better-sqlite3 over keeping file-based state.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 4; // v4 adds orders (Phase 9, agent/effects/order.js + routes/payments.js)
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'wispify.db');

/**
 * Open (and migrate) a SQLite database at the given path. Pass ':memory:'
 * for isolated, disk-free tests — every test file should use this instead of
 * touching the real `data/wispify.db`.
 */
function openDatabase(dbPath = DEFAULT_DB_PATH) {
  const isMemory = dbPath === ':memory:';
  if (!isMemory) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  // WAL is meaningless (and unsupported) for :memory: databases.
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL'); // safe with WAL; faster than FULL

  migrate(db);
  return db;
}

/** Apply schema.sql once, tracked via PRAGMA user_version. Safe to call repeatedly. */
function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version >= SCHEMA_VERSION) return;

  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const run = db.transaction(() => {
    db.exec(schemaSql);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  run();
}

let singleton = null;

/**
 * Lazily-created production DB singleton. Path comes from DB_PATH env var or
 * the default `data/wispify.db`. Nothing opens a connection just by
 * require()-ing this module — only the first getDb() call does, so tests
 * that only need openDatabase(':memory:') never touch the real data dir.
 */
function getDb() {
  if (!singleton) singleton = openDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);
  return singleton;
}

module.exports = { openDatabase, migrate, getDb, SCHEMA_VERSION, DEFAULT_DB_PATH };
