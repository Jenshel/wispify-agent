'use strict';
// Real HTTP round-trip tests for src/app.js's panel/dist static-serving
// wiring (launch-readiness gap: the admin panel was never actually served
// in production — no express.static() call existed anywhere, and panel/dist
// is git-ignored/never wired to the backend).
//
// panelDistDir is injectable (see src/app.js's createApp() opts) so these
// tests use disposable fixture directories instead of the real panel/dist.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

function makeFixturePanelDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispify-panel-dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>panel-index</body></html>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("fixture-asset");');
  return dir;
}

function startServer({ panelDistDir } = {}) {
  return new Promise((resolve) => {
    const db = openDatabase(':memory:');
    const app = createApp({ db, panelDistDir });
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function get(base, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(base + urlPath, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

test('serves a real built asset from panel/dist when it exists', async () => {
  const panelDistDir = makeFixturePanelDist();
  const server = await startServer({ panelDistDir });
  try {
    const res = await get(server.base, '/assets/app.js');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /fixture-asset/);
  } finally {
    await server.close();
    fs.rmSync(panelDistDir, { recursive: true, force: true });
  }
});

test('falls back to index.html for a client-side route not matched by any router (SPA fallback)', async () => {
  const panelDistDir = makeFixturePanelDist();
  const server = await startServer({ panelDistDir });
  try {
    const res = await get(server.base, '/some/deep/client/route');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /panel-index/);
  } finally {
    await server.close();
    fs.rmSync(panelDistDir, { recursive: true, force: true });
  }
});

test('API routes are mounted BEFORE the static/catch-all and are never shadowed by it', async () => {
  const panelDistDir = makeFixturePanelDist();
  const server = await startServer({ panelDistDir });
  try {
    const res = await get(server.base, '/api/auth/me');
    // requireAuth() rejects with a real 401 JSON body, not the panel's index.html.
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.body, /panel-index/);
  } finally {
    await server.close();
    fs.rmSync(panelDistDir, { recursive: true, force: true });
  }
});

test('does not crash and skips mounting when panelDistDir does not exist', async () => {
  const missingDir = path.join(os.tmpdir(), 'wispify-panel-dist-does-not-exist-' + Date.now());
  assert.ok(!fs.existsSync(missingDir));
  const server = await startServer({ panelDistDir: missingDir });
  try {
    // The server must still be fully functional for real API routes...
    const apiRes = await get(server.base, '/api/auth/me');
    assert.equal(apiRes.statusCode, 401);
    // ...and a random non-API path must NOT get a 200 SPA fallback (nothing
    // was mounted to serve it), proving no crash happened AND no fallback
    // route was silently registered anyway.
    const rootRes = await get(server.base, '/some/random/path');
    assert.notEqual(rootRes.statusCode, 200);
  } finally {
    await server.close();
  }
});
