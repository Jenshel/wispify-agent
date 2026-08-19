'use strict';
// src/routes/settings.js — guided integration setup screen (backend half,
// PR4; panel wizard UI is PR5+).
//
// Module boundary (design.md): "routes/settings.js never talks to a
// provider directly — it only calls src/integrations/* adapters, then
// src/config/store.js to persist." Every handler below follows that
// validate-then-persist shape: call the adapter's validate(), then either
// store.activateIntegration() on ok:true or store.setIntegrationError() on
// ok:false — the error is always returned to the caller, never swallowed.
//
// threat-matrix (e): rate limiting on /verify (each call is a real, costly
// outbound provider API call) and on the Google OAuth start endpoint.

const express = require('express');

const store = require('../config/store');
const { requireAuth } = require('../auth/middleware');
const { rateLimit } = require('../http/rate-limit');

const meta = require('../integrations/meta');
const gemini = require('../integrations/gemini');
const googleCalendar = require('../integrations/google-calendar');
const stripe = require('../integrations/stripe');

const ADAPTERS = { meta, gemini, google_calendar: googleCalendar, stripe };

const DEFAULT_VERIFY_RATE_LIMIT = { windowMs: 60_000, max: 10 };
const DEFAULT_OAUTH_START_RATE_LIMIT = { windowMs: 60_000, max: 10 };
const OAUTH_STATE_TTL_MS = 10 * 60_000;

function resolveRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/settings/google-calendar/oauth/callback`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   verifyRateLimit?: {windowMs: number, max: number},
 *   oauthStartRateLimit?: {windowMs: number, max: number},
 * }} [opts]
 */
function createSettingsRouter(
  db,
  {
    fetchImpl = fetch,
    verifyRateLimit = DEFAULT_VERIFY_RATE_LIMIT,
    oauthStartRateLimit = DEFAULT_OAUTH_START_RATE_LIMIT,
  } = {}
) {
  const router = express.Router();
  const requireAuthMw = requireAuth(db);

  const verifyLimiter = rateLimit({ ...verifyRateLimit, keyPrefix: 'verify' });
  const oauthStartLimiter = rateLimit({ ...oauthStartRateLimit, keyPrefix: 'oauth-start' });

  // Pending Google OAuth CSRF state — a single slot rather than a map keyed
  // by session cookie, because the callback is reached via a cross-site
  // redirect from Google and a SameSite=Strict session cookie (used
  // everywhere else in this app) is not guaranteed to survive that hop.
  // /oauth/start still requires an authenticated admin session to mint a
  // state in the first place (single-admin app: at most one setup flow is
  // ever in progress), so a state can only exist because an already-logged
  // -in admin requested it; verifyState()'s constant-time compare against
  // this single-use, 10-minute-TTL token is what actually authorizes the
  // callback (design.md threat-matrix (b), closed with a real HTTP 400).
  let pendingOAuthState = null; // { value, expiresAt } | null

  // ── integrations ─────────────────────────────────────────────────────

  router.get('/integrations', requireAuthMw, (req, res) => {
    res.json(store.listIntegrationsPublic(db));
  });

  router.post('/integrations/:id/verify', requireAuthMw, verifyLimiter, async (req, res) => {
    const { id } = req.params;
    if (!store.INTEGRATION_IDS.includes(id)) {
      return res.status(404).json({ error: 'unknown_integration' });
    }

    const adapter = ADAPTERS[id];
    let result;
    try {
      result = await adapter.validate(req.body || {}, { fetchImpl });
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    if (result.ok) {
      const pub = store.activateIntegration(db, id, { credentials: result.credentials, publicMeta: result.publicMeta });
      return res.json(pub);
    }

    // Never silently swallow a validation failure — persist the error and
    // return it to the caller.
    const error = result.error || 'validation failed';
    store.setIntegrationError(db, id, error);
    return res.status(422).json({ error });
  });

  router.patch('/integrations/:id', requireAuthMw, (req, res) => {
    const { id } = req.params;
    if (!store.INTEGRATION_IDS.includes(id)) {
      return res.status(404).json({ error: 'unknown_integration' });
    }
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      const pub = store.setIntegrationEnabled(db, id, enabled);
      return res.json(pub);
    } catch (err) {
      // store.setIntegrationEnabled() throws when asked to enable a
      // non-active integration — surface that as a clean 409, not a 500.
      return res.status(409).json({ error: err.message });
    }
  });

  // ── app config ───────────────────────────────────────────────────────

  router.get('/app-config', requireAuthMw, (req, res) => {
    res.json(store.getAppConfig(db));
  });

  router.patch('/app-config', requireAuthMw, (req, res) => {
    res.json(store.updateAppConfig(db, req.body || {}));
  });

  // ── Google Calendar OAuth ────────────────────────────────────────────
  // /start requires an authenticated admin session (only a logged-in admin
  // may kick off a setup flow). /callback deliberately does NOT — it is
  // reached via a cross-site redirect from Google, and this app's session
  // cookie is SameSite=Strict (see pendingOAuthState comment above), which
  // browsers will not attach to that hop. The single-use, TTL-bound state
  // token is the callback's actual authorization proof instead.

  router.get('/google-calendar/oauth/start', requireAuthMw, oauthStartLimiter, (req, res) => {
    const state = googleCalendar.generateState();
    pendingOAuthState = { value: state, expiresAt: Date.now() + OAUTH_STATE_TTL_MS };
    const redirectUri = resolveRedirectUri(req);
    res.redirect(302, googleCalendar.getAuthUrl(redirectUri, state, {}));
  });

  router.get('/google-calendar/oauth/callback', async (req, res) => {
    const pending = pendingOAuthState;
    const providedState = req.query.state;
    pendingOAuthState = null; // single-use regardless of outcome

    if (!pending || pending.expiresAt < Date.now() || !googleCalendar.verifyState(pending.value, providedState)) {
      return res.status(400).json({ error: 'invalid_state' });
    }

    const redirectUri = resolveRedirectUri(req);
    let tokens;
    try {
      tokens = await googleCalendar.exchangeCodeForTokens(req.query.code, redirectUri, { fetchImpl });
    } catch (err) {
      store.setIntegrationError(db, 'google_calendar', err.message);
      return res.redirect(302, googleCalendar.getFixedPostAuthRedirect());
    }

    const result = await googleCalendar.validate(
      { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
      { fetchImpl }
    );
    if (result.ok) {
      store.activateIntegration(db, 'google_calendar', { credentials: result.credentials, publicMeta: result.publicMeta });
    } else {
      store.setIntegrationError(db, 'google_calendar', result.error);
    }
    return res.redirect(302, googleCalendar.getFixedPostAuthRedirect());
  });

  return router;
}

module.exports = createSettingsRouter;
