'use strict';
// RED->GREEN for src/integrations/google-calendar.js (tasks.md Phase 2.3 + 2.4).
//
// Scope for this PR (design.md + delegated task): OAuth client plumbing
// (getAuthUrl/exchangeCodeForTokens) + validate() via a live calendarList
// probe, plus the CSRF-safe primitives (generateState/verifyState) and the
// fixed post-auth redirect target that close threat-matrix (b) "OAuth state
// mismatch -> 400, no open redirect". Wiring these into an actual Express
// route (storing state on the session, returning an actual 400) is Phase 3's
// job (routes/settings.js) — this suite pins the adapter-level contract that
// route will be built on top of.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const calendar = require('../src/integrations/google-calendar');

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ── threat-matrix (b): OAuth state CSRF + no open redirect ─────────────────

test('generateState() returns a long random string, different on every call', () => {
  const a = calendar.generateState();
  const b = calendar.generateState();
  assert.equal(typeof a, 'string');
  assert.ok(a.length >= 32);
  assert.notEqual(a, b);
});

test('verifyState() returns true only for an exact match', () => {
  const state = calendar.generateState();
  assert.equal(calendar.verifyState(state, state), true);
});

test('verifyState() returns false on any mismatch (the case a route maps to HTTP 400)', () => {
  assert.equal(calendar.verifyState('expected-state', 'attacker-supplied-state'), false);
});

test('verifyState() returns false when either side is missing (no accidental open pass)', () => {
  assert.equal(calendar.verifyState('expected-state', undefined), false);
  assert.equal(calendar.verifyState(undefined, 'expected-state'), false);
  assert.equal(calendar.verifyState('', ''), false);
});

test('getFixedPostAuthRedirect() always returns the same hardcoded internal path (no open redirect)', () => {
  assert.equal(calendar.getFixedPostAuthRedirect(), calendar.getFixedPostAuthRedirect());
  assert.match(calendar.getFixedPostAuthRedirect(), /^\/panel\//);
  // the function takes no input at all, so there is nothing an attacker's
  // query string could ever influence
  assert.equal(calendar.getFixedPostAuthRedirect.length, 0);
});

// ── getAuthUrl() ─────────────────────────────────────────────────────────

test('getAuthUrl() builds a Google consent URL with the calendar scope and the given state', () => {
  const state = 'random-state-123';
  const url = new URL(
    calendar.getAuthUrl('https://app.example.com/oauth/callback', state, { clientId: 'client-123' })
  );

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.com/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /calendar/);
});

// ── exchangeCodeForTokens() ─────────────────────────────────────────────

test('exchangeCodeForTokens() posts the authorization_code grant to the Google token endpoint', async () => {
  const fetchImpl = fakeFetch(
    jsonResponse(200, { access_token: 'ya29.fake', refresh_token: '1//fake', expires_in: 3599 })
  );
  const tokens = await calendar.exchangeCodeForTokens('auth-code-abc', 'https://app.example.com/oauth/callback', {
    fetchImpl,
    clientId: 'client-123',
    clientSecret: 'secret-456',
  });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, 'https://oauth2.googleapis.com/token');
  const params = new URLSearchParams(opts.body);
  assert.equal(params.get('code'), 'auth-code-abc');
  assert.equal(params.get('client_id'), 'client-123');
  assert.equal(params.get('client_secret'), 'secret-456');
  assert.equal(params.get('redirect_uri'), 'https://app.example.com/oauth/callback');
  assert.equal(params.get('grant_type'), 'authorization_code');

  assert.deepEqual(tokens, { access_token: 'ya29.fake', refresh_token: '1//fake', expires_in: 3599 });
});

test('exchangeCodeForTokens() throws with the provider error on a failed exchange', async () => {
  const fetchImpl = fakeFetch(jsonResponse(400, { error: 'invalid_grant', error_description: 'Bad code' }));
  await assert.rejects(
    () =>
      calendar.exchangeCodeForTokens('bad-code', 'https://app.example.com/oauth/callback', {
        fetchImpl,
        clientId: 'client-123',
        clientSecret: 'secret-456',
      }),
    /Bad code|invalid_grant/
  );
});

