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
// conversation-level pause/archived/status/message-limit guards.
// [DATOS_CONTACTO] persistence (contact_name/business_name) is wired via
// setContactInfo() below, closing the "FUTURE INJECTION POINT" PR9's
// contact-data.js documented — see that module for the effect-handler side.
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
  const lastClientMessageAt = row.last_client_message_at;
  const lastReadAt = row.last_read_at;
  // "Unread" is DERIVED, never a stored boolean (Phase 11, tasks.md 11.1) —
  // a conversation is unread when the client's last message is newer than
  // the last time an admin opened the thread (or the thread was never
  // opened at all). Both timestamps are ISO-8601 UTC strings from the same
  // `new Date().toISOString()` source, so plain string comparison is a
  // valid, cheap chronological compare — no Date parsing needed.
  const unread = !!lastClientMessageAt && (!lastReadAt || lastReadAt < lastClientMessageAt);
  return {
    customerPhone: row.customer_phone,
    contactName: row.contact_name,
    businessName: row.business_name,
    lastClientMessageAt,
    recentTurns: JSON.parse(row.recent_turns || '[]'),
    pinned: !!row.pinned,
    archived: !!row.archived,
    lastReadAt,
    unread,
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

function appendTurn(db, customerPhone, { role, content, now, mediaUrl, mediaType }) {
  ensureConversation(db, customerPhone);
  const row = db.prepare('SELECT recent_turns FROM conversations WHERE customer_phone = ?').get(customerPhone);
  const turns = JSON.parse(row?.recent_turns || '[]');
  const entry = { role, content, ts: now };
  // Optional, backward-compatible (Phase 11, tasks.md 11.2/gap 4): older
  // entries simply don't have these keys — JSON.parse of a turn missing
  // mediaUrl/mediaType still works fine, ChatView just renders text-only.
  if (mediaUrl) entry.mediaUrl = mediaUrl;
  if (mediaType) entry.mediaType = mediaType;
  turns.push(entry);
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
function recordClientMessage(db, customerPhone, { text, mediaUrl, mediaType, now = new Date().toISOString() } = {}) {
  ensureConversation(db, customerPhone);
  db.prepare('UPDATE conversations SET last_client_message_at = @now WHERE customer_phone = @phone').run({
    phone: customerPhone,
    now,
  });
  appendTurn(db, customerPhone, { role: 'user', content: text || '', now, mediaUrl, mediaType });
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

// ── Phase 11 (tasks.md 11.1): panel-only bookkeeping ────────────────────
// pinned/archived are panel organization only — NOT a bot guard (the
// per-conversation pause/status/message-limit guards flagged in PR9-PR12
// remain deliberately out of scope; only the GLOBAL app_config.bot_paused
// flag is wired, in src/channels/whatsapp/webhook.js, not here).

function setPinned(db, customerPhone, pinned) {
  ensureConversation(db, customerPhone);
  db.prepare(
    `UPDATE conversations SET pinned = @pinned, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE customer_phone = @phone`
  ).run({ phone: customerPhone, pinned: pinned ? 1 : 0 });
  return getConversation(db, customerPhone);
}

function setArchived(db, customerPhone, archived) {
  ensureConversation(db, customerPhone);
  db.prepare(
    `UPDATE conversations SET archived = @archived, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE customer_phone = @phone`
  ).run({ phone: customerPhone, archived: archived ? 1 : 0 });
  return getConversation(db, customerPhone);
}

/** Stamps last_read_at — the ONLY thing that clears the derived "unread" state (see toCamel()). */
function markRead(db, customerPhone, { now = new Date().toISOString() } = {}) {
  ensureConversation(db, customerPhone);
  db.prepare(
    `UPDATE conversations SET last_read_at = @now, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE customer_phone = @phone`
  ).run({ phone: customerPhone, now });
  return getConversation(db, customerPhone);
}

/**
 * Persist a [DATOS_CONTACTO] capture onto the conversation row (PR17 —
 * closes the "FUTURE INJECTION POINT" src/agent/effects/contact-data.js
 * documented since PR9). Same ensureConversation()-first + partial-UPDATE
 * shape as setPinned()/setArchived()/markRead() above.
 *
 * Only writes a field that is actually non-empty — src/agent/tags.js's
 * parseContactFields() returns '' (never undefined/null) for a field the
 * model didn't include in the tag body, and a later partial capture (e.g.
 * name only, no negocio) must never blank out a value already captured.
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerPhone
 * @param {{contactName?: string, businessName?: string}} [fields]
 */
function setContactInfo(db, customerPhone, { contactName, businessName } = {}) {
  ensureConversation(db, customerPhone);
  const sets = [];
  const params = { phone: customerPhone };
  if (contactName) {
    sets.push('contact_name = @contactName');
    params.contactName = contactName;
  }
  if (businessName) {
    sets.push('business_name = @businessName');
    params.businessName = businessName;
  }
  if (!sets.length) return getConversation(db, customerPhone);
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
  db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE customer_phone = @phone`).run(params);
  return getConversation(db, customerPhone);
}

/**
 * All conversations for the panel's ChatView list (tasks.md Phase 11.1) —
 * unlike listConversationsWithActivity() above (the nudge scan's source,
 * which requires a real client message), this includes every row so a
 * conversation created by e.g. an unsupported-type inbound message still
 * shows up. Sorted pinned-first, then most-recent activity
 * (lastClientMessageAt, falling back to updatedAt) descending. Archived
 * rows are excluded unless includeArchived is true.
 */
function listConversations(db, { includeArchived = false } = {}) {
  const rows = db.prepare('SELECT * FROM conversations').all().map(toCamel);
  const visible = includeArchived ? rows : rows.filter((c) => !c.archived);
  visible.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aTime = a.lastClientMessageAt || a.updatedAt || '';
    const bTime = b.lastClientMessageAt || b.updatedAt || '';
    return bTime.localeCompare(aTime);
  });
  return visible;
}

module.exports = {
  MAX_RECENT_TURNS,
  getConversation,
  recordClientMessage,
  recordBotMessage,
  listConversationsWithActivity,
  markStageSent,
  setContactInfo,
  setPinned,
  setArchived,
  markRead,
  listConversations,
};
