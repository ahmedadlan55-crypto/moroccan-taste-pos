/**
 * Warehouse Reports + Analytics — Phase 2B (READ-ONLY).
 *
 * Mounted under /api/inventory (so the Phase 2A.2 scope middleware's
 * req.guardWh / req.whScopeClause / req.warehouseScope are available). Every
 * endpoint is a pure SELECT returning the standard envelope and respecting the
 * warehouse scope on rows, totals AND export. No mutations.
 *
 * Honesty rules (data findings): value at warehouse WAC with a fallback flag;
 * NO reserved stock / barcode / real COGS-turnover (columns don't exist);
 * expiry + aging come from purchase_lots and are flagged تقديري when coverage
 * is low; orphan (NULL warehouse_id) rows surface only in the admin
 * data-quality report.
 */
'use strict';

const router = require('express').Router();
const db = require('../db/connection');
const INV = require('../lib/inventoryReporting');
const RC = require('../lib/reportContract');
const CSV = require('../lib/csvExport');

// Warehouse WAC with global-cost fallback (matches lib/inventoryReporting and
// the dashboard/grid endpoints, so values reconcile across the app).
const VALUE_EXPR = 'COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0)';
const ACTIVE = 'i.active = 1 AND i.deleted_at IS NULL';

function _generatedAt() { return new Date().toISOString(); }

function _scopeInfo(req) {
  const s = req.warehouseScope || { all: true, warehouseIds: [] };
  return { allWarehousesAccess: !!s.all, warehouseId: req.query.warehouseId || null };
}

// Push the injection-safe scope IN(...) fragment onto a where[]/params[] pair.
// Returns true if a restriction was added (used to detect "no access").
function _scopeWhere(req, column, where, params) {
  const sc = req.whScopeClause ? req.whScopeClause(column) : { sql: '', params: [] };
  if (sc.sql) { where.push(sc.sql.replace(/^\s*AND\s+/i, '')); params.push(...sc.params); }
}

// Per-warehouse aggregate — byte-for-byte the dashboard's _warehousesSummary
// logic (active-item gated) so analytics totals reconcile with dashboard/grid.
async function _perWarehouse(req) {
  const where = [];
  const params = [];
  _scopeWhere(req, 'w.id', where, params);
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const [rows] = await db.query(
    `SELECT w.id, w.name, w.code, w.type, w.location, w.manager, w.is_active,
            COUNT(DISTINCT i.id) AS item_count,
            COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0 THEN ws.qty ELSE 0 END), 0) AS total_qty,
            COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0 THEN ws.qty * ${VALUE_EXPR} ELSE 0 END), 0) AS total_value,
            COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0 AND (COALESCE(NULLIF(ws.avg_cost,0),0) = 0) THEN ws.qty * i.cost ELSE 0 END), 0) AS estimated_value,
            SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0 AND (i.min_stock <= 0 OR ws.qty > i.min_stock) THEN 1 ELSE 0 END) AS available_count,
            SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0 AND i.min_stock > 0 AND ws.qty <= i.min_stock THEN 1 ELSE 0 END) AS low_count,
            SUM(CASE WHEN i.id IS NOT NULL AND ws.qty = 0 AND ws.first_added_date IS NOT NULL THEN 1 ELSE 0 END) AS out_count,
            SUM(CASE WHEN i.id IS NOT NULL AND ws.qty < 0 THEN 1 ELSE 0 END) AS negative_count
       FROM warehouses w
       LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
       LEFT JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL
       ${whereSql}
      GROUP BY w.id, w.name, w.code, w.type, w.location, w.manager, w.is_active
      ORDER BY w.is_main DESC, w.code`, params);
  return rows;
}

