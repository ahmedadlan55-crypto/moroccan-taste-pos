#!/usr/bin/env node
'use strict';

const assert = require('assert');
const WI = require('../lib/warehouseIntelligence');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (error) { console.error('FAIL:', name); throw error; }
}

test('filters clamp pagination and never expose raw sort SQL', () => {
  const f = WI.parseFilters({ page: '-9', pageSize: '99999', sort: 'x; DROP TABLE sales', dir: 'sideways' });
  assert.equal(f.page, 1);
  assert.equal(f.pageSize, 200);
  assert.equal(f.sortKey, 'date');
  assert.equal(f.sortColumn, 'pr.receipt_date');
  assert.equal(f.dir, 'DESC');
});

test('filters accept real ISO dates and reject invalid/range-inverted input', () => {
  const f = WI.parseFilters({ from: '2026-02-28', to: '2026-12-31', q: 'x'.repeat(200), dir: 'ASC' });
  assert.equal(f.from, '2026-02-28');
  assert.equal(f.to, '2026-12-31');
  assert.equal(f.q.length, 120);
  assert.equal(f.dir, 'ASC');
  assert.throws(() => WI.parseFilters({ from: '2026-02-29' }), (e) => e.status === 400 && e.code === 'VALIDATION_ERROR');
  assert.throws(() => WI.parseFilters({ from: '2026-03-01', to: '2026-02-28' }), (e) => e.status === 400 && e.code === 'VALIDATION_ERROR');
});

test('date range includes the complete to day for DATETIME columns', () => {
  const where = [], params = [];
  WI.appendDateRange(where, params, 'm.movement_date', '2026-08-01', '2026-08-12');
  assert.deepEqual(where, ['m.movement_date >= ?', 'm.movement_date < DATE_ADD(?, INTERVAL 1 DAY)']);
  assert.deepEqual(params, ['2026-08-01', '2026-08-12']);
});

test('schema map normalizes mysql aliases', () => {
  const s = WI.schemaMap([{ TABLE_NAME: 't', COLUMN_NAME: 'a' }, { tableName: 't', columnName: 'b' }]);
  assert(WI.hasTable(s, 't'));
  assert(WI.hasColumn(s, 't', 'a'));
  assert(WI.hasColumn(s, 't', 'b'));
});

test('missing essential schema fails closed with 503 code', () => {
  const s = WI.schemaMap([{ tableName: 'purchase_receipts', columnName: 'id' }]);
  assert.throws(() => WI.purchaseModel(s), (e) => e.status === 503 && e.code === 'WAREHOUSE_INTELLIGENCE_SCHEMA_INCOMPLETE' && e.missing.length > 0);
});

function fullSchema(modern) {
  const columns = {
    purchase_receipts: ['id', 'receipt_date', 'status', 'warehouse_id', 'receipt_number', 'po_id', 'supplier_id', 'supplier_name_snapshot'],
    purchase_receipt_lines: ['id', 'receipt_id', 'item_id', 'quantity', 'unit_cost', 'line_total', 'unit', 'warehouse_id'],
    purchase_orders: ['id', 'status', 'warehouse_id', 'po_number', 'supplier_name'],
    po_lines: ['po_id', 'qty', 'received_qty', 'unit_price'],
    suppliers: ['id', 'name'],
    inv_items: ['id', 'name', 'unit'],
    warehouses: ['id', 'name'],
  };
  if (modern) {
    columns.purchase_receipt_lines.push('base_qty', 'entered_qty', 'base_unit_cost', 'entered_unit_code', 'item_name', 'vat_rate');
    columns.po_lines.push('base_qty', 'base_received_qty', 'base_unit_price', 'total');
  }
  return WI.schemaMap(Object.entries(columns).flatMap(([tableName, list]) => list.map((columnName) => ({ tableName, columnName }))));
}

test('modern receipt snapshots take precedence over legacy columns', () => {
  const m = WI.purchaseModel(fullSchema(true));
  assert.match(m.qty, /prl\.base_qty/);
  assert.match(m.qty, /prl\.quantity/);
  assert.match(m.unitCost, /prl\.base_unit_cost/);
  assert.match(m.warehouse, /prl\.warehouse_id/);
  assert.match(m.itemName, /prl\.item_name/);
});

