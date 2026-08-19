// panel/src/api/client.js — thin fetch wrapper for the backend's /api/* routes.
//
// Deliberately not axios: every call is same-origin (this panel is always
// served from the same host as the API, or proxied to it in dev — see
// vite.config.js), so a plain `fetch(..., { credentials: 'include' })` rides
// the HttpOnly session cookie without any extra client library.
//
// The request-shape logic (buildRequestInit/parseJsonResponse/request) is
// pure/injectable-fetchImpl, mirroring the `fetchImpl` pattern already used
// by src/integrations/*.js on the backend — see panel/test/client.test.js
// for fully offline node:test coverage of this module.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `request failed with HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Pure: build the fetch() init for a request. No body → no headers/no body key (GET/DELETE-safe). */
export function buildRequestInit(method, body) {
  const init = { method, credentials: 'include' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return init;
}

/** Parse a fetch Response: resolve with the JSON body on 2xx, throw ApiError otherwise. */
export async function parseJsonResponse(response) {
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) throw new ApiError(response.status, json);
  return json;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string}} [opts]
 */
export async function request(method, path, body, { fetchImpl = fetch, baseUrl = '' } = {}) {
  const response = await fetchImpl(`${baseUrl}${path}`, buildRequestInit(method, body));
  return parseJsonResponse(response);
}

const get = (path, opts) => request('GET', path, undefined, opts);
const post = (path, body, opts) => request('POST', path, body, opts);
const patch = (path, body, opts) => request('PATCH', path, body, opts);

// ── Auth (src/routes/auth.js) ───────────────────────────────────────────

export const login = (username, password, opts) => post('/api/auth/login', { username, password }, opts);
export const logout = (opts) => post('/api/auth/logout', undefined, opts);
export const me = (opts) => get('/api/auth/me', opts);

// ── Settings: integrations (src/routes/settings.js) ────────────────────

export const listIntegrations = (opts) => get('/api/settings/integrations', opts);
export const verifyIntegration = (id, credentials, opts) => post(`/api/settings/integrations/${id}/verify`, credentials, opts);
export const setIntegrationEnabled = (id, enabled, opts) => patch(`/api/settings/integrations/${id}`, { enabled }, opts);

// ── Settings: app config ────────────────────────────────────────────────

export const getAppConfig = (opts) => get('/api/settings/app-config', opts);
export const updateAppConfig = (patchBody, opts) => patch('/api/settings/app-config', patchBody, opts);

// ── Google Calendar OAuth — full-page redirect target, never fetched via
// AJAX (this is a real OAuth consent flow: the browser must navigate away
// to accounts.google.com and back). SettingsView sets window.location.href
// (or an <a href>) to this constant on click. ─────────────────────────────

export const GOOGLE_CALENDAR_OAUTH_START_URL = '/api/settings/google-calendar/oauth/start';
