'use strict';
// RED->GREEN for src/routes/settings.js — module boundary (design.md):
// "routes/settings.js never talks to a provider directly — it only calls
// src/integrations/* adapters, then src/config/store.js to persist."
//
// Covers: GET/POST/PATCH integrations, GET/PATCH app-config, Google Calendar
// OAuth start/callback (threat-matrix b: state mismatch -> HTTP 400, no open
// redirect), and threat-matrix (e): rate limiting on /verify and OAuth start.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { httpGet, httpPost, httpPatch, parseCookie } = require('./helper');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');
const googleCalendar = require('../src/integrations/google-calendar');

let prevKey, prevUsername, prevPassword;
before(() => {
  prevKey = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  prevUsername = process.env.ADMIN_USERNAME;
  prevPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = 'testadmin';
  process.env.ADMIN_PASSWORD = 'TestAdmin1!';
});
after(() => {
  if (prevKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = prevKey;
  if (prevUsername === undefined) delete process.env.ADMIN_USERNAME;
  else process.env.ADMIN_USERNAME = prevUsername;
  if (prevPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = prevPassword;
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Dispatch a fake fetch by matching a substring in the URL. */
function fakeFetchRouter(routes) {
  return async (url, opts) => {
    for (const [match, response] of routes) {
      if (url.includes(match)) return typeof response === 'function' ? response(url, opts) : response;
    }
    throw new Error(`fakeFetchRouter: no route for ${url}`);
  };
}

async function bootServer({ fetchImpl, verifyRateLimit, oauthStartRateLimit } = {}) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, fetchImpl, verifyRateLimit, oauthStartRateLimit });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${s.address().port}`,
        db,
        _raw: s,
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

// ── auth guard ───────────────────────────────────────────────────────────

test('GET /api/settings/integrations — 401 without a session', async () => {
  const server = await bootServer();
  const res = await httpGet(server, '/api/settings/integrations');
  assert.equal(res.statusCode, 401);
  await server.close();
});

// ── GET /integrations never leaks a credential ──────────────────────────

test('GET /api/settings/integrations — lists all 4 integrations, never a credential', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpGet(server, '/api/settings/integrations', { headers: { Cookie: `session=${cookie}` } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json.length, 4);
  const ids = res.json.map((r) => r.id).sort();
  assert.deepEqual(ids, ['gemini', 'google_calendar', 'meta', 'stripe']);
  for (const row of res.json) assert.equal('credentials' in row, false);
  await server.close();
});

// ── POST /:id/verify — validate-then-persist ────────────────────────────

test('POST /api/settings/integrations/:id/verify — unknown id returns 404', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpPost(server, '/api/settings/integrations/not-real/verify', {}, { headers: { Cookie: `session=${cookie}` } });
  assert.equal(res.statusCode, 404);
  await server.close();
});

test('POST /api/settings/integrations/stripe/verify — ok:true activates and returns public status, no secret echoed', async () => {
  const fetchImpl = fakeFetchRouter([['api.stripe.com/v1/balance', jsonResponse(200, { livemode: false })]]);
  const server = await bootServer({ fetchImpl });
  const cookie = await loginAndGetCookie(server);

  const res = await httpPost(
    server,
    '/api/settings/integrations/stripe/verify',
    { secretKey: 'sk_test_ABC' },
    { headers: { Cookie: `session=${cookie}` } }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, 'active');
  assert.equal(res.json.publicMeta.livemode, false);
  assert.equal(JSON.stringify(res.json).includes('sk_test_ABC'), false);
  await server.close();
});

test('POST /api/settings/integrations/stripe/verify — ok:false surfaces the error and sets status=error (never silently swallowed)', async () => {
  const fetchImpl = fakeFetchRouter([
    ['api.stripe.com/v1/balance', jsonResponse(401, { error: { message: 'Invalid API Key provided' } })],
  ]);
  const server = await bootServer({ fetchImpl });
  const cookie = await loginAndGetCookie(server);

  const res = await httpPost(
    server,
    '/api/settings/integrations/stripe/verify',
    { secretKey: 'sk_test_bad' },
    { headers: { Cookie: `session=${cookie}` } }
  );

  assert.equal(res.statusCode, 422);
  assert.equal(res.json.error, 'Invalid API Key provided');

  const list = await httpGet(server, '/api/settings/integrations', { headers: { Cookie: `session=${cookie}` } });
  const stripeRow = list.json.find((r) => r.id === 'stripe');
  assert.equal(stripeRow.status, 'error');
  assert.equal(stripeRow.lastError, 'Invalid API Key provided');
  await server.close();
});

test('POST /api/settings/integrations/:id/verify — returns 429 once the per-IP rate limit is exceeded', async () => {
  const fetchImpl = fakeFetchRouter([['api.stripe.com/v1/balance', jsonResponse(401, { error: { message: 'bad' } })]]);
  const server = await bootServer({ fetchImpl, verifyRateLimit: { windowMs: 60_000, max: 2 } });
  const cookie = await loginAndGetCookie(server);

  let last;
  for (let i = 0; i < 3; i++) {
    last = await httpPost(
      server,
      '/api/settings/integrations/stripe/verify',
      { secretKey: 'x' },
      { headers: { Cookie: `session=${cookie}` } }
    );
  }
  assert.equal(last.statusCode, 429);
  await server.close();
});

// ── PATCH /:id {enabled} ─────────────────────────────────────────────────

test('PATCH /api/settings/integrations/:id — enabling an active integration succeeds', async () => {
  const fetchImpl = fakeFetchRouter([
    ['graph.facebook.com', jsonResponse(200, { display_phone_number: '+52 1', verified_name: 'Demo' })],
  ]);
  const server = await bootServer({ fetchImpl });
  const cookie = await loginAndGetCookie(server);

  await httpPost(
    server,
    '/api/settings/integrations/meta/verify',
    { accessToken: 'tok', phoneNumberId: '123' },
    { headers: { Cookie: `session=${cookie}` } }
  );

  const res = await httpPatch(
    server,
    '/api/settings/integrations/meta',
    { enabled: true },
    { headers: { Cookie: `session=${cookie}` } }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.enabled, true);
  await server.close();
});

test('PATCH /api/settings/integrations/:id — enabling a never-activated integration returns 409, not 500', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpPatch(
    server,
    '/api/settings/integrations/gemini',
    { enabled: true },
    { headers: { Cookie: `session=${cookie}` } }
  );
  assert.equal(res.statusCode, 409);
  assert.ok(res.json.error);
  await server.close();
});

// ── app-config ───────────────────────────────────────────────────────────

test('GET /api/settings/app-config — returns the seeded defaults', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpGet(server, '/api/settings/app-config', { headers: { Cookie: `session=${cookie}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.currency, 'MXN');
  await server.close();
});

