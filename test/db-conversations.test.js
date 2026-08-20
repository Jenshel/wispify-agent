'use strict';
// RED->GREEN for src/db/conversations.js (tasks.md Phase 10) — the minimal
// per-conversation bookkeeping src/jobs/nudges.js needs: WHEN a customer
// last said something for real (stall detection), a small bounded
// recent-turns log for nudge AI context (mirrors the source system's
// per-phone timeline.jsonl, capped the same way — maxEntries=16), and a
// real DB-backed dedupe flag per follow-up stage (survives a restart,
// unlike the source's in-memory conv.followup.sent map — this job runs
// unconditionally at boot like src/jobs/appointment-reminders.js).
//
// See schema.sql's own comment on this table for why it's dedicated,
// not a reuse of appointments/orders.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const conversations = require('../src/db/conversations');

function freshDb() {
  return openDatabase(':memory:');
}

test('getConversation() returns null for a phone with no row yet', () => {
  const db = freshDb();
  assert.equal(conversations.getConversation(db, '5215500000001'), null);
});

test('recordClientMessage() creates the row on first contact and sets lastClientMessageAt', () => {
  const db = freshDb();
  const now = '2030-01-15T10:00:00.000Z';
  const conv = conversations.recordClientMessage(db, '5215500000001', { text: 'Hola, quiero info', now });
  assert.equal(conv.customerPhone, '5215500000001');
  assert.equal(conv.lastClientMessageAt, now);
  assert.equal(conv.recentTurns.length, 1);
  assert.equal(conv.recentTurns[0].role, 'user');
  assert.equal(conv.recentTurns[0].content, 'Hola, quiero info');
  assert.equal(conv.recentTurns[0].ts, now);
  assert.equal(conv.contactName, null);
  assert.equal(conv.businessName, null);
});

test('recordClientMessage() UPDATES lastClientMessageAt on a repeat contact instead of duplicating the row', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'primero', now: '2030-01-15T10:00:00.000Z' });
  const second = conversations.recordClientMessage(db, '5215500000001', { text: 'segundo', now: '2030-01-15T10:20:00.000Z' });
  assert.equal(second.lastClientMessageAt, '2030-01-15T10:20:00.000Z');
  assert.equal(second.recentTurns.length, 2);
  const allRows = db.prepare('SELECT * FROM conversations').all();
  assert.equal(allRows.length, 1);
});

test('recordBotMessage() appends to the same bounded log WITHOUT touching lastClientMessageAt', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  const conv = conversations.recordBotMessage(db, '5215500000001', { text: 'Hola! Como puedo ayudarte?', now: '2030-01-15T10:00:05.000Z' });
  assert.equal(conv.lastClientMessageAt, '2030-01-15T10:00:00.000Z');
  assert.equal(conv.recentTurns.length, 2);
  assert.equal(conv.recentTurns[1].role, 'bot');
  assert.equal(conv.recentTurns[1].content, 'Hola! Como puedo ayudarte?');
});

test('recordBotMessage() creates the row if a bot reply somehow arrives before any recorded client message', () => {
  const db = freshDb();
  const conv = conversations.recordBotMessage(db, '5215500000009', { text: 'hola', now: '2030-01-15T10:00:00.000Z' });
  assert.equal(conv.customerPhone, '5215500000009');
  assert.equal(conv.lastClientMessageAt, null);
  assert.equal(conv.recentTurns.length, 1);
});

test('recent-turns log is bounded to MAX_RECENT_TURNS (16) entries — oldest entries drop off', () => {
  const db = freshDb();
  for (let i = 0; i < 20; i++) {
    conversations.recordClientMessage(db, '5215500000001', { text: `msg ${i}`, now: `2030-01-15T10:${String(i).padStart(2, '0')}:00.000Z` });
  }
  const conv = conversations.getConversation(db, '5215500000001');
  assert.equal(conv.recentTurns.length, conversations.MAX_RECENT_TURNS);
  assert.equal(conv.recentTurns.length, 16);
  // The 4 oldest (msg 0-3) fell off; the log keeps msg 4..19.
  assert.equal(conv.recentTurns[0].content, 'msg 4');
  assert.equal(conv.recentTurns[15].content, 'msg 19');
});

