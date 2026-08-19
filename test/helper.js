'use strict';

// ── Test helper — boots the real Express app on a random port ────────────
// Pattern matches WhiteLabel_WA_System's test/helper.js (real HTTP requests
// against a disposable server), adapted to this project's factory-style
// createApp({db, fetchImpl}) so every test gets an isolated in-memory DB
// (and, where needed, an injected fake fetch) instead of sharing one
// process-wide singleton server.
//
// Usage:
//   const { startTestServer, httpGet, httpPost, httpPatch, parseCookie } = require('./helper');
//   const server = await startTestServer({ fetchImpl });
//   const res = await httpGet(server, '/api/settings/integrations');
//   await server.close();

const http = require('http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

/**
 * Start a fresh app instance on a random port, backed by a fresh in-memory
 * DB unless one is passed in.
 * @returns {Promise<{base: string, db: object, close: () => Promise<void>}>}
 */
function startTestServer({ db, fetchImpl } = {}) {
  return new Promise((resolve) => {
    const database = db || openDatabase(':memory:');
    const app = createApp({ db: database, fetchImpl });
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        db: database,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function request(method, server, path, data, opts = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = data !== undefined ? JSON.stringify(data) : '';
    const headers = {
      ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      ...(opts.headers || {}),
    };
    const req = http.request(server.base + path, { method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try {
            json = JSON.parse(body);
          } catch {
            /* leave json null */
          }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (bodyStr && data !== undefined) req.write(bodyStr);
    req.end();
  });
}

const httpGet = (server, path, opts) => request('GET', server, path, undefined, opts);
const httpPost = (server, path, data, opts) => request('POST', server, path, data, opts);
const httpPatch = (server, path, data, opts) => request('PATCH', server, path, data, opts);

/** Parse a Set-Cookie header value into { name, value, raw }. */
function parseCookie(setCookie) {
  if (!setCookie) return null;
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const [name, ...rest] = raw.split(';')[0].trim().split('=');
  return { name, value: rest.join('='), raw };
}

module.exports = { startTestServer, httpGet, httpPost, httpPatch, parseCookie };
