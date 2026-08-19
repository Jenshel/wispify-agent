'use strict';
// src/brain/gemini.js — Gemini generateContent() call wrapper (tasks.md
// Phase 6.2). Single provider, no adapter layer (design.md: "Gemini:
// single provider, static model list ... no provider adapter layer").
//
// Reuses the SAME request shape/auth pattern src/integrations/gemini.js's
// validate() already proved against the real API: GEMINI_API_BASE as the
// single source of truth (imported, not re-hardcoded — same precedent as
// channels/whatsapp/client.js reusing integrations/meta.js's
// GRAPH_API_BASE), and the API key passed as a `?key=` query param.
// fetchImpl is injectable so this module's tests run fully offline, same
// DI pattern as every other integration in this repo.
//
// Reference for the request/response shape: WhiteLabel_WA_System's
// wa-brain-local/index.js callGemini() — system_instruction + contents +
// generationConfig (thinkingConfig.thinkingBudget: 0, so Gemini 2.5's
// internal reasoning doesn't eat maxOutputTokens), the MAX_TOKENS
// single-retry-at-higher-ceiling behavior, and stripping any leaked
// <think> blocks from the reply as a safety net.

const { GEMINI_API_BASE } = require('../integrations/gemini');

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const RETRY_MAX_OUTPUT_TOKENS = 2048;
const FALLBACK_MEDIA_PROMPT = 'El cliente envió este archivo. Descríbelo y responde acorde a tu rol.';

/**
 * @param {string} text
 * @param {{mimeType: string, data: Buffer|string}|null|undefined} media
 * @returns {Array<object>}
 */
function buildParts(text, media) {
  const parts = [];
  if (media && media.mimeType && media.data) {
    const base64 = Buffer.isBuffer(media.data) ? media.data.toString('base64') : media.data;
    parts.push({ inline_data: { mime_type: media.mimeType, data: base64 } });
  }
  parts.push({ text: text || FALLBACK_MEDIA_PROMPT });
  return parts;
}

async function callOnce({ apiKey, model, systemPrompt, text, media, maxOutputTokens, fetchImpl }) {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt || '' }] },
    contents: [{ role: 'user', parts: buildParts(text, media) }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `network error contacting Gemini API: ${err.message}` };
  }

  const json = await safeJson(response);
  if (!response.ok) {
    return { ok: false, error: json?.error?.message || `Gemini API returned HTTP ${response.status}` };
  }

  const candidate = json?.candidates?.[0];
  const finishReason = candidate?.finishReason || 'unknown';
  const parts = candidate?.content?.parts || [];
  // Gemini 2.5 can return thinking in parts with thought:true — skip those.
  const responsePart = parts.find((p) => !p.thought) || parts[parts.length - 1] || {};
  const rawText = responsePart?.text || '';
  const text_ = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { ok: true, text: text_, finishReason };
}

/**
 * @param {{apiKey: string, model: string, systemPrompt: string, text: string,
 *   media?: {mimeType: string, data: Buffer|string}|null}} params
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
async function generateContent({ apiKey, model, systemPrompt, text, media } = {}, { fetchImpl = fetch } = {}) {
  if (!apiKey) return { ok: false, error: 'apiKey is required' };
  if (!model) return { ok: false, error: 'model is required' };

  const first = await callOnce({
    apiKey,
    model,
    systemPrompt,
    text,
    media,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    fetchImpl,
  });
  if (!first.ok) return first;
  if (first.finishReason !== 'MAX_TOKENS') return first;

  // Truncated — never ship a half-sentence to a real customer. Retry once
  // with a higher ceiling before giving up (source's exact behavior).
  const retry = await callOnce({
    apiKey,
    model,
    systemPrompt,
    text,
    media,
    maxOutputTokens: RETRY_MAX_OUTPUT_TOKENS,
    fetchImpl,
  });
  if (retry.ok && retry.finishReason === 'STOP') return retry;
  return { ok: false, error: 'reply truncated even after retrying with a higher token limit' };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = { generateContent };
