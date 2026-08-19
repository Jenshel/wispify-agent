'use strict';
// RED->GREEN for src/channels/whatsapp/client.js (tasks.md Phase 5.3).
//
// Ported from WhiteLabel_WA_System's routes/webhook.js send/pacing helpers.
// No real Graph API call ever happens in this suite — fetchImpl is
// injected (same pattern as src/integrations/meta.js), and sleepImpl/
// randomImpl are injected so the human-pacing math is exercised
// deterministically without any real wall-clock wait.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const client = require('../src/channels/whatsapp/client');

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return typeof response === 'function' ? response(url, opts) : response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const CREDS = { access_token: 'EAAB_TOKEN', phone_number_id: '999888777' };

// ── humanDelayMs() — exact port of the tuned constants ──────────────────

test('humanDelayMs() matches the tuned source formula at the deterministic midpoint (randomImpl -> 0.5)', () => {
  const inLen = 20;
  const outLen = 40;
  const readMs = Math.min(2500, 400 + inLen * 15); // 700
  const typeMs = Math.min(5500, 800 + outLen * 35); // 2200
  const jitter = 0.85 + 0.5 * 0.3; // 1.0
  const expected = Math.round((readMs + typeMs) * jitter * 3);
  const actual = client.humanDelayMs(inLen, outLen, { randomImpl: () => 0.5 });
  assert.equal(actual, expected);
});

test('humanDelayMs() caps readMs at 2500 and typeMs at 5500 for very long messages', () => {
  const cappedReadMs = 2500;
  const cappedTypeMs = 5500;
  const jitter = 0.85; // randomImpl -> 0
  const expected = Math.round((cappedReadMs + cappedTypeMs) * jitter * 3);
  const actual = client.humanDelayMs(10_000, 10_000, { randomImpl: () => 0 });
  assert.equal(actual, expected);
});

test('humanDelayMs() applies +-15% jitter bounds around the base delay', () => {
  const inLen = 10;
  const outLen = 10;
  const base = Math.min(2500, 400 + inLen * 15) + Math.min(5500, 800 + outLen * 35);
  const low = client.humanDelayMs(inLen, outLen, { randomImpl: () => 0 });
  const high = client.humanDelayMs(inLen, outLen, { randomImpl: () => 1 });
  assert.equal(low, Math.round(base * 0.85 * 3));
  assert.equal(high, Math.round(base * 1.15 * 3));
});

// ── computeNoticeDelayMs() — silent-gap-first pacing ────────────────────

test('computeNoticeDelayMs() picks a 2-4s silent gap before totalDelay caps it', () => {
  const low = client.computeNoticeDelayMs(999_999, { randomImpl: () => 0 });
  const high = client.computeNoticeDelayMs(999_999, { randomImpl: () => 1 });
  assert.equal(low, 2000);
  assert.equal(high, 4000);
});

test('computeNoticeDelayMs() never exceeds totalDelayMs for a short total delay', () => {
  const notice = client.computeNoticeDelayMs(500, { randomImpl: () => 1 });
  assert.equal(notice, 500);
});

// ── downloadMedia() — two-step Graph API call, Bearer auth on BOTH steps ─

test('downloadMedia() fetches the media URL first, then downloads bytes with Bearer auth on both requests', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('/mediaId123')) {
      return jsonResponse(200, { url: 'https://lookaside.fbsbx.com/whatsapp_media/abc' });
    }
    if (url === 'https://lookaside.fbsbx.com/whatsapp_media/abc') {
      // Buffer.from(string).buffer would return the whole (larger) pooled
      // ArrayBuffer — use TextEncoder to get an exactly-sized one instead.
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('binary-bytes').buffer };
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const buf = await client.downloadMedia(CREDS, { mediaId: 'mediaId123' }, { fetchImpl });

  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].url, /\/mediaId123$/);
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, 'Bearer EAAB_TOKEN');
  assert.equal(fetchImpl.calls[1].url, 'https://lookaside.fbsbx.com/whatsapp_media/abc');
  // Classic bug: forgetting Bearer auth on the SECOND request. Must be present.
  assert.equal(fetchImpl.calls[1].opts.headers.Authorization, 'Bearer EAAB_TOKEN');
  assert.equal(buf.toString(), 'binary-bytes');
});

test('downloadMedia() returns null (never throws) when the media-info step fails', async () => {
  const fetchImpl = fakeFetch(jsonResponse(404, { error: { message: 'not found' } }));
  const buf = await client.downloadMedia(CREDS, { mediaId: 'gone' }, { fetchImpl });
  assert.equal(buf, null);
});

test('downloadMedia() returns null without hitting the network when mediaId is missing', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  const buf = await client.downloadMedia(CREDS, {}, { fetchImpl });
  assert.equal(buf, null);
  assert.equal(fetchImpl.calls.length, 0);
});

// ── uploadMedia() — outbound primitive (not yet wired up until Phase 7) ─

