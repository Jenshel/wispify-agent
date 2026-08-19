'use strict';
// RED->GREEN for src/media/store.js (tasks.md Phase 5.4/5.5 — media-exchange).
//
// threat-matrix (d): path-segment sanitization for phone/product-derived
// filenames. Ported from WhiteLabel_WA_System's routes/files.js safeName()
// — path.basename() strips ANY directory component no matter how it's
// encoded (Express 5 decodes %2F to a literal "/" inside a single route
// param; this is what actually neutralizes traversal), plus context.js's
// regex-based phone sanitizer as a second, belt-and-suspenders layer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mediaStore = require('../src/media/store');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wispify-media-test-'));
}

// ── safeName() ───────────────────────────────────────────────────────────

test('safeName() strips directory components via path.basename()', () => {
  assert.equal(mediaStore.safeName('photo.jpg'), 'photo.jpg');
  assert.equal(mediaStore.safeName('../../etc/passwd'), 'passwd');
  assert.equal(mediaStore.safeName('a/b/c.jpg'), 'c.jpg');
});

test('safeName() rejects empty, ".", and ".." segments', () => {
  assert.throws(() => mediaStore.safeName(''), /invalid path segment/);
  assert.throws(() => mediaStore.safeName('.'), /invalid path segment/);
  assert.throws(() => mediaStore.safeName('..'), /invalid path segment/);
  assert.throws(() => mediaStore.safeName(undefined), /invalid path segment/);
  assert.throws(() => mediaStore.safeName(null), /invalid path segment/);
});

// ── safePhoneSegment() ───────────────────────────────────────────────────

test('safePhoneSegment() allows a normal WhatsApp phone/jid', () => {
  assert.equal(mediaStore.safePhoneSegment('5214426249375'), '5214426249375');
  assert.equal(mediaStore.safePhoneSegment('5214426249375@c.us'), '5214426249375@c.us');
});

test('safePhoneSegment() neutralizes traversal attempts without throwing on a still-safe result', () => {
  // Slashes are stripped/replaced before basename ever sees them, so the
  // result is a single opaque path segment — even though it may still
  // contain literal "." characters, it can never itself be interpreted as
  // a directory separator or a ".."-style parent reference once joined.
  const result = mediaStore.safePhoneSegment('../../etc/passwd');
  assert.equal(result.includes('/'), false);
  assert.equal(result.includes('\\'), false);

  const dataDir = tmpDataDir();
  const joined = path.join(dataDir, 'client-media', result);
  const root = path.join(dataDir, 'client-media');
  assert.equal(joined.startsWith(root + path.sep), true);
});

test('safePhoneSegment() rejects a phone that reduces to exactly ".."', () => {
  assert.throws(() => mediaStore.safePhoneSegment('..'), /invalid path segment/);
});

// ── saveClientMedia() + resolveClientMediaPath() round-trip ────────────

test('saveClientMedia() writes the buffer under data/client-media/<safePhone>/ and returns a safe filename', () => {
  const dataDir = tmpDataDir();
  const buf = Buffer.from('fake-image-bytes');
  const saved = mediaStore.saveClientMedia(dataDir, '5214426249375', buf, 'image/jpeg');

  assert.match(saved.filename, /^\d+\.jpeg$/);
  assert.equal(saved.phoneSegment, '5214426249375');

  const onDisk = fs.readFileSync(path.join(dataDir, 'client-media', '5214426249375', saved.filename));
  assert.deepEqual(onDisk, buf);
});

test('saveClientMedia() derives a safe extension even from a weird mime type', () => {
  const dataDir = tmpDataDir();
  const saved = mediaStore.saveClientMedia(dataDir, '521', Buffer.from('x'), 'audio/ogg; codecs=opus');
  assert.match(saved.filename, /^\d+\.ogg$/);
});

test('resolveClientMediaPath() resolves a previously-saved file back to the same absolute path', () => {
  const dataDir = tmpDataDir();
  const buf = Buffer.from('hello');
  const saved = mediaStore.saveClientMedia(dataDir, '5214426249375', buf, 'image/png');

  const resolved = mediaStore.resolveClientMediaPath(dataDir, '5214426249375', saved.filename);
  assert.equal(fs.readFileSync(resolved).toString(), 'hello');
});

test('resolveClientMediaPath() reduces a path-traversal filename to a safe basename, never escaping the root', () => {
  const dataDir = tmpDataDir();
  const resolved = mediaStore.resolveClientMediaPath(dataDir, '521', '../../../etc/passwd');
  const root = path.join(dataDir, 'client-media');
  assert.equal(resolved.startsWith(root + path.sep), true);
  assert.equal(path.basename(resolved), 'passwd');
});

test('resolveClientMediaPath() throws (never touches fs) when the filename reduces to exactly ".."', () => {
  const dataDir = tmpDataDir();
  assert.throws(() => mediaStore.resolveClientMediaPath(dataDir, '521', '..'));
});

test('resolveClientMediaPath() never escapes the client-media root even with an encoded-looking traversal filename', () => {
  const dataDir = tmpDataDir();
  // Simulates Express 5 decoding %2F to a literal "/" inside a single
  // :filename route param — the exact bug class fixed in the source system.
  const resolved = mediaStore.resolveClientMediaPath(dataDir, '521', '..%2F..%2F..%2Fetc%2Fpasswd');
  const root = path.join(dataDir, 'client-media');
  assert.equal(resolved.startsWith(root + path.sep) || resolved === root, true);
});

test('resolveClientMediaPath() rejects a phone segment that is exactly ".."', () => {
  const dataDir = tmpDataDir();
  assert.throws(() => mediaStore.resolveClientMediaPath(dataDir, '..', 'file.jpg'));
});
