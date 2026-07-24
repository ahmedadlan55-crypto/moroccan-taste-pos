/**
 * services/analytics/BudgetService.js — analytics_sales_budget writes + reads
 * + the month→day expansion (Wave 3).
 *
 * TABLE GRAIN: UNIQUE (branch_id, period_month, metric); period_month is the
 * FIRST DAY of the month (DATE). metric ∈ net_sales_ex_vat | orders | guests.
 *
 * WRITES (upsertLines): capability analytics.budget.manage; every line's
 * branch must sit INSIDE the caller's branch scope (admin = all) — a scoped
 * accountant can never plant a budget on someone else's branch. Batch
 * INSERT … ON DUPLICATE KEY UPDATE bumps `version` (+1) whenever an existing
 * row is overwritten — version is an audit counter, not optimistic locking.
 *
 * READS (list): branch-scope-clamped, optional branch/month/metric filters.
 *
 * DAILY EXPANSION (dailySeries / expandMonth):
 *   'even'             → amount / daysInMonth, every day equal.
 *   'weekday_weighted' → Saudi weekend weighting: Friday + Saturday carry
 *                        weight 1.5, Sunday–Thursday weight 1.0 (KSA weekend
 *                        is Fri+Sat; restaurant volume concentrates there).
 *                        day_amount = amount × w(day) / Σ w(days in month) —
 *                        normalized, so the days ALWAYS sum back to the
 *                        month amount exactly (float precision aside).
 *   expandMonth is a PURE exported helper — the query compare path reuses it
 *   later; no rounding inside (rounding per-day would drift the month sum;
 *   presentation rounds at the edge).
 */
'use strict';

const METRICS = new Set(['net_sales_ex_vat', 'orders', 'guests']);
const DISTRIBUTIONS = new Set(['even', 'weekday_weighted']);

/** Saudi-weekend weights (JS getUTCDay: 0=Sun … 5=Fri, 6=Sat). */
const WEEKDAY_WEIGHTS = Object.freeze({ 0: 1.0, 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.5, 6: 1.5 });

function err(code, http, message) {
  const e = new Error(message);
  e.code = code;
  e.http = http;
  return e;
}

function isAdminScope(scope) {
  return !!(scope && scope.all);
}

const MONTH_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

/** 'YYYY-MM' | 'YYYY-MM-DD' | Date → 'YYYY-MM-01' (first of month). */
function normalizeMonth(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // DATE columns arrive as JS Dates through the +03:00 session — recover
    // the calendar month the same way QueryService recovers dim values.
    const shifted = new Date(v.getTime() + 3 * 3600000);
    return shifted.toISOString().slice(0, 8) + '01';
  }
  const m = MONTH_RE.exec(String(v || ''));
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ── pure expansion helper (exported for the compare path) ────────────────────

/**
 * Expand ONE monthly budget amount into per-day amounts.
 * @param {object} p { periodMonth: 'YYYY-MM-01'|'YYYY-MM', amount: number,
 *                     distribution: 'even'|'weekday_weighted' }
 * @returns {Array<{date:string, amount:number}>} one entry per calendar day;
 *          Σ amount === p.amount (up to float precision — no rounding here).
 */
function expandMonth({ periodMonth, amount, distribution }) {
  const norm = normalizeMonth(periodMonth);
  if (!norm) throw err('VALIDATION_ERROR', 422, `periodMonth غير صالح: "${String(periodMonth).slice(0, 30)}"`);
  const dist = distribution || 'weekday_weighted';
  if (!DISTRIBUTIONS.has(dist)) throw err('VALIDATION_ERROR', 422, `distribution غير صالح: "${dist}"`);
  const total = Number(amount) || 0;
  const y = Number(norm.slice(0, 4));
  const mo = Number(norm.slice(5, 7));
  const nDays = daysInMonth(y, mo);

  const days = [];
  let weightSum = 0;
  for (let d = 1; d <= nDays; d++) {
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const w = dist === 'even' ? 1 : WEEKDAY_WEIGHTS[dow];
    weightSum += w;
    days.push({ date: `${norm.slice(0, 8)}${String(d).padStart(2, '0')}`, w });
  }
  return days.map(({ date, w }) => ({ date, amount: weightSum ? (total * w) / weightSum : 0 }));
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * Bulk upsert. @param p { user, scope, lines: [{branch_id, period_month,
 * metric, amount, distribution?}] } → { upserted }
 */
async function upsertLines(db, { user, scope, lines }) {
  if (!scope || !scope.caps || !scope.caps.has('analytics.budget.manage')) {
    throw err('PERMISSION_DENIED', 403, 'صلاحية غير كافية لإدارة الموازنات (analytics.budget.manage)');
  }
  if (!Array.isArray(lines) || !lines.length) {
    throw err('VALIDATION_ERROR', 422, 'lines يجب أن تكون مصفوفة غير فارغة');
  }
  if (lines.length > 500) {
    throw err('VALIDATION_ERROR', 422, 'lines: بحد أقصى 500 سطر لكل طلب');
  }

  const admin = isAdminScope(scope);
  const allowed = new Set((scope.branchIds || []).map(String));
  const normalized = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    const branchId = String(l.branch_id || '').trim();
    if (!branchId) throw err('VALIDATION_ERROR', 422, `lines[${i}].branch_id مطلوب`);
    if (!admin && !allowed.has(branchId)) {
      throw err('PERMISSION_DENIED', 403, `lines[${i}]: الفرع خارج نطاق صلاحياتك`);
    }
    const month = normalizeMonth(l.period_month);
    if (!month) throw err('VALIDATION_ERROR', 422, `lines[${i}].period_month يجب أن يكون YYYY-MM`);
    const metric = String(l.metric || '');
    if (!METRICS.has(metric)) {
      throw err('VALIDATION_ERROR', 422, `lines[${i}].metric يجب أن يكون net_sales_ex_vat أو orders أو guests`);
    }
    const amount = Number(l.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw err('VALIDATION_ERROR', 422, `lines[${i}].amount يجب أن يكون رقمًا ≥ 0`);
    }
    const distribution = l.distribution == null ? 'weekday_weighted' : String(l.distribution);
    if (!DISTRIBUTIONS.has(distribution)) {
      throw err('VALIDATION_ERROR', 422, `lines[${i}].distribution يجب أن يكون even أو weekday_weighted`);
    }
    normalized.push({
      brand_id: l.brand_id != null ? String(l.brand_id) : null,
      branch_id: branchId, period_month: month, metric, amount, distribution,
    });
  }

  const values = [];
  const params = [];
  for (const n of normalized) {
    values.push('(?,?,?,?,?,?,?)');
    params.push(n.brand_id, n.branch_id, n.period_month, n.metric, n.amount,
      n.distribution, user.username);
  }
  await db.query(
    `INSERT INTO analytics_sales_budget
       (brand_id, branch_id, period_month, metric, amount, distribution, created_by)
     VALUES ${values.join(',')}
     ON DUPLICATE KEY UPDATE
       amount = VALUES(amount),
       distribution = VALUES(distribution),
       brand_id = VALUES(brand_id),
       version = version + 1`,
    params);
  return { upserted: normalized.length };
}

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * @param p { scope, filters?: { branchIds?, from?, to?, metric? } }
 * from/to are months ('YYYY-MM'), inclusive.
 */
