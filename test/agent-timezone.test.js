'use strict';
// RED->GREEN for src/agent/timezone.js (PR17) — the single shared,
// Intl-based IANA-timezone wall-clock resolver src/agent/date.js and
// src/jobs/nudges.js both now read app_config.timezone through, instead of
// each hardcoding its own fixed Mexico City UTC-6 offset independently.
//
// Node's built-in Intl.DateTimeFormat ships full ICU/timezone data (Node
// 13+) — no new dependency for this.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getWallClockParts, zonedTimeToInstant, DEFAULT_TIMEZONE } = require('../src/agent/timezone');

test('DEFAULT_TIMEZONE is America/Mexico_City, matching schema.sql\'s own app_config.timezone default', () => {
  assert.equal(DEFAULT_TIMEZONE, 'America/Mexico_City');
});

// ── getWallClockParts() ───────────────────────────────────────────────────

test('getWallClockParts() resolves Mexico City (UTC-6) wall-clock components for a known instant', () => {
  const parts = getWallClockParts(Date.UTC(2030, 0, 15, 16, 0, 0), 'America/Mexico_City');
  assert.equal(parts.year, 2030);
  assert.equal(parts.month, 0); // 0-indexed, January
  assert.equal(parts.day, 15);
  assert.equal(parts.hour, 10); // 16:00 UTC - 6h
  assert.equal(parts.minute, 0);
  assert.equal(parts.weekday, 2); // Tuesday
  assert.equal(parts.offsetMs, -6 * 3600 * 1000);
});

test('getWallClockParts() resolves a DIFFERENT zone (America/Bogota, UTC-5) to a different wall-clock hour for the same instant', () => {
  const now = Date.UTC(2030, 0, 15, 16, 0, 0);
  const mx = getWallClockParts(now, 'America/Mexico_City');
  const bo = getWallClockParts(now, 'America/Bogota');
  assert.equal(mx.hour, 10);
  assert.equal(bo.hour, 11); // Bogota is UTC-5, one hour ahead of Mexico City
});

test('getWallClockParts() falls back to DEFAULT_TIMEZONE for an empty/undefined timezone name', () => {
  const now = Date.UTC(2030, 0, 15, 16, 0, 0);
  const withDefault = getWallClockParts(now, DEFAULT_TIMEZONE);
  assert.deepEqual(getWallClockParts(now, ''), withDefault);
  assert.deepEqual(getWallClockParts(now, undefined), withDefault);
});

test('getWallClockParts() falls back to DEFAULT_TIMEZONE (never throws) for a genuinely invalid IANA name', () => {
  const now = Date.UTC(2030, 0, 15, 16, 0, 0);
  let parts;
  assert.doesNotThrow(() => {
    parts = getWallClockParts(now, 'not/a-real-zone');
  });
  assert.deepEqual(parts, getWallClockParts(now, DEFAULT_TIMEZONE));
});

// ── zonedTimeToInstant() ──────────────────────────────────────────────────

test('zonedTimeToInstant() interprets a naive local ISO string as Mexico City time (UTC-6) by default', () => {
  const dt = zonedTimeToInstant('2026-08-20T09:00:00', DEFAULT_TIMEZONE);
  assert.equal(dt.toISOString(), '2026-08-20T15:00:00.000Z');
});

test('zonedTimeToInstant() produces a DIFFERENT real instant for the same naive string in a different zone', () => {
  const mx = zonedTimeToInstant('2030-01-15T15:00:00', 'America/Mexico_City'); // UTC-6 -> 21:00 UTC
  const sp = zonedTimeToInstant('2030-01-15T15:00:00', 'America/Sao_Paulo'); // UTC-3 -> 18:00 UTC
  assert.equal(mx.toISOString(), '2030-01-15T21:00:00.000Z');
  assert.equal(sp.toISOString(), '2030-01-15T18:00:00.000Z');
  assert.notEqual(mx.getTime(), sp.getTime());
});

test('zonedTimeToInstant() returns an Invalid Date for a malformed input rather than throwing', () => {
  assert.doesNotThrow(() => zonedTimeToInstant('not-a-date', DEFAULT_TIMEZONE));
  assert.equal(Number.isNaN(zonedTimeToInstant('not-a-date', DEFAULT_TIMEZONE).getTime()), true);
});
