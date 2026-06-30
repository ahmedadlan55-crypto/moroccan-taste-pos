/**
 * Phase 2A — Inventory Reporting helper tests.
 * Pure-function tests; no DB. Run: node tests/inventoryReporting.test.js
 */
'use strict';

const R = require('../lib/inventoryReporting');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('\n═══ Inventory Reporting ═══');

console.log('\n─── computeItemStatus ───');
test('negative qty → negative', () => eq(R.computeItemStatus(-3, 10), 'negative'));
test('zero qty → out', () => eq(R.computeItemStatus(0, 10), 'out'));
test('at/under min → low', () => eq(R.computeItemStatus(8, 10), 'low'));
test('above min → available', () => eq(R.computeItemStatus(20, 10), 'available'));
test('no min set → available when positive', () => eq(R.computeItemStatus(1, 0), 'available'));

console.log('\n─── effectiveCost (warehouse WAC vs global) ───');
test('uses WAC when present', () => eq(R.effectiveCost(54, 40), { cost: 54, estimated: false }));
test('falls back to global cost + flags estimated', () => eq(R.effectiveCost(0, 40), { cost: 40, estimated: true }));
test('both zero → 0 estimated', () => eq(R.effectiveCost(0, 0), { cost: 0, estimated: true }));

console.log('\n─── normalizeGridQuery (safe pagination + whitelisted sort) ───');
test('defaults: page 1, size 25, sort name ASC', () => {
  const n = R.normalizeGridQuery({});
  eq([n.page, n.pageSize, n.offset, n.sort, n.dir], [1, 25, 0, 'name', 'ASC']);
});
test('clamps pageSize to 200 and computes offset', () => {
  const n = R.normalizeGridQuery({ page: 3, pageSize: 9999 });
  eq([n.pageSize, n.offset], [200, 400]);
});
test('rejects unknown sort column → falls back to name (no SQL injection)', () => {
  const n = R.normalizeGridQuery({ sort: 'name); DROP TABLE inv_items;--' });
  eq(n.sort, 'name');
  eq(n.sortColumn, 'i.name');
});
test('accepts whitelisted sort + desc dir', () => {
  const n = R.normalizeGridQuery({ sort: 'value', dir: 'DESC' });
  eq([n.sort, n.sortColumn, n.dir], ['value', 'line_value', 'DESC']);
});
test('only known statuses pass through', () => {
  eq(R.normalizeGridQuery({ status: 'low' }).status, 'low');
  eq(R.normalizeGridQuery({ status: 'bogus' }).status, '');
});

console.log('\n─── statusFilterSql (constant fragments, no params) ───');
test('low fragment', () => ok(R.statusFilterSql('low').includes('ws.qty <= i.min_stock')));
test('out fragment', () => eq(R.statusFilterSql('out'), '(ws.qty = 0)'));
test('negative fragment', () => eq(R.statusFilterSql('negative'), '(ws.qty < 0)'));
test('unknown → empty (no filter)', () => eq(R.statusFilterSql('xxx'), ''));

console.log('\n─── mapGridRow ───');
test('maps a warehouse row using WAC and computes value', () => {
  const dto = R.mapGridRow({ item_id: 'RM-1', name: 'بن', category: 'مواد خام', unit: 'كجم', warehouse_id: 'WH-1', warehouse_name: 'المركزي', qty: 10, avg_cost: 54, global_cost: 40, min_stock: 12, last_movement: '2026-06-29' });
  eq(dto.sku, 'RM-1');
  eq(dto.qty, 10);
  eq(dto.avgCost, 54);
  eq(dto.costEstimated, false);
  eq(dto.value, 540);
  eq(dto.status, 'low'); // 10 <= 12
  eq(dto.reserved, null); // not tracked
  eq(dto.available, 10);
});
test('flags estimated cost when WAC missing', () => {
  const dto = R.mapGridRow({ item_id: 'X', qty: 5, avg_cost: 0, global_cost: 8, min_stock: 0 });
  eq(dto.avgCost, 8);
  eq(dto.costEstimated, true);
  eq(dto.value, 40);
  eq(dto.status, 'available');
});
test('negative qty → value 0, status negative', () => {
  const dto = R.mapGridRow({ item_id: 'X', qty: -2, avg_cost: 5, global_cost: 5, min_stock: 1 });
  eq(dto.value, 0);
  eq(dto.status, 'negative');
});

