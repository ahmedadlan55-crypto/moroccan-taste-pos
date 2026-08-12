/**
 * Warehouse Reports + Analytics — Phase 2B (READ-ONLY).
 *
 * Mounted under /api/inventory after warehouse scope resolution. Financial
 * reports deliberately enforce req.warehouseScope themselves, independently
 * from the operational rollout switch, on rows, totals AND export.
 *
 * Honesty rules (data findings): value at warehouse WAC with a fallback flag;
 * NO reserved stock / barcode / real COGS-turnover (columns don't exist);
 * expiry comes from the canonical lot ledger and is explicitly non-authoritative
 * when quantity coverage is incomplete; orphan (NULL warehouse_id) rows surface only in the admin
 * data-quality report.
 */
'use strict';

const router = require('express').Router();
const db = require('../db/connection');
const INV = require('../lib/inventoryReporting');
const RC = require('../lib/reportContract');
const CSV = require('../lib/csvExport');
const STRICT_SCOPE = require('../lib/warehouseIntelligenceScope');
const MOVEMENT = require('../lib/inventoryMovementSemantics');
const { hasCapability } = require('../middleware/requireCapability');

// Warehouse WAC with global-cost fallback (matches lib/inventoryReporting and
// the dashboard/grid endpoints, so values reconcile across the app).
const VALUE_EXPR = 'COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0)';
const ACTIVE = 'i.active = 1 AND i.deleted_at IS NULL';

function _generatedAt() { return new Date().toISOString(); }

function _scopeInfo(req) {
  const s = STRICT_SCOPE.publicScope(req.warehouseScope);
  return { allWarehousesAccess: !!s.all, warehouseId: req.query.warehouseId || null };
}

async function READ(req, res, next) {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    const allowed = await hasCapability(req.user, 'finance.reports.view') ||
      await hasCapability(req.user, 'procurement.reports');
    if (!allowed) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض تقارير المستودعات والمشتريات' });
    }
    return next();
  } catch (_) {
    return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض تقارير المستودعات والمشتريات' });
  }
}

function _guardRequestedWarehouse(req, res, warehouseId) {
  if (!warehouseId || STRICT_SCOPE.canReadWarehouse(req.warehouseScope, warehouseId)) return true;
  res.status(403).json({ success: false, code: 'WAREHOUSE_ACCESS_DENIED', error: 'لا تملك صلاحية الوصول إلى هذا المستودع.' });
  return false;
}

// Push the injection-safe scope IN(...) fragment onto a where[]/params[] pair.
// Returns true if a restriction was added (used to detect "no access").
function _scopeWhere(req, column, where, params) {
  STRICT_SCOPE.append(req.warehouseScope, column, where, params, req._reportWarehouseId);
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
            SUM(CASE WHEN i.id IS NOT NULL AND ws.qty < 0 THEN 1 ELSE 0 END) AS negative_count,
            COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND ws.qty < 0 THEN ws.qty * ${VALUE_EXPR} ELSE 0 END), 0) AS negative_value
       FROM warehouses w
       LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
       LEFT JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL
       ${whereSql}
      GROUP BY w.id, w.name, w.code, w.type, w.location, w.manager, w.is_active
      ORDER BY w.is_main DESC, w.code`, params);
  return rows;
}

// Coverage for the canonical lot ledger. A position is complete only when the
// expiry-tracked lot quantity reconciles to warehouse_stock; merely having one
// lot row is not enough evidence of complete expiry coverage.
async function _expiryLotCoverage(req) {
  const where = [ACTIVE, "i.tracking_mode='expiry'", 'ws.qty > 0'];
  const params = [];
  _scopeWhere(req, 'ws.warehouse_id', where, params);
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS tracked_positions,
            COALESCE(SUM(ws.qty),0) AS tracked_stock_qty,
            SUM(CASE WHEN ABS(ws.qty-COALESCE(lb.expiry_lot_qty,0)) <= 0.001 THEN 1 ELSE 0 END) AS fully_covered_positions,
            COALESCE(SUM(LEAST(ws.qty,GREATEST(COALESCE(lb.expiry_lot_qty,0),0))),0) AS covered_qty,
            COALESCE(SUM(ABS(ws.qty-COALESCE(lb.expiry_lot_qty,0))),0) AS quantity_drift
       FROM warehouse_stock ws
       JOIN inv_items i ON i.id=ws.item_id
       LEFT JOIN (
         SELECT b.warehouse_id,b.item_id,
                SUM(CASE WHEN l.expiry_date IS NOT NULL AND l.lifecycle_status<>'closed' THEN b.qty ELSE 0 END) AS expiry_lot_qty
           FROM warehouse_lot_balances b
           JOIN inventory_lots l ON l.id=b.lot_id
          GROUP BY b.warehouse_id,b.item_id
       ) lb ON lb.warehouse_id=ws.warehouse_id AND lb.item_id=ws.item_id
      WHERE ${where.join(' AND ')}`, params);
  const trackedPositions = Number(row && row.tracked_positions) || 0;
  const fullyCoveredPositions = Number(row && row.fully_covered_positions) || 0;
  const trackedStockQty = Number(row && row.tracked_stock_qty) || 0;
  const coveredQty = Number(row && row.covered_qty) || 0;
  const quantityDrift = Number(row && row.quantity_drift) || 0;
  return {
    source: 'inventory_lots+warehouse_lot_balances',
    trackedPositions,
    fullyCoveredPositions,
    trackedStockQty: _round2(trackedStockQty),
    coveredQty: _round2(coveredQty),
    quantityDrift: _round2(quantityDrift),
    coveragePct: trackedStockQty > 0 ? _round2(Math.min(100, (coveredQty / trackedStockQty) * 100)) : 100,
    complete: trackedPositions === fullyCoveredPositions && Math.abs(quantityDrift) <= 0.001,
  };
}

