// panel/test/client.test.js — RED/GREEN coverage for the thin fetch wrapper
// the SettingsView/LoginScreen React components call into.
//
// Only the request-shape logic is exercised here (pure functions + an
// injectable fetchImpl, same pattern src/integrations/*.js already uses on
// the backend) — no DOM, no real network. `Response`/`fetch` are native
// globals in Node 18+, so fakes are built with the real `Response` class.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  buildRequestInit,
  parseJsonResponse,
  request,
  login,
  logout,
  me,
  listIntegrations,
  verifyIntegration,
  setIntegrationEnabled,
  getAppConfig,
  updateAppConfig,
  GOOGLE_CALENDAR_OAUTH_START_URL,
  listConversations,
  getConversationDetail,
  updateConversation,
} from '../src/api/client.js';

// ── buildRequestInit ───────────────────────────────────────────────────────

test('buildRequestInit: GET with no body sends no headers/body, always credentials:include', () => {
  const init = buildRequestInit('GET', undefined);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'include');
  assert.equal(init.body, undefined);
  assert.equal(init.headers, undefined);
});

test('buildRequestInit: POST with a body JSON-encodes it and sets Content-Type', () => {
  const init = buildRequestInit('POST', { username: 'admin', password: 'secret' });
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'include');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, JSON.stringify({ username: 'admin', password: 'secret' }));
});

// ── parseJsonResponse ───────────────────────────────────────────────────────

test('parseJsonResponse: resolves the parsed body on a 2xx response', async () => {
  const res = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const body = await parseJsonResponse(res);
  assert.deepEqual(body, { ok: true });
});

test('parseJsonResponse: throws ApiError with status + body on a non-2xx response', async () => {
  const res = new Response(JSON.stringify({ error: 'invalid_credentials' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    () => parseJsonResponse(res),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 401);
      assert.deepEqual(err.body, { error: 'invalid_credentials' });
      assert.equal(err.message, 'invalid_credentials');
      return true;
    }
  );
});

test('parseJsonResponse: throws ApiError with a null body when the response is not JSON', async () => {
  const res = new Response('rate limited', { status: 429 });
  await assert.rejects(
    () => parseJsonResponse(res),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 429);
      assert.equal(err.body, null);
      return true;
    }
  );
});

// ── request() with an injected fetchImpl (offline, deterministic) ─────────

test('request(): calls fetchImpl with the built URL + init and returns the parsed body', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'meta' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const body = await request('GET', '/api/settings/integrations', undefined, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/settings/integrations');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(body, { id: 'meta' });
});

test('request(): propagates ApiError from a failing call', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: 'unknown_integration' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    () => request('POST', '/api/settings/integrations/unknown/verify', {}, { fetchImpl }),
    ApiError
  );
});

// ── Endpoint wrappers ────────────────────────────────────────────────────

test('login(): POSTs {username, password} to /api/auth/login', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ username: 'admin' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await login('admin', 'secret', { fetchImpl });
  assert.equal(calls[0].url, '/api/auth/login');
  assert.deepEqual(JSON.parse(calls[0].init.body), { username: 'admin', password: 'secret' });
});

test('logout(): POSTs to /api/auth/logout with no body', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await logout({ fetchImpl });
  assert.equal(calls[0].url, '/api/auth/logout');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, undefined);
});

test('me(): GETs /api/auth/me', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/auth/me');
    return new Response(JSON.stringify({ username: 'admin' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const body = await me({ fetchImpl });
  assert.deepEqual(body, { username: 'admin' });
});

test('listIntegrations(): GETs /api/settings/integrations', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/settings/integrations');
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await listIntegrations({ fetchImpl });
});

test('verifyIntegration(): POSTs credentials to /api/settings/integrations/:id/verify', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'gemini', status: 'active' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await verifyIntegration('gemini', { apiKey: 'k', model: 'gemini-2.5-flash' }, { fetchImpl });
  assert.equal(calls[0].url, '/api/settings/integrations/gemini/verify');
  assert.deepEqual(JSON.parse(calls[0].init.body), { apiKey: 'k', model: 'gemini-2.5-flash' });
});

test('setIntegrationEnabled(): PATCHes {enabled} to /api/settings/integrations/:id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'meta', enabled: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await setIntegrationEnabled('meta', true, { fetchImpl });
  assert.equal(calls[0].url, '/api/settings/integrations/meta');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { enabled: true });
});

test('getAppConfig(): GETs /api/settings/app-config', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/settings/app-config');
    return new Response(JSON.stringify({ businessName: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await getAppConfig({ fetchImpl });
});

test('updateAppConfig(): PATCHes the given patch to /api/settings/app-config', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ businessName: 'Acme' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await updateAppConfig({ businessName: 'Acme', currency: 'MXN', timezone: 'America/Mexico_City' }, { fetchImpl });
  assert.equal(calls[0].url, '/api/settings/app-config');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    businessName: 'Acme',
    currency: 'MXN',
    timezone: 'America/Mexico_City',
  });
});

test('GOOGLE_CALENDAR_OAUTH_START_URL: points at the OAuth start route (full-page nav target, never fetched)', () => {
  assert.equal(GOOGLE_CALENDAR_OAUTH_START_URL, '/api/settings/google-calendar/oauth/start');
});

// ── Conversations (ChatView, Phase 11) ──────────────────────────────────

test('listConversations(): GETs /api/conversations with no query by default', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/conversations');
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await listConversations(false, { fetchImpl });
});

test('listConversations(true): GETs /api/conversations?archived=1', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/conversations?archived=1');
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await listConversations(true, { fetchImpl });
});

test('getConversationDetail(): GETs /api/conversations/:phone, URL-encoded', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/conversations/%2B52%20155');
    return new Response(JSON.stringify({ customerPhone: '+52 155' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await getConversationDetail('+52 155', { fetchImpl });
});

test('updateConversation(): PATCHes the given patch to /api/conversations/:phone', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ customerPhone: '5215500000001', pinned: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await updateConversation('5215500000001', { pinned: true }, { fetchImpl });
  assert.equal(calls[0].url, '/api/conversations/5215500000001');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { pinned: true });
});
