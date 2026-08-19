'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../src/config/secrets');

function tmpKeyfilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispify-secrets-test-'));
  return path.join(dir, '.keyfile');
}

test('seal() then open() round-trips a plaintext string with an explicit key', () => {
  const key = require('node:crypto').randomBytes(32);
  const envelope = secrets.seal('super-secret-token', { key });
  assert.notEqual(envelope, 'super-secret-token');
  assert.equal(secrets.open(envelope, { key }), 'super-secret-token');
});

test('sealJSON()/openJSON() round-trips an object', () => {
  const key = require('node:crypto').randomBytes(32);
  const creds = { access_token: 'abc123', phone_number_id: '999' };
  const envelope = secrets.sealJSON(creds, { key });
  assert.deepEqual(secrets.openJSON(envelope, { key }), creds);
});

test('seal() output never contains the plaintext substring', () => {
  const key = require('node:crypto').randomBytes(32);
  const envelope = secrets.seal('sk_live_totallyRealSecretValue', { key });
  assert.equal(envelope.includes('sk_live_totallyRealSecretValue'), false);
});

test('two seal() calls on the same plaintext produce different ciphertext (random IV)', () => {
  const key = require('node:crypto').randomBytes(32);
  const a = secrets.seal('same-value', { key });
  const b = secrets.seal('same-value', { key });
  assert.notEqual(a, b);
  // but both still open back to the same plaintext
  assert.equal(secrets.open(a, { key }), 'same-value');
  assert.equal(secrets.open(b, { key }), 'same-value');
});

test('open() throws on a tampered envelope (auth tag verification fails)', () => {
  const key = require('node:crypto').randomBytes(32);
  const envelope = secrets.seal('do-not-tamper-with-me', { key });
  const parts = envelope.split(':');
  // Flip one bit in an actual ciphertext byte (decode -> mutate -> re-encode)
  // rather than editing the base64 text directly, so the corruption can
  // never accidentally land on padding ('=') and silently no-op.
  const ciphertext = Buffer.from(parts[2], 'base64');
  ciphertext[0] ^= 0xff;
  const tampered = [parts[0], parts[1], ciphertext.toString('base64')].join(':');
  assert.throws(() => secrets.open(tampered, { key }));
});

test('open() throws when given the wrong key', () => {
  const keyA = require('node:crypto').randomBytes(32);
  const keyB = require('node:crypto').randomBytes(32);
  const envelope = secrets.seal('wrong-key-test', { key: keyA });
  assert.throws(() => secrets.open(envelope, { key: keyB }));
});

test('resolveKey() prefers CONFIG_ENCRYPTION_KEY env var when set', () => {
  const hexKey = require('node:crypto').randomBytes(32).toString('hex');
  const prev = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = hexKey;
  try {
    const key = secrets.resolveKey();
    assert.equal(key.toString('hex'), hexKey);
  } finally {
    if (prev === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = prev;
  }
});

test('resolveKey() rejects a malformed CONFIG_ENCRYPTION_KEY (wrong length)', () => {
  const prev = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = 'not-a-valid-hex-key';
  try {
    assert.throws(() => secrets.resolveKey());
  } finally {
    if (prev === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = prev;
  }
});

test('resolveKey() auto-generates data/.keyfile with 0600 perms when no env var and no file exists', () => {
  const prev = process.env.CONFIG_ENCRYPTION_KEY;
  delete process.env.CONFIG_ENCRYPTION_KEY;
  try {
    const keyfilePath = tmpKeyfilePath();
    assert.equal(fs.existsSync(keyfilePath), false);

    const key = secrets.resolveKey({ keyfilePath });

    assert.equal(fs.existsSync(keyfilePath), true);
    assert.equal(key.length, 32);
    const mode = fs.statSync(keyfilePath).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    if (prev !== undefined) process.env.CONFIG_ENCRYPTION_KEY = prev;
  }
});

test('resolveKey() reuses an already-generated keyfile instead of regenerating it', () => {
  const prev = process.env.CONFIG_ENCRYPTION_KEY;
  delete process.env.CONFIG_ENCRYPTION_KEY;
  try {
    const keyfilePath = tmpKeyfilePath();
    const first = secrets.resolveKey({ keyfilePath });
    const second = secrets.resolveKey({ keyfilePath });
    assert.equal(first.toString('hex'), second.toString('hex'));
  } finally {
    if (prev !== undefined) process.env.CONFIG_ENCRYPTION_KEY = prev;
  }
});

test('seal()/open() work end-to-end through auto-generated keyfile resolution (no explicit key)', () => {
  const prev = process.env.CONFIG_ENCRYPTION_KEY;
  delete process.env.CONFIG_ENCRYPTION_KEY;
  try {
    const keyfilePath = tmpKeyfilePath();
    const envelope = secrets.seal('through-keyfile', { keyfilePath });
    assert.equal(secrets.open(envelope, { keyfilePath }), 'through-keyfile');
  } finally {
    if (prev !== undefined) process.env.CONFIG_ENCRYPTION_KEY = prev;
  }
});
