'use strict';
// RED->GREEN for src/jobs/nudges.js (tasks.md Phase 10.1), PORTED from
// WhiteLabel_WA_System's routes/nudges.js — 4-stage contextual follow-up
// system. See that module's header comment for the full stage/timing
// mapping. Gemini-only (design.md de-slotting table: "nudges: OpenRouter
// primary + Gemini fallback -> Gemini only") — no OpenRouter code exists
// anywhere in this port.
//
// Same "real signed/real fetchImpl DI, never assert on a mock that isn't
// exercising real logic" convention as test/jobs-appointment-reminders.
// test.js — Gemini calls go through the SAME injectable fetchImpl every
// other integration in this repo uses (src/brain/gemini.js's
// generateContent()), and sends go through client.sendText() (real Graph
// API payload shape, fake network only).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../src/db');
const store = require('../src/config/store');
const conversations = require('../src/db/conversations');
const { scanAndFollowup, stripOpeningPunctuation, isMexico10am } = require('../src/jobs/nudges');

let prevKey;
before(() => {
  prevKey = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (prevKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = prevKey;
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function freshDb({ withMeta = true, withGemini = true } = {}) {
  const db = openDatabase(':memory:');
  if (withMeta) {
    store.activateIntegration(db, 'meta', {
      credentials: { access_token: 'EAAB_TEST', phone_number_id: '999888777', app_secret: 's', verify_token: 'v' },
      publicMeta: {},
    });
  }
  if (withGemini) {
    store.activateIntegration(db, 'gemini', {
      credentials: { api_key: 'AIzaFAKE', model: 'gemini-2.5-flash' },
      publicMeta: { model: 'gemini-2.5-flash' },
    });
  }
  return db;
}

/** Fake fetch distinguishing Gemini (generateContent) vs Graph API (send) calls, mirroring the webhook runtime-harness convention. */
function fakeFetch({ geminiText = '¡Hola! ¿Seguimos platicando?' } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: geminiText }] } }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
  };
  fetchImpl.calls = calls;
  fetchImpl.geminiCalls = () => calls.filter((c) => c.url.includes('generativelanguage.googleapis.com'));
  fetchImpl.sendCalls = () => calls.filter((c) => c.url.includes('/messages'));
  return fetchImpl;
}

/** Seed a conversation that stalled `elapsedMs` ago, with a realistic user+bot turn pair. */
function seedStalledConversation(db, phone, now, elapsedMs, overrides = {}) {
  const lastClientAt = new Date(now - elapsedMs).toISOString();
  conversations.recordClientMessage(db, phone, { text: 'Hola, quiero saber precios', now: lastClientAt });
  conversations.recordBotMessage(db, phone, { text: 'Claro, contame tu negocio', now: new Date(now - elapsedMs + 1000).toISOString() });
  for (const [stage, ts] of Object.entries(overrides.stagesSent || {})) {
    conversations.markStageSent(db, phone, Number(stage), { now: ts });
  }
  return phone;
}

// ── stripOpeningPunctuation() — pure function ────────────────────────────

test('stripOpeningPunctuation() removes ¡ and ¿ anywhere in the text, not just at the start', () => {
  assert.equal(stripOpeningPunctuation('¡Hola! ¿Seguimos?'), 'Hola! Seguimos?');
  assert.equal(stripOpeningPunctuation('Sin signos'), 'Sin signos');
});

// ── isMexico10am() — pure function, deterministic via injected `now` ────

test('isMexico10am() is true between 10:00 and 10:11 Mexico time (UTC-6, no DST)', () => {
  assert.equal(isMexico10am(Date.UTC(2030, 0, 15, 16, 0, 0)), true); // 10:00 MX
  assert.equal(isMexico10am(Date.UTC(2030, 0, 15, 16, 11, 0)), true); // 10:11 MX
});

test('isMexico10am() is false outside the 10:00-10:11 window', () => {
  assert.equal(isMexico10am(Date.UTC(2030, 0, 15, 16, 12, 0)), false); // 10:12 MX
  assert.equal(isMexico10am(Date.UTC(2030, 0, 15, 15, 59, 0)), false); // 09:59 MX
  assert.equal(isMexico10am(Date.UTC(2030, 0, 15, 22, 0, 0)), false); // 16:00 MX
});

// ── scanAndFollowup() — capability gating (graceful no-op) ──────────────

test('scanAndFollowup() no-ops when meta is not configured', async () => {
  const db = freshDb({ withMeta: false });
  const now = Date.now();
  seedStalledConversation(db, '5215500000001', now, 20 * MIN);
  const fetchImpl = fakeFetch();

  await assert.doesNotReject(() => scanAndFollowup(db, { fetchImpl, now }));
  assert.equal(fetchImpl.calls.length, 0);
});

