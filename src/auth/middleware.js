'use strict';
// src/auth/middleware.js — requireAuth() Express guard.
//
// Shared by routes/settings.js (every endpoint — the whole guided setup
// screen is admin-only) and routes/auth.js's GET /me.

const sessionsStore = require('./sessions');

/** @returns {import('express').RequestHandler} */
function requireAuth(db) {
  return function (req, res, next) {
    const token = sessionsStore.getTokenFromRequest(req);
    const session = sessionsStore.getSession(db, token);
    if (!session) return res.status(401).json({ error: 'unauthorized' });
    req.admin = { sessionToken: session.token };
    next();
  };
}

module.exports = { requireAuth };
