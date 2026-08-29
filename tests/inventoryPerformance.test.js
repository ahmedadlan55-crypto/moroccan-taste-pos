#!/usr/bin/env node
'use strict';
/**
 * Inventory performance mathematics.
 *
 * These assertions are written against the DEFECTS each formula invites, not
 * against its happy path, because every one of them fails silently:
 *
 *   · a Pareto boundary read AFTER the row instead of before demotes the item
 *     that crosses 80% — on a warehouse with one dominant item, class A empties
 *     completely and the buyer stops watching the only item that matters;
 *   · days-on-hand derived independently of turnover produces a pair that
 *     cannot both be true, and neither number looks wrong on its own;
 *   · a sample standard deviation (÷ n−1) on a 3-week series inflates the CV by
 *     ~22%, which is enough to move steady items into "erratic";
 *   · a null denominator rendered as 0 turns "no stock to divide by" into
 *     "stock that never turns" — the opposite conclusion.
 */

const P = require('../lib/inventoryPerformance');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) {
  check(name, actual === expected, { actual, expected });
}

// ── ABC: the boundary item ─────────────────────────────────────────────────
{
  // 85 / 10 / 5. The FIRST item alone crosses 80%. Read the cumulative share
  // after adding it (85 ≥ 80) and it becomes class B or C — and class A ends up
  // empty on a warehouse whose whole spend is one item.
  const rows = P.classifyAbc([
    { itemId: 'b', value: 10 },
    { itemId: 'a', value: 85 },
    { itemId: 'c', value: 5 },
  ]);
  eq('sorted by value descending', rows.map((r) => r.itemId).join(''), 'abc');
  eq('the item that CROSSES 80% is still A', rows[0].abcClass, 'A');
  eq('the next item is B', rows[1].abcClass, 'B');
  eq('the tail is C', rows[2].abcClass, 'C');
  eq('share is a percentage of total value', rows[0].share, 85);
  eq('cumulative share accumulates', rows[1].cumulativeShare, 95);
  eq('cumulative share ends at 100', rows[2].cumulativeShare, 100);
}

{
  // Exactly at the cut-off: 80 / 15 / 5. The second row starts at cumulative
  // 80, which is NOT < 80, so it is B — the boundary is closed on the A side.
  const rows = P.classifyAbc([{ id: 1, value: 80 }, { id: 2, value: 15 }, { id: 3, value: 5 }]);
  eq('a row starting exactly at 80% is B', rows[1].abcClass, 'B');
  eq('a row starting exactly at 95% is C', rows[2].abcClass, 'C');
}

{
  // Zero and negative values cannot hold a Pareto share. They must still be
  // RETURNED — silently dropping them changes the item count the UI prints.
  const rows = P.classifyAbc([{ id: 1, value: 100 }, { id: 2, value: 0 }, { id: 3, value: -5 }]);
  eq('non-positive rows are kept', rows.length, 3);
  eq('a zero-value row is C', rows.find((r) => r.id === 2).abcClass, 'C');
  eq('a zero-value row has no share', rows.find((r) => r.id === 2).share, 0);
  eq('the only positive row holds 100%', rows[0].share, 100);
}

{
  const rows = P.classifyAbc([{ id: 1, value: 0 }, { id: 2, value: 0 }]);
  eq('an all-zero set does not divide by zero', rows.every((r) => r.share === 0), true);
  eq('an all-zero set is entirely C', rows.every((r) => r.abcClass === 'C'), true);
  eq('an empty set stays empty', P.classifyAbc([]).length, 0);
}

// ── ABC summary: value share, not item share ───────────────────────────────
{
  const summary = P.summarizeAbc(P.classifyAbc([
    { id: 1, value: 85, qty: 2 }, { id: 2, value: 10, qty: 3 }, { id: 3, value: 5, qty: 5 },
  ]));
  eq('always three classes', summary.map((s) => s.abcClass).join(''), 'ABC');
  eq('class A value share', summary[0].sharePct, 85);
  // The classic ABC error: reporting the item count share as the value share.
  // A holds 1 of 3 items (33.33%) but 85% of the value. If these two are ever
  // equal for this fixture, one is being computed from the other.
  eq('item share is separate from value share', summary[0].itemSharePct, 33.33);
  check('value share and item share disagree', summary[0].sharePct !== summary[0].itemSharePct);
  eq('class quantities roll up', summary[2].qty, 5);
}