test('legacy receipt schema has an explicit, non-silent fallback', () => {
  const m = WI.purchaseModel(fullSchema(false));
  assert.match(m.qty, /prl\.quantity/);
  assert.doesNotMatch(m.qty, /base_qty/);
  assert.match(m.unitCost, /prl\.unit_cost/);
  assert.match(m.itemName, /i\.name/);
});

test('absence of both modern and legacy quantity columns fails closed', () => {
  const s = fullSchema(false);
  s.purchase_receipt_lines.delete('quantity');
  assert.throws(() => WI.purchaseModel(s), (e) => e.status === 503 && e.missing.some((x) => x.includes('base_qty|quantity')));
});

test('open PO model uses snapshots and computes remaining only', () => {
  const m = WI.openPoModel(fullSchema(true));
  assert.match(m.remaining, /GREATEST/);
  assert.match(m.remaining, /base_qty/);
  assert.match(m.remaining, /base_received_qty/);
  assert.match(m.unitPrice, /base_unit_price/);
  assert.match(m.remainingValue, /pl\.total/);
  assert.equal(m.valueBasis, 'line_total_pro_rata_including_discount_and_vat');
});

test('legacy open PO model discloses its unit-price value fallback', () => {
  const m = WI.openPoModel(fullSchema(false));
  assert.equal(m.lineTotal, null);
  assert.match(m.remainingValue, /unit_price/);
  assert.equal(m.valueBasis, 'unit_price_fallback_ex_vat_discount_unknown');
});

test('specialized and overview reports share the exact open commitment formula', () => {
  const reports = require('../routes/procurement/reports');
  const m = WI.openPoModel(fullSchema(true));
  assert.equal(m.remaining, reports.OPEN_ORDER_QTY);
  assert.equal(m.remainingValue, reports.OPEN_ORDER_VALUE);
});

test('date and scope predicates are parameterized', () => {
  const where = [], params = [];
  WI.appendDateRange(where, params, 'pr.receipt_date', '2026-01-01', '2026-01-31');
  WI.appendWarehouseScope({ whScopeClause: () => ({ sql: ' AND x IN (?,?)', params: ['A', 'B'] }) }, 'x', where, params);
  assert.deepEqual(where, ['pr.receipt_date >= ?', 'pr.receipt_date < DATE_ADD(?, INTERVAL 1 DAY)', 'x IN (?,?)']);
  assert.deepEqual(params, ['2026-01-01', '2026-01-31', 'A', 'B']);
});

test('financial rounding is deterministic', () => {
  assert.equal(WI.round('10.005'), 10.01);
  assert.equal(WI.round('1.23456', 4), 1.2346);
  assert.equal(WI.round('not-a-number'), 0);
});

