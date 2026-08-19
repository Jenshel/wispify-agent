'use strict';
// src/agent/date.js — flexible Spanish date/time resolution for
// [CITA_CONFIRMADA] bookings (tasks.md Phase 8.1/8.2), PORTED from
// WhiteLabel_WA_System's routes/webhook.js parseFlexDate().
//
// src/agent/tags.js's parseCitaFields() deliberately leaves "Fecha"/"Hora"
// as raw strings (see that module's own header comment) — this is the
// module that turns "mañana"/"hoy"/"viernes"/"15 de marzo"/an explicit
// YYYY-MM-DD into an actual date, so the past-time and double-booking
// guards in src/agent/effects/appointment.js have something real to
// compare against.
//
// Deliberately hardcodes the Mexico City UTC-6 offset (no DST in Mexico
// City) exactly like the source — app_config.timezone is NOT wired into
// this resolution yet. This is an explicit scope boundary carried forward
// from the port (same open-item pattern as this repo's other "not wired
// yet" notes), not an oversight — see apply-progress.
//
// Pure function, no I/O — `now` is injectable so "hoy"/"mañana"/weekday
// resolution and the past-time guard that reads this module's output are
// fully deterministic in tests, unlike the source's bare Date.now() call.

const MX_OFFSET_MS = -6 * 3600 * 1000;
const MX_OFFSET_SUFFIX = '-06:00';

const MESES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};
const DIAS = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 0 };

/**
 * Resolve a raw "Fecha"/"Hora" pair from a [CITA_CONFIRMADA] tag into a
 * naive local ISO string (no timezone suffix — see toApptDate() below for
 * that). Understands: explicit `YYYY-MM-DD`, "mañana", "hoy", a bare
 * weekday name ("viernes" — always the NEXT occurrence, never today, even
 * if today is that weekday), "D de MES", falling back to tomorrow if
 * nothing else matches (same fallback the source used, rather than
 * silently defaulting to today for an unparseable date).
 * @param {string} dateStr
 * @param {string} timeStr
 * @param {{now?: number}} [opts]
 * @returns {string} e.g. "2026-08-21T15:00:00"
 */
function parseFlexDate(dateStr, timeStr, { now = Date.now() } = {}) {
  const timeParts = (timeStr || '10:00').match(/(\d{1,2}):(\d{2})/);
  const hours = timeParts ? parseInt(timeParts[1], 10) : 10;
  const minutes = timeParts ? parseInt(timeParts[2], 10) : 0;

  const trimmed = (dateStr || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
  }

  const nowMxDate = new Date(now + MX_OFFSET_MS);
  const todayY = nowMxDate.getUTCFullYear();
  const todayM = nowMxDate.getUTCMonth();
  const todayD = nowMxDate.getUTCDate();
  const todayDow = nowMxDate.getUTCDay();

  const lower = (dateStr || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  let targetY = todayY;
  let targetM = todayM;
  let targetD = todayD;
  let matched = false;

  if (lower.includes('manana')) {
    const t = new Date(Date.UTC(todayY, todayM, todayD + 1));
    targetY = t.getUTCFullYear();
    targetM = t.getUTCMonth();
    targetD = t.getUTCDate();
    matched = true;
  } else if (lower.includes('hoy')) {
    matched = true;
  } else {
    for (const [name, dow] of Object.entries(DIAS)) {
      if (lower.includes(name)) {
        const diff = (dow - todayDow + 7) % 7 || 7;
        const t = new Date(Date.UTC(todayY, todayM, todayD + diff));
        targetY = t.getUTCFullYear();
        targetM = t.getUTCMonth();
        targetD = t.getUTCDate();
        matched = true;
        break;
      }
    }
    if (!matched) {
      const dayMonth = lower.match(/(\d{1,2})\s*de\s*(\w+)/);
      if (dayMonth) {
        const day = parseInt(dayMonth[1], 10);
        const month = MESES[dayMonth[2]];
        if (!isNaN(day) && month !== undefined) {
          targetD = day;
          targetM = month;
          if (month < todayM || (month === todayM && day < todayD)) targetY = todayY + 1;
          matched = true;
        }
      }
    }
  }

  if (!matched) {
    const t = new Date(Date.UTC(todayY, todayM, todayD + 1));
    targetY = t.getUTCFullYear();
    targetM = t.getUTCMonth();
    targetD = t.getUTCDate();
  }

  const mm = String(targetM + 1).padStart(2, '0');
  const dd = String(targetD).padStart(2, '0');
  const hh = String(hours).padStart(2, '0');
  const min = String(minutes).padStart(2, '0');
  return `${targetY}-${mm}-${dd}T${hh}:${min}:00`;
}

/** Convert parseFlexDate()'s naive local ISO string into a real Date (Mexico City, UTC-6). */
function toApptDate(resolvedIso) {
  return new Date(`${resolvedIso}${MX_OFFSET_SUFFIX}`);
}

module.exports = { parseFlexDate, toApptDate, MX_OFFSET_SUFFIX };
