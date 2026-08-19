'use strict';
// RED->GREEN for src/routes/conversations.js (tasks.md Phase 11, gap #1 —
// no REST API to list/read/mutate conversations existed at all before this
// PR). Same admin-session-only pattern as src/routes/settings.js/files.js —
// every endpoint requires requireAuth. Read/write goes through
// src/db/conversations.js accessors only; no raw SQL here.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { httpGet, httpPost, httpPatch, parseCookie } = require('./helper');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');
const conversationsDb = require('../src/db/conversations');

let prevUsername, prevPassword;
before(() => {
  prevUsername = process.env.ADMIN_USERNAME;
  prevPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = 'testadmin';
  process.env.ADMIN_PASSWORD = 'TestAdmin1!';
});
after(() => {
  if (prevUsername === undefined) delete process.env.ADMIN_USERNAME;
  else process.env.ADMIN_USERNAME = prevUsername;
  if (prevPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = prevPassword;
});

async function bootServer() {
  const db = openDatabase(':memory:');
  const app = createApp({ db });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${s.address().port}`,
        db,
        close: () => new Promise((r) => s.close(() => r())),
      })
    );
  });
  return server;
}

async function loginAndGetCookie(server) {
  const res = await httpPost(server, '/api/auth/login', { username: 'testadmin', password: 'TestAdmin1!' });
  return parseCookie(res.headers['set-cookie']).value;
}

function authHeaders(cookie) {
  return { headers: { Cookie: `session=${cookie}` } };
}

// ── auth guard ───────────────────────────────────────────────────────────

test('GET /api/conversations — 401 without a session', async () => {
  const server = await bootServer();
  const res = await httpGet(server, '/api/conversations');
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('GET /api/conversations/:phone — 401 without a session', async () => {
  const server = await bootServer();
  const res = await httpGet(server, '/api/conversations/5215500000001');
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('PATCH /api/conversations/:phone — 401 without a session', async () => {
  const server = await bootServer();
  const res = await httpPatch(server, '/api/conversations/5215500000001', { pinned: true });
  assert.equal(res.statusCode, 401);
  await server.close();
});

// ── GET /api/conversations (list) ─────────────────────────────────────────

test('GET /api/conversations — sorted pinned-first then most-recent activity, archived excluded by default', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);

  conversationsDb.recordClientMessage(server.db, '5215500000001', { text: 'a', now: '2030-01-15T10:00:00.000Z' });
  conversationsDb.recordClientMessage(server.db, '5215500000002', { text: 'b', now: '2030-01-15T11:00:00.000Z' });
  conversationsDb.recordClientMessage(server.db, '5215500000003', { text: 'c', now: '2030-01-15T09:00:00.000Z' });
  conversationsDb.setPinned(server.db, '5215500000003', true);
  conversationsDb.setArchived(server.db, '5215500000002', true);

  const res = await httpGet(server, '/api/conversations', authHeaders(cookie));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json.map((c) => c.customerPhone),
    ['5215500000003', '5215500000001']
  );
  await server.close();
});

test('GET /api/conversations?archived=1 — includes archived conversations', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);

  conversationsDb.recordClientMessage(server.db, '5215500000001', { text: 'a', now: '2030-01-15T10:00:00.000Z' });
  conversationsDb.setArchived(server.db, '5215500000001', true);

  const withoutArchived = await httpGet(server, '/api/conversations', authHeaders(cookie));
  assert.equal(withoutArchived.json.length, 0);

  const withArchived = await httpGet(server, '/api/conversations?archived=1', authHeaders(cookie));
  assert.equal(withArchived.json.length, 1);
  await server.close();
});

// ── GET /api/conversations/:phone (detail) ────────────────────────────────

test('GET /api/conversations/:phone — 404 for an unknown phone', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpGet(server, '/api/conversations/5219999999999', authHeaders(cookie));
  assert.equal(res.statusCode, 404);
  await server.close();
});

test('GET /api/conversations/:phone — returns the full conversation including recentTurns', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  conversationsDb.recordClientMessage(server.db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  conversationsDb.recordBotMessage(server.db, '5215500000001', { text: 'Hola! como ayudo?', now: '2030-01-15T10:00:05.000Z' });

  const res = await httpGet(server, '/api/conversations/5215500000001', authHeaders(cookie));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.customerPhone, '5215500000001');
  assert.equal(res.json.recentTurns.length, 2);
  assert.equal(res.json.recentTurns[0].role, 'user');
  assert.equal(res.json.recentTurns[1].role, 'bot');
  await server.close();
});

// ── PATCH /api/conversations/:phone (partial update) ──────────────────────

test('PATCH /api/conversations/:phone — 404 for an unknown phone', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpPatch(server, '/api/conversations/5219999999999', { pinned: true }, authHeaders(cookie));
  assert.equal(res.statusCode, 404);
  await server.close();
});

test('PATCH /api/conversations/:phone — 400 when no known field is given', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  conversationsDb.recordClientMessage(server.db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });
  const res = await httpPatch(server, '/api/conversations/5215500000001', {}, authHeaders(cookie));
  assert.equal(res.statusCode, 400);
  await server.close();
});

test('PATCH /api/conversations/:phone {pinned: true} — pins the conversation', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  conversationsDb.recordClientMessage(server.db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });

  const res = await httpPatch(server, '/api/conversations/5215500000001', { pinned: true }, authHeaders(cookie));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.pinned, true);
  await server.close();
});

test('PATCH /api/conversations/:phone {archived: true} — archives the conversation', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  conversationsDb.recordClientMessage(server.db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });

  const res = await httpPatch(server, '/api/conversations/5215500000001', { archived: true }, authHeaders(cookie));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.archived, true);
  await server.close();
});

test('PATCH /api/conversations/:phone {markRead: true} — clears the derived unread state', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  // The route's markRead() stamps the REAL current time (no client-supplied
  // `now` — this is a server-authoritative admin action, same convention as
  // every other server-timestamped write in this repo) — seed a
  // lastClientMessageAt safely in the past so it is unambiguously older
  // than "now" whenever this test actually runs.
  conversationsDb.recordClientMessage(server.db, '5215500000001', { text: 'Hola', now: '2020-01-15T10:00:00.000Z' });

  const before = await httpGet(server, '/api/conversations/5215500000001', authHeaders(cookie));
  assert.equal(before.json.unread, true);

  const res = await httpPatch(server, '/api/conversations/5215500000001', { markRead: true }, authHeaders(cookie));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.unread, false);
  await server.close();
});

test('PATCH /api/conversations/:phone — rejects a non-boolean pinned value', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  conversationsDb.recordClientMessage(server.db, '5215500000001', { text: 'Hola', now: '2030-01-15T10:00:00.000Z' });

  const res = await httpPatch(server, '/api/conversations/5215500000001', { pinned: 'yes' }, authHeaders(cookie));
  assert.equal(res.statusCode, 400);
  await server.close();
});
