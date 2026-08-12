/**
 * Strict warehouse/date scoping for procurement reports.
 *
 * Report endpoints are intentionally stricter than the legacy warehouse
 * middleware feature flag: a non-global caller is always limited to the
 * warehouses loaded into req.warehouseScope. Missing scope data therefore
 * means zero rows, never an unscoped report.
 */
'use strict';

const TRUSTED_WAREHOUSE_EXPRESSIONS = new Set([
  'po.warehouse_id',
  'pr.warehouse_id',
  'si.warehouse_id',
  'pret.warehouse_id',
  'gj.warehouse_id',
  'COALESCE(prl.warehouse_id COLLATE utf8mb4_unicode_ci, pr.warehouse_id COLLATE utf8mb4_unicode_ci, po.warehouse_id COLLATE utf8mb4_unicode_ci, si.warehouse_id COLLATE utf8mb4_unicode_ci)',
]);

const TRUSTED_DATE_COLUMNS = new Set([
  'po.po_date',
  'pr.receipt_date',
  'si.issue_date',
  'pret.return_date',
]);

function _trusted(value, allow, kind) {
  const text = String(value || '');
  if (!allow.has(text)) throw new Error(`Untrusted ${kind}`);
  return text;
}

function _date(value, key) {
  if (value == null || String(value).trim() === '') return '';
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const e = new Error(`${key} must use YYYY-MM-DD`);
    e.code = 'VALIDATION_ERROR';
    throw e;
  }
  const d = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
    const e = new Error(`${key} is not a valid date`);
    e.code = 'VALIDATION_ERROR';
    throw e;
  }
  return text;
}

function parseReportFilters(query) {
  const q = query || {};
  const from = _date(q.from != null ? q.from : q.dateFrom, 'from');
  const to = _date(q.to != null ? q.to : q.dateTo, 'to');
  if (from && to && from > to) {
    const e = new Error('from must be on or before to');
    e.code = 'VALIDATION_ERROR';
    throw e;
  }
  const asOfDate = _date(q.asOfDate, 'asOfDate');
  return {
    from,
    to,
    asOfDate,
    warehouseId: q.warehouseId == null ? '' : String(q.warehouseId).trim(),
  };
}

function warehousePredicate(scope, expression, requestedWarehouseId) {
  const column = _trusted(expression, TRUSTED_WAREHOUSE_EXPRESSIONS, 'warehouse expression');
  const requested = requestedWarehouseId == null ? '' : String(requestedWarehouseId).trim();

  // Middleware did not resolve a scope: fail closed. This is deliberately not
  // delegated to WAREHOUSE_SCOPE_ENFORCE, whose rollout/shadow mode must never
  // make financial reports global.
  if (!scope || typeof scope !== 'object') return { sql: ' AND 1=0', params: [], denied: true };

  if (scope.all === true) {
    return requested
      ? { sql: ` AND ${column} = ?`, params: [requested], denied: false }
      : { sql: '', params: [], denied: false };
  }

  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(scope.warehouseIds) ? scope.warehouseIds : []) {
    const id = raw == null ? '' : String(raw).trim();
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  }
  if (!ids.length) return { sql: ' AND 1=0', params: [], denied: true };
  if (requested) {
    return seen.has(requested)
      ? { sql: ` AND ${column} = ?`, params: [requested], denied: false }
      : { sql: ' AND 1=0', params: [], denied: true };
  }
  return {
    sql: ` AND ${column} IN (${ids.map(() => '?').join(',')})`,
    params: ids,
    denied: false,
  };
}

function datePredicate(column, from, to) {
  const trusted = _trusted(column, TRUSTED_DATE_COLUMNS, 'date column');
  const parts = [];
  const params = [];
  if (from) { parts.push(`${trusted} >= ?`); params.push(from); }
  if (to) { parts.push(`${trusted} <= ?`); params.push(to); }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

function appendPredicate(where, params, predicate) {
  if (!predicate || !predicate.sql) return;
  where.push(String(predicate.sql).replace(/^\s*AND\s+/i, ''));
  params.push(...(predicate.params || []));
}

module.exports = {
  TRUSTED_WAREHOUSE_EXPRESSIONS,
  TRUSTED_DATE_COLUMNS,
  parseReportFilters,
  warehousePredicate,
  datePredicate,
  appendPredicate,
};
