'use strict';
/**
 * tests/o2cFoundation.test.js — pure unit tests for the Order-to-Cash foundation
 * (money/VAT/UoM/aging math, state machines, error sanitization). No DB.
 *   node tests/o2cFoundation.test.js
 */
const calc = require('../lib/order-to-cash/calculations');
const SM = require('../lib/order-to-cash/stateMachine');
const E = require('../lib/order-to-cash/errors');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗', m); } }
function throws(fn, m) { try { fn(); fail++; console.error('  ✗ (expected throw)', m); } catch (_) { pass++; } }

// ── money / rounding ──
ok(calc.money(1.005) === 1.01, 'half-up 1.005 → 1.01');
ok(calc.money(2.674) === 2.67, 'round 2.674 → 2.67');
ok(calc.toBaseQty(2, 12) === 24, 'baseQty 2×12 = 24');

// ── VAT 0%-safe (fixes vat_pct||15) ──
ok(calc.resolveVatRate({ vatRate: 0 }).rate === 0, 'explicit 0% stays 0 (not 15)');
ok(calc.resolveVatRate({ vatCategory: 'Z' }).rate === 0, 'Z → 0%');
ok(calc.resolveVatRate({ vatCategory: 'E' }).rate === 0, 'E → 0%');
ok(calc.resolveVatRate({ vatCategory: 'O' }).rate === 0, 'O → 0%');
ok(calc.resolveVatRate({ vatCategory: 'S', standardRate: 15 }).rate === 15, 'S → standard 15');
ok(calc.resolveVatRate({ vatRate: 15 }).rate === 15, 'explicit 15 → 15');
throws(() => calc.resolveVatRate({ vatCategory: 'X' }), 'unknown category throws (no silent 15)');

// ── computeLine exclusive / inclusive / 0% ──
const l1 = calc.computeLine({ enteredQty: 2, unitPriceEntered: 100, vatRate: 15 }, 15);
ok(l1.netAmount === 200 && l1.vatAmount === 30 && l1.grossAmount === 230, 'exclusive 2×100 @15% → net200 vat30 gross230');
const l2 = calc.computeLine({ enteredQty: 1, unitPriceEntered: 115, vatRate: 15, inclusiveTax: true }, 15);
ok(l2.netAmount === 100 && l2.vatAmount === 15, 'inclusive 115 @15% → net100 vat15');
const l3 = calc.computeLine({ enteredQty: 1, unitPriceEntered: 100, vatCategory: 'Z' }, 15);
ok(l3.netAmount === 100 && l3.vatAmount === 0, '0%-rated line → vat 0');
const tot = calc.computeTotals([l1, l3]);
ok(tot.subtotal === 300 && tot.vatAmount === 30 && tot.total === 330, 'totals aggregate net+vat');

// ── aging buckets (by days past due) ──
ok(calc.agingBucket(0) === 'current', 'aging 0 → current');
ok(calc.agingBucket(15) === 'd1_30' && calc.agingBucket(45) === 'd31_60' && calc.agingBucket(75) === 'd61_90', 'aging mid buckets');
ok(calc.agingBucket(100) === 'd91_120' && calc.agingBucket(150) === 'd120_plus', 'aging 91-120 / 120+');
ok(calc.addDays('2026-01-01', 30) === '2026-01-31', 'addDays terms → due date');
ok(calc.daysBetween('2026-01-01', '2026-01-31') === 30, 'daysBetween = 30');

// ── state machines ──
ok(SM.next('ar_document', 'issued', 'pay') === 'partially_paid', 'AR issued+pay → partially_paid');
ok(SM.next('ar_document', 'issued', 'settle') === 'paid', 'AR issued+settle → paid');
ok(SM.next('ar_document', 'issued', 'credit') === 'credited', 'AR issued+credit → credited');
ok(SM.next('customer_payment', 'approved', 'post') === 'posted', 'payment approved+post → posted');
ok(SM.next('customer_payment', 'posted', 'reverse') === 'reversed', 'payment posted+reverse → reversed');
ok(SM.next('sales_return', 'approved', 'post') === 'posted', 'return approved+post → posted');
ok(SM.next('sales_order', 'confirmed', 'fulfill') === 'fulfilled', 'order confirmed+fulfill → fulfilled');
throws(() => SM.next('ar_document', 'issued', 'edit'), 'issued AR doc is immutable (edit rejected)');
throws(() => SM.next('customer_payment', 'posted', 'cancel'), 'cannot cancel a posted payment');
throws(() => SM.next('sales_return', 'posted', 'approve'), 'cannot re-approve a posted return');
ok(SM.isDeletable('ar_document', 'draft') === true && SM.isDeletable('ar_document', 'issued') === false, 'only drafts deletable');

// ── error sanitization ──
const dbErr = new Error('Unknown column x'); dbErr.code = 'ER_BAD_FIELD_ERROR'; dbErr.errno = 1054; dbErr.sqlMessage = dbErr.message; dbErr.sql = 'SELECT x FROM ar_documents';
ok(E.isInternalError(dbErr) === true, 'DB error is internal');
ok(E.isInternalError(new TypeError('boom')) === true, 'TypeError is internal');
ok(E.isInternalError(E.err('CREDIT_LIMIT_EXCEEDED', 'x')) === false, 'domain error not internal');
const eb = E.errorBody(dbErr);
ok(eb.http === 500 && eb.body.code === 'INTERNAL_ERROR' && /تعذّر/.test(eb.body.error) && typeof eb.body.correlationId === 'string', 'internal → 500 + generic + correlationId');
ok(!/SELECT|ar_documents|ER_BAD_FIELD|sqlMessage/i.test(JSON.stringify(eb.body)), 'internal error body leaks no SQL/table');
const cb = E.errorBody(E.err('CREDIT_LIMIT_EXCEEDED', 'تجاوز حد الائتمان'));
ok(cb.http === 422 && cb.body.code === 'CREDIT_LIMIT_EXCEEDED' && cb.body.error === 'تجاوز حد الائتمان', 'domain error preserved (422)');
const env = E.ok({ data: { id: 'AR1' }, documentNumber: 'SI-1', status: 'issued', version: 2, journalId: 'J1' });
ok(env.success === true && env.documentNumber === 'SI-1' && env.version === 2 && env.journalId === 'J1' && typeof env.generatedAt === 'string', 'success envelope shape + generatedAt');

console.log(`\no2cFoundation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
