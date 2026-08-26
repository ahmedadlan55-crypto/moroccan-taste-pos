/**
 * Report contract — Phase 2B (read-only analytics + reports). Pure; no I/O.
 *
 * Filter parsing/clamping, Riyadh-day boundaries, per-report sort/type
 * allowlists (injection-safe), and the standard response envelope shared by
 * every report endpoint. Tested in tests/reportContract.test.js.
 */
'use strict';

const NO_MOVE_WINDOWS = [30, 60, 90, 180];
const DEFAULT_WINDOW = 90;

// Per-report sort allowlist: query key → trusted SQL identifier. ONLY values
// from these maps ever reach a query (raw user input never interpolated).
const SORT_WHITELIST = {
  'stock-balance':     { name: 'i.name', qty: 'ws.qty', value: 'line_value', category: 'i.category', warehouse: 'w.code' },
  'valuation':         { value: 'total_value', qty: 'total_qty', warehouse: 'w.code', name: 'w.name' },
  'movements':         { date: 'm.movement_date', qty: 'm.qty', type: 'm.type', item: 'm.item_name' },
  'low-stock':         { qty: 'ws.qty', name: 'i.name', reorder: 'reorder_qty', value: 'reorder_value' },
  'warehouse-compare': { value: 'total_value', qty: 'total_qty', items: 'item_count', name: 'w.name' },
  'transfers':         { date: 'si.issue_date', status: 'si.status', remaining: 'remaining_qty', number: 'si.issue_number' },
  'receipts-issues':   { date: 'si.issue_date', status: 'si.status', value: 'si.total_cost', number: 'si.issue_number' },
  'adjustments':       { date: 'a.adjustment_date', status: 'a.status', value: 'a.total_cost', reason: 'a.reason' },
  'stocktakes':        { date: 's.stocktake_date', variance: 's.total_variance', items: 's.items_count' },
  'no-movement':       { last: 'last_movement', name: 'name', qty: 'qty', value: 'value' },
  'expiry':            { expiry: 'l.expiry_date', qty: 'b.qty', value: 'lot_value', item: 'item_name' },
  'data-quality':      { count: 'cnt', metric: 'metric' },
};

const REPORT_TYPES = Object.keys(SORT_WHITELIST);

const REPORT_LABELS = {
  'stock-balance':     'رصيد المخزون الحالي',
  'valuation':         'تقييم المخزون',
  'movements':         'دفتر حركات المخزون',
  'low-stock':         'الأصناف المنخفضة والنافدة والسالبة',
  'warehouse-compare': 'مقارنة المستودعات',
  'transfers':         'التحويلات والكميات المتبقية',
  'receipts-issues':   'الاستلامات والصرف',
  'adjustments':       'التعديلات وسجل الاعتماد',
  'stocktakes':        'الجرد وفروقات الجرد',
  'no-movement':       'الأصناف عديمة الحركة',
  'expiry':            'انتهاء الصلاحية',
  'data-quality':      'جودة البيانات والتكلفة التقديرية',
};

function isReportType(t) { return REPORT_TYPES.indexOf(String(t)) !== -1; }

function _clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function _isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function _window(v) {
  const n = parseInt(v, 10);
  return NO_MOVE_WINDOWS.indexOf(n) !== -1 ? n : DEFAULT_WINDOW;
}

// Resolve a sort column + direction against a report's allowlist. Unknown/raw
// input falls back to the report's first column — never interpolated.
function resolveSort(reportType, sort, dir) {
  const map = SORT_WHITELIST[reportType] || {};
  const keys = Object.keys(map);
  const key = map[sort] ? String(sort) : keys[0];
  return {
    key,
    column: map[key] || '1',
    dir: String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC',
  };
}

function parseReportFilters(query, reportType) {
  const q = query || {};
  const page = _clampInt(q.page, 1, 1, 1000000);
  const pageSize = _clampInt(q.pageSize, 25, 1, 200);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    from: _isDate(q.from) ? q.from : null,
    to: _isDate(q.to) ? q.to : null,
    category: q.category ? String(q.category) : null,
    status: q.status ? String(q.status) : null,
    type: q.type ? String(q.type) : null,
    q: q.q ? String(q.q).trim() : null,
    window: _window(q.window),
    warehouseId: q.warehouseId ? String(q.warehouseId) : null,
    sort: resolveSort(reportType, q.sort, q.dir),
  };
}

// Riyadh-day boundaries for a datetime `column`. from/to are Riyadh calendar
// dates (YYYY-MM-DD); stored datetimes are treated as Riyadh-local (matching
// the legacy DATE()-based filters). Half-open [from 00:00, to+1day 00:00).
function riyadhDateRange(column, from, to) {
  const conds = [];
  const params = [];
  if (from) { conds.push(column + ' >= ?'); params.push(from + ' 00:00:00'); }
  if (to)   { conds.push(column + ' < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to + ' 00:00:00'); }
  return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', params };
}

function envelope(parts) {
  const p = parts || {};
  return {
    success: true,
    data: p.data != null ? p.data : [],
    totals: p.totals != null ? p.totals : {},
    pagination: p.pagination || null,
    filters: p.filters || {},
    scope: p.scope || {},
    generatedAt: p.generatedAt || null,
    dataQualityWarnings: p.dataQualityWarnings || [],
  };
}

function pushWarning(list, code, message, level, params) {
  const warning = { code, message, level: level || 'info' };
  if (params && typeof params === 'object') warning.params = params;
  (list || []).push(warning);
  return list;
}

module.exports = {
  NO_MOVE_WINDOWS, DEFAULT_WINDOW, SORT_WHITELIST, REPORT_TYPES, REPORT_LABELS,
  isReportType, resolveSort, parseReportFilters, riyadhDateRange, envelope, pushWarning,
};
