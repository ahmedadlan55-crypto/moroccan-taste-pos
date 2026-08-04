/**
 * Unit tests — lib/productionEngine.js (pure; no DB).
 * Run: node tests/productionEngine.test.js   (included in `npm test`)
 */
'use strict';
const P = require('../lib/productionEngine');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}
function throws(fn, code) {
  try { fn(); return false; } catch (e) { return !code || e.code === code; }
}

console.log('\n═══ productionEngine — state machine ═══');
// Full transition matrix.
check('draft: edit/approve/delete only', P.canEdit('draft') && P.canApprove('draft') && P.canDelete('draft') && !P.canIssue('draft') && !P.canOutput('draft') && !P.canComplete('draft') && !P.canClose('draft') && !P.canReverse('draft'));
check('approved: issue + cancel, no edit/output', P.canIssue('approved') && P.canCancel('approved', false) && !P.canEdit('approved') && !P.canOutput('approved') && !P.canDelete('approved'));
check('in_progress: issue/output/complete/reverse', P.canIssue('in_progress') && P.canOutput('in_progress') && P.canComplete('in_progress') && P.canReverse('in_progress') && !P.canCancel('in_progress', false) && !P.canEdit('in_progress'));
check('completed: close/reverse only', P.canClose('completed') && P.canReverse('completed') && !P.canIssue('completed') && !P.canOutput('completed') && !P.canComplete('completed'));
check('closed: reverse only', P.canReverse('closed') && !P.canClose('closed') && !P.canIssue('closed') && !P.canEdit('closed'));
check('cancelled/reversed: terminal', !P.canReverse('cancelled') && !P.canIssue('cancelled') && !P.canReverse('reversed') && !P.canOutput('reversed'));
check('legacy planned/released are NOT V2-actionable', !P.canIssue('planned') && !P.canIssue('released') && !P.canApprove('planned') && !P.canOutput('released') && !P.isV2Status('planned') && !P.isV2Status('released'));
check('cancel blocked after any issue event', !P.canCancel('approved', true) && throws(() => P.assertCanCancel('approved', true), 'INVALID_STATE_TRANSITION'));
check('assert throwers carry INVALID_STATE_TRANSITION', throws(() => P.assertCanEdit('approved'), 'INVALID_STATE_TRANSITION') && throws(() => P.assertCanOutput('approved'), 'INVALID_STATE_TRANSITION') && throws(() => P.assertCanClose('in_progress'), 'INVALID_STATE_TRANSITION'));
check('assertV2 rejects legacy rows', throws(() => P.assertV2({ source: 'legacy' }), 'VALIDATION_ERROR') && !throws(() => P.assertV2({ source: 'v2' })));
check('partially_completed is derived', P.isPartiallyCompleted('in_progress', 5) && !P.isPartiallyCompleted('in_progress', 0) && !P.isPartiallyCompleted('completed', 5));

console.log('\n═══ productionEngine — tolerance math ═══');
check('over-issue within tolerance ok (100 planned, 105 issued @10%)', P.checkOverIssue(100, 100, 5, 0.10).ok);
check('over-issue beyond tolerance fails (100 planned, 111 issued @10%)', !P.checkOverIssue(100, 100, 11, 0.10).ok);
check('over-issue exact cap ok', P.checkOverIssue(100, 0, 110, 0.10).ok && !P.checkOverIssue(100, 0, 110.01, 0.10).ok);
check('over-production mirrors (planned 50, produced 40+waste 5, +10 good @10%)', P.checkOverProduction(50, 40, 5, 10, 0, 0.10).ok && !P.checkOverProduction(50, 40, 5, 10, 1, 0.10).ok);
// SEMANTICS CHANGED — this used to assert 'pct=0 never role-gates'. Under that
// rule a zero-scrap order was indistinguishable from an unconfigured one; 0 was
// ALSO the column default and what both create routes wrote when the field was
// omitted, so the gate never fired on ANY order in the system. NULL is now the
// "no explicit policy" value and 0 means what it says. Migration 0027 rewrote
// every existing 0 to NULL, so no historical order changed behaviour.
check('waste allowance: NULL = no explicit policy, not gated', !P.wasteAllowanceExceeded(100, 0, 50, null));
check('waste allowance: pct=0 now gates ANY waste', P.wasteAllowanceExceeded(100, 0, 0.001, 0));
check('waste allowance: pct=0 does not gate a zero-waste event', !P.wasteAllowanceExceeded(100, 0, 0, 0));
check('waste allowance: 5% of 100 → 5 ok, 5.5 exceeded', !P.wasteAllowanceExceeded(100, 2, 3, 5) && P.wasteAllowanceExceeded(100, 2, 3.5, 5));
check('hasExplicitScrapAllowance distinguishes 0 from null',
  P.hasExplicitScrapAllowance(0) === true && P.hasExplicitScrapAllowance(null) === false);