// ── validate() ───────────────────────────────────────────────────────────

test('validate() calls the calendarList endpoint with Bearer auth', async () => {
  const fetchImpl = fakeFetch(
    jsonResponse(200, { items: [{ id: 'demo@business.example.com', primary: true, summary: 'Demo Business' }] })
  );
  await calendar.validate({ accessToken: 'ya29.fake', refreshToken: '1//fake' }, { fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, 'https://www.googleapis.com/calendar/v3/users/me/calendarList');
  assert.equal(opts.headers.Authorization, 'Bearer ya29.fake');
});

test('validate() returns ok + publicMeta.calendar_id + storage-shaped credentials on success', async () => {
  const fetchImpl = fakeFetch(
    jsonResponse(200, { items: [{ id: 'demo@business.example.com', primary: true, summary: 'Demo Business' }] })
  );
  const result = await calendar.validate({ accessToken: 'ya29.fake', refreshToken: '1//fake' }, { fetchImpl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.publicMeta, { calendar_id: 'demo@business.example.com' });
  assert.deepEqual(result.credentials, { access_token: 'ya29.fake', refresh_token: '1//fake' });
  assert.equal(JSON.stringify(result.publicMeta).includes('ya29.fake'), false);
});

test('validate() surfaces the provider error and persists nothing on a revoked/expired token', async () => {
  const fetchImpl = fakeFetch(jsonResponse(401, { error: { message: 'Invalid Credentials' } }));
  const result = await calendar.validate({ accessToken: 'expired', refreshToken: 'x' }, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid Credentials');
  assert.equal(result.credentials, undefined);
});

test('validate() rejects when accessToken is missing, without hitting the network', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { items: [] }));
  const result = await calendar.validate({ refreshToken: 'x' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('validate() handles a network failure without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const result = await calendar.validate({ accessToken: 'x', refreshToken: 'y' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /network error/i);
});

// ── getAccessToken() — tasks.md Phase 8.3 ───────────────────────────────

test('getAccessToken() returns the cached token without hitting the network when still fresh', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const cache = { accessToken: 'cached-token', expiresAt: Date.now() + 60_000 };
  const token = await calendar.getAccessToken({ refreshToken: 'r' }, { fetchImpl, cache });
  assert.equal(token, 'cached-token');
  assert.equal(fetchImpl.calls.length, 0);
});

test('getAccessToken() refreshes via the refresh_token grant when the cache is empty', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { access_token: 'ya29.new', expires_in: 3600 }));
  const cache = calendar.createTokenCache();
  const token = await calendar.getAccessToken(
    { refreshToken: '1//fake' },
    { fetchImpl, cache, clientId: 'client-123', clientSecret: 'secret-456' }
  );
  assert.equal(token, 'ya29.new');
  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, 'https://oauth2.googleapis.com/token');
  const params = new URLSearchParams(opts.body);
  assert.equal(params.get('refresh_token'), '1//fake');
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('client_id'), 'client-123');
});

test('getAccessToken() populates the cache so a second call within the token lifetime does not refresh again', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { access_token: 'ya29.new', expires_in: 3600 }));
  const cache = calendar.createTokenCache();
  await calendar.getAccessToken({ refreshToken: '1//fake' }, { fetchImpl, cache });
  await calendar.getAccessToken({ refreshToken: '1//fake' }, { fetchImpl, cache });
  assert.equal(fetchImpl.calls.length, 1);
});

test('getAccessToken() falls back to the given accessToken when no refreshToken is available', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const cache = calendar.createTokenCache();
  const token = await calendar.getAccessToken({ accessToken: 'ya29.direct' }, { fetchImpl, cache });
  assert.equal(token, 'ya29.direct');
  assert.equal(fetchImpl.calls.length, 0);
});

