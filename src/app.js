'use strict';
// src/app.js — Express app factory. Does NOT call app.listen() — src/server.js
// (production) and test/helper.js (tests) do that, each against their own db.
//
// Kept minimal on purpose (design.md scope for this PR): JSON body parser,
// the admin session/settings routes this PR builds, nothing from later
// phases (brain, panel static assets, etc.).
//
// Route ordering matters: the WhatsApp webhook router owns its OWN raw-body
// parser (POST /webhook needs the untouched byte stream for HMAC
// verification) and MUST be mounted before the global express.json() call
// below — otherwise json() would already have consumed/parsed the request
// body for every route by the time the webhook router's express.raw()
// middleware runs.

const fs = require('node:fs');
const path = require('node:path');

const express = require('express');

const { createWebhookRouter } = require('./channels/whatsapp/webhook');
const { createPaymentsRouter } = require('./routes/payments');
const createAuthRouter = require('./routes/auth');
const createSettingsRouter = require('./routes/settings');
const createFilesRouter = require('./routes/files');
const createConversationsRouter = require('./routes/conversations');

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   fetchImpl?: typeof fetch,
 *   sessionTtlMs?: number,
 *   loginRateLimit?: {windowMs: number, max: number},
 *   verifyRateLimit?: {windowMs: number, max: number},
 *   oauthStartRateLimit?: {windowMs: number, max: number},
 *   dataDir?: string,
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   randomImpl?: () => number,
 *   onMessageProcessed?: (info: object) => void,
 *   panelDistDir?: string,
 * }} opts
 */
function createApp({
  db,
  fetchImpl,
  sessionTtlMs,
  loginRateLimit,
  verifyRateLimit,
  oauthStartRateLimit,
  dataDir,
  sleepImpl,
  randomImpl,
  onMessageProcessed,
  panelDistDir = path.join(__dirname, '..', 'panel', 'dist'),
} = {}) {
  if (!db) throw new Error('createApp() requires a db instance');

  const app = express();
  app.set('trust proxy', 'loopback');

  // Raw-body routes FIRST — see header comment. POST /webhook/stripe needs
  // the same untouched byte stream for HMAC verification as POST /webhook.
  app.use('/', createWebhookRouter(db, { fetchImpl, dataDir, sleepImpl, randomImpl, onMessageProcessed }));
  app.use('/', createPaymentsRouter(db, { fetchImpl }));

  app.use(express.json());

  app.use('/api/auth', createAuthRouter(db, { sessionTtlMs, loginRateLimit }));
  app.use('/api/settings', createSettingsRouter(db, { fetchImpl, verifyRateLimit, oauthStartRateLimit }));
  app.use('/api', createFilesRouter(db, { dataDir }));
  app.use('/api', createConversationsRouter(db));

  // Serve the built admin panel (panel/dist, Vite build output) LAST, after
  // every API/webhook/payments route above, so a static file or the SPA
  // catch-all can never shadow an API response. Guarded: panel/dist is
  // git-ignored and only exists once someone has run `npm run build:panel`
  // (or the Dockerfile's panel-build stage) — if it's missing, skip mounting
  // instead of crashing the whole server, and warn once so the gap is
  // obvious in the logs. panelDistDir is injectable (same DI pattern as
  // dataDir above) so tests can point it at a fixture dir or a guaranteed-
  // missing path without touching the real panel/dist.
  if (fs.existsSync(panelDistDir)) {
    app.use(express.static(panelDistDir));
    // Client-side routing fallback. The panel has no router yet (PR13
    // shipped a single-page Chat/Settings tab switch, no deep links) — this
    // is still the correct default for an SPA so a future router doesn't
    // need this file touched again. Never intercepts /api, /webhook, or
    // /pay routes: those are handled by the routers mounted above and only
    // reach here if genuinely unmatched, at which point falling through to
    // index.html would be wrong (the client would get a confusing 200
    // instead of the API's own 404).
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/webhook') || req.path.startsWith('/pay/')) {
        return next();
      }
      res.sendFile(path.join(panelDistDir, 'index.html'));
    });
  } else {
    console.warn('[app] panel/dist not found — admin panel will not be served. Run `npm run build:panel` first.');
  }

  return app;
}

module.exports = { createApp };
