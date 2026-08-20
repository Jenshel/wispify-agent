'use strict';
// src/agent/effects/appointment.js — [CITA_CONFIRMADA] effect handler
// (tasks.md Phase 8), replacing PR9's documented stub with the real thing.
//
// PORTS two real bug fixes from WhiteLabel_WA_System's routes/webhook.js
// citaMatch handling, not just new feature code — this phase's own name
// ("past-time/double-booking guards") makes both of these the actual point,
// not optional hardening:
//
//   1. Past-time rejection — parseFlexDate()/src/agent/date.js has no
//      awareness of "hoy" + a clock time that has already passed. Without
//      this guard the bot would confirm a cita for a time already behind
//      "now" (sounds normal to the customer), and the no-show reminder job
//      (Phase 8.4) would then fire almost immediately after, telling the
//      customer they missed a demo they just booked seconds ago. Rejected
//      if the resolved time is more than PAST_GRACE_MS behind "now" (~5min
//      buffer for clock skew/typing time, ported verbatim from the source).
//
//   2. Double-booking rejection — the brain is a single LLM call with no
//      query access to existing appointments; without this guard two
//      different customers could each get their own confirmed booking for
//      the exact same slot. A customer rescheduling their OWN prior booking
//      is excluded (not a conflict with themselves) — see
//      src/db/appointments.js findConflict().
//
// Also creates the real Google Calendar event via
// src/integrations/google-calendar.js's OAuth token machinery (Phase 2/3),
// attempting a Google Meet conference link and falling back to a plain
// event (no Meet link) if conference creation isn't supported for that
// calendar — never failing the whole booking over a Meet-link failure
// (design.md/PR3 risk note).
//
// Booking confirmation is intentionally NOT blocked on Calendar event
// creation succeeding — mirrors the source's own behavior (the local
// appointment record is created regardless; a Calendar failure is logged
// and degrades gracefully, same as the source's createCalendarEvent()
// returning null on error without aborting the booking). The local
// `appointments` table (src/db/appointments.js) is bookkeeping for the two
// guards above + the reminder job — Google Calendar remains the sole
// booking backend per spec ("no local-storage fallback"); this table never
// substitutes for a Calendar event, it only tracks what this bot has
// confirmed so the guards and reminders have something to query.
//
// Card-payment link generation (the source's `paymentMethod === 'card'`
// branch) is deliberately NOT built here — Phase 9 ("Payments — generic
// Stripe checkout") owns real Stripe Checkout session creation; this phase
// does not invent a parallel/placeholder payment-link path.

const crypto = require('crypto');

const store = require('../../config/store');
const capabilities = require('../../config/capabilities');
const client = require('../../channels/whatsapp/client');
const googleCalendar = require('../../integrations/google-calendar');
const appointments = require('../../db/appointments');
const { parseFlexDate, toApptDate } = require('../date');

const PAST_GRACE_MS = 5 * 60 * 1000; // small buffer for clock skew/typing time — ported from source
const DEFAULT_DURATION_MIN = 60;

const PAYMENT_METHOD_MAP = { al_llegar: 'cash', transferencia: 'bank_transfer', tarjeta: 'card' };

async function notifyCustomer(db, from, text, { fetchImpl } = {}) {
  const metaCreds = store.getIntegrationCredentials(db, 'meta');
  if (!metaCreds) return false;
  const result = await client.sendText(metaCreds, { to: from, text }, { fetchImpl });
  return !!result;
}

/**
 * @param {{
 *   servicio: string, fecha: string, hora: string, duracion: string,
 *   pago: string, total: number, from: string,
 * }} payload
 * @param {{
 *   db?: import('better-sqlite3').Database, fetchImpl?: typeof fetch,
 *   now?: number, calendarTokenCache?: object,
 * }} [ctx]
 * @returns {Promise<{ok: boolean, reason?: string, id?: string, googleEventId?: string|null, meetLink?: string|null}>}
 */
