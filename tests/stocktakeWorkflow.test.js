/**
 * Phase 0 — Stocktake Pro workflow contract tests.
 * Pure-function tests; no DB required. Run: node tests/stocktakeWorkflow.test.js
 */
'use strict';

const S = require('../lib/stocktakeWorkflow');

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

console.log('\n═══ Stocktake Pro — Workflow ═══');

console.log('\n─── Transitions ───');
test('draft → submit → pending_approval', () => {
  assertEqual(S.transition('draft', 'submit'), 'pending_approval');
});
test('in_progress → submit → pending_approval', () => {
  assertEqual(S.transition('in_progress', 'submit'), 'pending_approval');
});
test('pending_approval → approve → approved', () => {
  assertEqual(S.transition('pending_approval', 'approve'), 'approved');
});
test('pending_approval → reject → rejected', () => {
  assertEqual(S.transition('pending_approval', 'reject'), 'rejected');
});
test('draft → approve is INVALID (must submit first)', () => {
  assertThrows(() => S.transition('draft', 'approve'), 'INVALID_TRANSITION');
});
test('approved → approve is INVALID (terminal)', () => {
  assertThrows(() => S.transition('approved', 'approve'), 'INVALID_TRANSITION');
});

console.log('\n─── Approve / reject / cancel guards ───');
test('canApprove only pending_approval', () => {
  assertEqual(S.canApprove('pending_approval'), true);
  assertEqual(S.canApprove('draft'), false);
  assertEqual(S.canApprove('approved'), false);
});
test('canReject only pending_approval', () => {
  assertEqual(S.canReject('pending_approval'), true);
  assertEqual(S.canReject('in_progress'), false);
});
test('canCancel only draft/in_progress', () => {
  assertEqual(S.canCancel('draft'), true);
  assertEqual(S.canCancel('in_progress'), true);
  assertEqual(S.canCancel('pending_approval'), false);
});

console.log('\n─── No delete after post (Phase 0 §7/§8) ───');
test('isPosted true for approved and legacy completed', () => {
  assertEqual(S.isPosted('approved'), true);
  assertEqual(S.isPosted('completed'), true);
  assertEqual(S.isPosted('draft'), false);
  assertEqual(S.isPosted('rejected'), false);
});
test('canDelete false for posted, true for drafts/rejected', () => {
  assertEqual(S.canDelete('approved'), false);
  assertEqual(S.canDelete('completed'), false);
  assertEqual(S.canDelete('draft'), true);
  assertEqual(S.canDelete('rejected'), true);
});
test('assertCanDelete(approved) throws STK_POSTED_NO_DELETE', () => {
  assertThrows(() => S.assertCanDelete('approved'), 'STK_POSTED_NO_DELETE');
});
test('assertCanDelete(completed) throws STK_POSTED_NO_DELETE (legacy)', () => {
  assertThrows(() => S.assertCanDelete('completed'), 'STK_POSTED_NO_DELETE');
});

console.log('\n─── Negative count guard ───');
test('assertNoNegativeCount passes for all-non-negative', () => {
  S.assertNoNegativeCount([{ actualQty: 0 }, { actualQty: 12.5 }]);
});
test('assertNoNegativeCount throws NEGATIVE_COUNT on a negative line', () => {
  assertThrows(() => S.assertNoNegativeCount([{ actualQty: 3 }, { actualQty: -1 }]), 'NEGATIVE_COUNT');
});

console.log('\n─── Variance math ───');
test('surplus variance (system 10, actual 12, cost 5)', () => {
  const v = S.computeVariance({ systemQty: 10, actualQty: 12, unitCost: 5, thresholdPct: 10 });
  assertClose(v.variance, 2, 'variance');
  assertClose(v.variancePct, 20, 'pct');
  assertClose(v.varianceValue, 10, 'value');
  assertEqual(v.isFlagged, true, 'flagged ≥ threshold');
});
test('shortage variance is signed negative', () => {
  const v = S.computeVariance({ systemQty: 20, actualQty: 18, unitCost: 3, thresholdPct: 50 });
  assertClose(v.variance, -2);
  assertClose(v.varianceValue, -6);
  assertEqual(v.isFlagged, false, '10% < 50% threshold');
});
test('system 0 with a count → 100% variance', () => {
  const v = S.computeVariance({ systemQty: 0, actualQty: 4, unitCost: 1, thresholdPct: 10 });
  assertClose(v.variancePct, 100);
  assertEqual(v.isFlagged, true);
});
test('no variance → not flagged', () => {
  const v = S.computeVariance({ systemQty: 7, actualQty: 7, unitCost: 9, thresholdPct: 10 });
  assertClose(v.variance, 0);
  assertClose(v.variancePct, 0);
  assertEqual(v.isFlagged, false);
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Total: ${_total} | Passed: ${_passed} | Failed: ${_failed}`);
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(_failed > 0 ? 1 : 0);
