'use strict';
// src/integrations/google-calendar.js — Google Calendar OAuth adapter.
//
// Module boundary (design.md): never touches Express, never persists
// anything. This PR's scope (tasks.md Phase 2.3/2.4) is the OAuth client
// plumbing + validate(), plus the CSRF-safe primitives an Express route
// needs to close threat-matrix (b) "OAuth state mismatch -> 400, no open
// redirect":
//   - generateState()/verifyState() give the future /oauth/start and
//     /oauth/callback routes (Phase 3, routes/settings.js) a session-bound,
//     constant-time-compared state token instead of trusting the query
//     string.
//   - getFixedPostAuthRedirect() is a zero-argument function returning a
//     single hardcoded internal path — the callback route must redirect
//     there, never to a URL taken from the request. That is what makes an
//     open redirect structurally impossible rather than merely validated.
// Actually wiring these into Express (storing state on the admin session,
// returning a real HTTP 400 on mismatch) is Phase 3's job — this module only
// provides the primitives and is unit-tested at that level for now.
//
// Meet-link/event-creation logic is deliberately out of scope for this PR
// (appointment booking lands in a later phase) — this file stops at proving
// OAuth access works.
//
// fetchImpl is injectable so this module's test suite runs fully
// offline/deterministic — see tasks.md Phase 2.3/2.4.

const crypto = require('crypto');

const GOOGLE_OAUTH_SCOPES = ['https://www.googleapis.com/auth/calendar'];
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

const POST_AUTH_REDIRECT_PATH = '/panel/settings?google=ok';

/** A random, session-bound CSRF token for the OAuth `state` param (10min TTL is the caller/route's job to enforce). */
function generateState() {
  return crypto.randomBytes(24).toString('hex');
}

/** Constant-time comparison so a mismatch never leaks timing information. Any missing/empty side is always false. */
function verifyState(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The ONLY place the post-OAuth-consent redirect target is defined. Takes no
 * arguments on purpose: nothing from the request (query string, referrer,
 * etc.) can ever influence where the callback route redirects to.
 */
function getFixedPostAuthRedirect() {
  return POST_AUTH_REDIRECT_PATH;
}

/**
 * Build the Google OAuth consent URL for Calendar read/write access.
 *
 * @param {string} redirectUri
 * @param {string} state
 * @param {{clientId?: string}} [opts]
 */
function getAuthUrl(redirectUri, state, { clientId = process.env.GOOGLE_CLIENT_ID } = {}) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * OAuth callback token exchange.
 *
 * @param {string} code
 * @param {string} redirectUri
 * @param {{fetchImpl?: typeof fetch, clientId?: string, clientSecret?: string}} [opts]
 * @returns {Promise<{access_token: string, refresh_token?: string, expires_in: number}>}
 */
async function exchangeCodeForTokens(
  code,
  redirectUri,
  {
    fetchImpl = fetch,
    clientId = process.env.GOOGLE_CLIENT_ID,
    clientSecret = process.env.GOOGLE_CLIENT_SECRET,
  } = {}
) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(`network error contacting Google OAuth token endpoint: ${err.message}`);
  }

  const parsed = await safeJson(response);

  if (!response.ok) {
    throw new Error(parsed?.error_description || parsed?.error || `Google OAuth token exchange returned HTTP ${response.status}`);
  }

  return parsed;
}

/**
 * Validate an access/refresh token pair with a real, lightweight Calendar
 * API call (design.md validation table: calendarList probe).
 *
 * @param {{accessToken: string, refreshToken?: string}} credentials
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, publicMeta?: object, error?: string, credentials?: object}>}
 */
async function validate({ accessToken, refreshToken } = {}, { fetchImpl = fetch } = {}) {
  if (!accessToken) return { ok: false, error: 'accessToken is required' };

  let response;
  try {
    response = await fetchImpl(GOOGLE_CALENDAR_LIST_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return { ok: false, error: `network error contacting Google Calendar API: ${err.message}` };
  }

  const body = await safeJson(response);

  if (!response.ok) {
    return { ok: false, error: body?.error?.message || `Google Calendar API returned HTTP ${response.status}` };
  }

  const items = Array.isArray(body?.items) ? body.items : [];
  const primary = items.find((item) => item.primary) || items[0];

  const credentials = { access_token: accessToken };
  if (refreshToken) credentials.refresh_token = refreshToken;

  return {
    ok: true,
    publicMeta: { calendar_id: primary ? primary.id : null },
    credentials,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = {
  generateState,
  verifyState,
  getFixedPostAuthRedirect,
  getAuthUrl,
  exchangeCodeForTokens,
  validate,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_CALENDAR_LIST_URL,
};
