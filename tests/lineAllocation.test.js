/**
 * POS→O2C line allocation — pure-function tests (no DB).
 * Run: node tests/lineAllocation.test.js
 *
 * The allocator fits per-line snapshots to figures the checkout already
 * recorded. Every case therefore asserts the same four invariants, because a
 * line that disagrees with its tax bucket by one halala breaks the ZATCA UBL
 * sum, and one that disagrees with total_final breaks the GL:
 *
 *   1. Σ line net per category === the category's final net
 *   2. Σ line vat per category === the category's final vat
 *   3. Σ line gross (all lines)  === total_final
 *   4. Σ line discount           === the APPLIED discount
 *
 * Covers: 15%, 5%, zero-rated, exempt, mixed carts, discounts, positive and
 * negative rounding deltas, single and many lines, halala-splitting remainders,
 * exact ties, and determinism.
 */
'use strict';

const A = require('../lib/order-to-cash/lineAllocation');

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
function throws(fn, code) {
  let t = false;
  try { fn(); } catch (e) { t = true; if (code && e.code !== code) throw new Error('expected code ' + code + ' got ' + e.code); }
  if (!t) throw new Error('expected throw' + (code ? ' (' + code + ')' : ''));
}

/**
 * Assert all four invariants. Called by every allocation case — the point of
 * the allocator is that these hold unconditionally, so testing them per-case
 * is the actual contract rather than a formality.
 */
function invariants(res, { taxSubtotals, appliedDiscount, totalFinal }, label) {
  Object.keys(taxSubtotals).forEach((cat) => {
    const mine = res.lines.filter((l) => l.cat === cat);
    const sumNet = mine.reduce((s, l) => s + l.netMinor, 0);
    const sumVat = mine.reduce((s, l) => s + l.vatMinor, 0);
    eq(sumNet, A.toMinor(taxSubtotals[cat].net), `${label}: net ties for ${cat}`);
    eq(sumVat, A.toMinor(taxSubtotals[cat].vat), `${label}: vat ties for ${cat}`);
  });
  eq(res.lines.reduce((s, l) => s + l.grossMinor, 0), A.toMinor(totalFinal), `${label}: gross sums to total_final`);
  eq(res.lines.reduce((s, l) => s + l.discountMinor, 0), A.toMinor(appliedDiscount), `${label}: discount sums to applied`);
  res.lines.forEach((l) => {
    eq(l.grossMinor, l.netMinor + l.vatMinor, `${label}: gross === net + vat for ${l.sourceLineId}`);
  });
}

console.log('\n── largestRemainder primitive ──');
test('distributes exactly, no unit lost or invented', () => {
  const parts = A.largestRemainder(100, [1, 1, 1], ['L0', 'L1', 'L2']);
  eq(parts.reduce((a, b) => a + b, 0), 100);
  deep(parts, [34, 33, 33], 'leftover goes to the first key on an exact three-way tie');
});
test('proportional when it divides evenly', () => {
  deep(A.largestRemainder(100, [50, 50], ['L0', 'L1']), [50, 50]);
});
test('proportional when weights are unequal', () => {
  deep(A.largestRemainder(100, [75, 25], ['L0', 'L1']), [75, 25]);
});
test('a tie breaks on sourceLineId ascending, not array order', () => {
  // Same weights, keys deliberately out of order: the leftover halala must go
  // to L0, not to whichever happened to be first in the array.
  const parts = A.largestRemainder(10, [3, 3, 3], ['L2', 'L0', 'L1']);
  eq(parts.reduce((a, b) => a + b, 0), 10);
  deep(parts, [3, 4, 3], 'L0 (index 1) takes the leftover');
});
test('zero weights with a non-zero target fall back to equal, losing nothing', () => {
  const parts = A.largestRemainder(7, [0, 0, 0], ['L0', 'L1', 'L2']);
  eq(parts.reduce((a, b) => a + b, 0), 7);
  deep(parts, [3, 2, 2]);
});
test('zero target yields zeros', () => {
  deep(A.largestRemainder(0, [5, 5], ['L0', 'L1']), [0, 0]);
});
test('negative target allocates by magnitude and re-signs', () => {
  const parts = A.largestRemainder(-100, [1, 1, 1], ['L0', 'L1', 'L2']);
  eq(parts.reduce((a, b) => a + b, 0), -100);
  deep(parts, [-34, -33, -33]);
});
test('empty input yields empty output', () => {
  deep(A.largestRemainder(0, [], []), []);
});
test('single line takes the whole target', () => {
  deep(A.largestRemainder(999, [7], ['L0']), [999]);
});

