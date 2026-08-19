'use strict';
// src/integrations/meta.js — Meta (WhatsApp Cloud API) adapter.
//
// Module boundary (design.md): this file never touches Express and never
// persists anything. validate() proves a token+phone-number-id pair works
// against the real Graph API and returns a normalized result; the caller
// (Phase 3's /verify route) decides what to do with it — it must call
// store.activateIntegration() itself, only after ok:true.
//
// fetchImpl is injectable so callers (and this module's own test suite) can
// run fully offline/deterministic — see tasks.md Phase 2.1.

const GRAPH_API_VERSION = 'v23.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Validate a Meta Cloud API access token + phone number id pair with a real,
 * lightweight Graph API GET (design.md validation table).
 *
 * @param {{accessToken: string, phoneNumberId: string, appSecret?: string, verifyToken?: string}} credentials
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, publicMeta?: object, error?: string, credentials?: object}>}
 */
async function validate({ accessToken, phoneNumberId, appSecret, verifyToken } = {}, { fetchImpl = fetch } = {}) {
  if (!accessToken) return { ok: false, error: 'accessToken is required' };
  if (!phoneNumberId) return { ok: false, error: 'phoneNumberId is required' };

  const url = `${GRAPH_API_BASE}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`;

  let response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    return { ok: false, error: `network error contacting Meta Graph API: ${err.message}` };
  }

  const body = await safeJson(response);

  if (!response.ok) {
    return { ok: false, error: body?.error?.message || `Meta Graph API returned HTTP ${response.status}` };
  }

  const credentials = { access_token: accessToken, phone_number_id: phoneNumberId };
  if (appSecret) credentials.app_secret = appSecret;
  if (verifyToken) credentials.verify_token = verifyToken;

  return {
    ok: true,
    publicMeta: {
      display_phone_number: body?.display_phone_number,
      verified_name: body?.verified_name,
    },
    credentials,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = { validate, GRAPH_API_VERSION, GRAPH_API_BASE };
