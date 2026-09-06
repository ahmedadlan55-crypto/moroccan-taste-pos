#!/usr/bin/env node
'use strict';
/**
 * tests/unit/landedCost.test.js — the landed-cost allocation, pinned without
 * a database (lib/procurement/landedCost.js).
 *
 * WHAT THIS FILE PINS
 *   1. Allocation by VALUE is a share of line_total; by QTY a share of
 *      base_qty; several charges on one receipt accumulate per line.
 *   2. THE EXACT-SUM RULE: every share is rounded to 4 dp and the rounding
 *      residual lands on the LARGEST line (first on a tie) — positive or
 *      negative — so Σ shares == charge total to the last 0.0001. Without it
 *      the GL inventory debit and the GRNI credit disagree by a cent nobody
 *      can explain.
 *   3. landedUnitCost = (line_total + share) / base_qty at 6 dp; a zero
 *      quantity has no unit cost (null), never a division by zero.
 *   4. NULL IS NOT ZERO: a receipt with no charges gets null shares and null
 *      unit costs — a 0 would claim "allocated, came to nothing".
 *   5. Money is never coerced silently: an unknown type, a non-positive
 *      amount, a negative VAT or an unknown method is a VALIDATION_ERROR with
 *      an Arabic message; VAT defaults to 0 and the method to 'value'.
 *   6. Weights that are all zero cannot be spread and the error names the
 *      method that failed (free goods by VALUE is a real situation).
 */

const path = require('path');
const L = require(path.join(__dirname, '..', '..', 'lib', 'procurement', 'landedCost.js'));

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) { check(name, actual === expected, { actual, expected }); }
function throwsCode(name, fn, code, msgRe) {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, e && e.code === code && (!msgRe || msgRe.test(e.message)), { code: e && e.code, message: e && e.message }); }
}
// Σ at 4 dp compared in integer ten-thousandths — no float "almost".
const sum4 = (arr) => arr.reduce((s, x) => s + Math.round(x * 10000), 0) / 10000;

// ── contract constants ────────────────────────────────────────────────────
{
  eq('allocation scale is 4 dp (purchase_receipt_lines.landed_charge_amount is DECIMAL(14,4))', L.ALLOC_DP, 4);
  eq('the five charge types of the API contract', L.CHARGE_TYPES.join(','), 'freight,customs,insurance,handling,other');
  eq('the two allocation methods of the API contract', L.ALLOCATION_METHODS.join(','), 'value,qty');
}

// ── 1. value vs qty ───────────────────────────────────────────────────────
{
  const lines = [{ id: 'A', line_total: 300, base_qty: 10 }, { id: 'B', line_total: 100, base_qty: 30 }];
  const byValue = L.allocateCharges(lines, [{ chargeType: 'freight', amount: 100 }]);
  eq('by value: A gets 300/400 of 100', byValue.lines[0].landedChargeAmount, 75);
  eq('by value: B gets 100/400 of 100', byValue.lines[1].landedChargeAmount, 25);
  eq('chargesTotal is the charge', byValue.chargesTotal, 100);
  eq('line identity is carried back (id)', byValue.lines[1].id, 'B');
  eq('line identity is carried back (index)', byValue.lines[1].index, 1);

  const byQty = L.allocateCharges(lines, [{ chargeType: 'customs', amount: 100, allocationMethod: 'qty' }]);
  eq('by qty: A gets 10/40 of 100', byQty.lines[0].landedChargeAmount, 25);
  eq('by qty: B gets 30/40 of 100', byQty.lines[1].landedChargeAmount, 75);

  const both = L.allocateCharges(lines, [
    { chargeType: 'freight', amount: 100 },
    { chargeType: 'customs', amount: 60, allocationMethod: 'qty' },
  ]);
  eq('two charges accumulate per line: A = 75 + 15', both.lines[0].landedChargeAmount, 90);
  eq('two charges accumulate per line: B = 25 + 45', both.lines[1].landedChargeAmount, 70);
  eq('chargesTotal is Σ charges', both.chargesTotal, 160);
  eq('snake_case (DB row) keys are accepted too',
    L.allocateCharges(lines, [{ charge_type: 'freight', amount: '100', allocation_method: 'qty' }]).lines[1].landedChargeAmount, 75);
  eq('camelCase line keys are accepted too',
    L.allocateCharges([{ lineTotal: 300, baseQty: 10 }, { lineTotal: 100, baseQty: 30 }], [{ chargeType: 'freight', amount: 100 }]).lines[0].landedChargeAmount, 75);
}

