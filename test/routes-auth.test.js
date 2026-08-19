'use strict';
// RED->GREEN for src/routes/auth.js — mono-tenant single-admin session flow
// (design.md: "portal/partner/client sessions, OTP maps deleted; one
// admin_sessions table"). Credentials come from ADMIN_USERNAME/ADMIN_PASSWORD
// env vars — there is no users table in a single-admin app.
//
// threat-matrix (e): rate limit on brute-force login attempts.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, httpGet, httpPost, parseCookie } = require('./helper');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');

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

test('POST /api/auth/login — missing fields returns 400', async () => {
  const server = await startTestServer();
  const res = await httpPost(server, '/api/auth/login', {});
  assert.equal(res.statusCode, 400);
  await server.close();
});

test('POST /api/auth/login — wrong credentials returns 401', async () => {
  const server = await startTestServer();
  const res = await httpPost(server, '/api/auth/login', { username: 'testadmin', password: 'wrong' });
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('POST /api/auth/login — correct credentials returns 200 and sets an HttpOnly/Secure/SameSite=Strict session cookie', async () => {
  const server = await startTestServer();
  const res = await httpPost(server, '/api/auth/login', { username: 'testadmin', password: 'TestAdmin1!' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.username, 'testadmin');

  const cookie = parseCookie(res.headers['set-cookie']);
  assert.equal(cookie.name, 'session');
  assert.match(cookie.raw, /HttpOnly/);
  assert.match(cookie.raw, /Secure/);
  assert.match(cookie.raw, /SameSite=Strict/);
  await server.close();
});

test('GET /api/auth/me — no session returns 401', async () => {
  const server = await startTestServer();
  const res = await httpGet(server, '/api/auth/me');
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('GET /api/auth/me — with a valid session cookie returns the admin username', async () => {
  const server = await startTestServer();
  const login = await httpPost(server, '/api/auth/login', { username: 'testadmin', password: 'TestAdmin1!' });
  const cookie = parseCookie(login.headers['set-cookie']);

  const res = await httpGet(server, '/api/auth/me', { headers: { Cookie: `session=${cookie.value}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.username, 'testadmin');
  await server.close();
});

test('POST /api/auth/logout — clears the session so a later /me returns 401', async () => {
  const server = await startTestServer();
  const login = await httpPost(server, '/api/auth/login', { username: 'testadmin', password: 'TestAdmin1!' });
  const cookie = parseCookie(login.headers['set-cookie']);

  const logout = await httpPost(server, '/api/auth/logout', {}, { headers: { Cookie: `session=${cookie.value}` } });
  assert.equal(logout.statusCode, 200);

  const me = await httpGet(server, '/api/auth/me', { headers: { Cookie: `session=${cookie.value}` } });
  assert.equal(me.statusCode, 401);
  await server.close();
});

// ── threat-matrix (e): rate limit on brute-force login attempts ────────────

test('POST /api/auth/login — returns 429 once the per-IP rate limit is exceeded', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, loginRateLimit: { windowMs: 60_000, max: 3 } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) }));
  });

  let last;
  for (let i = 0; i < 4; i++) {
    last = await httpPost(server, '/api/auth/login', { username: 'testadmin', password: 'wrong' });
  }
  assert.equal(last.statusCode, 429);
  await server.close();
});
