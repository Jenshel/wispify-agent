'use strict';
// RED->GREEN for src/agent/date.js (tasks.md Phase 8.1/8.2).
//
// parseFlexDate() PORTED from WhiteLabel_WA_System's routes/webhook.js —
// src/agent/tags.js's parseCitaFields() deliberately leaves "Fecha"/"Hora"
// as raw strings (see that module's own header comment); this is the
// module that resolves them into an actual date/time so the past-time and
// double-booking guards in src/agent/effects/appointment.js have something
// real to compare against.
//
// `now` is injectable (the source used a bare Date.now()) so every
// relative-date case ("hoy"/"mañana"/weekday) is fully deterministic here.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseFlexDate, toApptDate } = require('../src/agent/date');

// Wednesday 2026-08-19 12:00 UTC — matches the environment's "today".
const FIXED_NOW = Date.UTC(2026, 7, 19, 12, 0, 0);

test('parseFlexDate() resolves an explicit YYYY-MM-DD date with the given time', () => {
  const iso = parseFlexDate('2030-01-15', '15:30', { now: FIXED_NOW });
  assert.equal(iso, '2030-01-15T15:30:00');
});

test('parseFlexDate() defaults to 10:00 when no time is given', () => {
  const iso = parseFlexDate('2030-01-15', '', { now: FIXED_NOW });
  assert.equal(iso, '2030-01-15T10:00:00');
});

test('parseFlexDate() resolves "hoy" to the current Mexico-City date', () => {
  const iso = parseFlexDate('hoy', '09:00', { now: FIXED_NOW });
  // FIXED_NOW is 2026-08-19T12:00:00Z; MX offset (-6h) keeps it on the 19th.
  assert.equal(iso, '2026-08-19T09:00:00');
});

test('parseFlexDate() resolves "mañana" to the day after the current Mexico-City date', () => {
  const iso = parseFlexDate('mañana', '09:00', { now: FIXED_NOW });
  assert.equal(iso, '2026-08-20T09:00:00');
});

test('parseFlexDate() resolves a bare weekday name to the next occurrence of that weekday', () => {
  // FIXED_NOW (2026-08-19) is a Wednesday. "viernes" (Friday) is 2 days out.
  const iso = parseFlexDate('viernes', '11:00', { now: FIXED_NOW });
  assert.equal(iso, '2026-08-21T11:00:00');
});

test('parseFlexDate() resolves a weekday name that equals today to NEXT week (not today)', () => {
  // FIXED_NOW is a Wednesday ("miercoles") — "miercoles" must mean next week's,
  // matching the source's `(dow - todayDow + 7) % 7 || 7` (0 diff -> 7).
  const iso = parseFlexDate('miercoles', '11:00', { now: FIXED_NOW });
  assert.equal(iso, '2026-08-26T11:00:00');
});

test('parseFlexDate() resolves "D de MES" Spanish phrasing', () => {
  const iso = parseFlexDate('15 de septiembre', '14:00', { now: FIXED_NOW });
  assert.equal(iso, '2026-09-15T14:00:00');
});

test('parseFlexDate() rolls "D de MES" into next year when the month has already passed', () => {
  // FIXED_NOW is August 2026 — "10 de enero" (January) has already passed this year.
  const iso = parseFlexDate('10 de enero', '14:00', { now: FIXED_NOW });
  assert.equal(iso, '2027-01-10T14:00:00');
});

test('parseFlexDate() falls back to tomorrow for an unparseable date string', () => {
  const iso = parseFlexDate('algún día bonito', '10:00', { now: FIXED_NOW });
  assert.equal(iso, '2026-08-20T10:00:00');
});

test('parseFlexDate() is accent-insensitive ("miércoles" and "miercoles" behave the same)', () => {
  const withAccent = parseFlexDate('miércoles', '11:00', { now: FIXED_NOW });
  const withoutAccent = parseFlexDate('miercoles', '11:00', { now: FIXED_NOW });
  assert.equal(withAccent, withoutAccent);
});

test('toApptDate() interprets the naive local ISO string as Mexico City time (UTC-6)', () => {
  const dt = toApptDate('2026-08-20T09:00:00');
  assert.equal(dt.toISOString(), '2026-08-20T15:00:00.000Z');
});

test('toApptDate() returns an Invalid Date for a malformed input rather than throwing', () => {
  assert.doesNotThrow(() => toApptDate('not-a-date'));
  assert.equal(Number.isNaN(toApptDate('not-a-date').getTime()), true);
});

// ── app_config.timezone wiring (PR17) ─────────────────────────────────────
// Both functions now read a `timezoneName` option (defaulting to Mexico
// City if omitted, preserving every assertion above unchanged) through
// src/agent/timezone.js instead of a hardcoded offset constant.

test('parseFlexDate() resolves "hoy" against a DIFFERENT configured timezone, not a hardcoded Mexico City offset', () => {
  // Jan 16, 05:30 UTC: Mexico City (UTC-6) reads Jan 15 23:30 (still "today"
  // is the 15th); Bogota (UTC-5, one hour ahead) has already rolled over to
  // Jan 16 00:30 — a genuinely different calendar day per zone.
  const now = Date.UTC(2030, 0, 16, 5, 30, 0);
  const mxToday = parseFlexDate('hoy', '09:00', { now, timezoneName: 'America/Mexico_City' });
  const boToday = parseFlexDate('hoy', '09:00', { now, timezoneName: 'America/Bogota' });
  assert.equal(mxToday, '2030-01-15T09:00:00');
  assert.equal(boToday, '2030-01-16T09:00:00');
});

test('parseFlexDate() defaults to Mexico City when no timezoneName is given (unchanged default behavior)', () => {
  const now = Date.UTC(2030, 0, 16, 5, 30, 0);
  const withDefault = parseFlexDate('hoy', '09:00', { now });
  const withExplicitMx = parseFlexDate('hoy', '09:00', { now, timezoneName: 'America/Mexico_City' });
  assert.equal(withDefault, withExplicitMx);
});

test('toApptDate() resolves a DIFFERENT real instant for the same naive local string in a DIFFERENT configured timezone', () => {
  const mx = toApptDate('2030-01-15T15:00:00', 'America/Mexico_City'); // UTC-6
  const sp = toApptDate('2030-01-15T15:00:00', 'America/Sao_Paulo'); // UTC-3
  assert.equal(mx.toISOString(), '2030-01-15T21:00:00.000Z');
  assert.equal(sp.toISOString(), '2030-01-15T18:00:00.000Z');
  assert.notEqual(mx.getTime(), sp.getTime());
});
