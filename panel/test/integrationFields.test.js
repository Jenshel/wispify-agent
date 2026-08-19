// panel/test/integrationFields.test.js — RED/GREEN coverage for the pure
// integration-form config + status helpers SettingsView/IntegrationCard
// render from. Field `name`s are locked in here because they must exactly
// match what each backend adapter's validate() destructures
// (src/integrations/{meta,gemini,stripe}.js) — IntegrationCard POSTs the
// form object verbatim as the /verify request body.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GEMINI_MODELS,
  INTEGRATION_ORDER,
  INTEGRATION_META,
  canEnableIntegration,
  statusLabel,
} from '../src/views/settings/integrationFields.js';

test('INTEGRATION_ORDER lists exactly the four known integrations', () => {
  assert.deepEqual([...INTEGRATION_ORDER].sort(), ['gemini', 'google_calendar', 'meta', 'stripe']);
});

test('every INTEGRATION_ORDER id has a matching INTEGRATION_META entry', () => {
  for (const id of INTEGRATION_ORDER) {
    assert.ok(INTEGRATION_META[id], `missing INTEGRATION_META for "${id}"`);
  }
});

test('meta fields match src/integrations/meta.js validate() credential shape', () => {
  const names = INTEGRATION_META.meta.fields.map((f) => f.name);
  assert.deepEqual(names, ['accessToken', 'phoneNumberId', 'appSecret', 'verifyToken']);
  assert.equal(INTEGRATION_META.meta.fields.find((f) => f.name === 'accessToken').required, true);
  assert.equal(INTEGRATION_META.meta.fields.find((f) => f.name === 'appSecret').required, false);
});

test('gemini fields match gemini.js validate() shape, model is a curated select (not free text)', () => {
  const fields = INTEGRATION_META.gemini.fields;
  assert.deepEqual(fields.map((f) => f.name), ['apiKey', 'model']);
  const modelField = fields.find((f) => f.name === 'model');
  assert.equal(modelField.type, 'select');
  assert.deepEqual(modelField.options, GEMINI_MODELS);
  assert.ok(GEMINI_MODELS.length > 0);
});

test('stripe fields match stripe.js validate() shape', () => {
  assert.deepEqual(INTEGRATION_META.stripe.fields.map((f) => f.name), ['secretKey']);
});

test('google_calendar is OAuth-driven and has no manual credential fields', () => {
  assert.equal(INTEGRATION_META.google_calendar.oauth, true);
  assert.equal(INTEGRATION_META.google_calendar.fields, undefined);
});

test('canEnableIntegration: only "active" status may be enabled', () => {
  assert.equal(canEnableIntegration('active'), true);
  assert.equal(canEnableIntegration('unconfigured'), false);
  assert.equal(canEnableIntegration('error'), false);
});

test('statusLabel: human-readable label per status, defaults to "Not configured"', () => {
  assert.equal(statusLabel('active'), 'Active');
  assert.equal(statusLabel('error'), 'Error');
  assert.equal(statusLabel('unconfigured'), 'Not configured');
  assert.equal(statusLabel('something-unexpected'), 'Not configured');
});
