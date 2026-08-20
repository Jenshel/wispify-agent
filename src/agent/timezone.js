'use strict';
// src/agent/timezone.js — shared IANA-timezone wall-clock resolution (PR17).
//
// app_config.timezone (schema.sql, an IANA zone name like "America/Bogota" —
// NOT a raw UTC offset) previously round-tripped through the settings API
// but was never actually consumed: src/agent/date.js (CITA_CONFIRMADA date
// resolution) and src/jobs/nudges.js (stage-3 "10am" trigger) each
// hardcoded their own fixed Mexico City UTC-6 offset independently. This is
// the single shared helper both now read the configured zone through, so
// the offset-computation logic isn't duplicated in two places.
//
// Built entirely on Node's BUILT-IN Intl API — no new dependency. Node 13+
// ships full ICU/timezone data via Intl.DateTimeFormat, which is more than
// sufficient here (and correctly handles DST/historical offset changes,
// unlike a hardcoded constant).

const DEFAULT_TIMEZONE = 'America/Mexico_City';

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function buildFormatter(zone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
}

/**
 * Wall-clock date/time components for `epochMs` in `timezoneName`, computed
 * via Intl.DateTimeFormat. Falls back to DEFAULT_TIMEZONE if `timezoneName`
 * is empty/invalid (Intl throws on a genuinely unknown IANA name) — a bad
 * stored config value must never crash the reply/job pipeline over it.
 * @param {number} epochMs
 * @param {string} [timezoneName]
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number, weekday:number, offsetMs:number, zone:string}}
 */
function getWallClockParts(epochMs, timezoneName) {
  const requested = timezoneName || DEFAULT_TIMEZONE;
  let zone = requested;
  let formatter;
  try {
    formatter = buildFormatter(zone);
  } catch (err) {
    zone = DEFAULT_TIMEZONE;
    formatter = buildFormatter(zone);
  }

  const parts = formatter.formatToParts(new Date(epochMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10) - 1; // 0-indexed, matches Date's getUTCMonth()
  const day = parseInt(get('day'), 10);
  const minute = parseInt(get('minute'), 10);
  const second = parseInt(get('second'), 10);
  const hourRaw = get('hour');
  // Some ICU versions format midnight as "24" with hour12:false — normalize.
  const hour = hourRaw === '24' ? 0 : parseInt(hourRaw, 10);
  const weekday = WEEKDAYS[get('weekday')];

  // The zone's wall-clock reading for this instant, re-expressed as if it
  // were itself a UTC timestamp — the difference from the real instant is
  // exactly the zone's current offset from UTC.
  const wallAsUtcMs = Date.UTC(year, month, day, hour, minute, second);
  const offsetMs = wallAsUtcMs - epochMs;

  return { year, month, day, hour, minute, second, weekday, offsetMs, zone };
}

/**
 * Convert a naive local ISO string (no timezone suffix, e.g.
 * "2026-08-21T15:00:00") into the real UTC Date instant it represents in
 * `timezoneName`. Two-pass estimate (stable for both fixed-offset zones and
 * zones with DST): guess the instant by treating the wall-clock reading as
 * UTC, look up that guess's real offset, then correct.
 * @param {string} naiveIso
 * @param {string} [timezoneName]
 * @returns {Date}
 */
function zonedTimeToInstant(naiveIso, timezoneName) {
  const baseMs = Date.parse(`${naiveIso}Z`);
  if (Number.isNaN(baseMs)) return new Date(NaN);

  let instantMs = baseMs;
  for (let i = 0; i < 2; i++) {
    const { offsetMs } = getWallClockParts(instantMs, timezoneName);
    instantMs = baseMs - offsetMs;
  }
  return new Date(instantMs);
}

module.exports = { getWallClockParts, zonedTimeToInstant, DEFAULT_TIMEZONE };