test('getAccessToken() throws with err.code = "invalid_grant" when Google reports the refresh token is revoked/expired', async () => {
  const fetchImpl = fakeFetch(jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
  const cache = calendar.createTokenCache();
  await assert.rejects(
    () => calendar.getAccessToken({ refreshToken: 'revoked' }, { fetchImpl, cache }),
    (err) => {
      assert.equal(err.code, 'invalid_grant');
      return true;
    }
  );
});

test('getAccessToken() throws a plain error (no .code) on an unrelated refresh failure', async () => {
  const fetchImpl = fakeFetch(jsonResponse(500, { error: 'server_error' }));
  const cache = calendar.createTokenCache();
  await assert.rejects(
    () => calendar.getAccessToken({ refreshToken: 'x' }, { fetchImpl, cache }),
    (err) => {
      assert.equal(err.code, undefined);
      return true;
    }
  );
});

// ── createEvent() — tasks.md Phase 8.2/8.4 (real Calendar event creation) ─

test('createEvent() creates an event with a Google Meet conference link on success', async () => {
  const cache = { accessToken: 'ya29.fake', expiresAt: Date.now() + 60_000 };
  const fetchImpl = fakeFetch(
    jsonResponse(200, {
      id: 'evt_abc',
      htmlLink: 'https://calendar.google.com/event?eid=abc',
      hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
    })
  );
  const result = await calendar.createEvent(
    { accessToken: 'ya29.fake', calendarId: 'demo@business.example.com' },
    { summary: 'Corte — 5215500000001', description: 'desc', startIso: '2030-01-15T15:00:00.000Z', endIso: '2030-01-15T15:30:00.000Z' },
    { fetchImpl, cache }
  );

  assert.equal(result.id, 'evt_abc');
  assert.equal(result.meetLink, 'https://meet.google.com/xyz-abcd-efg');
  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.match(url, /conferenceDataVersion=1/);
  assert.equal(opts.headers.Authorization, 'Bearer ya29.fake');
  const body = JSON.parse(opts.body);
  assert.equal(body.summary, 'Corte — 5215500000001');
  assert.ok(body.conferenceData);
});

test('createEvent() falls back to creating the event WITHOUT a Meet link when conference creation fails, rather than failing the whole booking', async () => {
  const cache = { accessToken: 'ya29.fake', expiresAt: Date.now() + 60_000 };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('conferenceDataVersion=1')) {
      return jsonResponse(400, { error: { message: 'conference creation not supported' } });
    }
    return jsonResponse(200, { id: 'evt_no_meet', htmlLink: 'https://calendar.google.com/event?eid=xyz' });
  };
  fetchImpl.calls = calls;

  const result = await calendar.createEvent(
    { accessToken: 'ya29.fake', calendarId: 'demo@business.example.com' },
    { summary: 'Corte', startIso: '2030-01-15T15:00:00.000Z', endIso: '2030-01-15T15:30:00.000Z' },
    { fetchImpl, cache }
  );

  assert.equal(result.id, 'evt_no_meet');
  assert.equal(result.meetLink, null);
  assert.equal(calls.length, 2);
});

test('createEvent() throws when the calendar itself rejects the fallback (non-conference) request', async () => {
  const cache = { accessToken: 'ya29.fake', expiresAt: Date.now() + 60_000 };
  const fetchImpl = fakeFetch(jsonResponse(403, { error: { message: 'insufficient permissions' } }));
  await assert.rejects(
    () =>
      calendar.createEvent(
        { accessToken: 'ya29.fake', calendarId: 'demo@business.example.com' },
        { summary: 'Corte', startIso: '2030-01-15T15:00:00.000Z', endIso: '2030-01-15T15:30:00.000Z' },
        { fetchImpl, cache }
      ),
    /insufficient permissions/
  );
});

test('createEvent() throws when calendarId is missing', async () => {
  const cache = { accessToken: 'ya29.fake', expiresAt: Date.now() + 60_000 };
  await assert.rejects(
    () =>
      calendar.createEvent(
        { accessToken: 'ya29.fake' },
        { summary: 'Corte', startIso: '2030-01-15T15:00:00.000Z', endIso: '2030-01-15T15:30:00.000Z' },
        { fetchImpl: fakeFetch(jsonResponse(200, {})), cache }
      ),
    /calendarId/
  );
});
