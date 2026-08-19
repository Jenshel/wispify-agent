'use strict';
// src/routes/auth.js — single-admin login (mono-tenant: one admin account,
// no users table). Credentials come from ADMIN_USERNAME/ADMIN_PASSWORD env
// vars, seeded once via .env — design.md: "hardcoded ADMIN_PHONE ... one
// admin_sessions table" replaces the old multi-tenant
// portal/partner/client session maps + OTP tables.
//
// Security posture matches WhiteLabel_WA_System's routes/auth.js +
// context.js: bcrypt password check, server-side session store (here:
// SQLite-backed, see src/auth/sessions.js), signed HttpOnly/Secure cookie.
// threat-matrix (e): rate limit on brute-force login attempts — this is a
// clean-built system (the source material had no rate limiting anywhere
// except a hand-rolled guard on /login for most of its life), so this is
// applied from day one via src/http/rate-limit.js.

const express = require('express');
const bcrypt = require('bcryptjs');

const sessionsStore = require('../auth/sessions');
const { requireAuth } = require('../auth/middleware');
const { rateLimit } = require('../http/rate-limit');

const DEFAULT_LOGIN_RATE_LIMIT = { windowMs: 15 * 60_000, max: 10 };

// bcrypt hashing is expensive by design — memoize the hash for the current
// ADMIN_PASSWORD value instead of recomputing it on every login attempt.
let _hashCache = { password: null, hash: null };
function getAdminPasswordHash(password) {
  if (_hashCache.password !== password) {
    _hashCache = { password, hash: bcrypt.hashSync(password, 10) };
  }
  return _hashCache.hash;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{sessionTtlMs?: number, loginRateLimit?: {windowMs: number, max: number}}} [opts]
 */
function createAuthRouter(db, { sessionTtlMs, loginRateLimit = DEFAULT_LOGIN_RATE_LIMIT } = {}) {
  const router = express.Router();
  const loginLimiter = rateLimit({ ...loginRateLimit, keyPrefix: 'login' });

  router.post('/login', loginLimiter, (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminUsername || !adminPassword) {
      return res.status(503).json({ error: 'admin_not_configured' });
    }

    const usernameMatches = username === adminUsername;
    const passwordMatches = bcrypt.compareSync(password, getAdminPasswordHash(adminPassword));
    if (!usernameMatches || !passwordMatches) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = sessionsStore.createSession(db, { ttlMs: sessionTtlMs });
    sessionsStore.setSessionCookie(res, token, { ttlMs: sessionTtlMs });
    res.json({ username: adminUsername });
  });

  router.post('/logout', requireAuth(db), (req, res) => {
    sessionsStore.deleteSession(db, req.admin.sessionToken);
    sessionsStore.clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(db), (req, res) => {
    res.json({ username: process.env.ADMIN_USERNAME });
  });

  return router;
}

module.exports = createAuthRouter;
