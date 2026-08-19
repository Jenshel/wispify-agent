'use strict';
// src/integrations/stripe.js — Stripe adapter.
//
// Module boundary (design.md): never touches Express, never persists
// anything. validate() proves a secret key works with a real, read-only
// balance GET and surfaces `livemode` so the setup screen can show
// test-vs-live (design.md validation table).
//
// fetchImpl is injectable so this module's test suite runs fully
// offline/deterministic — see tasks.md Phase 2.5.

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * Validate a Stripe secret key with a real, lightweight authenticated call
 * (GET /v1/balance — read-only).
 *
 * @param {{secretKey: string}} credentials
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, publicMeta?: object, error?: string, credentials?: object}>}
 */
async function validate({ secretKey } = {}, { fetchImpl = fetch } = {}) {
  if (!secretKey) return { ok: false, error: 'secretKey is required' };

  let response;
  try {
    response = await fetchImpl(`${STRIPE_API_BASE}/balance`, {
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` },
    });
  } catch (err) {
    return { ok: false, error: `network error contacting Stripe API: ${err.message}` };
  }

  const body = await safeJson(response);

  if (!response.ok) {
    return { ok: false, error: body?.error?.message || `Stripe API returned HTTP ${response.status}` };
  }

  return {
    ok: true,
    publicMeta: { livemode: !!body?.livemode },
    credentials: { secret_key: secretKey },
  };
}

/**
 * Build a Stripe Checkout Session with dynamic line_items derived from an
 * order's products (design.md "Payments (generic only)": "builds a Checkout
 * Session with dynamic line_items[i][price_data] from the order's
 * products... client_reference_id=orderId + metadata[orderId]"). No fixed
 * per-plan price tiers — spec's explicit boundary.
 *
 * Reuses the SAME Basic-auth pattern validate() already uses (secretKey as
 * the HTTP Basic username, empty password) rather than inventing a second
 * auth shape in this module.
 *
 * @param {{secretKey: string}} credentials
 * @param {{
 *   orderId: string,
 *   products: Array<{name: string, qty: number, price: number}>,
 *   currency: string, successUrl: string, cancelUrl: string,
 * }} order
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, id?: string, url?: string, error?: string}>}
 */
async function createCheckoutSession(
  { secretKey } = {},
  { orderId, products, currency = 'usd', successUrl, cancelUrl } = {},
  { fetchImpl = fetch } = {}
) {
  if (!secretKey) return { ok: false, error: 'secretKey is required' };
  if (!Array.isArray(products) || products.length === 0) {
    return { ok: false, error: 'order has no products — nothing to check out' };
  }

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('client_reference_id', orderId);
  params.append('metadata[orderId]', orderId);

  let lineItemIndex = 0;
  for (const product of products) {
    const unitAmount = Math.round((Number(product.price) || 0) * 100);
    const qty = Number(product.qty) || 1;
    if (unitAmount <= 0) continue; // a free/invalid line item is skipped, mirrors the source's own guard
    params.append(`line_items[${lineItemIndex}][quantity]`, String(qty));
    params.append(`line_items[${lineItemIndex}][price_data][currency]`, String(currency).toLowerCase());
    params.append(`line_items[${lineItemIndex}][price_data][unit_amount]`, String(unitAmount));
    params.append(`line_items[${lineItemIndex}][price_data][product_data][name]`, String(product.name || 'Producto').slice(0, 100));
    lineItemIndex += 1;
  }
  if (lineItemIndex === 0) return { ok: false, error: 'order has no valid (positive-price) line items' };

  let response;
  try {
    response = await fetchImpl(`${STRIPE_API_BASE}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (err) {
    return { ok: false, error: `network error contacting Stripe API: ${err.message}` };
  }

  const body = await safeJson(response);
  if (!response.ok) {
    return { ok: false, error: body?.error?.message || `Stripe API returned HTTP ${response.status}` };
  }

  return { ok: true, id: body.id, url: body.url };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = { validate, createCheckoutSession, STRIPE_API_BASE };
