/**
 * Pure helpers for the warehouse intelligence read model.
 *
 * No user supplied value is ever interpolated as a SQL identifier.  Schema
 * capabilities are represented as table -> Set(column) so the route can use
 * the modern procurement snapshots while remaining explicit on older installs.
 */
'use strict';

const openOrderValue = require('./procurement/openOrderValue');

const SORT_COLUMNS = Object.freeze({
  date: 'pr.receipt_date',
  receipt: 'pr.receipt_number',
  supplier: 'supplier_name',
  item: 'item_name',
  warehouse: 'warehouse_name',
  quantity: 'base_qty',
  unitCost: 'base_unit_cost',
  value: 'net_amount',
});

const SCHEMA_TABLES = Object.freeze([
  'warehouse_stock', 'inv_items', 'warehouses', 'warehouse_item_rules',
  'purchase_receipts', 'purchase_receipt_lines', 'purchase_orders', 'po_lines',
  'suppliers', 'supplier_invoices', 'supplier_invoice_matches',
  'purchase_returns', 'purchase_return_lines', 'waste_entries', 'waste_entry_items',
  'analytics_order_facts', 'ar_documents', 'ar_document_lines',
  'sales_returns', 'sales_return_lines', 'inventory_movements',
  'gl_accounts', 'gl_journals', 'gl_entries', 'account_roles', 'settings',
]);

function _integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function _date(value, key) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + 'T00:00:00Z') : null;
  if (!d || !Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== text) {
    const error = new Error(`${key} must be a valid date in YYYY-MM-DD format`);
    error.code = 'VALIDATION_ERROR';
    error.status = 400;
    throw error;
  }
  return text;
}

