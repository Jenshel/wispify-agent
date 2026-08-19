'use strict';
// src/routes/payments.js — generic Stripe checkout (tasks.md Phase 9,
// design.md "Payments (generic only)").
//
// PORTED FLOW (not code) from WhiteLabel_WA_System/routes/payments.js's
// GENERIC order-based path only — `GET /pago/stripe-redirect/:orderId`
// (lazy Checkout Session creation from an order's products) and
// `POST /stripe-webhook`'s `checkout.session.completed` order-matching
// logic. The fixed per-plan Stripe payment-link branch that source file
// also contains (Wispify's own subscription setup fee, matched by
// `payment_link` id against a `planPaymentLinks` config) is deliberately
// NOT ported — spec.md is explicit: "generic per-order Checkout Session
// only... MUST NOT ship fixed per-plan price tiers."
//
// GET /pay/:orderId — the customer-facing redirect a `[PEDIDO_CONFIRMADO]`
// WhatsApp message links to (built by src/agent/effects/order.js). Builds a
// real Stripe Checkout Session lazily (only when clicked, not eagerly at
// order-creation time) and 303-redirects to it.
//
// Session caching: unlike the source system's equivalent `stripeSessionUrl
// && !stripeSessionExpired` check — whose `stripeSessionExpired` flag is
// read but NEVER SET anywhere in that codebase (grepped, confirmed empty; a
// live bug that would serve an already-expired Stripe URL forever once one
// existed) — this port actually enforces the freshness window Stripe's own
// default Checkout Session expiry implies (~24h after creation), instead of
// silently repeating that bug.
//
// POST /webhook/stripe — verifies Stripe's signature (fail-closed,
// timing-safe, timestamp-freshness check — same rigor as
// src/channels/whatsapp/webhook.js's Meta HMAC verification), matches
// `checkout.session.completed` to a pending order via
// `client_reference_id`/`metadata.orderId` (the generic-order matching path
// only — the source's slot-scanning Payment-Link fallback and its plan-tier
// branch are both dropped, per the same generic-only scope boundary above),
// marks it paid, and sends a WhatsApp payment confirmation.
//
// GET /pay/:orderId/result — a DELIBERATE, EXPLICITLY-FLAGGED SCOPE GAP: no
// public-facing confirmation page (the source system's `wispify.app/pago`
// equivalent) exists anywhere in this repo or in tasks.md's remaining
// phases (Phase 11 is the admin panel, not a public page). Rather than
// redirect success_url/cancel_url to a URL that would 404, this route is a
// minimal, honest, server-rendered placeholder that reads the REAL order
// status from the DB (never trusts the `?paid=1` query string Stripe's
// success_url alone would carry — that string only reflects Stripe's
// client-side redirect, not the webhook's server-side confirmation, and the
// two can race). Whoever builds the eventual public page should replace
// this route's body, not its callers.

const express = require('express');
const crypto = require('crypto');

const store = require('../config/store');
const client = require('../channels/whatsapp/client');
const stripe = require('../integrations/stripe');
const orders = require('../db/orders');

const WEBHOOK_MAX_AGE_SEC = 300; // ported verbatim from the source's own replay-age check
const SESSION_CACHE_FRESH_MS = 23 * 60 * 60 * 1000; // Stripe's default Checkout Session expiry is ~24h; 23h leaves a safety margin so a customer is never handed a URL Stripe is about to expire mid-checkout

// ── Stripe HMAC verify (threat-matrix a) ──────────────────────────────────
// Stripe's `Stripe-Signature` header is `t=<unix ts>,v1=<hex hmac>[,v0=...]`
// (comma-separated key=value pairs) — a different wire format from Meta's
// `sha256=<hex>` header, but the same fail-closed discipline: a length
// check BEFORE crypto.timingSafeEqual (which throws on unequal-length
// buffers), crypto.timingSafeEqual itself (never a plain `===` on a
// secret-derived value), and — unlike Meta's webhook — a replay-age check,
// since Stripe's signed payload embeds its own timestamp for exactly this
// purpose.
function verifyStripeSignature(rawBody, sigHeader, secret, { now = Date.now(), maxAgeSec = WEBHOOK_MAX_AGE_SEC } = {}) {
  if (!rawBody || !rawBody.length) return { ok: false, reason: 'no_body' };
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (!sigHeader) return { ok: false, reason: 'missing_header' };

  const elements = {};
  for (const part of String(sigHeader).split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    elements[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  const timestamp = elements.t;
  const providedHex = elements.v1;
  if (!timestamp || !providedHex) return { ok: false, reason: 'malformed_header' };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'malformed_header' };
  if (!/^[a-f0-9]+$/i.test(providedHex)) return { ok: false, reason: 'malformed_header' };

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expectedHex = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const providedLower = providedHex.toLowerCase();

  if (expectedHex.length !== providedLower.length) return { ok: false, reason: 'length_mismatch' };
  const matches = crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(providedLower, 'hex'));
  if (!matches) return { ok: false, reason: 'hmac_mismatch' };

  const ageSec = Math.floor(now / 1000) - parseInt(timestamp, 10);
  if (ageSec > maxAgeSec) return { ok: false, reason: 'event_too_old' };
  // Beyond the source's own check: a timestamp implausibly far in the
  // future is just as suspicious as a stale one (clock skew or a crafted
  // replay), so it fails closed too rather than being silently accepted.
  if (ageSec < -maxAgeSec) return { ok: false, reason: 'event_from_future' };

  return { ok: true, reason: 'ok' };
}

