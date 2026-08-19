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

const store = require('../config/store');
const capabilities = require('../config/capabilities');
const { buildSystemPrompt } = require('./prompt');
const gemini = require('./gemini');

const FALLBACK_NOT_CONFIGURED =
  'Lo siento, en este momento no puedo responder automáticamente. El equipo te contactará en breve.';
const FALLBACK_ERROR =
  'Lo siento, tuve un problema para procesar tu mensaje. El equipo te contactará en breve.';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{text: string, media?: {mimeType: string, data: Buffer|string}|null}} input
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<string>}
 */
async function generateReply(db, { text, media } = {}, { fetchImpl } = {}) {
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

  return result.text || FALLBACK_ERROR;
}

module.exports = { generateReply };
