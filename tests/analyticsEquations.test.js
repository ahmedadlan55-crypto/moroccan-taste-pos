/**
 * Analytics equations — pure-function tests (no DB).
 * Run: node tests/analyticsEquations.test.js
 *
 * Every fixture is hand-computed. The contract under test:
 *   - all money math happens in integer halalas (float error cannot leak in),
 *   - rounding is half AWAY FROM ZERO at 2dp, exactly once, at the edge,
 *   - ratios with a zero denominator return null (never 0, never Infinity),
 *   - nothing in the module knows a VAT rate.
 */
'use strict';

const E = require('../lib/analytics/equations');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

console.log('\n── halala conversion + rounding contract ──');
test('toMinor converts exact 2dp decimals exactly', () => {
  eq(E.toMinor(1.23), 123);
  eq(E.toMinor(0), 0);
  eq(E.toMinor(1000000.01), 100000001);
});
test('toMinor absorbs binary float error (0.1 + 0.2)', () => {
  eq(E.toMinor(0.1 + 0.2), 30);
});
test('toMinor rounds half away from zero — positive .005 goes UP', () => {
  eq(E.toMinor(2.005), 201);
  eq(E.toMinor(0.005), 1);
});
test('toMinor rounds half away from zero — negative .005 goes DOWN', () => {
  eq(E.toMinor(-2.005), -201);
  eq(E.toMinor(-0.005), -1);
});
test('toMinor does not invent halalas below the half boundary', () => {
  eq(E.toMinor(2.004), 200);
  eq(E.toMinor(-2.004), -200);
});
test('toMinor treats garbage as 0', () => {
  eq(E.toMinor('abc'), 0);
  eq(E.toMinor(null), 0);
  eq(E.toMinor(undefined), 0);
  eq(E.toMinor(NaN), 0);
});
test('fromMinor mirrors toMinor', () => {
  eq(E.fromMinor(123), 1.23);
  eq(E.fromMinor(-50), -0.5);
});
test('roundMoney is the edge rounding, once', () => {
  eq(E.roundMoney(2.005), 2.01);
  eq(E.roundMoney(-2.005), -2.01);
  eq(E.roundMoney(0.1 + 0.2), 0.3);
});
test('round2 is the RATIO rounding: half away from zero on both signs', () => {
  // Mutation gap (EQ-14): round2 must mirror negatives the way toMinor does.
  // A bare Math.round(n * 100 + 1e-9) / 100 rounds -2.005 to -2.00 (toward
  // zero) while +2.005 still goes to 2.01 — a percentage that is biased by a
  // halala in one direction only, which is how a variance report stops adding
  // up. The positive cases pass under BOTH implementations; the negative ones
  // are what pin the contract.
  eq(E.round2(2.005), 2.01);
  eq(E.round2(-2.005), -2.01, 'negative .005 rounds AWAY from zero');
  eq(E.round2(-0.005), -0.01);
  eq(E.round2(0.1 + 0.2), 0.3, 'binary error is absorbed, not rounded up');
});
test('round2 on a non-finite ratio is null, never 0', () => {
  // Mutation gap (EQ-15): 0 here would publish an UNDEFINED ratio (0/0, ∞) as
  // a real "0%" — precisely the lie the module header forbids. Every caller
  // guards its own denominator, so only a direct assertion pins this branch.
  eq(E.round2(NaN), null);
  eq(E.round2(Infinity), null);
  eq(E.round2(-Infinity), null);
  eq(E.round2('abc'), null);
});
test('sumMoney sums raw then rounds once — no per-item drift', () => {
  // 10 × 0.1: float summation gives 0.9999999999999999
  eq(E.sumMoney([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]), 1);
  eq(E.sumMoney([1.11, 2.22, -0.33]), 3);
  eq(E.sumMoney([]), 0);
});

console.log('\n── product sales ──');
test('grossProductSales sums an array of line grosses', () => {
  eq(E.grossProductSales([115, 57.5, 27.6]), 200.1);
});
test('grossProductSales passes a scalar through (already summed)', () => {
  eq(E.grossProductSales(200.1), 200.1);
});
test('netProductSales = gross − discounts − returnsNet', () => {
  eq(E.netProductSales(1000, 50, 25.5), 924.5);
  eq(E.netProductSales(100, 0, 0), 100);
  eq(E.netProductSales(100, 120, 0), -20, 'over-discount goes negative, not clamped');
});
test('netInclVat adds STORED vat — no rate anywhere', () => {
  eq(E.netInclVat(100, 15), 115);
  eq(E.netInclVat(87.72, 4.39), 92.11, 'a 5%-era row still adds correctly');
  eq(E.netInclVat(50, 0), 50, 'zero-rated');
});
test('invoiceTotal = products + modifiers − discounts + fees + tax + rounding', () => {
  eq(E.invoiceTotal(100, 10, 5, 2, 16.05, -0.05), 123);
  eq(E.invoiceTotal(0, 0, 0, 0, 0, 0), 0);
  eq(E.invoiceTotal(99.99, 0.01, 0, 0, 15, 0.25), 115.25, 'rounding may be positive');
});

