'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const gitignorePath = path.join(ROOT, '.gitignore');

test('.gitignore exists and blocks every known secret-leak path', () => {
  assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist at repo root');

  const content = fs.readFileSync(gitignorePath, 'utf8');

  // Each of these MUST be covered so no real secret can ever land in git
  // history: node_modules (bloat, not a secret risk, but required hygiene),
  // .env (real credentials), data/ (SQLite DB + auto-generated
  // CONFIG_ENCRYPTION_KEY keyfile per design.md), *.keyfile (defense in
  // depth if a keyfile ever lives outside data/), *.local.* (local override
  // files), and standard OS/editor cruft.
  const requiredPatterns = [
    'node_modules/',
    '.env',
    'data/',
    '*.keyfile',
    '*.local.*',
    '.DS_Store',
  ];

  for (const pattern of requiredPatterns) {
    assert.ok(
      content.includes(pattern),
      `.gitignore must include pattern: ${pattern}`
    );
  }
});

test('.gitignore does not blanket-ignore .env.example (it must stay tracked)', () => {
  const content = fs.readFileSync(gitignorePath, 'utf8');
  assert.ok(
    content.includes('!.env.example'),
    '.gitignore must explicitly un-ignore .env.example so the placeholder template stays committed'
  );
});

test('.env.example exists and contains no realistic secret-shaped values', () => {
  const envExamplePath = path.join(ROOT, '.env.example');
  assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');

  const content = fs.readFileSync(envExamplePath, 'utf8');

  // Guard against accidentally pasting a real-looking key when this file is
  // next edited. Every assigned value must look like a placeholder, not a
  // real secret (e.g. no live Stripe/Meta-shaped tokens).
  const suspiciousPatterns = [/sk_live_/i, /sk_test_[a-zA-Z0-9]{10,}/, /ya29\./, /AIza[0-9A-Za-z_-]{30,}/];
  for (const pattern of suspiciousPatterns) {
    assert.ok(
      !pattern.test(content),
      `.env.example must not contain a realistic secret-shaped value matching ${pattern}`
    );
  }
});
