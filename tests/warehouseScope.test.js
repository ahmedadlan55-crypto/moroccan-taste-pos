/**
 * Phase 2A.2 — Warehouse Scope access-control unit tests.
 * Pure-function tests; no DB. Run: node tests/warehouseScope.test.js
 */
'use strict';

const W = require('../lib/warehouseScope');

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
function throwsCode(fn, code) {
  try { fn(); }
  catch (e) {
    if (code && e.code !== code) throw new Error('expected code ' + code + ', got ' + e.code);
    return;
  }
  throw new Error('expected throw' + (code ? ' (' + code + ')' : ''));
}

const member = { all: false, warehouseIds: ['WH-A'] };
const twoWh = { all: false, warehouseIds: ['WH-A', 'WH-B'] };
const noAccess = { all: false, warehouseIds: [] };
const global = { all: true, warehouseIds: [] };

console.log('\n═══ Warehouse Scope (access control) ═══');

console.log('\n─── isGlobalScope (admin/developer only) ───');
test('admin → global', () => eq(W.isGlobalScope({ role: 'admin' }), true));
test('developer flag → global', () => eq(W.isGlobalScope({ role: 'manager', isDeveloper: true }), true));
test('manager → NOT global', () => eq(W.isGlobalScope({ role: 'manager' }), false));
test('employee → NOT global', () => eq(W.isGlobalScope({ role: 'employee' }), false));
test('no user → NOT global', () => eq(W.isGlobalScope(null), false));

console.log('\n─── resolveScopeFromRows ───');
test('admin resolves to all (ignores rows)', () => eq(W.resolveScopeFromRows({ role: 'admin' }, []), { all: true, warehouseIds: [] }));
test('member rows dedupe + stringify', () =>
  eq(W.resolveScopeFromRows({ role: 'employee' }, [{ warehouse_id: 'WH-A' }, { warehouse_id: 'WH-A' }, { warehouse_id: 'WH-B' }]),
     { all: false, warehouseIds: ['WH-A', 'WH-B'] }));
test('plain-string rows accepted', () => eq(W.resolveScopeFromRows({ role: 'employee' }, ['WH-A']), { all: false, warehouseIds: ['WH-A'] }));
test('no rows → empty (default deny)', () => eq(W.resolveScopeFromRows({ role: 'employee' }, []), { all: false, warehouseIds: [] }));

console.log('\n─── hasWarehouseAccess / assertWarehouseAccess ───');
test('member can access granted', () => eq(W.hasWarehouseAccess(member, 'WH-A'), true));
test('member cannot access other', () => eq(W.hasWarehouseAccess(member, 'WH-B'), false));
test('global accesses anything', () => eq(W.hasWarehouseAccess(global, 'WH-ZZZ'), true));
test('blank id (non-global) → deny', () => eq(W.hasWarehouseAccess(member, ''), false));
test('no-access scope denies everything', () => eq(W.hasWarehouseAccess(noAccess, 'WH-A'), false));
test('assert denies with generic code', () => throwsCode(() => W.assertWarehouseAccess(member, 'WH-B'), 'WAREHOUSE_ACCESS_DENIED'));
test('assert passes for granted', () => W.assertWarehouseAccess(member, 'WH-A'));

console.log('\n─── transfer needs BOTH ends ───');
test('both ends granted → ok', () => eq(W.hasTransferAccess(twoWh, 'WH-A', 'WH-B'), true));
test('missing source → denied', () => throwsCode(() => W.assertTransferAccess(member, 'WH-B', 'WH-A'), 'WAREHOUSE_ACCESS_DENIED'));
test('missing dest → denied', () => throwsCode(() => W.assertTransferAccess(member, 'WH-A', 'WH-B'), 'WAREHOUSE_ACCESS_DENIED'));
test('denial message never names the warehouse', () => {
  try { W.assertTransferAccess(member, 'WH-A', 'WH-SECRET'); }
  catch (e) { ok(String(e.message).indexOf('WH-SECRET') === -1, 'message leaked the forbidden id'); return; }
  throw new Error('expected throw');
});

console.log('\n─── filterAccessibleIds ───');
test('global returns all candidates', () => eq(W.filterAccessibleIds(global, ['WH-A', 'WH-B']), ['WH-A', 'WH-B']));
test('member intersects (order preserved)', () => eq(W.filterAccessibleIds(twoWh, ['WH-A', 'WH-C', 'WH-B']), ['WH-A', 'WH-B']));
test('no access → empty', () => eq(W.filterAccessibleIds(noAccess, ['WH-A']), []));

console.log('\n─── scopeSqlClause (injection-safe) ───');
test('global → no restriction', () => eq(W.scopeSqlClause(global, 'warehouse_id'), { sql: '', params: [] }));
test('member → parameterized IN', () => eq(W.scopeSqlClause(twoWh, 'ws.warehouse_id'), { sql: ' AND ws.warehouse_id IN (?,?)', params: ['WH-A', 'WH-B'] }));
test('no access → 1=0 (deny all rows)', () => eq(W.scopeSqlClause(noAccess, 'warehouse_id'), { sql: ' AND 1=0', params: [] }));
test('placeholders count matches params (no injection of values)', () => {
  const c = W.scopeSqlClause(twoWh, 'w.id');
  eq((c.sql.match(/\?/g) || []).length, c.params.length);
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log('Total: ' + _total + ' | Passed: ' + _passed + ' | Failed: ' + _failed);
console.log('═══════════════════════════════════════════════════════════');
process.exit(_failed > 0 ? 1 : 0);