console.log('\n── 15% standard-rated ──');
test('single line, no discount, no rounding', () => {
  const input = {
    lines: [{ sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 }],
    taxSubtotals: { S: { net: 100, vat: 15, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 115,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, '15% single');
  eq(res.lines[0].net, 100);
  eq(res.lines[0].vat, 15);
  eq(res.lines[0].gross, 115);
});
test('many lines split cleanly', () => {
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 },
      { sourceLineId: 'L1', cat: 'S', rate: 15, net: 200, vat: 30 },
      { sourceLineId: 'L2', cat: 'S', rate: 15, net: 300, vat: 45 },
    ],
    taxSubtotals: { S: { net: 600, vat: 90, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 690,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, '15% many');
  deep(res.lines.map((l) => l.net), [100, 200, 300]);
});

console.log('\n── 5% ──');
test('5% allocates from the bucket, not from the rate', () => {
  // The allocator never recomputes VAT — it fits lines to the recorded bucket.
  // So a 5% cart works even though checkout hardcodes `cat === 'S' ? VAT_RATE : 0`.
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 5, net: 100, vat: 5 },
      { sourceLineId: 'L1', cat: 'S', rate: 5, net: 100, vat: 5 },
    ],
    taxSubtotals: { S: { net: 200, vat: 10, rate: 5 } },
    appliedDiscount: 0,
    totalFinal: 210,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, '5%');
  deep(res.lines.map((l) => l.vat), [5, 5]);
});

console.log('\n── zero-rated and exempt ──');
test('zero-rated cart carries net, never invents VAT', () => {
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'Z', rate: 0, net: 50, vat: 0 },
      { sourceLineId: 'L1', cat: 'Z', rate: 0, net: 50, vat: 0 },
    ],
    taxSubtotals: { Z: { net: 100, vat: 0, rate: 0 } },
    appliedDiscount: 0,
    totalFinal: 100,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'zero-rated');
  eq(res.lines.every((l) => l.vatMinor === 0), true, 'no VAT on a zero-rated cart');
});
test('exempt cart carries net, never invents VAT', () => {
  const input = {
    lines: [{ sourceLineId: 'L0', cat: 'E', rate: 0, net: 80, vat: 0 }],
    taxSubtotals: { E: { net: 80, vat: 0, rate: 0 } },
    appliedDiscount: 0,
    totalFinal: 80,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'exempt');
  eq(res.lines[0].vatMinor, 0);
});

console.log('\n── mixed cart ──');
test('three categories each tie to their own bucket', () => {
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 },
      { sourceLineId: 'L1', cat: 'Z', rate: 0, net: 50, vat: 0 },
      { sourceLineId: 'L2', cat: 'E', rate: 0, net: 25, vat: 0 },
      { sourceLineId: 'L3', cat: 'S', rate: 15, net: 100, vat: 15 },
    ],
    taxSubtotals: {
      S: { net: 200, vat: 30, rate: 15 },
      Z: { net: 50, vat: 0, rate: 0 },
      E: { net: 25, vat: 0, rate: 0 },
    },
    appliedDiscount: 0,
    totalFinal: 305,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'mixed');
});
test('VAT lands only on the standard bucket in a mixed cart', () => {
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 },
      { sourceLineId: 'L1', cat: 'Z', rate: 0, net: 100, vat: 0 },
    ],
    taxSubtotals: { S: { net: 100, vat: 15, rate: 15 }, Z: { net: 100, vat: 0, rate: 0 } },
    appliedDiscount: 0,
    totalFinal: 215,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'mixed vat placement');
  eq(res.lines.find((l) => l.sourceLineId === 'L1').vatMinor, 0);
});

