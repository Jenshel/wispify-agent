'use strict';
// src/agent/effects/contact-data.js — [DATOS_CONTACTO] effect handler
// (tasks.md Phase 7.4).
//
// The other effect the PR9 scope note calls "needing no other phase's
// tables" — but only because this phase's job for it is narrow: the tag's
// body is ALREADY stripped from the customer-visible reply unconditionally
// by src/agent/tags.js's stripTags() (that's the part of the spec's
// requirement this repo can satisfy today). Actually PERSISTING the
// captured name/business onto a conversation record — like the source
// system's contactName/businessName conversation fields — needs the
// `conversations` table, which does not exist yet (schema.sql defers it;
// see src/brain/index.js's own FUTURE HISTORY INJECTION POINT note for the
// precedent on how a future phase should thread `db` through here once that
// table lands).
//
// FUTURE INJECTION POINT: once `conversations` exists, this function should
// take `db` in its ctx (same DI pattern as escalate.js) and UPSERT
// {contactName, businessName} onto the row keyed by `from`, exactly
// mirroring the source's updateConversation() contactMatch handling.

/**
 * @param {{name: string, business: string, from: string}} payload
 * @returns {Promise<{captured: boolean}>}
 */
async function captureContactData({ name, business, from } = {}) {
  console.log(`[DATOS_CONTACTO] from=${from} nombre="${name || ''}" negocio="${business || ''}"`);
  return { captured: true };
}

module.exports = { captureContactData };
