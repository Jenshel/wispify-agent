'use strict';
// src/config/store.js — app_config + integrations accessors.
//
// This module is dumb, integration-agnostic storage: it never calls a
// provider and never decides whether a credential is valid (design.md
// module boundary: "integrations/* never touch Express; routes/settings.js
// never talks to a provider directly"). Phase 2/3's /verify route is the
// only caller of activateIntegration() — it must already have gotten a real
// 2xx from the provider before calling it. store.js just persists what it's
// told is already proven.
//
// Every accessor takes `db` explicitly (no hidden singleton) so tests always
// run against an isolated `:memory:` database — see test/config-store.test.js.

const secrets = require('./secrets');

const INTEGRATION_IDS = ['meta', 'gemini', 'google_calendar', 'stripe'];

const APP_CONFIG_FIELD_MAP = {
  businessName: 'business_name',
  greeting: 'greeting',
  context: 'context',
  personality: 'personality',
  personalityCustom: 'personality_custom',
  currency: 'currency',
  timezone: 'timezone',
  adminPhone: 'admin_phone',
  soulDocs: 'soul_docs',
  botPaused: 'bot_paused',
};

// Free-text fields that flow straight into the future AI system prompt
// (design.md buildSystemPrompt(business, catalog, soulDocs, capabilities);
// mirrors the source system's config.context / config.personalityCustom /
// soul-docs rules text). This is the OWNER's own bot config, not user input,
// so no injection-style validation applies here — but an unbounded paste
// must not be able to create a pathological DB row, so a generous max-length
// guard is enforced before any write.
const MAX_LONG_TEXT_LENGTH = 20_000;
const LONG_TEXT_FIELDS = ['context', 'personalityCustom', 'soulDocs'];

function assertAppConfigPatchWithinLimits(patch) {
  for (const camel of LONG_TEXT_FIELDS) {
    const value = patch[camel];
    if (typeof value === 'string' && value.length > MAX_LONG_TEXT_LENGTH) {
      throw new Error(
        `${camel} exceeds maximum length of ${MAX_LONG_TEXT_LENGTH} characters (got ${value.length})`
      );
    }
  }
}

function toCamelConfig(row) {
  return {
    businessName: row.business_name,
    greeting: row.greeting,
    context: row.context,
    personality: row.personality,
    personalityCustom: row.personality_custom,
    currency: row.currency,
    timezone: row.timezone,
    adminPhone: row.admin_phone,
    soulDocs: row.soul_docs,
    botPaused: !!row.bot_paused,
    updatedAt: row.updated_at,
  };
}

/** Read the single app_config row (always exists — seeded by schema.sql). */
function getAppConfig(db) {
  return toCamelConfig(db.prepare('SELECT * FROM app_config WHERE id = 1').get());
}

/**
 * Merge `patch` (any subset of APP_CONFIG_FIELD_MAP's camelCase keys) onto
 * the current row and persist. Unknown keys are ignored. Read-then-write
 * happens in one synchronous call — no `await` gap, so no lock is needed
 * (see src/db/index.js header comment).
 */
function updateAppConfig(db, patch) {
  assertAppConfigPatchWithinLimits(patch);
  const current = db.prepare('SELECT * FROM app_config WHERE id = 1').get();
  const next = { ...current };
  for (const [camel, column] of Object.entries(APP_CONFIG_FIELD_MAP)) {
    if (camel in patch) {
      next[column] = camel === 'botPaused' ? (patch[camel] ? 1 : 0) : patch[camel];
    }
  }
  db.prepare(
    `UPDATE app_config SET
       business_name = @business_name, greeting = @greeting, context = @context,
       personality = @personality, personality_custom = @personality_custom,
       currency = @currency, timezone = @timezone, admin_phone = @admin_phone,
       soul_docs = @soul_docs, bot_paused = @bot_paused,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = 1`
  ).run(next);
  return getAppConfig(db);
}

function assertKnownIntegration(id) {
  if (!INTEGRATION_IDS.includes(id)) {
    throw new Error(`unknown integration id: ${JSON.stringify(id)} (expected one of ${INTEGRATION_IDS.join(', ')})`);
  }
}

/**
 * Raw row, including the sealed `credentials` ciphertext. Internal use only
 * — never return this (or anything derived from `.credentials`) from an HTTP
 * response. Use getIntegrationPublic()/listIntegrationsPublic() for that.
 */
function getIntegrationRow(db, id) {
  assertKnownIntegration(id);
  return db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
}

/**
 * Public read shape: status + non-secret publicMeta only, never credentials.
 * A masked hint (e.g. "sk_live_••••1234"), if the caller wants one shown in
 * the setup screen, travels inside publicMeta — computed once by whichever
 * caller persisted the credential (activateIntegration), never derived here
 * from the ciphertext.
 */
function toPublicIntegration(row) {
  return {
    id: row.id,
    enabled: !!row.enabled,
    status: row.status,
    publicMeta: row.public_meta ? JSON.parse(row.public_meta) : null,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
  };
}

