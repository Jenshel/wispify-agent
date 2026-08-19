'use strict';
// RED->GREEN for src/auth/middleware.js — requireAuth() guard used by both
// routes/settings.js (every endpoint) and routes/auth.js (GET /me).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const sessionsStore = require('../src/auth/sessions');
const { requireAuth } = require('../src/auth/middleware');

function freshDb() {
  return openDatabase(':memory:');
}

function fakeRes() {
  let statusCode = null;
  let jsonBody = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
    getStatus: () => statusCode,
    getJson: () => jsonBody,
  };
}

test('requireAuth() calls next() and attaches req.admin when the session cookie is valid', () => {
  const db = freshDb();
  const token = sessionsStore.createSession(db, { ttlMs: 60_000 });
  const middleware = requireAuth(db);
  const req = { headers: { cookie: `session=${token}` } };
  const res = fakeRes();
  let called = false;
  middleware(req, res, () => { called = true; });

  assert.equal(called, true);
  assert.ok(req.admin);
  assert.equal(res.getStatus(), null);
});

test('requireAuth() returns 401 without calling next() when there is no session cookie', () => {
  const db = freshDb();
  const middleware = requireAuth(db);
  const req = { headers: {} };
  const res = fakeRes();
  let called = false;
  middleware(req, res, () => { called = true; });

  assert.equal(called, false);
  assert.equal(res.getStatus(), 401);
  assert.deepEqual(res.getJson(), { error: 'unauthorized' });
});

test('requireAuth() returns 401 for an unknown/expired session token', () => {
  const db = freshDb();
  const middleware = requireAuth(db);
  const req = { headers: { cookie: 'session=not-a-real-token' } };
  const res = fakeRes();
  let called = false;
  middleware(req, res, () => { called = true; });

  assert.equal(called, false);
  assert.equal(res.getStatus(), 401);
});
