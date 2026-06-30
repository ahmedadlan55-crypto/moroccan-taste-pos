/**
 * Inventory Reporting — pure helpers for the Phase 2A read-only endpoints
 * (warehouses-summary, dashboard-summary, grid). No I/O; everything here is
 * unit-tested in tests/inventoryReporting.test.js so the SQL-building +
 * mapping logic the endpoints rely on can never drift.
 *
 * Costing rule (blueprint §13): value at the warehouse WAC
 * (warehouse_stock.avg_cost) when it is known (> 0); fall back to the global
 * inv_items.cost and FLAG the row as estimated so the UI can mark it.
 */
'use strict';

// ── Item status (UI shows: متوفر / منخفض / نافد / سالب) ─────────────────
function computeItemStatus(qty, minStock) {
  const q = Number(qty) || 0;
  const min = Number(minStock) || 0;
  if (q < 0) return 'negative';
  if (q === 0) return 'out';
  if (min > 0 && q <= min) return 'low';
  return 'available';
}

// Effective unit cost = warehouse WAC when present, else global cost.
// Returns { cost, estimated } so the row can flag a fallback valuation.
function effectiveCost(avgCost, globalCost) {
  const wac = Number(avgCost) || 0;
  if (wac > 0) return { cost: wac, estimated: false };
  return { cost: Number(globalCost) || 0, estimated: true };
}

// ── Grid query normalization (safe pagination + WHITELISTED sort) ───────
// Never interpolates user input into SQL: sort maps through a fixed table,
// dir is constrained to ASC/DESC, page/pageSize are clamped.
const SORT_COLUMNS = {
  name: 'i.name',
  category: 'i.category',
  qty: 'ws.qty',
  cost: 'eff_cost',
  value: 'line_value',
  status: 'ws.qty', // status order ≈ qty order; good enough for a column sort
};
const STATUS_KEYS = ['available', 'low', 'out', 'negative'];

function normalizeGridQuery(query) {
  const q = query || {};
  const pageSize = Math.max(1, Math.min(Number(q.pageSize) || 25, 200));
  const page = Math.max(1, Number(q.page) || 1);
  const offset = (page - 1) * pageSize;

  const sortKey = SORT_COLUMNS[q.sort] ? q.sort : 'name';
  const sortColumn = SORT_COLUMNS[sortKey];
  const dir = String(q.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const status = STATUS_KEYS.indexOf(String(q.status)) !== -1 ? String(q.status) : '';

  return {
    page,
    pageSize,
    limit: pageSize,
    offset,
    sort: sortKey,
    sortColumn,
    dir,
    q: q.q ? String(q.q).trim() : '',
    category: q.category ? String(q.category) : '',
    status,
    warehouseId: q.warehouseId ? String(q.warehouseId) : '',
  };
}

// SQL fragment (no params — constants over ws.qty / i.min_stock) for a status
// filter. Returns '' for unknown/empty status (no filtering).
function statusFilterSql(status) {
  switch (status) {
    case 'available':
      return '(ws.qty > 0 AND (i.min_stock <= 0 OR ws.qty > i.min_stock))';
    case 'low':
      return '(ws.qty > 0 AND i.min_stock > 0 AND ws.qty <= i.min_stock)';
    case 'out':
      return '(ws.qty = 0)';
    case 'negative':
      return '(ws.qty < 0)';
    default:
      return '';
  }
}

// ── Row mappers ─────────────────────────────────────────────────────────
function mapGridRow(row) {
  const r = row || {};
  const qty = Number(r.qty) || 0;
  const { cost, estimated } = effectiveCost(r.avg_cost, r.global_cost);
  const value = qty > 0 ? qty * cost : 0;
  return {
    itemId: String(r.item_id ?? ''),
    sku: String(r.item_id ?? ''),
    name: String(r.name ?? ''),
    category: String(r.category ?? ''),
    unit: String(r.unit ?? ''),
    warehouseId: String(r.warehouse_id ?? ''),
    warehouseName: String(r.warehouse_name ?? ''),
    warehouseCode: String(r.warehouse_code ?? ''),
    qty,
    // Reservation is NOT tracked by this backend — surface null so the UI can
    // render "—" instead of a misleading 0.
    reserved: null,
    available: qty,
    avgCost: cost,
    costEstimated: estimated,
    value,
    reorderPoint: Number(r.min_stock) || 0,
    status: computeItemStatus(qty, r.min_stock),
    lastMovementAt: r.last_movement || null,
  };
}

function mapWarehouseRow(row) {
  const r = row || {};
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    code: String(r.code ?? ''),
    type: String(r.type ?? ''),
    location: String(r.location ?? ''),
    manager: String(r.manager ?? ''),
    isActive: Boolean(Number(r.is_active ?? 0)),
    itemCount: Number(r.item_count) || 0,
    totalQty: Number(r.total_qty) || 0,
    totalValue: Number(r.total_value) || 0,
    lowCount: Number(r.low_count) || 0,
    outCount: Number(r.out_count) || 0,
    negativeCount: Number(r.negative_count) || 0,
    lastMovementAt: r.last_movement || null,
  };
}

// Grand totals across the per-warehouse rows (pure reduce — tested).
function summarizeWarehouses(warehouses) {
  const list = Array.isArray(warehouses) ? warehouses : [];
  const totals = {
    warehouseCount: list.length,
    activeCount: 0,
    itemCount: 0,
    totalQty: 0,
    totalValue: 0,
    lowCount: 0,
    outCount: 0,
    negativeCount: 0,
  };
  for (const w of list) {
    if (w.isActive) totals.activeCount += 1;
    totals.itemCount += Number(w.itemCount) || 0;
    totals.totalQty += Number(w.totalQty) || 0;
    totals.totalValue += Number(w.totalValue) || 0;
    totals.lowCount += Number(w.lowCount) || 0;
    totals.outCount += Number(w.outCount) || 0;
    totals.negativeCount += Number(w.negativeCount) || 0;
  }
  totals.totalValue = Math.round(totals.totalValue * 100) / 100;
  return totals;
}

// Transfer counts from a GROUP BY status result: pending vs in-transit.
function transferCounts(statusRows) {
  const rows = Array.isArray(statusRows) ? statusRows : [];
  const by = {};
  for (const r of rows) by[String(r.status)] = Number(r.n) || 0;
  const pending = (by.draft || 0) + (by.submitted || 0) + (by.approved || 0);
  const inTransit = (by.issued || 0) + (by.partially_received || 0);
  return { pending, inTransit, byStatus: by };
}

module.exports = {
  computeItemStatus,
  effectiveCost,
  normalizeGridQuery,
  statusFilterSql,
  mapGridRow,
  mapWarehouseRow,
  summarizeWarehouses,
  transferCounts,
  SORT_COLUMNS,
  STATUS_KEYS,
};