console.log('\n─── summarizeWarehouses (grand totals) ───');
test('reduces per-warehouse rows into totals', () => {
  const totals = R.summarizeWarehouses([
    { isActive: true, itemCount: 10, totalQty: 100, totalValue: 1000.005, lowCount: 2, outCount: 1, negativeCount: 0 },
    { isActive: false, itemCount: 5, totalQty: 50, totalValue: 500, lowCount: 1, outCount: 0, negativeCount: 1 },
  ]);
  eq(totals.warehouseCount, 2);
  eq(totals.activeCount, 1);
  eq(totals.itemCount, 15);
  eq(totals.totalQty, 150);
  eq(totals.totalValue, 1500.01);
  eq(totals.lowCount, 3);
  eq(totals.negativeCount, 1);
});
test('empty list → zeroed totals', () => {
  const t = R.summarizeWarehouses([]);
  eq([t.warehouseCount, t.totalValue, t.itemCount], [0, 0, 0]);
});

console.log('\n─── transferCounts (pending vs in-transit) ───');
test('buckets stock_issue statuses correctly', () => {
  const c = R.transferCounts([
    { status: 'draft', n: 2 }, { status: 'approved', n: 1 },
    { status: 'issued', n: 3 }, { status: 'partially_received', n: 1 },
    { status: 'received', n: 9 },
  ]);
  eq(c.pending, 3); // draft 2 + approved 1
  eq(c.inTransit, 4); // issued 3 + partial 1
});
test('in-transit ALWAYS includes partially_received (Phase 0 contract)', () => {
  const c = R.transferCounts([{ status: 'partially_received', n: 5 }]);
  eq(c.inTransit, 5);
  eq(c.pending, 0);
});
test('unknown statuses are ignored (not silently bucketed)', () => {
  const c = R.transferCounts([{ status: 'reversed', n: 9 }, { status: 'cancelled', n: 4 }]);
  eq(c.pending, 0);
  eq(c.inTransit, 0);
});

// ── Phase 2A.1 — bounds + injection-safety hardening ──────────────────
console.log('\n─── normalizeGridQuery bounds (security) ───');
test('page lower bound: 0 and negative clamp to 1', () => {
  eq(R.normalizeGridQuery({ page: 0 }).page, 1);
  eq(R.normalizeGridQuery({ page: -5 }).page, 1);
  eq(R.normalizeGridQuery({ page: 'abc' }).page, 1);
});
test('pageSize lower/upper bounds: clamps to [1, 200], default 25', () => {
  eq(R.normalizeGridQuery({}).pageSize, 25);
  eq(R.normalizeGridQuery({ pageSize: 0 }).pageSize, 25);   // 0 falsy → default 25
  eq(R.normalizeGridQuery({ pageSize: -10 }).pageSize, 1);  // negative → 1
  eq(R.normalizeGridQuery({ pageSize: 5000 }).pageSize, 200);
});
test('offset is derived safely from clamped page/pageSize', () => {
  eq(R.normalizeGridQuery({ page: 4, pageSize: 50 }).offset, 150);
  eq(R.normalizeGridQuery({ page: -1, pageSize: 50 }).offset, 0);
});
test('dir is constrained to ASC/DESC regardless of input case/garbage', () => {
  eq(R.normalizeGridQuery({ dir: 'desc' }).dir, 'DESC');
  eq(R.normalizeGridQuery({ dir: 'DESC' }).dir, 'DESC');
  eq(R.normalizeGridQuery({ dir: 'Desc' }).dir, 'DESC');
  eq(R.normalizeGridQuery({ dir: 'asc' }).dir, 'ASC');
  eq(R.normalizeGridQuery({ dir: "; DROP TABLE x" }).dir, 'ASC'); // garbage → ASC
});
test('sort column is ALWAYS a whitelisted constant (never raw input)', () => {
  // every whitelisted key resolves to a fixed column expression
  Object.keys(R.SORT_COLUMNS).forEach((k) => {
    const n = R.normalizeGridQuery({ sort: k });
    eq(n.sortColumn, R.SORT_COLUMNS[k]);
  });
  // any non-whitelisted value (incl. an injection attempt) falls back to name
  const inj = R.normalizeGridQuery({ sort: 'qty,(SELECT 1)' });
  eq(inj.sort, 'name');
  eq(inj.sortColumn, 'i.name');
});
test('q is trimmed; warehouseId/category pass through as plain strings (parameterized at the route)', () => {
  const n = R.normalizeGridQuery({ q: '  بن  ', warehouseId: 'WH-1', category: 'خام' });
  eq(n.q, 'بن');
  eq(n.warehouseId, 'WH-1');
  eq(n.category, 'خام');
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Total: ${_total} | Passed: ${_passed} | Failed: ${_failed}`);
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(_failed > 0 ? 1 : 0);