// ── 2. the exact-sum rule ─────────────────────────────────────────────────
{
  // Three equal lines: 33.3333 × 3 = 99.9999 — the missing 0.0001 goes to
  // the largest line, which on a tie is the FIRST.
  const three = L.allocateCharges(
    [{ line_total: 10, base_qty: 1 }, { line_total: 10, base_qty: 1 }, { line_total: 10, base_qty: 1 }],
    [{ chargeType: 'freight', amount: 100 }]);
  const shares = three.lines.map((l) => l.landedChargeAmount);
  eq('positive residual on the first of tied largest lines', JSON.stringify(shares), JSON.stringify([33.3334, 33.3333, 33.3333]));
  eq('Σ shares == charge total EXACTLY', sum4(shares), 100);

  // 1 : 1 : 4 → 0.1667 + 0.1667 + 0.6667 = 1.0001 — a NEGATIVE residual,
  // also on the largest line, which here is the LAST.
  const neg = L.allocateCharges(
    [{ line_total: 1, base_qty: 1 }, { line_total: 1, base_qty: 1 }, { line_total: 4, base_qty: 1 }],
    [{ chargeType: 'freight', amount: 1 }]);
  eq('negative residual on the largest line (last here)',
    JSON.stringify(neg.lines.map((l) => l.landedChargeAmount)), JSON.stringify([0.1667, 0.1667, 0.6666]));
  eq('… and the sum is still exact', sum4(neg.lines.map((l) => l.landedChargeAmount)), 1);

  // The residual follows the WEIGHT of the method in force: by qty the
  // largest line is the one with the most units, not the highest value.
  const qtyRes = L.allocateCharges(
    [{ line_total: 900, base_qty: 1 }, { line_total: 1, base_qty: 1 }, { line_total: 1, base_qty: 1 }],
    [{ chargeType: 'freight', amount: 100, allocationMethod: 'qty' }]);
  eq('by qty, three lines of one unit each tie — residual to the first',
    JSON.stringify(qtyRes.lines.map((l) => l.landedChargeAmount)), JSON.stringify([33.3334, 33.3333, 33.3333]));

  // splitExact directly: zero/negative weights receive nothing.
  eq('a zero weight receives nothing', JSON.stringify(L.splitExact(10, [0, 1, 1])), JSON.stringify([0, 5, 5]));
  eq('a negative weight receives nothing', JSON.stringify(L.splitExact(10, [-5, 1, 1])), JSON.stringify([0, 5, 5]));

  // Property: 300 pseudo-random receipts, every one sums exactly.
  let seed = 20260906;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let exact = 0, tried = 0;
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rnd() * 7);
    const lines = Array.from({ length: n }, () => ({ line_total: Math.round(rnd() * 100000) / 100 + 0.01, base_qty: Math.round(rnd() * 10000) / 100 + 0.01 }));
    const charges = [
      { chargeType: 'freight', amount: Math.round(rnd() * 100000) / 100 + 0.01, allocationMethod: rnd() < 0.5 ? 'value' : 'qty' },
      { chargeType: 'other', amount: Math.round(rnd() * 1000) / 100 + 0.01, allocationMethod: rnd() < 0.5 ? 'value' : 'qty' },
    ];
    const out = L.allocateCharges(lines, charges);
    tried++;
    if (sum4(out.lines.map((l) => l.landedChargeAmount)) === out.chargesTotal) exact++;
  }
  eq(`Σ shares == chargesTotal exactly on ${tried}/${tried} random receipts`, exact, tried);
}

// ── 3. unit cost math ─────────────────────────────────────────────────────
{
  const out = L.allocateCharges(
    [{ line_total: 300, base_qty: 10 }, { line_total: 100, base_qty: 10 }],
    [{ chargeType: 'freight', amount: 100 }, { chargeType: 'customs', amount: 60, allocationMethod: 'qty' }]);
  eq('landedUnitCost = (300 + 105) / 10', out.lines[0].landedUnitCost, 40.5);
  eq('landedUnitCost = (100 + 55) / 10', out.lines[1].landedUnitCost, 15.5);
  const dp6 = L.allocateCharges([{ line_total: 100, base_qty: 3 }, { line_total: 200, base_qty: 3 }], [{ chargeType: 'freight', amount: 10 }]);
  eq('unit cost is rounded at 6 dp: (100 + 3.3333) / 3 = 34.4444333…', dp6.lines[0].landedUnitCost, 34.444433);
  eq('unit cost is rounded at 6 dp: (200 + 6.6667) / 3 = 68.8889 exactly', dp6.lines[1].landedUnitCost, 68.8889);
  const zeroQty = L.allocateCharges([{ line_total: 100, base_qty: 0 }, { line_total: 100, base_qty: 5 }], [{ chargeType: 'freight', amount: 10 }]);
  eq('a zero-quantity line still receives its value share', zeroQty.lines[0].landedChargeAmount, 5);
  eq('… but has NO unit cost (null), never a division by zero', zeroQty.lines[0].landedUnitCost, null);
}

// ── 4. NULL is not zero ───────────────────────────────────────────────────
{
  const none = L.allocateCharges([{ id: 'A', line_total: 300, base_qty: 10 }], []);
  eq('no charges → chargesTotal 0', none.chargesTotal, 0);
  eq('no charges → landedChargeAmount is null, NOT 0', none.lines[0].landedChargeAmount, null);
  eq('no charges → landedUnitCost is null, NOT the base cost', none.lines[0].landedUnitCost, null);
  const undef = L.allocateCharges([{ line_total: 300, base_qty: 10 }], undefined);
  eq('an absent charges key is the same as none', undef.lines[0].landedChargeAmount, null);
  eq('normalizeCharges(null) is an empty list', L.normalizeCharges(null).length, 0);
}