// ── Turnover and days-on-hand are ONE definition ───────────────────────────
{
  // Consumption 1200 over 90 days, average inventory 300 → 4× turns.
  const t = P.turnover({ consumptionValue: 1200, openingValue: 200, closingValue: 400, days: 90 });
  eq('average inventory is the two-point mean', t.averageInventoryValue, 300);
  eq('turnover = consumption / average inventory', t.turnoverRatio, 4);
  eq('days-on-hand = days / turnover', t.daysOnHand, 22.5);
  // The pair must be internally consistent, whatever the numbers.
  check('turnover x days-on-hand reconstructs the period',
    Math.abs(t.turnoverRatio * t.daysOnHand - 90) < 0.05, t);
  eq('annualised for cross-period comparison', t.annualizedTurnover, 16.222);
}

{
  // No inventory to divide by. 0 would read as "stock that never turns" —
  // exactly the opposite of "there is no stock".
  const t = P.turnover({ consumptionValue: 500, openingValue: 0, closingValue: 0, days: 30 });
  eq('turnover with no inventory is null, not zero', t.turnoverRatio, null);
  eq('days-on-hand with no inventory is null', t.daysOnHand, null);
  eq('average inventory is still reported', t.averageInventoryValue, 0);
}

{
  // Stock exists, nothing moved. Turnover genuinely IS zero; cover is not
  // computable (dividing by zero consumption).
  const t = P.turnover({ consumptionValue: 0, openingValue: 100, closingValue: 100, days: 30 });
  eq('no consumption against real stock is a true zero', t.turnoverRatio, 0);
  eq('days-on-hand is null when nothing was consumed', t.daysOnHand, null);
}

{
  const t = P.turnover({ consumptionValue: 100, openingValue: 100, closingValue: 100, days: 0 });
  eq('a zero-day period cannot yield days-on-hand', t.daysOnHand, null);
  eq('a zero-day period cannot be annualised', t.annualizedTurnover, null);
}

// ── Ageing buckets ─────────────────────────────────────────────────────────
{
  eq('day 0 is the freshest bucket', P.agingBucket(0), '0_30');
  eq('day 30 is still the first bucket', P.agingBucket(30), '0_30');
  eq('day 31 crosses into the second', P.agingBucket(31), '31_60');
  eq('day 60 closes the second', P.agingBucket(60), '31_60');
  eq('day 90 closes the third', P.agingBucket(90), '61_90');
  eq('day 91 is the fourth', P.agingBucket(91), '91_180');
  eq('day 180 closes the fourth', P.agingBucket(180), '91_180');
  eq('day 181 is dead stock', P.agingBucket(181), 'over_180');
  // Never consumed is NOT "very old" — it is a different fact, and merging it
  // into over_180 hides stock that was received yesterday and never issued.
  eq('never consumed is its own bucket', P.agingBucket(null), 'never');
  eq('an unparseable age is never, not zero days', P.agingBucket('x'), 'never');
  eq('every bucket key is declared', P.AGING_BUCKETS.length, 6);
  check('agingBucket only returns declared keys',
    [0, 45, 75, 120, 400, null].every((d) => P.AGING_BUCKETS.includes(P.agingBucket(d))));
}

// ── Coefficient of variation: population, not sample ───────────────────────
{
  // [2,4,4,4,5,5,7,9]: mean 5, POPULATION sd 2 → cv 0.4 (class X).
  // The sample estimator gives sd 2.138 → cv 0.428 — same class here, so the
  // next fixture is the one that separates them.
  eq('population CV', P.coefficientOfVariation([2, 4, 4, 4, 5, 5, 7, 9]), 0.4);
  eq('a steady series is X', P.xyzClass(0.4), 'X');
}

