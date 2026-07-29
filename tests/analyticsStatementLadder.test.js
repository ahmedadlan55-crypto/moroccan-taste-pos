#!/usr/bin/env node
'use strict';
/**
 * tests/analyticsStatementLadder.test.js — the executive sales statement must
 * FOOT. Pure, no DB.
 *
 * THE DEFECT THIS PINS
 * The statement printed
 *     gross_product_sales − discounts_total − returns_net = net_ex_vat
 *                         + vat_amount + fees_total + rounding_total
 *                         = invoice_total
 * and not one of those relations was true, because the operands sit on three
 * different bases:
 *   • gross_product_sales is Σ d.gross_amount, which BOTH writers produce as
 *     net + VAT AFTER the discount (lineAllocation.js:263 / calculations.js:138)
 *     — tax-INCLUSIVE, post-discount, and equal to the invoice total by the
 *     allocation invariant at lineAllocation.js:242,
 *   • discounts_total is Σ f.discount_total = sales.discount_amount =
 *     routes/sales.js:736 appliedDiscountTotal — tax-INCLUSIVE, and already
 *     removed from the figure above, so subtracting it removes it twice,
 *   • returns_net is Σ rl.net_amount — EX-VAT (SalesReturnService.js:92),
 *   • fees_total is sales.kita_service_fee, which never enters total_final
 *     (routes/sales.js:753), and rounding_total is a literal 0
 *     (ProjectionService.js:284).
 *
 * WHAT IS ASSERTED HERE
 * Every fixture below is a hand-computed period of FACT ROWS shaped exactly like
 * the columns the projection writes. For each one:
 *   1. the additive metrics are summed from the very columns the registry's SQL
 *      names (the column map is asserted against metrics.js, so a registry SQL
 *      change fails here rather than drifting silently),
 *   2. the derived metrics are evaluated the way QueryService.computeDerived
 *      does — equations.js function, positional inputs, integer halalas,
 *   3. each ladder line is asserted to be the EXACT arithmetic result of the
 *      lines above it, to the halala, on ONE stated basis,
 *   4. the old mixed-basis subtraction is re-run and asserted to be WRONG, so a
 *      revert cannot pass this file.
 *
 * Run: node tests/analyticsStatementLadder.test.js
 */

const { byId } = require('../lib/analytics/registry/metrics');
const EQ = require('../lib/analytics/equations');

