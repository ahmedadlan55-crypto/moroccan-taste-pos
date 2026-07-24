/**
 * Slot forecasting — pure-function tests (no DB).
 * Run: node tests/analyticsForecast.test.js
 *
 * Every expected number is hand-computed (median / MAD / 1.4826 scale). The
 * contract under test:
 *   - point = median, band = ±1.4826 × MAD, per (weekday, slot30) cell;
 *   - samples < 6 → { availability: 'insufficient_history' };
 *   - MAD/median > 0.6 (or median 0 with MAD > 0) → suppressed too;
 *   - outliers move the band a little, the point not at all;
 *   - output is sorted and deterministic.
 */
'use strict';

const F = require('../lib/analytics/forecast');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function deep(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || 'deep') + ': expected ' + b + ', got ' + a);
}

function rows(weekday, slot30, values) {
  return values.map((value) => ({ weekday, slot30, value }));
}

console.log('\n── median / MAD primitives ──');
test('median: odd count picks the middle', () => {
  eq(F.median([3, 1, 2]), 2);
});
test('median: even count averages the two middles', () => {
  eq(F.median([90, 95, 100, 100, 105, 110]), 100);
  eq(F.median([1, 2]), 1.5);
});
test('median: empty is null; input is not mutated', () => {
  eq(F.median([]), null);
  const arr = [3, 1, 2];
  F.median(arr);
  deep(arr, [3, 1, 2]);
});
test('mad around a center', () => {
  // deviations of [90,95,100,100,105,110] from 100 → [10,5,0,0,5,10] → median 5
  eq(F.mad([90, 95, 100, 100, 105, 110], 100), 5);
});

console.log('\n── hand-computed forecast (even sample count) ──');
test('6 samples: median 100, MAD 5 → band 7.413', () => {
  const out = F.forecastSlots(rows(1, 20, [100, 110, 90, 105, 95, 100]));
  eq(out.length, 1);
  const c = out[0];
  eq(c.weekday, 1);
  eq(c.slot30, 20);
  eq(c.point, 100);
  eq(c.low, 92.59, '100 − 1.4826×5 = 92.587 → 92.59');
  eq(c.high, 107.41, '100 + 7.413 → 107.41');
  eq(c.samples, 6);
  eq(c.availability, undefined);
});

console.log('\n── hand-computed forecast (odd count, with an outlier) ──');
test('one Eid-night outlier moves the band a little, the point not at all', () => {
  // [10,12,8,11,9,10,100]: median 10; deviations [0,2,2,1,1,0,90] → MAD 1
  const out = F.forecastSlots(rows(2, 36, [10, 12, 8, 11, 9, 10, 100]));
  const c = out[0];
  eq(c.point, 10);
  eq(c.low, 8.52, '10 − 1.4826 = 8.5174 → 8.52');
  eq(c.high, 11.48, '10 + 1.4826 = 11.4826 → 11.48');
  eq(c.samples, 7);
});