test('uploadMedia() POSTs multipart form data to the /media endpoint and returns the media id', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { id: 'wamid.uploaded123' }));
  const mediaId = await client.uploadMedia(
    CREDS,
    { buffer: Buffer.from('img-bytes'), filename: 'photo.jpg', mimeType: 'image/jpeg' },
    { fetchImpl }
  );

  assert.equal(mediaId, 'wamid.uploaded123');
  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.match(url, /\/999888777\/media$/);
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.Authorization, 'Bearer EAAB_TOKEN');
  assert.ok(opts.body instanceof FormData);
});

test('uploadMedia() returns null on a non-2xx response', async () => {
  const fetchImpl = fakeFetch(jsonResponse(400, { error: { message: 'bad file' } }));
  const mediaId = await client.uploadMedia(
    CREDS,
    { buffer: Buffer.from('x'), filename: 'x.jpg', mimeType: 'image/jpeg' },
    { fetchImpl }
  );
  assert.equal(mediaId, null);
});

// ── sendText() / sendImageByUrl() / sendImageById() ─────────────────────

test('sendText() posts the exact WhatsApp Cloud API text message shape', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, { messages: [{ id: 'wamid.1' }] }));
  await client.sendText(CREDS, { to: '5215500000000', text: 'Hola!' }, { fetchImpl });

  const { url, opts } = fetchImpl.calls[0];
  assert.match(url, /\/999888777\/messages$/);
  const body = JSON.parse(opts.body);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.to, '5215500000000');
  assert.equal(body.type, 'text');
  assert.equal(body.text.body, 'Hola!');
  assert.equal(opts.headers.Authorization, 'Bearer EAAB_TOKEN');
});

test('sendText() returns null without throwing on a failed send', async () => {
  const fetchImpl = fakeFetch(jsonResponse(500, { error: { message: 'boom' } }));
  const result = await client.sendText(CREDS, { to: '521', text: 'x' }, { fetchImpl });
  assert.equal(result, null);
});

test('sendImageById() posts an image message referencing an uploaded media id', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  await client.sendImageById(CREDS, { to: '521', mediaId: 'wamid.abc', caption: 'Producto' }, { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(body.type, 'image');
  assert.equal(body.image.id, 'wamid.abc');
  assert.equal(body.image.caption, 'Producto');
});

// ── markAsRead() — native typing-indicator trick ─────────────────────────

test('markAsRead() sends a plain read receipt without typing_indicator by default', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  await client.markAsRead(CREDS, { messageId: 'wamid.in1' }, { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(body.status, 'read');
  assert.equal(body.message_id, 'wamid.in1');
  assert.equal(body.typing_indicator, undefined);
});

test('markAsRead() bundles typing_indicator into the same read-receipt call when showTyping is true', async () => {
  const fetchImpl = fakeFetch(jsonResponse(200, {}));
  await client.markAsRead(CREDS, { messageId: 'wamid.in1', showTyping: true }, { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(body.typing_indicator, { type: 'text' });
});

test('markAsRead() never throws even when the network call fails (non-critical)', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  await assert.doesNotReject(client.markAsRead(CREDS, { messageId: 'x' }, { fetchImpl }));
});

// ── sendPacedReply() — silent gap first, THEN typing, THEN send ─────────

test('sendPacedReply() sleeps the silent gap, marks read WITH typing, sleeps the remainder, then sends text — in that exact order', async () => {
  const events = [];
  const fetchImpl = fakeFetch((url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    events.push({ type: 'fetch', status: body.status, msgType: body.type });
    return jsonResponse(200, { messages: [{ id: 'wamid.out1' }] });
  });
  const sleepImpl = async (ms) => {
    events.push({ type: 'sleep', ms });
  };

  const result = await client.sendPacedReply(
    CREDS,
    { to: '521', messageId: 'wamid.in1', customerText: 'hola', replyText: 'hola de vuelta' },
    { fetchImpl, sleepImpl, randomImpl: () => 0.5 }
  );

  assert.equal(events.length, 4);
  assert.equal(events[0].type, 'sleep'); // silent gap first
  assert.equal(events[1].type, 'fetch');
  assert.equal(events[1].status, 'read'); // markAsRead(showTyping: true)
  assert.equal(events[2].type, 'sleep'); // remainder of the pacing delay
  assert.equal(events[3].type, 'fetch');
  assert.equal(events[3].msgType, 'text'); // final send
  assert.ok(result);

  const totalDelay = client.humanDelayMs(4, 'hola de vuelta'.length, { randomImpl: () => 0.5 });
  const noticeDelay = client.computeNoticeDelayMs(totalDelay, { randomImpl: () => 0.5 });
  assert.equal(events[0].ms, noticeDelay);
  assert.equal(events[2].ms, totalDelay - noticeDelay);

  // the typing-indicator call must carry showTyping — confirm via a second
  // fetchImpl capture with full opts inspection
  const readCall = fetchImpl.calls.find((c) => {
    try {
      return JSON.parse(c.opts.body).status === 'read';
    } catch {
      return false;
    }
  });
  assert.deepEqual(JSON.parse(readCall.opts.body).typing_indicator, { type: 'text' });
});
