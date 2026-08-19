'use strict';
// src/channels/whatsapp/webhook.js — GET/POST /webhook (tasks.md Phase
// 5.1/5.2, PORTED from WhiteLabel_WA_System's routes/webhook.js).
//
// Module boundary (design.md): this file is the transport/channel layer
// ONLY — HMAC verification, the Meta subscription handshake, and inbound
// message parsing/media download. Control-tag parsing/effects (Phase 7)
// are explicitly OUT of scope here; this file stops at
// processIncomingMessage(), which now calls src/brain/index.js's
// generateReply() directly (Phase 6) — a real, single-turn Gemini reply,
// not the tag-effects pipeline Phase 7 still owns.
//
// Security posture (deliberate deviation from the source system, per the
// delegated PR7 instructions): the source's routes/webhook.js gated HMAC
// enforcement behind a META_WEBHOOK_VERIFY_MODE env var defaulting to
// 'off', with a permissive "no secret configured -> accept blindly"
// fallback even in 'enforce' mode — flagged by this session's own security
// audit as a real risk. design.md is silent on keeping that flexibility,
// so this fresh public starter ships secure-by-default instead: HMAC
// verification is ALWAYS enforced, and a missing app_secret fails closed
// (401), never accepts blindly.
//
// Phase 10 (tasks.md 10.1, src/jobs/nudges.js): handleIncomingMessage() is
// also the sole write path for the new src/db/conversations.js table —
// every real inbound customer message upserts last_client_message_at +
// appends to the bounded recent-turns log, and the bot's own reply is
// appended to that same log once client.sendPacedReply() succeeds. This is
// the only place inbound messages are observed, so it is the natural
// integration point (see src/db/conversations.js's header comment for why
// this table exists at all).

const express = require('express');
const crypto = require('crypto');

const store = require('../../config/store');
const client = require('./client');
const mediaStore = require('../../media/store');
const brain = require('../../brain');
const conversations = require('../../db/conversations');

// ── Meta HMAC verify (threat-matrix a) ───────────────────────────────────
// Ported verbatim from the source's verifyMetaSignature(): the
// `sha256=`-prefixed header format, a length check BEFORE the timing-safe
// comparison (crypto.timingSafeEqual throws on unequal-length buffers — a
// length mismatch must fail closed first, not crash the request), and
// crypto.timingSafeEqual itself (never a plain `===` on a secret-derived
// value).
function verifySignature(rawBody, sigHeader, secret) {
  if (!rawBody || !rawBody.length) return { ok: false, reason: 'no_body' };
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (!sigHeader) return { ok: false, reason: 'missing_header' };
  const match = /^sha256=([a-f0-9]+)$/i.exec(sigHeader);
  if (!match) return { ok: false, reason: 'malformed_header' };

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedHex = match[1].toLowerCase();
  if (expectedHex.length !== providedHex.length) return { ok: false, reason: 'length_mismatch' };

  const matches = crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(providedHex, 'hex'));
  return { ok: matches, reason: matches ? 'ok' : 'hmac_mismatch' };
}

/** Same fail-closed-on-length-mismatch + timing-safe pattern, for the GET verify_token compare. */
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Integration seam ──────────────────────────────────────────────────────
// Real AI reply generation (Phase 6, extended Phase 7). `db` and
// `fetchImpl` are threaded through from createWebhookRouter()'s own params
// (the injectable-fetch DI pattern used throughout this repo); no parallel/
// duplicate reply path is built here — this is the ONLY place that calls
// src/brain/index.js generateReply(). `from` (Phase 7) lets the control-tag
// effect pipeline (e.g. escalateHuman) know which customer to reference —
// generateReply()'s returned string is always the tag-free, customer-safe
// reply text.
async function processIncomingMessage(db, from, text, media, { fetchImpl } = {}) {
  return brain.generateReply(db, { text, media, from }, { fetchImpl });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   randomImpl?: () => number,
 *   dataDir?: string,
 *   onMessageProcessed?: (info: object) => void,
 * }} [opts]
 */
