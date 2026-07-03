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

console.log('\n═══ posOrderMachine — cart math (tax-inclusive) ═══');
// Line: 2 × 23.00 S → gross 46, VAT = 46 − 46/1.15 = 6.00
let t = M.lineTotals({ qty: 2, unitPrice: 23, vatCategory: 'S' });
check('S line: gross 46, vat 6.00', near(t.gross, 46) && near(t.vat, 6), t);
t = M.lineTotals({ qty: 3, unitPrice: 10, vatCategory: 'Z' });
check('Z line: vat 0', near(t.gross, 30) && t.vat === 0, t);
t = M.lineTotals({ qty: 1, unitPrice: 50, lineDiscount: 10, vatCategory: 'S' });
check('line discount before VAT: gross 40, vat 5.22', near(t.gross, 40) && near(t.vat, 5.22), t);
t = M.lineTotals({ qty: 1, unitPrice: 20, lineDiscount: 999, vatCategory: 'S' });
check('line discount capped at line value', near(t.gross, 0) && near(t.discount, 20), t);

const LINES = [
  { qty: 2, unitPrice: 23, vatCategory: 'S' },              // 46 (vat 6)
  { qty: 3, unitPrice: 10, vatCategory: 'Z' },              // 30 (vat 0)
  { qty: 1, unitPrice: 50, lineDiscount: 10, vatCategory: 'S' }, // 40 (vat 5.217)
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
const lines = [
  { menuId: 'M1', nameSnapshot: 'شاي أتاي', qty: 2, unitPrice: 23, lineDiscount: 0, vatCategory: 'S' },
  { menuId: 'M2', nameSnapshot: 'ماء', qty: 3, unitPrice: 10, lineDiscount: 0, vatCategory: 'Z' },
  { menuId: 'M3', nameSnapshot: 'طاجين', qty: 1, unitPrice: 50, lineDiscount: 10, vatCategory: 'S' },
];
const payload = M.buildLegacySalePayload(order, lines, [{ method: 'cash', amount: 104.4 }], { cashTendered: 110, changeDue: 5.6 });
check('payload.clientOrderId = order ULID', payload.clientOrderId === '01POSULID');
check('payload totals: total 116 / totalFinal 104.4 / discount 11.6', near(payload.total, 116) && near(payload.totalFinal, 104.4) && near(payload.discountAmount, 11.6), payload);
check('payload items carry id/name/qty/price/lineDiscount', payload.items.length === 3 && payload.items[2].lineDiscount === 10 && payload.items[0].id === 'M1');
check('payload cash fields present', payload.cashTendered === 110 && near(payload.changeDue, 5.6));
check('payload shift + warehouse carried', payload.shiftId === 7 && payload.warehouseId === 'WH-1');

console.log(`\n${_f === 0 ? '✅' : '❌'} posOrderMachine: ${_p} passed, ${_f} failed\n`);
process.exit(_f === 0 ? 0 : 1);
