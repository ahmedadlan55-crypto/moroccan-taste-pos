/**
 * Phase 3B — inventory-transaction engine unit tests (pure parts; no DB).
 * WAC math, state guards, GL spec builders. Run: node tests/inventoryTxEngine.test.js
 */
'use strict';

const E = require('../lib/inventoryTxEngine');
const A = E.CORE_ACCOUNTS;

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function close(a, b, msg) { if (Math.abs(Number(a) - Number(b)) > 1e-9) throw new Error((msg || 'close') + ': expected ' + b + ', got ' + a); }
function balanced(spec) {
  let d = 0, c = 0;
  spec.entries.forEach((e) => { d += Number(e.debit) || 0; c += Number(e.credit) || 0; });
  if (Math.abs(d - c) > 0.01) throw new Error('not balanced: Dr=' + d + ' Cr=' + c);
  return { d, c };
}

console.log('\n═══ Inventory-tx engine ═══');

console.log('\n─── WAC ───');
test('the canonical example: 100@5 + 50@7 → 5.6667', () => close(E.newWAC(100, 5, 50, 7), 5.6667));
test('value identity: 850 / 150', () => close(E.newWAC(100, 5, 50, 7) * 150, 850.005, 'within 4dp rounding')); // 5.6667*150=850.005
test('empty stock takes the incoming cost', () => eq(E.newWAC(0, 0, 10, 9), 9));
test('non-positive total returns addCost', () => eq(E.newWAC(-5, 4, 0, 3), 3));

console.log('\n─── inventoryAccountFor ───');
test('main warehouse → INVENTORY 1200', () => eq(E.inventoryAccountFor({ is_main: 1 }), A.INVENTORY.code));
test('type=main → INVENTORY 1200', () => eq(E.inventoryAccountFor({ type: 'main' }), A.INVENTORY.code));
test('branch warehouse → BRANCH_INVENTORY 1210', () => eq(E.inventoryAccountFor({ type: 'branch' }), A.BRANCH_INVENTORY.code));

console.log('\n─── adjustmentExpenseCode ───');
test('تالف → WASTE_EXPENSE', () => eq(E.adjustmentExpenseCode('تالف'), A.WASTE_EXPENSE.code));
test('admin/settlement → STOCK_VARIANCE', () => eq(E.adjustmentExpenseCode('تسوية إدارية'), A.STOCK_VARIANCE.code));

console.log('\n─── GL spec builders ───');
test('receipt: Dr inventory / Cr stock-gain, balanced, value matches', () => {
  const s = E.glReceipt({ amount: 350, warehouse: { type: 'main' }, referenceId: 'RCV-1', journalDate: '2026-06-30', warehouseId: 'WH-A' });
  eq(s.referenceType, 'inv_receipt');
  eq(s.entries[0].accountCode, A.INVENTORY.code);
  eq(s.entries[0].debit, 350);
  eq(s.entries[1].accountCode, A.STOCK_GAIN.code);
  eq(s.entries[1].credit, 350);
  eq(s.entries[0].warehouseId, 'WH-A');
  balanced(s);
});
test('issue: Dr expense / Cr inventory, default expense = STOCK_VARIANCE', () => {
  const s = E.glIssue({ amount: 170, warehouse: { type: 'branch' }, referenceId: 'ISU-1', journalDate: '2026-06-30' });
  eq(s.referenceType, 'inv_issue');
  eq(s.entries[0].accountCode, A.STOCK_VARIANCE.code);
  eq(s.entries[0].debit, 170);
  eq(s.entries[1].accountCode, A.BRANCH_INVENTORY.code);
  eq(s.entries[1].credit, 170);
  balanced(s);
});
test('issue honours an explicit expenseCode', () => {
  const s = E.glIssue({ amount: 50, warehouse: { type: 'main' }, expenseCode: '5400', referenceId: 'ISU-2' });
  eq(s.entries[0].accountCode, '5400');
});
test('adjustment positive: Dr inventory / Cr stock-gain', () => {
  const s = E.glAdjustment({ amount: 56.67, delta: 7, warehouse: { type: 'main' }, reason: 'جرد', referenceId: 'ADV-1' });
  eq(s.entries[0].accountCode, A.INVENTORY.code);
  eq(s.entries[1].accountCode, A.STOCK_GAIN.code);
  balanced(s);
});
test('adjustment negative (تالف): Dr WASTE_EXPENSE / Cr inventory', () => {
  const s = E.glAdjustment({ amount: 56.67, delta: -10, warehouse: { type: 'main' }, reason: 'تالف', referenceId: 'ADV-2' });
  eq(s.entries[0].accountCode, A.WASTE_EXPENSE.code);
  eq(s.entries[0].debit, 56.67);
  eq(s.entries[1].accountCode, A.INVENTORY.code);
  eq(s.entries[1].credit, 56.67);
  balanced(s);
});
test('glAdjustmentNet keeps positive & negative GROSS (no netting hides the effect)', () => {
  const s = E.glAdjustmentNet({ posValue: 100, negValue: 40, warehouse: { type: 'main' }, reason: 'جرد', referenceId: 'ADV-NET' });
  eq(s.entries.length, 4, 'four lines: a gross positive pair + a gross negative pair');
  const invDeb = s.entries.filter((e) => e.accountCode === A.INVENTORY.code && Number(e.debit) > 0);
  const invCrd = s.entries.filter((e) => e.accountCode === A.INVENTORY.code && Number(e.credit) > 0);
  ok(invDeb.length === 1 && Number(invDeb[0].debit) === 100, 'inventory debit 100 (gross increase, not netted to 60)');
  ok(invCrd.length === 1 && Number(invCrd[0].credit) === 40, 'inventory credit 40 (gross decrease, not netted away)');
  const gain = s.entries.find((e) => e.accountCode === A.STOCK_GAIN.code);
  ok(gain && Number(gain.credit) === 100, 'stock-gain credit = gross positive 100');
  const totals = balanced(s);
  close(totals.d, 140, 'gross debit = 140 (100 + 40)');
});
test('reverseSpec swaps debit/credit and tags *_reverse', () => {
  const fwd = E.glReceipt({ amount: 350, warehouse: { type: 'main' }, referenceId: 'RCV-1' });
  const rev = E.reverseSpec(fwd, { postedBy: 'admin' });
  eq(rev.referenceType, 'inv_receipt_reverse');
  eq(rev.entries[0].debit, fwd.entries[0].credit);
  eq(rev.entries[0].credit, fwd.entries[0].debit);
  balanced(rev);
});

console.log('\n─── state guards ───');
test('lifecycle predicates', () => {
  eq([E.canEdit('draft'), E.canApprove('draft'), E.canPost('approved'), E.canCancel('approved'), E.canReverse('posted'), E.canDelete('draft')], [true, true, true, true, true, true]);
  eq([E.canEdit('posted'), E.canPost('draft'), E.canReverse('draft'), E.canDelete('posted'), E.canCancel('posted')], [false, false, false, false, false]);
});
test('assertCanPost throws INVALID_STATE_TRANSITION off-state', () => {
  let code = null; try { E.assertCanPost('draft'); } catch (e) { code = e.code; }
  eq(code, 'INVALID_STATE_TRANSITION');
});
test('assertCanReverse passes for posted, throws for draft', () => {
  E.assertCanReverse('posted'); // no throw
  let code = null; try { E.assertCanReverse('draft'); } catch (e) { code = e.code; }
  eq(code, 'INVALID_STATE_TRANSITION');
});

console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
process.exit(_f > 0 ? 1 : 0);
