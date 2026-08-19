'use strict';
// src/agent/effects/order.js — [PEDIDO_CONFIRMADO] effect handler
// (tasks.md Phase 9), replacing PR9's documented stub with the real thing.
//
// Creates the `orders` row (status='pending') and sends the customer a
// `/pay/:orderId` link over WhatsApp. The real Stripe Checkout Session
// itself is built LAZILY by src/routes/payments.js's GET /pay/:orderId — NOT
// here — only when the customer actually clicks the link. This mirrors the
// source system's own two-step shape (create the order first, build the
// Checkout Session on the redirect route) rather than eagerly creating a
// Stripe session for every parsed order, most of which a customer may never
// click through to pay. src/routes/payments.js's POST /webhook/stripe
// (Phase 9.3) marks the order paid and sends the payment-confirmation
// message once Stripe reports `checkout.session.completed`.
//
// Needs `PUBLIC_BASE_URL` (env, deploy-level config — same convention as
// `PORT` in src/server.js, not an app_config/admin-editable field) to build
// an absolute link a WhatsApp text message can actually contain. Unlike GET
// /pay/:orderId's success_url/cancel_url (which has a real Express `req` to
// derive host/protocol from), there is no request context here — this
// effect is dispatched from src/agent/effects/index.js, itself called from
// the webhook handler after the AI reply was already generated. If
// PUBLIC_BASE_URL is unset, the order is still created (so the admin/webhook
// flow keeps working end to end) but the customer is told staff will follow
// up instead of receiving a broken/relative URL — same graceful-degradation
// posture as confirmAppointment.js's Calendar-failure handling.

const crypto = require('crypto');

const store = require('../../config/store');
const client = require('../../channels/whatsapp/client');
const orders = require('../../db/orders');

async function notifyCustomer(db, from, text, { fetchImpl } = {}) {
  const metaCreds = store.getIntegrationCredentials(db, 'meta');
  if (!metaCreds) return false;
  try {
    const result = await client.sendText(metaCreds, { to: from, text }, { fetchImpl });
    return !!result;
  } catch (err) {
    // A failed notification must never crash the reply pipeline — the order
    // itself has already been persisted regardless (matches
    // dispatchEffectCalls()'s own "an effect must never throw" contract).
    console.error('[PEDIDO_CONFIRMADO] notification send failed:', err.message);
    return false;
  }
}

/**
 * @param {{products: Array<{name: string, qty: number, price: number}>, total: number, from: string}} payload
 * @param {{db?: import('better-sqlite3').Database, fetchImpl?: typeof fetch}} [ctx]
 * @returns {Promise<{ok: boolean, reason?: string, id?: string, total?: number, currency?: string, paymentLink?: string|null}>}
 */
async function confirmOrder({ products = [], total, from } = {}, { db, fetchImpl } = {}) {
  if (!db) {
    console.warn(`[PEDIDO_CONFIRMADO] no db in ctx — cannot create order (from=${from})`);
    return { ok: false, reason: 'no_db' };
  }
  if (!Array.isArray(products) || products.length === 0) {
    console.warn(`[PEDIDO_CONFIRMADO] no products parsed — nothing to check out (from=${from})`);
    return { ok: false, reason: 'no_products' };
  }

  const totalNum = Number(total) || products.reduce((sum, p) => sum + (Number(p.price) || 0) * (Number(p.qty) || 1), 0);
  const currency = store.getAppConfig(db).currency || 'MXN';

  const id = crypto.randomUUID();
  orders.createOrder(db, { id, customerPhone: from, products, total: totalNum, currency });
  console.log(`[PEDIDO_CONFIRMADO] Order ${id} created — ${products.length} item(s), total ${totalNum} ${currency} (from=${from})`);

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  const totalLine = totalNum > 0 ? `Total: $${totalNum} ${currency}` : '';
  let confirmMsg;
  let paymentLink = null;
  if (baseUrl) {
    paymentLink = `${baseUrl}/pay/${id}`;
    confirmMsg = `✅ Tu pedido quedó registrado.\n\n${totalLine}\n\nPaga aquí de forma segura: ${paymentLink}`;
  } else {
    console.warn('[PEDIDO_CONFIRMADO] PUBLIC_BASE_URL is not configured — cannot build a payment link, customer told staff will follow up instead');
    confirmMsg = `✅ Tu pedido quedó registrado.\n\n${totalLine}\n\nEn breve el equipo te contacta para completar el pago.`;
  }
  await notifyCustomer(db, from, confirmMsg, { fetchImpl });

  return { ok: true, id, total: totalNum, currency, paymentLink };
}

module.exports = { confirmOrder };
