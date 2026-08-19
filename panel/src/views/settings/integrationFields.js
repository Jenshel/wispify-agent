// panel/src/views/settings/integrationFields.js — pure config describing
// each integration's guided-setup form. Field `name`s match exactly what
// each backend adapter's validate() destructures (src/integrations/*.js),
// since IntegrationCard POSTs the form object verbatim as the /verify
// request body — see panel/test/integrationFields.test.js.
//
// GEMINI_MODELS mirrors the curated list in src/integrations/gemini.js.
// panel/ and the backend are separate module trees (design.md keeps them
// that way — no shared package), so this is a deliberate, documented
// duplicate: keep both lists in sync when Google ships/retires model ids.
// spec: "Gemini model MUST NOT accept free-text model identifiers" — hence
// `type: 'select'` with a fixed `options` list, never a text input.

export const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

export const INTEGRATION_ORDER = ['meta', 'gemini', 'google_calendar', 'stripe'];

export const INTEGRATION_META = {
  meta: {
    label: 'Meta WhatsApp Cloud API',
    fields: [
      { name: 'accessToken', label: 'Access Token', type: 'password', required: true },
      { name: 'phoneNumberId', label: 'Phone Number ID', type: 'text', required: true },
      { name: 'appSecret', label: 'App Secret', type: 'password', required: false },
      { name: 'verifyToken', label: 'Verify Token', type: 'text', required: false },
    ],
  },
  gemini: {
    label: 'Google Gemini',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true },
      { name: 'model', label: 'Model', type: 'select', options: GEMINI_MODELS, required: true },
    ],
  },
  google_calendar: {
    label: 'Google Calendar',
    oauth: true,
  },
  stripe: {
    label: 'Stripe',
    fields: [{ name: 'secretKey', label: 'Secret Key', type: 'password', required: true }],
  },
};

/** Backend refuses to enable unless status==='active' (src/config/store.js setIntegrationEnabled) — mirror that here so the toggle is disabled before the round-trip, not just after a 409. */
export function canEnableIntegration(status) {
  return status === 'active';
}

export function statusLabel(status) {
  if (status === 'active') return 'Active';
  if (status === 'error') return 'Error';
  return 'Not configured';
}
