'use strict';
// RED->GREEN for src/agent/effects/* (tasks.md Phase 7.4).
//
// Two real, working effects (no other phase's tables needed):
//   - escalateHuman: always logs; notifies app_config.adminPhone over
//     WhatsApp when meta credentials + adminPhone are both configured.
//   - captureContactData: logs the captured Nombre/Negocio (no
//     `conversations` table exists yet to persist it onto — see the
//     module's own header comment for the documented injection point).
//
// confirmAppointment is now REAL (Phase 8 — see the confirmAppointment
// section below, which replaces the old PR9-era stub test with the real
// past-time/double-booking guard + Calendar event creation behavior, same
// "update the obsolete test with a documented comment" pattern PR8/PR9 used
// on their own predecessors' stub-era assertions).
//
// Two remaining DOCUMENTED STUBS (seam only — real implementation lands
// with the phase that builds the table/integration each one needs):
//   - confirmOrder: Phase 9 (Stripe generic per-order checkout)
//   - sendPhoto: no catalog table exists yet in ANY phase's task list yet —
//     stub documents this explicitly rather than guessing a future phase.
//
// Every effect resolves (never throws) — a broken/incomplete tag payload
// from the model must never crash the reply pipeline mid-dispatch.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../src/db');
const store = require('../src/config/store');

const { escalateHuman } = require('../src/agent/effects/escalate');
const { captureContactData } = require('../src/agent/effects/contact-data');
const { confirmAppointment } = require('../src/agent/effects/appointment');
const { confirmOrder } = require('../src/agent/effects/order');
const { sendPhoto } = require('../src/agent/effects/photos');
const appointments = require('../src/db/appointments');
const googleCalendar = require('../src/integrations/google-calendar');

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
  return openDatabase(':memory:');
}

// ── escalateHuman ─────────────────────────────────────────────────────────

test('escalateHuman() resolves without throwing when db is omitted', async () => {
  await assert.doesNotReject(() => escalateHuman({ reason: 'x', from: '5215500000001' }));
});

test('escalateHuman() does not attempt a WhatsApp notification when no admin phone is configured', async () => {
  const db = freshDb();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const result = await escalateHuman({ reason: 'cliente molesto', from: '5215500000001' }, { db, fetchImpl });
  assert.equal(result.notified, false);
  assert.equal(calls.length, 0);
});

test('escalateHuman() does not attempt a notification when adminPhone is set but meta credentials are not', async () => {
  const db = freshDb();
  store.updateAppConfig(db, { adminPhone: '5215500009999' });
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const result = await escalateHuman({ reason: 'x', from: '5215500000001' }, { db, fetchImpl });
  assert.equal(result.notified, false);
});

test('escalateHuman() sends a WhatsApp notification to the admin when both adminPhone and meta credentials are configured', async () => {
  const db = freshDb();
  store.updateAppConfig(db, { adminPhone: '5215500009999' });
  store.activateIntegration(db, 'meta', {
    credentials: { access_token: 'EAAB_TEST', phone_number_id: '999888777', app_secret: 's', verify_token: 'v' },
    publicMeta: {},
  });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };
  const result = await escalateHuman({ reason: 'cliente molesto', from: '5215500000001' }, { db, fetchImpl });
  assert.equal(result.notified, true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.to, '5215500009999');
  assert.match(body.text.body, /5215500000001/);
  assert.match(body.text.body, /cliente molesto/);
});

test('escalateHuman() never throws even when the notification send fails', async () => {
  const db = freshDb();
  store.updateAppConfig(db, { adminPhone: '5215500009999' });
  store.activateIntegration(db, 'meta', {
    credentials: { access_token: 'EAAB_TEST', phone_number_id: '999888777', app_secret: 's', verify_token: 'v' },
    publicMeta: {},
  });
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  await assert.doesNotReject(() => escalateHuman({ reason: 'x', from: '5215500000001' }, { db, fetchImpl }));
});

// ── captureContactData ───────────────────────────────────────────────────

