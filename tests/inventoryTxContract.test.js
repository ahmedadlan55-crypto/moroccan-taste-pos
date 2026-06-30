/**
 * Phase 3B — inventory-transaction contract unit tests. Pure; no DB.
 * Run: node tests/inventoryTxContract.test.js
 */
'use strict';

const C = require('../lib/inventoryTxContract');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('\n═══ Inventory-tx contract ═══');

console.log('\n─── canonical codes ───');
test('exactly 10 canonical codes', () => eq(Object.keys(C.HTTP_FOR).length, 10));
test('conflicts map to 409', () => {
  eq(C.httpFor('VERSION_CONFLICT'), 409);
  eq(C.httpFor('IDEMPOTENCY_CONFLICT'), 409);
  eq(C.httpFor('QUANTITY_CONFLICT'), 409);
});
test('validation/permission/stock statuses', () => {
  eq(C.httpFor('VALIDATION_ERROR'), 422);
  eq(C.httpFor('PERMISSION_DENIED'), 403);
  eq(C.httpFor('WAREHOUSE_ACCESS_DENIED'), 403);
  eq(C.httpFor('INSUFFICIENT_STOCK'), 422);
  eq(C.httpFor('COST_REQUIRED'), 422);
  eq(C.httpFor('GL_POSTING_FAILED'), 500);
});
test('isCanonical true for canonical, false for alias', () => {
  eq(C.isCanonical('QUANTITY_CONFLICT'), true);
  eq(C.isCanonical('SNAPSHOT_STALE'), false);
});

console.log('\n─── mapError ───');
test('canonical passes through', () => eq(C.mapError('COST_REQUIRED'), 'COST_REQUIRED'));
test('snapshot/quantity aliases → QUANTITY_CONFLICT', () => {
  eq(C.mapError({ code: 'SNAPSHOT_STALE' }), 'QUANTITY_CONFLICT');
  eq(C.mapError({ code: 'QUANTITY_CONFLICT' }), 'QUANTITY_CONFLICT');
});
test('state guards → INVALID_STATE_TRANSITION', () => {
  eq(C.mapError({ code: 'NOT_DRAFT' }), 'INVALID_STATE_TRANSITION');
  eq(C.mapError({ code: 'ALREADY_POSTED' }), 'INVALID_STATE_TRANSITION');
  eq(C.mapError({ code: 'CANNOT_REVERSE' }), 'INVALID_STATE_TRANSITION');
});
test('maker-checker → PERMISSION_DENIED', () => eq(C.mapError({ code: 'MAKER_CHECKER' }), 'PERMISSION_DENIED'));
test('insufficient / cost aliases', () => {
  eq(C.mapError({ code: 'INSUFFICIENT_STOCK' }), 'INSUFFICIENT_STOCK');
  eq(C.mapError({ code: 'COST_REQUIRED' }), 'COST_REQUIRED');
});
test('gl alias → GL_POSTING_FAILED', () => eq(C.mapError({ code: 'GL_FAILED' }), 'GL_POSTING_FAILED'));
test('message heuristic: insufficient → INSUFFICIENT_STOCK', () => {
  eq(C.mapError(new Error('الرصيد المتاح لا يكفي')), 'INSUFFICIENT_STOCK');
  eq(C.mapError(new Error('insufficient stock')), 'INSUFFICIENT_STOCK');
});
test('unknown / null → VALIDATION_ERROR', () => {
  eq(C.mapError({ code: 'WAT' }), 'VALIDATION_ERROR');
  eq(C.mapError(null), 'VALIDATION_ERROR');
});

console.log('\n─── mutationEnvelope ───');
test('has the extended keys (affectedValue/movementIds/journalId)', () => {
  const e = C.mutationEnvelope({ status: 'posted', version: 2, documentNumber: 'RCV-1', affectedValue: 350, movementIds: ['MV-1'], journalId: 'JRN-1' });
  eq(e.success, true);
  eq(e.status, 'posted');
  eq(e.version, 2);
  eq(e.documentNumber, 'RCV-1');
  eq(e.affectedValue, 350);
  eq(e.movementIds, ['MV-1']);
  eq(e.journalId, 'JRN-1');
  ok(Array.isArray(e.affectedStock) && Array.isArray(e.warnings));
});
test('defaults are safe', () => {
  const e = C.mutationEnvelope({});
  eq(e.affectedValue, 0);
  eq(e.movementIds, []);
  eq(e.journalId, null);
  eq(e.version, null);
});

console.log('\n─── parseListQuery ───');
test('clamps page/pageSize, sort allow-listed', () => {
  const wl = ['created_at', 'receipt_date', 'status', 'total_value'];
  const q = C.parseListQuery({ page: '0', pageSize: '9999', sort: 'DROP TABLE', dir: 'asc', status: 'posted' }, wl, C.STATUSES);
  eq(q.page, 1);
  eq(q.pageSize, 200);
  eq(q.sort, 'created_at'); // injection rejected → first whitelist col
  eq(q.dir, 'ASC');
  eq(q.status, 'posted');
});
test('rejects an out-of-allowlist status', () => {
  const q = C.parseListQuery({ status: 'frobnicate' }, ['created_at'], C.STATUSES);
  eq(q.status, '');
});
test('accepts a whitelisted sort column', () => {
  const q = C.parseListQuery({ sort: 'total_value', dir: 'desc' }, ['created_at', 'total_value'], C.STATUSES);
  eq(q.sort, 'total_value');
  eq(q.dir, 'DESC');
});

console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
process.exit(_f > 0 ? 1 : 0);
