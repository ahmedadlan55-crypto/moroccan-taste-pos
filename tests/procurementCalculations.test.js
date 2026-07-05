/**
 * Procurement calculations — pure-function tests (no DB).
 * Run: node tests/procurementCalculations.test.js
 *
 * Covers: UoM conversion (10 cartons × 12 = 120 base), majorPrice = base×factor,
 * VAT 15% / 0% / exempt / inclusive, the `vatRate || 15` regression, totals.
 */
'use strict';

const C = require('../lib/procurement/calculations');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function near(actual, expected, msg, tol = 0.005) {
  if (Math.abs(actual - expected) > tol) throw new Error((msg || 'near') + ': expected ~' + expected + ', got ' + actual);
}
function throws(fn, code) {
  let t = false;
  try { fn(); } catch (e) { t = true; if (code && e.code !== code) throw new Error('expected code ' + code + ' got ' + e.code); }
  if (!t) throw new Error('expected throw' + (code ? ' (' + code + ')' : ''));
}

console.log('\n── UoM conversion ──');
test('10 cartons × factor 12 = 120 base', () => {
  eq(C.toBaseQty(10, 12), 120);
});
test('composite: entered 10 cartons, base qty is 120 in computeLine', () => {
  const l = C.computeLine({ enteredQty: 10, factor: 12, unitPriceEntered: 120, vatRate: 15 }, 15);
  eq(l.baseQty, 120);
});
test('majorPrice = basePrice × factor', () => {
  eq(C.toMajorPrice(10, 12), 120);
});
test('baseUnitPrice = enteredPrice / factor (no wrong division)', () => {
  // enter 120 per carton → base (piece) price = 10
  eq(C.toBaseUnitPrice(120, 12), 10);
});
test('zero / negative factor rejected', () => {
  throws(() => C.toBaseQty(1, 0), 'UNIT_CONVERSION_CONFLICT');
});

console.log('\n── VAT ──');
test('15% exclusive: net 1000 → vat 150, total 1150', () => {
  const l = C.computeLine({ enteredQty: 10, factor: 1, unitPriceEntered: 100, vatRate: 15 }, 15);
  near(l.net, 1000); near(l.vatAmount, 150); near(l.lineTotal, 1150);
});
test('0% VAT stays 0 (does NOT clobber to 15)', () => {
  const l = C.computeLine({ enteredQty: 10, factor: 1, unitPriceEntered: 100, vatRate: 0 }, 15);
  eq(l.vatRate, 0); near(l.vatAmount, 0); near(l.lineTotal, 1000);
});
test('taxCode Z (zero-rated) → rate 0', () => {
  const r = C.resolveVatRate({ taxCode: 'Z', standardRate: 15 });
  eq(r.rate, 0); eq(r.taxable, false);
});
test('taxCode E (exempt) → rate 0', () => {
  eq(C.resolveVatRate({ taxCode: 'E', standardRate: 15 }).rate, 0);
});
test('taxCode O (out of scope) → rate 0', () => {
  eq(C.resolveVatRate({ taxCode: 'O', standardRate: 15 }).rate, 0);
});
test('default standard code → settings rate', () => {
  eq(C.resolveVatRate({ taxCode: 'S', standardRate: 15 }).rate, 15);
  eq(C.resolveVatRate({ standardRate: 5 }).rate, 5);
});
test('unknown tax code → TAX_CONFIGURATION_ERROR (never silent 15)', () => {
  throws(() => C.resolveVatRate({ taxCode: 'ZZZ', standardRate: 15 }), 'TAX_CONFIGURATION_ERROR');
});
test('inclusive 15%: gross 1150 → net 1000, vat 150', () => {
  const l = C.computeLine({ enteredQty: 1, factor: 1, unitPriceEntered: 1150, vatRate: 15, inclusiveTax: true }, 15);
  near(l.net, 1000); near(l.vatAmount, 150); near(l.lineTotal, 1150);
});

console.log('\n── discount + totals ──');
test('line discount reduces taxable base', () => {
  const l = C.computeLine({ enteredQty: 10, factor: 1, unitPriceEntered: 100, discount: 100, vatRate: 15 }, 15);
  near(l.net, 900); near(l.vatAmount, 135); near(l.lineTotal, 1035);
});
test('document totals aggregate lines', () => {
  const a = C.computeLine({ enteredQty: 10, factor: 1, unitPriceEntered: 100, vatRate: 15 }, 15);
  const b = C.computeLine({ enteredQty: 5, factor: 1, unitPriceEntered: 100, vatRate: 0 }, 15);
  const t = C.computeTotals([a, b]);
  near(t.subtotal, 1500); near(t.vatAmount, 150); near(t.total, 1650);
});
test('zero/negative qty rejected', () => {
  throws(() => C.computeLine({ enteredQty: 0, factor: 1, unitPriceEntered: 100, vatRate: 15 }, 15), 'VALIDATION_ERROR');
});

console.log('\n── WAC ──');
test('WAC: 100@5 + 100@7 = 6', () => {
  eq(C.newWAC(100, 5, 100, 7), 6);
});
test('WAC from empty stock = incoming cost', () => {
  eq(C.newWAC(0, 0, 50, 8), 8);
});

console.log(`\nProcurement calculations: ${_passed}/${_total} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