// ── GET /api/inventory/analytics/summary ────────────────────────────────────
// The whole analytics payload in ONE call (no N+1). Honors warehouse scope +
// optional ?warehouseId, ?category, ?type, ?window, ?from, ?to.
router.get('/analytics/summary', async (req, res) => {
  try {
    const filters = RC.parseReportFilters(req.query, 'movements');
    if (filters.warehouseId && !req.guardWh(res, filters.warehouseId)) return;
    const warnings = [];

    // 1) KPIs + value-by-warehouse + comparison (reconciles with dashboard).
    const whRows = await _perWarehouse(req);
    const warehouses = whRows.map((r) => {
      const dto = INV.mapWarehouseRow(r);
      dto.availableCount = Number(r.available_count) || 0;
      dto.estimatedValue = Math.round((Number(r.estimated_value) || 0) * 100) / 100;
      return dto;
    });
    const totals = INV.summarizeWarehouses(warehouses);
    const estimatedCostValue = Math.round(warehouses.reduce((s, w) => s + (w.estimatedValue || 0), 0) * 100) / 100;
    const availableCount = warehouses.reduce((s, w) => s + (w.availableCount || 0), 0);

    // Helper to build a scoped value/category/item query body.
    function scopedWhere(col) {
      const where = [ACTIVE, 'ws.qty IS NOT NULL'];
      const params = [];
      _scopeWhere(req, col, where, params);
      return { where, params };
    }

    // 2) Value by category.
    const cat = scopedWhere('ws.warehouse_id');
    const [catRows] = await db.query(
      `SELECT COALESCE(NULLIF(i.category,''),'(غير مصنّف)') AS category,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * ${VALUE_EXPR} ELSE 0 END),0) AS value,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty ELSE 0 END),0) AS qty,
              COUNT(DISTINCT i.id) AS items
         FROM warehouse_stock ws
         JOIN inv_items i ON i.id = ws.item_id
        WHERE ${cat.where.join(' AND ')}
        GROUP BY COALESCE(NULLIF(i.category,''),'(غير مصنّف)')
        HAVING value > 0
        ORDER BY value DESC`, cat.params);
    const valueByCategory = catRows.map((r) => ({ category: String(r.category), value: Math.round((Number(r.value) || 0) * 100) / 100, qty: Number(r.qty) || 0, items: Number(r.items) || 0 }));

    // 3) Top items by value.
    const top = scopedWhere('ws.warehouse_id');
    const [topRows] = await db.query(
      `SELECT i.id AS item_id, i.name, i.category, i.unit,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * ${VALUE_EXPR} ELSE 0 END),0) AS value,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty ELSE 0 END),0) AS qty
         FROM warehouse_stock ws
         JOIN inv_items i ON i.id = ws.item_id
        WHERE ${top.where.join(' AND ')}
        GROUP BY i.id, i.name, i.category, i.unit
        HAVING value > 0
        ORDER BY value DESC
        LIMIT 10`, top.params);
    const topItemsByValue = topRows.map((r) => ({ itemId: String(r.item_id), name: String(r.name), category: String(r.category || ''), unit: String(r.unit || ''), qty: Number(r.qty) || 0, value: Math.round((Number(r.value) || 0) * 100) / 100 }));

    // 4) Movement trend (in/out). Default: last 30 days; group by day (≤92d) or week.
    const mWhere = [];
    const mParams = [];
    _scopeWhere(req, 'm.warehouse_id', mWhere, mParams);
    const dr = RC.riyadhDateRange('m.movement_date', filters.from, filters.to);
    if (dr.sql) { mWhere.push(dr.sql.replace(/^\s*AND\s+/i, '')); mParams.push(...dr.params); }
    else { mWhere.push('m.movement_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)'); }
    if (filters.type === 'in' || filters.type === 'out') { mWhere.push('m.type = ?'); mParams.push(filters.type); }
    const spanDays = (filters.from && filters.to) ? (Math.round((Date.parse(filters.to) - Date.parse(filters.from)) / 86400000)) : 30;
    const bucket = spanDays > 92 ? "DATE_FORMAT(m.movement_date,'%x-W%v')" : 'DATE(m.movement_date)';
    const [trendRows] = await db.query(
      `SELECT ${bucket} AS bucket, m.type, COALESCE(SUM(m.qty),0) AS qty, COUNT(*) AS n
         FROM inventory_movements m
        WHERE ${mWhere.join(' AND ')}
        GROUP BY bucket, m.type
        ORDER BY bucket`, mParams);
    const trendMap = {};
    trendRows.forEach((r) => {
      const k = String(r.bucket);
      if (!trendMap[k]) trendMap[k] = { bucket: k, in: 0, out: 0 };
      if (r.type === 'in') trendMap[k].in = Number(r.qty) || 0;
      else if (r.type === 'out') trendMap[k].out = Number(r.qty) || 0;
    });
    const movementTrend = Object.values(trendMap);

    // 5) Slow / no-movement count (items holding stock, no movement in window).
    const slWhere = [ACTIVE];
    const slParams = [];
    _scopeWhere(req, 'ws.warehouse_id', slWhere, slParams);
    const subWhere = [];
    const subParams = [];
    _scopeWhere(req, 'mm.warehouse_id', subWhere, subParams);
    const subScope = subWhere.length ? ' AND ' + subWhere.join(' AND ') : '';
    const [[slowRow]] = await db.query(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT i.id,
                COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty ELSE 0 END),0) AS qty,
                (SELECT MAX(mm.movement_date) FROM inventory_movements mm WHERE mm.item_id = i.id${subScope}) AS last_mv
           FROM warehouse_stock ws
           JOIN inv_items i ON i.id = ws.item_id
          WHERE ${slWhere.join(' AND ')}
          GROUP BY i.id
       ) t
       WHERE qty > 0 AND (last_mv IS NULL OR last_mv < DATE_SUB(NOW(), INTERVAL ? DAY))`,
      slParams.concat(subParams, [filters.window]));
    const slowNoMovement = { window: filters.window, count: Number(slowRow.cnt) || 0 };

    // 6) Transfers: pending / in-transit + remaining-to-receive.
    const tWhere = [];
    const tParams = [];
    const sf = req.whScopeClause ? req.whScopeClause('from_warehouse_id') : { sql: '', params: [] };
    const st = req.whScopeClause ? req.whScopeClause('to_warehouse_id') : { sql: '', params: [] };
    if (sf.sql) { tWhere.push('(' + sf.sql.replace(/^\s*AND\s+/i, '') + ' OR ' + st.sql.replace(/^\s*AND\s+/i, '') + ')'); tParams.push(...sf.params, ...st.params); }
    let transfers = { pending: 0, inTransit: 0, byStatus: {}, remainingQty: 0 };
    try {
      const [trows] = await db.query('SELECT status, COUNT(*) AS n FROM stock_issues' + (tWhere.length ? ' WHERE ' + tWhere.join(' AND ') : '') + ' GROUP BY status', tParams);
      const tc = INV.transferCounts(trows);
      // Remaining-to-receive = Σ(qty_issued − qty_received) for in-transit, scoped on destination.
      const rWhere = ["si.status IN ('issued','partially_received')"];
      const rParams = [];
      _scopeWhere(req, 'si.to_warehouse_id', rWhere, rParams);
      const [[rem]] = await db.query(
        `SELECT COALESCE(SUM(GREATEST(sii.qty_issued - sii.qty_received, 0)),0) AS remaining
           FROM stock_issue_items sii JOIN stock_issues si ON si.id = sii.issue_id
          WHERE ${rWhere.join(' AND ')}`, rParams);
      transfers = { pending: tc.pending, inTransit: tc.inTransit, byStatus: tc.byStatus, remainingQty: Number(rem.remaining) || 0 };
    } catch (_) { /* stock_issues variants */ }

    // 7) Data-quality indicators (counts only; the detail report is admin-gated).
    const dq = scopedWhere('ws.warehouse_id');
    const [[dqRow]] = await db.query(
      `SELECT SUM(CASE WHEN ws.qty > 0 AND COALESCE(NULLIF(ws.avg_cost,0),0) = 0 THEN 1 ELSE 0 END) AS estimated_cost_items,
              SUM(CASE WHEN i.min_stock <= 0 THEN 1 ELSE 0 END) AS missing_min_stock
         FROM warehouse_stock ws JOIN inv_items i ON i.id = ws.item_id
        WHERE ${dq.where.join(' AND ')}`, dq.params);
    // Expiry coverage → flag تقديري when few items that hold stock have lots.
    let expiryCoverage = { lots: 0, covered: 0, reliable: true };
    try {
      const eWhere = [];
      const eParams = [];
      _scopeWhere(req, 'warehouse_id', eWhere, eParams);
      const [[lc]] = await db.query('SELECT COUNT(*) AS lots, COUNT(DISTINCT inv_item_id) AS items FROM purchase_lots WHERE qty_remaining > 0' + (eWhere.length ? ' AND ' + eWhere.join(' AND ') : ''), eParams);
      expiryCoverage = { lots: Number(lc.lots) || 0, covered: Number(lc.items) || 0, reliable: (Number(lc.lots) || 0) > 0 };
      if (!expiryCoverage.reliable) RC.pushWarning(warnings, 'EXPIRY_LOW_COVERAGE', 'لا توجد طبقات استلام (purchase_lots) كافية — تقارير انتهاء الصلاحية والتقادم تقديرية.', 'warning');
    } catch (_) {}
    const dataQualityIndicators = {
      estimatedCostItems: Number(dqRow && dqRow.estimated_cost_items) || 0,
      missingMinStock: Number(dqRow && dqRow.missing_min_stock) || 0,
      expiryCoverage,
    };
    if (dataQualityIndicators.estimatedCostItems > 0) RC.pushWarning(warnings, 'COST_ESTIMATED', dataQualityIndicators.estimatedCostItems + ' صنف مُقيّم بتكلفة عامة تقديرية (لا يوجد WAC للمستودع).', 'info');

    res.json(RC.envelope({
      data: {
        kpis: {
          inventoryValueWac: totals.totalValue,
          estimatedCostValue,
          itemCount: totals.itemCount,
          totalQty: totals.totalQty,
          availableCount,
          lowCount: totals.lowCount,
          outCount: totals.outCount,
          negativeCount: totals.negativeCount,
          activeWarehouses: totals.activeCount,
        },
        valueByWarehouse: warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code, value: w.totalValue, qty: w.totalQty })),
        warehouseComparison: warehouses,
        valueByCategory,
        topItemsByValue,
        movementTrend,
        slowNoMovement,
        transfers,
        dataQualityIndicators,
      },
      totals: { inventoryValueWac: totals.totalValue, estimatedCostValue, itemCount: totals.itemCount },
      filters: { warehouseId: filters.warehouseId, from: filters.from, to: filters.to, category: filters.category, type: filters.type, window: filters.window },
      scope: _scopeInfo(req),
      generatedAt: _generatedAt(),
      dataQualityWarnings: warnings,
    }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/inventory/reports/catalog ──────────────────────────────────────
router.get('/reports/catalog', async (req, res) => {
  res.json(RC.envelope({
    data: RC.REPORT_TYPES.map((type) => ({ type, label: RC.REPORT_LABELS[type], adminOnly: type === 'data-quality' })),
    scope: _scopeInfo(req),
    generatedAt: _generatedAt(),
  }));
});

module.exports = router;
