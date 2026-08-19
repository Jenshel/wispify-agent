'use strict';
// src/db/orders.js — orders table accessors (tasks.md Phase 9).
//
// Its own dedicated table, NOT a reuse of appointments (see
// src/db/appointments.js's own header comment and schema.sql's comment on
// this table for the full "don't overload one polymorphic row shape"
// reasoning PR10 already established for this exact pair).
//
// Every accessor takes `db` explicitly, same convention as
// src/db/appointments.js/src/config/store.js, so tests always run against
// an isolated `:memory:` database.

function toCamel(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerPhone: row.customer_phone,
    products: JSON.parse(row.products || '[]'),
    total: row.total,
    currency: row.currency,
    status: row.status,
    stripeSessionId: row.stripe_session_id,
    stripeSessionUrl: row.stripe_session_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   id: string, customerPhone: string,
 *   products: Array<{name: string, qty: number, price: number}>,
 *   total?: number, currency?: string,
 * }} input
 */
function createOrder(db, { id, customerPhone, products, total = 0, currency = 'MXN' }) {
  db.prepare(
    `INSERT INTO orders (id, customer_phone, products, total, currency, status)
     VALUES (@id, @customerPhone, @products, @total, @currency, 'pending')`
  ).run({
    id,
    customerPhone,
    products: JSON.stringify(products || []),
    total,
    currency,
  });
  return getOrderById(db, id);
}

function getOrderById(db, id) {
  return toCamel(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
}

/**
 * Cache the Stripe Checkout Session GET /pay/:orderId just built for this
 * order, so a customer re-clicking the same link within the freshness
 * window doesn't spawn a new session every time.
 */
function setStripeSession(db, id, { stripeSessionId, stripeSessionUrl }) {
  db.prepare(
    `UPDATE orders SET
       stripe_session_id = @stripeSessionId, stripe_session_url = @stripeSessionUrl,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = @id`
  ).run({ id, stripeSessionId: stripeSessionId || null, stripeSessionUrl: stripeSessionUrl || null });
  return getOrderById(db, id);
}

/** Mark an order paid (POST /webhook/stripe, checkout.session.completed). */
function markPaid(db, id, { stripeSessionId } = {}) {
  db.prepare(
    `UPDATE orders SET
       status = 'paid',
       stripe_session_id = COALESCE(@stripeSessionId, stripe_session_id),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = @id`
  ).run({ id, stripeSessionId: stripeSessionId || null });
  return getOrderById(db, id);
}

module.exports = { createOrder, getOrderById, setStripeSession, markPaid };