console.log('\n── suppression ──');
test('5 samples is insufficient history', () => {
  const out = F.forecastSlots(rows(1, 20, [100, 110, 90, 105, 95]));
  deep(out, [{ weekday: 1, slot30: 20, availability: 'insufficient_history', samples: 5 }]);
});
test('minSamples is configurable', () => {
  const out = F.forecastSlots(rows(1, 20, [100, 100, 100]), { minSamples: 3 });
  eq(out[0].point, 100);
  eq(out[0].samples, 3);
});
test('volatile history (MAD/median > 0.6) is suppressed even with many samples', () => {
  // [10,100,10,100,10,100]: median 55; MAD 45; 45/55 ≈ 0.818 > 0.6
  const out = F.forecastSlots(rows(3, 10, [10, 100, 10, 100, 10, 100]));
  deep(out, [{ weekday: 3, slot30: 10, availability: 'insufficient_history', samples: 6 }]);
});
test('dispersion exactly AT 0.6 is kept (strictly-greater suppresses)', () => {
  // [40,70,100,100,130,160]: median 100; deviations sorted [0,0,30,30,60,60]
  // → MAD 30; dispersion 30/100 = 0.3. Pin the boundary with maxDispersion.
  const out = F.forecastSlots(rows(0, 0, [40, 70, 100, 100, 130, 160]), { maxDispersion: 0.3 });
  eq(out[0].point, 100, '0.3 == 0.3 is not > 0.3 — kept');
  const out2 = F.forecastSlots(rows(0, 0, [40, 70, 100, 100, 130, 160]), { maxDispersion: 0.29 });
  eq(out2[0].availability, 'insufficient_history', '0.3 > 0.29 — suppressed');
});
test('zero median with non-zero MAD is suppressed (infinitely dispersed)', () => {
  // [-50,-20,0,0,20,50]: median 0; deviations [50,20,0,0,20,50] → MAD 20 > 0
  const out = F.forecastSlots(rows(4, 44, [-50, -20, 0, 0, 20, 50]));
  deep(out, [{ weekday: 4, slot30: 44, availability: 'insufficient_history', samples: 6 }]);
});
test('a confidently-dead slot (all zeros) forecasts 0, not suppressed', () => {
  const out = F.forecastSlots(rows(5, 2, [0, 0, 0, 0, 0, 0]));
  deep(out, [{ weekday: 5, slot30: 2, point: 0, low: 0, high: 0, samples: 6 }]);
});

console.log('\n── clamping ──');
test('a negative-median slot keeps its negative band (no zero-clamp incoherence)', () => {
  const out = F.forecastSlots(rows(6, 30, [-10, -10, -10, -10, -10, -10]));
  const c = out[0];
  eq(c.point, -10);
  eq(c.low, -10);
  eq(c.high, -10);
});

console.log('\n── multiple cells, ordering, determinism ──');
test('cells are independent and sorted by (weekday, slot30)', () => {
  const history = [
    ...rows(2, 5, [50, 50, 50, 50, 50, 50]),
    ...rows(0, 40, [20, 20, 20, 20, 20, 20]),
    ...rows(0, 3, [100, 110, 90, 105, 95, 100]),
  ];
  const out = F.forecastSlots(history);
  deep(out.map((c) => [c.weekday, c.slot30]), [[0, 3], [0, 40], [2, 5]]);
  eq(out[0].point, 100);
  eq(out[1].point, 20);
  eq(out[2].point, 50);
});
test('same input twice → byte-identical output', () => {
  const history = [
    ...rows(1, 20, [100, 110, 90, 105, 95, 100]),
    ...rows(3, 10, [10, 100, 10, 100, 10, 100]),
  ];
  eq(JSON.stringify(F.forecastSlots(history)), JSON.stringify(F.forecastSlots(history)));
});
test('input row order does not change the result', () => {
  const a = rows(1, 20, [100, 110, 90, 105, 95, 100]);
  const b = rows(1, 20, [95, 100, 100, 110, 90, 105]);
  eq(JSON.stringify(F.forecastSlots(a)), JSON.stringify(F.forecastSlots(b)));
});
test('malformed rows are ignored, not crashed on', () => {
  const out = F.forecastSlots([
    { weekday: 1, slot30: 20, value: 100 },
    { weekday: 'x', slot30: 20, value: 100 },
    { weekday: 1, slot30: 20.5, value: 100 },
    { weekday: 1, slot30: 20, value: 'NaN' },
    null && {},
  ].filter(Boolean));
  // Only the first row survives → 1 sample → insufficient.
  deep(out, [{ weekday: 1, slot30: 20, availability: 'insufficient_history', samples: 1 }]);
});
test('empty history yields an empty forecast', () => {
  deep(F.forecastSlots([]), []);
  deep(F.forecastSlots(undefined), []);
});

console.log(`\nForecast: ${_passed}/${_total} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
