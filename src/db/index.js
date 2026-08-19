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

const SCHEMA_VERSION = 6; // v6 adds conversations.{pinned,archived,last_read_at} (Phase 11, panel ChatView)
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// ── Column-level migrations ──────────────────────────────────────────────
// schema.sql's `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
// already exists — perfect for adding brand-new tables across versions
// (v2-v5 only ever did that), but it silently does NOTHING when a version
// needs to add a COLUMN to a table that already exists from an earlier
// version. Schema v6 (Phase 11) is the first to hit this — conversations
// shipped in v5, and this phase adds pinned/archived/last_read_at onto it.
// A real gap in the old "just replay the whole file" approach: it would
// never have applied these columns to an already-migrated v5 install, only
// to a brand-new database (where schema.sql's own CREATE TABLE already
// includes them). Fixed here instead of silently reproduced — same
// "port/build real fixes, not latent bugs" precedent this repo's own
// history already established (PR11's Stripe session-expiry flag). Each
// entry is checked against the live column list first, so it is always
// safe to run unconditionally, regardless of which version a database is
// migrating from.
const COLUMN_MIGRATIONS = [
  { table: 'conversations', column: 'pinned', ddl: 'ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0' },
  { table: 'conversations', column: 'archived', ddl: 'ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0' },
  { table: 'conversations', column: 'last_read_at', ddl: 'ALTER TABLE conversations ADD COLUMN last_read_at TEXT' },
];

function applyColumnMigrations(db) {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  }
}

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
    applyColumnMigrations(db);
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
