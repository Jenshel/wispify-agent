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

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = { validate, STRIPE_API_BASE };