test('scanAndFollowup() no-ops when gemini is not configured', async () => {
  const db = freshDb({ withGemini: false });
  const now = Date.now();
  seedStalledConversation(db, '5215500000001', now, 20 * MIN);
  const fetchImpl = fakeFetch();

  await assert.doesNotReject(() => scanAndFollowup(db, { fetchImpl, now }));
  assert.equal(fetchImpl.calls.length, 0);
});

test('scanAndFollowup() skips a conversation with fewer than 2 recorded turns (not enough context to nudge about)', async () => {
  const db = freshDb();
  const now = Date.now();
  conversations.recordClientMessage(db, '5215500000001', { text: 'Hola', now: new Date(now - 20 * MIN).toISOString() });
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });
  assert.equal(fetchImpl.calls.length, 0);
});

test('scanAndFollowup() skips a conversation whose 24h window has already expired', async () => {
  const db = freshDb();
  const now = Date.now();
  seedStalledConversation(db, '5215500000001', now, 25 * 60 * MIN); // 25h ago
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });
  assert.equal(fetchImpl.calls.length, 0);
});

// ── Stage 1: 15 min after last client message ────────────────────────────

test('scanAndFollowup() sends stage 1 at 15+ min elapsed, generates via Gemini (system prompt references "15 minutos"), strips opening punctuation, and records the dedupe flag + bot turn', async () => {
  const db = freshDb();
  const now = Date.now();
  const phone = '5215500000001';
  seedStalledConversation(db, phone, now, 16 * MIN);
  const fetchImpl = fakeFetch({ geminiText: '¡Seguimos platicando?' });

  await scanAndFollowup(db, { fetchImpl, now });

  const gCall = fetchImpl.geminiCalls()[0];
  assert.ok(gCall, 'expected a Gemini call');
  const gBody = JSON.parse(gCall.opts.body);
  assert.match(gBody.system_instruction.parts[0].text, /15 minutos/);
  // Shared FORMAT_RULES emoji whitelist/punctuation rule is present in every stage's system prompt.
  assert.match(gBody.system_instruction.parts[0].text, /🤗 ✨ 👩‍💻 📅 💡 📊 🔍 🚀/);

  const sCall = fetchImpl.sendCalls()[0];
  assert.ok(sCall, 'expected a WhatsApp send');
  const sentText = JSON.parse(sCall.opts.body).text.body;
  assert.equal(sentText, 'Seguimos platicando?'); // ¡ stripped — deterministic enforcement, not just prompt compliance
  assert.doesNotMatch(sentText, /[¡¿]/);

  const conv = conversations.getConversation(db, phone);
  assert.ok(conv.stageSentAt[1]);
  assert.equal(conv.recentTurns[conv.recentTurns.length - 1].role, 'bot');
  assert.equal(conv.recentTurns[conv.recentTurns.length - 1].content, 'Seguimos platicando?');
});

test('scanAndFollowup() never re-sends stage 1 on a second scan (real DB-backed dedupe, not in-memory)', async () => {
  const db = freshDb();
  const now = Date.now();
  seedStalledConversation(db, '5215500000001', now, 16 * MIN);
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });
  await scanAndFollowup(db, { fetchImpl, now });

  assert.equal(fetchImpl.sendCalls().length, 1);
});

test('scanAndFollowup() does not send stage 1 before 15 minutes have elapsed', async () => {
  const db = freshDb();
  const now = Date.now();
  seedStalledConversation(db, '5215500000001', now, 5 * MIN);
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });
  assert.equal(fetchImpl.calls.length, 0);
});

// ── Stage 2: 1 hour after last client message ────────────────────────────

test('scanAndFollowup() sends stage 2 at 1h+ elapsed (stage 1 already sent), system prompt references "1 hora"', async () => {
  const db = freshDb();
  const now = Date.now();
  const phone = '5215500000001';
  seedStalledConversation(db, phone, now, 65 * MIN, { stagesSent: { 1: new Date(now - 60 * MIN).toISOString() } });
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });

  const gBody = JSON.parse(fetchImpl.geminiCalls()[0].opts.body);
  assert.match(gBody.system_instruction.parts[0].text, /1 hora/);
  assert.equal(fetchImpl.sendCalls().length, 1);
  assert.ok(conversations.getConversation(db, phone).stageSentAt[2]);
});

// ── Stage 3: next-day 10am Mexico time, ONLY if stage 2 already sent ─────

