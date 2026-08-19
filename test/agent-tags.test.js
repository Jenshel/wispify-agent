'use strict';
// RED->GREEN for src/agent/tags.js (tasks.md Phase 7.1).
//
// Pure parse/strip functions ONLY — no capability gating, no effect
// dispatch, no I/O (design.md: "agent/tags.js is pure (parse/strip) so
// gating is unit-testable"). src/agent/pipeline.js is the layer that reads
// these results and decides what to do about capability state.
//
// The stripTags() regex chain is PORTED VERBATIM (in spirit) from
// WhiteLabel_WA_System/routes/webhook.js's cleanReply construction inside
// handleIncomingMessage() — including the catch-all `\[\/?[A-Z_]+...\]`
// pattern that guarantees NO unknown/future bracket tag can ever leak to a
// real customer, even one this repo hasn't implemented a handler for yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tags = require('../src/agent/tags');

// ── stripTags() — the customer-safety guarantee ──────────────────────────

test('stripTags() removes a [DATOS_CONTACTO]...[/DATOS_CONTACTO] block entirely', () => {
  const raw = 'Perfecto.[DATOS_CONTACTO]\nNombre: Ana\nNegocio: Bella Studio\n[/DATOS_CONTACTO] Gracias por tu info.';
  const clean = tags.stripTags(raw);
  assert.doesNotMatch(clean, /DATOS_CONTACTO/);
  assert.doesNotMatch(clean, /Ana/);
  assert.match(clean, /Perfecto\./);
  assert.match(clean, /Gracias por tu info\./);
});

test('stripTags() removes a [CITA_CONFIRMADA]...[/CITA_CONFIRMADA] block entirely', () => {
  const raw = '¡Listo![CITA_CONFIRMADA]\nServicio: Corte\nFecha: mañana\nHora: 10:00\n[/CITA_CONFIRMADA]';
  const clean = tags.stripTags(raw);
  assert.doesNotMatch(clean, /CITA_CONFIRMADA/);
  assert.doesNotMatch(clean, /Servicio/);
  assert.match(clean, /¡Listo!/);
});

test('stripTags() removes a [PEDIDO_CONFIRMADO]...[/PEDIDO_CONFIRMADO] block entirely', () => {
  const raw = 'Tu pedido:[PEDIDO_CONFIRMADO]\nProducto x1 $100\nTotal: $100\n[/PEDIDO_CONFIRMADO] Gracias.';
  const clean = tags.stripTags(raw);
  assert.doesNotMatch(clean, /PEDIDO_CONFIRMADO/);
  assert.doesNotMatch(clean, /Producto x1/);
});

test('stripTags() removes an inline [PEDIDO_CONFIRMADO:{json}] tag', () => {
  const raw = 'Confirmado [PEDIDO_CONFIRMADO:{"items":[{"name":"X","price":10}],"total":10}] gracias';
  const clean = tags.stripTags(raw);
  assert.doesNotMatch(clean, /PEDIDO_CONFIRMADO/);
  assert.match(clean, /Confirmado/);
  assert.match(clean, /gracias/);
});

test('stripTags() removes [ESCALAR_HUMANO:reason]', () => {
  const raw = 'Un momento, te conecto con el equipo.[ESCALAR_HUMANO:cliente molesto]';
  const clean = tags.stripTags(raw);
  assert.doesNotMatch(clean, /ESCALAR_HUMANO/);
  assert.match(clean, /te conecto con el equipo\./);
});

test('stripTags() removes [ENVIAR_FOTO:productName] tags', () => {
  const raw = 'Aquí tienes: [ENVIAR_FOTO:Camisa Roja] ¿Te gusta?';
  const clean = tags.stripTags(raw);
  assert.doesNotMatch(clean, /ENVIAR_FOTO/);
  assert.match(clean, /Aquí tienes:/);
});

test('stripTags() strips an unknown/future bracket tag via the catch-all — nothing ever leaks', () => {
  const raw = 'Hola [ALGUN_TAG_FUTURO:x] mundo [/OTRO_TAG]';
  const clean = tags.stripTags(raw);
  assert.doesNotMatch(clean, /\[/);
  assert.doesNotMatch(clean, /\]/);
  assert.match(clean, /Hola/);
  assert.match(clean, /mundo/);
});

