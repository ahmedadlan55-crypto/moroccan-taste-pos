/**
 * Phase 0 — Warehouse Transfer (Stock Issue) contract tests.
 * Pure-function tests; no DB required. Run: node tests/warehouseTransfer.test.js
 *
 * Locks the lifecycle contract the React warehouse rewrite depends on:
 *   • issue ONLY from approved
 *   • cumulative per-line receipt, no over-receipt, no negative
 *   • partially_received vs received header status
 */
'use strict';

const T = require('../lib/warehouseTransfer');

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
function assertClose(actual, expected, msg) {
  if (Math.abs(Number(actual) - Number(expected)) > 1e-6) {
    throw new Error((msg || 'assertClose') + ': expected ≈' + expected + ', got ' + actual);
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

console.log('\n═══ Warehouse Transfer — Lifecycle ═══');

test('STATES contains the 7 canonical statuses', () => {
  ['draft','approved','issued','partially_received','received','cancelled','reversed']
    .forEach(s => { if (T.STATES.indexOf(s) < 0) throw new Error('missing state ' + s); });
});

console.log('\n─── Issue requires approved (Phase 0 §3) ───');

test('canIssue is true ONLY for approved', () => {
  assertEqual(T.canIssue('approved'), true);
  assertEqual(T.canIssue('draft'), false);
  assertEqual(T.canIssue('issued'), false);
  assertEqual(T.canIssue('received'), false);
});
test('assertCanIssue(approved) does not throw', () => {
  T.assertCanIssue('approved');
});
test('assertCanIssue(draft) throws ISSUE_REQUIRES_APPROVED', () => {
  assertThrows(() => T.assertCanIssue('draft'), 'ISSUE_REQUIRES_APPROVED');
});
test('draft → issue is NOT a valid transition', () => {
  assertThrows(() => T.transition('draft', 'issue'), 'INVALID_TRANSITION');
});
test('approved → issue → issued', () => {
  assertEqual(T.transition('approved', 'issue'), 'issued');
});
test('draft → approve → approved', () => {
  assertEqual(T.transition('draft', 'approve'), 'approved');
});

console.log('\n─── Receive guards ───');

test('canReceive true for issued and partially_received only', () => {
  assertEqual(T.canReceive('issued'), true);
  assertEqual(T.canReceive('partially_received'), true);
  assertEqual(T.canReceive('approved'), false);
  assertEqual(T.canReceive('received'), false);
});
test('assertCanReceive(approved) throws RECEIVE_INVALID_STATE', () => {
  assertThrows(() => T.assertCanReceive('approved'), 'RECEIVE_INVALID_STATE');
});

console.log('\n─── Cumulative per-line receipt (Phase 0 §4) ───');

test('first partial receipt accumulates', () => {
  const r = T.computeLineReceipt({ qtyIssued: 10, qtyReceivedSoFar: 0, qtyReceiveNow: 4 });
  assertClose(r.newQtyReceived, 4, 'cumulative');
  assertClose(r.remaining, 6, 'remaining');
});
test('second partial receipt accumulates onto the first', () => {
  const r = T.computeLineReceipt({ qtyIssued: 10, qtyReceivedSoFar: 4, qtyReceiveNow: 6 });
  assertClose(r.newQtyReceived, 10, 'cumulative reaches issued');
  assertClose(r.remaining, 0, 'fully received');
});
test('over-receipt across shipments throws OVER_RECEIPT', () => {
  // already got 4 of 10, trying to receive 7 more (would be 11)
  assertThrows(() => T.computeLineReceipt({ qtyIssued: 10, qtyReceivedSoFar: 4, qtyReceiveNow: 7 }), 'OVER_RECEIPT');
});
test('single over-receipt (12 of 10) throws OVER_RECEIPT', () => {
  assertThrows(() => T.computeLineReceipt({ qtyIssued: 10, qtyReceivedSoFar: 0, qtyReceiveNow: 12 }), 'OVER_RECEIPT');
});
test('negative receive throws NEGATIVE_QTY', () => {
  assertThrows(() => T.computeLineReceipt({ qtyIssued: 10, qtyReceivedSoFar: 0, qtyReceiveNow: -1 }), 'NEGATIVE_QTY');
});
test('exact-remaining receipt is allowed (boundary)', () => {
  const r = T.computeLineReceipt({ qtyIssued: 5, qtyReceivedSoFar: 2, qtyReceiveNow: 3 });
  assertClose(r.newQtyReceived, 5);
  assertClose(r.remaining, 0);
});

console.log('\n─── Header status after receipt (Phase 0 §4) ───');

test('partial receipt across lines → partially_received', () => {
  const status = T.computeNextReceiveStatus([
    { qtyIssued: 10, qtyReceived: 4 },
    { qtyIssued: 5,  qtyReceived: 5 },
  ]);
  assertEqual(status, 'partially_received');
});
test('all lines fully received → received', () => {
  const status = T.computeNextReceiveStatus([
    { qtyIssued: 10, qtyReceived: 10 },
    { qtyIssued: 5,  qtyReceived: 5 },
  ]);
  assertEqual(status, 'received');
});
test('zero received so far → partially_received (not received)', () => {
  const status = T.computeNextReceiveStatus([
    { qtyIssued: 10, qtyReceived: 0 },
  ]);
  assertEqual(status, 'partially_received');
});

console.log('\n─── Cancel / Reverse guards ───');

test('canCancel only for draft/approved', () => {
  assertEqual(T.canCancel('draft'), true);
  assertEqual(T.canCancel('approved'), true);
  assertEqual(T.canCancel('issued'), false);
  assertEqual(T.canCancel('received'), false);
});
test('canReverse only after issue/partial/received', () => {
  assertEqual(T.canReverse('issued'), true);
  assertEqual(T.canReverse('partially_received'), true);
  assertEqual(T.canReverse('received'), true);
  assertEqual(T.canReverse('approved'), false);
  assertEqual(T.canReverse('draft'), false);
});
test('partially_received → reverse → reversed', () => {
  assertEqual(T.transition('partially_received', 'reverse'), 'reversed');
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Total: ${_total} | Passed: ${_passed} | Failed: ${_failed}`);
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(_failed > 0 ? 1 : 0);