function parseFilters(query) {
  const q = query || {};
  const page = _integer(q.page, 1, 1, 1000000);
  const pageSize = _integer(q.pageSize, 50, 1, 200);
  const sortKey = Object.prototype.hasOwnProperty.call(SORT_COLUMNS, q.sort) ? String(q.sort) : 'date';
  const dir = String(q.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const from = _date(q.from, 'from');
  const to = _date(q.to, 'to');
  if (from && to && from > to) {
    const error = new Error('from must be on or before to');
    error.code = 'VALIDATION_ERROR';
    error.status = 400;
    throw error;
  }
  return {
    from,
    to,
    warehouseId: q.warehouseId ? String(q.warehouseId).trim().slice(0, 80) : null,
    supplierId: q.supplierId ? String(q.supplierId).trim().slice(0, 80) : null,
    itemId: q.itemId ? String(q.itemId).trim().slice(0, 80) : null,
    q: q.q ? String(q.q).trim().slice(0, 120) : null,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sortKey,
    sortColumn: SORT_COLUMNS[sortKey],
    dir,
  };
}

function schemaMap(rows) {
  const out = Object.create(null);
  for (const row of rows || []) {
    const table = String(row.tableName || row.TABLE_NAME || '');
    const column = String(row.columnName || row.COLUMN_NAME || '');
    if (!table || !column) continue;
    if (!out[table]) out[table] = new Set();
    out[table].add(column);
  }
  return out;
}

function hasTable(schema, table) {
  return !!(schema && schema[table] && schema[table].size);
}

function hasColumn(schema, table, column) {
  return !!(hasTable(schema, table) && schema[table].has(column));
}

function firstColumn(schema, table, candidates) {
  for (const column of candidates || []) if (hasColumn(schema, table, column)) return column;
  return null;
}

function schemaError(missing) {
  const error = new Error('Warehouse intelligence schema is incomplete: ' + missing.join(', '));
  error.code = 'WAREHOUSE_INTELLIGENCE_SCHEMA_INCOMPLETE';
  error.status = 503;
  error.missing = missing.slice();
  return error;
}

function requireColumns(schema, requirements) {
  const missing = [];
  for (const [table, columns] of Object.entries(requirements || {})) {
    if (!hasTable(schema, table)) {
      missing.push(table);
      continue;
    }
    for (const column of columns) if (!hasColumn(schema, table, column)) missing.push(table + '.' + column);
  }
  if (missing.length) throw schemaError(missing);
}

function requireAnyColumn(schema, table, candidates) {
  const column = firstColumn(schema, table, candidates);
  if (!column) throw schemaError([table + '.(' + candidates.join('|') + ')']);
  return column;
}

function coalesceColumns(schema, table, alias, candidates, fallback) {
  const cols = (candidates || []).filter((column) => hasColumn(schema, table, column));
  if (!cols.length) return fallback;
  return 'COALESCE(' + cols.map((column) => alias + '.' + column).join(', ') + (fallback != null ? ', ' + fallback : '') + ')';
}

function purchaseModel(schema) {
  requireColumns(schema, {
    purchase_receipts: ['id', 'receipt_date', 'status', 'warehouse_id', 'po_id', 'supplier_id'],
    purchase_receipt_lines: ['id', 'receipt_id', 'item_id'],
    purchase_orders: ['id'],
    suppliers: ['id', 'name'],
    inv_items: ['id', 'name'],
    warehouses: ['id', 'name'],
  });
  requireAnyColumn(schema, 'purchase_receipt_lines', ['base_qty', 'quantity']);
  requireAnyColumn(schema, 'purchase_receipt_lines', ['base_unit_cost', 'unit_cost']);
  const qty = coalesceColumns(schema, 'purchase_receipt_lines', 'prl', ['base_qty', 'quantity'], '0');
  const enteredQty = coalesceColumns(schema, 'purchase_receipt_lines', 'prl', ['entered_qty', 'quantity', 'base_qty'], '0');
  const unitCost = coalesceColumns(schema, 'purchase_receipt_lines', 'prl', ['base_unit_cost', 'unit_cost'], '0');
  const netAmount = coalesceColumns(schema, 'purchase_receipt_lines', 'prl', ['line_total'], '(' + qty + ' * ' + unitCost + ')');
  const warehouse = hasColumn(schema, 'purchase_receipt_lines', 'warehouse_id')
    ? 'COALESCE(prl.warehouse_id, pr.warehouse_id)'
    : 'pr.warehouse_id';
  const itemName = hasColumn(schema, 'purchase_receipt_lines', 'item_name')
    ? "COALESCE(NULLIF(prl.item_name,''), NULLIF(i.name,''), prl.item_id)"
    : "COALESCE(NULLIF(i.name,''), prl.item_id)";
  const poSupplier = hasColumn(schema, 'purchase_orders', 'supplier_name') ? "NULLIF(po.supplier_name,'')" : 'NULL';
  const supplierName = hasColumn(schema, 'purchase_receipts', 'supplier_name_snapshot')
    ? `COALESCE(NULLIF(pr.supplier_name_snapshot,''), NULLIF(s.name,''), ${poSupplier}, pr.supplier_id)`
    : `COALESCE(NULLIF(s.name,''), ${poSupplier}, pr.supplier_id)`;
  const enteredUnit = coalesceColumns(schema, 'purchase_receipt_lines', 'prl', ['entered_unit_code', 'unit'], "''");
  const baseUnit = hasColumn(schema, 'inv_items', 'unit') ? "COALESCE(i.unit,'')" : enteredUnit;
  // A missing VAT snapshot is not the same thing as a proven zero-rated line.
  // Keep it NULL all the way to the report/CSV so historic receiving data is
  // never presented as tax truth when the receipt writer did not capture it.
  const vatRate = hasColumn(schema, 'purchase_receipt_lines', 'vat_rate') ? 'prl.vat_rate' : 'NULL';
  const vatAmount = '(CASE WHEN (' + vatRate + ') IS NULL THEN NULL ELSE ((' + netAmount + ') * (' + vatRate + ') / 100) END)';
  const grossAmount = '(CASE WHEN (' + vatRate + ') IS NULL THEN NULL ELSE ((' + netAmount + ') + ((' + netAmount + ') * (' + vatRate + ') / 100)) END)';
  const sku = hasColumn(schema, 'inv_items', 'sku') ? "COALESCE(i.sku,'')" : "''";
  const poNumber = hasColumn(schema, 'purchase_orders', 'po_number') ? 'po.po_number' : 'NULL';
  const receiptNumber = hasColumn(schema, 'purchase_receipts', 'receipt_number') ? 'pr.receipt_number' : 'pr.id';
  return { qty, enteredQty, unitCost, netAmount, vatRate, vatAmount, grossAmount, sku, warehouse, itemName, supplierName, enteredUnit, baseUnit, poNumber, receiptNumber };
}

function openPoModel(schema) {
  requireColumns(schema, { purchase_orders: ['id', 'status', 'warehouse_id'], po_lines: ['po_id'] });
  requireAnyColumn(schema, 'po_lines', ['base_qty', 'qty']);
  requireAnyColumn(schema, 'po_lines', ['base_received_qty', 'received_qty']);
  requireAnyColumn(schema, 'po_lines', ['base_unit_price', 'unit_price']);
  const ordered = coalesceColumns(schema, 'po_lines', 'pl', ['base_qty', 'qty'], '0');
  const received = coalesceColumns(schema, 'po_lines', 'pl', ['base_received_qty', 'received_qty'], '0');
  const unitPrice = coalesceColumns(schema, 'po_lines', 'pl', ['base_unit_price', 'unit_price'], '0');
  const lineTotal = hasColumn(schema, 'po_lines', 'total') ? 'pl.total' : null;
  const value = openOrderValue.expressions({ ordered, received, lineTotal, unitPrice });
  return { ordered, received, unitPrice, lineTotal, ...value };
}

function appendDateRange(where, params, column, from, to) {
  if (from) { where.push(column + ' >= ?'); params.push(from); }
  if (to) { where.push(column + ' < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to); }
}

function appendWarehouseScope(req, column, where, params) {
  const scoped = typeof req.whScopeClause === 'function' ? req.whScopeClause(column) : { sql: '', params: [] };
  if (scoped && scoped.sql) {
    where.push(scoped.sql.replace(/^\s*AND\s+/i, ''));
    params.push(...(scoped.params || []));
  }
}

function round(value, scale) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const power = 10 ** (scale == null ? 2 : scale);
  return Math.round((n + Number.EPSILON) * power) / power;
}

module.exports = {
  SORT_COLUMNS,
  SCHEMA_TABLES,
  parseFilters,
  schemaMap,
  hasTable,
  hasColumn,
  firstColumn,
  requireColumns,
  requireAnyColumn,
  coalesceColumns,
  purchaseModel,
  openPoModel,
  appendDateRange,
  appendWarehouseScope,
  round,
};