console.log('\n═══ productionEngine — output event costing ═══');
// WIP 1000, planned 100, nothing produced → first event of 40 good:
// remainingExpected=100, u=10, fg=400.
let r = P.priceOutputEvent({ wipBalance: 1000, plannedQty: 100, producedSoFar: 0, wasteSoFar: 0, goodQty: 40, wasteQty: 0 });
check('event1: u=wip/remaining (1000/100=10), fg=400', r.unitCost === 10 && r.fgValue === 400 && r.wasteValue === 0 && r.relief === 400, r);
// After event1 (wip 600, produced 40) → event2 of 50 good + 10 waste:
// remainingExpected=max(100-40,60)=60, u=10, fg=500, waste=100.
r = P.priceOutputEvent({ wipBalance: 600, plannedQty: 100, producedSoFar: 40, wasteSoFar: 0, goodQty: 50, wasteQty: 10 });
check('event2: u=600/60=10, fg=500, waste=100, relief=600', r.unitCost === 10 && r.fgValue === 500 && r.wasteValue === 100 && r.relief === 600, r);
// Over-production event beyond plan: remainingExpected = eventQty (never divide < event).
r = P.priceOutputEvent({ wipBalance: 500, plannedQty: 100, producedSoFar: 95, wasteSoFar: 0, goodQty: 20, wasteQty: 0 });
check('over-plan event: remainingExpected=eventQty(20), u=25', r.remainingExpected === 20 && r.unitCost === 25, r);
// WIP cap: when the event qty exceeds remainingExpected the whole WIP is
// relieved exactly (u = wip/eventQty) — relief never exceeds WIP.
r = P.priceOutputEvent({ wipBalance: 100, plannedQty: 10, producedSoFar: 0, wasteSoFar: 0, goodQty: 20, wasteQty: 5 });
check('WIP cap: relief == wip exactly, never above', r.relief === 100 && r.fgValue === 80 && r.wasteValue === 20, r);
// Pathological rounding overshoot → proportional scale-down keeps WIP ≥ 0.
r = P.priceOutputEvent({ wipBalance: 10, plannedQty: 3, producedSoFar: 0, wasteSoFar: 0, goodQty: 2, wasteQty: 1 });
check('relief ≤ wip always', r.relief <= 10 + 1e-9, r);
check('zero event qty throws', throws(() => P.priceOutputEvent({ wipBalance: 100, plannedQty: 10, producedSoFar: 0, wasteSoFar: 0, goodQty: 0, wasteQty: 0 }), 'VALIDATION_ERROR'));

console.log('\n═══ productionEngine — GL spec builders ═══');
const dims = { warehouseId: 'WH1', brandId: 'B1', branchId: 'BR1', journalDate: '2026-07-03', postedBy: 't', referenceId: 'X' };
let spec = P.glProdIssue(Object.assign({ materialsCost: 300, laborCost: 50, overheadCost: 20, inventoryCode: '1200', description: 'd' }, dims));
check('issue spec balances (Dr WIP 370 / Cr 1200+5400+5410)', P.specBalances(spec) && spec.entries.length === 6 && spec.referenceType === 'prod_issue', spec.entries);
check('issue spec WIP debits sum = 370', P.round2(spec.entries.filter((e) => e.accountCode === '1220').reduce((s, e) => s + e.debit, 0)) === 370);
spec = P.glProdIssue(Object.assign({ materialsCost: 300, laborCost: 0, overheadCost: 0, inventoryCode: '1210', description: 'd' }, dims));
check('issue spec branch warehouse credits 1210', spec.entries.some((e) => e.accountCode === '1210' && e.credit === 300));
spec = P.glProdOutput(Object.assign({ fgValue: 500, wasteValue: 100, outputWarehouseId: 'WH2', description: 'd' }, dims));
check('output spec balances (Dr 1230:500 + 5122:100 / Cr 1220:600)', P.specBalances(spec) && spec.entries.some((e) => e.accountCode === '1230' && e.debit === 500 && e.warehouseId === 'WH2') && spec.entries.some((e) => e.accountCode === '5122' && e.debit === 100) && spec.entries.some((e) => e.accountCode === '1220' && e.credit === 600), spec.entries);
spec = P.glProdOutput(Object.assign({ fgValue: 500, wasteValue: 0, outputWarehouseId: 'WH2', description: 'd' }, dims));
check('output spec without waste has no 5122 line', !spec.entries.some((e) => e.accountCode === '5122') && P.specBalances(spec));
spec = P.glProdClose(Object.assign({ variance: 25, description: 'd' }, dims));
check('close spec balances (Dr 5420 / Cr 1220 = 25)', P.specBalances(spec) && spec.entries.some((e) => e.accountCode === '5420' && e.debit === 25) && spec.referenceType === 'prod_close');
spec = P.glProdClose(Object.assign({ variance: 0, description: 'd' }, dims));
check('close spec zero variance → no entries', spec.entries.length === 0);

console.log(`\n${_f === 0 ? '✅' : '❌'} productionEngine: ${_p} passed, ${_f} failed\n`);
process.exit(_f === 0 ? 0 : 1);
