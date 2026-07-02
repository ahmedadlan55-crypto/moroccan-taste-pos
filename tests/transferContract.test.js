/**
 * Phase 3A — Transfer contract unit tests. Pure; no DB.
 * Run: node tests/transferContract.test.js
 */
'use strict';

const T = require('../lib/transferContract');

let _p = 0, _f = 0, _t = 0;
function test(name, fn) { _t++; try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('\n═══ Transfer contract ═══');

console.log('\n─── canonical codes ───');
test('exactly 8 canonical codes', () => eq(Object.keys(T.HTTP_FOR).length, 8));
test('isCanonical true for canonical, false for alias', () => {
  eq(T.isCanonical('VERSION_CONFLICT'), true);
  eq(T.isCanonical('state_changed'), false);
});

console.log('\n─── mapError ───');
test('canonical passes through', () => eq(T.mapError('OVER_RECEIPT'), 'OVER_RECEIPT'));
test('issue/receive/transition guards → INVALID_STATE_TRANSITION', () => {
  eq(T.mapError({ code: 'ISSUE_REQUIRES_APPROVED' }), 'INVALID_STATE_TRANSITION');
  eq(T.mapError({ code: 'RECEIVE_INVALID_STATE' }), 'INVALID_STATE_TRANSITION');
  eq(T.mapError({ code: 'INVALID_TRANSITION' }), 'INVALID_STATE_TRANSITION');
});
test('legacy state_changed → VERSION_CONFLICT', () => eq(T.mapError({ code: 'state_changed' }), 'VERSION_CONFLICT'));
test('NEGATIVE_QTY / empty items → VALIDATION_ERROR', () => {
  eq(T.mapError({ code: 'NEGATIVE_QTY' }), 'VALIDATION_ERROR');
  eq(T.mapError({ code: 'ITEMS_ARRAY_EMPTY' }), 'VALIDATION_ERROR');
});
test('message heuristic: insufficient → INSUFFICIENT_STOCK', () => {
  eq(T.mapError(new Error('الرصيد المتاح لا يكفي')), 'INSUFFICIENT_STOCK');
  eq(T.mapError(new Error('insufficient stock for item')), 'INSUFFICIENT_STOCK');
});
test('unknown code falls back to VALIDATION_ERROR', () => eq(T.mapError({ code: 'WAT' }), 'VALIDATION_ERROR'));
test('null/undefined → VALIDATION_ERROR', () => eq(T.mapError(null), 'VALIDATION_ERROR'));

console.log('\n─── httpFor ───');
test('403 for permission/access', () => {
  eq(T.httpFor('PERMISSION_DENIED'), 403);
  eq(T.httpFor('WAREHOUSE_ACCESS_DENIED'), 403);
});
test('409 for version/idempotency conflicts', () => {
  eq(T.httpFor('VERSION_CONFLICT'), 409);
  eq(T.httpFor('IDEMPOTENCY_CONFLICT'), 409);
});
test('422 for validation/state/stock/over-receipt', () => {
  eq(T.httpFor('VALIDATION_ERROR'), 422);
  eq(T.httpFor('INVALID_STATE_TRANSITION'), 422);
  eq(T.httpFor('INSUFFICIENT_STOCK'), 422);
  eq(T.httpFor('OVER_RECEIPT'), 422);
});

console.log('\n─── errorBody ───');
test('errorBody normalizes alias code + keeps message', () => {
  const b = T.errorBody('state_changed', 'تغيّرت الحالة');
  eq(b.success, false);
  eq(b.code, 'VERSION_CONFLICT');
  eq(b.error, 'تغيّرت الحالة');
});

console.log('\n─── mutationEnvelope ───');
test('defaults are safe', () => {
  const e = T.mutationEnvelope({});
  eq(e.success, true);
  eq(e.data, null);
  eq(e.affectedStock, []);
  eq(e.warnings, []);
  eq(e.version, null);
});
test('carries provided fields', () => {
  const e = T.mutationEnvelope({ documentNumber: 'ISS-1', status: 'issued', version: 3, affectedStock: [{ warehouseId: 'W1', itemId: 'I1', delta: -5 }] });
  eq(e.documentNumber, 'ISS-1');
  eq(e.status, 'issued');
  eq(e.version, 3);
  eq(e.affectedStock.length, 1);
});

console.log('\n─── parseListQuery ───');
test('pageSize clamps to [1,200], default 25; offset derived', () => {
  eq(T.parseListQuery({ pageSize: '9999' }).pageSize, 200);
  eq(T.parseListQuery({ pageSize: '0' }).pageSize, 1);
  eq(T.parseListQuery({}).pageSize, 25);
  eq(T.parseListQuery({ page: '3', pageSize: '10' }).offset, 20);
});
test('sort allow-listed; junk falls back to created_at', () => {
  eq(T.parseListQuery({ sort: 'status' }).sort, 'status');
  eq(T.parseListQuery({ sort: 'status; DROP TABLE' }).sort, 'created_at');
});
test('dir only asc/desc (default DESC)', () => {
  eq(T.parseListQuery({ dir: 'asc' }).dir, 'ASC');
  eq(T.parseListQuery({ dir: 'sideways' }).dir, 'DESC');
});
test('status filter only valid lifecycle states', () => {
  eq(T.parseListQuery({ status: 'issued' }).status, 'issued');
  eq(T.parseListQuery({ status: 'nonsense' }).status, '');
});

console.log('\n═══════════════════════════════════════════');
console.log('Total: ' + _t + ' | Passed: ' + _p + ' | Failed: ' + _f);
console.log('═══════════════════════════════════════════');
process.exit(_f > 0 ? 1 : 0);
