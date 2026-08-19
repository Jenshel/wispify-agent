'use strict';
// src/agent/pipeline.js — control-tag capability gate + effect dispatch list
// (tasks.md Phase 7.2/7.3, design.md "Effect (enforcement)" layer).
//
// design.md: "capabilities() = { chat, scheduling, payments }... Enforced
// twice: 1. Prompt (prevention) — buildSystemPrompt(...). 2. Effect
// (enforcement) — agent/pipeline.js drops any tag whose capability is off,
// strips it from the outgoing text, logs [TAG_DROPPED], runs no effect.
// Prompt compliance is probabilistic; this is the guarantee."
//
// This module is the seam between src/agent/tags.js (pure parse/strip) and
// src/agent/effects/* (the functions that actually DO something). It never
// calls a provider, never touches a db, never awaits anything — it takes a
// raw reply string + a capabilities snapshot and returns a plain
// description of what to do: the customer-safe text, and a list of effect
// calls (name + payload) for the caller (src/brain/index.js) to dispatch.
// This split keeps capability-gating logic pure and trivially unit-testable
// (design.md: "gating is unit-testable"), independent of how effects are
// actually executed.
//
// Scope note — PR9/Phase 7: cleanReply is stripped UNCONDITIONALLY,
// regardless of capability state or whether an effect exists yet. A tag
// being "off" or "not built yet" changes whether its effect runs; it never
// changes whether the raw bracket syntax is allowed to reach the customer.
//
// ENVIAR_FOTO has no capability flag (capabilities.js has no `catalog`/
// `photos` concept — there's no catalog table for such a flag to gate
// anything meaningful yet). Rather than silently drop it, every occurrence
// is routed to the `sendPhoto` effect, whose stub implementation documents
// why it can't do anything real yet (see src/agent/effects/photos.js).

const tags = require('./tags');

const TAG_DROPPED_PREFIX = '[TAG_DROPPED]';

/**
 * @param {string} rawReply
 * @param {{capabilities?: {scheduling?: boolean, payments?: boolean}}} [opts]
 * @returns {{
 *   cleanReply: string,
 *   effectCalls: Array<{effect: string, payload: object}>,
 *   dropped: Array<{tag: string, reason: string}>,
 * }}
 */
function runPipeline(rawReply, { capabilities = {} } = {}) {
  const text = rawReply || '';
  const parsed = tags.parseTags(text);
  const cleanReply = tags.stripTags(text);

  const effectCalls = [];
  const dropped = [];

  if (parsed.escalar) {
    effectCalls.push({ effect: 'escalateHuman', payload: { reason: parsed.escalar.reason } });
  }

  if (parsed.contact) {
    effectCalls.push({ effect: 'captureContactData', payload: tags.parseContactFields(parsed.contact.raw) });
  }

  if (parsed.cita) {
    if (capabilities.scheduling) {
      effectCalls.push({ effect: 'confirmAppointment', payload: tags.parseCitaFields(parsed.cita.raw) });
    } else {
      dropped.push({ tag: 'CITA_CONFIRMADA', reason: 'scheduling_off' });
      console.warn(`${TAG_DROPPED_PREFIX} CITA_CONFIRMADA — scheduling capability off, no appointment effect run`);
    }
  }

  if (parsed.order) {
    if (capabilities.payments) {
      effectCalls.push({ effect: 'confirmOrder', payload: tags.parseOrderFields(parsed.order) });
    } else {
      dropped.push({ tag: 'PEDIDO_CONFIRMADO', reason: 'payments_off' });
      console.warn(`${TAG_DROPPED_PREFIX} PEDIDO_CONFIRMADO — payments capability off, no order effect run`);
    }
  }

  for (const productName of parsed.photoTags) {
    effectCalls.push({ effect: 'sendPhoto', payload: { productName } });
  }

  return { cleanReply, effectCalls, dropped };
}

module.exports = { runPipeline };
