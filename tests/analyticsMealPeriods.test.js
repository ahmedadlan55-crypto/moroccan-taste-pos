/**
 * Meal-period bucketing — pure-function tests (no DB).
 * Run: node tests/analyticsMealPeriods.test.js
 *
 * The contract under test:
 *   - ranges are inclusive on both ends;
 *   - an overnight range (start > end, e.g. dinner 17:00–04:59) matches both
 *     sides of midnight;
 *   - overlaps resolve by sort ascending, deterministically;
 *   - a branch's own rows REPLACE the global set entirely (resolveRows);
 *   - no gap: with the seeded defaults every second of the day maps somewhere
 *     except the 05:00-exclusive edge cases we assert explicitly.
 */
'use strict';

const M = require('../lib/analytics/mealPeriods');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

console.log('\n── default periods (mirror of the migration seed) ──');
test('mid-morning is breakfast', () => {
  eq(M.bucket('2026-07-24 08:30:00'), 'breakfast');
});
test('noon exactly is lunch', () => {
  eq(M.bucket('2026-07-24 12:00:00'), 'lunch');
});
test('afternoon is lunch through 16:59:59', () => {
  eq(M.bucket('2026-07-24 16:59:59'), 'lunch');
});
test('17:00 exactly is dinner', () => {
  eq(M.bucket('2026-07-24 17:00:00'), 'dinner');
});
test('boundaries are inclusive on both ends', () => {
  eq(M.bucket('2026-07-24 05:00:00'), 'breakfast', 'breakfast start');
  eq(M.bucket('2026-07-24 11:59:59'), 'breakfast', 'breakfast end (:59 seconds — no dead gap)');
});

console.log('\n── overnight range (dinner 17:00–04:59) ──');
test('late evening is dinner', () => {
  eq(M.bucket('2026-07-24 23:00:00'), 'dinner');
});
test('midnight is dinner', () => {
  eq(M.bucket('2026-07-24 00:00:00'), 'dinner');
});
test('01:30 after midnight is still dinner', () => {
  eq(M.bucket('2026-07-25 01:30:00'), 'dinner');
});
test('04:59:59 is the last dinner second', () => {
  eq(M.bucket('2026-07-24 04:59:59'), 'dinner');
});
test('the 05:00 flip: dinner ends, breakfast begins — nothing falls through', () => {
  eq(M.bucket('2026-07-24 04:59:59'), 'dinner');
  eq(M.bucket('2026-07-24 05:00:00'), 'breakfast');
});
test('every half-hour slot of the day maps to SOME period (no gaps)', () => {
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const key = M.bucket(`2026-07-24 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
      if (key === null) throw new Error(`gap at ${h}:${m}`);
    }
  }
});

console.log('\n── input forms ──');
test('accepts bare HH:mm and HH:mm:ss', () => {
  eq(M.bucket('08:00'), 'breakfast');
  eq(M.bucket('13:15:30'), 'lunch');
});
test('accepts a Date, reading its LOCAL wall-clock fields', () => {
  const d = new Date(2026, 6, 24, 8, 30, 0); // local 08:30
  eq(M.bucket(d), 'breakfast');
});

console.log('\n── custom config rows ──');
const CUSTOM = [
  { period_key: 'late_night', start_time: '23:00:00', end_time: '02:59:59', sort: 1 },
  { period_key: 'all_day', start_time: '00:00:00', end_time: '23:59:59', sort: 2 },
];
test('overlap resolves by sort ascending — first match wins', () => {
  eq(M.bucket('2026-07-24 23:30:00', CUSTOM), 'late_night');
  eq(M.bucket('2026-07-24 01:00:00', CUSTOM), 'late_night');
  eq(M.bucket('2026-07-24 12:00:00', CUSTOM), 'all_day');
});
test('overlap tie on sort breaks on period_key, deterministically', () => {
  const tied = [
    { period_key: 'zeta', start_time: '00:00:00', end_time: '23:59:59', sort: 1 },
    { period_key: 'alpha', start_time: '00:00:00', end_time: '23:59:59', sort: 1 },
  ];
  eq(M.bucket('2026-07-24 12:00:00', tied), 'alpha');
});
test('a time outside every configured range returns null', () => {
  const gappy = [{ period_key: 'brunch', start_time: '10:00:00', end_time: '13:59:59', sort: 1 }];
  eq(M.bucket('2026-07-24 09:00:00', gappy), null);
  eq(M.bucket('2026-07-24 14:00:00', gappy), null);
  eq(M.bucket('2026-07-24 12:00:00', gappy), 'brunch');
});

console.log('\n── resolveRows (branch override semantics) ──');
const ALL_ROWS = [
  { branch_id: null, period_key: 'breakfast', start_time: '05:00:00', end_time: '11:59:59', sort: 1 },
  { branch_id: null, period_key: 'lunch', start_time: '12:00:00', end_time: '16:59:59', sort: 2 },
  { branch_id: 'BR-2', period_key: 'suhoor', start_time: '02:00:00', end_time: '04:29:59', sort: 1 },
];
test('a branch with its own rows gets ONLY its own rows', () => {
  const rows = M.resolveRows(ALL_ROWS, 'BR-2');
  eq(rows.length, 1);
  eq(rows[0].period_key, 'suhoor');
});
test('a branch with no rows falls back to the global set', () => {
  const rows = M.resolveRows(ALL_ROWS, 'BR-1');
  eq(rows.length, 2);
  eq(rows[0].branch_id, null);
});
test('no rows at all falls back to the built-in defaults', () => {
  const rows = M.resolveRows([], 'BR-1');
  eq(rows.length, 3);
  eq(rows.map((r) => r.period_key).join(','), 'breakfast,lunch,dinner');
});

console.log(`\nMeal periods: ${_passed}/${_total} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
