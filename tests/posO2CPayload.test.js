'use strict';
/**
 * tests/posO2CPayload.test.js — the POS→O2C payload contract. buildLegacySalePayload
 * must emit a STRUCTURED payments[] + flat customerId (the shape creditSaleGate
 * reads) ALONGSIDE the legacy paymentMethod/splitDetails/customer:{id} (unchanged
 * for routes/sales.js). Pure, no DB.
 *   node tests/posO2CPayload.test.js
 */
const M = require('../lib/posOrderMachine');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗', m); } }

const order = { id: '01ULID', shiftId: 'SH1', customerId: 'CUST-9', discountType: null, discountValue: 0 };
const lines = [{ menuId: 'M1', nameSnapshot: 'شاي', qty: 2, unitPrice: 50, lineDiscount: 0, baseQty: 2 }];

// ── single credit ──
const p1 = M.buildLegacySalePayload(order, lines, [{ method: 'credit', amount: 100 }], {});
ok(Array.isArray(p1.payments) && p1.payments.length === 1 && p1.payments[0].method === 'credit' && p1.payments[0].amount === 100, 'structured payments[] emitted for credit');
ok(p1.customerId === 'CUST-9', 'flat customerId emitted');
ok(p1.customer && p1.customer.id === 'CUST-9', 'legacy nested customer:{id} preserved');
ok(p1.paymentMethod === 'كيتا', 'legacy paymentMethod preserved (routes/sales.js unchanged)');

// ── split cash + credit → structured payments cover both legs ──
const p2 = M.buildLegacySalePayload(order, lines, [{ method: 'cash', amount: 40 }, { method: 'credit', amount: 60 }], {});
ok(p2.payments.length === 2 && p2.payments.map((x) => x.method).join(',') === 'cash,credit', 'split emits both legs in payments[]');
ok(Math.round(p2.payments.reduce((s, x) => s + x.amount, 0) * 100) / 100 === 100, 'split payments sum to total');
ok(p2.paymentMethod === 'split' && Array.isArray(p2.splitDetails), 'legacy split fields preserved');

// ── no customer → no flat customerId (walk-in cash) ──
const p3 = M.buildLegacySalePayload({ id: 'X', shiftId: 'SH1', customerId: null, discountType: null, discountValue: 0 }, lines, [{ method: 'cash', amount: 100 }], {});
ok(p3.customerId === undefined && p3.customer === undefined, 'walk-in cash → no customer fields');
ok(p3.payments[0].method === 'cash', 'cash structured payment emitted');

console.log(`\nposO2CPayload: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
