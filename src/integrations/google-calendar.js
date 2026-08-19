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
// getAccessToken()/createEvent() (tasks.md Phase 8.2/8.3) extend this same
// module boundary: real Calendar-event creation + the in-memory
// access-token cache+refresh (design.md "getAccessToken() caches in memory
// to expires_at; refresh on demand; invalid_grant -> status='error' and the
// scheduling gate closes automatically"). This module still never touches
// store.js or Express — it takes credentials directly (same shape
// validate() already does) and returns/throws plain results; the caller
// (src/agent/effects/appointment.js, which already imports store.js) is
// responsible for actually persisting a status='error' on an invalid_grant
// error (surfaced here as `err.code === 'invalid_grant'`).
//
// Meet-link creation is attempted first and falls back to a plain event
// (no Meet link) if conference creation isn't supported/fails for that
// calendar — never failing the whole booking over a Meet-link failure
// (PR3/design.md risk note), PORTED from the source's createCalendarEvent()
// try/catch-and-retry-without-conferenceData shape.
//
// fetchImpl is injectable so this module's test suite runs fully
// offline/deterministic — see tasks.md Phase 2.3/2.4/8.2/8.3.

const crypto = require('crypto');

const GOOGLE_OAUTH_SCOPES = ['https://www.googleapis.com/auth/calendar'];
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

function eventsUrlFor(calendarId) {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

// Google access tokens last ~60min; refresh a little early so a
// long-running effect call never races an in-flight expiry.
const ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000;

function createTokenCache() {
  return { accessToken: null, expiresAt: 0 };
}

// Module-scoped default so a real caller that doesn't pass its own `cache`
// still benefits from the design-mandated in-memory cache; tests always
// pass their own fresh cache (see test/integrations-google-calendar.test.js)
// so cases never bleed into each other.
const defaultTokenCache = createTokenCache();

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

/**
 * Returns a valid Calendar access token, using the cache when still fresh
 * and refreshing via the refresh_token grant on demand otherwise
 * (design.md: "getAccessToken() caches in memory to expires_at; refresh on
 * demand"). Throws with `err.code === 'invalid_grant'` when Google reports
 * the refresh token itself is no longer valid (revoked/expired) — the
 * caller owns closing the integration's status='error' gate on that
 * specific error (this module never touches store.js/Express).
 *
 * @param {{accessToken?: string, refreshToken?: string}} credentials
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   cache?: {accessToken: string|null, expiresAt: number},
 *   clientId?: string, clientSecret?: string,
 * }} [opts]
 * @returns {Promise<string>}
 */
async function getAccessToken(
  { accessToken, refreshToken } = {},
  {
    fetchImpl = fetch,
    cache = defaultTokenCache,
    clientId = process.env.GOOGLE_CLIENT_ID,
    clientSecret = process.env.GOOGLE_CLIENT_SECRET,
  } = {}
) {
  if (cache.accessToken && cache.expiresAt > Date.now()) {
    return cache.accessToken;
  }

  if (!refreshToken) {
    // Nothing to refresh with — fall back to whatever access token we were
    // given (may already be stale; there is simply no better option here).
    if (!accessToken) throw new Error('no Google Calendar access token or refresh token available');
    cache.accessToken = accessToken;
    cache.expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
    return accessToken;
  }

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(`network error refreshing Google Calendar access token: ${err.message}`);
  }

  const parsed = await safeJson(response);

  if (!response.ok) {
    const message = parsed?.error_description || parsed?.error || `Google OAuth token refresh returned HTTP ${response.status}`;
    const err = new Error(message);
    if (parsed?.error === 'invalid_grant') err.code = 'invalid_grant';
    throw err;
  }

  cache.accessToken = parsed.access_token;
  cache.expiresAt = Date.now() + (parsed.expires_in ? parsed.expires_in * 1000 - 60_000 : ACCESS_TOKEN_TTL_MS);
  return cache.accessToken;
}

/**
 * Create a real Calendar event, attempting a Google Meet conference link
 * first and falling back to a plain event (no Meet link) if conference
 * creation isn't supported/fails for that calendar — never failing the
 * whole booking over a Meet-link failure (design.md/PR3 risk note).
 *
 * @param {{accessToken?: string, refreshToken?: string, calendarId: string}} credentials
 * @param {{summary: string, description?: string, startIso: string, endIso: string, timeZone?: string}} eventInput
 * @param {{fetchImpl?: typeof fetch, cache?: object}} [opts]
 * @returns {Promise<{id: string, meetLink: string|null, htmlLink: string|null}>}
 */
async function createEvent(
  { accessToken, refreshToken, calendarId },
  { summary, description = '', startIso, endIso, timeZone = 'America/Mexico_City' } = {},
  { fetchImpl = fetch, cache } = {}
) {
  if (!calendarId) throw new Error('calendarId is required to create a Calendar event');

  const token = await getAccessToken({ accessToken, refreshToken }, { fetchImpl, cache });
  const event = {
    summary,
    description,
    start: { dateTime: startIso, timeZone },
    end: { dateTime: endIso, timeZone },
  };
  const eventsUrl = eventsUrlFor(calendarId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let response;
  try {
    response = await fetchImpl(`${eventsUrl}?conferenceDataVersion=1`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...event,
        conferenceData: {
          createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
      }),
    });
  } catch (err) {
    throw new Error(`network error creating Calendar event: ${err.message}`);
  }

  let body = await safeJson(response);

  if (!response.ok) {
    console.log('[CALENDAR] Conference creation not supported, creating event without Meet link');
    try {
      response = await fetchImpl(eventsUrl, { method: 'POST', headers, body: JSON.stringify(event) });
    } catch (err) {
      throw new Error(`network error creating Calendar event: ${err.message}`);
    }
    body = await safeJson(response);
    if (!response.ok) {
      throw new Error(body?.error?.message || `Google Calendar API returned HTTP ${response.status}`);
    }
  }

  const meetLink =
    body.hangoutLink || body.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri || null;

  return { id: body.id, meetLink, htmlLink: body.htmlLink || null };
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
  createTokenCache,
  getAccessToken,
  createEvent,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_CALENDAR_LIST_URL,
};
