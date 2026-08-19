'use strict';
// RED->GREEN for src/brain/index.js generateReply() (tasks.md Phase 6.3).
//
// This is the real AI reply-generation entrypoint. src/channels/whatsapp/
// webhook.js's processIncomingMessage() (PR7's stub) calls this directly —
// see test/channels-whatsapp-webhook.test.js for the wired-through
// integration coverage.
//
// Capability gating, layer 1 (prevention) — design.md "never promise what
// isn't wired". Uses src/config/capabilities.js's isIntegrationActive(db,
// 'gemini') as the delegated instructions specify, so an inactive/
// unconfigured Gemini integration fails gracefully (a clear fallback
// reply), never an unhandled exception thrown into the webhook handler.
//
// Hard dependency carried from PR6/Phase 4 (apply-progress 4.3/4.4): this
// module MUST call store.getAppConfig(db) fresh on every generateReply()
// call, never cache/memoize at boot, so a soul-docs panel edit is visible
// on the very next customer message. Covered explicitly below.
//
// PR9/Phase 7 update: generateReply() now runs src/agent/pipeline.js on
// Gemini's raw reply before returning — the customer-visible return value
// is ALWAYS cleanReply (tag-free), never the raw Gemini text. Effect calls
// the pipeline emits (escalateHuman, captureContactData, ...) are dispatched
// via src/agent/effects/*, threading the new `from` input param through.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../src/db');
const store = require('../src/config/store');
const { generateReply } = require('../src/brain/index');

let previousEncryptionKey;
before(() => {
  previousEncryptionKey = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (previousEncryptionKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = previousEncryptionKey;
});

function freshDb() {
  return openDatabase(':memory:');
}

function activateGemini(db, { apiKey = 'AIzaFAKE', model = 'gemini-2.5-flash', enabled = true } = {}) {
  store.activateIntegration(db, 'gemini', {
    credentials: { api_key: apiKey, model },
    publicMeta: { model },
  });
  if (enabled) store.setIntegrationEnabled(db, 'gemini', true);
}

function fakeGeminiFetch(replyText, { finishReason = 'STOP' } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ finishReason, content: { parts: [{ text: replyText }] } }] }),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ── Capability gating (layer 1: prevention) ─────────────────────────────────

test('generateReply() returns a graceful fallback and makes no network call when gemini is not active', async () => {
  const db = freshDb();
  const fetchImpl = fakeGeminiFetch('should never be reached');
  const reply = await generateReply(db, { text: 'hola' }, { fetchImpl });
  assert.equal(typeof reply, 'string');
  assert.ok(reply.length > 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateReply() returns a graceful fallback when gemini is active but disabled', async () => {
  const db = freshDb();
  activateGemini(db, { enabled: false });
  const fetchImpl = fakeGeminiFetch('should never be reached');
  const reply = await generateReply(db, { text: 'hola' }, { fetchImpl });
  assert.ok(reply.length > 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateReply() never throws when gemini is unconfigured — always resolves to a string', async () => {
  const db = freshDb();
  await assert.doesNotReject(() => generateReply(db, { text: 'hola' }, { fetchImpl: fakeGeminiFetch('x') }));
});

// ── Happy path ────────────────────────────────────────────────────────────

test('generateReply() calls Gemini and returns its reply text when active + configured', async () => {
  const db = freshDb();
  activateGemini(db);
  const fetchImpl = fakeGeminiFetch('¡Hola! ¿En qué puedo ayudarte hoy?');
  const reply = await generateReply(db, { text: 'hola' }, { fetchImpl });
  assert.equal(reply, '¡Hola! ¿En qué puedo ayudarte hoy?');
  assert.equal(fetchImpl.calls.length, 1);
});

test('generateReply() uses the configured model + api_key from store.getIntegrationCredentials', async () => {
  const db = freshDb();
  activateGemini(db, { apiKey: 'AIzaSPECIFIC', model: 'gemini-2.5-pro' });
  const fetchImpl = fakeGeminiFetch('ok');
  await generateReply(db, { text: 'hola' }, { fetchImpl });
  const { url } = fetchImpl.calls[0];
  assert.match(url, /models\/gemini-2\.5-pro:generateContent\?key=AIzaSPECIFIC/);
});

test('generateReply() returns a graceful fallback (never throws) when the Gemini call itself fails', async () => {
  const db = freshDb();
  activateGemini(db);
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const reply = await generateReply(db, { text: 'hola' }, { fetchImpl });
  assert.equal(typeof reply, 'string');
  assert.ok(reply.length > 0);
});

// ── Fresh-per-call app_config read (hard dependency carried from PR6) ──────

test('generateReply() reads app_config fresh on every call — a soul-docs edit is visible on the very next message, no restart/cache', async () => {
  const db = freshDb();
  activateGemini(db);

  store.updateAppConfig(db, { context: 'Version A del negocio' });
  const fetchImplA = fakeGeminiFetch('respuesta A');
  await generateReply(db, { text: 'hola' }, { fetchImpl: fetchImplA });
  const bodyA = JSON.parse(fetchImplA.calls[0].opts.body);
  assert.match(bodyA.system_instruction.parts[0].text, /Version A del negocio/);

  store.updateAppConfig(db, { context: 'Version B del negocio (editada en el panel)' });
  const fetchImplB = fakeGeminiFetch('respuesta B');
  await generateReply(db, { text: 'hola de nuevo' }, { fetchImpl: fetchImplB });
  const bodyB = JSON.parse(fetchImplB.calls[0].opts.body);
  assert.match(bodyB.system_instruction.parts[0].text, /Version B del negocio \(editada en el panel\)/);
  assert.doesNotMatch(bodyB.system_instruction.parts[0].text, /Version A del negocio/);
});

// ── Capability-aware prompt wiring ───────────────────────────────────────────

test('generateReply() passes the real capability state into the system prompt (scheduling off by default)', async () => {
  const db = freshDb();
  activateGemini(db);
  const fetchImpl = fakeGeminiFetch('ok');
  await generateReply(db, { text: 'quiero agendar' }, { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.match(body.system_instruction.parts[0].text, /no puedes agendar|no puedo agendar/i);
});

// ── Multimodal passthrough ────────────────────────────────────────────────

test('generateReply() passes inbound media through to Gemini as inline base64', async () => {
  const db = freshDb();
  activateGemini(db);
  const fetchImpl = fakeGeminiFetch('Veo tu imagen.');
  const media = { mimeType: 'image/jpeg', data: Buffer.from('fake-jpeg-bytes') };
  await generateReply(db, { text: '', media }, { fetchImpl });

  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  const inlinePart = body.contents[0].parts.find((p) => p.inline_data);
  assert.ok(inlinePart);
  assert.equal(inlinePart.inline_data.data, Buffer.from('fake-jpeg-bytes').toString('base64'));
});

// ── Control-tag pipeline wiring (Phase 7) — the customer-safety guarantee ──

function fakeGraphAndGemini(geminiReplyText) {
  const geminiCalls = [];
  const graphCalls = [];
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiCalls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: geminiReplyText }] } }] }),
      };
    }
    graphCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };
  fetchImpl.geminiCalls = geminiCalls;
  fetchImpl.graphCalls = graphCalls;
  return fetchImpl;
}

