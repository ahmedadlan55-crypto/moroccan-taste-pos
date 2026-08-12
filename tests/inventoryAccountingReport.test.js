'use strict';

const assert = require('assert');
const R = require('../lib/inventoryAccountingReport');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ok - ' + name);
}

test('the registry covers every IAS 2.36 disclosure family', () => {
  const authorities = R.REPORT_REQUIREMENTS.map((row) => row.authority).join('|');
  for (const paragraph of ['IAS 2.36(a)', 'IAS 2.36(b)', 'IAS 2.36(c)', 'IAS 2.36(d)', 'IAS 2.36(e)', 'IAS 2.36(f)-(g)', 'IAS 2.36(h)']) {
    assert.ok(authorities.includes(paragraph), paragraph + ' is missing');
  }
});

test('the registry separates statutory, warehouse, procurement and cost reports', () => {
  const families = new Set(R.REPORT_REQUIREMENTS.map((row) => row.family));
  assert.deepStrictEqual([...families].sort(), ['cost', 'financial', 'procurement', 'warehouse']);
});

test('high-risk reports declare the facts needed to avoid fabricated values', () => {
  const byId = Object.fromEntries(R.REPORT_REQUIREMENTS.map((row) => [row.id, row]));
  assert.ok(byId['inventory-as-of'].requiredFacts.includes('valued_movements'));
  assert.ok(byId['inventory-write-downs'].requiredFacts.includes('nrv_test'));
  assert.ok(byId['landed-cost-allocation'].requiredFacts.includes('allocation_basis'));
  assert.ok(byId['sales-cogs-gross-margin'].requiredFacts.includes('frozen_cogs'));
});

test('warehouse rows merge stock and GL without hiding unallocated GL', () => {
  const rows = R.mergeReconciliationRows(
    [{ warehouse_id: 'W1', warehouse_name: 'Main', positive_value: 105, negative_value: -5, subledger_value: 100, stock_positions: 2, wac_positions: 2 }],
    [{ warehouse_id: 'W1', warehouse_name: 'Main', gl_balance: 100 }, { warehouse_id: null, warehouse_name: null, gl_balance: 12 }],
  );
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.find((row) => row.warehouseId === 'W1').difference, 0);
  assert.strictEqual(rows.find((row) => row.warehouseId == null).glBalance, 12);
});

test('a complete global report reconciles only inside the fixed tolerance', () => {
  const summary = R.summarizeReconciliation([
    { positiveValue: 100, negativeValue: 0, subledgerValue: 100, glBalance: 99.995, stockPositions: 1, wacPositions: 1 },
  ], { scopeAll: true });
  assert.strictEqual(summary.state, 'reconciled');
  assert.deepStrictEqual(summary.blockers, []);
  assert.strictEqual(summary.tolerance, 0.01);
});

test('fallback cost, missing cost, negative stock and GL differences fail closed', () => {
  const summary = R.summarizeReconciliation([
    { positiveValue: 120, negativeValue: -20, subledgerValue: 100, glBalance: 90, stockPositions: 4, wacPositions: 1, fallbackPositions: 1, missingCostPositions: 1, negativePositions: 1 },
  ], { scopeAll: true });
  assert.strictEqual(summary.state, 'not_reconciled');
  assert.deepStrictEqual(summary.blockers, [
    'MASTER_COST_FALLBACK', 'MISSING_COST', 'NEGATIVE_STOCK', 'WAREHOUSE_DIMENSION_DIFFERENCE', 'SUBLEDGER_GL_DIFFERENCE',
  ]);
});

test('orphan stock rows and negative effective costs survive the merge and fail closed', () => {
  const rows = R.mergeReconciliationRows([{
    warehouse_id: 'W1', warehouse_name: 'Main', positive_value: 50,
    negative_value: 0, subledger_value: 50, stock_positions: 2,
    wac_positions: 2, orphan_stock_positions: 1, negative_cost_positions: 1,
  }], [{ warehouse_id: 'W1', warehouse_name: 'Main', gl_balance: 50 }]);
  assert.strictEqual(rows[0].orphanStockPositions, 1);
  assert.strictEqual(rows[0].negativeCostPositions, 1);
  const summary = R.summarizeReconciliation(rows, { scopeAll: true, inventorySystem: 'perpetual' });
  assert.strictEqual(summary.state, 'not_reconciled');
  assert.ok(summary.blockers.includes('ORPHAN_STOCK_ITEM'));
  assert.ok(summary.blockers.includes('NEGATIVE_COST'));
  assert.strictEqual(R.isCarryingAmountReady(summary, 'perpetual'), false);
});

test('periodic inventory never claims a perpetual reconciliation or ready carrying amount', () => {
  const summary = R.summarizeReconciliation([{
    warehouseId: 'W1', subledgerValue: 100, glBalance: 100,
    stockPositions: 1, wacPositions: 1,
  }], { scopeAll: true, inventorySystem: 'periodic' });
  assert.strictEqual(summary.state, 'not_reconciled');
  assert.ok(summary.blockers.includes('PERIODIC_INVENTORY_SYSTEM'));
  assert.strictEqual(R.isCarryingAmountReady(summary, 'periodic'), false);
});

test('only clean perpetual measurement can be marked carrying-amount ready', () => {
  const summary = R.summarizeReconciliation([{
    warehouseId: 'W1', subledgerValue: 100, glBalance: 100,
    stockPositions: 1, wacPositions: 1,
  }], { scopeAll: true, inventorySystem: 'perpetual' });
  assert.strictEqual(summary.state, 'reconciled');
  assert.strictEqual(R.isCarryingAmountReady(summary, 'perpetual'), true);
});

test('a warehouse-scoped slice is not mislabelled as company reconciliation', () => {
  const summary = R.summarizeReconciliation([
    { subledgerValue: 50, glBalance: 50, stockPositions: 1, wacPositions: 1 },
  ], { scopeAll: false });
  assert.strictEqual(summary.state, 'not_reconciled');
  assert.ok(summary.blockers.includes('WAREHOUSE_SCOPE_PARTIAL'));
});

test('equal company totals cannot hide unallocated GL or warehouse-level netting', () => {
  const rows = R.mergeReconciliationRows(
    [{ warehouse_id: 'WH-A', warehouse_name: 'A', subledger_value: 100, positive_value: 100, stock_positions: 1, wac_positions: 1 }],
    [{ warehouse_id: null, warehouse_name: 'Unallocated', gl_balance: 100 }],
  );
  const result = R.summarizeReconciliation(rows, { scopeAll: true });
  assert.strictEqual(result.difference, 0, 'company totals deliberately net to zero');
  assert.strictEqual(result.state, 'not_reconciled');
  assert.ok(result.blockers.includes('UNALLOCATED_GL_BALANCE'));
  assert.ok(result.blockers.includes('WAREHOUSE_DIMENSION_DIFFERENCE'));
  assert.strictEqual(result.warehouseDimensionDifferenceCount, 2);
});

console.log(`\n${passed}/${passed} inventory accounting contract tests passed`);
