'use strict';
// src/db/appointments.js — appointments table accessors (tasks.md Phase 8).
//
// The minimal table this phase actually needs: the double-booking guard's
// conflict query (8.1/8.2, src/agent/effects/appointment.js) and the
// reminder job's upcoming-appointment scan (8.4,
// src/jobs/appointment-reminders.js). Deliberately NOT the general-purpose
// `orders` table design.md defers to Phase 9 (Stripe) — appointments and
// paid orders are different concerns with different lifecycles; this repo
// keeps them in separate tables rather than overloading one polymorphic
// row shape (the source system's `type: 'appointment'` orders row) — see
// schema.sql's own comment on this table.
//
// Every accessor takes `db` explicitly, same convention as
// src/config/store.js, so tests always run against an isolated `:memory:`
// database.

function toCamel(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerPhone: row.customer_phone,
    service: row.service,
    date: row.date,
    time: row.time,
    durationMinutes: row.duration_minutes,
    paymentMethod: row.payment_method,
    total: row.total,
    status: row.status,
    googleEventId: row.google_event_id,
    meetLink: row.meet_link,
    reminder30Sent: !!row.reminder_30_sent,
    reminder5Sent: !!row.reminder_5_sent,
    noShowSent: !!row.no_show_sent,
    createdAt: row.created_at,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   id: string, customerPhone: string, service: string, date: string, time: string,
 *   durationMinutes?: number, paymentMethod?: string|null, total?: number,
 *   status?: string, googleEventId?: string|null, meetLink?: string|null,
 * }} input
 */
function createAppointment(
  db,
  {
    id,
    customerPhone,
    service,
    date,
    time,
    durationMinutes = 60,
    paymentMethod = null,
    total = 0,
    status = 'confirmed',
    googleEventId = null,
    meetLink = null,
  }
) {
  db.prepare(
    `INSERT INTO appointments
       (id, customer_phone, service, date, time, duration_minutes, payment_method, total, status, google_event_id, meet_link)
     VALUES (@id, @customerPhone, @service, @date, @time, @durationMinutes, @paymentMethod, @total, @status, @googleEventId, @meetLink)`
  ).run({ id, customerPhone, service, date, time, durationMinutes, paymentMethod, total, status, googleEventId, meetLink });
  return getAppointmentById(db, id);
}

function getAppointmentById(db, id) {
  return toCamel(db.prepare('SELECT * FROM appointments WHERE id = ?').get(id));
}

/**
 * Double-booking guard query (tasks.md 8.1/8.2, ported from the source's
 * `dbLib.getOrders(slotId).filter(...)`). Excludes cancelled appointments
 * and the SAME customer's own prior booking — a customer rescheduling their
 * own appointment is not a conflict with themselves.
 * @param {import('better-sqlite3').Database} db
 * @param {{date: string, time: string, excludePhone: string}} query
 */
function findConflict(db, { date, time, excludePhone }) {
  return toCamel(
    db
      .prepare(
        `SELECT * FROM appointments
          WHERE date = @date AND time = @time
            AND status != 'cancelled'
            AND customer_phone != @excludePhone
          LIMIT 1`
      )
      .get({ date, time, excludePhone })
  );
}

/** Attach the real Google Calendar event id + Meet link once created. */
function setGoogleEvent(db, id, { googleEventId, meetLink }) {
  db.prepare('UPDATE appointments SET google_event_id = @googleEventId, meet_link = @meetLink WHERE id = @id').run({
    id,
    googleEventId: googleEventId || null,
    meetLink: meetLink || null,
  });
  return getAppointmentById(db, id);
}

/** Confirmed (non-cancelled) appointments — the reminder job's scan source (tasks.md 8.4). */
function listActiveAppointments(db) {
  return db.prepare(`SELECT * FROM appointments WHERE status = 'confirmed'`).all().map(toCamel);
}

const REMINDER_FIELD_COLUMNS = {
  reminder30: 'reminder_30_sent',
  reminder5: 'reminder_5_sent',
  noShow: 'no_show_sent',
};

/** @param {'reminder30'|'reminder5'|'noShow'} field */
function markReminderSent(db, id, field) {
  const column = REMINDER_FIELD_COLUMNS[field];
  if (!column) {
    throw new Error(`unknown reminder field: ${JSON.stringify(field)} (expected one of ${Object.keys(REMINDER_FIELD_COLUMNS).join(', ')})`);
  }
  db.prepare(`UPDATE appointments SET ${column} = 1 WHERE id = ?`).run(id);
}

module.exports = {
  createAppointment,
  getAppointmentById,
  findConflict,
  setGoogleEvent,
  listActiveAppointments,
  markReminderSent,
};