async function confirmAppointment(
  { servicio, fecha, hora, duracion, pago, total, from } = {},
  { db, fetchImpl, now = Date.now(), calendarTokenCache } = {}
) {
  if (!db) {
    console.warn(`[CITA_CONFIRMADA] no db in ctx — cannot book (from=${from})`);
    return { ok: false, reason: 'no_db' };
  }

  const service = servicio || 'Cita';
  const durationMin = parseInt(duracion, 10) || DEFAULT_DURATION_MIN;
  const paymentRaw = (pago || 'al_llegar').toLowerCase().replace(/\s+/g, '_');
  const paymentMethod = PAYMENT_METHOD_MAP[paymentRaw] || 'cash';
  const totalNum = Number(total) || 0;

  const timezoneName = store.getAppConfig(db).timezone;
  const resolvedIso = parseFlexDate(fecha, hora, { now, timezoneName });
  const date = resolvedIso.slice(0, 10);
  const time = resolvedIso.slice(11, 16);

  // ── Guard 1: reject a resolved time that has already passed ───────────
  const apptDateTime = toApptDate(resolvedIso, timezoneName);
  if (Number.isNaN(apptDateTime.getTime()) || apptDateTime.getTime() < now - PAST_GRACE_MS) {
    console.warn(`[CITA_CONFIRMADA] rejected — resolved time ${resolvedIso} already passed (from=${from})`);
    await notifyCustomer(db, from, 'Esa hora ya pasó. ¿Me confirmas otro día u horario que sí esté disponible?', { fetchImpl });
    return { ok: false, reason: 'past_time' };
  }

  // ── Guard 2: reject a conflicting booking for a DIFFERENT customer ────
  let conflict = null;
  try {
    conflict = appointments.findConflict(db, { date, time, excludePhone: from });
  } catch (err) {
    // Lookup itself failed (DB hiccup) — fail open rather than blocking a
    // legitimate booking over an infra blip (matches the source's own
    // fail-open behavior for this specific check).
    console.error('[CITA_CONFIRMADA] conflict check failed, proceeding anyway:', err.message);
  }
  if (conflict) {
    console.warn(`[CITA_CONFIRMADA] rejected — ${date} ${time} already booked (conflicts with appointment ${conflict.id})`);
    await notifyCustomer(db, from, 'Ese horario ya se acaba de ocupar. ¿Me confirmas otro día u hora?', { fetchImpl });
    return { ok: false, reason: 'slot_conflict' };
  }

  // ── Real Google Calendar event creation (Meet link + graceful fallback) ─
  let calendarEvent = null;
  const calendarActive = capabilities.isIntegrationActive(db, 'google_calendar');
  if (calendarActive) {
    try {
      const calCreds = store.getIntegrationCredentials(db, 'google_calendar');
      const calMeta = store.getIntegrationPublic(db, 'google_calendar').publicMeta;
      const endDt = new Date(apptDateTime.getTime() + durationMin * 60000);
      calendarEvent = await googleCalendar.createEvent(
        { accessToken: calCreds?.access_token, refreshToken: calCreds?.refresh_token, calendarId: calMeta?.calendar_id },
        {
          summary: `${service} — ${from}`,
          description: `Cliente: ${from}\nServicio: ${service}\nTotal: $${totalNum}\nPago: ${pago || ''}\nDuración: ${durationMin} min`,
          startIso: apptDateTime.toISOString(),
          endIso: endDt.toISOString(),
        },
        { fetchImpl, cache: calendarTokenCache }
      );
    } catch (err) {
      if (err.code === 'invalid_grant') {
        store.setIntegrationError(db, 'google_calendar', 'refresh token invalid or revoked (invalid_grant) — reconnect Google Calendar');
      }
      console.error('[CITA_CONFIRMADA] Calendar event creation failed:', err.message);
    }
  } else {
    console.warn(`[CITA_CONFIRMADA] google_calendar not active — booking ${from} locally without a Calendar event`);
  }

  const id = crypto.randomUUID();
  appointments.createAppointment(db, {
    id,
    customerPhone: from,
    service,
    date,
    time,
    durationMinutes: durationMin,
    paymentMethod,
    total: totalNum,
    status: 'confirmed',
    googleEventId: calendarEvent?.id || null,
    meetLink: calendarEvent?.meetLink || null,
  });
  console.log(`[CITA_CONFIRMADA] Appointment ${id} created — ${service} ${date} ${time} (${durationMin}min) — ${pago || ''}`);

  const totalLine = totalNum > 0 ? `Total: $${totalNum}` : 'Pago: gratis';
  const meetLine = calendarEvent?.meetLink
    ? `\n\n📹 Google Meet: ${calendarEvent.meetLink}`
    : calendarActive
      ? '\n\n📹 Te enviaremos el link de Google Meet 30 minutos antes de la cita.'
      : '';
  const confirmMsg = `✅ Listo, confirmado.\n\nServicio: ${service}\nFecha: ${date}\nHora: ${time}\nDuración: ${durationMin} min\n${totalLine}${meetLine}`;
  await notifyCustomer(db, from, confirmMsg, { fetchImpl });

  return { ok: true, id, googleEventId: calendarEvent?.id || null, meetLink: calendarEvent?.meetLink || null };
}

module.exports = { confirmAppointment };
