'use strict';
// src/db/conversations.js — conversations table accessors (tasks.md Phase 10).
//
// Minimal per-conversation bookkeeping src/jobs/nudges.js actually needs:
// WHEN a customer last said something for real (stall detection), a small
// bounded recent-turns log for nudge AI context (mirrors the source
// system's per-phone timeline.jsonl, capped the same way — maxEntries=16),
// and a real DB-backed dedupe flag per follow-up stage so a restart can
// never re-send a stage already sent (see schema.sql's own comment on this
// table for the full "why a dedicated table" reasoning, same precedent
// PR10/PR11 established for appointments/orders).
//
// Deliberately NOT built here (still out of scope — see schema.sql):
// conversation-level pause/archived/status/message-limit guards, and
// wiring [DATOS_CONTACTO] to populate contact_name/business_name (a
// documented future injection point from PR9's contact-data.js).
//
// Every accessor takes `db` explicitly, same convention as
// src/db/appointments.js/src/db/orders.js, so tests always run against an
// isolated `:memory:` database.

const MAX_RECENT_TURNS = 16;

const STAGE_COLUMNS = {
  1: 'stage_1_sent_at',
  2: 'stage_2_sent_at',
  3: 'stage_3_sent_at',
  4: 'stage_4_sent_at',
};

function toCamel(row) {
  if (!row) return null;
  return {
    customerPhone: row.customer_phone,
    contactName: row.contact_name,
    businessName: row.business_name,
    lastClientMessageAt: row.last_client_message_at,
    recentTurns: JSON.parse(row.recent_turns || '[]'),
    stageSentAt: {
      1: row.stage_1_sent_at,
      2: row.stage_2_sent_at,
      3: row.stage_3_sent_at,
      4: row.stage_4_sent_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getConversation(db, customerPhone) {
  return toCamel(db.prepare('SELECT * FROM conversations WHERE customer_phone = ?').get(customerPhone));
}

function ensureConversation(db, customerPhone) {
  db.prepare('INSERT OR IGNORE INTO conversations (customer_phone) VALUES (?)').run(customerPhone);
}

function appendTurn(db, customerPhone, { role, content, now }) {
  ensureConversation(db, customerPhone);
  const row = db.prepare('SELECT recent_turns FROM conversations WHERE customer_phone = ?').get(customerPhone);
  const turns = JSON.parse(row?.recent_turns || '[]');
  turns.push({ role, content, ts: now });
  const bounded = turns.slice(-MAX_RECENT_TURNS);
  db.prepare(
    `UPDATE conversations SET recent_turns = @turns, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE customer_phone = @phone`
  ).run({ phone: customerPhone, turns: JSON.stringify(bounded) });
}

/**
 * Record a REAL inbound customer message — the ONLY place this should be
 * called from is src/channels/whatsapp/webhook.js's handleIncomingMessage
 * (tasks.md Phase 10), the sole place inbound messages are currently
 * observed. Updates the stall-detection clock AND appends to the bounded
 * recent-turns log in one call.
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerPhone
 * @param {{text: string, now?: string}} [input]
 */
function recordClientMessage(db, customerPhone, { text, now = new Date().toISOString() } = {}) {
  ensureConversation(db, customerPhone);
  db.prepare('UPDATE conversations SET last_client_message_at = @now WHERE customer_phone = @phone').run({
    phone: customerPhone,
    now,
  });
  appendTurn(db, customerPhone, { role: 'user', content: text || '', now });
  return getConversation(db, customerPhone);
}

/**
 * Record the bot's own reply, appended to the SAME bounded log so nudge
 * context includes both sides of the conversation (mirrors the source
 * system's timeline.jsonl). Called from webhook.js AFTER
 * client.sendPacedReply() succeeds. Deliberately does NOT touch
 * last_client_message_at — only a real customer message resets the stall
 * clock, otherwise the bot's own reply would look like a "response" and
 * mask a genuine stall.
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerPhone
 * @param {{text: string, now?: string}} [input]
 */
function recordBotMessage(db, customerPhone, { text, now = new Date().toISOString() } = {}) {
  appendTurn(db, customerPhone, { role: 'bot', content: text || '', now });
  return getConversation(db, customerPhone);
}

/** Conversations with at least one recorded client message — the nudge scan's source (tasks.md 10.1). */
function listConversationsWithActivity(db) {
  return db.prepare('SELECT * FROM conversations WHERE last_client_message_at IS NOT NULL').all().map(toCamel);
}

/**
 * Real DB-backed dedupe write — survives a restart, unlike the source's
 * in-memory conv.followup.sent map (see this table's schema.sql comment).
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerPhone
 * @param {1|2|3|4} stage
 * @param {{now?: string}} [opts]
 */
function markStageSent(db, customerPhone, stage, { now = new Date().toISOString() } = {}) {
  const column = STAGE_COLUMNS[stage];
  if (!column) {
    throw new Error(`unknown follow-up stage: ${JSON.stringify(stage)} (expected one of ${Object.keys(STAGE_COLUMNS).join(', ')})`);
  }
  db.prepare(`UPDATE conversations SET ${column} = @now WHERE customer_phone = @phone`).run({
    phone: customerPhone,
    now,
  });
  return getConversation(db, customerPhone);
}

module.exports = {
  MAX_RECENT_TURNS,
  getConversation,
  recordClientMessage,
  recordBotMessage,
  listConversationsWithActivity,
  markStageSent,
};
