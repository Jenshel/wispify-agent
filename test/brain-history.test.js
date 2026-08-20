'use strict';
// RED->GREEN for src/brain/history.js (PR15, conversation-memory follow-up).
//
// design.md's Module Boundaries already listed `src/brain/history.js`
// alongside index.js/prompt.js/gemini.js, and src/brain/index.js's own
// header comment (PR8) anticipated this exact filename as the "FUTURE
// HISTORY INJECTION POINT" once src/db/conversations.js (PR12) gave this
// repo a real per-conversation recent-turns log to draw from. Kept as a
// small pure function (no db/fetchImpl) so this specific ordering/role-
// mapping logic is independently testable without booting a database or a
// webhook harness.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHistory } = require('../src/brain/history');

test('buildHistory() returns an empty array for an empty recentTurns log', () => {
  assert.deepEqual(buildHistory([]), []);
});

test('buildHistory() excludes the LAST entry (the current live turn) and maps role bot->model', () => {
  const recentTurns = [
    { role: 'user', content: 'Hola', ts: '2026-01-01T00:00:00.000Z' },
    { role: 'bot', content: '¡Hola! ¿En qué te ayudo?', ts: '2026-01-01T00:00:01.000Z' },
    { role: 'user', content: 'quiero info', ts: '2026-01-01T00:00:02.000Z' }, // current live turn
  ];
  const history = buildHistory(recentTurns);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { role: 'user', text: 'Hola' });
  assert.deepEqual(history[1], { role: 'model', text: '¡Hola! ¿En qué te ayudo?' });
});

test('buildHistory() returns an empty array when recentTurns has only the current turn (first-ever message)', () => {
  const recentTurns = [{ role: 'user', content: 'primer mensaje', ts: '2026-01-01T00:00:00.000Z' }];
  assert.deepEqual(buildHistory(recentTurns), []);
});

test('buildHistory() preserves chronological order and maps EVERY prior turn, not just the first/last', () => {
  const recentTurns = [
    { role: 'user', content: 'a' },
    { role: 'bot', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'bot', content: 'd' },
    { role: 'user', content: 'e' }, // current live turn — excluded
  ];
  const history = buildHistory(recentTurns);
  assert.deepEqual(history.map((h) => h.text), ['a', 'b', 'c', 'd']);
  assert.deepEqual(history.map((h) => h.role), ['user', 'model', 'user', 'model']);
});

test('buildHistory() treats a missing/undefined recentTurns as empty, without throwing', () => {
  assert.doesNotThrow(() => buildHistory(undefined));
  assert.deepEqual(buildHistory(undefined), []);
});
