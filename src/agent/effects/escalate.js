'use strict';
// src/agent/effects/escalate.js — [ESCALAR_HUMANO:reason] effect handler
// (tasks.md Phase 7.4).
//
// One of the two effects the PR9 scope note calls out as needing "no other
// phase's tables": always logs the escalation (grep-able ops signal), and
// additionally sends a WhatsApp notification to app_config.adminPhone when
// both an admin phone AND active meta credentials are configured — reusing
// src/channels/whatsapp/client.js's sendText(), not a new Graph API call
// shape.
//
// Deliberate simplification vs. the source system's notifyAdmin(): the
// source only sent within a 24h window if the admin's OWN conversation
// record showed recent activity — that check read a `conversations` table
// this repo doesn't have yet. This version sends unconditionally whenever
// configured; a future phase that builds `conversations` can reintroduce
// the window check without changing this function's signature.

const store = require('../../config/store');
const client = require('../../channels/whatsapp/client');

/**
 * @param {{reason: string, from: string}} payload
 * @param {{db?: import('better-sqlite3').Database, fetchImpl?: typeof fetch}} [ctx]
 * @returns {Promise<{notified: boolean}>}
 */
async function escalateHuman({ reason, from } = {}, { db, fetchImpl } = {}) {
  console.warn(`[ESCALAR_HUMANO] from=${from} reason="${reason || ''}"`);

  if (!db) return { notified: false };

  try {
    const appConfig = store.getAppConfig(db);
    const metaCreds = store.getIntegrationCredentials(db, 'meta');
    if (!appConfig?.adminPhone || !metaCreds?.access_token) {
      return { notified: false };
    }

    const message = `Escalado a atencion manual: ${from} - motivo: ${reason || 'sin especificar'}`;
    const result = await client.sendText(metaCreds, { to: appConfig.adminPhone, text: message }, { fetchImpl });
    return { notified: !!result };
  } catch (err) {
    console.error('[ESCALAR_HUMANO] admin notification failed:', err.message);
    return { notified: false };
  }
}

module.exports = { escalateHuman };
