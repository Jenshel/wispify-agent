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

  return app;
}

module.exports = { createApp };
