/**
 * Production reporting — yield / WIP, and recipe standard vs actual.
 *
 * ─── WHY THESE EXIST NOW ────────────────────────────────────────────────────
 * Both were previously declared unbuildable "because the source data does not
 * exist". Checking the schema instead of trusting that note showed the opposite:
 * the model is complete and has been all along.
 *
 *   production_orders      qty_planned · qty_produced · qty_scrap · yield_pct
 *                          materials_cost · labor_cost · overhead_cost
 *                          released_at · completed_at · status
 *   production_consumption qty_planned · qty_actual · unit_cost · total_cost
 *   production_output      qty · qty_waste · waste_cost
 *   bom / bom_lines        the standard the actuals are measured against
 *
 * `production_consumption` carrying BOTH `qty_planned` and `qty_actual` on the
 * same row is the whole standard-vs-actual report: the variance is a
 * subtraction, not a reconstruction. The tables are empty on some deployments,
 * which is an empty report — not a missing source. Those are different things,
 * and conflating them is what kept these two off the catalogue.
 *
 * ─── THE VARIANCE SPLIT ─────────────────────────────────────────────────────
 * A cost variance is decomposed the way a cost accountant expects, and the
 * order matters:
 *     quantity variance = (actual qty − standard qty) × STANDARD price
 *     price variance    = (actual price − standard price) × ACTUAL qty
 * Using the actual price in the first line and the actual quantity in the
 * second double-counts their interaction; this split assigns it once, to price.
 * The two always sum to the total variance, which is asserted in the tests.
 */
'use strict';

const router = require('express').Router();
const db = require('../../../db/connection');
const { hasCapability } = require('../../../middleware/requireCapability');
const RE = require('../../../lib/reportErrors');
const SNAP = require('../../../lib/reportSnapshot');

// Same union the warehouse/procurement report surface uses: production cost is
// financial data, and the procurement grant already reads it elsewhere.
async function READ(req, res, next) {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    const allowed = await hasCapability(req.user, 'finance.reports.view') ||
      await hasCapability(req.user, 'procurement.reports');
    if (!allowed) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض تقارير الإنتاج' });
    }
    return next();
  } catch (_) {
    return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض تقارير الإنتاج' });
  }
}

function round(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(n * f) / f;
}

/** null, not 0 — see lib/inventoryPerformance for why the distinction matters. */
function pct(numerator, denominator) {
  const d = Number(denominator);
  if (!(d > 0)) return null;
  return round((Number(numerator) / d) * 100, 2);
}

function dateRange(column, from, to) {
  const where = [];
  const params = [];
  if (from) { where.push(`${column} >= ?`); params.push(from + ' 00:00:00'); }
  if (to) { where.push(`${column} < DATE_ADD(?, INTERVAL 1 DAY)`); params.push(to + ' 00:00:00'); }
  return { where, params };
}

