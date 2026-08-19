'use strict';
// RED->GREEN for src/auth/sessions.js — SQLite-backed admin session store +
// HttpOnly/Secure/SameSite cookie helpers (mono-tenant: one admin account,
// no users table — routes/auth.js checks ADMIN_USERNAME/ADMIN_PASSWORD from
// env directly and only this module persists the resulting session token).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const sessions = require('../src/auth/sessions');

function freshDb() {
  return openDatabase(':memory:');
}

test('createSession() persists a token that getSession() can read back before it expires', () => {
  const db = freshDb();
  const token = sessions.createSession(db, { ttlMs: 60_000 });
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);

  const rec = sessions.getSession(db, token);
  assert.ok(rec);
  assert.equal(typeof rec.expiresAt, 'number');
});

test('getSession() returns null for an unknown token', () => {
  const db = freshDb();
  assert.equal(sessions.getSession(db, 'not-a-real-token'), null);
});

test('getSession() returns null and deletes the row once the token has expired', () => {
  const db = freshDb();
  const token = sessions.createSession(db, { ttlMs: -1 }); // already expired
  assert.equal(sessions.getSession(db, token), null);
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
  assert.equal(row, undefined);
});

test('deleteSession() removes the row so a later getSession() returns null', () => {
  const db = freshDb();
  const token = sessions.createSession(db, { ttlMs: 60_000 });
  sessions.deleteSession(db, token);
  assert.equal(sessions.getSession(db, token), null);
});

test('setSessionCookie() sets an HttpOnly, Secure, SameSite=Strict cookie named "session"', () => {
  let header;
  const res = { setHeader: (name, value) => { assert.equal(name, 'Set-Cookie'); header = value; } };
  sessions.setSessionCookie(res, 'abc123', { ttlMs: 60_000 });
  assert.match(header, /^session=abc123;/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
});

test('clearSessionCookie() expires the cookie immediately', () => {
  let header;
  const res = { setHeader: (name, value) => { header = value; } };
  sessions.clearSessionCookie(res);
  assert.match(header, /^session=;/);
  assert.match(header, /Max-Age=0/);
});

test('getTokenFromRequest() extracts the session cookie value from a raw Cookie header', () => {
  const req = { headers: { cookie: 'other=x; session=the-token-value; another=y' } };
  assert.equal(sessions.getTokenFromRequest(req), 'the-token-value');
});

test('getTokenFromRequest() returns null when there is no cookie header or no session cookie', () => {
  assert.equal(sessions.getTokenFromRequest({ headers: {} }), null);
  assert.equal(sessions.getTokenFromRequest({ headers: { cookie: 'other=x' } }), null);
});
