'use strict';
// RED->GREEN for src/routes/files.js (tasks.md Phase 5.5, spec.md
// "Authenticated Media Serving" requirement).
//
// threat-matrix (d): path-segment sanitization — every attacker-controlled
// :phone/:filename route param must be neutralized via
// src/media/store.js before ever touching fs. Also covers the
// unauthorized-access requirement (401 without a session).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { httpGet, httpPost, parseCookie } = require('./helper');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');
const mediaStore = require('../src/media/store');

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

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wispify-files-test-'));
}

async function bootServer({ dataDir } = {}) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, dataDir: dataDir || tmpDataDir() });
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

test('GET /api/media/client/:phone/:filename — 401 without a session', async () => {
  const server = await bootServer();
  const res = await httpGet(server, '/api/media/client/5215500000000/photo.jpg');
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('GET /api/media/client/:phone/:filename — serves a previously-stored file to an authenticated admin', async () => {
  const dataDir = tmpDataDir();
  const saved = mediaStore.saveClientMedia(dataDir, '5215500000000', Buffer.from('jpeg-bytes'), 'image/jpeg');
  const server = await bootServer({ dataDir });
  const cookie = await loginAndGetCookie(server);

  const res = await httpGet(server, `/api/media/client/5215500000000/${saved.filename}`, {
    headers: { Cookie: `session=${cookie}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'jpeg-bytes');
  await server.close();
});

test('GET /api/media/client/:phone/:filename — 404 when the file does not exist', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpGet(server, '/api/media/client/5215500000000/does-not-exist.jpg', {
    headers: { Cookie: `session=${cookie}` },
  });
  assert.equal(res.statusCode, 404);
  await server.close();
});

test('GET /api/media/client/:phone/:filename — 400 on a path-traversal filename, and never reads outside the client-media root', async () => {
  const dataDir = tmpDataDir();
  // A secret file that lives OUTSIDE the client-media root — this request
  // must never be able to read it.
  fs.writeFileSync(path.join(dataDir, 'secret.txt'), 'top-secret');
  const server = await bootServer({ dataDir });
  const cookie = await loginAndGetCookie(server);

  const res = await httpGet(server, '/api/media/client/5215500000000/..%2F..%2Fsecret.txt', {
    headers: { Cookie: `session=${cookie}` },
  });
  // Either the traversal collapses to a safe (non-existent) basename inside
  // the root (404) or is explicitly rejected (400) — it must NEVER be a 200
  // with the secret file's contents.
  assert.ok([400, 404].includes(res.statusCode), `expected 400 or 404, got ${res.statusCode}`);
  assert.notEqual(res.body, 'top-secret');
  await server.close();
});

test('GET /api/media/client/:phone/:filename — 400 on a path-traversal phone segment', async () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'secret.txt'), 'top-secret');
  const server = await bootServer({ dataDir });
  const cookie = await loginAndGetCookie(server);

  const res = await httpGet(server, '/api/media/client/..%2F../secret.txt', {
    headers: { Cookie: `session=${cookie}` },
  });
  assert.ok([400, 404].includes(res.statusCode), `expected 400 or 404, got ${res.statusCode}`);
  assert.notEqual(res.body, 'top-secret');
  await server.close();
});
