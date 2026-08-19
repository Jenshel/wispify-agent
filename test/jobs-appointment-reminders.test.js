'use strict';
// RED->GREEN for src/jobs/appointment-reminders.js (tasks.md Phase 8.4),
// PORTED from WhiteLabel_WA_System's routes/appointment-reminders.js
// scanAndRemind() — see that module's header comment for the full mapping
// (slot-scan -> single appointments-table query, three reminder windows).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../src/db');
const store = require('../src/config/store');
const appointments = require('../src/db/appointments');
const { scanAndRemind } = require('../src/jobs/appointment-reminders');

let prevKey;
before(() => {
  prevKey = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (prevKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = prevKey;
});

function freshDb() {
  const db = openDatabase(':memory:');
  store.activateIntegration(db, 'meta', {
    credentials: { access_token: 'EAAB_TEST', phone_number_id: '999888777', app_secret: 's', verify_token: 'v' },
    publicMeta: {},
  });
  return db;
}

function fakeFetch(response = { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) }) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// Date/time is stored business-local (Mexico City, UTC-6, matches
// src/agent/date.js's toApptDate()) — build a date+time pair `minutesFromNow`
// minutes away from the given `now` so tests are deterministic regardless of
// when they actually run.
function apptAt(now, minutesFromNow) {
  const target = new Date(now + minutesFromNow * 60000);
  // Convert the target instant into its Mexico-City (UTC-6) wall-clock date/time.
  const mx = new Date(target.getTime() - 6 * 3600 * 1000);
  const date = mx.toISOString().slice(0, 10);
  const time = mx.toISOString().slice(11, 16);
  return { date, time };
}

function makeAppt(db, overrides = {}) {
  const id = crypto.randomUUID();
  appointments.createAppointment(db, {
    id, customerPhone: '5215500000001', service: 'Corte',
    date: '2030-01-15', time: '15:00', durationMinutes: 30, total: 0, status: 'confirmed',
    ...overrides,
  });
  return id;
}

test('scanAndRemind() sends the 30-minute reminder (with Meet link) and marks it sent', async () => {
  const db = freshDb();
  const now = Date.now();
  const { date, time } = apptAt(now, 20); // inside the 30min window, not yet inside 5min
  const id = makeAppt(db, { date, time, meetLink: 'https://meet.google.com/fake' });
  const fetchImpl = fakeFetch();

  await scanAndRemind(db, { fetchImpl, now });

  const appt = appointments.getAppointmentById(db, id);
  assert.equal(appt.reminder30Sent, true);
  assert.equal(appt.reminder5Sent, false);
  const call = fetchImpl.calls.find((c) => c.url.includes('/messages'));
  assert.ok(call);
  assert.match(JSON.parse(call.opts.body).text.body, /30 minutos/);
  assert.match(JSON.parse(call.opts.body).text.body, /meet\.google\.com\/fake/);
});

test('scanAndRemind() does not resend the 30-minute reminder on a second scan', async () => {
  const db = freshDb();
  const now = Date.now();
  const { date, time } = apptAt(now, 20);
  const id = makeAppt(db, { date, time });
  const fetchImpl = fakeFetch();

  await scanAndRemind(db, { fetchImpl, now });
  await scanAndRemind(db, { fetchImpl, now });

  const messageCalls = fetchImpl.calls.filter((c) => c.url.includes('/messages'));
  assert.equal(messageCalls.length, 1);
  assert.equal(appointments.getAppointmentById(db, id).reminder30Sent, true);
});

test('scanAndRemind() sends the 5-minute reminder once inside that window (30-minute reminder already sent in an earlier scan)', async () => {
  const db = freshDb();
  const now = Date.now();
  const { date, time } = apptAt(now, 3);
  const id = makeAppt(db, { date, time });
  appointments.markReminderSent(db, id, 'reminder30'); // realistic: the 2min-interval job would already have sent this by t-3min
  const fetchImpl = fakeFetch();

  await scanAndRemind(db, { fetchImpl, now });

  const appt = appointments.getAppointmentById(db, id);
  assert.equal(appt.reminder5Sent, true);
  const call = fetchImpl.calls.find((c) => c.url.includes('/messages'));
  assert.match(JSON.parse(call.opts.body).text.body, /5 minutos/);
});

test('scanAndRemind() sends a no-show recovery message once the grace period has passed', async () => {
  const db = freshDb();
  const now = Date.now();
  const { date, time } = apptAt(now, -20); // 20 minutes ago, past the 15min grace
  const id = makeAppt(db, { date, time });
  const fetchImpl = fakeFetch();

  await scanAndRemind(db, { fetchImpl, now });

  const appt = appointments.getAppointmentById(db, id);
  assert.equal(appt.noShowSent, true);
  const call = fetchImpl.calls.find((c) => c.url.includes('/messages'));
  assert.match(JSON.parse(call.opts.body).text.body, /Reagendamos/);
});

test('scanAndRemind() never sends a no-show message for an appointment older than the 48h backstop', async () => {
  const db = freshDb();
  const now = Date.now();
  const { date, time } = apptAt(now, -3 * 24 * 60); // 3 days ago
  const id = makeAppt(db, { date, time });
  const fetchImpl = fakeFetch();

  await scanAndRemind(db, { fetchImpl, now });

  assert.equal(appointments.getAppointmentById(db, id).noShowSent, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('scanAndRemind() skips cancelled appointments entirely', async () => {
  const db = freshDb();
  const now = Date.now();
  const { date, time } = apptAt(now, 20);
  makeAppt(db, { date, time, status: 'cancelled' });
  const fetchImpl = fakeFetch();

  await scanAndRemind(db, { fetchImpl, now });

  assert.equal(fetchImpl.calls.length, 0);
});

test('scanAndRemind() is a no-op when meta is not configured', async () => {
  const db = openDatabase(':memory:'); // no meta credentials seeded
  const now = Date.now();
  const { date, time } = apptAt(now, 20);
  makeAppt(db, { date, time });
  const fetchImpl = fakeFetch();

  await assert.doesNotReject(() => scanAndRemind(db, { fetchImpl, now }));
  assert.equal(fetchImpl.calls.length, 0);
});