function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Minimal placeholder result page — see this file's header comment. */
function resultPage(title, message) {
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family: sans-serif; max-width: 480px; margin: 4rem auto; text-align: center;">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: typeof fetch}} [opts]
 */
function createPaymentsRouter(db, { fetchImpl = fetch } = {}) {
  const router = express.Router();

  // ── GET /pay/:orderId/result — placeholder confirmation page ───────────
  router.get('/pay/:orderId/result', (req, res) => {
    const order = orders.getOrderById(db, req.params.orderId);
    if (!order) return res.status(404).type('html').send(resultPage('Orden no encontrada', 'No encontramos esa orden.'));
    if (order.status === 'paid') {
      return res.type('html').send(resultPage('Pago confirmado', '¡Gracias por tu compra! Recibimos tu pago correctamente.'));
    }
    return res
      .type('html')
      .send(resultPage('Pago pendiente', 'Tu pago no se ha completado o aún se está procesando. Si ya pagaste, esto se actualizará en unos segundos.'));
  });

  // ── GET /pay/:orderId — build/redirect to the real Checkout Session ────
  router.get('/pay/:orderId', async (req, res) => {
    const order = orders.getOrderById(db, req.params.orderId);
    if (!order) return res.status(404).send('Orden no encontrada');

    if (order.status === 'paid') {
      return res.redirect(`/pay/${order.id}/result?paid=1`);
    }

    const secretKey = store.getIntegrationCredentials(db, 'stripe')?.secret_key;
    if (!secretKey) return res.status(500).send('Stripe no está configurado');

    const cacheFresh =
      order.stripeSessionUrl && order.updatedAt && Date.now() - Date.parse(`${order.updatedAt}`) < SESSION_CACHE_FRESH_MS;
    if (cacheFresh) {
      return res.redirect(303, order.stripeSessionUrl);
    }

    const baseUrl = publicBaseUrl(req);
    const result = await stripe.createCheckoutSession(
      { secretKey },
      {
        orderId: order.id,
        products: order.products,
        currency: order.currency,
        successUrl: `${baseUrl}/pay/${order.id}/result?paid=1`,
        cancelUrl: `${baseUrl}/pay/${order.id}/result`,
      },
      { fetchImpl }
    );
    if (!result.ok) {
      console.error('[STRIPE CHECKOUT] session creation failed:', result.error);
      return res.status(500).send(`No se pudo iniciar el pago: ${result.error}`);
    }

    orders.setStripeSession(db, order.id, { stripeSessionId: result.id, stripeSessionUrl: result.url });
    console.log(`[STRIPE CHECKOUT] session ${result.id} created for order ${order.id} → redirect`);
    return res.redirect(303, result.url);
  });

  // ── POST /webhook/stripe — payment confirmation (raw body, HMAC) ───────
  router.post('/webhook/stripe', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    const secret = store.getIntegrationCredentials(db, 'stripe')?.webhook_secret;
    const sigHeader = req.headers['stripe-signature'];
    const rawBody = req.body;

    const verification = verifyStripeSignature(rawBody, sigHeader, secret);
    if (!verification.ok) {
      console.warn(`[STRIPE-WEBHOOK] signature rejected: ${verification.reason}`);
      // A missing secret is a server misconfiguration (fail closed, but
      // distinctly from a bad/replayed signature, same as the source's own
      // "secret not configured" 500 vs. a verification-failure 400).
      return res.sendStatus(verification.reason === 'no_secret_configured' ? 500 : 400);
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      console.error('[STRIPE-WEBHOOK] malformed JSON body:', err.message);
      return res.sendStatus(400);
    }

    // Ack Stripe immediately — same fire-and-forget precedent as
    // src/channels/whatsapp/webhook.js's Meta handler (a slow WhatsApp
    // confirmation send must never delay the webhook ack, or Stripe retries
    // delivery).
    res.sendStatus(200);

    handleStripeEvent(event, { fetchImpl }).catch((err) => {
      console.error('[STRIPE-WEBHOOK] processing error:', err.message);
    });
  });

  async function handleStripeEvent(event, { fetchImpl: fi }) {
    if (event.type !== 'checkout.session.completed') {
      console.log(`[STRIPE-WEBHOOK] received ${event.type} (ignored)`);
      return;
    }

    const session = event.data?.object || {};
    const orderId = session.client_reference_id || session.metadata?.orderId || null;
    if (!orderId) {
      console.warn(`[STRIPE-WEBHOOK] checkout.session.completed with no client_reference_id/metadata.orderId (session=${session.id})`);
      return;
    }

    const order = orders.getOrderById(db, orderId);
    if (!order) {
      console.warn(`[STRIPE-WEBHOOK] no matching order for orderId=${orderId} (session=${session.id})`);
      return;
    }
    if (order.status === 'paid') {
      console.log(`[STRIPE-WEBHOOK] order ${orderId} already paid — ignoring duplicate event`);
      return;
    }

    orders.markPaid(db, orderId, { stripeSessionId: session.id });
    console.log(`[STRIPE-WEBHOOK] order ${orderId} → paid`);

    const metaCreds = store.getIntegrationCredentials(db, 'meta');
    if (metaCreds && order.customerPhone) {
      const productsLine = (order.products || []).map((p) => p.name).filter(Boolean).join(', ');
      const totalLine = order.total ? `$${order.total} ${order.currency || ''}`.trim() : '';
      const confirmMsg = totalLine
        ? `Pago confirmado ✅ Recibimos ${totalLine}${productsLine ? ` por ${productsLine}` : ''}. ¡Gracias por tu compra!`
        : 'Pago confirmado ✅ ¡Gracias por tu compra!';
      try {
        await client.sendText(metaCreds, { to: order.customerPhone, text: confirmMsg }, { fetchImpl: fi });
      } catch (err) {
        console.error('[STRIPE-WEBHOOK] payment confirmation send failed:', err.message);
      }
    }
  }

  return router;
}

module.exports = { createPaymentsRouter, verifyStripeSignature };
