'use strict';
// RED->GREEN for src/brain/prompt.js (tasks.md Phase 6.1).
//
// Reference: WhiteLabel_WA_System/wa-brain-local/index.js's
// buildSystemPrompt() — structural pattern only (config.context +
// config.personalityCustom + soul-docs rules text assembled into a system
// prompt), not a literal line-for-line port. See src/brain/prompt.js's own
// header comment for the full scope-boundary rationale (no catalog table
// yet, no control-tag protocol text yet — Phase 7 ships tags.js/pipeline.js
// alongside the prompt blocks that describe them).

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

// ── Scope boundary: no control-tag protocol text yet (Phase 7's job) ────────

test('buildSystemPrompt() never instructs the model to emit control tags yet (no tags.js/pipeline.js to strip them)', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, capabilities: { scheduling: true, payments: true } });
  assert.doesNotMatch(prompt, /\[CITA_CONFIRMADA\]/);
  assert.doesNotMatch(prompt, /\[PEDIDO_CONFIRMADO\]/);
  assert.doesNotMatch(prompt, /\[ENVIAR_FOTO/);
});

test('buildSystemPrompt() accepts a catalog param without emitting product/photo-tag text (no catalog table yet)', () => {
  const prompt = buildSystemPrompt({ appConfig: {}, catalog: [{ name: 'Producto X', price: 100 }] });
  assert.doesNotMatch(prompt, /Producto X/);
});
