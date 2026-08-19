'use strict';
// src/agent/effects/index.js — dispatch map for src/agent/pipeline.js's
// `effectCalls` descriptors (tasks.md Phase 7.4).
//
// src/agent/pipeline.js only DESCRIBES what to do (name + payload) — it
// never calls a provider or touches a db, so it stays a pure, trivially
// unit-testable function. This module is the one place that turns those
// descriptors into real invocations, merging in the shared execution
// context (db/fetchImpl/from) every handler in src/agent/effects/*
// declares it needs.

const { escalateHuman } = require('./escalate');
const { captureContactData } = require('./contact-data');
const { confirmAppointment } = require('./appointment');
const { confirmOrder } = require('./order');
const { sendPhoto } = require('./photos');

const dispatch = {
  escalateHuman,
  captureContactData,
  confirmAppointment,
  confirmOrder,
  sendPhoto,
};

/**
 * Runs every effectCall from src/agent/pipeline.js's runPipeline() output
 * against its matching handler, in order. An unknown effect name or a
 * handler that throws is logged and skipped — a broken/unrecognized effect
 * must never crash the reply pipeline; the customer-visible cleanReply has
 * already been computed independently of this dispatch.
 * @param {Array<{effect: string, payload: object}>} effectCalls
 * @param {{db?: object, fetchImpl?: typeof fetch, from?: string}} [ctx]
 * @returns {Promise<Array<{effect: string, result: object|null}>>}
 */
async function dispatchEffectCalls(effectCalls, ctx = {}) {
  const results = [];
  for (const call of effectCalls || []) {
    const handler = dispatch[call.effect];
    if (typeof handler !== 'function') {
      console.error(`[AGENT] no effect handler registered for "${call.effect}" — skipped`);
      results.push({ effect: call.effect, result: null });
      continue;
    }
    try {
      const result = await handler({ ...call.payload, from: call.payload?.from ?? ctx.from }, ctx);
      results.push({ effect: call.effect, result });
    } catch (err) {
      console.error(`[AGENT] effect "${call.effect}" threw — treated as failed, dispatch continues:`, err.message);
      results.push({ effect: call.effect, result: null });
    }
  }
  return results;
}

module.exports = { dispatch, dispatchEffectCalls };
