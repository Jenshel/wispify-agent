'use strict';
// src/config/secrets.js — AES-256-GCM seal/open for credentials at rest.
//
// Key resolution (design.md "Config & Credential Storage"): CONFIG_ENCRYPTION_KEY
// env var takes precedence; otherwise a key is auto-generated on first use and
// persisted to data/.keyfile with 0600 perms. That path is already covered by
// PR1's .gitignore (`*.keyfile`, `data/`) and gitignore test, so nothing here
// can ever end up committed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM's recommended nonce size
const KEY_LENGTH = 32; // 256 bits

const DEFAULT_KEYFILE = path.join(__dirname, '..', '..', 'data', '.keyfile');

/**
 * Resolve the 32-byte encryption key. Precedence: CONFIG_ENCRYPTION_KEY env
 * var (64-char hex) > an existing keyfile > a freshly generated + persisted
 * keyfile. `keyfilePath` is overridable so tests never touch the real
 * `data/.keyfile`.
 */
function resolveKey({ keyfilePath = DEFAULT_KEYFILE } = {}) {
  const envKey = process.env.CONFIG_ENCRYPTION_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length !== KEY_LENGTH || !/^[0-9a-fA-F]+$/.test(envKey)) {
      throw new Error(
        `CONFIG_ENCRYPTION_KEY must be a ${KEY_LENGTH * 2}-char hex string (${KEY_LENGTH} bytes), got ${envKey.length} chars`
      );
    }
    return buf;
  }

  const dir = path.dirname(keyfilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(keyfilePath)) {
    const hex = fs.readFileSync(keyfilePath, 'utf8').trim();
    return Buffer.from(hex, 'hex');
  }

  const key = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(keyfilePath, key.toString('hex'), { mode: 0o600 });
  fs.chmodSync(keyfilePath, 0o600); // belt-and-suspenders against umask/platform quirks
  console.warn(`[config/secrets] CONFIG_ENCRYPTION_KEY not set — generated a new key at ${keyfilePath}`);
  return key;
}

/**
 * Encrypt plaintext into a self-describing envelope:
 * base64(iv):base64(authTag):base64(ciphertext). IV + auth tag travel with
 * the ciphertext so any later open() call is independently verifiable
 * without external state (the process that opens it may not be the one that
 * sealed it).
 */
function seal(plaintext, opts = {}) {
  const key = opts.key || resolveKey(opts);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypt an envelope produced by seal(). Throws if malformed or if the auth
 * tag fails to verify (tampered/corrupted ciphertext, or wrong key).
 */
function open(envelope, opts = {}) {
  const key = opts.key || resolveKey(opts);
  const parts = String(envelope).split(':');
  if (parts.length !== 3) throw new Error('malformed credential envelope');
  const [ivB64, tagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Convenience: seal/open a JSON-serializable value directly. */
function sealJSON(value, opts) {
  return seal(JSON.stringify(value), opts);
}
function openJSON(envelope, opts) {
  return JSON.parse(open(envelope, opts));
}

module.exports = { seal, open, sealJSON, openJSON, resolveKey, DEFAULT_KEYFILE, ALGORITHM };