function createWebhookRouter(
  db,
  { fetchImpl = fetch, sleepImpl, randomImpl, dataDir = mediaStore.DEFAULT_DATA_DIR, onMessageProcessed } = {}
) {
  const router = express.Router();

  // ── GET /webhook — Meta subscription verification challenge ───────────
  router.get('/webhook', (req, res) => {
    const creds = store.getIntegrationCredentials(db, 'meta') || {};
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && creds.verify_token && timingSafeStringEqual(token, creds.verify_token)) {
      console.log('[WEBHOOK] verification successful');
      return res.status(200).send(challenge);
    }
    console.warn('[WEBHOOK] verification failed — token mismatch or not configured yet');
    return res.sendStatus(403);
  });

  // ── POST /webhook — incoming messages (raw body, required for HMAC) ───
  router.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    const creds = store.getIntegrationCredentials(db, 'meta') || {};
    const rawBody = req.body;
    const sigHeader = req.headers['x-hub-signature-256'];

    const result = verifySignature(rawBody, sigHeader, creds.app_secret);
    if (!result.ok) {
      console.warn(`[WEBHOOK] signature rejected: ${result.reason}`);
      return res.sendStatus(401);
    }

    // Ack Meta immediately — actual processing (media download, human-paced
    // reply) can take several real seconds and must never delay the ack,
    // or Meta will retry delivery. Matches the source system's fire-and
    // -forget pattern.
    res.sendStatus(200);

    handleWebhookBody(rawBody, creds).catch((err) => {
      console.error('[WEBHOOK] processing error:', err.message);
    });
  });

  async function handleWebhookBody(rawBody, creds) {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      console.error('[WEBHOOK] malformed JSON body:', err.message);
      return;
    }
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (!value || !value.messages) continue;

        const metadata = value.metadata || {};
        const phoneNumberId = metadata.phone_number_id;
        // Mono-tenant: this instance serves exactly one number. Ignore
        // anything not addressed to the currently-configured
        // phone_number_id instead of guessing (de-slotting table:
        // "webhook ignores non-matching metadata.phone_number_id").
        if (creds.phone_number_id && phoneNumberId !== creds.phone_number_id) {
          console.warn(`[WEBHOOK] ignoring message for unrecognized phone_number_id=${phoneNumberId}`);
          continue;
        }

        for (const msg of value.messages) {
          await handleIncomingMessage(creds, msg).catch((err) => {
            console.error('[WEBHOOK] handleIncomingMessage error:', err.message);
          });
        }
      }
    }
  }

  async function handleIncomingMessage(creds, msg) {
    const from = msg.from;
    const messageId = msg.id;
    const type = msg.type;

    let customerText = '';
    let media = null;
    let mediaUrl = null;

    if (type === 'text') {
      customerText = msg.text?.body || '';
    } else if (type === 'interactive') {
      customerText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    } else if (type === 'image' || type === 'audio') {
      const mediaId = msg[type]?.id;
      const mimeType = msg[type]?.mime_type || (type === 'image' ? 'image/jpeg' : 'audio/ogg');
      customerText =
        type === 'image' ? msg.image?.caption || '[El cliente envió una imagen]' : '[El cliente envió un audio]';
      if (mediaId) {
        const buffer = await client.downloadMedia(creds, { mediaId }, { fetchImpl });
        if (buffer) {
          media = { mimeType, data: buffer };
          const saved = mediaStore.saveClientMedia(dataDir, from, buffer, mimeType);
          mediaUrl = `/api/media/client/${encodeURIComponent(saved.phoneSegment)}/${encodeURIComponent(saved.filename)}`;
          console.log(`[WEBHOOK] stored inbound ${type} (${buffer.length}B) from ${from}`);
        } else {
          console.error(`[WEBHOOK] media download failed for ${type} from ${from} (mediaId=${mediaId})`);
        }
      }
    } else {
      console.log(`[WEBHOOK] unsupported message type '${type}' from ${from} — skipped`);
      // PR12 follow-up fix: this is still a REAL inbound message from a
      // genuinely engaged customer — the stall-detection clock
      // (src/jobs/nudges.js) must reset even though the bot can't
      // understand/generate a reply for this type. Only reply generation
      // is skipped here, not activity tracking — otherwise a customer
      // actively engaging via video/document/sticker/location/etc. looks
      // stalled to the nudge job and can get an inappropriate "why did you
      // stop responding" follow-up.
      conversations.recordClientMessage(db, from, { text: '[mensaje no soportado]' });
      return;
    }

    if (!customerText.trim() && !media) return;

    // Phase 10 (tasks.md 10.1, src/jobs/nudges.js): this is the ONLY place
    // inbound messages are currently observed, so it is the natural
    // integration point for the conversations table's stall-detection
    // clock + bounded recent-turns context log. Real DB write, not
    // in-memory state — the nudge job's dedupe/stall check reads this
    // fresh on every scan.
    //
    // Phase 11 (tasks.md 11.2, gap #4): pass the mediaUrl this handler
    // already computed for image/audio messages through onto the recorded
    // turn, so the panel's ChatView thread view has something to point an
    // <img>/<audio> tag at (src/db/conversations.js's turn shape carries
    // these as OPTIONAL fields — old entries without them still parse fine).
    conversations.recordClientMessage(db, from, {
      text: customerText,
      mediaUrl: mediaUrl || undefined,
      mediaType: media ? media.mimeType : undefined,
    });

    // Read receipt only — typing dots kick in later, once the pacing
    // decides it's time (see client.sendPacedReply()).
    await client.markAsRead(creds, { messageId }, { fetchImpl });

    // Phase 11 (tasks.md 11.1, gap #3): app_config.bot_paused is a GLOBAL
    // pause flag (schema since Phase 1) that was set-able via the settings
    // route since PR4 but READ NOWHERE — flagged as still-unwired in every
    // prior phase's Open Risks (PR9-PR12). Wired here now: read FRESH on
    // every message (no caching), same "apply live, no restart" guarantee
    // soul-docs edits already have (PR8's src/brain/index.js) — flipping
    // the panel's toggle affects the very next inbound message. The
    // conversations write + read receipt above still happen while paused
    // (an admin reviewing the panel needs to see what the customer said,
    // and the stall clock must keep ticking) — only reply
    // generation/sending is skipped.
    const appConfig = store.getAppConfig(db);
    if (appConfig.botPaused) {
      console.log(`[WEBHOOK] bot is paused — message from ${from} recorded, no reply generated`);
      if (typeof onMessageProcessed === 'function') {
        onMessageProcessed({
          from,
          messageId,
          type,
          customerText,
          media: media ? { mimeType: media.mimeType } : null,
          mediaUrl,
          replyText: null,
          sendResult: null,
          paused: true,
        });
      }
      return;
    }

    const replyText = await processIncomingMessage(db, from, customerText, media, { fetchImpl });

    let sendResult = null;
    if (replyText) {
      sendResult = await client.sendPacedReply(
        creds,
        { to: from, messageId, customerText, replyText },
        { fetchImpl, sleepImpl, randomImpl }
      );
      if (sendResult) {
        // Append the bot's own reply to the SAME bounded log so nudge
        // context includes both sides of the conversation, mirroring the
        // source system's timeline.jsonl. Only recorded once the send
        // actually succeeded — a failed send never claims the bot said
        // something it didn't.
        conversations.recordBotMessage(db, from, { text: replyText });
      }
    }

    if (typeof onMessageProcessed === 'function') {
      onMessageProcessed({
        from,
        messageId,
        type,
        customerText,
        media: media ? { mimeType: media.mimeType } : null,
        mediaUrl,
        replyText,
        sendResult,
        paused: false,
      });
    }
  }

  return router;
}

module.exports = {
  createWebhookRouter,
  verifySignature,
  timingSafeStringEqual,
  processIncomingMessage,
};
