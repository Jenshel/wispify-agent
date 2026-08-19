'use strict';
// src/media/store.js — safe on-disk storage for client-sent media
// (images/audio) and safe path resolution for serving it back
// (tasks.md Phase 5.4/5.5, spec.md media-exchange domain).
//
// Threat-matrix (d): a filename/phone-derived path segment that comes from
// a route param MUST go through path.basename()-based sanitization before
// ever touching the filesystem — no exceptions. This is a direct, literal
// port of the fix (not just the feature) from WhiteLabel_WA_System's
// routes/files.js safeName(): path.basename() strips ANY directory
// component no matter how it was encoded, which is what actually
// neutralizes traversal (Express 5 decodes %2F to a literal "/" inside a
// single route param — a confirmed, fixed critical vulnerability class in
// the source system). The regex-based safePhoneSegment() below is a second,
// belt-and-suspenders layer on top, matching context.js's precedent.
//
// Mono-tenant: no slotId anywhere — files live under data/client-media/,
// not data/slot_N/client-media/.

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CLIENT_MEDIA_SUBDIR = 'client-media';

/**
 * path.basename() strips ANY directory component no matter how it's
 * encoded. Throws on empty/'.'/'..' so a sanitized segment can never
 * resolve to "the directory itself" or its parent.
 */
function safeName(x) {
  const n = path.basename(String(x ?? ''));
  if (!n || n === '.' || n === '..') {
    throw new Error(`invalid path segment: ${JSON.stringify(x)}`);
  }
  return n;
}

/**
 * Belt-and-suspenders: phone numbers/jids are further restricted to a safe
 * charset before also being run through safeName() — matches the pattern
 * routes/webhook.js used for timeline filenames in the source system.
 */
function safePhoneSegment(phone) {
  const stripped = String(phone ?? '').replace(/[^a-zA-Z0-9@._-]/g, '_');
  return safeName(stripped);
}

function clientMediaRoot(dataDir) {
  return path.join(dataDir, CLIENT_MEDIA_SUBDIR);
}

function clientMediaDir(dataDir, phone) {
  const dir = path.join(clientMediaRoot(dataDir), safePhoneSegment(phone));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist a downloaded media buffer for `phone`. Returns the stored
 * filename and the sanitized phone segment, ready to embed in an
 * authenticated serving URL (see src/routes/files.js).
 */
function saveClientMedia(dataDir, phone, buffer, mimeType) {
  const rawExt = String(mimeType || '').split('/')[1] || 'bin';
  const ext = (rawExt.split(';')[0] || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  const filename = `${Date.now()}.${ext}`;
  const dir = clientMediaDir(dataDir, phone);
  fs.writeFileSync(path.join(dir, filename), buffer);
  return { filename, phoneSegment: safePhoneSegment(phone) };
}

/**
 * Resolve the absolute path for a previously-stored file, given the raw
 * (attacker-controlled) route params. Throws on any invalid/traversal
 * attempt instead of ever touching fs with an unsanitized segment — callers
 * must catch and respond 400, never let this bubble into a 500 with a
 * stack trace.
 */
function resolveClientMediaPath(dataDir, phone, filename) {
  const safePhone = safePhoneSegment(phone);
  const safeFilename = safeName(filename);
  return path.join(clientMediaRoot(dataDir), safePhone, safeFilename);
}

module.exports = {
  DEFAULT_DATA_DIR,
  CLIENT_MEDIA_SUBDIR,
  safeName,
  safePhoneSegment,
  clientMediaDir,
  saveClientMedia,
  resolveClientMediaPath,
};
