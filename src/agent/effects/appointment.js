'use strict';
// src/agent/effects/appointment.js — [CITA_CONFIRMADA] effect handler
// (tasks.md Phase 7.4) — DOCUMENTED STUB, NOT the real thing yet.
//
// This phase's job (per the delegated PR9 instructions) is parsing/
// extracting the tag correctly and calling this booking-effect seam, NOT
// implementing calendar event creation itself. Real implementation is
// Phase 8 (tasks.md "Appointment Booking — Calendar mandatory; port guard
// logic"):
//   - 8.1/8.2: PORT the source's past-time + double-booking guard logic
//     (parseFlexDate() resolution, the `orders` table conflict query) —
//     src/agent/tags.js's parseCitaFields() deliberately does NOT resolve
//     "Fecha" into a real date/time; that resolution belongs here, in
//     Phase 8, alongside the guards that need it.
//   - 8.3: getAccessToken() cache+refresh against Google Calendar's OAuth
//     tokens (src/integrations/google-calendar.js already has the OAuth
//     plumbing from Phase 2 — this is the piece that actually calls
//     calendar/v3/.../events).
//
// The function signature below is deliberately stable — same shape a real
// implementation will keep — so Phase 8 only has to fill in the body, not
// change every call site. This function itself NEVER creates an `orders`
// row or a Calendar event; it only logs and reports the stub outcome so the
// caller (src/agent/pipeline.js's confirmAppointment effectCall, dispatched
// by src/brain/index.js) can decide what to tell the customer, if anything.

/**
 * @param {{
 *   servicio: string, fecha: string, hora: string, duracion: string,
 *   pago: string, total: number, from: string,
 * }} payload
 * @param {{db?: import('better-sqlite3').Database}} [ctx]
 * @returns {Promise<{ok: false, stub: true, reason: string}>}
 */
async function confirmAppointment({ servicio, fecha, hora, from } = {}, _ctx = {}) {
  console.warn(
    `[CITA_CONFIRMADA] STUB — from=${from} servicio="${servicio || ''}" fecha="${fecha || ''}" hora="${hora || ''}"` +
      ' — no Calendar event created (Phase 8 owns date resolution + booking guards + event creation).'
  );
  return { ok: false, stub: true, reason: 'appointment_booking_not_implemented_yet' };
}

module.exports = { confirmAppointment };