test('captureContactData() resolves without throwing and reports it captured the data', async () => {
  const result = await captureContactData({ name: 'Ana', business: 'Bella Studio', from: '5215500000001' });
  assert.equal(result.captured, true);
});

test('captureContactData() handles empty name/business without throwing', async () => {
  await assert.doesNotReject(() => captureContactData({ name: '', business: '', from: '5215500000001' }));
});

// ── confirmAppointment — REAL (tasks.md Phase 8) ─────────────────────────
// Ports two real bug fixes from the source (past-time + double-booking
// rejection — see src/agent/effects/appointment.js's header comment), plus
// real Google Calendar event creation with a Meet-link + graceful fallback.

function fakeMetaFetch(responses = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fake', expires_in: 3600 }) };
    }
    if (url.includes('calendar/v3')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'evt_fake', htmlLink: 'https://calendar.google.com/x', hangoutLink: 'https://meet.google.com/fake' }),
      };
    }
    // Graph API send
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function activateMeta(db) {
  return store.activateIntegration(db, 'meta', {
    credentials: { access_token: 'EAAB_TEST', phone_number_id: '999888777', app_secret: 's', verify_token: 'v' },
    publicMeta: {},
  });
}

function activateCalendar(db) {
  const pub = store.activateIntegration(db, 'google_calendar', {
    credentials: { access_token: 'ya29.fake', refresh_token: '1//fake' },
    publicMeta: { calendar_id: 'demo@business.example.com' },
  });
  store.setIntegrationEnabled(db, 'google_calendar', true);
  return pub;
}

// A fresh, isolated token cache per test — confirmAppointment() defaults to
// its own module-scoped cache in production (design.md: "getAccessToken()
// caches in memory"), but tests must never share that cache across cases,
// same DI precedent as fetchImpl/randomImpl elsewhere in this repo.
function freshCalendarCtx(extra = {}) {
  return { calendarTokenCache: googleCalendar.createTokenCache(), ...extra };
}

test('confirmAppointment() rejects a resolved time already in the past and does not create an appointment', async () => {
  const db = freshDb();
  activateMeta(db);
  const fetchImpl = fakeMetaFetch();
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: '2020-01-01', hora: '10:00', duracion: '30', pago: 'al_llegar', total: 0, from: '5215500000001' },
    { db, fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'past_time');
  assert.equal(appointments.listActiveAppointments(db).length, 0);
  // customer must still be told, even though nothing was booked
  const notifyCall = fetchImpl.calls.find((c) => c.url.includes('/messages'));
  assert.ok(notifyCall);
  assert.match(JSON.parse(notifyCall.opts.body).text.body, /ya pasó/);
});

test('confirmAppointment() rejects a slot already booked by a DIFFERENT customer', async () => {
  const db = freshDb();
  activateMeta(db);
  appointments.createAppointment(db, {
    id: 'existing-1', customerPhone: '5215500001111', service: 'Corte',
    date: '2030-01-15', time: '15:00', durationMinutes: 30, total: 0, status: 'confirmed',
  });
  const fetchImpl = fakeMetaFetch();
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: '2030-01-15', hora: '15:00', duracion: '30', pago: 'al_llegar', total: 0, from: '5215500009999' },
    { db, fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'slot_conflict');
  assert.equal(appointments.listActiveAppointments(db).length, 1); // only the pre-existing one
});

