'use strict';
// src/config/capabilities.js — derived feature gates (design.md "Capability
// Gating: never promise what isn't wired").
//
// capabilities() = { chat: meta&&gemini active, scheduling: google_calendar
// active&&enabled, payments: stripe active&&enabled }. This is the DATA half
// of the two-layer enforcement design describes:
//   1. Prevention — brain/prompt.js (Phase 6) reads this to decide what the
//      AI is allowed to promise.
//   2. Enforcement — agent/pipeline.js (Phase 7) drops any tag whose
//      capability is off, regardless of what the model said.
// This module only computes the flags; it never touches Express or a
// provider, and it never decrypts a credential (store.js's public read shape
// — enabled + status — is all a capability check ever needs).

const store = require('./store');

function isActive(row) {
  return !!row && !!row.enabled && row.status === 'active';
}

/**
 * Pure function: given a map of integration id -> { enabled, status }
 * (the shape store.getIntegrationPublic()/listIntegrationsPublic() return),
 * compute the capability flags. Missing keys are treated as inactive.
 */
function deriveCapabilities(rowsById) {
  return {
    chat: isActive(rowsById.meta) && isActive(rowsById.gemini),
    scheduling: isActive(rowsById.google_calendar),
    payments: isActive(rowsById.stripe),
  };
}

/** Compute the current capability gates from a db instance's integrations table. */
function capabilities(db) {
  const rows = store.listIntegrationsPublic(db);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  return deriveCapabilities(byId);
}

/** Convenience single-integration gate check, e.g. isIntegrationActive(db, 'google_calendar'). */
function isIntegrationActive(db, id) {
  return isActive(store.getIntegrationPublic(db, id));
}

module.exports = { deriveCapabilities, capabilities, isIntegrationActive };