function getIntegrationPublic(db, id) {
  return toPublicIntegration(getIntegrationRow(db, id));
}

function listIntegrationsPublic(db) {
  return db.prepare('SELECT * FROM integrations ORDER BY id').all().map(toPublicIntegration);
}

/**
 * Decrypt and return this integration's credentials as a plain object, or
 * null if none are stored yet. Internal use only (Phase 2 adapters, webhook
 * HMAC verification) — never call this from a route handler that returns
 * its result to the client.
 */
function getIntegrationCredentials(db, id) {
  const row = getIntegrationRow(db, id);
  if (!row.credentials) return null;
  return secrets.openJSON(row.credentials);
}

/**
 * Persist a VALIDATED credential set and mark the integration active. The
 * caller must already have called the provider's live validate() and gotten
 * a success — this function never validates anything itself.
 */
function activateIntegration(db, id, { credentials, publicMeta } = {}) {
  assertKnownIntegration(id);
  const sealed = secrets.sealJSON(credentials || {});
  db.prepare(
    `UPDATE integrations SET
       credentials = @credentials, public_meta = @publicMeta, status = 'active',
       last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = NULL
     WHERE id = @id`
  ).run({ id, credentials: sealed, publicMeta: publicMeta ? JSON.stringify(publicMeta) : null });
  return getIntegrationPublic(db, id);
}

/** Record a failed validation attempt without touching any previously-persisted credential. */
function setIntegrationError(db, id, message) {
  assertKnownIntegration(id);
  db.prepare(
    `UPDATE integrations SET
       status = 'error', last_error = @message,
       last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = @id`
  ).run({ id, message: String(message || '') });
  return getIntegrationPublic(db, id);
}

/**
 * Enable/disable a previously-activated integration. Refuses to enable
 * unless status is already 'active' (design.md: "PATCH refuses to enable
 * unless status='active'"). Disabling is always allowed.
 */
function setIntegrationEnabled(db, id, enabled) {
  assertKnownIntegration(id);
  if (enabled) {
    const row = getIntegrationRow(db, id);
    if (row.status !== 'active') {
      throw new Error(`cannot enable integration "${id}": status is "${row.status}", not "active"`);
    }
  }
  db.prepare('UPDATE integrations SET enabled = @enabled WHERE id = @id').run({
    id,
    enabled: enabled ? 1 : 0,
  });
  return getIntegrationPublic(db, id);
}

// ── DB > .env seed-once precedence ──────────────────────────────────────────
// Headless/Docker deploys can pre-fill credentials via `.env` so the bot
// doesn't strictly need a human to visit the setup screen first. Seeding
// NEVER overwrites a DB-held credential (DB always wins) and never marks the
// integration active — it only lifts data-layer state from "no credential on
// file" to "an unvalidated credential is on file". Actually validating those
// seeded credentials at boot is wired up once the provider adapters exist
// (Phase 2+), not here.
const ENV_SEED_FIELDS = {
  meta: {
    access_token: 'META_ACCESS_TOKEN',
    phone_number_id: 'META_PHONE_NUMBER_ID',
    app_secret: 'META_APP_SECRET',
    verify_token: 'META_VERIFY_TOKEN',
  },
  gemini: { api_key: 'GEMINI_API_KEY', model: 'GEMINI_MODEL' },
  stripe: { secret_key: 'STRIPE_SECRET_KEY', webhook_secret: 'STRIPE_WEBHOOK_SECRET' },
  // google_calendar is deliberately absent: it's OAuth-consent based, there is
  // no user secret to lift from env — only the app's own client id/secret.
};

function readEnvCredentials(id, env) {
  const fields = ENV_SEED_FIELDS[id];
  if (!fields) return null;
  const creds = {};
  for (const [credKey, envVar] of Object.entries(fields)) {
    if (env[envVar]) creds[credKey] = env[envVar];
  }
  return Object.keys(creds).length ? creds : null;
}

/**
 * Seed any integration that has no DB credential yet from matching `.env`
 * vars. Returns the list of integration ids actually seeded.
 */
function seedIntegrationsFromEnv(db, env = process.env) {
  const seeded = [];
  for (const id of Object.keys(ENV_SEED_FIELDS)) {
    const row = getIntegrationRow(db, id);
    if (row.credentials) continue; // DB already has a credential — DB wins, never overwrite
    const creds = readEnvCredentials(id, env);
    if (!creds) continue;
    db.prepare('UPDATE integrations SET credentials = @credentials WHERE id = @id').run({
      id,
      credentials: secrets.sealJSON(creds),
    });
    seeded.push(id);
  }
  return seeded;
}

module.exports = {
  INTEGRATION_IDS,
  MAX_LONG_TEXT_LENGTH,
  getAppConfig,
  updateAppConfig,
  getIntegrationRow,
  getIntegrationPublic,
  listIntegrationsPublic,
  getIntegrationCredentials,
  activateIntegration,
  setIntegrationError,
  setIntegrationEnabled,
  seedIntegrationsFromEnv,
  readEnvCredentials,
};