test('confirmAppointment() allows a customer to reschedule their OWN prior booking for the same slot', async () => {
  const db = freshDb();
  activateMeta(db);
  appointments.createAppointment(db, {
    id: 'existing-1', customerPhone: '5215500000001', service: 'Corte',
    date: '2030-01-15', time: '15:00', durationMinutes: 30, total: 0, status: 'confirmed',
  });
  const fetchImpl = fakeMetaFetch();
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: '2030-01-15', hora: '15:00', duracion: '30', pago: 'al_llegar', total: 0, from: '5215500000001' },
    { db, fetchImpl }
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

test('confirmAppointment() books successfully, creates a real Calendar event with a Meet link, and notifies the customer', async () => {
  const db = freshDb();
  activateMeta(db);
  activateCalendar(db);
  const fetchImpl = fakeMetaFetch();
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: '2030-01-15', hora: '15:00', duracion: '30', pago: 'tarjeta', total: 200, from: '5215500000001' },
    freshCalendarCtx({ db, fetchImpl })
  );

  assert.equal(result.ok, true);
  assert.equal(result.googleEventId, 'evt_fake');
  assert.equal(result.meetLink, 'https://meet.google.com/fake');

  const stored = appointments.getAppointmentById(db, result.id);
  assert.equal(stored.customerPhone, '5215500000001');
  assert.equal(stored.date, '2030-01-15');
  assert.equal(stored.time, '15:00');
  assert.equal(stored.googleEventId, 'evt_fake');
  assert.equal(stored.meetLink, 'https://meet.google.com/fake');

  const calendarCall = fetchImpl.calls.find((c) => c.url.includes('calendar/v3'));
  assert.ok(calendarCall);
  const notifyCall = fetchImpl.calls.find((c) => c.url.includes('/messages'));
  assert.match(JSON.parse(notifyCall.opts.body).text.body, /meet\.google\.com\/fake/);
});

test('confirmAppointment() books locally and notifies the customer even when google_calendar is not active (no local-fallback backend, but the appointment record + guards still work)', async () => {
  const db = freshDb();
  activateMeta(db);
  const fetchImpl = fakeMetaFetch();
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: '2030-01-15', hora: '15:00', duracion: '30', pago: 'al_llegar', total: 0, from: '5215500000001' },
    { db, fetchImpl }
  );
  assert.equal(result.ok, true);
  assert.equal(result.googleEventId, null);
  const calendarCall = fetchImpl.calls.find((c) => c.url.includes('calendar/v3'));
  assert.equal(calendarCall, undefined);
});

test('confirmAppointment() degrades gracefully (still books) when Calendar event creation fails outright', async () => {
  const db = freshDb();
  activateMeta(db);
  activateCalendar(db);
  const fetchImpl = async (url, opts) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fake', expires_in: 3600 }) };
    }
    if (url.includes('calendar/v3')) {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'internal error' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: '2030-01-15', hora: '15:00', duracion: '30', pago: 'al_llegar', total: 0, from: '5215500000001' },
    freshCalendarCtx({ db, fetchImpl })
  );
  assert.equal(result.ok, true);
  assert.equal(result.googleEventId, null);
  assert.equal(appointments.listActiveAppointments(db).length, 1);
});

test('confirmAppointment() closes the scheduling gate (status=error) when the Calendar refresh token is invalid_grant', async () => {
  const db = freshDb();
  activateMeta(db);
  activateCalendar(db);
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: '2030-01-15', hora: '15:00', duracion: '30', pago: 'al_llegar', total: 0, from: '5215500000001' },
    freshCalendarCtx({ db, fetchImpl })
  );
  assert.equal(result.ok, true); // booking still succeeds locally
  assert.equal(result.googleEventId, null);
  assert.equal(store.getIntegrationPublic(db, 'google_calendar').status, 'error');
});

test('confirmAppointment() resolves without throwing (and without booking) when no db is provided in ctx', async () => {
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: 'mañana', hora: '10:00', duracion: '30', pago: 'tarjeta', total: 200, from: '5215500000001' },
    {}
  );
  assert.equal(result.ok, false);
});

// ── confirmOrder — documented stub (Phase 9 owns the real thing) ─────────

test('confirmOrder() resolves with a stub result, never throws, and never actually charges/creates a checkout session', async () => {
  const result = await confirmOrder({ products: [{ name: 'Camisa', qty: 1, price: 100 }], total: 100, from: '5215500000001' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.stub, true);
  assert.ok(result.reason);
});

// ── sendPhoto — documented stub (no catalog table exists in any phase yet) ─

test('sendPhoto() resolves with a stub result, never throws, and never attempts a Graph API call', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const result = await sendPhoto({ productName: 'Camisa Roja', to: '5215500000001' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.stub, true);
  assert.equal(calls.length, 0);
});
