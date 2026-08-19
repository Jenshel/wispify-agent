'use strict';
// src/app.js — Express app factory. Does NOT call app.listen() — src/server.js
// (production) and test/helper.js (tests) do that, each against their own db.
//
// Kept minimal on purpose (design.md scope for this PR): JSON body parser,
// the admin session/settings routes this PR builds, nothing from later
// phases (webhook, brain, panel static assets, etc.).

const express = require('express');

const createAuthRouter = require('./routes/auth');
const createSettingsRouter = require('./routes/settings');

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   fetchImpl?: typeof fetch,
 *   sessionTtlMs?: number,
 *   loginRateLimit?: {windowMs: number, max: number},
 *   verifyRateLimit?: {windowMs: number, max: number},
 *   oauthStartRateLimit?: {windowMs: number, max: number},
 * }} opts
 */
function createApp({ db, fetchImpl, sessionTtlMs, loginRateLimit, verifyRateLimit, oauthStartRateLimit } = {}) {
  if (!db) throw new Error('createApp() requires a db instance');

  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());

  app.use('/api/auth', createAuthRouter(db, { sessionTtlMs, loginRateLimit }));
  app.use('/api/settings', createSettingsRouter(db, { fetchImpl, verifyRateLimit, oauthStartRateLimit }));

  return app;
}

module.exports = { createApp };
