'use strict';
// RED->GREEN for src/config/admin-guard.js — boot-time guard against weak
// default admin credentials.
//
// Confirmed gap: .env.example ships ADMIN_USERNAME=admin /
// ADMIN_PASSWORD=change_this_to_a_strong_password, and nothing checked
// whether those were left at their placeholder values before the server
// started accepting connections. Deliberately NOT tested via
// routes/auth.js — this is a boot-time concern (src/server.js), not a
// login-time one, so login stays fast/simple.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkAdminPassword,
  assertAdminPasswordIsSafe,
  PLACEHOLDER_ADMIN_PASSWORD,
  MIN_ADMIN_PASSWORD_LENGTH,
} = require('../src/config/admin-guard');

// ── checkAdminPassword() — pure function, no process access ────────────────

test('checkAdminPassword() rejects the exact .env.example placeholder value', () => {
  assert.equal(PLACEHOLDER_ADMIN_PASSWORD, 'change_this_to_a_strong_password');
  const reason = checkAdminPassword(PLACEHOLDER_ADMIN_PASSWORD);
  assert.ok(reason, 'placeholder password must be rejected');
  assert.match(reason, /placeholder/i);
});

test('checkAdminPassword() rejects an unset/empty password', () => {
  assert.match(checkAdminPassword(undefined), /not set/i);
  assert.match(checkAdminPassword(''), /not set/i);
});

test(`checkAdminPassword() rejects passwords shorter than ${MIN_ADMIN_PASSWORD_LENGTH} chars`, () => {
  const tooShort = 'a'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1);
  const reason = checkAdminPassword(tooShort);
  assert.ok(reason, 'too-short password must be rejected');
  assert.match(reason, /too short/i);
});

test('checkAdminPassword() accepts a real password at exactly the minimum length', () => {
  const justRight = 'a'.repeat(MIN_ADMIN_PASSWORD_LENGTH);
  assert.equal(checkAdminPassword(justRight), null);
});

test('checkAdminPassword() accepts a real, non-placeholder, long-enough password', () => {
  assert.equal(checkAdminPassword('correct-horse-battery-staple-42'), null);
});

// ── assertAdminPasswordIsSafe() — boot-time enforcement, DI for exit/log ──

test('assertAdminPasswordIsSafe() exits(1) and logs when ADMIN_PASSWORD is the placeholder', () => {
  const logs = [];
  let exitCode = null;
  const result = assertAdminPasswordIsSafe({
    env: { ADMIN_PASSWORD: PLACEHOLDER_ADMIN_PASSWORD },
    exit: (code) => {
      exitCode = code;
    },
    log: (msg) => logs.push(msg),
  });

  assert.equal(exitCode, 1);
  assert.equal(result, false);
  assert.ok(logs.length > 0, 'must log an actionable error');
  assert.match(logs.join('\n'), /placeholder/i);
});

test('assertAdminPasswordIsSafe() exits(1) when ADMIN_PASSWORD is too short', () => {
  let exitCode = null;
  assertAdminPasswordIsSafe({
    env: { ADMIN_PASSWORD: 'short' },
    exit: (code) => {
      exitCode = code;
    },
    log: () => {},
  });
  assert.equal(exitCode, 1);
});

test('assertAdminPasswordIsSafe() does NOT exit and returns true for a safe password', () => {
  let exitCalled = false;
  const result = assertAdminPasswordIsSafe({
    env: { ADMIN_PASSWORD: 'a-real-strong-password-123' },
    exit: () => {
      exitCalled = true;
    },
    log: () => {},
  });
  assert.equal(exitCalled, false);
  assert.equal(result, true);
});

test('assertAdminPasswordIsSafe() defaults env/exit/log to process globals when not injected', () => {
  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'a-real-strong-password-123';
  try {
    let exitCalled = false;
    const result = assertAdminPasswordIsSafe({ exit: () => (exitCalled = true) });
    assert.equal(exitCalled, false);
    assert.equal(result, true);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous;
  }
});
