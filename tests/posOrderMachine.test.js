/**
 * Unit tests — lib/posOrderMachine.js (pure; no DB).
 * Run: node tests/posOrderMachine.test.js   (included in `npm test`)
 */
'use strict';
const M = require('../lib/posOrderMachine');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}
function throws(fn, code) { try { fn(); return false; } catch (e) { return !code || e.code === code; } }
const near = (a, b) => Math.abs(a - b) <= 0.011;

console.log('\n═══ posOrderMachine — transitions ═══');
check('open: edit/hold/submit/void', M.canEdit('open') && M.canHold('open') && M.canSubmit('open') && M.canVoid('open') && !M.canResume('open') && !M.canComplete('open'));
check('held: resume/void only', M.canResume('held') && M.canVoid('held') && !M.canEdit('held') && !M.canSubmit('held') && !M.canComplete('held'));
check('submitted: complete/reopen only', M.canComplete('submitted') && M.canReopen('submitted') && !M.canEdit('submitted') && !M.canVoid('submitted') && !M.canHold('submitted'));
check('completed/voided terminal', M.isTerminal('completed') && M.isTerminal('voided') && !M.canVoid('completed') && !M.canComplete('completed') && !M.canEdit('voided'));
check('void after completion is refused with the credit-note message', throws(() => M.assertCanVoid('completed'), 'INVALID_STATE_TRANSITION'));
check('order type normalizes', M.normalizeOrderType('dine_in') === 'dine_in' && M.normalizeOrderType('junk') === 'takeaway');

console.log('\n═══ posOrderMachine — cart math (TAX-INCLUSIVE items) ═══');
// The convention is PER ITEM now (menu.is_tax_inclusive), so these fixtures
// state it explicitly instead of relying on a global assumption. Inclusive:
// the price already contains VAT, which is extracted downward.
// Line: 2 × 23.00 S → gross 46, VAT = 46 − 46/1.15 = 6.00
let t = M.lineTotals({ qty: 2, unitPrice: 23, vatCategory: 'S', taxInclusive: true });
check('S line: gross 46, vat 6.00', near(t.gross, 46) && near(t.vat, 6), t);
t = M.lineTotals({ qty: 3, unitPrice: 10, vatCategory: 'Z', taxInclusive: true });
check('Z line: vat 0', near(t.gross, 30) && t.vat === 0, t);
t = M.lineTotals({ qty: 1, unitPrice: 50, lineDiscount: 10, vatCategory: 'S', taxInclusive: true });
check('line discount before VAT: gross 40, vat 5.22', near(t.gross, 40) && near(t.vat, 5.22), t);
t = M.lineTotals({ qty: 1, unitPrice: 20, lineDiscount: 999, vatCategory: 'S', taxInclusive: true });
check('line discount capped at line value', near(t.gross, 0) && near(t.discount, 20), t);

console.log('\n═══ posOrderMachine — cart math (TAX-EXCLUSIVE items) ═══');
// This is what EVERY current menu row is (server.js v7.1 set
// is_tax_inclusive = 0 on all of them), and it was entirely untested: the
// machine hardcoded the inclusive formula, froze totalFinal at the NET amount,
// and routes/sales.js then rejected the sale for not matching its own
// net × 1.15. The owner's example is the first assertion.
// v8.2 — the customer-facing UNIT price snaps to a whole riyal. This used to
// assert 16 → 2.40 → 18.40, which is exactly what the owner rejected: he sells
// at whole riyals and the till printed halalas on every standard-rated row.
// net/vat are now derived FROM the rounded gross, so the invariant below still
// holds exactly — that is what the sale journal and ZATCA require.
t = M.lineTotals({ qty: 1, unitPrice: 16, vatCategory: 'S', taxInclusive: false });
check('the owner\'s case — 16.00 net rings up as a whole 18',
  near(t.gross, 18) && near(t.net, 15.65) && near(t.vat, 2.35), t);
check('net + vat === gross exactly', near(t.net + t.vat, t.gross), t);
// Rounded per UNIT, so a quoted "18 each" really does cost 36 for two.
t = M.lineTotals({ qty: 2, unitPrice: 16, vatCategory: 'S', taxInclusive: false });
check('the whole unit price multiplies cleanly — 2 × 18 = 36', near(t.gross, 36), t);
t = M.lineTotals({ qty: 2, unitPrice: 20, vatCategory: 'S', taxInclusive: false });
check('2 × 20 net → 40.00 + 6.00 = 46.00', near(t.net, 40) && near(t.vat, 6) && near(t.gross, 46), t);
t = M.lineTotals({ qty: 3, unitPrice: 10, vatCategory: 'Z', taxInclusive: false });
check('zero-rated exclusive line adds NO vat', near(t.gross, 30) && t.vat === 0, t);
// An ABSENT flag must behave like the DB does today, not like the old default.
t = M.lineTotals({ qty: 1, unitPrice: 16, vatCategory: 'S' });
check('absent flag → EXCLUSIVE (matches every current menu row)', near(t.gross, 18), t);
// The flag has to actually change the money, or the bug is back.
check('inclusive and exclusive differ for the same price',
  !near(M.lineTotals({ qty: 1, unitPrice: 16, vatCategory: 'S', taxInclusive: true }).gross,
        M.lineTotals({ qty: 1, unitPrice: 16, vatCategory: 'S', taxInclusive: false }).gross));

