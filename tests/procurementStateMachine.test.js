/**
 * Procurement state-machine + numbering — pure-function tests (no DB).
 * Run: node tests/procurementStateMachine.test.js
 */
'use strict';

const SM = require('../lib/procurement/stateMachine');
const { PREFIX } = require('../lib/procurement/numbering');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name, '—', e.message); } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ''} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function throws(fn, code) { let t = false; try { fn(); } catch (e) { t = true; if (code && e.code !== code) throw new Error(`code ${e.code} != ${code}`); } if (!t) throw new Error('expected throw'); }

console.log('\n── PO transitions ──');
test('draft → submitted', () => eq(SM.next('po', 'draft', 'submit'), 'submitted'));
test('submitted → approved', () => eq(SM.next('po', 'submitted', 'approve'), 'approved'));
test('approved → sent', () => eq(SM.next('po', 'approved', 'send'), 'sent'));
test('sent → partially_received', () => eq(SM.next('po', 'sent', 'receive'), 'partially_received'));
test('partially_received → fully_received', () => eq(SM.next('po', 'partially_received', 'complete'), 'fully_received'));
test('fully_received → closed', () => eq(SM.next('po', 'fully_received', 'close'), 'closed'));
test('cannot approve a draft', () => throws(() => SM.next('po', 'draft', 'approve'), 'INVALID_STATE_TRANSITION'));
test('cannot cancel a closed PO', () => throws(() => SM.next('po', 'closed', 'cancel'), 'INVALID_STATE_TRANSITION'));

console.log('\n── GRN transitions ──');
test('draft → approved → posted → reversed', () => {
  eq(SM.next('grn', 'draft', 'approve'), 'approved');
  eq(SM.next('grn', 'approved', 'post'), 'posted');
  eq(SM.next('grn', 'posted', 'reverse'), 'reversed');
});
test('cannot post a draft GRN directly', () => throws(() => SM.next('grn', 'draft', 'post'), 'INVALID_STATE_TRANSITION'));

console.log('\n── Supplier invoice transitions ──');
test('draft → pending_review → approved', () => {
  eq(SM.next('supplier_invoice', 'draft', 'submit'), 'pending_review');
  eq(SM.next('supplier_invoice', 'pending_review', 'approve'), 'approved');
});
test('approved → paid', () => eq(SM.next('supplier_invoice', 'approved', 'settle'), 'paid'));

console.log('\n── Payment transitions ──');
test('requested → authorized → paid → closed', () => {
  eq(SM.next('payment', 'requested', 'authorize'), 'authorized');
  eq(SM.next('payment', 'authorized', 'pay'), 'paid');
  eq(SM.next('payment', 'paid', 'close'), 'closed');
});
test('paid → reversed', () => eq(SM.next('payment', 'paid', 'reverse'), 'reversed'));

console.log('\n── Return transitions ──');
test('draft → approved → posted → settled', () => {
  eq(SM.next('return', 'draft', 'approve'), 'approved');
  eq(SM.next('return', 'approved', 'post'), 'posted');
  eq(SM.next('return', 'posted', 'settle'), 'settled');
});

console.log('\n── deletability + terminal ──');
test('draft is deletable', () => eq(SM.isDeletable('po', 'draft'), true));
test('posted GRN is NOT deletable', () => eq(SM.isDeletable('grn', 'posted'), false));
test('approved invoice is NOT deletable', () => eq(SM.isDeletable('supplier_invoice', 'approved'), false));

console.log('\n── numbering prefixes ──');
test('prefixes distinct per doc type', () => {
  eq(PREFIX.po, 'PO'); eq(PREFIX.grn, 'GRN'); eq(PREFIX.supplier_invoice, 'SINV');
  eq(PREFIX.payment, 'PPAY'); eq(PREFIX.return, 'PRET');
});

console.log(`\nProcurement state machine: ${_p} passed, ${_f} failed`);
process.exit(_f ? 1 : 0);
