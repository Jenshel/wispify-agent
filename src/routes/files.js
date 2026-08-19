'use strict';
// src/routes/files.js — authenticated media serving (tasks.md Phase 5.5,
// spec.md "Authenticated Media Serving" requirement).
//
// GET /api/media/client/:phone/:filename — an image/audio the customer sent
// over WhatsApp, saved to disk by src/channels/whatsapp/webhook.js. Only an
// authenticated admin session may read it back (so the panel's future
// ChatView — Phase 11 — has something correct to build on).
//
// Mono-tenant: no slotId anywhere. Threat-matrix (d): every
// attacker-controlled path segment (:phone, :filename) goes through
// src/media/store.js's path.basename()-based sanitization before ever
// touching fs — this is the exact fix (not just the feature) for the
// Express 5 `%2F`-decodes-to-a-literal-"/" route-param bug, a confirmed,
// fixed critical vulnerability in WhiteLabel_WA_System's routes/files.js.

const express = require('express');
const fs = require('fs');

const { requireAuth } = require('../auth/middleware');
const mediaStore = require('../media/store');

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{dataDir?: string}} [opts]
 */
function createFilesRouter(db, { dataDir = mediaStore.DEFAULT_DATA_DIR } = {}) {
  const router = express.Router();
  const requireAuthMw = requireAuth(db);

  router.get('/media/client/:phone/:filename', requireAuthMw, (req, res) => {
    let filePath;
    try {
      filePath = mediaStore.resolveClientMediaPath(dataDir, req.params.phone, req.params.filename);
    } catch {
      return res.status(400).json({ error: 'invalid_path' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.sendFile(filePath);
  });

  return router;
}

module.exports = createFilesRouter;