test('generateReply() returns cleanReply — raw bracket-tag syntax never reaches the returned string', async () => {
  const db = freshDb();
  activateGemini(db);
  const fetchImpl = fakeGraphAndGemini('¡Listo! Te ayudo con eso.[ESCALAR_HUMANO:cliente molesto]');
  const reply = await generateReply(db, { text: 'ayuda', from: '5215500000001' }, { fetchImpl });
  assert.doesNotMatch(reply, /\[/);
  assert.match(reply, /¡Listo! Te ayudo con eso\./);
});

test('generateReply() strips a [CITA_CONFIRMADA] block and never throws even though scheduling capability is off by default', async () => {
  const db = freshDb();
  activateGemini(db);
  const fetchImpl = fakeGraphAndGemini(
    '¡Confirmado![CITA_CONFIRMADA]\nServicio: Corte\nFecha: mañana\nHora: 10:00\n[/CITA_CONFIRMADA]'
  );
  const reply = await generateReply(db, { text: 'quiero agendar', from: '5215500000001' }, { fetchImpl });
  assert.doesNotMatch(reply, /\[/);
  assert.match(reply, /¡Confirmado!/);
});

test('generateReply() dispatches the escalateHuman effect and notifies the configured admin phone', async () => {
  const db = freshDb();
  activateGemini(db);
  store.updateAppConfig(db, { adminPhone: '5215500009999' });
  store.activateIntegration(db, 'meta', {
    credentials: { access_token: 'EAAB_TEST', phone_number_id: '999888777', app_secret: 's', verify_token: 'v' },
    publicMeta: {},
  });

  const fetchImpl = fakeGraphAndGemini('Un momento, te comunico con el equipo.[ESCALAR_HUMANO:cliente molesto]');
  const reply = await generateReply(db, { text: 'quiero hablar con alguien', from: '5215500000001' }, { fetchImpl });

  assert.doesNotMatch(reply, /\[/);
  assert.equal(fetchImpl.graphCalls.length, 1);
  const body = JSON.parse(fetchImpl.graphCalls[0].opts.body);
  assert.equal(body.to, '5215500009999');
  assert.match(body.text.body, /5215500000001/);
  assert.match(body.text.body, /cliente molesto/);
});

test('generateReply() never throws when the model emits a control tag but no `from` was passed in', async () => {
  const db = freshDb();
  activateGemini(db);
  const fetchImpl = fakeGraphAndGemini('Ok.[ESCALAR_HUMANO:motivo]');
  await assert.doesNotReject(() => generateReply(db, { text: 'hola' }, { fetchImpl }));
});