{
  // Three buckets, mean 10, population sd 4.0825 → cv 0.408 (X).
  // The sample estimator would give sd 5 → cv 0.5 … still X, so push it:
  // [5,10,15] population cv = 0.408; sample cv = 0.5. Both X. Use a series that
  // straddles the Y boundary instead.
  const steady = P.coefficientOfVariation([5, 10, 15]);
  eq('short series use the population divisor', steady, 0.408);
  check('the sample divisor would give a different number', Math.abs(steady - 0.5) > 0.05, steady);
}

{
  // One bucket has a variance of exactly zero, which would classify "sold once,
  // ever" as the STEADIEST item in the warehouse. Live production data made
  // this concrete: 13 of 15 top-consumed items had a single movement bucket and
  // every one came back X.
  eq('one observation is not a demand pattern', P.coefficientOfVariation([42]), null);
  eq('two observations are not a demand pattern', P.coefficientOfVariation([40, 44]), null);
  eq('three observations are', P.coefficientOfVariation([40, 44, 42]) != null, true);
  eq('the threshold is stated, not hidden', P.XYZ_MIN_OBSERVATIONS, 3);
  eq('a series below the threshold has no XYZ class', P.xyzClass(P.coefficientOfVariation([42])), null);
}

{
  eq('a series with no demand has no variability', P.coefficientOfVariation([0, 0, 0]), null);
  eq('an empty series has no variability', P.coefficientOfVariation([]), null);
  eq('a flat series is perfectly steady', P.coefficientOfVariation([7, 7, 7]), 0);
  eq('a null CV has no XYZ class', P.xyzClass(null), null);
  eq('CV 0.5 closes X', P.xyzClass(0.5), 'X');
  eq('CV 0.51 is Y', P.xyzClass(0.51), 'Y');
  eq('CV 1.0 closes Y', P.xyzClass(1), 'Y');
  eq('CV above 1 is erratic', P.xyzClass(1.01), 'Z');
}

// ── Days of cover ──────────────────────────────────────────────────────────
{
  // 90 on hand, 180 consumed over 90 days → 2/day → 45 days of cover.
  eq('cover = on-hand / average daily consumption', P.daysOfCover(90, 180, 90), 45);
  // Dead stock: rendering "infinite" as a big number sorts it to the TOP of a
  // best-covered list, which is precisely backwards.
  eq('stock that never moved has no cover figure', P.daysOfCover(500, 0, 90), null);
  eq('zero on-hand is a real zero, not null', P.daysOfCover(0, 180, 90), 0);
  eq('a zero-day span cannot yield cover', P.daysOfCover(90, 180, 0), null);
}

// ── Range length ───────────────────────────────────────────────────────────
{
  eq('a range is inclusive of both ends', P.rangeDays('2026-01-01', '2026-01-31'), 31);
  eq('a single day is one day, not zero', P.rangeDays('2026-01-01', '2026-01-01'), 1);
  eq('a reversed range degrades to one day', P.rangeDays('2026-02-01', '2026-01-01'), 1);
  eq('a missing range degrades to one day', P.rangeDays(null, null), 1);
  // A leap day inside the range must be counted.
  eq('February in a leap year has 29 days', P.rangeDays('2028-02-01', '2028-02-29'), 29);
}

// ── No NaN or Infinity may reach JSON ──────────────────────────────────────
{
  const t = P.turnover({ consumptionValue: NaN, openingValue: 100, closingValue: 100, days: 30 });
  check('NaN consumption does not produce NaN turnover', Number.isFinite(t.turnoverRatio), t);
  eq('finiteOrNull rejects Infinity', P.finiteOrNull(Infinity), null);
  eq('finiteOrNull rejects NaN', P.finiteOrNull(NaN), null);
  eq('finiteOrNull keeps a real zero', P.finiteOrNull(0), 0);
  eq('round handles junk without NaN', P.round('abc'), 0);
}

if (failures.length) {
  console.error('\n' + failures.length + ' failure(s):');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('  ✅ ABC boundaries, one turnover definition, population CV, null-not-zero denominators');
console.log(pass + '/' + pass + ' passed');
