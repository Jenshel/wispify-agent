'use strict';
// src/config/admin-guard.js — boot-time guard against weak default admin
// credentials.
//
// Confirmed gap this closes: .env.example ships ADMIN_USERNAME=admin /
// ADMIN_PASSWORD=change_this_to_a_strong_password, and nothing checked
// whether those were left at their placeholder values before the server
// started accepting connections. A copy-.env.example-without-editing
// deployment would run a live, internet-facing, WhatsApp-connected admin
// panel behind a guessable, publicly-documented password.
//
// Deliberately NOT wired into routes/auth.js — login must stay fast/simple.
// This is a boot-time concern only: src/server.js calls
// assertAdminPasswordIsSafe() before app.listen(), so a misconfigured
// deployment fails loudly and immediately instead of silently running
// insecurely.

const PLACEHOLDER_ADMIN_PASSWORD = 'change_this_to_a_strong_password'; // must match .env.example verbatim
const MIN_ADMIN_PASSWORD_LENGTH = 12; // NIST SP 800-63B baseline minimum for a memorized secret

/**
 * Pure check: returns `null` when the password is acceptable, or a
 * human-readable reason string when it must be rejected. Never touches
 * process.env/process.exit — src/server.js (via assertAdminPasswordIsSafe
 * below) decides what to do with the result; that's boot-time policy, not
 * this function's job.
 */
function checkAdminPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'ADMIN_PASSWORD is not set.';
  }
  if (password === PLACEHOLDER_ADMIN_PASSWORD) {
    return 'ADMIN_PASSWORD is still the placeholder value from .env.example.';
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `ADMIN_PASSWORD is too short (${password.length} chars, minimum ${MIN_ADMIN_PASSWORD_LENGTH}).`;
  }
  return null;
}

/**
 * Boot-time enforcement. Logs an actionable error and exits the process
 * with a non-zero code if the current ADMIN_PASSWORD is unsafe. Returns
 * `true`/`false` (rather than relying solely on the injected `exit` being
 * called) so tests can assert the outcome even when `exit` is stubbed to a
 * no-op.
 *
 * env/exit/log are injectable (same DI pattern this repo already uses for
 * fetchImpl/sleepImpl/randomImpl elsewhere) so this can be unit-tested
 * without ever actually terminating the test process.
 */
function assertAdminPasswordIsSafe({ env = process.env, exit = process.exit, log = console.error } = {}) {
  const reason = checkAdminPassword(env.ADMIN_PASSWORD);
  if (reason) {
    log(`[boot] Refusing to start: ${reason}`);
    log('[boot] Set a real ADMIN_PASSWORD (env var or the admin panel) before starting the server.');
    exit(1);
    return false;
  }
  return true;
}

module.exports = {
  checkAdminPassword,
  assertAdminPasswordIsSafe,
  PLACEHOLDER_ADMIN_PASSWORD,
  MIN_ADMIN_PASSWORD_LENGTH,
};
