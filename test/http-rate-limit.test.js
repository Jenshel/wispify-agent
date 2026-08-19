'use strict';
// RED->GREEN for src/http/rate-limit.js.
//
// New system, built clean (no port from WhiteLabel_WA_System, which had zero
// rate limiting anywhere except a hand-rolled guard on /login for most of its
// life — a gap found in a security audit). This is a small in-memory
// per-IP sliding-window limiter: no new heavy dependency needed for a
// single-instance starter app.
//
// Each rateLimit({...}) call must own an independent bucket Map — route
// factories create a fresh limiter per createApp() call so test runs never
// leak rate-limit state between unrelated test files/servers sharing a
// process.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rateLimit } = require('../src/http/rate-limit');

function fakeReqRes(ip) {
  const req = { ip, socket: { remoteAddress: ip } };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
}

test('rateLimit() allows requests under the limit', () => {
  const middleware = rateLimit({ windowMs: 60_000, max: 3, keyPrefix: 'test' });
  let calls = 0;
  const next = () => calls++;

  for (let i = 0; i < 3; i++) {
    const { req, res } = fakeReqRes('1.2.3.4');
    middleware(req, res, next);
  }
  assert.equal(calls, 3);
});

test('rateLimit() blocks with 429 once max is exceeded within the window', () => {
  const middleware = rateLimit({ windowMs: 60_000, max: 2, keyPrefix: 'test' });
  const next = () => {};

  for (let i = 0; i < 2; i++) {
    const { req, res } = fakeReqRes('5.6.7.8');
    middleware(req, res, next);
  }
  const { req, res, getStatus, getJson } = fakeReqRes('5.6.7.8');
  middleware(req, res, next);
  assert.equal(getStatus(), 429);
  assert.deepEqual(getJson(), { error: 'too_many_requests' });
});

test('rateLimit() tracks each IP independently', () => {
  const middleware = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'test' });
  const next = () => {};

  const first = fakeReqRes('9.9.9.9');
  middleware(first.req, first.res, next);
  assert.equal(first.getStatus(), null);

  const second = fakeReqRes('1.1.1.1');
  middleware(second.req, second.res, next);
  assert.equal(second.getStatus(), null); // different IP, own bucket
});

test('rateLimit() resets the window after it elapses', () => {
  const middleware = rateLimit({ windowMs: 10, max: 1, keyPrefix: 'test' });
  const next = () => {};

  const first = fakeReqRes('2.2.2.2');
  middleware(first.req, first.res, next);
  assert.equal(first.getStatus(), null);

  const blocked = fakeReqRes('2.2.2.2');
  middleware(blocked.req, blocked.res, next);
  assert.equal(blocked.getStatus(), 429);

  return new Promise((resolve) => {
    setTimeout(() => {
      const afterWindow = fakeReqRes('2.2.2.2');
      middleware(afterWindow.req, afterWindow.res, next);
      assert.equal(afterWindow.getStatus(), null);
      middleware.stop();
      resolve();
    }, 20);
  });
});

test('two independent rateLimit() instances never share bucket state', () => {
  const a = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'a' });
  const b = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'b' });
  const next = () => {};

  const first = fakeReqRes('3.3.3.3');
  a(first.req, first.res, next);
  assert.equal(first.getStatus(), null);

  const second = fakeReqRes('3.3.3.3'); // same IP, different limiter instance
  b(second.req, second.res, next);
  assert.equal(second.getStatus(), null);

  a.stop();
  b.stop();
});
