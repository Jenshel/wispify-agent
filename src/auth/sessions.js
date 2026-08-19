'use strict';
// src/auth/sessions.js — SQLite-backed admin session store + cookie helpers.
//
// Mono-tenant, single-admin: there is no `users` table. routes/auth.js
// compares the submitted username/password against ADMIN_USERNAME /
// ADMIN_PASSWORD (read from env) itself; this module only persists the
// resulting opaque session token and knows how to read/clear the cookie
// that carries it — matching the security posture WhiteLabel_WA_System's
// context.js used (HttpOnly + Secure + SameSite=Strict, server-side session
// store keyed by a random token, not a JWT).

const crypto = require('crypto');

const COOKIE_NAME = 'session';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Create a new session row and return the opaque token. */
function createSession(db, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  db.prepare('INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  return token;
}

/**
 * Look up a session by token. Returns null (and deletes the row) if the
 * token is unknown or expired — callers never have to separately check
 * expiry.
 */
function getSession(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession(db, token);
    return null;
  }
  return { token: row.token, expiresAt: row.expires_at };
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

function setSessionCookie(res, token, { ttlMs = DEFAULT_TTL_MS } = {}) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

/** Parse the raw `Cookie` request header for this app's session cookie value. */
function getTokenFromRequest(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return null;
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_MS,
  createSession,
  getSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  getTokenFromRequest,
};
