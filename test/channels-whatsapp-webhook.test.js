'use strict';
// RED->GREEN for src/channels/whatsapp/webhook.js (tasks.md Phase 5.1/5.2).
//
// threat-matrix (a): Meta + Stripe webhook HMAC verification on raw bytes,
// enforce mode default ON — this repo ships secure-by-default (no
// META_WEBHOOK_VERIFY_MODE off/log escape hatch; design.md is silent on
// keeping that source-system flexibility, so this port defaults to
// always-enforce per the delegated instructions).
//
// Tests construct REAL signed payloads with a test HMAC secret and POST
// them to the real Express app (never mock the inbound webhook itself —
// Meta calls us). Outbound Graph API calls (markAsRead/downloadMedia/
// sendText) go through an injectable fetchImpl, same pattern as every
// other integration in this repo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { httpGet, httpPost } = require('./helper');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');
const store = require('../src/config/store');
const webhook = require('../src/channels/whatsapp/webhook');

const APP_SECRET = 'test-app-secret-123';
const VERIFY_TOKEN = 'test-verify-token-xyz';

let prevKey;
before(() => {
  prevKey = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (prevKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = prevKey;
});

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wispify-webhook-test-'));
}

function seedMetaCredentials(db, overrides = {}) {
  store.activateIntegration(db, 'meta', {
    credentials: {
      access_token: 'EAAB_TEST_TOKEN',
      phone_number_id: '999888777',
      app_secret: APP_SECRET,
      verify_token: VERIFY_TOKEN,
      ...overrides,
    },
    publicMeta: { display_phone_number: '+52 55 0000 0000' },
  });
}

function sign(bodyStr, secret = APP_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
}

/**
 * Never let a test accidentally reach the real Graph API — every outbound
 * call (markAsRead/sendText/sendPacedReply) defaults to this generic OK
 * responder unless a test explicitly injects its own fetchImpl to assert
 * on call shapes or simulate a specific provider response.
 */
async function defaultFetchImpl() {
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
}

