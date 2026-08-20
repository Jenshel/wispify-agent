'use strict';
// RED->GREEN for src/brain/gemini.js (tasks.md Phase 6.2).
//
// Single provider, no adapter layer (design.md: "Gemini: single provider,
// static model list ... no provider adapter layer"). Reuses the SAME
// request shape/auth pattern src/integrations/gemini.js's validate()
// already proved (GEMINI_API_BASE single source of truth, apiKey as a
// `?key=` query param) — see src/brain/gemini.js's header comment.
// fetchImpl is injectable, same DI pattern as every other integration in
// this repo — no real network calls in this test file.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generateContent } = require('../src/brain/gemini');
const { GEMINI_API_BASE } = require('../src/integrations/gemini');

function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function candidateResponse(text, finishReason = 'STOP') {
  return jsonResponse(200, { candidates: [{ finishReason, content: { parts: [{ text }] } }] });
}

test('generateContent() rejects when apiKey or model is missing, without hitting the network', async () => {
  const fetchImpl = fakeFetch(candidateResponse('hola'));
  const result = await generateContent({ model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'hola' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateContent() calls the generateContent endpoint with the api key as a query param', async () => {
  const fetchImpl = fakeFetch(candidateResponse('¡Hola! ¿En qué te ayudo?'));
  await generateContent(
    { apiKey: 'AIzaFAKE', model: 'gemini-2.5-flash', systemPrompt: 'Eres un asistente.', text: 'hola' },
    { fetchImpl }
  );

  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(
    url,
    `${GEMINI_API_BASE}/models/gemini-2.5-flash:generateContent?key=AIzaFAKE`
  );
  assert.equal(opts.method, 'POST');
  const body = JSON.parse(opts.body);
  assert.equal(body.system_instruction.parts[0].text, 'Eres un asistente.');
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[0].parts[0].text, 'hola');
});

test('generateContent() returns the reply text on success', async () => {
  const fetchImpl = fakeFetch(candidateResponse('¡Claro! Te cuento nuestros precios.'));
  const result = await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'precios?' },
    { fetchImpl }
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, '¡Claro! Te cuento nuestros precios.');
});

test('generateContent() strips leaked <think> blocks from the reply as a safety net', async () => {
  const fetchImpl = fakeFetch(candidateResponse('<think>plan de respuesta</think>Hola, ¿cómo estás?'));
  const result = await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'hola' },
    { fetchImpl }
  );
  assert.equal(result.text, 'Hola, ¿cómo estás?');
});

test('generateContent() retries once with a higher token limit on MAX_TOKENS, and returns the retry text on success', async () => {
  const fetchImpl = fakeFetch([candidateResponse('respuesta trunc', 'MAX_TOKENS'), candidateResponse('respuesta completa', 'STOP')]);
  const result = await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'algo largo' },
    { fetchImpl }
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, 'respuesta completa');
  assert.equal(fetchImpl.calls.length, 2);
  const retryBody = JSON.parse(fetchImpl.calls[1].opts.body);
  assert.ok(retryBody.generationConfig.maxOutputTokens > JSON.parse(fetchImpl.calls[0].opts.body).generationConfig.maxOutputTokens);
});

test('generateContent() gives up and returns an error if still truncated after the retry', async () => {
  const fetchImpl = fakeFetch([candidateResponse('a', 'MAX_TOKENS'), candidateResponse('b', 'MAX_TOKENS')]);
  const result = await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'algo largo' },
    { fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 2);
});

test('generateContent() surfaces the provider error message on a non-2xx response', async () => {
  const fetchImpl = fakeFetch(jsonResponse(400, { error: { message: 'API key not valid.' } }));
  const result = await generateContent(
    { apiKey: 'bad', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'hola' },
    { fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API key not valid.');
});

test('generateContent() handles a network failure without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const result = await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'hola' },
    { fetchImpl }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /network error/i);
});

// ── Multimodal input (image/audio media, inline base64) ─────────────────────