console.log('\n── discount ──');
test('discount is allocated to the applied figure, gross-proportionally', () => {
  // 230.00 gross, 23.00 discount → 207.00, which is already whole SAR.
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 },
      { sourceLineId: 'L1', cat: 'S', rate: 15, net: 100, vat: 15 },
    ],
    taxSubtotals: { S: { net: 180, vat: 27, rate: 15 } },
    appliedDiscount: 23,
    totalFinal: 207,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'discount');
  deep(res.lines.map((l) => l.discount), [11.5, 11.5], 'split evenly across equal lines');
});
test('an odd discount halala is not lost across three equal lines', () => {
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 },
      { sourceLineId: 'L1', cat: 'S', rate: 15, net: 100, vat: 15 },
      { sourceLineId: 'L2', cat: 'S', rate: 15, net: 100, vat: 15 },
    ],
    taxSubtotals: { S: { net: 290.43, vat: 43.57, rate: 15 } },
    appliedDiscount: 11,
    totalFinal: 334,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'odd discount halala');
  eq(res.lines.reduce((s, l) => s + l.discountMinor, 0), 1100);
});
test('a discount that consumes the whole cart still ties', () => {
  const input = {
    lines: [{ sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 }],
    taxSubtotals: { S: { net: 0, vat: 0, rate: 15 } },
    appliedDiscount: 115,
    totalFinal: 0,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'full discount');
  eq(res.lines[0].grossMinor, 0);
});

console.log('\n── whole-SAR rounding delta ──');
test('positive delta: buckets already carry it, lines still tie', () => {
  // grossPrecise 114.60 → invTotal 115, so _roundDelta = +0.40, absorbed onto
  // net at routes/sales.js:568 and already inside the reconciled bucket.
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 50, vat: 7.5 },
      { sourceLineId: 'L1', cat: 'S', rate: 15, net: 49.65, vat: 7.45 },
    ],
    taxSubtotals: { S: { net: 100.4, vat: 14.6, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 115,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'positive delta');
});
test('negative delta: buckets already carry it, lines still tie', () => {
  // grossPrecise 115.40 → invTotal 115, so _roundDelta = −0.40.
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 50.2, vat: 7.53 },
      { sourceLineId: 'L1', cat: 'S', rate: 15, net: 50.17, vat: 7.5 },
    ],
    taxSubtotals: { S: { net: 99.6, vat: 15.4, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 115,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'negative delta');
});
test('delta plus discount plus mixed categories all close together', () => {
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 33.33, vat: 5 },
      { sourceLineId: 'L1', cat: 'S', rate: 15, net: 33.33, vat: 5 },
      { sourceLineId: 'L2', cat: 'Z', rate: 0, net: 33.34, vat: 0 },
    ],
    taxSubtotals: { S: { net: 60.87, vat: 9.13, rate: 15 }, Z: { net: 30, vat: 0, rate: 0 } },
    appliedDiscount: 10,
    totalFinal: 100,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'delta + discount + mixed');
});

console.log('\n── halala remainders ──');
test('an indivisible bucket is split without losing a halala', () => {
  // 100.01 over three equal lines cannot divide evenly.
  const input = {
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 33.34, vat: 5 },
      { sourceLineId: 'L1', cat: 'S', rate: 15, net: 33.34, vat: 5 },
      { sourceLineId: 'L2', cat: 'S', rate: 15, net: 33.34, vat: 5 },
    ],
    taxSubtotals: { S: { net: 100.01, vat: 14.99, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 115,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'indivisible');
  eq(res.lines.reduce((s, l) => s + l.netMinor, 0), 10001);
});
test('one halala across many lines lands on exactly one line', () => {
  const lines = [];
  for (let i = 0; i < 7; i++) lines.push({ sourceLineId: 'L' + i, cat: 'S', rate: 15, net: 1, vat: 0.15 });
  const input = {
    lines,
    taxSubtotals: { S: { net: 7.01, vat: 1.05, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 8.06,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'one halala across seven');
  eq(res.lines.filter((l) => l.netMinor === 101).length, 1, 'exactly one line takes the extra halala');
});

console.log('\n── determinism ──');
test('re-running produces byte-identical output', () => {
  const input = () => ({
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 33.33, vat: 5 },
      { sourceLineId: 'L1', cat: 'S', rate: 15, net: 33.33, vat: 5 },
      { sourceLineId: 'L2', cat: 'S', rate: 15, net: 33.34, vat: 5.01 },
    ],
    taxSubtotals: { S: { net: 90.44, vat: 13.56, rate: 15 } },
    appliedDiscount: 12.99,
    totalFinal: 104,
  });
  const a = A.allocateSaleLines(input());
  const b = A.allocateSaleLines(input());
  deep(a, b, 'identical inputs → identical output');
});
test('cart order does not change what a given line receives', () => {
  // Same three lines, reversed. Allocation keys on sourceLineId, so each line
  // must receive the same halalas regardless of the order it arrives in.
  const base = [
    { sourceLineId: 'L0', cat: 'S', rate: 15, net: 33.34, vat: 5 },
    { sourceLineId: 'L1', cat: 'S', rate: 15, net: 33.34, vat: 5 },
    { sourceLineId: 'L2', cat: 'S', rate: 15, net: 33.34, vat: 5 },
  ];
  const ts = { S: { net: 100.01, vat: 15, rate: 15 } };
  const fwd = A.allocateSaleLines({ lines: base, taxSubtotals: ts, appliedDiscount: 0, totalFinal: 115.01 });
  const rev = A.allocateSaleLines({ lines: base.slice().reverse(), taxSubtotals: ts, appliedDiscount: 0, totalFinal: 115.01 });
  const pick = (r, id) => r.lines.find((l) => l.sourceLineId === id).netMinor;
  ['L0', 'L1', 'L2'].forEach((id) => eq(pick(fwd, id), pick(rev, id), 'stable for ' + id));
});

