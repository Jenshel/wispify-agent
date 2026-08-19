'use strict';
// RED->GREEN for src/agent/pipeline.js (tasks.md Phase 7.2/7.3).
//
// This is the CAPABILITY GATING layer design.md calls the "hard guarantee":
// "agent/pipeline.js drops any tag whose capability is off, strips it from
// the outgoing text, logs [TAG_DROPPED], runs no effect. Prompt compliance
// is probabilistic; this is the guarantee." runPipeline() never calls a
// provider or touches a db itself — it takes a capabilities snapshot and
// returns effect *descriptors* (tasks.md/PR9 scope: "extracted tag data,
// not yet executed"); src/brain/index.js is the caller that dispatches them
// to src/agent/effects/*.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runPipeline } = require('../src/agent/pipeline');

// ── cleanReply — unconditional, regardless of capability state ──────────
// This is the universal guarantee from the PR9 delegated instructions: every
// tag is stripped from the customer-visible text whether or not its
// capability is on, whether or not it has a real effect yet.

test('runPipeline() never leaks raw tag syntax into cleanReply, even when a capability is off', () => {
  const raw = '¡Listo![CITA_CONFIRMADA]\nServicio: Corte\nFecha: hoy\nHora: 10:00\n[/CITA_CONFIRMADA]';
  const result = runPipeline(raw, { capabilities: { scheduling: false, payments: false } });
  assert.doesNotMatch(result.cleanReply, /\[/);
  assert.match(result.cleanReply, /¡Listo!/);
});

test('runPipeline() never leaks raw tag syntax into cleanReply for an unrecognized/future tag', () => {
  const raw = 'Hola [FUTURO_TAG:x] mundo';
  const result = runPipeline(raw, {});
  assert.doesNotMatch(result.cleanReply, /\[/);
});

// ── Always-available tags: no capability gate ────────────────────────────

test('runPipeline() always queues escalateHuman when [ESCALAR_HUMANO] is present, regardless of capabilities', () => {
  const raw = 'Un momento.[ESCALAR_HUMANO:cliente molesto]';
  const result = runPipeline(raw, { capabilities: {} });
  const call = result.effectCalls.find((c) => c.effect === 'escalateHuman');
  assert.ok(call);
  assert.equal(call.payload.reason, 'cliente molesto');
  assert.equal(result.dropped.length, 0);
});

test('runPipeline() always queues captureContactData when [DATOS_CONTACTO] is present', () => {
  const raw = '[DATOS_CONTACTO]\nNombre: Ana\nNegocio: Bella Studio\n[/DATOS_CONTACTO]';
  const result = runPipeline(raw, { capabilities: {} });
  const call = result.effectCalls.find((c) => c.effect === 'captureContactData');
  assert.ok(call);
  assert.equal(call.payload.name, 'Ana');
  assert.equal(call.payload.business, 'Bella Studio');
});

// ── Capability-gated tags: the enforcement guarantee ─────────────────────

test('runPipeline() queues confirmAppointment when [CITA_CONFIRMADA] is present AND scheduling is on', () => {
  const raw = '[CITA_CONFIRMADA]\nServicio: Corte\nFecha: hoy\nHora: 10:00\nDuracion: 30\nPago: tarjeta\nTotal: $200\n[/CITA_CONFIRMADA]';
  const result = runPipeline(raw, { capabilities: { scheduling: true } });
  const call = result.effectCalls.find((c) => c.effect === 'confirmAppointment');
  assert.ok(call);
  assert.equal(call.payload.servicio, 'Corte');
  assert.equal(result.dropped.length, 0);
});

test('runPipeline() drops [CITA_CONFIRMADA] and logs [TAG_DROPPED] when scheduling is off — no effect queued', () => {
  const raw = '[CITA_CONFIRMADA]\nServicio: Corte\nFecha: hoy\nHora: 10:00\n[/CITA_CONFIRMADA]';
  const result = runPipeline(raw, { capabilities: { scheduling: false } });
  assert.equal(result.effectCalls.find((c) => c.effect === 'confirmAppointment'), undefined);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].tag, 'CITA_CONFIRMADA');
  assert.equal(result.dropped[0].reason, 'scheduling_off');
});

test('runPipeline() drops [CITA_CONFIRMADA] when capabilities is entirely omitted (defaults to off)', () => {
  const raw = '[CITA_CONFIRMADA]\nServicio: Corte\nFecha: hoy\nHora: 10:00\n[/CITA_CONFIRMADA]';
  const result = runPipeline(raw);
  assert.equal(result.effectCalls.find((c) => c.effect === 'confirmAppointment'), undefined);
  assert.equal(result.dropped[0].reason, 'scheduling_off');
});

test('runPipeline() queues confirmOrder when [PEDIDO_CONFIRMADO] is present AND payments is on', () => {
  const raw = '[PEDIDO_CONFIRMADO:{"items":[{"name":"Camisa","price":100,"qty":1}],"total":100}]';
  const result = runPipeline(raw, { capabilities: { payments: true } });
  const call = result.effectCalls.find((c) => c.effect === 'confirmOrder');
  assert.ok(call);
  assert.equal(call.payload.total, 100);
  assert.equal(result.dropped.length, 0);
});

test('runPipeline() drops [PEDIDO_CONFIRMADO] and logs [TAG_DROPPED] when payments is off — no effect queued', () => {
  const raw = '[PEDIDO_CONFIRMADO:{"total":100}]';
  const result = runPipeline(raw, { capabilities: { payments: false } });
  assert.equal(result.effectCalls.find((c) => c.effect === 'confirmOrder'), undefined);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].tag, 'PEDIDO_CONFIRMADO');
  assert.equal(result.dropped[0].reason, 'payments_off');
});

// ── ENVIAR_FOTO — no capability concept exists yet (no catalog table) ────
// Always routed to the stub effect rather than silently dropped, so the
// seam is exercised end to end even though there's nothing to look up yet
// (see src/agent/effects/photos.js).

test('runPipeline() queues sendPhoto for every [ENVIAR_FOTO:x] regardless of capabilities', () => {
  const raw = '[ENVIAR_FOTO:Camisa Roja] y [ENVIAR_FOTO:Pantalón Azul]';
  const result = runPipeline(raw, { capabilities: {} });
  const calls = result.effectCalls.filter((c) => c.effect === 'sendPhoto');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.productName, 'Camisa Roja');
  assert.equal(calls[1].payload.productName, 'Pantalón Azul');
});

// ── No tags at all ────────────────────────────────────────────────────────

test('runPipeline() returns an empty effectCalls/dropped list and an unmodified cleanReply for plain text', () => {
  const result = runPipeline('Hola, ¿en qué puedo ayudarte?', { capabilities: { scheduling: true, payments: true } });
  assert.equal(result.cleanReply, 'Hola, ¿en qué puedo ayudarte?');
  assert.deepEqual(result.effectCalls, []);
  assert.deepEqual(result.dropped, []);
});

test('runPipeline() handles a null/undefined raw reply without throwing', () => {
  assert.doesNotThrow(() => runPipeline(null));
  assert.doesNotThrow(() => runPipeline(undefined));
  const result = runPipeline(null);
  assert.equal(result.cleanReply, '');
  assert.deepEqual(result.effectCalls, []);
});