test('PATCH /api/settings/app-config — persists a partial patch', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpPatch(
    server,
    '/api/settings/app-config',
    { businessName: 'Wispify Demo', currency: 'USD' },
    { headers: { Cookie: `session=${cookie}` } }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.businessName, 'Wispify Demo');
  assert.equal(res.json.currency, 'USD');
  await server.close();
});

// ── soul-docs / personality (Phase 4, PR6) — folded into the existing
// GET/PATCH /api/settings/app-config endpoints, since context/personality/
// personalityCustom/soulDocs were already columns (PR2's schema) and already
// in store.js's field allowlist. This is pure CRUD, no external provider
// call: apply-live means the DB write is visible on the very next read. ────

test('PATCH /api/settings/app-config — persists context/personality/personalityCustom/soulDocs, visible on the very next GET (apply-live, no restart)', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpPatch(
    server,
    '/api/settings/app-config',
    {
      context: 'We sell keratin treatments.',
      personality: 'amigable',
      personalityCustom: 'Warm, concise, uses emojis sparingly.',
      soulDocs: 'Never discount below cost.',
    },
    { headers: { Cookie: `session=${cookie}` } }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.context, 'We sell keratin treatments.');
  assert.equal(res.json.personality, 'amigable');
  assert.equal(res.json.personalityCustom, 'Warm, concise, uses emojis sparingly.');
  assert.equal(res.json.soulDocs, 'Never discount below cost.');

  // No caching layer between a save and the next read — this is the DB-level
  // guarantee Phase 6's future prompt-builder depends on to reflect edits on
  // the very next bot reply without a restart.
  const reread = await httpGet(server, '/api/settings/app-config', { headers: { Cookie: `session=${cookie}` } });
  assert.equal(reread.json.soulDocs, 'Never discount below cost.');
  await server.close();
});