test('markStageSent() writes a real, persisted timestamp for the given stage without touching the others', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  const conv = conversations.markStageSent(db, '5215500000001', 1, { now: '2030-01-15T10:15:00.000Z' });
  assert.equal(conv.stageSentAt[1], '2030-01-15T10:15:00.000Z');
  assert.equal(conv.stageSentAt[2], null);
  assert.equal(conv.stageSentAt[3], null);
  assert.equal(conv.stageSentAt[4], null);
});

test('markStageSent() persists across a fresh read — a real DB write, not in-memory state', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  conversations.markStageSent(db, '5215500000001', 2, { now: '2030-01-15T11:00:00.000Z' });
  const reread = conversations.getConversation(db, '5215500000001');
  assert.equal(reread.stageSentAt[2], '2030-01-15T11:00:00.000Z');
});

test('markStageSent() throws on an unknown stage rather than silently no-op-ing', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  assert.throws(() => conversations.markStageSent(db, '5215500000001', 5, {}));
});

test('listConversationsWithActivity() only returns conversations that have at least one recorded client message', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  conversations.recordBotMessage(db, '5215500000002', { text: 'nunca hubo cliente aqui', now: '2030-01-15T10:00:00.000Z' });
  const active = conversations.listConversationsWithActivity(db);
  assert.equal(active.length, 1);
  assert.equal(active[0].customerPhone, '5215500000001');
});

// ── Phase 11 (tasks.md 11.1): pinned/archived/unread + panel list ─────────

test('a brand new conversation is pinned:false, archived:false, unread:false (no client message yet)', () => {
  const db = freshDb();
  const conv = conversations.recordBotMessage(db, '5215500000020', { text: 'hola', now: '2030-01-15T10:00:00.000Z' });
  assert.equal(conv.pinned, false);
  assert.equal(conv.archived, false);
  assert.equal(conv.unread, false);
  assert.equal(conv.lastReadAt, null);
});

test('a conversation is unread as soon as a client message arrives and no read has been recorded yet', () => {
  const db = freshDb();
  const conv = conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  assert.equal(conv.unread, true);
});

test('markRead() clears unread — unread is derived from last_read_at vs last_client_message_at, not a stored flag', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  const read = conversations.markRead(db, '5215500000001', { now: '2030-01-15T10:05:00.000Z' });
  assert.equal(read.unread, false);
  assert.equal(read.lastReadAt, '2030-01-15T10:05:00.000Z');

  // A NEW client message after the read must flip it back to unread.
  const again = conversations.recordClientMessage(db, '5215500000001', { text: 'sigues ahi?', now: '2030-01-15T10:10:00.000Z' });
  assert.equal(again.unread, true);
});

test('setPinned() toggles pinned and persists', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  const pinned = conversations.setPinned(db, '5215500000001', true);
  assert.equal(pinned.pinned, true);
  const reread = conversations.getConversation(db, '5215500000001');
  assert.equal(reread.pinned, true);
  const unpinned = conversations.setPinned(db, '5215500000001', false);
  assert.equal(unpinned.pinned, false);
});

test('setArchived() toggles archived and persists', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  const archived = conversations.setArchived(db, '5215500000001', true);
  assert.equal(archived.archived, true);
  const reread = conversations.getConversation(db, '5215500000001');
  assert.equal(reread.archived, true);
});