console.log('\n── profitability ──');
test('grossProfit = net − cogs', () => {
  eq(E.grossProfit(1000, 350), 650);
  eq(E.grossProfit(100, 130), -30, 'a loss is a negative profit, not zero');
});
test('marginPct hand-computed', () => {
  eq(E.marginPct(1000, 350), 65);
  eq(E.marginPct(100, 66.67), 33.33);
  eq(E.marginPct(3, 1), 66.67, '2/3 rounds to 66.67');
});
test('marginPct on zero net is null, not 0%', () => {
  eq(E.marginPct(0, 50), null);
});

console.log('\n── collections & till ──');
test('netCollections = settled − refunds', () => {
  eq(E.netCollections(5000, 123.45), 4876.55);
});
test('expectedCash hand-computed', () => {
  // 500 float + 2000 sales − 150 returns + 100 pay-in − 250 pay-out
  eq(E.expectedCash(500, 2000, 150, 100, 250), 2200);
  eq(E.expectedCash(0, 0, 0, 0, 0), 0);
});
test('expectedCash survives float-hostile inputs', () => {
  eq(E.expectedCash(0.1, 0.2, 0, 0, 0), 0.3);
});
test('tillVariance: shortage is negative', () => {
  eq(E.tillVariance(2150.25, 2200), -49.75);
  eq(E.tillVariance(2200, 2200), 0);
  eq(E.tillVariance(2210, 2200), 10, 'overage is positive');
});

console.log('\n── averages & rates ──');
test('avgTicket hand-computed, 2dp', () => {
  eq(E.avgTicket(1000, 3), 333.33);
  eq(E.avgTicket(100, 8), 12.5);
});
test('avgTicket with zero orders is null', () => {
  eq(E.avgTicket(1000, 0), null);
});
test('avgItemsPerOrder', () => {
  eq(E.avgItemsPerOrder(25, 10), 2.5);
  eq(E.avgItemsPerOrder(10, 3), 3.33);
  eq(E.avgItemsPerOrder(10, 0), null);
});
test('discountPct', () => {
  eq(E.discountPct(50, 1000), 5);
  eq(E.discountPct(1, 3), 33.33);
  eq(E.discountPct(50, 0), null, 'no gross → undefined, not 0%');
});
test('attachRate: modifiers per 100 items', () => {
  eq(E.attachRate(30, 100), 30);
  eq(E.attachRate(1, 3), 33.33);
  eq(E.attachRate(5, 0), null);
});
test('avgModifiersPerItem', () => {
  eq(E.avgModifiersPerItem(45, 30), 1.5);
  eq(E.avgModifiersPerItem(0, 30), 0);
  eq(E.avgModifiersPerItem(45, 0), null);
});
test('ratePct — the cashier discount/void/return rate primitive', () => {
  eq(E.ratePct(3, 40), 7.5);
  eq(E.ratePct(0, 40), 0);
  eq(E.ratePct(3, 0), null);
});
test('contributionPct', () => {
  eq(E.contributionPct(250, 1000), 25);
  eq(E.contributionPct(1, 7), 14.29, '1/7 rounds half away at 2dp');
  eq(E.contributionPct(10, 0), null);
});
test('netQuantity is plain subtraction (quantities, not money)', () => {
  eq(E.netQuantity(10.5, 2.5), 8);
  eq(E.netQuantity(3, 0), 3);
});

console.log('\n── growth ──');
test('growth hand-computed', () => {
  eq(E.growth(120, 100), 20);
  eq(E.growth(80, 100), -20);
  eq(E.growth(100, 100), 0);
  eq(E.growth(1, 3), -66.67);
});
test('growth from a negative base uses |prev| so the sign means direction', () => {
  eq(E.growth(-50, -100), 50, 'losing less is positive growth');
  eq(E.growth(-150, -100), -50);
});
test('growth from zero is null, not Infinity', () => {
  eq(E.growth(120, 0), null);
});

console.log('\n── NO VAT constants: derive-from-rate is not even expressible ──');
test('module exports contain no VAT-deriving function names', () => {
  const names = Object.keys(E).join(' ');
  if (/vatFrom|applyVat|addVat|calcVat/i.test(names)) {
    throw new Error('equations.js must not expose VAT derivation: ' + names);
  }
});

console.log(`\nAnalytics equations: ${_passed}/${_total} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