test('stripTags() collapses 3+ blank lines left behind by a stripped block down to one blank line', () => {
  const raw = 'Antes\n\n\n\n[DATOS_CONTACTO]\nNombre: X\n[/DATOS_CONTACTO]\n\n\n\nDespués';
  const clean = tags.stripTags(raw);
  assert.doesNotMatch(clean, /\n{3,}/);
});

test('stripTags() trims leading/trailing whitespace', () => {
  const clean = tags.stripTags('   hola   ');
  assert.equal(clean, 'hola');
});

test('stripTags() handles null/undefined/empty input without throwing', () => {
  assert.equal(tags.stripTags(null), '');
  assert.equal(tags.stripTags(undefined), '');
  assert.equal(tags.stripTags(''), '');
});

test('stripTags() leaves plain text with no tags completely untouched (besides trim)', () => {
  const clean = tags.stripTags('Hola, ¿en qué puedo ayudarte hoy?');
  assert.equal(clean, 'Hola, ¿en qué puedo ayudarte hoy?');
});

// ── parseTags() — extraction, no side effects ────────────────────────────

test('parseTags() extracts every [ENVIAR_FOTO:x] occurrence in order', () => {
  const raw = '[ENVIAR_FOTO:Camisa Roja] y también [ENVIAR_FOTO:Pantalón Azul]';
  const parsed = tags.parseTags(raw);
  assert.deepEqual(parsed.photoTags, ['Camisa Roja', 'Pantalón Azul']);
});

test('parseTags() returns an empty photoTags array when none are present', () => {
  const parsed = tags.parseTags('hola');
  assert.deepEqual(parsed.photoTags, []);
});

test('parseTags() extracts a block-style [PEDIDO_CONFIRMADO] as kind "block"', () => {
  const raw = '[PEDIDO_CONFIRMADO]\nCamisa x2 $50\nTotal: $100\n[/PEDIDO_CONFIRMADO]';
  const parsed = tags.parseTags(raw);
  assert.ok(parsed.order);
  assert.equal(parsed.order.kind, 'block');
  assert.match(parsed.order.raw, /Camisa x2 \$50/);
});

test('parseTags() extracts an inline [PEDIDO_CONFIRMADO:{json}] as kind "inline"', () => {
  const raw = '[PEDIDO_CONFIRMADO:{"total":100}]';
  const parsed = tags.parseTags(raw);
  assert.ok(parsed.order);
  assert.equal(parsed.order.kind, 'inline');
  assert.equal(parsed.order.raw, '{"total":100}');
});

test('parseTags() returns order: null when no order tag is present', () => {
  const parsed = tags.parseTags('hola');
  assert.equal(parsed.order, null);
});

test('parseTags() extracts the [DATOS_CONTACTO] block body', () => {
  const raw = '[DATOS_CONTACTO]\nNombre: Ana\nNegocio: Bella Studio\n[/DATOS_CONTACTO]';
  const parsed = tags.parseTags(raw);
  assert.ok(parsed.contact);
  assert.match(parsed.contact.raw, /Nombre: Ana/);
});

test('parseTags() extracts the [CITA_CONFIRMADA] block body', () => {
  const raw = '[CITA_CONFIRMADA]\nServicio: Corte\nFecha: mañana\nHora: 10:00\n[/CITA_CONFIRMADA]';
  const parsed = tags.parseTags(raw);
  assert.ok(parsed.cita);
  assert.match(parsed.cita.raw, /Servicio: Corte/);
});

test('parseTags() extracts the [ESCALAR_HUMANO:reason] reason, trimmed', () => {
  const raw = '[ESCALAR_HUMANO:  cliente molesto  ]';
  const parsed = tags.parseTags(raw);
  assert.ok(parsed.escalar);
  assert.equal(parsed.escalar.reason, 'cliente molesto');
});

