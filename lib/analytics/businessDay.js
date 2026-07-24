/**
 * lib/analytics/businessDay.js — timezone-correct local time + business day.
 *
 * INPUT CONVENTION (matters — read before calling)
 * The DB session runs at +03:00 and every DATETIME column stores Riyadh
 * WALL-CLOCK time, not UTC. So a string input ('YYYY-MM-DD HH:mm:ss') is
 * interpreted as Riyadh wall-clock and converted to a UTC instant by
 * subtracting the fixed +03:00 offset (Saudi Arabia has no DST — the offset
 * is constant, which is what makes this safe). A Date input is already an
 * instant and is used as-is.
 *
 * The instant is then formatted in the TARGET timezone via
 * Intl.DateTimeFormat — the ICU tables handle DST (Europe/London etc.)
 * correctly, including spring-forward and fall-back.
 *
 * BUSINESS DAY
 * business_day = the local calendar date, minus one day when the local time
 * is strictly BEFORE the branch's day_close_time. A sale at 01:30 with a
 * 04:00 close belongs to yesterday's trading day; a sale at exactly 04:00:00
 * belongs to today. day_close_time '00:00:00' means business day === calendar
 * day always (nothing is strictly before midnight).
 *
 * Pure: no DB, no config, no ambient clock (nextRunAt takes `nowUtc`).
 */
'use strict';

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000; // +03:00, fixed (no DST in KSA)

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Coerce input to a UTC instant (Date).
 * - Date            → as-is (already an instant).
 * - 'YYYY-MM-DD HH:mm[:ss]' → Riyadh wall-clock → instant (subtract +03:00).
 * Throws on anything unparseable — a silent NaN date would poison every
 * downstream business_day.
 */
function toInstant(dateUtcOrRiyadh) {
  if (dateUtcOrRiyadh instanceof Date) {
    if (Number.isNaN(dateUtcOrRiyadh.getTime())) throw new Error('businessDay: invalid Date');
    return dateUtcOrRiyadh;
  }
  const s = String(dateUtcOrRiyadh || '');
  const m = DATETIME_RE.exec(s);
  if (!m) throw new Error(`businessDay: unparseable datetime "${s}"`);
  const wallUtcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return new Date(wallUtcMs - RIYADH_OFFSET_MS);
}

// Formatter cache — Intl.DateTimeFormat construction is expensive and the
// projector calls this per row.
const _fmtCache = new Map();
function formatterFor(tz) {
  let f = _fmtCache.get(tz);
  if (!f) {
    // en-CA yields ISO-ordered parts; hourCycle h23 forbids the "24:xx"
    // midnight some ICU versions emit under hour12:false.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    _fmtCache.set(tz, f);
  }
  return f;
}

/** Instant → { y, mo, d, h, mi, s } in the target timezone (DST-safe via ICU). */
function localParts(instant, tz) {
  const parts = formatterFor(tz).formatToParts(instant);
  const out = {};
  for (const p of parts) out[p.type] = p.value;
  return {
    y: +out.year, mo: +out.month, d: +out.day,
    h: +out.hour, mi: +out.minute, s: +out.second,
  };
}

/** 'HH:mm' | 'HH:mm:ss' | TIME value → seconds since local midnight. */
function parseTimeOfDay(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(t == null ? '' : t));
  if (!m) throw new Error(`businessDay: unparseable day_close_time "${t}"`);
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
}