console.log('\n── invariant guards ──');
test('rejects an empty cart', () => {
  throws(() => A.allocateSaleLines({ lines: [], taxSubtotals: {}, appliedDiscount: 0, totalFinal: 0 }), 'ALLOCATION_INVARIANT');
});
test('rejects a duplicate sourceLineId', () => {
  throws(() => A.allocateSaleLines({
    lines: [
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 10, vat: 1.5 },
      { sourceLineId: 'L0', cat: 'S', rate: 15, net: 10, vat: 1.5 },
    ],
    taxSubtotals: { S: { net: 20, vat: 3, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 23,
  }), 'ALLOCATION_INVARIANT');
});
test('rejects a line whose category has no bucket', () => {
  throws(() => A.allocateSaleLines({
    lines: [{ sourceLineId: 'L0', cat: 'O', rate: 0, net: 10, vat: 0 }],
    taxSubtotals: { S: { net: 10, vat: 0, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 10,
  }), 'ALLOCATION_INVARIANT');
});
test('rejects a bucket that has money but no lines', () => {
  throws(() => A.allocateSaleLines({
    lines: [{ sourceLineId: 'L0', cat: 'S', rate: 15, net: 10, vat: 1.5 }],
    taxSubtotals: { S: { net: 10, vat: 1.5, rate: 15 }, Z: { net: 99, vat: 0, rate: 0 } },
    appliedDiscount: 0,
    totalFinal: 11.5,
  }), 'ALLOCATION_INVARIANT');
});
test('rejects buckets that do not sum to total_final', () => {
  throws(() => A.allocateSaleLines({
    lines: [{ sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 }],
    taxSubtotals: { S: { net: 100, vat: 15, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 999,
  }), 'ALLOCATION_INVARIANT');
});
test('an empty 0/0 bucket is harmless', () => {
  const input = {
    lines: [{ sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 }],
    taxSubtotals: { S: { net: 100, vat: 15, rate: 15 }, Z: { net: 0, vat: 0, rate: 0 } },
    appliedDiscount: 0,
    totalFinal: 115,
  };
  const res = A.allocateSaleLines(input);
  invariants(res, input, 'empty bucket');
});

console.log('\n── projection version ──');
test('the version is reported so a snapshot records which algorithm built it', () => {
  const res = A.allocateSaleLines({
    lines: [{ sourceLineId: 'L0', cat: 'S', rate: 15, net: 100, vat: 15 }],
    taxSubtotals: { S: { net: 100, vat: 15, rate: 15 } },
    appliedDiscount: 0,
    totalFinal: 115,
  });
  eq(res.projectionVersion, A.PROJECTION_VERSION);
  eq(typeof A.PROJECTION_VERSION, 'number');
});

console.log(`\nLine allocation: ${_passed}/${_total} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