test('scanAndFollowup() sends stage 3 at 10am Mexico time ONLY when stage 2 was already sent', async () => {
  const db = freshDb();
  const now = Date.UTC(2030, 0, 16, 16, 5, 0); // 10:05am Mexico
  const phone = '5215500000001';
  seedStalledConversation(db, phone, now, 20 * HOUR, {
    stagesSent: { 1: new Date(now - 19 * HOUR).toISOString(), 2: new Date(now - 18 * HOUR).toISOString() },
  });
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });

  const gBody = JSON.parse(fetchImpl.geminiCalls()[0].opts.body);
  assert.match(gBody.system_instruction.parts[0].text, /nuevo día/);
  assert.ok(conversations.getConversation(db, phone).stageSentAt[3]);
});

test('scanAndFollowup() does NOT send stage 3 at 10am if stage 2 was never sent', async () => {
  const db = freshDb();
  const now = Date.UTC(2030, 0, 16, 16, 5, 0); // 10:05am Mexico
  seedStalledConversation(db, '5215500000001', now, 20 * HOUR); // no stagesSent at all
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });

  // elapsed (20h) >= stage-2 threshold and stage 2 not sent -> stage 2 fires instead of stage 3.
  const gBody = JSON.parse(fetchImpl.geminiCalls()[0].opts.body);
  assert.match(gBody.system_instruction.parts[0].text, /1 hora/);
});

test('scanAndFollowup() does not send stage 3 outside the 10am Mexico window even if stage 2 was sent', async () => {
  const db = freshDb();
  const now = Date.UTC(2030, 0, 16, 20, 0, 0); // 2pm Mexico, not 10am
  const phone = '5215500000001';
  seedStalledConversation(db, phone, now, 20 * HOUR, {
    stagesSent: { 1: new Date(now - 19 * HOUR).toISOString(), 2: new Date(now - 18 * HOUR).toISOString() },
  });
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });
  assert.equal(fetchImpl.calls.length, 0); // stages 1+2 already sent, not stage-4 window, not 10am -> nothing to send
});

// ── Stage 4: 5 min before the 24h window closes (highest priority) ──────

test('scanAndFollowup() sends stage 4 inside the 5-minute-before-expiry window, system prompt references maximum urgency', async () => {
  const db = freshDb();
  const now = Date.now();
  const phone = '5215500000001';
  seedStalledConversation(db, phone, now, 23 * HOUR + 58 * MIN, {
    stagesSent: {
      1: new Date(now - 23 * HOUR).toISOString(),
      2: new Date(now - 22 * HOUR).toISOString(),
    },
  });
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });

  const gBody = JSON.parse(fetchImpl.geminiCalls()[0].opts.body);
  assert.match(gBody.system_instruction.parts[0].text, /5 MINUTOS/);
  assert.ok(conversations.getConversation(db, phone).stageSentAt[4]);
});

test('scanAndFollowup() prioritizes stage 4 over stage 2/3 when both windows technically overlap', async () => {
  const db = freshDb();
  const now = Date.now();
  const phone = '5215500000001';
  // 23h58m elapsed: stage-2 condition (elapsed>=1h, not sent) is ALSO true, but stage 4 must win.
  seedStalledConversation(db, phone, now, 23 * HOUR + 58 * MIN);
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });

  const gBody = JSON.parse(fetchImpl.geminiCalls()[0].opts.body);
  assert.match(gBody.system_instruction.parts[0].text, /5 MINUTOS/);
});

// ── Gemini failure handling ───────────────────────────────────────────────

test('scanAndFollowup() sends nothing and does not mark the stage sent when Gemini returns an empty reply', async () => {
  const db = freshDb();
  const now = Date.now();
  const phone = '5215500000001';
  seedStalledConversation(db, phone, now, 16 * MIN);
  const fetchImpl = fakeFetch({ geminiText: '' });

  await scanAndFollowup(db, { fetchImpl, now });

  assert.equal(fetchImpl.sendCalls().length, 0);
  assert.equal(conversations.getConversation(db, phone).stageSentAt[1], null);
});

// ── Multiple conversations in one scan ────────────────────────────────────

test('scanAndFollowup() handles multiple stalled conversations independently in one pass', async () => {
  const db = freshDb();
  const now = Date.now();
  seedStalledConversation(db, '5215500000001', now, 16 * MIN);
  seedStalledConversation(db, '5215500000002', now, 70 * MIN, { stagesSent: { 1: new Date(now - 60 * MIN).toISOString() } });
  const fetchImpl = fakeFetch();

  await scanAndFollowup(db, { fetchImpl, now });

  assert.equal(fetchImpl.sendCalls().length, 2);
  assert.ok(conversations.getConversation(db, '5215500000001').stageSentAt[1]);
  assert.ok(conversations.getConversation(db, '5215500000002').stageSentAt[2]);
});
