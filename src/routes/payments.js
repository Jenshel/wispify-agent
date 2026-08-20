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
// GET /pay/:orderId/result — the customer-facing confirmation page a Stripe
// Checkout redirect (success_url/cancel_url) lands on. Originally shipped
// (PR11) as "a DELIBERATE, EXPLICITLY-FLAGGED SCOPE GAP" — a bare, unstyled
// placeholder, since no public-facing confirmation page existed anywhere in
// tasks.md's phases. This closes that gap: an on-brand, server-rendered
// page (reusing panel/src/index.css's dark theme + green-accent tokens,
// inlined here since this page is served outside the panel's React app and
// can't import that stylesheet directly) that still reads the REAL order
// status from the DB on every load — the placeholder's core discipline is
// UNCHANGED, only what's rendered around it changed. `?paid=1` is still
// never trusted on its own: that query string only reflects Stripe's
// client-side redirect, not the webhook's server-side confirmation, and the
// two can race.

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

// ── Result page — on-brand, mobile-first, self-contained (server-rendered
// outside the panel's React app, so it can't import panel/src/index.css —
// the values below are copied from it, not a new palette). `--pending` /
// `--pending-bg` are new tokens local to this standalone page only (not
// added to the shared panel token set): a normal in-flight webhook delay is
// not an error, so it deliberately does NOT reuse `--danger`. ──────────
const PAGE_CSS = `
:root {
  --bg: #0b0f14;
  --bg-card: #161c25;
  --border: rgba(255, 255, 255, 0.08);
  --text: #f5f7fa;
  --text-dim: #9aa4b2;
  --text-mute: #64748b;
  --accent-green: #2ec78e;
  --accent-green-deep: #56e3ab;
  --pending: #f5b942;
  --pending-bg: rgba(245, 185, 66, 0.12);
  --font-main: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-main);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
.result-card {
  width: 100%;
  max-width: 480px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 32px 28px;
  text-align: center;
}
.brand {
  font-size: 14px;
  font-weight: 700;
  margin: 0 0 20px;
  background: linear-gradient(135deg, var(--accent-green), var(--accent-green-deep));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  margin: 0 auto 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.icon-success { background: linear-gradient(135deg, var(--accent-green), var(--accent-green-deep)); }
.icon-success::after {
  content: '';
  width: 14px;
  height: 26px;
  border: solid #04120c;
  border-width: 0 4px 4px 0;
  transform: rotate(45deg) translate(-2px, -3px);
}
.icon-pending { background: var(--pending-bg); }
.icon-pending .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pending);
  animation: pulse-dot 1.2s ease-in-out infinite;
}
.icon-pending .dot:nth-child(2) { animation-delay: 0.2s; }
.icon-pending .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes pulse-dot {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.1); }
}
.icon-muted {
  background: rgba(154, 164, 178, 0.12);
  color: var(--text-dim);
  font-size: 26px;
  font-weight: 700;
}
h1 { font-size: 20px; margin: 0 0 8px; }
.message { color: var(--text-dim); font-size: 13px; line-height: 1.5; margin: 0; }
.hint { color: var(--text-mute); font-size: 12px; margin: 12px 0 0; }
.receipt { width: 100%; border-collapse: collapse; margin-top: 20px; text-align: left; font-size: 13px; }
.receipt td { padding: 8px 0; border-bottom: 1px solid var(--border); }
.receipt-qty { color: var(--text-mute); font-size: 12px; }
.receipt-price { text-align: right; white-space: nowrap; }
.receipt tfoot td { border-bottom: none; border-top: 1px solid var(--border); padding-top: 12px; font-weight: 700; }
.receipt-total-value { text-align: right; }
`;

function pageShell(title, bodyHtml, { autoRefresh = false } = {}) {
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    (autoRefresh ? `<meta http-equiv="refresh" content="5">` : '') +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">` +
    `<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head>` +
    `<body><main class="result-card">${bodyHtml}</main></body></html>`
  );
}

/**
 * Receipt-style summary of the order's products/total — paid state only.
 * Pure function (no DB/HTTP access), unit-tested directly.
 * @param {{products: Array<{name: string, qty: number, price: number}>, total: number, currency: string}} order
 */
function renderReceipt(order) {
  const rows = (order.products || [])
    .map((p) => {
      const qty = Number(p.qty) || 1;
      const lineTotal = (Number(p.price) || 0) * qty;
      return (
        `<tr><td>${escapeHtml(p.name || '')} <span class="receipt-qty">× ${qty}</span></td>` +
        `<td class="receipt-price">$${lineTotal.toFixed(2)}</td></tr>`
      );
    })
    .join('');
  const total = (Number(order.total) || 0).toFixed(2);
  return (
    `<table class="receipt"><tbody>${rows}</tbody><tfoot><tr>` +
    `<td>Total</td><td class="receipt-total-value">$${total} ${escapeHtml(order.currency || '')}</td>` +
    `</tr></tfoot></table>`
  );
}

function notFoundPage() {
  return pageShell(
    'Orden no encontrada',
    `<div class="brand">Wispify</div>` +
      `<div class="icon icon-muted">?</div>` +
      `<h1>Orden no encontrada</h1>` +
      `<p class="message">No encontramos esa orden. Verifica el enlace o contáctanos si crees que esto es un error.</p>`
  );
}

function paidPage(order) {
  return pageShell(
    'Pago confirmado',
    `<div class="brand">Wispify</div>` +
      `<div class="icon icon-success"></div>` +
      `<h1>Pago confirmado</h1>` +
      `<p class="message">¡Gracias por tu compra! Recibimos tu pago correctamente.</p>` +
      renderReceipt(order)
  );
}

function pendingPage() {
  return pageShell(
    'Pago pendiente',
    `<div class="brand">Wispify</div>` +
      `<div class="icon icon-pending"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>` +
      `<h1>Pago pendiente</h1>` +
      `<p class="message">Tu pago no se ha completado o aún se está procesando. Si ya pagaste, esto se actualizará en unos segundos.</p>` +
      `<p class="hint">Esta página se actualiza sola.</p>`,
    { autoRefresh: true }
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: typeof fetch}} [opts]
 */
function createPaymentsRouter(db, { fetchImpl = fetch } = {}) {
  const router = express.Router();

  // ── GET /pay/:orderId/result — on-brand confirmation page ──────────────
  router.get('/pay/:orderId/result', (req, res) => {
    const order = orders.getOrderById(db, req.params.orderId);
    if (!order) return res.status(404).type('html').send(notFoundPage());
    if (order.status === 'paid') {
      return res.type('html').send(paidPage(order));
    }
    return res.type('html').send(pendingPage());
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

module.exports = { createPaymentsRouter, verifyStripeSignature, renderReceipt };
