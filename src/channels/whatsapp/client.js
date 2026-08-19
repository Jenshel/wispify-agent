'use strict';
// src/channels/whatsapp/client.js — outbound Meta Cloud API primitives +
// human-like reply pacing (tasks.md Phase 5.3, PORTED from
// WhiteLabel_WA_System's routes/webhook.js sendCloud*/markAsRead/
// humanDelayMs).
//
// Module boundary (design.md): this file is the transport layer only — it
// never decides WHAT to send, only HOW. src/channels/whatsapp/webhook.js
// (the caller) owns message parsing/routing; Phase 6/7 own reply content.
//
// Credentials are always the exact shape store.getIntegrationCredentials(db,
// 'meta') returns: { access_token, phone_number_id, app_secret?,
// verify_token? } — snake_case, per the repo-wide convention. fetchImpl/
// sleepImpl/randomImpl are all injectable (same DI pattern as
// src/integrations/meta.js's fetchImpl) so this whole module runs fully
// offline and deterministically in tests — see
// test/channels-whatsapp-client.test.js.
//
// Reuses the SAME Graph API version as src/integrations/meta.js (a single
// source of truth) rather than reintroducing the older source system's
// separately-hardcoded v25.0 — this repo already made v23.0 the one
// deliberate choice for the whole codebase in Phase 2.

const { GRAPH_API_BASE } = require('../../integrations/meta');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Human-like reply pacing ──────────────────────────────────────────────
// A "reading the client's message" pause scaled to what they sent, plus a
// "typing the reply" pause scaled to how long the reply is — capped so long
// replies don't make people wait forever. These exact constants (including
// the x3 tuning multiplier) are ported verbatim from the source system's
// most recently tuned humanDelayMs() — do not "simplify" the numbers.
function humanDelayMs(inLen, outLen, { randomImpl = Math.random } = {}) {
  const readMs = Math.min(2500, 400 + inLen * 15);
  const typeMs = Math.min(5500, 800 + outLen * 35);
  const jitter = 0.85 + randomImpl() * 0.3; // +-15%
  return Math.round((readMs + typeMs) * jitter * 3);
}

/**
 * "Silent gap first" (no typing dots yet — the bot "hasn't opened the
 * chat"), THEN the typing indicator kicks in for the rest of the pause.
 * Ported from the source's inline noticeDelay computation next to where
 * humanDelayMs() is invoked.
 */
function computeNoticeDelayMs(totalDelayMs, { randomImpl = Math.random } = {}) {
  return Math.min(totalDelayMs, Math.round(2000 + randomImpl() * 2000));
}

// ── Cloud API send primitives ────────────────────────────────────────────

async function postMessage(credentials, payload, { fetchImpl = fetch } = {}) {
  if (!credentials?.access_token || !credentials?.phone_number_id) return null;
  try {
    const res = await fetchImpl(`${GRAPH_API_BASE}/${credentials.phone_number_id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await safeJson(res);
      console.error('[WHATSAPP] send failed:', JSON.stringify(errBody?.error || res.status));
      return null;
    }
    return await safeJson(res);
  } catch (err) {
    console.error('[WHATSAPP] send failed:', err.message);
    return null;
  }
}

async function sendText(credentials, { to, text }, opts = {}) {
  return postMessage(
    credentials,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    },
    opts
  );
}

async function sendImageByUrl(credentials, { to, imageUrl, caption }, opts = {}) {
  return postMessage(
    credentials,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { link: imageUrl, caption: caption || '' },
    },
    opts
  );
}

async function sendImageById(credentials, { to, mediaId, caption }, opts = {}) {
  return postMessage(
    credentials,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { id: mediaId, caption: caption || '' },
    },
    opts
  );
}

/**
 * Read receipt, with the NATIVE typing-indicator trick bundled into the
 * SAME call when showTyping is true (Cloud API's typing_indicator only
 * shows for a few seconds and must ride a status:'read' call — there is no
 * separate "start typing" endpoint). Non-critical: never throws.
 */
async function markAsRead(credentials, { messageId, showTyping = false }, { fetchImpl = fetch } = {}) {
  if (!credentials?.access_token || !credentials?.phone_number_id) return;
  try {
    const body = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
    if (showTyping) body.typing_indicator = { type: 'text' };
    await fetchImpl(`${GRAPH_API_BASE}/${credentials.phone_number_id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Non-critical — a failed read receipt must never block message processing.
  }
}

// ── Media download (inbound) — two-step Graph API call ──────────────────
// Step 1: resolve the ephemeral media URL from the media id.
// Step 2: download the actual bytes from that URL.
// Both requests need Bearer auth — forgetting it on the SECOND request is
// the classic mistake this port must not repeat.
async function downloadMedia(credentials, { mediaId }, { fetchImpl = fetch } = {}) {
  if (!credentials?.access_token || !mediaId) return null;
  try {
    const infoRes = await fetchImpl(`${GRAPH_API_BASE}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${credentials.access_token}` },
    });
    if (!infoRes.ok) return null;
    const info = await safeJson(infoRes);
    const url = info?.url;
    if (!url) return null;

    const dlRes = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${credentials.access_token}` },
    });
    if (!dlRes.ok) return null;
    const arrayBuffer = await dlRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('[WHATSAPP] media download failed:', err.message);
    return null;
  }
}

// ── Media upload (outbound) — sendable primitive for Phase 7's effects ──
// Nothing calls this yet (ENVIAR_FOTO is a Phase 7 control-tag effect) —
// built now per design.md's module boundary so Phase 7 only has to wire it
// up, not invent the Graph API call shape.
async function uploadMedia(credentials, { buffer, filename, mimeType }, { fetchImpl = fetch } = {}) {
  if (!credentials?.access_token || !credentials?.phone_number_id) return null;
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([buffer], { type: mimeType }), filename || 'upload.bin');

    const res = await fetchImpl(`${GRAPH_API_BASE}/${credentials.phone_number_id}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.access_token}` },
      body: form,
    });
    if (!res.ok) return null;
    const body = await safeJson(res);
    return body?.id || null;
  } catch (err) {
    console.error('[WHATSAPP] media upload failed:', err.message);
    return null;
  }
}

/**
 * Composed helper: waits the human-paced delay (silent gap, THEN typing
 * indicator for the remainder), then sends the reply text. This is the
 * stub send path Phase 5 wires the webhook handler into — Phase 6 supplies
 * the real replyText, this function's timing behavior does not change.
 */
async function sendPacedReply(
  credentials,
  { to, messageId, customerText, replyText },
  { fetchImpl = fetch, sleepImpl = sleep, randomImpl = Math.random } = {}
) {
  const totalDelay = humanDelayMs((customerText || '').length, (replyText || '').length, { randomImpl });
  const noticeDelay = computeNoticeDelayMs(totalDelay, { randomImpl });

  await sleepImpl(noticeDelay);
  await markAsRead(credentials, { messageId, showTyping: true }, { fetchImpl });
  await sleepImpl(totalDelay - noticeDelay);

  return sendText(credentials, { to, text: replyText }, { fetchImpl });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = {
  sleep,
  humanDelayMs,
  computeNoticeDelayMs,
  sendText,
  sendImageByUrl,
  sendImageById,
  markAsRead,
  downloadMedia,
  uploadMedia,
  sendPacedReply,
};
