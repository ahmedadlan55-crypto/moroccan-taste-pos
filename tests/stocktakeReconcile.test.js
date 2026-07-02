/**
 * Phase 3C — stocktake reconciliation math (pure). Run: node tests/stocktakeReconcile.test.js
 * Centres on the canonical chain: snapshot 100, −10 during count → theoretical 90,
 * counted 85 → variance −5 (the later +20 movement is applied to the CURRENT
 * balance at POST time, not here).
 */
'use strict';
const R = require('../lib/stocktakeReconcile');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('\n═══ Stocktake reconcile ═══\n');

test('theoreticalQtyAtCount = snapshot + net movements (100 + −10 = 90)', () => eq(R.theoreticalQtyAtCount(100, -10), 90));
test('variance = counted − theoretical (85 − 90 = −5)', () => eq(R.variance(85, 90), -5));

test('canonical line: snapshot 100, −10 mid-count, counted 85 → theoretical 90, variance −5', () => {
  const r = R.reconcileLine({ snapshotQty: 100, netMovements: -10, countedQty: 85, unitCost: 5, thresholdPct: 10 });
  eq(r.theoreticalQty, 90);
  eq(r.variance, -5);
  eq(r.varianceValue, -25, 'value = −5 × 5');
  eq(r.counted, true);
});

test('null countedQty ⇒ NOT counted (variance null, excluded at post)', () => {
  const r = R.reconcileLine({ snapshotQty: 50, netMovements: 0, countedQty: null, unitCost: 4 });
  eq(r.counted, false);
  eq(r.countedQty, null);
  eq(r.variance, null);
});

test('zero countedQty ⇒ counted-and-empty (a real negative variance)', () => {
  const r = R.reconcileLine({ snapshotQty: 8, netMovements: 0, countedQty: 0, unitCost: 3 });
  eq(r.counted, true);
  eq(r.variance, -8);
  eq(r.varianceValue, -24);
});

test('isCounted: null/undefined/"" are uncounted; 0 and numbers are counted', () => {
  eq([R.isCounted(null), R.isCounted(undefined), R.isCounted('')], [false, false, false]);
  eq([R.isCounted(0), R.isCounted(5), R.isCounted(-2)], [true, true, true]);
});

test('large variance flags over threshold (no movements: theoretical = snapshot)', () => {
  const r = R.reconcileLine({ snapshotQty: 100, netMovements: 0, countedQty: 70, unitCost: 5, thresholdPct: 10 });
  eq(r.theoreticalQty, 100);
  eq(r.variance, -30);
  ok(r.isFlagged, '30% ≥ 10% threshold → flagged');
});

test('net movements include both directions (snapshot 40, +15 −5 = +10 → theoretical 50)', () => {
  eq(R.theoreticalQtyAtCount(40, 15 - 5), 50);
});

console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
process.exit(_f > 0 ? 1 : 0);
