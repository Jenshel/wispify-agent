'use strict';
// src/jobs/appointment-reminders.js — appointment reminder scheduler
// (tasks.md Phase 8.4), PORTED from WhiteLabel_WA_System's
// routes/appointment-reminders.js scanAndRemind().
//
// The source scanned every `slot_*` directory on disk
// (`fs.readdirSync(DATA_DIR)`) and probed a per-slot Baileys gateway before
// falling back to Meta Cloud API (`sendToSlot()`) — this repo is
// mono-tenant and Cloud-API-only, so both of those collapse to a single
// query against this repo's own `appointments` table (design.md de-slotting
// table: "appointment-reminders: sendToSlot probe, readdirSync(DATA_DIR)
// slot scan -> direct whatsapp.sendText + single `orders` query" — see
// src/db/appointments.js's header comment for why this repo uses a
// dedicated `appointments` table rather than Phase 9's `orders` table).
//
// Sends three reminders per appointment, same windows as the source:
//   - 30 min before: reminder + Google Meet link (if one was created)
//   - 5 min before: short "starting now" ping
//   - 15 min after start with no reschedule/cancel: no-show recovery message
// A 48h hard backstop (NO_SHOW_MAX_AGE_MS) protects against ever
// backfilling old appointments the moment this job starts/restarts.
//
// No cron/scheduler dependency — a minimal setTimeout+setInterval runner,
// same simplicity precedent as the source (which used the exact same
// pattern, no node-cron/agenda/bull).

const store = require('../config/store');
const client = require('../channels/whatsapp/client');
const appointments = require('../db/appointments');
const { MX_OFFSET_SUFFIX } = require('../agent/date');

const SCAN_INTERVAL_MS = 2 * 60 * 1000;
const REMINDER_30_WINDOW_MS = 30 * 60 * 1000;
const REMINDER_5_WINDOW_MS = 5 * 60 * 1000;
const NO_SHOW_GRACE_MS = 15 * 60 * 1000;
const NO_SHOW_MAX_AGE_MS = 48 * 60 * 60 * 1000; // never act on appointments older than this
const START_DELAY_MS = 30 * 1000;

/** Resolve an appointment's start time (business-local, same Mexico City/UTC-6 convention as src/agent/date.js). */
function resolveApptDateTime(appt) {
  if (!appt.date || !appt.time) return null;
  const timeMatch = /^(\d{1,2}):(\d{2})/.exec(appt.time);
  if (!timeMatch) return null;
  const hh = timeMatch[1].padStart(2, '0');
  const mm = timeMatch[2];
  const dt = new Date(`${appt.date}T${hh}:${mm}:00${MX_OFFSET_SUFFIX}`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * One scan pass — exported standalone so it is directly unit-testable and
 * reusable from a manual trigger route, without waiting on the interval.
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: typeof fetch, now?: number}} [opts]
 */
async function scanAndRemind(db, { fetchImpl, now = Date.now() } = {}) {
  const metaCreds = store.getIntegrationCredentials(db, 'meta');
  if (!metaCreds) return; // nothing configured to send reminders with

  const active = appointments.listActiveAppointments(db);

  for (const appt of active) {
    if (appt.noShowSent) continue;

    const apptTime = resolveApptDateTime(appt);
    if (!apptTime) continue;
    const msUntil = apptTime.getTime() - now;

    // Hard backstop: never send ANY reminder for an appointment whose time
    // is more than 48h in the past — protects against ever backfilling old
    // appointments the moment this job starts or restarts.
    if (msUntil < -NO_SHOW_MAX_AGE_MS) continue;

    if (!appt.reminder30Sent && msUntil > 0 && msUntil <= REMINDER_30_WINDOW_MS) {
      const meetLine = appt.meetLink ? `\n\n📹 Únete aquí: ${appt.meetLink}` : '';
      const msg = `Tu cita empieza en 30 minutos.${meetLine}`;
      const sent = await client.sendText(metaCreds, { to: appt.customerPhone, text: msg }, { fetchImpl });
      if (sent) {
        appointments.markReminderSent(db, appt.id, 'reminder30');
        console.log(`[APPT-REMINDER] 30min reminder sent — appointment ${appt.id}`);
      }
      continue;
    }

    if (!appt.reminder5Sent && msUntil > 0 && msUntil <= REMINDER_5_WINDOW_MS) {
      const meetLine = appt.meetLink ? `\n${appt.meetLink}` : '';
      const msg = `Ya casi! Tu cita empieza en 5 minutos.${meetLine}`;
      const sent = await client.sendText(metaCreds, { to: appt.customerPhone, text: msg }, { fetchImpl });
      if (sent) {
        appointments.markReminderSent(db, appt.id, 'reminder5');
        console.log(`[APPT-REMINDER] 5min reminder sent — appointment ${appt.id}`);
      }
      continue;
    }

    if (msUntil < -NO_SHOW_GRACE_MS) {
      const msg = 'Vimos que no pudiste conectarte a tu cita. ¿Reagendamos? Solo dime qué día te queda bien.';
      const sent = await client.sendText(metaCreds, { to: appt.customerPhone, text: msg }, { fetchImpl });
      if (sent) {
        appointments.markReminderSent(db, appt.id, 'noShow');
        console.log(`[APPT-REMINDER] No-show recovery sent — appointment ${appt.id}`);
      }
    }
  }
}

/**
 * Start the periodic scan loop. Returns a handle with stop() so tests and
 * graceful shutdown never leave a dangling timer.
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: typeof fetch, intervalMs?: number, startDelayMs?: number}} [opts]
 */
function startAppointmentReminderJob(db, { fetchImpl, intervalMs = SCAN_INTERVAL_MS, startDelayMs = START_DELAY_MS } = {}) {
  let interval = null;
  const runScan = () => {
    scanAndRemind(db, { fetchImpl }).catch((err) => console.error('[APPT-REMINDER] scan failed:', err.message));
  };
  const timeout = setTimeout(() => {
    runScan();
    interval = setInterval(runScan, intervalMs);
  }, startDelayMs);

  console.log('[APPT-REMINDER] Appointment reminder job scheduled — scanning every 2 min');

  return {
    stop() {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    },
  };
}

module.exports = { scanAndRemind, startAppointmentReminderJob, resolveApptDateTime };
