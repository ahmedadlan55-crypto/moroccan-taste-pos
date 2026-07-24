/**
 * lib/analytics/anomalyRules.js — the anomaly rule catalog.
 *
 * Every rule is { id, severity, category, title, run(db, ctx) } where
 * ctx = { branchId, businessDay: 'YYYY-MM-DD', thresholds } and run resolves
 * to findings [{ subject, value, baseline, detail }]. Rules are PURE READS —
 * writing alerts (dedupe and all) is AnomalyService's job.
 *
 * BASELINE MODEL (spike rules): the trailing-28-day SAME-WEEKDAY window —
 * exactly the 4 days D−7, D−14, D−21, D−28. A cashier needs MIN_SAMPLES (4)
 * baseline days WITH ACTIVITY (≥1 non-CN order fact) or the rule SKIPS —
 * honesty beats coverage: 3 quiet Mondays are not a baseline. The threshold is
 * median + 3 × MAD (lib/analytics/forecast.median/mad — robust against one
 * weird day in the baseline itself), PLUS an absolute floor so a zero-MAD
 * baseline (4 identical days) doesn't flag noise:
 *   discount_rate_spike — day rate must also exceed median by > 1 percentage
 *                         point (RATE_FLOOR_PP);
 *   void_spike / return_spike — day count must also be ≥ COUNT_FLOOR (3).
 *
 * DEFINITIONS
 *   discount rate (per cashier, per day) = Σ f.discount_total / Σ doc.total_amount × 100
 *     over non-voided, non-CN order facts (the planner's default filters,
 *     verbatim — RollupService semantics). Days where the cashier's invoice
 *     total is 0 carry no rate and don't count as samples.
 *   cashier = f.created_by — the SAME expression as the registry's `cashier`
 *     dimension (lib/analytics/registry/dimensions.js), so an alert's subject
 *     matches what the analytics UI groups by.
 *   till_variance — per (branch, day) aggregate over analytics_till_facts
 *     (subject 'till'): variance = counted − expected where expected =
 *     equations.expectedCash(open_float, cash_sale, cash_refund, pay_in,
 *     pay_out + deposit) — deposit is an outflow (merge-owner ruling).
 *     Fires when |variance| > max(thresholds.tillAbs, thresholds.tillPct/100 ×
 *     |expected|). Days with no close_count are SKIPPED (nothing was counted —
 *     there is no variance to measure). Thresholds come from the settings
 *     table (AnalyticsTillVarianceAbs / AnalyticsTillVariancePct — see
 *     AnomalyService.readThresholds) and are passed in via ctx.
 *   late_offline_sync — order facts origin='offline' whose paid_at − opened_at
 *     exceeds 30 minutes (subject = document_id).
 *   projection_drift — register (sales, non-cancelled) vs projection
 *     (analytics_order_facts source='pos' status<>'voided' ⋈ sales), BOTH
 *     grouped by DATE(s.order_date) for the day under scan — the same
 *     comparison scripts/analytics/reconcile.js makes, but per-day-safe:
 *     grouping both sides by the sale's own calendar date removes the
 *     day-close boundary noise the script tolerates only in totals.
 */
'use strict';

const equations = require('./equations');
const { median, mad } = require('./forecast');

const MIN_SAMPLES = 4;      // trailing-28d same-weekday window is exactly 4 days
const RATE_FLOOR_PP = 1;    // percentage points above median (zero-MAD guard)
const COUNT_FLOOR = 3;      // minimum day count for count-based spikes
const OFFLINE_LAG_MIN = 30; // minutes
const DRIFT_EPS = 0.01;     // SAR — same epsilon as scripts/analytics/reconcile.js

// Planner default filters, verbatim (RollupService / planner semantics).
const NOT_VOID = "(f.status IS NULL OR f.status <> 'voided')";
const NOT_CN = "(f.source IS NULL OR f.source NOT IN ('sales_return','credit_note'))";
const IS_CN = "f.source IN ('sales_return','credit_note')";

const _r2 = (n) => equations.round2(Number(n) || 0);