// ── 5. money is never coerced silently ────────────────────────────────────
{
  const n = L.normalizeCharges([{ chargeType: 'FREIGHT', amount: '100.005', description: '  شحن بحري  ', supplierId: ' SUP-1 ' }]);
  eq('type is lower-cased', n[0].chargeType, 'freight');
  eq('amount is money (2 dp, half-up)', n[0].amount, 100.01);
  eq('VAT defaults to 0', n[0].vatAmount, 0);
  eq("method defaults to 'value'", n[0].allocationMethod, 'value');
  eq('description is trimmed', n[0].description, 'شحن بحري');
  eq('supplierId is trimmed', n[0].supplierId, 'SUP-1');
  eq('an empty description is null', L.normalizeCharges([{ chargeType: 'other', amount: 1, description: '   ' }])[0].description, null);
  eq('a missing supplier is null', L.normalizeCharges([{ chargeType: 'other', amount: 1 }])[0].supplierId, null);

  throwsCode('a non-array is refused', () => L.normalizeCharges({ chargeType: 'freight', amount: 1 }), 'VALIDATION_ERROR', /قائمة/);
  throwsCode('an unknown type is refused, naming the row', () => L.normalizeCharges([{ chargeType: 'teleport', amount: 1 }]), 'VALIDATION_ERROR', /السطر 1/);
  throwsCode('a zero amount is refused', () => L.normalizeCharges([{ chargeType: 'freight', amount: 0 }]), 'VALIDATION_ERROR', /موجب/);
  throwsCode('a negative amount is refused', () => L.normalizeCharges([{ chargeType: 'freight', amount: -5 }]), 'VALIDATION_ERROR', /موجب/);
  throwsCode('a non-numeric amount is refused', () => L.normalizeCharges([{ chargeType: 'freight', amount: 'abc' }]), 'VALIDATION_ERROR');
  throwsCode('a negative VAT is refused', () => L.normalizeCharges([{ chargeType: 'freight', amount: 1, vatAmount: -1 }]), 'VALIDATION_ERROR', /سالبة/);
  throwsCode('an unknown method is refused', () => L.normalizeCharges([{ chargeType: 'freight', amount: 1, allocationMethod: 'weight' }]), 'VALIDATION_ERROR', /طريقة/);
  throwsCode('a null row is refused', () => L.normalizeCharges([null]), 'VALIDATION_ERROR');
}

// ── 6. weights that cannot be spread ──────────────────────────────────────
{
  throwsCode('all-zero VALUE weights name the method (free goods → use qty)',
    () => L.allocateCharges([{ line_total: 0, base_qty: 5 }], [{ chargeType: 'freight', amount: 10 }]), 'VALIDATION_ERROR', /بالقيمة/);
  throwsCode('all-zero QTY weights name the method',
    () => L.allocateCharges([{ line_total: 50, base_qty: 0 }], [{ chargeType: 'freight', amount: 10, allocationMethod: 'qty' }]), 'VALIDATION_ERROR', /بالكمية/);
  throwsCode('charges on a receipt with no lines',
    () => L.allocateCharges([], [{ chargeType: 'freight', amount: 10 }]), 'VALIDATION_ERROR', /بلا سطور/);
  eq('free goods CAN be spread by qty', L.allocateCharges([{ line_total: 0, base_qty: 5 }], [{ chargeType: 'freight', amount: 10, allocationMethod: 'qty' }]).lines[0].landedChargeAmount, 10);
}

// ── roundExactTo (per-warehouse inventory debits) ─────────────────────────
{
  // Ties are decided on the ROUNDED parts, first wins — the same rule as splitExact.
  eq('parts are rounded to 2 dp and forced to the total (tie → first)', JSON.stringify(L.roundExactTo([33.333, 33.333, 33.334], 100)), JSON.stringify([33.34, 33.33, 33.33]));
  eq('the residual goes to the largest part', JSON.stringify(L.roundExactTo([30.004, 30.004, 39.994], 100.01)), JSON.stringify([30, 30, 40.01]));
  eq('a negative residual too', JSON.stringify(L.roundExactTo([10.004, 20.004, 30.004], 60)), JSON.stringify([10, 20, 30]));
  eq('an empty list stays empty', L.roundExactTo([], 0).length, 0);
}

if (failures.length) {
  console.error('\n' + failures.length + ' failure(s):');
  failures.forEach((f) => console.error('  - ' + f));
  console.log(`${pass}/${pass + failures.length} passed`);
  process.exit(1);
}
console.log('  ✅ landed cost: value/qty shares, exact sums with the residual on the largest line, 6-dp unit cost, null-not-zero, money never coerced');
console.log(`${pass}/${pass} passed`);
