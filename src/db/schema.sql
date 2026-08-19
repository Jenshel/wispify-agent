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

-- Appointment bookkeeping for the [CITA_CONFIRMADA] booking effect (Phase 8,
-- src/agent/effects/appointment.js). Google Calendar remains the sole
-- booking backend (spec: "no local-storage fallback") — this table is NOT
-- an alternate backend, it only tracks what this bot has confirmed so the
-- past-time/double-booking guards (Phase 8.1/8.2) and the reminder job
-- (Phase 8.4, src/jobs/appointment-reminders.js) have something to query.
-- Deliberately its own table, not a reuse of the general-purpose `orders`
-- table Phase 9 (Stripe) owns — appointments and paid orders are different
-- concerns/lifecycles; this repo does not overload one polymorphic row
-- shape for both, unlike the source system's `type: 'appointment'` orders.
CREATE TABLE IF NOT EXISTS appointments (
  id                TEXT PRIMARY KEY,
  customer_phone    TEXT NOT NULL,
  service           TEXT NOT NULL,
  date              TEXT NOT NULL,                       -- YYYY-MM-DD, business-local
  time              TEXT NOT NULL,                        -- HH:MM, business-local
  duration_minutes  INTEGER NOT NULL DEFAULT 60,
  payment_method    TEXT,
  total             REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'confirmed',    -- confirmed | cancelled
  google_event_id   TEXT,
  meet_link         TEXT,
  reminder_30_sent  INTEGER NOT NULL DEFAULT 0,
  reminder_5_sent   INTEGER NOT NULL DEFAULT 0,
  no_show_sent      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Orders bookkeeping for the [PEDIDO_CONFIRMADO] checkout effect (Phase 9,
-- src/agent/effects/order.js) + generic Stripe Checkout (src/routes/payments.js).
-- Its own dedicated table, deliberately NOT a reuse of `appointments` above —
-- same "different concern, different lifecycle, don't overload one
-- polymorphic row shape" reasoning PR10 already established for this exact
-- pair of tables (see appointments' own comment) — this table is that flag
-- being honored, not just referenced.
--
-- `currency` is a snapshot taken at order-creation time (not re-read from
-- app_config later), so a currency change in Settings after an order is
-- placed never silently changes what an already-quoted customer is charged.
-- `stripe_session_id`/`stripe_session_url` cache the last Checkout Session
-- GET /pay/:orderId built, reused only while still fresh (see that route's
-- own comment on why — the source system's equivalent `stripeSessionExpired`
-- flag is read but never set anywhere in that codebase, a live bug this port
-- does not repeat).
CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  customer_phone        TEXT NOT NULL,
  products              TEXT NOT NULL,                      -- JSON array [{name, qty, price}]
  total                 REAL NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'MXN',
  status                TEXT NOT NULL DEFAULT 'pending',     -- pending | paid | cancelled
  stripe_session_id     TEXT,
  stripe_session_url    TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Minimal per-conversation bookkeeping for the 4-stage nudge/follow-up
-- system (Phase 10, src/jobs/nudges.js), PORTED (in spirit, not shape) from
-- WhiteLabel_WA_System's conversations.json + per-phone timeline.jsonl.
-- That source system tracked this in a JSON-file "conversations" object
-- (paused/archived/needsHuman/status/lastClientTime/followup/contactName/
-- businessName/messageCount) plus a separate append-only timeline.jsonl per
-- phone for AI context. THIS REPO HAS NEITHER — no conversations table
-- existed before this phase (src/brain/index.js's own header comment:
-- "single-turn only ... no conversations table yet"). Stall-detection,
-- per-stage dedupe, and a contextual nudge message all genuinely need SOME
-- persisted per-conversation state, so this table is Phase 10's own
-- dedicated addition — same "when a phase needs a bookkeeping table a
-- literal task description implies reusing an existing/future table,
-- prefer a dedicated table over overloading a shared polymorphic row shape"
-- precedent PR10 (appointments) and PR11 (orders) already established.
--
-- Deliberately MINIMAL — not the general-purpose message-log subsystem the
-- source's full conversations.json + timeline.jsonl pair implied. Only what
-- stall-detection/dedupe/nudge-context actually needs:
--   * last_client_message_at — the stall clock. Only a REAL inbound
--     customer message resets it (never the bot's own reply).
--   * recent_turns — a small BOUNDED JSON log of the last MAX_RECENT_TURNS
--     (16) {role, content, ts} entries, both sides of the conversation —
--     mirrors the source's timeline.jsonl slice(-16), capped the same way.
--     Not a full messages table; this is nudge AI context only.
--   * stage_N_sent_at — a REAL, persisted dedupe flag per follow-up stage,
--     so a restart can never re-send a stage already sent (the source's
--     equivalent, conv.followup.sent, lived only in the in-memory/JSON
--     snapshot of a single scan cycle's read — this column is read fresh
--     from disk on every scan instead).
--   * contact_name / business_name — nullable; populated by a FUTURE phase
--     that wires the already-existing [DATOS_CONTACTO] effect (see
--     src/agent/effects/contact-data.js's own "FUTURE INJECTION POINT"
--     comment, written in PR9) to upsert onto this row. Deliberately NOT
--     wired in this phase — out of this phase's narrow scope.
--
-- Deliberately NOT built here (still out of scope, carried from PR9's Open
-- Risks, untouched by PR10/PR11 either): conversation-level pause/archived/
-- status/message-limit guards. This table exists for stall-detection/
-- dedupe/context ONLY — nothing in this phase wires it into the
-- webhook/brain call path as a guard, and app_config.bot_paused remains
-- unwired.
CREATE TABLE IF NOT EXISTS conversations (
  customer_phone          TEXT PRIMARY KEY,
  contact_name             TEXT,
  business_name            TEXT,
  last_client_message_at   TEXT,                              -- ISO; stall-detection clock
  recent_turns             TEXT NOT NULL DEFAULT '[]',         -- JSON array, bounded to 16, [{role, content, ts}]
  stage_1_sent_at          TEXT,
  stage_2_sent_at          TEXT,
  stage_3_sent_at          TEXT,
  stage_4_sent_at          TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
