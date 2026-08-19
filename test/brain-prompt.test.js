'use strict';
// RED->GREEN for src/brain/prompt.js (tasks.md Phase 6.1, extended by
// Phase 7.1).
//
// Reference: WhiteLabel_WA_System/wa-brain-local/index.js's
// buildSystemPrompt() — structural pattern only (config.context +
// config.personalityCustom + soul-docs rules text assembled into a system
// prompt), not a literal line-for-line port. See src/brain/prompt.js's own
// header comment for the full scope-boundary rationale.
//
// PR9/Phase 7 update: this file now DOES emit control-tag protocol
// instructions for ESCALAR_HUMANO/DATOS_CONTACTO (always) and
// CITA_CONFIRMADA/PEDIDO_CONFIRMADO (capability-gated) — landing in the
// SAME PR as src/agent/tags.js + src/agent/pipeline.js, which parse/strip/
// gate exactly those tags (PR8's own hard requirement: never ship prompt
// instructions for a tag without the pipeline that handles it). ENVIAR_FOTO
// is still never instructed — no catalog table exists yet to reference.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt } = require('../src/brain/prompt');

test('buildSystemPrompt() includes business context when present', () => {
  const prompt = buildSystemPrompt({ appConfig: { context: 'Vendemos productos de belleza.' } });
  assert.match(prompt, /Vendemos productos de belleza\./);
});

test('buildSystemPrompt() includes personalityCustom instructions when present', () => {
  const prompt = buildSystemPrompt({ appConfig: { personalityCustom: 'Sé breve y usa emojis con moderación.' } });
  assert.match(prompt, /Sé breve y usa emojis con moderación\./);
});

test('buildSystemPrompt() includes soulDocs rules content when present', () => {
  const prompt = buildSystemPrompt({ appConfig: { soulDocs: 'Nunca ofrezcas descuentos sin autorización.' } });
  assert.match(prompt, /Nunca ofrezcas descuentos sin autorización\./);
});

test('buildSystemPrompt() includes a personality preset line for non-custom presets', () => {
  const prompt = buildSystemPrompt({ appConfig: { personality: 'amigable' } });
  assert.match(prompt, /cálida|cercana|amigable/i);
});

test('buildSystemPrompt() ignores the "custom" personality preset marker (personalityCustom carries the actual text)', () => {
  const prompt = buildSystemPrompt({ appConfig: { personality: 'custom' } });
  assert.doesNotMatch(prompt, /TONO:/);
});

test('buildSystemPrompt() includes the business name when present', () => {
  const prompt = buildSystemPrompt({ appConfig: { businessName: 'Bella Studio' } });
  assert.match(prompt, /Bella Studio/);
});

test('buildSystemPrompt() omits absent fields cleanly (no "undefined" leaking into the prompt)', () => {
  const prompt = buildSystemPrompt({ appConfig: {} });
  assert.doesNotMatch(prompt, /undefined/);
  assert.ok(prompt.length > 0);
});

test('buildSystemPrompt() defaults to a sane prompt when called with no arguments at all', () => {
  const prompt = buildSystemPrompt();
  assert.doesNotMatch(prompt, /undefined/);
  assert.ok(prompt.length > 0);
});

// ── Capability gating, layer 1 (prevention) — design.md ─────────────────────

test('buildSystemPrompt() adds an explicit no-booking decline line when scheduling capability is off', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: false, payments: true } });
  assert.match(prompt, /no puedes agendar|no puedo agendar/i);
});

test('buildSystemPrompt() adds an explicit no-payment-link decline line when payments capability is off', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: true, payments: false } });
  assert.match(prompt, /no puedes generar enlaces de pago|no puedo generar enlaces de pago/i);
});

test('buildSystemPrompt() does not emit the decline lines when both capabilities are on', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: true, payments: true } });
  assert.doesNotMatch(prompt, /no puedes agendar|no puedo agendar/i);
  assert.doesNotMatch(prompt, /no puedes generar enlaces de pago|no puedo generar enlaces de pago/i);
});

// ── Control-tag protocol instructions (Phase 7 — lands with the pipeline
// that parses/strips/gates these exact tags, see src/agent/tags.js and
// src/agent/pipeline.js) ─────────────────────────────────────────────────

test('buildSystemPrompt() always instructs [ESCALAR_HUMANO:reason], regardless of capability state', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: {} });
  assert.match(prompt, /\[ESCALAR_HUMANO:/);
});

test('buildSystemPrompt() always instructs [DATOS_CONTACTO]...[/DATOS_CONTACTO], regardless of capability state', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: {} });
  assert.match(prompt, /\[DATOS_CONTACTO\]/);
  assert.match(prompt, /\[\/DATOS_CONTACTO\]/);
});

test('buildSystemPrompt() instructs [CITA_CONFIRMADA]...[/CITA_CONFIRMADA] with the exact parseable field labels when scheduling is on', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: true, payments: false } });
  assert.match(prompt, /\[CITA_CONFIRMADA\]/);
  assert.match(prompt, /\[\/CITA_CONFIRMADA\]/);
  assert.match(prompt, /Servicio:/);
  assert.match(prompt, /Fecha:/);
  assert.match(prompt, /Hora:/);
  assert.match(prompt, /Duracion:/);
  assert.match(prompt, /Pago:/);
  assert.match(prompt, /Total:/);
});

test('buildSystemPrompt() omits [CITA_CONFIRMADA] instructions and keeps the decline line when scheduling is off', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: false, payments: true } });
  assert.doesNotMatch(prompt, /\[CITA_CONFIRMADA\]/);
  assert.match(prompt, /no puedes agendar|no puedo agendar/i);
});

test('buildSystemPrompt() instructs [PEDIDO_CONFIRMADO] with a parseable format when payments is on', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: false, payments: true } });
  assert.match(prompt, /PEDIDO_CONFIRMADO/);
});

test('buildSystemPrompt() omits [PEDIDO_CONFIRMADO] instructions and keeps the decline line when payments is off', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: true, payments: false } });
  assert.doesNotMatch(prompt, /\[PEDIDO_CONFIRMADO\]/);
  assert.match(prompt, /no puedes generar enlaces de pago|no puedo generar enlaces de pago/i);
});

// ── Scope boundary retained: ENVIAR_FOTO is never instructed (no catalog) ──

test('buildSystemPrompt() never instructs [ENVIAR_FOTO] — no catalog table exists yet to reference', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: true, payments: true } });
  assert.doesNotMatch(prompt, /\[ENVIAR_FOTO/);
});

test('buildSystemPrompt() accepts a catalog param without emitting product/photo-tag text (no catalog table yet)', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, catalog: [{ name: 'Producto X', price: 100 }] });
  assert.doesNotMatch(prompt, /Producto X/);
  assert.doesNotMatch(prompt, /\[ENVIAR_FOTO/);
});