// Static contract checks catch accidental removal of the two trust boundaries.
const routeSource = require('fs').readFileSync(require.resolve('../routes/warehouse-intelligence'), 'utf8');
const procurementReportsSource = require('fs').readFileSync(require.resolve('../routes/procurement/reports'), 'utf8');
const serverSource = require('fs').readFileSync(require.resolve('../server'), 'utf8');
test('both endpoints are permission gated', () => {
  assert.match(routeSource, /router\.get\('\/overview', READ/);
  assert.match(routeSource, /router\.get\('\/purchases', READ/);
  assert.match(routeSource, /hasCapability\(req\.user, 'finance\.reports\.view'\)/);
  assert.match(routeSource, /hasCapability\(req\.user, 'procurement\.reports'\)/);
  assert.match(routeSource, /status\(403\).*PERMISSION_DENIED/s);
});
test('the router is mounted before the generic inventory catch-all', () => {
  const intelligence = serverSource.indexOf("app.use('/api/inventory/intelligence', require('./routes/warehouse-intelligence'))");
  const catchAll = serverSource.indexOf("app.use('/api/inventory', require('./routes/inventory'))");
  assert(intelligence >= 0, 'warehouse intelligence mount missing');
  assert(catchAll >= 0 && intelligence < catchAll, 'warehouse intelligence must be mounted before inventory catch-all');
});
test('runtime version contract exposes the P2P capability while keeping its router flag-gated', () => {
  assert.match(serverSource, /app\.get\('\/api\/version'[\s\S]*procurementP2P:\s*\/\^\(1\|true\|on\|yes\)\$\/i\.test/);
  assert.match(serverSource, /if \(PROCUREMENT_P2P_ENABLE\) \{[\s\S]*app\.use\('\/api\/procurement'/);
});
test('all nine specialized procurement report endpoints remain wired server-side', () => {
  for (const id of [
    'open-orders', 'receiving-variance', 'three-way-match', 'price-variance',
    'purchase-analysis', 'tax', 'ap-aging', 'supplier-statement', 'data-quality',
  ]) {
    assert.match(procurementReportsSource, new RegExp(`router\\.get\\('\\/${id}'`), id);
  }
});
test('posted GRNs and warehouse scope are hard requirements', () => {
  assert.match(routeSource, /pr\.status = 'posted'/);
  assert.match(routeSource, /STRICT_SCOPE\.append/);
  assert.match(routeSource, /guardRequestedWarehouse/);
});
test('COGS and turnover are explicitly unavailable, never fabricated', () => {
  assert.match(routeSource, /ar_document_lines d/);
  assert.match(routeSource, /d\.cost_snapshot/);
  assert.match(routeSource, /analytics\.cost\.view/);
  assert.match(routeSource, /SALES_COST_SNAPSHOTS_UNAVAILABLE/);
  assert.match(routeSource, /rl\.cogs_reversed_amount/);
  assert.match(routeSource, /UNPROVEN_RETURN_COGS/);
  assert.doesNotMatch(routeSource, /FROM\s+recipe\b/i);
  assert.match(routeSource, /turnover: null/);
});

test('purchase tax and gross are derived from the receipt line snapshot, not a hard-coded rate', () => {
  assert.match(routeSource, /model\.vatAmount/);
  assert.match(routeSource, /model\.grossAmount/);
  const m = WI.purchaseModel(fullSchema(true));
  assert.match(m.vatAmount, /prl\.vat_rate|\* \(0\)/);
  assert.doesNotMatch(m.vatAmount, /15/);
});

test('missing GRN VAT snapshot stays NULL instead of becoming a proven zero rate', () => {
  const schema = fullSchema(true);
  schema.purchase_receipt_lines.delete('vat_rate');
  const model = WI.purchaseModel(schema);
  assert.equal(model.vatRate, 'NULL');
  assert.match(model.vatAmount, /CASE WHEN \(NULL\) IS NULL THEN NULL/);
  assert.doesNotMatch(model.vatAmount, /COALESCE\(prl\.vat_rate,0\)/);
});

test('purchase CSV export shares scope, filters, safe row cap and CSV injection guard', () => {
  assert.match(routeSource, /router\.get\('\/purchases\/export', READ/);
  assert.match(routeSource, /purchaseWhere\(req, filters, model\)/);
  assert.match(routeSource, /CSV_ROW_CAP \+ 1/);
  assert.match(routeSource, /code: 'EXPORT_ROW_LIMIT'/);
  assert.match(routeSource, /sendCsv\(res,/);
  const { toCsv } = require('../lib/procurement/http');
  const csv = toCsv([{ value: '=2+2' }], [{ key: 'value', label: 'Value' }]);
  assert.match(csv, /'=2\+2/);
});

test('overview exposes reconciling supplier, trend and quantity-only stock flow', () => {
  assert.match(routeSource, /purchaseBySupplier/);
  assert.match(routeSource, /purchaseTrend/);
  assert.match(routeSource, /stockFlow/);
  assert.match(routeSource, /value: null/);
});

test('overview uses shared commercial open-value expression and discloses legacy fallback', () => {
  assert.match(routeSource, /SUM\(\$\{openPo\.remainingValue\}\)/);
  assert.match(routeSource, /OPEN_PO_VALUE_LEGACY_FALLBACK/);
  assert.match(routeSource, /openCommitments: openPo\.valueBasis/);
});

console.log(`warehouseIntelligence: ${passed}/${passed} passed`);
