'use strict';
// RED->GREEN for src/db/orders.js (tasks.md Phase 9).
//
// Its own dedicated table, NOT a reuse of appointments — same precedent PR10
// established for the reverse case (see src/db/appointments.js header
// comment and tasks.md's Open Risks: "flag this for whoever implements
// Phase 9, so they don't assume appointments rows live in orders").

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const orders = require('../src/db/orders');

function freshDb() {
  return openDatabase(':memory:');
}

test('createOrder() persists products as JSON and defaults status to pending', () => {
  const db = freshDb();
  const products = [{ name: 'Camisa', qty: 2, price: 150 }];
  const created = orders.createOrder(db, { id: 'ord-1', customerPhone: '5215500000001', products, total: 300, currency: 'MXN' });

  assert.equal(created.id, 'ord-1');
  assert.equal(created.customerPhone, '5215500000001');
  assert.deepEqual(created.products, products);
  assert.equal(created.total, 300);
  assert.equal(created.currency, 'MXN');
  assert.equal(created.status, 'pending');
  assert.equal(created.stripeSessionId, null);
  assert.equal(created.stripeSessionUrl, null);
  assert.ok(created.createdAt);
  assert.ok(created.updatedAt);
});

test('createOrder() defaults currency to MXN when not provided', () => {
  const db = freshDb();
  const created = orders.createOrder(db, { id: 'ord-2', customerPhone: '5215500000002', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
  assert.equal(created.currency, 'MXN');
});

test('getOrderById() returns null for an unknown id', () => {
  const db = freshDb();
  assert.equal(orders.getOrderById(db, 'nope'), null);
});

test('setStripeSession() caches the session id/url and bumps updated_at', () => {
  const db = freshDb();
  orders.createOrder(db, { id: 'ord-3', customerPhone: '5215500000003', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
  const before = orders.getOrderById(db, 'ord-3');

  const updated = orders.setStripeSession(db, 'ord-3', { stripeSessionId: 'cs_test_123', stripeSessionUrl: 'https://checkout.stripe.com/pay/cs_test_123' });
  assert.equal(updated.stripeSessionId, 'cs_test_123');
  assert.equal(updated.stripeSessionUrl, 'https://checkout.stripe.com/pay/cs_test_123');
  assert.equal(updated.status, 'pending');
  assert.ok(updated.updatedAt >= before.updatedAt);
});

test('markPaid() flips status to paid and stores the settling session id', () => {
  const db = freshDb();
  orders.createOrder(db, { id: 'ord-4', customerPhone: '5215500000004', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });

  const paid = orders.markPaid(db, 'ord-4', { stripeSessionId: 'cs_test_paid' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.stripeSessionId, 'cs_test_paid');
});

test('markPaid() preserves a previously-cached session id when none is passed', () => {
  const db = freshDb();
  orders.createOrder(db, { id: 'ord-5', customerPhone: '5215500000005', products: [{ name: 'X', qty: 1, price: 10 }], total: 10 });
  orders.setStripeSession(db, 'ord-5', { stripeSessionId: 'cs_cached', stripeSessionUrl: 'https://checkout.stripe.com/pay/cs_cached' });

  const paid = orders.markPaid(db, 'ord-5');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.stripeSessionId, 'cs_cached');
});
