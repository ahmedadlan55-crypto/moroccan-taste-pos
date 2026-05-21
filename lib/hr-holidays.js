// ═══════════════════════════════════════════════════════════════════
// v5.11.1 — Holiday detection + monthly map for the HR module.
//
// Reads from the `hr_holidays` table (created by the migration in
// server.js). Two responsibilities:
//
//   1. findHolidayForDate(date, brandId, branchId)
//      → returns the best-matching holiday row for that date, or null.
//        Branch-scoped holidays beat brand-scoped beat all-scope, so an
//        owner can override a national holiday with a branch-specific
//        decision (e.g. branch X closes on a local civic day).
//
//   2. holidaysInMonth(year, month, brandId, branchId)
//      → returns a map keyed by 'YYYY-MM-DD' for fast lookup while
//        building the monthly attendance report.
// ═══════════════════════════════════════════════════════════════════
const db = require('../db/connection');

function _pad2(n) { return String(n).padStart(2, '0'); }
function _ymd(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate());
}

async function findHolidayForDate(date, brandId, branchId) {
  if (!date) return null;
  const dateStr = (typeof date === 'string') ? date.slice(0, 10) : _ymd(date);
  try {
    const [rows] = await db.query(
      'SELECT * FROM hr_holidays ' +
      'WHERE is_active = 1 ' +
      '  AND ? BETWEEN start_date AND end_date ' +
      '  AND (scope = "all" ' +
      '       OR (scope = "brand"  AND brand_id  = ?) ' +
      '       OR (scope = "branch" AND branch_id = ?)) ' +
      'ORDER BY ' +
      '  CASE scope WHEN "branch" THEN 0 WHEN "brand" THEN 1 ELSE 2 END ' +
      'LIMIT 1',
      [dateStr, brandId || '', branchId || '']
    );
    return rows[0] || null;
  } catch (e) {
    console.warn('[hr-holidays] findHolidayForDate failed:', e.message);
    return null;
  }
}

async function holidaysInMonth(year, month, brandId, branchId) {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m) return {};
  const start = y + '-' + _pad2(m) + '-01';
  // Last day of month
  const lastDay = new Date(y, m, 0).getDate();
  const end = y + '-' + _pad2(m) + '-' + _pad2(lastDay);
  try {
    const [rows] = await db.query(
      'SELECT * FROM hr_holidays ' +
      'WHERE is_active = 1 ' +
      '  AND start_date <= ? AND end_date >= ? ' +
      '  AND (scope = "all" ' +
      '       OR (scope = "brand"  AND brand_id  = ?) ' +
      '       OR (scope = "branch" AND branch_id = ?))',
      [end, start, brandId || '', branchId || '']
    );
    // Expand each holiday into per-day map; if multiple holidays cover
    // the same day (rare), branch > brand > all wins.
    const scopeRank = { branch: 0, brand: 1, all: 2 };
    const map = {};
    rows.forEach(h => {
      const s = new Date(h.start_date), e = new Date(h.end_date);
      for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        if (d.getFullYear() !== y || d.getMonth() + 1 !== m) continue;
        const key = _ymd(d);
        if (!map[key] || scopeRank[h.scope] < scopeRank[map[key].scope]) {
          map[key] = h;
        }
      }
    });
    return map;
  } catch (e) {
    console.warn('[hr-holidays] holidaysInMonth failed:', e.message);
    return {};
  }
}

module.exports = { findHolidayForDate, holidaysInMonth };
