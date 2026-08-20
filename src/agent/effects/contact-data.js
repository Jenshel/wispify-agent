'use strict';
// src/agent/effects/contact-data.js — [DATOS_CONTACTO] effect handler
// (tasks.md Phase 7.4, wired to real persistence in PR17).
//
// The tag's raw bracket syntax is ALREADY stripped from the customer-visible
// reply unconditionally by src/agent/tags.js's stripTags() — that guarantee
// is independent of whatever happens here. This module's job is just:
// persist what the model captured onto the conversation record.
//
// Persists via src/db/conversations.js's setContactInfo() — same DI pattern
// (`db` in ctx) every other real effect handler in this directory already
// uses (see escalate.js). Closes the "FUTURE INJECTION POINT" this file
// itself documented since PR9: the `conversations` table has existed since
// PR12, there was nothing left blocking this.

const conversations = require('../../db/conversations');

/**
 * @param {{name: string, business: string, from: string}} payload
 * @param {{db?: import('better-sqlite3').Database}} [ctx]
 * @returns {Promise<{captured: boolean, persisted: boolean}>}
 */
async function captureContactData({ name, business, from } = {}, { db } = {}) {
  console.log(`[DATOS_CONTACTO] from=${from} nombre="${name || ''}" negocio="${business || ''}"`);

  if (!db || !from || (!name && !business)) {
    return { captured: true, persisted: false };
  }

  conversations.setContactInfo(db, from, { contactName: name, businessName: business });
  return { captured: true, persisted: true };
}

module.exports = { captureContactData };