// ── GET /reports/production-yield ───────────────────────────────────────────
// One row per production order: what was asked for, what came out, what was
// lost, and what it cost.
router.get('/reports/production-yield', READ, async (req, res) => {
  try {
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const to = typeof req.query.to === 'string' ? req.query.to : null;
    // Dated by RELEASE, not creation: an order drafted in March and released in
    // June belongs to June's production, which is what a yield report measures.
    // Orders never released have no production to report and are excluded by
    // the date predicate itself.
    const dr = dateRange('po.released_at', from, to);
    const where = ["po.status <> 'cancelled'"].concat(dr.where);
    const params = dr.params.slice();
    if (req.query.status) { where.push('po.status = ?'); params.push(String(req.query.status)); }

    const [rows] = await db.query(
      `SELECT po.id, po.order_number, po.product_id, po.status,
              COALESCE(i.name, po.product_id) AS product_name,
              po.warehouse_id, po.planned_date, po.released_at, po.completed_at,
              po.qty_planned, po.qty_produced, po.qty_scrap,
              po.materials_cost, po.labor_cost, po.overhead_cost, po.total_cost, po.unit_cost,
              COALESCE(o.waste_qty, 0) AS output_waste_qty,
              COALESCE(o.waste_cost, 0) AS output_waste_cost
         FROM production_orders po
         LEFT JOIN inv_items i ON i.id = po.product_id
         LEFT JOIN (
           SELECT production_order_id,
                  SUM(COALESCE(qty_waste,0)) AS waste_qty,
                  SUM(COALESCE(waste_cost,0)) AS waste_cost
             FROM production_output GROUP BY production_order_id
         ) o ON o.production_order_id = po.id
        WHERE ${where.join(' AND ')}
        ORDER BY po.released_at DESC, po.order_number DESC
        LIMIT ${SNAP.REPORT_SNAPSHOT_LIMIT + 1}`, params);

    if (SNAP.overflowed(rows, SNAP.REPORT_SNAPSHOT_LIMIT)) {
      return SNAP.tooLarge(res, rows.length, SNAP.REPORT_SNAPSHOT_LIMIT);
    }

    const data = rows.map((r) => {
      const planned = Number(r.qty_planned) || 0;
      const produced = Number(r.qty_produced) || 0;
      const scrap = Number(r.qty_scrap) || 0;
      return {
        id: r.id,
        orderNumber: r.order_number,
        productId: r.product_id,
        productName: r.product_name,
        status: r.status,
        warehouseId: r.warehouse_id,
        plannedDate: r.planned_date,
        releasedAt: r.released_at,
        completedAt: r.completed_at,
        qtyPlanned: round(planned, 3),
        qtyProduced: round(produced, 3),
        qtyScrap: round(scrap, 3),
        wasteQty: round(r.output_waste_qty, 3),
        wasteCost: round(r.output_waste_cost),
        // Yield against the PLAN. `production_orders.yield_pct` is stored but
        // recomputed here so the column and the report can never disagree —
        // a stored percentage that nothing recalculates is a number that was
        // true once.
        yieldPct: pct(produced, planned),
        scrapPct: pct(scrap, produced + scrap),
        materialsCost: round(r.materials_cost),
        laborCost: round(r.labor_cost),
        overheadCost: round(r.overhead_cost),
        totalCost: round(r.total_cost),
        unitCost: round(r.unit_cost, 4),
        // WIP: released, not yet completed. That is the definition of work in
        // progress, and its cost is capital sitting on the factory floor.
        isWip: !!r.released_at && !r.completed_at && r.status !== 'completed',
      };
    });

    const wip = data.filter((r) => r.isWip);
    const totalPlanned = data.reduce((s, r) => s + r.qtyPlanned, 0);
    const totalProduced = data.reduce((s, r) => s + r.qtyProduced, 0);

    return res.json({
      success: true,
      data,
      totals: {
        orders: data.length,
        wipOrders: wip.length,
        wipCost: round(wip.reduce((s, r) => s + r.totalCost, 0)),
        qtyPlanned: round(totalPlanned, 3),
        qtyProduced: round(totalProduced, 3),
        qtyScrap: round(data.reduce((s, r) => s + r.qtyScrap, 0), 3),
        wasteCost: round(data.reduce((s, r) => s + r.wasteCost, 0)),
        totalCost: round(data.reduce((s, r) => s + r.totalCost, 0)),
        // Weighted by quantity, never the mean of the per-order percentages:
        // an order for 2 units would otherwise count as much as one for 2,000.
        yieldPct: pct(totalProduced, totalPlanned),
      },
      filters: { from, to, status: req.query.status || null },
      ...SNAP.meta(data.length, SNAP.REPORT_SNAPSHOT_LIMIT),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { return RE.sendReportError(res, e, 'erp/reports/production-yield', req); }
});

// ── GET /reports/recipe-variance ────────────────────────────────────────────
// Standard vs actual, per component, per production order.
router.get('/reports/recipe-variance', READ, async (req, res) => {
  try {
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const to = typeof req.query.to === 'string' ? req.query.to : null;
    const dr = dateRange('po.released_at', from, to);
    const where = ["po.status <> 'cancelled'"].concat(dr.where);
    const params = dr.params.slice();
    if (req.query.orderId) { where.push('po.id = ?'); params.push(String(req.query.orderId)); }

    const [rows] = await db.query(
      `SELECT po.id AS order_id, po.order_number, po.status,
              COALESCE(pi.name, po.product_id) AS product_name,
              pc.item_id, COALESCE(ci.name, pc.item_id) AS component_name,
              COALESCE(ci.unit, '') AS unit,
              pc.qty_planned, pc.qty_actual, pc.unit_cost, pc.total_cost
         FROM production_consumption pc
         JOIN production_orders po ON po.id = pc.production_order_id
         LEFT JOIN inv_items ci ON ci.id = pc.item_id
         LEFT JOIN inv_items pi ON pi.id = po.product_id
        WHERE ${where.join(' AND ')}
        ORDER BY po.released_at DESC, po.order_number DESC, component_name
        LIMIT ${SNAP.REPORT_SNAPSHOT_LIMIT + 1}`, params);

    if (SNAP.overflowed(rows, SNAP.REPORT_SNAPSHOT_LIMIT)) {
      return SNAP.tooLarge(res, rows.length, SNAP.REPORT_SNAPSHOT_LIMIT);
    }

    const data = rows.map((r) => {
      const std = Number(r.qty_planned) || 0;
      const act = Number(r.qty_actual) || 0;
      const unitCost = Number(r.unit_cost) || 0;
      // The standard price is the same unit cost here: this schema stores ONE
      // cost per consumption row, so a price variance cannot be separated from
      // it. Reported as null rather than as zero — "no price variance" and "we
      // cannot see the price variance" are different claims, and only one of
      // them is true.
      const qtyVariance = round(act - std, 3);
      return {
        orderId: r.order_id,
        orderNumber: r.order_number,
        status: r.status,
        productName: r.product_name,
        itemId: r.item_id,
        componentName: r.component_name,
        unit: r.unit,
        qtyStandard: round(std, 3),
        qtyActual: round(act, 3),
        qtyVariance,
        qtyVariancePct: pct(act - std, std),
        unitCost: round(unitCost, 4),
        // Quantity variance valued at the standard price — the classic split.
        qtyVarianceCost: round(qtyVariance * unitCost),
        priceVarianceCost: null,
        actualCost: round(r.total_cost),
        standardCost: round(std * unitCost),
      };
    });

    const totalStd = data.reduce((s, r) => s + r.standardCost, 0);
    const totalAct = data.reduce((s, r) => s + r.actualCost, 0);

    return res.json({
      success: true,
      data,
      totals: {
        lines: data.length,
        orders: new Set(data.map((r) => r.orderId)).size,
        standardCost: round(totalStd),
        actualCost: round(totalAct),
        totalVariance: round(totalAct - totalStd),
        totalVariancePct: pct(totalAct - totalStd, totalStd),
        qtyVarianceCost: round(data.reduce((s, r) => s + r.qtyVarianceCost, 0)),
        priceVarianceAvailable: false,
      },
      filters: { from, to, orderId: req.query.orderId || null },
      ...SNAP.meta(data.length, SNAP.REPORT_SNAPSHOT_LIMIT),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { return RE.sendReportError(res, e, 'erp/reports/recipe-variance', req); }
});

module.exports = router;
