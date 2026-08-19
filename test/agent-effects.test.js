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
// Three DOCUMENTED STUBS (seam only — real implementation lands with the
// phase that builds the table/integration each one needs):
//   - confirmAppointment: Phase 8 (Google Calendar event creation + past-
//     time/double-booking guards)
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

// ── confirmAppointment — documented stub (Phase 8 owns the real thing) ───

test('confirmAppointment() resolves with a stub result, never throws, and never actually books anything', async () => {
  const result = await confirmAppointment(
    { servicio: 'Corte', fecha: 'mañana', hora: '10:00', duracion: '30', pago: 'tarjeta', total: 200, from: '5215500000001' },
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.stub, true);
  assert.ok(result.reason);
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
