'use strict';
// src/agent/tags.js — control-tag parse/strip (tasks.md Phase 7.1, PORTED
// from WhiteLabel_WA_System's routes/webhook.js handleIncomingMessage()).
//
// Module boundary (design.md): "agent/tags.js is pure (parse/strip) so
// gating is unit-testable." This file NEVER decides whether a tag's effect
// should run (that's capability state, which src/agent/pipeline.js owns)
// and NEVER calls an effect itself (src/agent/effects/*). It only answers
// two questions from a raw Gemini reply string: (1) what tags are in here
// and what did they say, and (2) what does the text look like with every
// tag — known or unknown — removed.
//
// stripTags()'s regex chain is the customer-safety guarantee this whole
// phase exists for: it is PORTED VERBATIM from the source's cleanReply
// construction, ending in the exact same catch-all
// `\[\/?[A-Z_]+(?::[^\]]+)?\]` pattern. That catch-all is what guarantees
// no unknown/future tag can ever leak raw bracket syntax to a real
// customer, even for a tag this repo has no effect handler for yet
// (ENVIAR_FOTO today; whatever Phase 8/9/10 adds tomorrow).

/**
 * Customer-safe text: every known tag block/inline form is stripped first
 * (so their multi-line bodies don't get chopped by the single-line
 * catch-all below), then the catch-all removes anything left over that
 * still looks like a bracket tag, then excess blank lines collapse.
 * @param {string} rawReply
 * @returns {string}
 */
function stripTags(rawReply) {
  const text = rawReply || '';
  return text
    .replace(/\[DATOS_CONTACTO\][\s\S]*?\[\/DATOS_CONTACTO\]/g, '')
    .replace(/\[CITA_CONFIRMADA\][\s\S]*?\[\/CITA_CONFIRMADA\]/g, '')
    .replace(/\[PEDIDO_CONFIRMADO\][\s\S]*?\[\/PEDIDO_CONFIRMADO\]/g, '')
    .replace(/\[ESCALAR_HUMANO:[^\]]+\]/g, '')
    .replace(/\[\/?[A-Z_]+(?::[^\]]+)?\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract every tag occurrence from a raw Gemini reply. Returns raw
 * (unparsed) tag bodies only — see parseCitaFields()/parseOrderFields()/
 * parseContactFields() below for turning those bodies into structured data.
 * @param {string} rawReply
 * @returns {{
 *   photoTags: string[],
 *   order: {kind: 'block'|'inline', raw: string}|null,
 *   contact: {raw: string}|null,
 *   cita: {raw: string}|null,
 *   escalar: {reason: string}|null,
 * }}
 */
function parseTags(rawReply) {
  const text = rawReply || '';

  const photoTags = [...text.matchAll(/\[ENVIAR_FOTO:([^\]]+)\]/g)].map((m) => m[1].trim());

  const orderBlockMatch = text.match(/\[PEDIDO_CONFIRMADO\]\s*([\s\S]*?)\s*\[\/PEDIDO_CONFIRMADO\]/);
  // Greedy (not `.*?`) so a nested items array's own `}` doesn't false-match
  // the closing `}]` early — a JSON order payload legitimately contains
  // internal `}` characters before its own final one.
  const orderInlineMatch = text.match(/\[PEDIDO_CONFIRMADO:(\{[\s\S]*\})\]/);
  const order = orderBlockMatch
    ? { kind: 'block', raw: orderBlockMatch[1] }
    : orderInlineMatch
      ? { kind: 'inline', raw: orderInlineMatch[1] }
      : null;

  const contactMatch = text.match(/\[DATOS_CONTACTO\]\s*([\s\S]*?)\s*\[\/DATOS_CONTACTO\]/);
  const contact = contactMatch ? { raw: contactMatch[1] } : null;

  const citaMatch = text.match(/\[CITA_CONFIRMADA\]\s*([\s\S]*?)\s*\[\/CITA_CONFIRMADA\]/);
  const cita = citaMatch ? { raw: citaMatch[1] } : null;

  const escalarMatch = text.match(/\[ESCALAR_HUMANO:\s*([^\]]+)\]/);
  const escalar = escalarMatch ? { reason: escalarMatch[1].trim() } : null;

  return { photoTags, order, contact, cita, escalar };
}

/**
 * Structured fields from a [CITA_CONFIRMADA] body. Deliberately does NOT
 * resolve "Fecha" into an actual date/time (the source's parseFlexDate()) —
 * date resolution + the past-time/double-booking guards that depend on it
 * are Phase 8's job (tasks.md Phase 8.1/8.2), which also owns the real
 * Google Calendar event creation these fields eventually feed.
 * @param {string} raw
 */
function parseCitaFields(raw) {
  const text = raw || '';
  const servicio = text.match(/Servicio:\s*(.+)/i)?.[1]?.trim() || '';
  const fecha = text.match(/Fecha:\s*(.+)/i)?.[1]?.trim() || '';
  const hora = text.match(/Hora:\s*(.+)/i)?.[1]?.trim() || '';
  const duracion = text.match(/Duracion:\s*(\d+)/i)?.[1] || '';
  const pago = text.match(/Pago:\s*(.+)/i)?.[1]?.trim() || '';
  const totalStr = text.match(/Total:\s*\$?([\d,.]+)/i)?.[1];
  const total = totalStr ? parseFloat(totalStr.replace(',', '')) : 0;
  return { servicio, fecha, hora, duracion, pago, total };
}

/**
 * Structured fields from a parsed order tag (either kind returned by
 * parseTags()'s `order`). Never throws on malformed inline JSON — a broken
 * payload from the model must degrade to an empty, loggable order, not
 * crash the reply pipeline.
 * @param {{kind: 'block'|'inline', raw: string}|null} order
 */
function parseOrderFields(order) {
  if (!order) return null;

  if (order.kind === 'inline') {
    try {
      const payload = JSON.parse(order.raw);
      const products = payload.items || payload.products || [];
      const total = payload.total ?? products.reduce((sum, p) => sum + p.price * (p.qty || 1), 0);
      return { products, total };
    } catch (err) {
      return { products: [], total: 0, parseError: err.message };
    }
  }

  const products = [];
  let total = 0;
  for (const line of order.raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const totalLine = trimmed.match(/^total[:\s]*\$?([\d,.]+)/i);
    if (totalLine) {
      total = parseFloat(totalLine[1].replace(',', ''));
      continue;
    }
    const prodLine = trimmed.match(/^(.+?)\s+x(\d+)\s+\$?([\d,.]+)/i);
    if (prodLine) {
      products.push({ name: prodLine[1].trim(), qty: parseInt(prodLine[2], 10), price: parseFloat(prodLine[3].replace(',', '')) });
    }
  }
  if (!total && products.length) {
    total = products.reduce((sum, p) => sum + p.price * p.qty, 0);
  }
  return { products, total };
}

/**
 * Structured fields from a [DATOS_CONTACTO] body.
 * @param {string} raw
 */
function parseContactFields(raw) {
  const text = raw || '';
  const name = text.match(/Nombre:\s*(.+)/i)?.[1]?.trim() || '';
  const business = text.match(/Negocio:\s*(.+)/i)?.[1]?.trim() || '';
  return { name, business };
}

module.exports = {
  stripTags,
  parseTags,
  parseCitaFields,
  parseOrderFields,
  parseContactFields,
};
