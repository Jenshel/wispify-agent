'use strict';
// src/brain/history.js — builds the Gemini-shaped conversation history array
// from src/db/conversations.js's bounded recentTurns log (PR15,
// conversation-memory follow-up).
//
// design.md's Module Boundaries already listed `src/brain/history.js`
// alongside index.js/prompt.js/gemini.js, and src/brain/index.js's own
// header comment (PR8) anticipated this exact filename as the "FUTURE
// HISTORY INJECTION POINT" once a real conversations table existed to draw
// from (src/db/conversations.js, PR12). Kept as a small pure function (no
// db/fetchImpl side effects) so this specific ordering/role-mapping logic
// is independently testable without booting a database or a webhook
// harness — this repo's own extract-before-mock convention.

/**
 * @param {Array<{role: 'user'|'bot', content: string, ts?: string}>} [recentTurns]
 * @returns {Array<{role: 'user'|'model', text: string}>}
 */
function buildHistory(recentTurns) {
  if (!Array.isArray(recentTurns) || recentTurns.length === 0) return [];
  // The LAST entry in recentTurns is always the CURRENT inbound message —
  // src/channels/whatsapp/webhook.js's handleIncomingMessage() already
  // calls conversations.recordClientMessage() BEFORE generateReply() runs,
  // so by the time this function runs that message is already the newest
  // row in recentTurns. It is handled separately as the live turn
  // (src/brain/gemini.js's own `text` param) — including it again here
  // would show the model the customer's current message twice.
  return recentTurns.slice(0, -1).map((turn) => ({
    role: turn.role === 'bot' ? 'model' : 'user',
    text: turn.content,
  }));
}

module.exports = { buildHistory };