test('PATCH /api/settings/app-config — rejects an oversized soulDocs value with 400 and does not persist it', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const oversized = 'x'.repeat(20_001);
  const res = await httpPatch(
    server,
    '/api/settings/app-config',
    { soulDocs: oversized },
    { headers: { Cookie: `session=${cookie}` } }
  );
  assert.equal(res.statusCode, 400);
  assert.ok(res.json.error);

  const reread = await httpGet(server, '/api/settings/app-config', { headers: { Cookie: `session=${cookie}` } });
  assert.equal(reread.json.soulDocs, null);
  await server.close();
});

// ── Google Calendar OAuth ────────────────────────────────────────────────

test('GET /api/settings/google-calendar/oauth/start — 401 without a session', async () => {
  const server = await bootServer();
  const res = await httpGet(server, '/api/settings/google-calendar/oauth/start');
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('GET /api/settings/google-calendar/oauth/start — redirects to Google with a state param', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  const res = await httpGet(server, '/api/settings/google-calendar/oauth/start', {
    headers: { Cookie: `session=${cookie}` },
  });
  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers.location);
  assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.ok(location.searchParams.get('state'));
  await server.close();
});

test('GET /api/settings/google-calendar/oauth/start — returns 429 once the per-IP rate limit is exceeded', async () => {
  const server = await bootServer({ oauthStartRateLimit: { windowMs: 60_000, max: 2 } });
  const cookie = await loginAndGetCookie(server);
  let last;
  for (let i = 0; i < 3; i++) {
    last = await httpGet(server, '/api/settings/google-calendar/oauth/start', {
      headers: { Cookie: `session=${cookie}` },
    });
  }
  assert.equal(last.statusCode, 429);
  await server.close();
});

test('GET /api/settings/google-calendar/oauth/callback — state mismatch returns a real HTTP 400 (threat-matrix b, PR3 deferred item), with NO session cookie sent', async () => {
  const server = await bootServer();
  const cookie = await loginAndGetCookie(server);
  await httpGet(server, '/api/settings/google-calendar/oauth/start', { headers: { Cookie: `session=${cookie}` } });

  // Deliberately no Cookie header — this mirrors the real browser redirect
  // from accounts.google.com, where a SameSite=Strict session cookie is not
  // guaranteed to be attached. The callback must not depend on it.
  const res = await httpGet(server, '/api/settings/google-calendar/oauth/callback?code=abc&state=attacker-supplied');
  assert.equal(res.statusCode, 400);
  await server.close();
});

test('GET /api/settings/google-calendar/oauth/callback — works with NO session cookie: valid state exchanges the code, validates, persists, and redirects to the fixed internal path only', async () => {
  const fetchImpl = fakeFetchRouter([
    ['oauth2.googleapis.com/token', jsonResponse(200, { access_token: 'gtok', refresh_token: 'grtok', expires_in: 3600 })],
    ['googleapis.com/calendar/v3/users/me/calendarList', jsonResponse(200, { items: [{ id: 'primary-cal', primary: true }] })],
  ]);
  const server = await bootServer({ fetchImpl });
  const cookie = await loginAndGetCookie(server);

  const start = await httpGet(server, '/api/settings/google-calendar/oauth/start', {
    headers: { Cookie: `session=${cookie}` },
  });
  const state = new URL(start.headers.location).searchParams.get('state');

  // No Cookie header here either — see the 400-mismatch test above for why.
  const res = await httpGet(server, `/api/settings/google-calendar/oauth/callback?code=validcode&state=${state}`);

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, googleCalendar.getFixedPostAuthRedirect());

  const list = await httpGet(server, '/api/settings/integrations', { headers: { Cookie: `session=${cookie}` } });
  const calRow = list.json.find((r) => r.id === 'google_calendar');
  assert.equal(calRow.status, 'active');
  assert.equal(calRow.publicMeta.calendar_id, 'primary-cal');
  await server.close();
});