test('parseTags() returns null for every tag field when the reply has no tags at all', () => {
  const parsed = tags.parseTags('Hola, ¿en qué puedo ayudarte?');
  assert.equal(parsed.order, null);
  assert.equal(parsed.contact, null);
  assert.equal(parsed.cita, null);
  assert.equal(parsed.escalar, null);
  assert.deepEqual(parsed.photoTags, []);
});

test('parseTags() handles null/undefined input without throwing', () => {
  assert.doesNotThrow(() => tags.parseTags(null));
  assert.doesNotThrow(() => tags.parseTags(undefined));
});

// ── parseCitaFields() — structured extraction from a [CITA_CONFIRMADA] body ─

test('parseCitaFields() extracts Servicio/Fecha/Hora/Duracion/Pago/Total fields', () => {
  const raw = 'Servicio: Corte de cabello\nFecha: mañana\nHora: 15:30\nDuracion: 45\nPago: tarjeta\nTotal: $350';
  const fields = tags.parseCitaFields(raw);
  assert.equal(fields.servicio, 'Corte de cabello');
  assert.equal(fields.fecha, 'mañana');
  assert.equal(fields.hora, '15:30');
  assert.equal(fields.duracion, '45');
  assert.equal(fields.pago, 'tarjeta');
  assert.equal(fields.total, 350);
});

test('parseCitaFields() defaults missing fields to empty/zero rather than throwing', () => {
  const fields = tags.parseCitaFields('');
  assert.equal(fields.servicio, '');
  assert.equal(fields.fecha, '');
  assert.equal(fields.total, 0);
});

// ── parseOrderFields() — structured extraction from a parsed order tag ──────

test('parseOrderFields() parses a JSON inline order payload', () => {
  const order = { kind: 'inline', raw: '{"items":[{"name":"Camisa","price":50,"qty":2}],"total":100}' };
  const fields = tags.parseOrderFields(order);
  assert.equal(fields.total, 100);
  assert.equal(fields.products.length, 1);
  assert.equal(fields.products[0].name, 'Camisa');
});

test('parseOrderFields() computes total from line items when the JSON payload omits it', () => {
  const order = { kind: 'inline', raw: '{"items":[{"name":"Camisa","price":50,"qty":2}]}' };
  const fields = tags.parseOrderFields(order);
  assert.equal(fields.total, 100);
});

test('parseOrderFields() parses a block-style "Name xQty $price" order body', () => {
  const order = { kind: 'block', raw: 'Camisa x2 $50\nPantalón x1 $200\nTotal: $300' };
  const fields = tags.parseOrderFields(order);
  assert.equal(fields.total, 300);
  assert.equal(fields.products.length, 2);
  assert.equal(fields.products[0].name, 'Camisa');
  assert.equal(fields.products[0].qty, 2);
  assert.equal(fields.products[0].price, 50);
});

test('parseOrderFields() computes total from block line items when no Total: line is present', () => {
  const order = { kind: 'block', raw: 'Camisa x2 $50' };
  const fields = tags.parseOrderFields(order);
  assert.equal(fields.total, 100);
});

test('parseOrderFields() returns null when passed a null order', () => {
  assert.equal(tags.parseOrderFields(null), null);
});

test('parseOrderFields() never throws on malformed inline JSON — returns an empty order with a parseError note', () => {
  const order = { kind: 'inline', raw: '{not valid json' };
  const fields = tags.parseOrderFields(order);
  assert.deepEqual(fields.products, []);
  assert.equal(fields.total, 0);
  assert.ok(fields.parseError);
});

// ── parseContactFields() — structured extraction from a [DATOS_CONTACTO] body ─

test('parseContactFields() extracts Nombre/Negocio fields', () => {
  const fields = tags.parseContactFields('Nombre: Ana Pérez\nNegocio: Bella Studio');
  assert.equal(fields.name, 'Ana Pérez');
  assert.equal(fields.business, 'Bella Studio');
});

test('parseContactFields() defaults missing fields to empty strings', () => {
  const fields = tags.parseContactFields('');
  assert.equal(fields.name, '');
  assert.equal(fields.business, '');
});
