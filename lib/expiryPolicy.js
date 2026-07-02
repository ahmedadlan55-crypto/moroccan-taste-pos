/**
 * Expiry policy — Phase 4B.
 *
 * Pure, DATE-ONLY expiry math in the Asia/Riyadh calendar (the business TZ;
 * server.js pins process.env.TZ = 'Asia/Riyadh'). Comparisons ignore clock time
 * to avoid off-by-one errors around midnight / DST (Riyadh has no DST; it is a
 * fixed UTC+3). Everything works on 'YYYY-MM-DD' calendar dates.
 *
 *   classify(expiry, now)    → 'none' | 'expired' | 'critical' | 'warning' | 'safe'
 *   receiptCheck(expiry,now) → { ok, level:'expired'|'near'|'ok', daysUntil }
 *
 * Thresholds come from env (overridable per call for tests):
 *   EXPIRY_CRITICAL_DAYS   (default 7)   — ≤ N days  → 'critical'
 *   EXPIRY_WARNING_DAYS    (default 30)  — ≤ N days  → 'warning'
 *   EXPIRY_RECEIPT_MIN_DAYS(default 30)  — receiving with < N days left → warn
 *
 * Rules: issuing an EXPIRED lot is blocked (the route enforces it); receiving an
 * already-expired lot is blocked; receiving a near-expiry lot is allowed WITH a
 * reason. A transfer never renews expiry (the lot keeps its original date).
 */
'use strict';

const RIYADH_OFFSET_MIN = 3 * 60; // UTC+3, no DST

function _int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; }

function thresholds() {
  return {
    critical: _int(process.env.EXPIRY_CRITICAL_DAYS, 7),
    warning: _int(process.env.EXPIRY_WARNING_DAYS, 30),
    receiptMin: _int(process.env.EXPIRY_RECEIPT_MIN_DAYS, 30),
  };
}

// Normalize any date-ish input to a 'YYYY-MM-DD' Riyadh calendar date (or null).
// Strings are taken as already-calendar dates (first 10 chars). Date instants are
// shifted to the Riyadh wall clock before the calendar date is read.
function ymd(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'string') { const s = input.trim().slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
  const d = (input instanceof Date) ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + RIYADH_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

function todayYmd(now) { return ymd(now || new Date()); }

// Whole calendar days from `fromYmd` to `toYmd` (negative if to < from).
function _daysBetween(fromYmd, toYmd) {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

// Days from today (Riyadh) until expiry; negative = already past. null if no expiry.
function daysUntil(expiry, now) {
  const e = ymd(expiry); if (!e) return null;
  return _daysBetween(todayYmd(now), e);
}

function classify(expiry, now, opts) {
  const e = ymd(expiry);
  if (!e) return 'none';
  const th = (opts && opts.thresholds) || thresholds();
  const d = _daysBetween(todayYmd(now), e);
  if (d < 0) return 'expired';
  if (d <= th.critical) return 'critical';
  if (d <= th.warning) return 'warning';
  return 'safe';
}

// Gate for receiving a lot: already-expired is blocked; near-expiry (< receiptMin)
// is allowed but flagged so the route can require a reason; otherwise ok.
function receiptCheck(expiry, now, opts) {
  const e = ymd(expiry);
  const th = (opts && opts.thresholds) || thresholds();
  if (!e) return { ok: true, level: 'ok', daysUntil: null };
  const d = _daysBetween(todayYmd(now), e);
  if (d < 0) return { ok: false, level: 'expired', daysUntil: d };
  if (d < th.receiptMin) return { ok: true, level: 'near', daysUntil: d };
  return { ok: true, level: 'ok', daysUntil: d };
}

function isExpired(expiry, now) { const d = daysUntil(expiry, now); return d !== null && d < 0; }

module.exports = { thresholds, ymd, todayYmd, daysUntil, classify, receiptCheck, isExpired };
