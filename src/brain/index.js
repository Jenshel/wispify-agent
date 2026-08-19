'use strict';
// src/brain/index.js — generateReply() (tasks.md Phase 6.3). The real AI
// reply-generation entrypoint.
//
// Integration seam (carried from PR7): src/channels/whatsapp/webhook.js's
// processIncomingMessage() — previously a deterministic echo stub — now
// calls generateReply() directly. There is no parallel/duplicate reply
// path.
//
// Capability gating, layer 1 (prevention, design.md "never promise what
// isn't wired"): checks src/config/capabilities.js's
// isIntegrationActive(db, 'gemini') BEFORE attempting any call. If the
// gemini integration isn't active (or credentials are somehow incomplete
// despite an 'active' status), this returns a graceful fallback string —
// it never throws into the webhook handler, which awaits this directly on
// Meta's real request path.
//
// Fresh-per-call config (hard dependency carried from PR6/Phase 4 — see
// apply-progress 4.3/4.4): store.getAppConfig(db) is called on EVERY
// invocation, never cached/memoized at boot. This is the exact guarantee
// PR6's soul-docs panel editor depends on — a saved edit must be visible
// on the very next customer message, no restart.
//
// Scope note (PR8 / Phase 6): single-turn only. The source system
// (wa-brain-local/index.js) keeps a rolling conversation-history window
// (loadHistory() + callGemini(..., conversationHistory)) — this repo has
// no `conversations` table yet (schema.sql defers it to Phase 8-9), so
// there is nothing to load a history window FROM.
//
// FUTURE HISTORY INJECTION POINT: once that table exists, load its last
// N turns here (see design.md's Data Flow: "guards(...) -> brain.
// generateReply(prompt(caps))") and pass them through to
// src/brain/gemini.js's generateContent() as an ordered array of
// {role: 'user'|'model', text} entries BEFORE the current turn's contents
// entry — mirroring the source's callGemini(systemPrompt, userMessage,
// conversationHistory, media) shape. generateContent() would need a new
// `history` param threaded into its `contents` array construction.
//
// PR9 / Phase 7 — control-tag pipeline (design.md "Effect (enforcement)"
// layer, the hard guarantee behind the prompt's probabilistic protocol
// instructions in prompt.js): every Gemini reply is run through
// src/agent/pipeline.js's runPipeline() BEFORE this function returns. The
// return value is ALWAYS `cleanReply` — raw bracket-tag syntax must never
// reach the customer, regardless of which effects are fully wired yet (see
// src/agent/effects/* for what's real vs. a documented stub). Effect calls
// the pipeline emits are dispatched via src/agent/effects/index.js's
// dispatchEffectCalls(), threading `db`/`fetchImpl`/the new `from` input
// param through to whichever handlers need them.

const store = require('../config/store');
const capabilities = require('../config/capabilities');
const { buildSystemPrompt } = require('./prompt');
const gemini = require('./gemini');
const pipeline = require('../agent/pipeline');
const { dispatchEffectCalls } = require('../agent/effects');

const FALLBACK_NOT_CONFIGURED =
  'Lo siento, en este momento no puedo responder automáticamente. El equipo te contactará en breve.';
const FALLBACK_ERROR =
  'Lo siento, tuve un problema para procesar tu mensaje. El equipo te contactará en breve.';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   text: string, media?: {mimeType: string, data: Buffer|string}|null,
 *   from?: string,
 * }} input
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<string>}
 */
async function generateReply(db, { text, media, from } = {}, { fetchImpl } = {}) {
  if (!capabilities.isIntegrationActive(db, 'gemini')) {
    console.warn('[BRAIN] gemini integration not active — returning fallback reply');
    return FALLBACK_NOT_CONFIGURED;
  }

  const creds = store.getIntegrationCredentials(db, 'gemini');
  if (!creds || !creds.api_key || !creds.model) {
    console.warn('[BRAIN] gemini marked active but credentials are incomplete — returning fallback reply');
    return FALLBACK_NOT_CONFIGURED;
  }

  // Read fresh on every call — see header comment. No cache, no singleton,
  // no TTL, matching store.getAppConfig()'s own guarantee.
  const appConfig = store.getAppConfig(db);
  const caps = capabilities.capabilities(db);
  const systemPrompt = buildSystemPrompt({ appConfig, capabilities: caps });

  const result = await gemini.generateContent(
    { apiKey: creds.api_key, model: creds.model, systemPrompt, text, media },
    { fetchImpl }
  );

  if (!result.ok) {
    console.error(`[BRAIN] Gemini call failed: ${result.error}`);
    return FALLBACK_ERROR;
  }

  if (!result.text) return FALLBACK_ERROR;

  // Run the control-tag pipeline on the RAW model output — this is the
  // enforcement layer design.md calls "the hard guarantee". cleanReply is
  // what gets returned below no matter what; effectCalls/dropped only
  // decide what ELSE happens (an effect dispatch, or a logged
  // [TAG_DROPPED]), never whether the text itself is safe to send.
  const { cleanReply, effectCalls } = pipeline.runPipeline(result.text, { capabilities: caps });

  if (effectCalls.length) {
    try {
      await dispatchEffectCalls(effectCalls, { db, fetchImpl, from });
    } catch (err) {
      // Defense in depth — dispatchEffectCalls() already swallows individual
      // handler errors, but the customer-visible reply must never depend on
      // effect dispatch succeeding.
      console.error('[BRAIN] effect dispatch failed unexpectedly:', err.message);
    }
  }

  return cleanReply;
}

module.exports = { generateReply };