let _passed = 0;
const _failures = [];
function test(name, fn) {
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failures.push(name + ' → ' + e.message); console.log('  ❌', name); console.log('     ', e.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function ne(actual, forbidden, msg) {
  if (actual === forbidden) throw new Error((msg || 'ne') + ': must NOT equal ' + JSON.stringify(forbidden));
}

/* ── the fixture ↔ registry binding ──────────────────────────────────────────
 * metric id → [fixture bucket, column]. Each entry is checked against the
 * metric's real `sql` before any fixture is summed: if someone repoints
 * gross_product_sales at another column, this file stops being a valid model of
 * the registry and says so instead of quietly agreeing with itself. */
const COLUMN_OF = Object.freeze({
  gross_product_sales: ['lines', 'gross_amount', 'd'],
  net_ex_vat: ['lines', 'net_amount', 'd'],
  vat_amount: ['lines', 'vat_amount', 'd'],
  discounts_line: ['lines', 'discount_amount', 'd'],
  discounts_total: ['orders', 'discount_total', 'f'],
  fees_total: ['orders', 'fees_amount', 'f'],
  rounding_total: ['orders', 'rounding_amount', 'f'],
  returns_net: ['returns', 'net_amount', 'rl'],
  returns_vat: ['returns', 'vat_amount', 'rl'],
  returns_value: ['returns', 'gross_amount', 'rl'],
});

/** invoice_total reads doc.total_amount off the ORDER fact's join partner. */
const INVOICE_TOTAL_COLUMN = ['orders', 'total_amount', 'doc'];

function assertColumnBinding() {
  for (const [id, [, column, alias]] of Object.entries(COLUMN_OF)) {
    const m = byId[id];
    if (!m) throw new Error(`metric "${id}" is missing from the registry`);
    eq(m.sql, `SUM(${alias}.${column})`, `${id}.sql`);
  }
  eq(byId.invoice_total.sql, `SUM(${INVOICE_TOTAL_COLUMN[2]}.${INVOICE_TOTAL_COLUMN[1]})`, 'invoice_total.sql');
}

/** Σ a column across a fixture bucket, in integer halalas, rounded once. */
function sumColumn(period, bucket, column) {
  return EQ.sumMoney((period[bucket] || []).map((row) => row[column] || 0));
}

/**
 * Every metric the statement uses, computed from one fixture period — the same
 * two steps QueryService takes: additive sums first, then derived equations
 * over those sums (positional inputs, exactly like computeDerived).
 */
function metricsFor(period) {
  const v = {};
  for (const [id, [bucket, column]] of Object.entries(COLUMN_OF)) {
    v[id] = sumColumn(period, bucket, column);
  }
  v.invoice_total = sumColumn(period, INVOICE_TOTAL_COLUMN[0], INVOICE_TOTAL_COLUMN[1]);

  for (const id of ['sales_before_discount', 'net_product_sales', 'net_product_sales_ex_vat',
    'statement_variance', 'net_incl_vat']) {
    const m = byId[id];
    if (!m) throw new Error(`derived metric "${id}" is missing from the registry`);
    const fn = EQ[m.equationKey];
    if (typeof fn !== 'function') throw new Error(`${id}: equationKey "${m.equationKey}" is not an equations.js function`);
    v[id] = fn(...m.inputs.map((i) => v[i]));
  }
  return v;
}

/**
 * The two ladders, asserted line by line. `v` is the metric bag above.
 * Returns nothing — it throws on the first line that is not the exact result of
 * the lines above it.
 */
function assertLaddersFoot(v, label) {
  // ── tax-INCLUSIVE ladder ──
  //     sales before discount (incl VAT)
  //   − discounts given       (incl VAT)
  //   = invoiced to customers (incl VAT)
  //   − returns               (incl VAT)
  //   = net sales after returns (incl VAT)
  eq(EQ.roundMoney(v.sales_before_discount - v.discounts_total), v.gross_product_sales,
    `${label}: (sales before discount − discounts) must equal the invoiced amount`);
  eq(EQ.roundMoney(v.gross_product_sales - v.returns_value), v.net_product_sales,
    `${label}: (invoiced − returns incl VAT) must equal net sales incl VAT`);

  // ── EX-VAT ladder ──
  //     net sales ex VAT (already net of every discount)
  //   − returns ex VAT
  //   = net sales after returns, ex VAT
  eq(EQ.roundMoney(v.net_ex_vat - v.returns_net), v.net_product_sales_ex_vat,
    `${label}: (net ex-VAT − returns ex-VAT) must equal net sales ex VAT`);

  // ── the bridge between the two bases, built only from STORED VAT columns ──
  eq(EQ.roundMoney(v.net_product_sales_ex_vat + v.vat_amount - v.returns_vat), v.net_product_sales,
    `${label}: ex-VAT bottom line + VAT on sales − VAT on returns must equal the incl-VAT bottom line`);
  eq(v.net_incl_vat, v.gross_product_sales,
    `${label}: net_ex_vat + vat_amount must equal Σ line gross (they are the same money)`);

  // ── the control: headers vs lines ──
  eq(EQ.roundMoney(v.gross_product_sales + v.statement_variance), v.invoice_total,
    `${label}: invoiced + variance must equal the invoice headers`);
}

/** The ladder that shipped, re-run so a revert cannot pass this file. */
function oldLadderResult(v) {
  return EQ.roundMoney(v.gross_product_sales - v.discounts_total - v.returns_net);
}
function oldLadderTail(v) {
  return EQ.roundMoney(v.net_ex_vat + v.vat_amount + v.fees_total + v.rounding_total);
}

/* ── fixtures ────────────────────────────────────────────────────────────────
 * Column names are the real ones. A "line" is an ar_document_lines row, an
 * "order" carries analytics_order_facts + ar_documents, a "return" is a
 * sales_return_lines row. */

// P1 — the simplest honest period: one standard-rated line, no discount, no
//      return, no fee. Everything must already agree here or nothing will.
const P1 = {
  lines: [{ net_amount: 100, vat_amount: 15, gross_amount: 115, discount_amount: 0 }],
  orders: [{ total_amount: 115, discount_total: 0, fees_amount: 0, rounding_amount: 0 }],
  returns: [],
};

// P2 — an ORDER-LEVEL discount, applied in gross space, across a mixed cart
//      (the shape of the live seed's D1). 15.75 of gross discount is ALREADY
//      out of every line below; the header records it once more as the applied
//      total. This is the fixture the shipped ladder got wrong.
const P2 = {
  lines: [
    { net_amount: 100, vat_amount: 15, gross_amount: 115, discount_amount: 10 },   // standard
    { net_amount: 20, vat_amount: 0, gross_amount: 20, discount_amount: 0 },       // zero-rated
    { net_amount: 60, vat_amount: 9, gross_amount: 69, discount_amount: 5.75 },    // standard
  ],
  orders: [{ total_amount: 204, discount_total: 15.75, fees_amount: 0, rounding_amount: 0 }],
  returns: [],
};

// P3 — P2 plus a posted return of the whole first line. The return carries its
//      own VAT, so it lands on BOTH bases without anyone deriving a rate.
const P3 = {
  lines: P2.lines,
  orders: P2.orders,
  returns: [{ net_amount: 100, vat_amount: 15, gross_amount: 115 }],
};

// P4 — halala closure plus the two figures that are NOT invoice money:
//      a fee (sales.kita_service_fee, persisted beside total_final) and a
//      rounding amount (a column the projection writes as 0 — set non-zero here
//      precisely to prove the ladder does not touch it). The three 0.10 lines
//      make the naive float sum 0.30000000000000004.
const P4 = {
  lines: [
    { net_amount: 0.1, vat_amount: 0, gross_amount: 0.1, discount_amount: 0 },
    { net_amount: 0.1, vat_amount: 0, gross_amount: 0.1, discount_amount: 0 },
    { net_amount: 0.1, vat_amount: 0, gross_amount: 0.1, discount_amount: 0.1 },
  ],
  orders: [{ total_amount: 0.3, discount_total: 0.1, fees_amount: 3, rounding_amount: 0.25 }],
  returns: [],
};

// P5 — standard + zero-rated + exempt in one period. VAT is 30.00 on a 350.00
//      base: 8.57%, not 15%. Any ladder that assumes a single rate breaks here.
const P5 = {
  lines: [
    { net_amount: 200, vat_amount: 30, gross_amount: 230, discount_amount: 0 },  // S
    { net_amount: 100, vat_amount: 0, gross_amount: 100, discount_amount: 0 },   // Z
    { net_amount: 50, vat_amount: 0, gross_amount: 50, discount_amount: 0 },     // E
  ],
  orders: [{ total_amount: 380, discount_total: 0, fees_amount: 0, rounding_amount: 0 }],
  returns: [{ net_amount: 50, vat_amount: 0, gross_amount: 50 }],                // a zero-rated return
};

console.log('\n── the fixture models the registry, not itself ──');
test('every fixture column is the column the registry SQL actually sums', assertColumnBinding);

console.log('\n── P1: plain period ──');
test('P1 sums to the hand-computed figures', () => {
  const v = metricsFor(P1);
  eq(v.gross_product_sales, 115);
  eq(v.net_ex_vat, 100);
  eq(v.vat_amount, 15);
  eq(v.invoice_total, 115);
  eq(v.sales_before_discount, 115, 'no discount ⇒ before-discount IS the invoiced amount');
  eq(v.statement_variance, 0);
});
test('P1: both ladders foot exactly', () => assertLaddersFoot(metricsFor(P1), 'P1'));

console.log('\n── P2: order-level discount, recorded in GROSS space ──');
test('P2 sums to the hand-computed figures', () => {
  const v = metricsFor(P2);
  eq(v.gross_product_sales, 204, 'Σ line gross');
  eq(v.net_ex_vat, 180);
  eq(v.vat_amount, 24);
  eq(v.discounts_total, 15.75);
  eq(v.discounts_line, 15.75, 'the per-line allocation is the SAME money as the header total');
  eq(v.invoice_total, 204);
  eq(v.sales_before_discount, 219.75, '204 + 15.75, reconstructed in gross space');
});
test('P2: both ladders foot exactly', () => assertLaddersFoot(metricsFor(P2), 'P2'));
test('P2: the SHIPPED ladder does not foot — 188.25 asserted as 180.00', () => {
  const v = metricsFor(P2);
  eq(oldLadderResult(v), 188.25, 'gross − discounts − returns_net');
  ne(oldLadderResult(v), v.net_ex_vat, 'the old subtraction must not equal the "=" line it printed');
  eq(EQ.roundMoney(oldLadderResult(v) - v.net_ex_vat), 8.25,
    'the gap is the VAT (24.00) less the discount double-subtracted (15.75)');
});
test('P2: an ex-VAT ladder may NOT subtract the gross discount', () => {
  const v = metricsFor(P2);
  // The tempting "fix" — keep the ex-VAT basis and just subtract the discount —
  // is still wrong twice over: the discount is already out of net_ex_vat, and it
  // carries VAT that net_ex_vat does not.
  ne(EQ.roundMoney(v.net_ex_vat - v.discounts_total), v.net_product_sales_ex_vat,
    'net_ex_vat − discounts_total is not a revenue figure');
});

console.log('\n── P3: a posted return ──');
test('P3 sums to the hand-computed figures', () => {
  const v = metricsFor(P3);
  eq(v.returns_net, 100, 'ex-VAT');
  eq(v.returns_vat, 15);
  eq(v.returns_value, 115, 'incl VAT');
  eq(v.net_product_sales_ex_vat, 80, '180 − 100');
  eq(v.net_product_sales, 89, '204 − 115');
});
test('P3: both ladders foot exactly', () => assertLaddersFoot(metricsFor(P3), 'P3'));
test('P3: returns must be subtracted on the MATCHING basis, never across bases', () => {
  const v = metricsFor(P3);
  ne(EQ.roundMoney(v.gross_product_sales - v.returns_net), v.net_product_sales,
    'incl-VAT sales minus ex-VAT returns is not the incl-VAT bottom line');
  ne(EQ.roundMoney(v.net_ex_vat - v.returns_value), v.net_product_sales_ex_vat,
    'ex-VAT sales minus incl-VAT returns is not the ex-VAT bottom line');
  eq(EQ.roundMoney(v.net_product_sales - v.net_product_sales_ex_vat), 9,
    'the two bottom lines differ by exactly the net VAT (24 − 15)');
});

console.log('\n── P4: halalas, fees and rounding ──');
test('P4 closes in integer halalas, not floats', () => {
  const v = metricsFor(P4);
  eq(v.gross_product_sales, 0.3, '0.1 + 0.1 + 0.1 — float would give 0.30000000000000004');
  eq(v.sales_before_discount, 0.4);
  eq(EQ.roundMoney(v.sales_before_discount - v.discounts_total), 0.3);
});
test('P4: both ladders foot exactly', () => assertLaddersFoot(metricsFor(P4), 'P4'));
test('P4: fees and rounding are NOT invoice money', () => {
  const v = metricsFor(P4);
  eq(v.fees_total, 3, 'the fee is recorded…');
  eq(v.rounding_total, 0.25, '…and so is the rounding column…');
  eq(v.invoice_total, 0.3, '…but neither is inside the invoice total');
  ne(oldLadderTail(v), v.invoice_total,
    'net + VAT + fees + rounding overstates the invoice total by exactly the memo figures');
  eq(EQ.roundMoney(oldLadderTail(v) - v.invoice_total), 3.25, 'overstated by fees + rounding');
});

console.log('\n── P5: zero-rated and exempt lines ──');
test('P5: VAT is a stored per-line figure, not a rate applied to the total', () => {
  const v = metricsFor(P5);
  eq(v.net_ex_vat, 350);
  eq(v.vat_amount, 30, '15% on the 200.00 standard base only');
  ne(v.vat_amount, EQ.roundMoney(v.net_ex_vat * 0.15), 'a flat 15% of net would say 52.50');
  // What the VAT close does (routes/erp/vat.js:82) — total − total/1.15 over
  // SUM(sales.total_final), i.e. the standard rate applied to every riyal.
  const closeStyleVat = EQ.roundMoney(v.invoice_total - v.invoice_total / 1.15);
  ne(closeStyleVat, v.vat_amount, 'the divide-by-1.15 close cannot reproduce a mixed-rate period');
  eq(closeStyleVat, 49.57, 'it would claim 49.57 where the invoices charged 30.00');
});
test('P5: both ladders foot exactly with mixed VAT categories', () => assertLaddersFoot(metricsFor(P5), 'P5'));
test('P5: a zero-rated return crosses the bridge without inventing VAT', () => {
  const v = metricsFor(P5);
  eq(v.returns_net, 50);
  eq(v.returns_vat, 0, 'nothing to give back on a zero-rated line');
  eq(v.returns_value, 50);
  eq(v.net_product_sales_ex_vat, 300);
  eq(v.net_product_sales, 330, '300 + 30 VAT on sales − 0 VAT on returns');
});

console.log('\n── the registry keeps the ladder honest ──');
test('net_product_sales no longer mixes three bases', () => {
  const m = byId.net_product_sales;
  eq(m.equationKey, 'netSalesInclVat');
  eq(m.inputs.join(','), 'gross_product_sales,returns_value', 'both operands incl VAT');
  eq(m.version, 2, 'a redefinition, not a rename');
});
test('net_product_sales_ex_vat is the ex-VAT twin and takes only ex-VAT inputs', () => {
  const m = byId.net_product_sales_ex_vat;
  eq(m.inputs.join(','), 'net_ex_vat,returns_net');
});
test('sales_before_discount adds the discount back in gross space only', () => {
  const m = byId.sales_before_discount;
  eq(m.inputs.join(','), 'gross_product_sales,discounts_total');
});
test('statement_variance compares headers to lines and nothing else', () => {
  const m = byId.statement_variance;
  eq(m.inputs.join(','), 'invoice_total,gross_product_sales');
});
test('returns_vat reads the stored return VAT column, never a rate', () => {
  const m = byId.returns_vat;
  eq(m.fact, 'return');
  eq(m.sql, 'SUM(rl.vat_amount)');
});

console.log(`\n${_passed} passed, ${_failures.length} failed`);
if (_failures.length) {
  console.error('\nFAILED:\n  ' + _failures.join('\n  '));
  process.exit(1);
}
console.log('✅ analytics statement ladder: one basis per ladder, every "=" is the exact arithmetic result');
