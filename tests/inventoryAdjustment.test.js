/**
 * Phase 0 — Inventory Adjustment contract tests.
 * Pure-function tests; no DB required. Run: node tests/inventoryAdjustment.test.js
 */
'use strict';

const A = require('../lib/inventoryAdjustment');

let _passed = 0, _failed = 0, _total = 0;

function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEqual') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function assertThrows(fn, expectedCode) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (expectedCode && e.code !== expectedCode) {
      throw new Error('Expected throw with code ' + expectedCode + ', got code ' + e.code);
    }
  }
  if (!threw) throw new Error('Expected function to throw' + (expectedCode ? ' (' + expectedCode + ')' : ''));
}

console.log('\n═══ Inventory Adjustment — Contract ═══');

console.log('\n─── Approve only pending (Phase 0 §6) ───');
test('canApprove only for pending', () => {
  assertEqual(A.canApprove('pending'), true);
  assertEqual(A.canApprove('approved'), false);
  assertEqual(A.canApprove('rejected'), false);
});
test('assertCanApprove(pending) ok', () => { A.assertCanApprove('pending'); });
test('assertCanApprove(approved) throws ADJ_NOT_PENDING (no double-post)', () => {
  assertThrows(() => A.assertCanApprove('approved'), 'ADJ_NOT_PENDING');
});

console.log('\n─── No delete after post (Phase 0 §7) ───');
test('isPosted true only for approved', () => {
  assertEqual(A.isPosted('approved'), true);
  assertEqual(A.isPosted('pending'), false);
});
test('canDelete true for pending, false for approved', () => {
  assertEqual(A.canDelete('pending'), true);
  assertEqual(A.canDelete('approved'), false);
});
test('assertCanDelete(pending) ok', () => { A.assertCanDelete('pending'); });
test('assertCanDelete(approved) throws ADJ_POSTED_NO_DELETE', () => {
  assertThrows(() => A.assertCanDelete('approved'), 'ADJ_POSTED_NO_DELETE');
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Total: ${_total} | Passed: ${_passed} | Failed: ${_failed}`);
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(_failed > 0 ? 1 : 0);
