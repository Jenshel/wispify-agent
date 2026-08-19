'use strict';
// src/agent/effects/order.js — [PEDIDO_CONFIRMADO] effect handler
// (tasks.md Phase 7.4) — DOCUMENTED STUB, NOT the real thing yet.
//
// Same story as appointment.js: this phase parses the tag and calls the
// seam; Phase 9 ("Payments — generic Stripe checkout") owns the real
// payment-link creation:
//   - 9.2: `GET /pay/:orderId` building dynamic Stripe line_items from the
//     order this function would need to persist.
//   - 9.3: the Stripe webhook that marks an order paid and confirms over
//     WhatsApp.
//
// No `orders` table exists yet (schema.sql defers it), so this function
// cannot create a real order row — it only logs the parsed
// products/total and reports the stub outcome. Signature is stable for
// Phase 9 to fill in without touching call sites.

/**
 * @param {{products: Array<{name: string, qty: number, price: number}>, total: number, from: string}} payload
 * @param {{db?: import('better-sqlite3').Database}} [ctx]
 * @returns {Promise<{ok: false, stub: true, reason: string}>}
 */
async function confirmOrder({ products = [], total, from } = {}, _ctx = {}) {
  console.warn(
    `[PEDIDO_CONFIRMADO] STUB — from=${from} products=${products.length} total=${total ?? 0}` +
      ' — no order persisted, no Stripe Checkout session created (Phase 9 owns generic checkout).'
  );
  return { ok: false, stub: true, reason: 'order_checkout_not_implemented_yet' };
}

module.exports = { confirmOrder };