async function bootServer({ fetchImpl, dataDir, onMessageProcessed, sleepImpl, randomImpl, seedCreds = true } = {}) {
  const db = openDatabase(':memory:');
  if (seedCreds) seedMetaCredentials(db);
  const app = createApp({
    db,
    fetchImpl: fetchImpl || defaultFetchImpl,
    dataDir: dataDir || tmpDataDir(),
    onMessageProcessed,
    sleepImpl: sleepImpl || (async () => {}), // instant by default — no real wall-clock wait in tests
    randomImpl,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${s.address().port}`,
        db,
        close: () => new Promise((r) => s.close(() => r())),
      })
    );
  });
  return server;
}

function withTimeout(promise, ms = 2000, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ── verifySignature() — pure unit tests (threat-matrix a) ────────────────

test('verifySignature() accepts a correctly-signed body', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig = sign(body.toString());
  const result = webhook.verifySignature(body, sig, APP_SECRET);
  assert.equal(result.ok, true);
});

test('verifySignature() rejects a tampered body (signature no longer matches)', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig = sign(body.toString());
  const tampered = Buffer.from(JSON.stringify({ hello: 'tampered' }));
  const result = webhook.verifySignature(tampered, sig, APP_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'hmac_mismatch');
});

test('verifySignature() rejects when no secret is configured — fails closed, never accepts blindly', () => {
  const body = Buffer.from('{}');
  const sig = sign(body.toString());
  const result = webhook.verifySignature(body, sig, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_secret_configured');
});

test('verifySignature() rejects a missing signature header', () => {
  const body = Buffer.from('{}');
  const result = webhook.verifySignature(body, undefined, APP_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_header');
});

test('verifySignature() rejects a malformed signature header', () => {
  const body = Buffer.from('{}');
  const result = webhook.verifySignature(body, 'not-a-valid-header', APP_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed_header');
});

test('verifySignature() fails closed on a length mismatch WITHOUT throwing (never a raw timingSafeEqual on unequal buffers)', () => {
  const body = Buffer.from('{}');
  // A short, clearly-wrong-length hex string — timingSafeEqual() throws on
  // unequal-length buffers, so the length check MUST happen first.
  assert.doesNotThrow(() => {
    const result = webhook.verifySignature(body, 'sha256=abcd', APP_SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'length_mismatch');
  });
});

test('verifySignature() rejects an empty body', () => {
  const result = webhook.verifySignature(Buffer.alloc(0), sign(''), APP_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_body');
});

// ── GET /webhook — Meta verification challenge ───────────────────────────

test('GET /webhook returns the challenge on a matching hub.mode + hub.verify_token', async () => {
  const server = await bootServer();
  const res = await httpGet(
    server,
    `/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=CHALLENGE_123`
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'CHALLENGE_123');
  await server.close();
});

test('GET /webhook returns 403 on a token mismatch', async () => {
  const server = await bootServer();
  const res = await httpGet(
    server,
    `/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=CHALLENGE_123`
  );
  assert.equal(res.statusCode, 403);
  await server.close();
});

test('GET /webhook returns 403 when no verify_token is configured yet — fails closed', async () => {
  const server = await bootServer({ seedCreds: false });
  const res = await httpGet(
    server,
    `/webhook?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=CHALLENGE_123`
  );
  assert.equal(res.statusCode, 403);
  await server.close();
});

test('GET /webhook returns 403 when hub.mode is not "subscribe"', async () => {
  const server = await bootServer();
  const res = await httpGet(
    server,
    `/webhook?hub.mode=unsubscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=x`
  );
  assert.equal(res.statusCode, 403);
  await server.close();
});

// ── POST /webhook — HMAC-verified inbound messages (real signed payloads) ─

function textMessagePayload({ from = '5215500000001', text = 'Hola, quiero info', phoneNumberId = '999888777', messageId = 'wamid.IN1' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ from, id: messageId, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

test('POST /webhook rejects a request with an invalid signature — 401, no processing', async () => {
  let processed = false;
  const server = await bootServer({ onMessageProcessed: () => { processed = true; } });

  const payload = textMessagePayload();
  const res = await httpPost(server, '/webhook', payload, {
    headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(processed, false);
  await server.close();
});

test('POST /webhook rejects a request with no signature header at all — 401', async () => {
  const server = await bootServer();
  const payload = textMessagePayload();
  const res = await httpPost(server, '/webhook', payload);
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('POST /webhook accepts a validly-signed text message, acks 200 immediately, and hands the text to the integration seam (gemini not configured -> graceful fallback, never a crash)', async () => {
  let resolveProcessed;
  const processed = new Promise((resolve) => { resolveProcessed = resolve; });
  const server = await bootServer({ onMessageProcessed: (info) => resolveProcessed(info) });

  const payload = textMessagePayload({ text: 'Hola, quiero info' });
  const bodyStr = JSON.stringify(payload);
  const res = await httpPost(server, '/webhook', payload, {
    headers: { 'x-hub-signature-256': sign(bodyStr) },
  });

  assert.equal(res.statusCode, 200);

  try {
    const info = await withTimeout(processed, 2000, 'message processing');
    assert.equal(info.from, '5215500000001');
    assert.equal(info.customerText, 'Hola, quiero info');
    assert.equal(info.type, 'text');
    // This test only seeds `meta` credentials, not `gemini` — the brain's
    // capability gate (Phase 6, src/brain/index.js) fails gracefully with a
    // fallback string here, never throws or leaks the stub's old echo text.
    assert.match(info.replyText, /no puedo responder automáticamente/);
  } finally {
    await server.close();
  }
});

test('POST /webhook wires a real Gemini reply through when gemini is active + configured, and it reaches the customer via sendPacedReply', async () => {
  let resolveProcessed;
  const processed = new Promise((resolve) => { resolveProcessed = resolve; });
  const geminiCalls = [];

  const fetchImpl = async (url, opts) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Claro, contame qué buscás.' }] } }],
        }),
      };
    }
    // markAsRead / sendText calls during pacing (Graph API)
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };

  const server = await bootServer({ fetchImpl, onMessageProcessed: (info) => resolveProcessed(info) });
  store.activateIntegration(server.db, 'gemini', {
    credentials: { api_key: 'AIzaFAKE', model: 'gemini-2.5-flash' },
    publicMeta: { model: 'gemini-2.5-flash' },
  });
  store.setIntegrationEnabled(server.db, 'gemini', true);

  const payload = textMessagePayload({ text: 'Hola, quiero info' });
  const bodyStr = JSON.stringify(payload);
  const res = await httpPost(server, '/webhook', payload, {
    headers: { 'x-hub-signature-256': sign(bodyStr) },
  });
  assert.equal(res.statusCode, 200);

  try {
    const info = await withTimeout(processed, 2000, 'message processing');
    assert.equal(info.replyText, 'Claro, contame qué buscás.');
    assert.equal(geminiCalls.length, 1);
    assert.ok(info.sendResult, 'expected the real reply to be sent via sendPacedReply');
  } finally {
    await server.close();
  }
});

test('POST /webhook ignores messages for a phone_number_id that does not match the configured one', async () => {
  let called = false;
  const server = await bootServer({ onMessageProcessed: () => { called = true; } });

  const payload = textMessagePayload({ phoneNumberId: 'SOME_OTHER_NUMBER' });
  const bodyStr = JSON.stringify(payload);
  await httpPost(server, '/webhook', payload, { headers: { 'x-hub-signature-256': sign(bodyStr) } });

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(called, false);
  await server.close();
});

test('POST /webhook downloads and stores inbound image media, and passes a mediaUrl to the integration seam', async () => {
  let resolveProcessed;
  const processed = new Promise((resolve) => { resolveProcessed = resolve; });
  const dataDir = tmpDataDir();

  const fetchImpl = async (url, opts) => {
    if (url.includes('/MEDIA_ID_1')) {
      return { ok: true, status: 200, json: async () => ({ url: 'https://lookaside.fbsbx.com/media/xyz' }) };
    }
    if (url === 'https://lookaside.fbsbx.com/media/xyz') {
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('fake-jpeg-bytes').buffer };
    }
    // markAsRead / sendText calls during pacing
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const server = await bootServer({ fetchImpl, dataDir, onMessageProcessed: (info) => resolveProcessed(info) });

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '999888777' },
              messages: [
                {
                  from: '5215500000002',
                  id: 'wamid.IMG1',
                  type: 'image',
                  image: { id: 'MEDIA_ID_1', mime_type: 'image/jpeg', caption: '' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const bodyStr = JSON.stringify(payload);
  const res = await httpPost(server, '/webhook', payload, { headers: { 'x-hub-signature-256': sign(bodyStr) } });
  assert.equal(res.statusCode, 200);

  const info = await withTimeout(processed, 2000, 'media message processing');
  assert.equal(info.type, 'image');
  assert.ok(info.mediaUrl);
  assert.match(info.mediaUrl, /^\/api\/media\/client\/5215500000002\/\d+\.jpeg$/);

  const onDiskFiles = fs.readdirSync(path.join(dataDir, 'client-media', '5215500000002'));
  assert.equal(onDiskFiles.length, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, 'client-media', '5215500000002', onDiskFiles[0])).toString(), 'fake-jpeg-bytes');

  await server.close();
});

function rawPost(server, urlPath, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      server.base + urlPath,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

test('POST /webhook does not crash on an unparseable JSON body even after a valid signature', async () => {
  const server = await bootServer();
  const bodyStr = 'not-json{{{';
  const res = await rawPost(server, '/webhook', bodyStr, { 'x-hub-signature-256': sign(bodyStr) });
  // A valid signature always acks 200 immediately, regardless of what the
  // (separately-verified) body turns out to contain once parsed.
  assert.equal(res.statusCode, 200);

  // Server must stay healthy — a bad payload must never crash the process.
  const followUp = await httpGet(server, `/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=ok`);
  assert.equal(followUp.statusCode, 200);
  await server.close();
});