/** Calendar-shift a local (y,mo,d) by `days` — done in UTC space, DST-immune. */
function shiftDate(y, mo, d, days) {
  const dt = new Date(Date.UTC(y, mo - 1, d) + days * 86400000);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * The core computation.
 *
 * @param {Date|string} dateUtcOrRiyadh  Date instant, or DB DATETIME string
 *                                       (Riyadh wall-clock — see header).
 * @param {string} tz                    IANA timezone of the branch.
 * @param {string} dayCloseTime          'HH:mm:ss' (branches.day_close_time).
 * @returns {{ occurredAtLocal: string, businessDay: string }}
 */
function computeLocal(dateUtcOrRiyadh, tz, dayCloseTime) {
  const instant = toInstant(dateUtcOrRiyadh);
  const p = localParts(instant, tz || 'Asia/Riyadh');
  const occurredAtLocal =
    `${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;

  const closeSec = parseTimeOfDay(dayCloseTime == null ? '04:00:00' : dayCloseTime);
  const localSec = p.h * 3600 + p.mi * 60 + p.s;
  let bd = { y: p.y, mo: p.mo, d: p.d };
  if (localSec < closeSec) bd = shiftDate(p.y, p.mo, p.d, -1);

  return {
    occurredAtLocal,
    businessDay: `${bd.y}-${pad2(bd.mo)}-${pad2(bd.d)}`,
  };
}

// ─── local wall-clock → UTC instant (for schedules) ─────────────────────────

/** Offset (ms) of `tz` from UTC at a given instant, via the ICU tables. */
function tzOffsetMs(tz, instant) {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - instant.getTime();
}

/**
 * Convert a local wall-clock time in `tz` to a UTC instant. Two-pass offset
 * fixpoint: guess with the offset at the naive instant, then correct with the
 * offset at the guess — converges for every real timezone. During a DST
 * spring-forward gap (a wall time that never exists) this lands on the
 * adjacent valid instant, which is the useful behavior for a scheduler.
 */
function wallTimeToUtc(tz, y, mo, d, h, mi, s) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  let offset = tzOffsetMs(tz, new Date(naive));
  let guess = naive - offset;
  offset = tzOffsetMs(tz, new Date(guess));
  guess = naive - offset;
  return new Date(guess);
}

/**
 * Next fire instant for a report schedule, strictly AFTER `nowUtc`.
 *
 * @param {object} schedule { freq: 'daily'|'weekly'|'monthly',
 *                            at_time: 'HH:mm[:ss]',
 *                            weekday:  0..6 (0 = Sunday) — weekly only,
 *                            month_day: 1..31 — monthly only (clamped to the
 *                                       month's last day, so 31 fires on
 *                                       Feb 28/29 rather than never),
 *                            timezone: IANA tz (default 'Asia/Riyadh') }
 * @param {Date} nowUtc
 * @returns {Date} UTC instant of the next run.
 */
function nextRunAt(schedule, nowUtc) {
  if (!schedule || !schedule.freq) throw new Error('nextRunAt: schedule.freq is required');
  const tz = schedule.timezone || 'Asia/Riyadh';
  const atSec = parseTimeOfDay(schedule.at_time == null ? '00:00:00' : schedule.at_time);
  const h = Math.floor(atSec / 3600), mi = Math.floor((atSec % 3600) / 60), s = atSec % 60;
  const now = nowUtc instanceof Date ? nowUtc : new Date(nowUtc);
  if (Number.isNaN(now.getTime())) throw new Error('nextRunAt: invalid nowUtc');

  const today = localParts(now, tz);
  // Walk local calendar days from today; 62 covers any monthly schedule
  // (including a month_day that only exists via clamping) twice over.
  for (let i = 0; i <= 62; i++) {
    const day = shiftDate(today.y, today.mo, today.d, i);
    if (schedule.freq === 'weekly') {
      // JS getUTCDay on the pure date: 0 = Sunday … 6 = Saturday.
      const dow = new Date(Date.UTC(day.y, day.mo - 1, day.d)).getUTCDay();
      if (dow !== Number(schedule.weekday)) continue;
    } else if (schedule.freq === 'monthly') {
      const wanted = Number(schedule.month_day) || 1;
      const lastOfMonth = new Date(Date.UTC(day.y, day.mo, 0)).getUTCDate();
      if (day.d !== Math.min(wanted, lastOfMonth)) continue;
    }
    const candidate = wallTimeToUtc(tz, day.y, day.mo, day.d, h, mi, s);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error('nextRunAt: no fire date found within 62 days (invalid schedule?)');
}

module.exports = {
  computeLocal,
  nextRunAt,
  // exported for tests / the projector
  toInstant,
  localParts,
  parseTimeOfDay,
  wallTimeToUtc,
  tzOffsetMs,
};