async function list(db, { scope, filters = {} }) {
  const where = [];
  const params = [];

  if (!isAdminScope(scope)) {
    const ids = (scope && scope.branchIds) || [];
    if (!ids.length) return []; // fail-closed, same posture as the planner
    where.push(`branch_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids.map(String));
  }
  if (Array.isArray(filters.branchIds) && filters.branchIds.length) {
    where.push(`branch_id IN (${filters.branchIds.map(() => '?').join(',')})`);
    params.push(...filters.branchIds.map(String));
  }
  const from = filters.from ? normalizeMonth(filters.from) : null;
  const to = filters.to ? normalizeMonth(filters.to) : null;
  if (filters.from && !from) throw err('VALIDATION_ERROR', 422, 'from يجب أن يكون YYYY-MM');
  if (filters.to && !to) throw err('VALIDATION_ERROR', 422, 'to يجب أن يكون YYYY-MM');
  if (from) { where.push('period_month >= ?'); params.push(from); }
  if (to) { where.push('period_month <= ?'); params.push(to); }
  if (filters.metric) {
    if (!METRICS.has(String(filters.metric))) throw err('VALIDATION_ERROR', 422, 'metric غير معروف');
    where.push('metric = ?');
    params.push(String(filters.metric));
  }

  // period_month is formatted in SQL — a raw DATE column would arrive as a
  // JS Date whose calendar day depends on the driver's tz conversion.
  const [rows] = await db.query(
    `SELECT id, brand_id, branch_id,
            DATE_FORMAT(period_month, '%Y-%m-%d') AS period_month,
            metric, amount, distribution, version, created_by, updated_at
       FROM analytics_sales_budget
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY period_month, branch_id, metric`,
    params);
  return rows.map((r) => Object.assign({}, r, { amount: Number(r.amount) }));
}

/**
 * Per-day budget series for [from..to] (inclusive calendar dates), summed
 * across the requested branches per day.
 * @param p { branchIds: string[], from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', metric }
 * @returns {Promise<Array<{date:string, amount:number}>>} ascending by date;
 *          days without any budget row are omitted.
 */
async function dailySeries(db, { branchIds, from, to, metric }) {
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!Array.isArray(branchIds) || !branchIds.length) {
    throw err('VALIDATION_ERROR', 422, 'branchIds مطلوبة');
  }
  if (!DAY_RE.test(String(from)) || !DAY_RE.test(String(to)) || String(from) > String(to)) {
    throw err('VALIDATION_ERROR', 422, 'from/to يجب أن يكونا YYYY-MM-DD و from ≤ to');
  }
  if (!METRICS.has(String(metric))) throw err('VALIDATION_ERROR', 422, 'metric غير معروف');

  const fromMonth = String(from).slice(0, 7) + '-01';
  const toMonth = String(to).slice(0, 7) + '-01';
  const ph = branchIds.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT branch_id, DATE_FORMAT(period_month, '%Y-%m-%d') AS period_month,
            amount, distribution
       FROM analytics_sales_budget
      WHERE branch_id IN (${ph}) AND metric = ? AND period_month >= ? AND period_month <= ?`,
    [...branchIds.map(String), String(metric), fromMonth, toMonth]);

  const byDate = new Map();
  for (const r of rows) {
    const days = expandMonth({
      periodMonth: r.period_month,
      amount: Number(r.amount),
      distribution: r.distribution,
    });
    for (const d of days) {
      if (d.date < from || d.date > to) continue; // clip partial edge months
      byDate.set(d.date, (byDate.get(d.date) || 0) + d.amount);
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, amount]) => ({ date, amount }));
}

module.exports = { upsertLines, list, dailySeries, expandMonth, WEEKDAY_WEIGHTS };
