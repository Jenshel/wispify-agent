'use strict';
// src/http/rate-limit.js — small in-memory per-IP sliding-window limiter.
//
// This is a NEW system built clean, not a port. WhiteLabel_WA_System (the
// source material) had zero rate limiting anywhere except a hand-rolled
// guard on /login for most of its life — a real gap found in a security
// audit. Doing this right from day one here: applied to POST /api/auth/login
// (brute-force protection) and every POST
// /api/settings/integrations/:id/verify call (each one is a real, costly
// outbound provider API call — must not be hammerable).
//
// Each call to rateLimit() owns its own bucket Map and cleanup interval —
// route factories (routes/auth.js, routes/settings.js) create a fresh
// limiter per createApp() call, so no state leaks between unrelated app
// instances (important for test isolation: each test file boots its own
// server).

const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60_000;

/**
 * @param {{windowMs: number, max: number, keyPrefix?: string}} opts
 * @returns {import('express').RequestHandler & {stop: () => void, buckets: Map}}
 */
function rateLimit({ windowMs, max, keyPrefix = 'rl' }) {
  const buckets = new Map(); // `${keyPrefix}:${ip}` -> { count, resetAt }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of buckets) {
      if (rec.resetAt < now) buckets.delete(key);
    }
  }, Math.min(windowMs, DEFAULT_CLEANUP_INTERVAL_MS));
  if (typeof timer.unref === 'function') timer.unref();

  function middleware(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    const rec = buckets.get(key);

    if (!rec || rec.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (rec.count >= max) {
      return res.status(429).json({ error: 'too_many_requests' });
    }
    rec.count += 1;
    next();
  }

  middleware.buckets = buckets;
  middleware.stop = () => clearInterval(timer);
  return middleware;
}

module.exports = { rateLimit };
