-- src/db/schema.sql — Wispify single-bot SQLite schema.
--
-- Mono-tenant: no slot_id anywhere. One running instance serves exactly one
-- business (design.md "multi-slot -> mono-tenant" collapse). Phase 1 defines
-- app_config + integrations fully (the config/credential layer this PR
-- builds accessors and encryption for); conversations/orders/catalog land
-- with the phases that actually read/write them (Phase 6-9) to avoid
-- shipping speculative columns nobody exercises yet.

CREATE TABLE IF NOT EXISTS app_config (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),  -- exactly one row, always id=1
  business_name       TEXT,
  greeting            TEXT,
  context             TEXT,
  personality         TEXT,
  personality_custom  TEXT,
  currency            TEXT NOT NULL DEFAULT 'MXN',
  timezone            TEXT NOT NULL DEFAULT 'America/Mexico_City',
  admin_phone         TEXT,
  soul_docs           TEXT,
  bot_paused          INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS integrations (
  id                TEXT PRIMARY KEY,                     -- meta | gemini | google_calendar | stripe
  enabled           INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'unconfigured',  -- unconfigured | active | error
  credentials       TEXT,                                  -- AES-256-GCM sealed envelope, never plaintext
  public_meta       TEXT,                                  -- JSON, non-secret (display data + masked hint)
  last_checked_at   TEXT,
  last_error        TEXT
);

-- Bootstrap rows so store.js never has to branch on "row missing" — every
-- accessor below can assume exactly these rows already exist and only UPDATE.
INSERT OR IGNORE INTO app_config (id) VALUES (1);
INSERT OR IGNORE INTO integrations (id) VALUES ('meta');
INSERT OR IGNORE INTO integrations (id) VALUES ('gemini');
INSERT OR IGNORE INTO integrations (id) VALUES ('google_calendar');
INSERT OR IGNORE INTO integrations (id) VALUES ('stripe');

-- Single-admin session store (Phase 3, design.md "one admin_sessions table"
-- replaces the old multi-tenant portal/partner session maps + OTP tables).
-- token is the opaque session cookie value; expires_at is epoch ms for cheap
-- comparison on every authenticated request.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token       TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
