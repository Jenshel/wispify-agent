'use strict';
// src/routes/conversations.js — panel ChatView backend (tasks.md Phase
// 11.1, gap #1: "No REST API to list/read/mutate conversations exists at
// all"). Same admin-session-only pattern as src/routes/settings.js/
// files.js — every endpoint requires requireAuth. Reads/writes go through
// src/db/conversations.js accessors only; no raw SQL in this file.

const express = require('express');

const { requireAuth } = require('../auth/middleware');
const conversations = require('../db/conversations');

/** @param {import('better-sqlite3').Database} db */
function createConversationsRouter(db) {
  const router = express.Router();
  const requireAuthMw = requireAuth(db);

  // GET /api/conversations?archived=1 — list, pinned-first then
  // most-recent activity (src/db/conversations.js listConversations()),
  // archived excluded unless ?archived=1.
  router.get('/conversations', requireAuthMw, (req, res) => {
    const includeArchived = req.query.archived === '1';
    res.json(conversations.listConversations(db, { includeArchived }));
  });

  // GET /api/conversations/:phone — single conversation detail, including
  // the full bounded recentTurns log the thread view renders.
  router.get('/conversations/:phone', requireAuthMw, (req, res) => {
    const conv = conversations.getConversation(db, req.params.phone);
    if (!conv) return res.status(404).json({ error: 'not_found' });
    res.json(conv);
  });

  // PATCH /api/conversations/:phone {pinned?, archived?, markRead?} —
  // partial update, same shape convention as PATCH /api/settings/app-config
  // (any subset of known fields; unknown fields are ignored).
  router.patch('/conversations/:phone', requireAuthMw, (req, res) => {
    const { phone } = req.params;
    const { pinned, archived, markRead } = req.body || {};

    if (pinned === undefined && archived === undefined && markRead === undefined) {
      return res.status(400).json({ error: 'no_recognized_fields — expected any of pinned, archived, markRead' });
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }
    if (archived !== undefined && typeof archived !== 'boolean') {
      return res.status(400).json({ error: 'archived must be a boolean' });
    }

    let conv = conversations.getConversation(db, phone);
    if (!conv) return res.status(404).json({ error: 'not_found' });

    if (pinned !== undefined) conv = conversations.setPinned(db, phone, pinned);
    if (archived !== undefined) conv = conversations.setArchived(db, phone, archived);
    if (markRead) conv = conversations.markRead(db, phone);

    res.json(conv);
  });

  return router;
}

module.exports = createConversationsRouter;
