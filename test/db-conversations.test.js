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