// ── GET /api/inventory/analytics/summary ────────────────────────────────────
// The whole analytics payload in ONE call (no N+1). Honors warehouse scope +
// optional ?warehouseId, ?category, ?type, ?window, ?from, ?to.
router.get('/analytics/summary', READ, async (req, res) => {
  try {
    const filters = RC.parseReportFilters(req.query, 'movements');
    if (!_guardRequestedWarehouse(req, res, filters.warehouseId)) return;
    req._reportWarehouseId = filters.warehouseId || '';
    const warnings = [];

    // 1) KPIs + value-by-warehouse + comparison (reconciles with dashboard).
    const whRows = await _perWarehouse(req);
    const warehouses = whRows.map((r) => {
      const dto = INV.mapWarehouseRow(r);
      dto.availableCount = Number(r.available_count) || 0;
      dto.estimatedValue = Math.round((Number(r.estimated_value) || 0) * 100) / 100;
      // Value impact of NEGATIVE stock (a negative number) — surfaced as a
      // standalone KPI; it is NOT part of inventoryValueWac (which counts qty>0).
      dto.negativeValue = Math.round((Number(r.negative_value) || 0) * 100) / 100;
      return dto;
    });
    const totals = INV.summarizeWarehouses(warehouses);
    // estimatedCostValue is the SUBSET of inventoryValueWac priced from the
    // global item cost fallback (no per-warehouse WAC) — a component WITHIN the
    // value, never an amount added on top of it.
    const estimatedCostValue = Math.round(warehouses.reduce((s, w) => s + (w.estimatedValue || 0), 0) * 100) / 100;
    const negativeStockValueImpact = Math.round(warehouses.reduce((s, w) => s + (w.negativeValue || 0), 0) * 100) / 100;
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

    // 5) Slow / no-movement count.  Demand consumption only: transfers,
    // stocktakes, adjustments and waste must not reset the clock.
    const slWhere = [ACTIVE];
    const slParams = [];
    _scopeWhere(req, 'ws.warehouse_id', slWhere, slParams);
    const consumption = MOVEMENT.outboundConsumptionSql('mm');
    const subWhere = [];
    const subScopeParams = [];
    _scopeWhere(req, 'mm.warehouse_id', subWhere, subScopeParams);
    const subScope = subWhere.length ? ' AND ' + subWhere.join(' AND ') : '';
    const [[slowRow]] = await db.query(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT i.id,
                COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty ELSE 0 END),0) AS qty,
                (SELECT MAX(mm.movement_date) FROM inventory_movements mm WHERE mm.item_id = i.id AND ${consumption.sql}${subScope}) AS last_mv
           FROM warehouse_stock ws
           JOIN inv_items i ON i.id = ws.item_id
          WHERE ${slWhere.join(' AND ')}
          GROUP BY i.id
       ) t
       WHERE qty > 0 AND (last_mv IS NULL OR last_mv < DATE_SUB(NOW(), INTERVAL ? DAY))`,
      // Placeholders in the SELECT subquery occur before the outer WHERE.
      MOVEMENT.subqueryFirstParams(consumption.params, subScopeParams, slParams, [filters.window]));
    const slowNoMovement = { window: filters.window, count: Number(slowRow.cnt) || 0, basis: 'outbound_consumption' };

    // 6) Transfers: pending / in-transit + remaining-to-receive.
    const tWhere = [];
    const tParams = [];
    const sf = STRICT_SCOPE.predicate(req.warehouseScope, 'from_warehouse_id', req._reportWarehouseId);
    const st = STRICT_SCOPE.predicate(req.warehouseScope, 'to_warehouse_id', req._reportWarehouseId);
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
    // Expiry risk is authoritative only when the canonical lot ledger fully
    // reconciles every expiry-tracked stock position by quantity.
    let expiryCoverage = { source: 'inventory_lots+warehouse_lot_balances', trackedPositions: 0, fullyCoveredPositions: 0, trackedStockQty: 0, coveredQty: 0, quantityDrift: 0, coveragePct: 0, complete: false };
    try {
      expiryCoverage = await _expiryLotCoverage(req);
      if (!expiryCoverage.complete) RC.pushWarning(warnings, 'EXPIRY_LOT_COVERAGE_INCOMPLETE', 'تغطية دفعات الصلاحية جزئية؛ لا يمكن اعتبار قيم الصلاحية أو التقادم نهائية.', 'warning');
    } catch (_) {
      RC.pushWarning(warnings, 'CANONICAL_LOT_LEDGER_UNAVAILABLE', 'دفتر الدفعات المعياري غير متاح؛ لم يُعرض تقييم صلاحية بديل.', 'error');
    }
    const dataQualityIndicators = {
      estimatedCostItems: Number(dqRow && dqRow.estimated_cost_items) || 0,
      missingMinStock: Number(dqRow && dqRow.missing_min_stock) || 0,
      expiryCoverage,
    };
    if (dataQualityIndicators.estimatedCostItems > 0) RC.pushWarning(warnings, 'COST_ESTIMATED', dataQualityIndicators.estimatedCostItems + ' صنف مُقيّم بتكلفة عامة تقديرية (لا يوجد WAC للمستودع).', 'info');

    res.json(RC.envelope({
      data: {
        kpis: {
          // Value of POSITIVE stock at WAC (qty>0 only).
          inventoryValueWac: totals.totalValue,
          // A subset of inventoryValueWac, priced from the global cost fallback.
          estimatedCostValue,
          estimatedCostIsSubset: true,
          // Value impact of negative stock (≤ 0) — separate, not added to value.
          negativeStockValueImpact,
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
      totals: { inventoryValueWac: totals.totalValue, estimatedCostValue, estimatedCostIsSubset: true, negativeStockValueImpact, itemCount: totals.itemCount },
      filters: { warehouseId: filters.warehouseId, from: filters.from, to: filters.to, category: filters.category, type: filters.type, window: filters.window },
      scope: _scopeInfo(req),
      generatedAt: _generatedAt(),
      dataQualityWarnings: warnings,
    }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/inventory/reports/catalog ──────────────────────────────────────
router.get('/reports/catalog', READ, async (req, res) => {
  res.json(RC.envelope({
    data: RC.REPORT_TYPES.map((type) => ({ type, label: RC.REPORT_LABELS[type], adminOnly: type === 'data-quality' })),
    scope: _scopeInfo(req),
    generatedAt: _generatedAt(),
  }));
});

// ════════════════════════════════════════════════════════════════════════
// Report runner — 12 reports. Each builder returns { rows, total, totals,
// warnings } and carries static `headers` (CSV) + `csvRow(dto)`. Pagination is
// server-side; export runs the same query capped at MAX_EXPORT_ROWS+1.
// ════════════════════════════════════════════════════════════════════════

const EXPORT_PROBE = ' LIMIT ' + (CSV.MAX_EXPORT_ROWS + 1);
function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Item-stock base (warehouse_stock × active items × warehouses), scoped.
function _itemBase(req, filters, extra) {
  const where = [ACTIVE];
  const params = [];
  _scopeWhere(req, 'ws.warehouse_id', where, params);
  if (filters.category) { where.push('i.category = ?'); params.push(filters.category); }
  if (filters.q) { where.push('(i.name LIKE ? OR i.id LIKE ?)'); params.push('%' + filters.q + '%', '%' + filters.q + '%'); }
  (extra || []).forEach((c) => where.push(c));
  return { where, params };
}

const BUILDERS = {
  // 1) Current stock balance (per item per warehouse).
  'stock-balance': {
    headers: ['الصنف', 'الفئة', 'المستودع', 'الكمية', 'تكلفة الوحدة', 'تقديري', 'القيمة', 'حد الطلب', 'الحالة'],
    csvRow: (r) => [r.name, r.category, r.warehouseName, r.qty, r.avgCost, r.costEstimated ? 'نعم' : 'لا', r.value, r.reorderPoint, r.status],
    async run(req, filters, forExport) {
      const { where, params } = _itemBase(req, filters);
      const statusSql = INV.statusFilterSql(INV.STATUS_KEYS.indexOf(filters.status) !== -1 ? filters.status : '');
      if (statusSql) where.push(statusSql);
      const whereSql = ' WHERE ' + where.join(' AND ');
      const from = ' FROM warehouse_stock ws JOIN inv_items i ON i.id = ws.item_id JOIN warehouses w ON w.id = ws.warehouse_id';
      const [[c]] = await db.query('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN ws.qty>0 THEN ws.qty*' + VALUE_EXPR + ' ELSE 0 END),0) AS v, COALESCE(SUM(CASE WHEN ws.qty>0 THEN ws.qty ELSE 0 END),0) AS q' + from + whereSql, params);
      const sel = 'SELECT i.id AS item_id, i.name, i.category, i.unit, i.min_stock, i.cost AS global_cost, ws.qty, ws.avg_cost, w.id AS warehouse_id, w.name AS warehouse_name, w.code AS warehouse_code';
      const order = ' ORDER BY ' + filters.sort.column + ' ' + filters.sort.dir + ', i.name ASC';
      const pg = forExport ? EXPORT_PROBE : ' LIMIT ? OFFSET ?';
      const [rows] = await db.query(sel + ', ' + VALUE_EXPR + ' AS eff_cost, (CASE WHEN ws.qty>0 THEN ws.qty*' + VALUE_EXPR + ' ELSE 0 END) AS line_value' + from + whereSql + order + pg, forExport ? params : params.concat([filters.pageSize, filters.offset]));
      return { rows: rows.map(INV.mapGridRow), total: Number(c.n) || 0, totals: { totalValue: _round2(c.v), totalQty: Number(c.q) || 0, rows: Number(c.n) || 0 }, warnings: [] };
    },
  },

  // 2) Valuation — per warehouse value + grand total + category breakdown.
  'valuation': {
    headers: ['المستودع', 'الكود', 'عدد الأصناف', 'الكمية', 'القيمة (WAC)', 'منها تقديري'],
    csvRow: (r) => [r.name, r.code, r.itemCount, r.totalQty, r.totalValue, r.estimatedValue],
    async run(req) {
      const whRows = await _perWarehouse(req);
      const rows = whRows.map((r) => {
        const dto = INV.mapWarehouseRow(r);
        dto.estimatedValue = _round2(r.estimated_value);
        return dto;
      });
      const totals = INV.summarizeWarehouses(rows);
      totals.estimatedValue = _round2(rows.reduce((s, w) => s + (w.estimatedValue || 0), 0));
      return { rows, total: rows.length, totals, warnings: [] };
    },
  },

  // 3) Movement ledger.
  'movements': {
    headers: ['التاريخ', 'الصنف', 'النوع', 'الكمية', 'السبب', 'المستخدم', 'المستودع'],
    csvRow: (r) => [r.date, r.itemName, r.typeLabel, r.qty, r.reason, r.username, r.warehouseName],
    async run(req, filters, forExport) {
      const where = ['1=1'];
      const params = [];
      _scopeWhere(req, 'm.warehouse_id', where, params);
      const dr = RC.riyadhDateRange('m.movement_date', filters.from, filters.to);
      if (dr.sql) { where.push(dr.sql.replace(/^\s*AND\s+/i, '')); params.push(...dr.params); }
      if (filters.type === 'in' || filters.type === 'out') { where.push('m.type = ?'); params.push(filters.type); }
      if (filters.q) { where.push('(m.item_name LIKE ? OR m.reason LIKE ?)'); params.push('%' + filters.q + '%', '%' + filters.q + '%'); }
      const whereSql = ' WHERE ' + where.join(' AND ');
      const from = ' FROM inventory_movements m LEFT JOIN warehouses w ON w.id = m.warehouse_id';
      const [[c]] = await db.query("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN m.type='in' THEN m.qty ELSE 0 END),0) AS qin, COALESCE(SUM(CASE WHEN m.type='out' THEN m.qty ELSE 0 END),0) AS qout" + from + whereSql, params);
      const order = ' ORDER BY ' + filters.sort.column + ' ' + filters.sort.dir + ', m.id DESC';
      const pg = forExport ? EXPORT_PROBE : ' LIMIT ? OFFSET ?';
      const [rows] = await db.query('SELECT m.id, m.movement_date, m.item_id, m.item_name, m.type, m.qty, m.reason, m.username, m.warehouse_id, w.name AS warehouse_name' + from + whereSql + order + pg, forExport ? params : params.concat([filters.pageSize, filters.offset]));
      return {
        rows: rows.map((m) => ({ id: m.id, date: m.movement_date, itemId: m.item_id, itemName: m.item_name, type: m.type, typeLabel: m.type === 'in' ? 'وارد' : 'صادر', qty: Number(m.qty) || 0, reason: m.reason || '', username: m.username || '', warehouseId: m.warehouse_id || '', warehouseName: m.warehouse_name || '' })),
        total: Number(c.n) || 0, totals: { count: Number(c.n) || 0, inQty: Number(c.qin) || 0, outQty: Number(c.qout) || 0 }, warnings: [],
      };
    },
  },

  // 4) Low / out / negative.
  'low-stock': {
    headers: ['الصنف', 'المستودع', 'الكمية', 'الحد الأدنى', 'الحالة', 'كمية الطلب', 'قيمة الطلب'],
    csvRow: (r) => [r.name, r.warehouseName, r.qty, r.minStock, r.severityLabel, r.reorderQty, r.reorderValue],
    async run(req, filters, forExport) {
      const { where, params } = _itemBase(req, filters, ['(ws.qty < 0 OR ws.qty = 0 OR (i.min_stock > 0 AND ws.qty <= i.min_stock))']);
      const whereSql = ' WHERE ' + where.join(' AND ');
      const from = ' FROM warehouse_stock ws JOIN inv_items i ON i.id = ws.item_id JOIN warehouses w ON w.id = ws.warehouse_id';
      const [[c]] = await db.query('SELECT COUNT(*) AS n, SUM(ws.qty<0) AS neg, SUM(ws.qty=0) AS outc, SUM(ws.qty>0) AS lowc, COALESCE(SUM(GREATEST(i.min_stock-ws.qty,0)*' + VALUE_EXPR + '),0) AS rv' + from + whereSql, params);
      const order = ' ORDER BY (ws.qty<0) DESC, (ws.qty=0) DESC, ' + filters.sort.column + ' ' + filters.sort.dir;
      const pg = forExport ? EXPORT_PROBE : ' LIMIT ? OFFSET ?';
      const sel = 'SELECT i.id AS item_id, i.name, i.category, i.unit, i.min_stock, i.cost AS global_cost, ws.qty, ws.avg_cost, w.id AS warehouse_id, w.name AS warehouse_name, GREATEST(i.min_stock-ws.qty,0) AS reorder_qty, GREATEST(i.min_stock-ws.qty,0)*' + VALUE_EXPR + ' AS reorder_value';
      const [rows] = await db.query(sel + from + whereSql + order + pg, forExport ? params : params.concat([filters.pageSize, filters.offset]));
      return {
        rows: rows.map((r) => {
          const sev = INV.computeItemStatus(r.qty, r.min_stock);
          return { itemId: String(r.item_id), name: r.name, warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, qty: Number(r.qty) || 0, minStock: Number(r.min_stock) || 0, severity: sev, severityLabel: { negative: 'سالب', out: 'نافد', low: 'منخفض', available: 'متوفر' }[sev], reorderQty: Number(r.reorder_qty) || 0, reorderValue: _round2(r.reorder_value) };
        }),
        total: Number(c.n) || 0, totals: { count: Number(c.n) || 0, negativeCount: Number(c.neg) || 0, outCount: Number(c.outc) || 0, lowCount: Number(c.lowc) || 0, totalReorderValue: _round2(c.rv) }, warnings: [],
      };
    },
  },

  // 5) Warehouse comparison.
  'warehouse-compare': {
    headers: ['المستودع', 'الكود', 'النوع', 'عدد الأصناف', 'الكمية', 'القيمة', 'منخفض', 'نافد', 'سالب'],
    csvRow: (r) => [r.name, r.code, r.type, r.itemCount, r.totalQty, r.totalValue, r.lowCount, r.outCount, r.negativeCount],
    async run(req) {
      const whRows = await _perWarehouse(req);
      const rows = whRows.map(INV.mapWarehouseRow);
      return { rows, total: rows.length, totals: INV.summarizeWarehouses(rows), warnings: [] };
    },
  },

  // 6) Transfers + statuses + remaining-to-receive.
  'transfers': {
    headers: ['الرقم', 'التاريخ', 'من', 'إلى', 'الحالة', 'مُصدر', 'مُستلم', 'متبقٍ'],
    csvRow: (r) => [r.number, r.date, r.fromName, r.toName, r.statusLabel, r.issued, r.received, r.remaining],
    async run(req, filters, forExport) { return _transferReport(req, filters, forExport, false); },
  },

  // 7) Receipts & issues (same source, value-focused).
  'receipts-issues': {
    headers: ['الرقم', 'التاريخ', 'من', 'إلى', 'الحالة', 'القيمة'],
    csvRow: (r) => [r.number, r.date, r.fromName, r.toName, r.statusLabel, r.value],
    async run(req, filters, forExport) { return _transferReport(req, filters, forExport, true); },
  },

  // 8) Adjustments + approval log.
  'adjustments': {
    headers: ['الرقم', 'التاريخ', 'المستودع', 'السبب', 'الحالة', 'عدد الأصناف', 'التكلفة', 'اعتمد بواسطة', 'تاريخ الاعتماد'],
    csvRow: (r) => [r.id, r.date, r.warehouseName, r.reasonLabel, r.statusLabel, r.itemsCount, r.totalCost, r.approvedBy, r.approvedAt],
    async run(req, filters, forExport) {
      const where = ['1=1'];
      const params = [];
      _scopeWhere(req, 'a.warehouse_id', where, params);
      const dr = RC.riyadhDateRange('a.adjustment_date', filters.from, filters.to);
      if (dr.sql) { where.push(dr.sql.replace(/^\s*AND\s+/i, '')); params.push(...dr.params); }
      if (filters.status) { where.push('a.status = ?'); params.push(filters.status); }
      const whereSql = ' WHERE ' + where.join(' AND ');
      const from = ' FROM stock_adjustments a LEFT JOIN warehouses w ON w.id = a.warehouse_id';
      const [[c]] = await db.query("SELECT COUNT(*) AS n, COALESCE(SUM(a.total_cost),0) AS tc, SUM(a.status='pending') AS pend, SUM(a.status='approved') AS appr" + from + whereSql, params);
      const order = ' ORDER BY ' + filters.sort.column + ' ' + filters.sort.dir;
      const pg = forExport ? EXPORT_PROBE : ' LIMIT ? OFFSET ?';
      const REASON = { damaged: 'تالف', admin: 'إداري', settlement: 'تسوية' };
      const [rows] = await db.query('SELECT a.id, a.adjustment_date, a.reason, a.status, a.items_count, a.total_cost, a.approved_by, a.approved_at, a.warehouse_id, w.name AS warehouse_name' + from + whereSql + order + pg, forExport ? params : params.concat([filters.pageSize, filters.offset]));
      return {
        rows: rows.map((a) => ({ id: a.id, date: a.adjustment_date, warehouseId: a.warehouse_id || '', warehouseName: a.warehouse_name || '', reason: a.reason, reasonLabel: REASON[a.reason] || a.reason, status: a.status, statusLabel: a.status === 'approved' ? 'معتمد' : 'بانتظار', itemsCount: Number(a.items_count) || 0, totalCost: _round2(a.total_cost), approvedBy: a.approved_by || '', approvedAt: a.approved_at || '' })),
        total: Number(c.n) || 0, totals: { count: Number(c.n) || 0, totalCost: _round2(c.tc), pending: Number(c.pend) || 0, approved: Number(c.appr) || 0 }, warnings: [],
      };
    },
  },

  // 9) Stocktakes + variances (header level).
  'stocktakes': {
    headers: ['الرقم', 'التاريخ', 'المستودع', 'الحالة', 'عدد الأصناف', 'إجمالي الفرق'],
    csvRow: (r) => [r.id, r.date, r.warehouseName, r.statusLabel, r.itemsCount, r.totalVariance],
    async run(req, filters, forExport) {
      const where = ['1=1'];
      const params = [];
      _scopeWhere(req, 's.warehouse_id', where, params);
      const dr = RC.riyadhDateRange('s.stocktake_date', filters.from, filters.to);
      if (dr.sql) { where.push(dr.sql.replace(/^\s*AND\s+/i, '')); params.push(...dr.params); }
      const whereSql = ' WHERE ' + where.join(' AND ');
      const from = ' FROM stocktakes s LEFT JOIN warehouses w ON w.id = s.warehouse_id';
      const [[c]] = await db.query('SELECT COUNT(*) AS n, COALESCE(SUM(s.total_variance),0) AS tv' + from + whereSql, params);
      const order = ' ORDER BY ' + filters.sort.column + ' ' + filters.sort.dir;
      const pg = forExport ? EXPORT_PROBE : ' LIMIT ? OFFSET ?';
      const [rows] = await db.query('SELECT s.id, s.stocktake_date, COALESCE(s.workflow_status, s.status) AS eff_status, s.items_count, s.total_variance, s.warehouse_id, w.name AS warehouse_name' + from + whereSql + order + pg, forExport ? params : params.concat([filters.pageSize, filters.offset]));
      const STL = { completed: 'مكتمل', approved: 'معتمد', pending_approval: 'بانتظار الاعتماد', rejected: 'مرفوض', draft: 'مسودة', cancelled: 'ملغى' };
      return {
        rows: rows.map((s) => ({ id: s.id, date: s.stocktake_date, warehouseId: s.warehouse_id || '', warehouseName: s.warehouse_name || '', status: s.eff_status, statusLabel: STL[s.eff_status] || s.eff_status || '', itemsCount: Number(s.items_count) || 0, totalVariance: _round2(s.total_variance) })),
        total: Number(c.n) || 0, totals: { count: Number(c.n) || 0, totalVariance: _round2(c.tv) }, warnings: [],
      };
    },
  },

  // 10) No outbound consumption (sales/independent issue/production material).
  'no-movement': {
    headers: ['الصنف', 'الفئة', 'الكمية', 'القيمة', 'آخر استهلاك/صرف', 'أيام بلا استهلاك'],
    csvRow: (r) => [r.name, r.category, r.qty, r.value, r.lastOutboundAt || 'لا يوجد', r.daysSinceOutbound == null ? '∞' : r.daysSinceOutbound],
    async run(req, filters, forExport) {
      const where = [ACTIVE];
      const params = [];
      _scopeWhere(req, 'ws.warehouse_id', where, params);
      if (filters.category) { where.push('i.category = ?'); params.push(filters.category); }
      const consumption = MOVEMENT.outboundConsumptionSql('mm');
      const sub = [];
      const subScopeParams = [];
      _scopeWhere(req, 'mm.warehouse_id', sub, subScopeParams);
      const subScope = sub.length ? ' AND ' + sub.join(' AND ') : '';
      const innerSel = `SELECT i.id AS item_id, i.name, i.category, i.unit,
               COALESCE(SUM(CASE WHEN ws.qty>0 THEN ws.qty ELSE 0 END),0) AS qty,
               COALESCE(SUM(CASE WHEN ws.qty>0 THEN ws.qty*${VALUE_EXPR} ELSE 0 END),0) AS value,
               (SELECT MAX(mm.movement_date) FROM inventory_movements mm WHERE mm.item_id = i.id AND ${consumption.sql}${subScope}) AS last_movement
          FROM warehouse_stock ws JOIN inv_items i ON i.id = ws.item_id
         WHERE ${where.join(' AND ')}
         GROUP BY i.id, i.name, i.category, i.unit`;
      // The SELECT subquery placeholders occur before the outer WHERE.
      const innerParams = MOVEMENT.subqueryFirstParams(consumption.params, subScopeParams, params);
      const havQty = ' HAVING qty > 0 AND (last_movement IS NULL OR last_movement < DATE_SUB(NOW(), INTERVAL ' + Number(filters.window) + ' DAY))';
      const [[c]] = await db.query('SELECT COUNT(*) AS n, COALESCE(SUM(value),0) AS v FROM (' + innerSel + havQty + ') t', innerParams);
      const order = ' ORDER BY ' + filters.sort.column + ' ' + filters.sort.dir;
      const pg = forExport ? EXPORT_PROBE : ' LIMIT ? OFFSET ?';
      const [rows] = await db.query('SELECT * FROM (' + innerSel + havQty + ') t' + order + pg, forExport ? innerParams : innerParams.concat([filters.pageSize, filters.offset]));
      return {
        rows: rows.map((r) => {
          const lastOutboundAt = r.last_movement || null;
          const daysSinceOutbound = lastOutboundAt ? Math.floor((Date.now() - new Date(lastOutboundAt).getTime()) / 86400000) : null;
          return { itemId: String(r.item_id), name: r.name, category: r.category || '', unit: r.unit || '', qty: Number(r.qty) || 0, value: _round2(r.value), lastOutboundAt, daysSinceOutbound, lastMovement: lastOutboundAt, daysSince: daysSinceOutbound };
        }),
        total: Number(c.n) || 0, totals: { count: Number(c.n) || 0, totalValue: _round2(c.v), window: filters.window, basis: 'outbound_consumption' }, warnings: [],
      };
    },
  },

  // 11) Expiry from the canonical lot ledger. Partial coverage is explicit
  // and never presented as a complete aging/expiry population.
  'expiry': {
    headers: ['الصنف', 'المستودع', 'الدفعة', 'الكمية المتبقية', 'تكلفة الوحدة', 'القيمة', 'تاريخ الانتهاء', 'أيام متبقية', 'الحالة'],
    csvRow: (r) => [r.itemName, r.warehouseName, r.batch, r.qtyRemaining, r.unitCost, r.value, r.expiryDate, r.daysToExpiry == null ? '' : r.daysToExpiry, r.statusLabel],
    async run(req, filters, forExport) {
      const where = ['b.qty > 0', 'l.expiry_date IS NOT NULL', "l.lifecycle_status<>'closed'"];
      const params = [];
      _scopeWhere(req, 'b.warehouse_id', where, params);
      if (filters.q) { where.push('i.name LIKE ?'); params.push('%' + filters.q + '%'); }
      const whereSql = ' WHERE ' + where.join(' AND ');
      const from = ' FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id JOIN inv_items i ON i.id=l.item_id LEFT JOIN warehouse_stock ws ON ws.warehouse_id=b.warehouse_id AND ws.item_id=b.item_id LEFT JOIN warehouses w ON w.id=b.warehouse_id';
      let total = 0, sumVal = 0;
      let rows = [];
      const warnings = [];
      let sourceAvailable = true;
      try {
        const valuationCost = 'COALESCE(NULLIF(ws.avg_cost,0),NULLIF(i.cost,0),0)';
        const [[c]] = await db.query('SELECT COUNT(*) AS n, COALESCE(SUM(b.qty*' + valuationCost + '),0) AS v' + from + whereSql, params);
        total = Number(c.n) || 0; sumVal = _round2(c.v);
        const order = ' ORDER BY ' + filters.sort.column + ' ' + filters.sort.dir;
        const pg = forExport ? EXPORT_PROBE : ' LIMIT ? OFFSET ?';
        const [r] = await db.query('SELECT l.id, l.item_id AS inv_item_id, i.name AS item_name, b.warehouse_id, w.name AS warehouse_name, l.lot_number AS batch_number, b.qty AS qty_remaining, ' + valuationCost + ' AS unit_cost, l.unit_cost AS lot_receipt_cost, (b.qty*' + valuationCost + ') AS lot_value, l.expiry_date, l.lifecycle_status, DATEDIFF(l.expiry_date, CURDATE()) AS days_to_expiry' + from + whereSql + order + pg, forExport ? params : params.concat([filters.pageSize, filters.offset]));
        rows = r.map((x) => {
          const d = x.days_to_expiry == null ? null : Number(x.days_to_expiry);
          const st = d == null ? 'unknown' : d < 0 ? 'expired' : d <= 7 ? 'critical' : d <= 30 ? 'soon' : 'safe';
          return { id: x.id, itemId: String(x.inv_item_id), itemName: x.item_name, warehouseId: x.warehouse_id || '', warehouseName: x.warehouse_name || '', batch: x.batch_number || '', qtyRemaining: Number(x.qty_remaining) || 0, unitCost: _round2(x.unit_cost), lotReceiptCost: _round2(x.lot_receipt_cost), value: _round2(x.lot_value), costBasis: 'warehouse_wac', expiryDate: x.expiry_date, lifecycleStatus: x.lifecycle_status, daysToExpiry: d, status: st, statusLabel: { expired: 'منتهٍ', critical: 'حرج', soon: 'قريب', safe: 'آمن', unknown: 'غير معروف' }[st] };
        });
      } catch (_) {
        sourceAvailable = false;
        RC.pushWarning(warnings, 'CANONICAL_LOT_LEDGER_UNAVAILABLE', 'دفتر الدفعات المعياري غير متاح؛ لم يُستخدم purchase_lots كبديل صامت.', 'error');
      }
      let coverage = { source: 'inventory_lots+warehouse_lot_balances', trackedPositions: 0, fullyCoveredPositions: 0, trackedStockQty: 0, coveredQty: 0, quantityDrift: 0, coveragePct: 0, complete: false };
      try {
        coverage = await _expiryLotCoverage(req);
        const stocked = coverage.trackedPositions, covered = coverage.fullyCoveredPositions;
        if (stocked > 0 && covered < stocked) RC.pushWarning(warnings, 'EXPIRY_LOW_COVERAGE', 'تقديري: ' + covered + ' من ' + stocked + ' صنف لها طبقات استلام — الأصناف بلا طبقات لا تظهر هنا.', 'warning');
        if (!coverage.complete && !(stocked > 0 && covered < stocked)) RC.pushWarning(warnings, 'EXPIRY_LOT_QUANTITY_DRIFT', 'أرصدة دفعات الصلاحية لا تطابق رصيد المستودع؛ التقرير غير نهائي.', 'warning');
      } catch (_) {
        sourceAvailable = false;
        if (!warnings.some((w) => w.code === 'CANONICAL_LOT_LEDGER_UNAVAILABLE')) RC.pushWarning(warnings, 'CANONICAL_LOT_LEDGER_UNAVAILABLE', 'تعذر قياس تغطية دفتر الدفعات.', 'error');
      }
      return { rows, total, totals: { count: total, totalValue: sumVal, costBasis: 'warehouse_wac', lotSource: coverage.source, coverage, authoritative: sourceAvailable && coverage.complete }, warnings };
    },
  },

  // 12) Data quality (admin/global only — surfaces orphans).
  'data-quality': {
    adminOnly: true,
    headers: ['المؤشر', 'العدد', 'ملاحظة'],
    csvRow: (r) => [r.label, r.count, r.note],
    async run(req) {
      const rows = [];
      async function one(label, sql, note) {
        try { const [[r]] = await db.query(sql); rows.push({ metric: label, label, count: Number(r.cnt) || 0, note }); }
        catch (_) { rows.push({ metric: label, label, count: 0, note: 'تعذّر القياس' }); }
      }
      await one('حركات بلا مستودع', "SELECT COUNT(*) AS cnt FROM inventory_movements WHERE warehouse_id IS NULL OR warehouse_id=''", 'رؤية الإدارة فقط');
      await one('تعديلات بلا مستودع', "SELECT COUNT(*) AS cnt FROM stock_adjustments WHERE warehouse_id IS NULL OR warehouse_id=''", 'رؤية الإدارة فقط');
      await one('جرد بلا مستودع', "SELECT COUNT(*) AS cnt FROM stocktakes WHERE warehouse_id IS NULL OR warehouse_id=''", 'رؤية الإدارة فقط');
      await one('أصناف بتكلفة تقديرية', "SELECT COUNT(*) AS cnt FROM warehouse_stock ws WHERE ws.qty>0 AND COALESCE(NULLIF(ws.avg_cost,0),0)=0", 'WAC غير متوفر — قُيّمت بالتكلفة العامة');
      await one('أصناف بلا حد أدنى', "SELECT COUNT(*) AS cnt FROM inv_items WHERE active=1 AND deleted_at IS NULL AND (min_stock IS NULL OR min_stock<=0)", 'تقارير المنخفض قد تكون ناقصة');
      await one('دفعات معيارية برصيد نشط', 'SELECT COUNT(*) AS cnt FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.qty>0', 'المصدر المعياري لتقارير الصلاحية والتتبع');
      return { rows, total: rows.length, totals: { metrics: rows.length }, warnings: [] };
    },
  },
};

// Shared transfer/receipts-issues builder.
async function _transferReport(req, filters, forExport, valueMode) {
  const where = [];
  const params = [];
  const sf = STRICT_SCOPE.predicate(req.warehouseScope, 'si.from_warehouse_id', req._reportWarehouseId);
  const st = STRICT_SCOPE.predicate(req.warehouseScope, 'si.to_warehouse_id', req._reportWarehouseId);
  if (sf.sql) { where.push('(' + sf.sql.replace(/^\s*AND\s+/i, '') + ' OR ' + st.sql.replace(/^\s*AND\s+/i, '') + ')'); params.push(...sf.params, ...st.params); }
  const dr = RC.riyadhDateRange('si.issue_date', filters.from, filters.to);
  if (dr.sql) { where.push(dr.sql.replace(/^\s*AND\s+/i, '')); params.push(...dr.params); }
  if (filters.status) { where.push('si.status = ?'); params.push(filters.status); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const from = ' FROM stock_issues si LEFT JOIN warehouses wf ON wf.id = si.from_warehouse_id LEFT JOIN warehouses wt ON wt.id = si.to_warehouse_id';
  const [[c]] = await db.query('SELECT COUNT(*) AS n, COALESCE(SUM(si.total_cost),0) AS v' + from + whereSql, params);
  const order = ' ORDER BY ' + filters.sort.column + ' ' + filters.sort.dir;
  const pg = forExport ? EXPORT_PROBE : ' LIMIT ? OFFSET ?';
  const rem = '(SELECT COALESCE(SUM(GREATEST(sii.qty_issued-sii.qty_received,0)),0) FROM stock_issue_items sii WHERE sii.issue_id = si.id)';
  const iss = '(SELECT COALESCE(SUM(sii.qty_issued),0) FROM stock_issue_items sii WHERE sii.issue_id = si.id)';
  const rcv = '(SELECT COALESCE(SUM(sii.qty_received),0) FROM stock_issue_items sii WHERE sii.issue_id = si.id)';
  const [rows] = await db.query('SELECT si.id, si.issue_number, si.issue_date, si.status, si.total_cost, si.from_warehouse_id, si.to_warehouse_id, wf.name AS from_name, wt.name AS to_name, ' + rem + ' AS remaining_qty, ' + iss + ' AS issued_qty, ' + rcv + ' AS received_qty' + from + whereSql + order + pg, forExport ? params : params.concat([filters.pageSize, filters.offset]));
  const STL = { draft: 'مسودة', approved: 'معتمد', issued: 'مُصدر', partially_received: 'استلام جزئي', received: 'مستلم', cancelled: 'ملغى', reversed: 'معكوس' };
  let inTransitRemaining = 0;
  const data = rows.map((r) => {
    const remaining = Number(r.remaining_qty) || 0;
    if (r.status === 'issued' || r.status === 'partially_received') inTransitRemaining += remaining;
    return { id: r.id, number: r.issue_number, date: r.issue_date, fromId: r.from_warehouse_id, toId: r.to_warehouse_id, fromName: r.from_name || '', toName: r.to_name || '', status: r.status, statusLabel: STL[r.status] || r.status, value: _round2(r.total_cost), issued: Number(r.issued_qty) || 0, received: Number(r.received_qty) || 0, remaining };
  });
  return { rows: data, total: Number(c.n) || 0, totals: { count: Number(c.n) || 0, totalValue: _round2(c.v), inTransitRemaining: _round2(inTransitRemaining) }, warnings: [] };
}

function _isAdminScope(req) { return !!(req.warehouseScope && req.warehouseScope.all); }

// ── GET /api/inventory/reports/:reportType ───────────────────────────────────
router.get('/reports/:reportType', READ, async (req, res) => {
  try {
    const type = String(req.params.reportType);
    if (!RC.isReportType(type)) return res.status(404).json({ success: false, code: 'UNKNOWN_REPORT', error: 'تقرير غير معروف.' });
    const builder = BUILDERS[type];
    if (builder.adminOnly && !_isAdminScope(req)) return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'هذا التقرير متاح للإدارة فقط.' });
    const filters = RC.parseReportFilters(req.query, type);
    if (!_guardRequestedWarehouse(req, res, filters.warehouseId)) return;
    req._reportWarehouseId = filters.warehouseId || '';
    const out = await builder.run(req, filters, false);
    const totalPages = Math.max(1, Math.ceil((out.total || 0) / filters.pageSize));
    res.json(RC.envelope({
      data: out.rows,
      totals: out.totals,
      pagination: { page: filters.page, pageSize: filters.pageSize, total: out.total || 0, totalPages },
      filters: { warehouseId: filters.warehouseId, from: filters.from, to: filters.to, category: filters.category, status: filters.status, type: filters.type, window: filters.window, sort: filters.sort.key, dir: filters.sort.dir },
      scope: _scopeInfo(req),
      generatedAt: _generatedAt(),
      dataQualityWarnings: out.warnings || [],
    }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/inventory/reports/:reportType/export → CSV ──────────────────────
router.get('/reports/:reportType/export', READ, async (req, res) => {
  try {
    const type = String(req.params.reportType);
    if (!RC.isReportType(type)) return res.status(404).json({ success: false, code: 'UNKNOWN_REPORT', error: 'تقرير غير معروف.' });
    const builder = BUILDERS[type];
    if (builder.adminOnly && !_isAdminScope(req)) return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'هذا التقرير متاح للإدارة فقط.' });
    const filters = RC.parseReportFilters(req.query, type);
    if (!_guardRequestedWarehouse(req, res, filters.warehouseId)) return;
    req._reportWarehouseId = filters.warehouseId || '';
    const out = await builder.run(req, filters, true);
    let csv;
    try {
      csv = CSV.toCsv(builder.headers, out.rows.map(builder.csvRow));
    } catch (e) {
      if (e.code === 'EXPORT_LIMIT') return res.status(413).json({ success: false, code: 'EXPORT_LIMIT', error: e.message });
      throw e;
    }
    const fname = 'report-' + type + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
    res.send(csv);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