console.log('\n═══ posOrderMachine — the rate is settings-driven, not hardcoded ═══');
t = M.lineTotals({ qty: 1, unitPrice: 100, vatCategory: 'S', taxInclusive: false }, 5);
check('a 5% rate is honoured (100 → 105.00)', near(t.vat, 5) && near(t.gross, 105), t);
t = M.lineTotals({ qty: 1, unitPrice: 100, vatCategory: 'S', taxInclusive: false }, 0);
check('a 0% rate is honoured (100 → 100.00)', t.vat === 0 && near(t.gross, 100), t);
t = M.lineTotals({ qty: 1, unitPrice: 100, vatCategory: 'S', taxInclusive: false });
check('no rate passed → 15% default', near(t.vat, 15) && near(t.gross, 115), t);

console.log('\n═══ posOrderMachine — cart aggregation (inclusive fixtures) ═══');
const LINES = [
  { qty: 2, unitPrice: 23, vatCategory: 'S', taxInclusive: true },              // 46 (vat 6)
  { qty: 3, unitPrice: 10, vatCategory: 'Z', taxInclusive: true },              // 30 (vat 0)
  { qty: 1, unitPrice: 50, lineDiscount: 10, vatCategory: 'S', taxInclusive: true }, // 40 (vat 5.217)
];
let c = M.cartTotals(LINES, null);
check('cart subtotal 116, lineDiscounts 10, vat 11.22', near(c.subtotal, 116) && near(c.lineDiscountTotal, 10) && near(c.vatTotal, 11.22), c);
c = M.cartTotals(LINES, { type: 'PERCENT', value: 10 });
check('10% order discount: total 104.4, vat scales (10.1)', near(c.total, 104.4) && near(c.discountAmount, 11.6) && near(c.vatTotal, 10.1), c);
c = M.cartTotals(LINES, { type: 'FIXED', value: 16 });
check('fixed 16 discount: total 100', near(c.total, 100) && near(c.discountAmount, 16), c);
c = M.cartTotals(LINES, { type: 'FIXED', value: 9999 });
check('fixed discount capped at subtotal → total 0', near(c.total, 0), c);
c = M.cartTotals([], null);
check('empty cart totals are zero-safe', c.subtotal === 0 && c.total === 0 && c.vatTotal === 0, c);

console.log('\n═══ posOrderMachine — payments ═══');
check('single cash covering total ok', M.validatePayments([{ method: 'cash', amount: 104.4 }], 104.4) === 104.4);
check('split covering total ok', M.validatePayments([{ method: 'cash', amount: 50 }, { method: 'card', amount: 54.4 }], 104.4) === 104.4);
check('under-payment rejected', throws(() => M.validatePayments([{ method: 'cash', amount: 100 }], 104.4), 'PAYMENT_MISMATCH'));
check('over-payment rejected (change via cashTendered, not a payment line)', throws(() => M.validatePayments([{ method: 'cash', amount: 110 }], 104.4), 'PAYMENT_MISMATCH'));
check('unknown method rejected', throws(() => M.validatePayments([{ method: 'bitcoin', amount: 104.4 }], 104.4), 'VALIDATION_ERROR'));
check('empty payments rejected', throws(() => M.validatePayments([], 10), 'VALIDATION_ERROR'));
let lp = M.legacyPaymentFields([{ method: 'cash', amount: 104.4 }]);
check('single cash → paymentMethod كاش, no split', lp.paymentMethod === 'كاش' && lp.splitDetails === null, lp);
lp = M.legacyPaymentFields([{ method: 'cash', amount: 50 }, { method: 'card', amount: 54.4 }]);
check('mixed → split + mapped methods', lp.paymentMethod === 'split' && lp.splitDetails.length === 2 && lp.splitDetails[1].method === 'شبكة', lp);

console.log('\n═══ posOrderMachine — legacy payload builder ═══');
const order = { id: '01POSULID', shiftId: 7, warehouseId: 'WH-1', discountType: 'PERCENT', discountValue: 10, discountName: 'عرض', customerId: null, channelId: null };
// taxInclusive is stated per line: routes/pos-v2.js stamps it from the DB
// (_applyTaxConvention) before calling this builder, exactly so the frozen
// totalFinal matches what routes/sales.js will independently recompute.
const lines = [
  { menuId: 'M1', nameSnapshot: 'شاي أتاي', qty: 2, unitPrice: 23, lineDiscount: 0, vatCategory: 'S', taxInclusive: true },
  { menuId: 'M2', nameSnapshot: 'ماء', qty: 3, unitPrice: 10, lineDiscount: 0, vatCategory: 'Z', taxInclusive: true },
  { menuId: 'M3', nameSnapshot: 'طاجين', qty: 1, unitPrice: 50, lineDiscount: 10, vatCategory: 'S', taxInclusive: true },
];
const payload = M.buildLegacySalePayload(order, lines, [{ method: 'cash', amount: 104.4 }], { cashTendered: 110, changeDue: 5.6 });
check('payload.clientOrderId = order ULID', payload.clientOrderId === '01POSULID');
check('payload totals: total 116 / totalFinal 104.4 / discount 11.6', near(payload.total, 116) && near(payload.totalFinal, 104.4) && near(payload.discountAmount, 11.6), payload);
check('payload items carry id/name/qty/price/lineDiscount', payload.items.length === 3 && payload.items[2].lineDiscount === 10 && payload.items[0].id === 'M1');
check('payload cash fields present', payload.cashTendered === 110 && near(payload.changeDue, 5.6));
check('payload shift + warehouse carried', payload.shiftId === 7 && payload.warehouseId === 'WH-1');

console.log(`\n${_f === 0 ? '✅' : '❌'} posOrderMachine: ${_p} passed, ${_f} failed\n`);
process.exit(_f === 0 ? 0 : 1);