test('recordClientMessage() optionally carries mediaUrl/mediaType through onto the recorded turn', () => {
  const db = freshDb();
  const conv = conversations.recordClientMessage(db, '5215500000001', {
    text: '[El cliente envió una imagen]',
    mediaUrl: '/api/media/client/5215500000001/123.jpeg',
    mediaType: 'image/jpeg',
    now: '2030-01-15T10:00:00.000Z',
  });
  assert.equal(conv.recentTurns[0].mediaUrl, '/api/media/client/5215500000001/123.jpeg');
  assert.equal(conv.recentTurns[0].mediaType, 'image/jpeg');
});

test('recordClientMessage() without mediaUrl/mediaType still works — old-shape turns remain backward-compatible', () => {
  const db = freshDb();
  const conv = conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  assert.equal(conv.recentTurns[0].mediaUrl, undefined);
  assert.equal(conv.recentTurns[0].mediaType, undefined);
});

test('listConversations() sorts pinned-first, then most-recent client activity, excludes archived by default', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'a', now: '2030-01-15T10:00:00.000Z' });
  conversations.recordClientMessage(db, '5215500000002', { text: 'b', now: '2030-01-15T11:00:00.000Z' });
  conversations.recordClientMessage(db, '5215500000003', { text: 'c', now: '2030-01-15T09:00:00.000Z' });
  conversations.setPinned(db, '5215500000003', true);
  conversations.setArchived(db, '5215500000002', true);

  const list = conversations.listConversations(db);
  // 5215500000003 is pinned -> first, even though its activity is oldest.
  // 5215500000002 is archived -> excluded by default.
  // 5215500000001 is the only remaining unpinned one -> second.
  assert.deepEqual(list.map((c) => c.customerPhone), ['5215500000003', '5215500000001']);
});

test('listConversations({includeArchived: true}) includes archived rows', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'a', now: '2030-01-15T10:00:00.000Z' });
  conversations.setArchived(db, '5215500000001', true);

  assert.equal(conversations.listConversations(db).length, 0);
  assert.equal(conversations.listConversations(db, { includeArchived: true }).length, 1);
});

// ── setContactInfo() — [DATOS_CONTACTO] persistence (PR17) ───────────────

test('setContactInfo() creates the row (if it does not exist yet) and writes both fields', () => {
  const db = freshDb();
  const conv = conversations.setContactInfo(db, '5215500000001', { contactName: 'Ana', businessName: 'Bella Studio' });
  assert.equal(conv.contactName, 'Ana');
  assert.equal(conv.businessName, 'Bella Studio');
  const reread = conversations.getConversation(db, '5215500000001');
  assert.equal(reread.contactName, 'Ana');
  assert.equal(reread.businessName, 'Bella Studio');
});

test('setContactInfo() writes only the non-empty field(s) given', () => {
  const db = freshDb();
  conversations.setContactInfo(db, '5215500000001', { contactName: 'Ana', businessName: 'Bella Studio' });
  const conv = conversations.setContactInfo(db, '5215500000001', { contactName: '', businessName: 'Studio Renamed' });
  assert.equal(conv.businessName, 'Studio Renamed');
  assert.equal(conv.contactName, 'Ana'); // untouched by the empty-string field
});

test('setContactInfo() never blanks out a previously-captured value with an empty string', () => {
  const db = freshDb();
  conversations.setContactInfo(db, '5215500000001', { contactName: 'Ana', businessName: 'Bella Studio' });
  const conv = conversations.setContactInfo(db, '5215500000001', { contactName: '', businessName: '' });
  assert.equal(conv.contactName, 'Ana');
  assert.equal(conv.businessName, 'Bella Studio');
});

test('setContactInfo() with both fields empty/omitted is a no-op that still returns the current row', () => {
  const db = freshDb();
  conversations.recordClientMessage(db, '5215500000001', { text: 'hola', now: '2030-01-15T10:00:00.000Z' });
  const conv = conversations.setContactInfo(db, '5215500000001', {});
  assert.equal(conv.contactName, null);
  assert.equal(conv.businessName, null);
});