/** The 4 trailing same-weekday days (D−7 … D−28) as 'YYYY-MM-DD'. */
function trailingSameWeekday(businessDay) {
  const base = Date.parse(businessDay + 'T00:00:00Z');
  const out = [];
  for (let k = 1; k <= 4; k++) {
    out.push(new Date(base - k * 7 * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

// ── rule: discount_rate_spike ────────────────────────────────────────────────

async function runDiscountRateSpike(db, { branchId, businessDay }) {
  const [dayRows] = await db.query(
    `SELECT f.created_by AS cashier,
            COALESCE(SUM(f.discount_total), 0) AS disc,
            COALESCE(SUM(doc.total_amount), 0) AS inv
       FROM analytics_order_facts f
       JOIN ar_documents doc ON doc.id = f.document_id
      WHERE f.branch_id = ? AND f.business_day = ?
        AND ${NOT_VOID} AND ${NOT_CN} AND f.created_by IS NOT NULL
      GROUP BY f.created_by`,
    [branchId, businessDay]);
  if (!dayRows.length) return [];

  const baseDays = trailingSameWeekday(businessDay);
  const [baseRows] = await db.query(
    `SELECT f.created_by AS cashier, f.business_day AS d,
            COALESCE(SUM(f.discount_total), 0) AS disc,
            COALESCE(SUM(doc.total_amount), 0) AS inv
       FROM analytics_order_facts f
       JOIN ar_documents doc ON doc.id = f.document_id
      WHERE f.branch_id = ? AND f.business_day IN (?,?,?,?)
        AND ${NOT_VOID} AND ${NOT_CN} AND f.created_by IS NOT NULL
      GROUP BY f.created_by, f.business_day`,
    [branchId, ...baseDays]);

  const baseline = new Map(); // cashier → rates[]
  for (const r of baseRows) {
    if (!(Number(r.inv) > 0)) continue; // no invoice money → no rate sample
    const rate = (Number(r.disc) / Number(r.inv)) * 100;
    let arr = baseline.get(String(r.cashier));
    if (!arr) { arr = []; baseline.set(String(r.cashier), arr); }
    arr.push(rate);
  }

  const findings = [];
  for (const r of dayRows) {
    if (!(Number(r.inv) > 0)) continue;
    const rates = baseline.get(String(r.cashier)) || [];
    if (rates.length < MIN_SAMPLES) continue; // insufficient history — skip
    const dayRate = (Number(r.disc) / Number(r.inv)) * 100;
    const med = median(rates);
    const spread = mad(rates, med);
    if (dayRate > med + 3 * spread && dayRate - med > RATE_FLOOR_PP) {
      findings.push({
        subject: String(r.cashier),
        value: _r2(dayRate),
        baseline: _r2(med),
        detail: `نسبة خصم ${_r2(dayRate)}% مقابل وسيط ${_r2(med)}% (MAD ${_r2(spread)}, عينات ${rates.length}) — خصومات ${_r2(r.disc)} من ${_r2(r.inv)}`,
      });
    }
  }
  return findings;
}

// ── rules: void_spike / return_spike (same pattern, on counts) ───────────────

/**
 * Shared count-spike scan. dayExpr/baseExpr select the counted event per
 * cashier; activity (≥1 non-CN order fact) defines whether a baseline day is
 * a sample — a day the cashier didn't work is NOT an honest zero.
 */
async function runCountSpike(db, { branchId, businessDay }, countCase, label) {
  const [dayRows] = await db.query(
    `SELECT f.created_by AS cashier,
            SUM(${countCase}) AS hits,
            SUM(CASE WHEN ${NOT_CN} THEN 1 ELSE 0 END) AS activity
       FROM analytics_order_facts f
      WHERE f.branch_id = ? AND f.business_day = ? AND f.created_by IS NOT NULL
      GROUP BY f.created_by`,
    [branchId, businessDay]);
  const hot = dayRows.filter((r) => Number(r.hits) >= COUNT_FLOOR);
  if (!hot.length) return [];

  const baseDays = trailingSameWeekday(businessDay);
  const [baseRows] = await db.query(
    `SELECT f.created_by AS cashier, f.business_day AS d,
            SUM(${countCase}) AS hits,
            SUM(CASE WHEN ${NOT_CN} THEN 1 ELSE 0 END) AS activity
       FROM analytics_order_facts f
      WHERE f.branch_id = ? AND f.business_day IN (?,?,?,?) AND f.created_by IS NOT NULL
      GROUP BY f.created_by, f.business_day`,
    [branchId, ...baseDays]);
  const baseline = new Map(); // cashier → counts[] on active days
  for (const r of baseRows) {
    if (!(Number(r.activity) > 0)) continue;
    let arr = baseline.get(String(r.cashier));
    if (!arr) { arr = []; baseline.set(String(r.cashier), arr); }
    arr.push(Number(r.hits));
  }

  const findings = [];
  for (const r of hot) {
    const counts = baseline.get(String(r.cashier)) || [];
    if (counts.length < MIN_SAMPLES) continue;
    const dayCount = Number(r.hits);
    const med = median(counts);
    const spread = mad(counts, med);
    if (dayCount > med + 3 * spread) {
      findings.push({
        subject: String(r.cashier),
        value: dayCount,
        baseline: _r2(med),
        detail: `${label}: ${dayCount} مقابل وسيط ${_r2(med)} (MAD ${_r2(spread)}, عينات ${counts.length})`,
      });
    }
  }
  return findings;
}

// ── rule: till_variance ──────────────────────────────────────────────────────

async function runTillVariance(db, { branchId, businessDay, thresholds }) {
  const t = thresholds || {};
  const absT = Number.isFinite(Number(t.tillAbs)) ? Number(t.tillAbs) : 20;
  const pctT = Number.isFinite(Number(t.tillPct)) ? Number(t.tillPct) : 2;
  const [[agg]] = await db.query(
    `SELECT
        COALESCE(SUM(CASE WHEN movement_type = 'open_float'  THEN amount ELSE 0 END), 0) AS open_float,
        COALESCE(SUM(CASE WHEN movement_type = 'cash_sale'   THEN amount ELSE 0 END), 0) AS cash_sale,
        COALESCE(SUM(CASE WHEN movement_type = 'cash_refund' THEN amount ELSE 0 END), 0) AS cash_refund,
        COALESCE(SUM(CASE WHEN movement_type = 'pay_in'      THEN amount ELSE 0 END), 0) AS pay_in,
        COALESCE(SUM(CASE WHEN movement_type = 'pay_out'     THEN amount ELSE 0 END), 0) AS pay_out,
        COALESCE(SUM(CASE WHEN movement_type = 'deposit'     THEN amount ELSE 0 END), 0) AS deposit,
        COALESCE(SUM(CASE WHEN movement_type = 'close_count' THEN amount ELSE 0 END), 0) AS close_amt,
        COALESCE(SUM(movement_type = 'close_count'), 0) AS close_rows
       FROM analytics_till_facts
      WHERE branch_id = ? AND business_day = ?`,
    [branchId, businessDay]);
  if (!agg || Number(agg.close_rows) === 0) return []; // nothing counted — no variance to measure

  // deposit is an OUTFLOW (merge-owner ruling) — folded into payOuts.
  const expected = equations.expectedCash(
    agg.open_float, agg.cash_sale, agg.cash_refund, agg.pay_in,
    Number(agg.pay_out) + Number(agg.deposit));
  const counted = equations.roundMoney(agg.close_amt);
  const variance = equations.tillVariance(counted, expected);
  const threshold = Math.max(absT, (pctT / 100) * Math.abs(expected));
  if (Math.abs(variance) <= threshold) return [];
  return [{
    subject: 'till',
    value: variance,
    baseline: expected,
    detail: `فرق الصندوق ${variance} (المعدود ${counted} مقابل المتوقع ${expected}؛ الحد ${equations.roundMoney(threshold)} = max(${absT}, ${pctT}% × المتوقع))`,
  }];
}

// ── rule: late_offline_sync ──────────────────────────────────────────────────

async function runLateOfflineSync(db, { branchId, businessDay }) {
  const [rows] = await db.query(
    `SELECT f.document_id, TIMESTAMPDIFF(MINUTE, f.opened_at, f.paid_at) AS lag_min
       FROM analytics_order_facts f
      WHERE f.branch_id = ? AND f.business_day = ? AND f.origin = 'offline'
        AND f.opened_at IS NOT NULL AND f.paid_at IS NOT NULL
        AND f.paid_at > DATE_ADD(f.opened_at, INTERVAL ${OFFLINE_LAG_MIN} MINUTE)
      ORDER BY f.document_id`,
    [branchId, businessDay]);
  return rows.map((r) => ({
    subject: String(r.document_id),
    value: Number(r.lag_min),
    baseline: OFFLINE_LAG_MIN,
    detail: `فاتورة أوفلاين تأخر سدادها ${r.lag_min} دقيقة عن فتح الطلب (الحد ${OFFLINE_LAG_MIN} دقيقة)`,
  }));
}

// ── rule: projection_drift ───────────────────────────────────────────────────

async function runProjectionDrift(db, { branchId, businessDay }) {
  // 'UNASSIGNED' facts come from sales with NULL branch_id (ProjectionService).
  const regBranch = branchId === 'UNASSIGNED' ? 's.branch_id IS NULL' : 's.branch_id = ?';
  const regParams = branchId === 'UNASSIGNED' ? [businessDay] : [branchId, businessDay];
  const [[reg]] = await db.query(
    `SELECT COUNT(*) AS c, COALESCE(SUM(s.total_final), 0) AS t
       FROM sales s
      WHERE ${regBranch} AND DATE(s.order_date) = ?
        AND (s.zatca_type IS NULL OR s.zatca_type <> 'cancellation')`,
    regParams);
  const [[fac]] = await db.query(
    `SELECT COUNT(*) AS c, COALESCE(SUM(s.total_final), 0) AS t
       FROM analytics_order_facts f
       JOIN sales s ON s.id = f.sale_id
      WHERE f.branch_id = ? AND DATE(s.order_date) = ?
        AND f.source = 'pos' AND f.status <> 'voided'`,
    [branchId, businessDay]);

  const drift = equations.roundMoney(Number(fac.t) - Number(reg.t));
  const cntDelta = Number(fac.c) - Number(reg.c);
  if (Math.abs(drift) <= DRIFT_EPS && cntDelta === 0) return [];
  return [{
    subject: 'projection',
    value: equations.roundMoney(fac.t),
    baseline: equations.roundMoney(reg.t),
    detail: `انحراف الإسقاط: السجل ${equations.roundMoney(reg.t)} (${reg.c} عملية) مقابل الحقائق ${equations.roundMoney(fac.t)} (${fac.c}) — فرق ${drift}، فرق العدد ${cntDelta}. شغّل backfill أو صرّف analytics_projection_repair.`,
  }];
}

// ── the catalog ──────────────────────────────────────────────────────────────

const RULES = Object.freeze([
  {
    id: 'discount_rate_spike', severity: 'medium', category: 'behavioral',
    title: 'ارتفاع غير معتاد في نسبة الخصم لكاشير',
    run: runDiscountRateSpike,
  },
  {
    id: 'void_spike', severity: 'medium', category: 'behavioral',
    title: 'ارتفاع غير معتاد في عمليات الإلغاء لكاشير',
    run: (db, ctx) => runCountSpike(db, ctx, "CASE WHEN f.status = 'voided' THEN 1 ELSE 0 END", 'إلغاءات'),
  },
  {
    id: 'return_spike', severity: 'medium', category: 'behavioral',
    title: 'ارتفاع غير معتاد في المرتجعات لكاشير',
    run: (db, ctx) => runCountSpike(db, ctx, `CASE WHEN ${IS_CN} THEN 1 ELSE 0 END`, 'مرتجعات'),
  },
  {
    id: 'till_variance', severity: 'high', category: 'financial',
    title: 'فرق صندوق يتجاوز الحد المسموح',
    run: runTillVariance,
  },
  {
    id: 'late_offline_sync', severity: 'low', category: 'operational',
    title: 'مزامنة أوفلاين متأخرة',
    run: runLateOfflineSync,
  },
  {
    id: 'projection_drift', severity: 'high', category: 'operational',
    title: 'انحراف بين سجل المبيعات وحقائق التحليلات',
    run: runProjectionDrift,
  },
]);

module.exports = {
  RULES,
  trailingSameWeekday,
  MIN_SAMPLES,
  RATE_FLOOR_PP,
  COUNT_FLOOR,
  OFFLINE_LAG_MIN,
  DRIFT_EPS,
};
