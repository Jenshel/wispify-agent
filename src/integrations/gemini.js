'use strict';
// src/integrations/gemini.js — Google Gemini adapter.
//
// Module boundary (design.md): never touches Express, never persists
// anything. validate() proves an API key + model pair works against the
// real Generative Language API. GEMINI_MODELS is the curated static list
// the setup screen's dropdown renders — spec: "MUST NOT accept free-text
// model identifiers", so validate() also rejects any model id outside this
// list before making a network call.
//
// fetchImpl is injectable so this module's test suite runs fully
// offline/deterministic — see tasks.md Phase 2.2.

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Keep this list short and current — it is the entire dropdown the setup
// screen renders (spec: "guided-integration-setup / Gemini Model Selection
// Is Curated"). Update as Google ships/retires model ids.
const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function normalizeModelName(name) {
  return String(name || '').replace(/^models\//, '');
}

/**
 * Validate a Gemini API key + curated model id with a real, minimal
 * models-list call (design.md validation table).
 *
 * @param {{apiKey: string, model: string}} credentials
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, publicMeta?: object, error?: string, credentials?: object}>}
 */
async function validate({ apiKey, model } = {}, { fetchImpl = fetch } = {}) {
  if (!apiKey) return { ok: false, error: 'apiKey is required' };
  if (!model) return { ok: false, error: 'model is required' };
  if (!GEMINI_MODELS.includes(model)) {
    return { ok: false, error: `unknown model "${model}" — must be one of ${GEMINI_MODELS.join(', ')}` };
  }

  let response;
  try {
    response = await fetchImpl(`${GEMINI_API_BASE}/models?key=${encodeURIComponent(apiKey)}`);
  } catch (err) {
    return { ok: false, error: `network error contacting Gemini API: ${err.message}` };
  }

  const body = await safeJson(response);

  if (!response.ok) {
    return { ok: false, error: body?.error?.message || `Gemini API returned HTTP ${response.status}` };
  }

  const models = Array.isArray(body?.models) ? body.models : [];
  const found = models.some((m) => normalizeModelName(m.name) === model);
  if (!found) {
    return { ok: false, error: `model "${model}" is not available for this API key` };
  }

  return {
    ok: true,
    publicMeta: { model },
    credentials: { api_key: apiKey, model },
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = { validate, GEMINI_MODELS, GEMINI_API_BASE };