test('generateContent() inlines Buffer media as base64 in the request parts', async () => {
  const fetchImpl = fakeFetch(candidateResponse('Veo una imagen bonita.'));
  const media = { mimeType: 'image/jpeg', data: Buffer.from('fake-jpeg-bytes') };
  await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: '¿qué ves?', media },
    { fetchImpl }
  );

  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  const parts = body.contents[0].parts;
  const inlinePart = parts.find((p) => p.inline_data);
  assert.ok(inlinePart, 'expected an inline_data part for the media');
  assert.equal(inlinePart.inline_data.mime_type, 'image/jpeg');
  assert.equal(inlinePart.inline_data.data, Buffer.from('fake-jpeg-bytes').toString('base64'));
  assert.match(inlinePart.inline_data.data, /^[A-Za-z0-9+/]+=*$/, 'must be base64, not raw bytes');
});

test('generateContent() falls back to a generic prompt for media with no text caption', async () => {
  const fetchImpl = fakeFetch(candidateResponse('Descripción del archivo.'));
  const media = { mimeType: 'audio/ogg', data: Buffer.from('fake-audio-bytes') };
  await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: '', media },
    { fetchImpl }
  );

  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  const textPart = body.contents[0].parts.find((p) => typeof p.text === 'string');
  assert.ok(textPart.text.length > 0, 'must never send an empty text part alongside media');
});

// ── Conversation history (PR15, conversation-memory follow-up) ──────────────
// gemini.js stays a thin, non-opinionated wrapper (design.md: "single
// provider, no adapter layer") — it trusts the roles it's handed are
// already 'user'/'model' (Gemini's own literal role names). Role mapping
// from src/db/conversations.js's stored 'bot' happens in src/brain/index.js
// via src/brain/history.js, NOT here.

test('generateContent() prepends history turns to contents BEFORE the current live turn, mapping role/text as given', async () => {
  const fetchImpl = fakeFetch(candidateResponse('ok'));
  const history = [
    { role: 'user', text: 'Hola' },
    { role: 'model', text: '¡Hola! ¿En qué te ayudo?' },
  ];
  await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'segundo mensaje', history },
    { fetchImpl }
  );

  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(body.contents.length, 3, 'expected 2 history entries + the current live turn');
  assert.deepEqual(body.contents[0], { role: 'user', parts: [{ text: 'Hola' }] });
  assert.deepEqual(body.contents[1], { role: 'model', parts: [{ text: '¡Hola! ¿En qué te ayudo?' }] });
  assert.equal(body.contents[2].role, 'user');
  assert.equal(body.contents[2].parts[0].text, 'segundo mensaje');
});

test('generateContent() omits history entirely from contents when none is passed (unchanged single-turn shape)', async () => {
  const fetchImpl = fakeFetch(candidateResponse('ok'));
  await generateContent({ apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'hola' }, { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(body.contents.length, 1);
  assert.deepEqual(body.contents[0], { role: 'user', parts: [{ text: 'hola' }] });
});

test('generateContent() also includes history in the MAX_TOKENS retry request, not just the first attempt', async () => {
  const fetchImpl = fakeFetch([candidateResponse('trunc', 'MAX_TOKENS'), candidateResponse('completa', 'STOP')]);
  const history = [{ role: 'user', text: 'primer mensaje' }];
  await generateContent(
    { apiKey: 'k', model: 'gemini-2.5-flash', systemPrompt: 'x', text: 'segundo', history },
    { fetchImpl }
  );
  assert.equal(fetchImpl.calls.length, 2);
  const retryBody = JSON.parse(fetchImpl.calls[1].opts.body);
  assert.equal(retryBody.contents.length, 2, 'history must not be dropped on the retry call');
  assert.deepEqual(retryBody.contents[0], { role: 'user', parts: [{ text: 'primer mensaje' }] });
  assert.equal(retryBody.contents[1].parts[0].text, 'segundo');
});
