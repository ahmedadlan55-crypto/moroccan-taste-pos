/**
 * Production Orders V2 engine — Phase P1 (warehouse final completion).
 *
 * PURE module (no I/O, no DB) mirroring lib/inventoryTxEngine.js:
 *   • the V2 production state machine + assert* guards,
 *   • partial-output event costing (running WIP average, never retroactive),
 *   • over-issue / over-production tolerance math,
 *   • GL spec builders for issue / output / close (+ reverse via E.reverseSpec).
 *
 * V2 lifecycle mapped ONTO the existing production_orders.status ENUM:
 *   draft → approved → in_progress → completed → closed          (+ reversed)
 *   draft|approved → cancelled (only BEFORE any materials issue)
 * Legacy occupies planned/released exclusively; V2 documents carry
 * source='v2' and never enter those two states, so the two write paths can
 * never act on each other's documents ("partially completed" is DERIVED:
 * in_progress AND qty_produced > 0 — no stored state to keep in sync).
 *
 * Costing model (approved design):
 *   • Each ISSUE event freezes per-line unit cost (warehouse WAC at that
 *     moment) and raises wip_balance by materials+labor+overhead.
 *   • Each OUTPUT event prices at  u = wip_balance / remainingExpected  where
 *     remainingExpected = max(plannedQty − producedSoFar, eventQty). Later
 *     issues raise later events' cost; already-posted FG is never restated.
 *   • Waste is expensed in full (Dr WASTE_FINISHED 5122) — never absorbed
 *     into good units, so the FG WAC stays clean.
 *   • close flushes any WIP residual to PRODUCTION_VARIANCE 5420.
 *
 * Unit-tested in tests/productionEngine.test.js.
 */
'use strict';

const { CORE_ACCOUNTS: A } = require('./glPosting');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

// ── State machine (V2 values only — legacy planned/released are OFF-LIMITS) ──
const V2_STATUSES = ['draft', 'approved', 'in_progress', 'completed', 'closed', 'cancelled', 'reversed'];
const LEGACY_STATUSES = ['planned', 'released'];

function _g(msg) { const e = new Error(msg); e.code = 'INVALID_STATE_TRANSITION'; return e; }
function isV2Status(s) { return V2_STATUSES.indexOf(String(s)) !== -1; }
function canEdit(s) { return s === 'draft'; }
function canApprove(s) { return s === 'draft'; }
function canIssue(s) { return s === 'approved' || s === 'in_progress'; }
function canOutput(s) { return s === 'in_progress'; }
function canComplete(s) { return s === 'in_progress'; }
function canClose(s) { return s === 'completed'; }
function canCancel(s, hasIssues) { return (s === 'draft' || s === 'approved') && !hasIssues; }
function canReverse(s) { return s === 'in_progress' || s === 'completed' || s === 'closed'; }
function canDelete(s) { return s === 'draft'; }
// Derived UI state — NOT a stored status.
function isPartiallyCompleted(s, qtyProduced) { return s === 'in_progress' && Number(qtyProduced) > 0; }

function assertCanEdit(s) { if (!canEdit(s)) throw _g('لا يمكن تعديل أمر إنتاج حالته "' + s + '" — المسودة فقط قابلة للتعديل'); }
function assertCanApprove(s) { if (!canApprove(s)) throw _g('لا يمكن اعتماد أمر إنتاج حالته "' + s + '"'); }
function assertCanIssue(s) { if (!canIssue(s)) throw _g('لا يمكن إصدار مواد لأمر حالته "' + s + '" — يجب اعتماده أولًا'); }
function assertCanOutput(s) { if (!canOutput(s)) throw _g('لا يمكن تسجيل إنتاج لأمر حالته "' + s + '" — أصدر المواد أولًا'); }
function assertCanComplete(s) { if (!canComplete(s)) throw _g('لا يمكن إكمال أمر حالته "' + s + '"'); }
function assertCanClose(s) { if (!canClose(s)) throw _g('لا يمكن إغلاق أمر حالته "' + s + '" — الإكمال أولًا'); }
function assertCanCancel(s, hasIssues) {
  if (s !== 'draft' && s !== 'approved') throw _g('لا يمكن إلغاء أمر حالته "' + s + '" — الإلغاء قبل إصدار المواد فقط؛ استخدم العكس بعده');
  if (hasIssues) throw _g('صدرت مواد لهذا الأمر — لا يمكن الإلغاء؛ استخدم العكس (reverse) لاسترجاع المواد');
}
function assertCanReverse(s) { if (!canReverse(s)) throw _g('لا يمكن عكس أمر حالته "' + s + '"'); }
function assertCanDelete(s) { if (!canDelete(s)) throw _g('لا يمكن حذف أمر حالته "' + s + '" — المسودة فقط'); }
function assertV2(doc) {
  if (!doc || doc.source !== 'v2') {
    const e = new Error('هذا المستند من النظام القديم — أوامر V2 فقط تُدار من هنا');
    e.code = 'VALIDATION_ERROR';
    throw e;
  }
}

// ── Tolerance math ───────────────────────────────────────────────────────────
// Over-issue: cumulative issued may exceed planned by at most tolPct (default
// 10%; env INV_PROD_OVERISSUE_TOL_PCT). Beyond → OVER_ISSUE unless a manager
// explicitly overrides with a reason.
function overIssueTolerance() {
  const n = Number(process.env.INV_PROD_OVERISSUE_TOL_PCT);
  return Number.isFinite(n) && n >= 0 ? n / 100 : 0.10;
}
function overProductionTolerance() {
  const n = Number(process.env.INV_PROD_OVERPROD_TOL_PCT);
  return Number.isFinite(n) && n >= 0 ? n / 100 : 0.10;
}
function checkOverIssue(plannedQty, issuedSoFar, addQty, tol) {
  const t = tol != null ? tol : overIssueTolerance();
  const cap = round4(Number(plannedQty) * (1 + t));
  const after = round4(Number(issuedSoFar) + Number(addQty));
  return { ok: after <= cap + 1e-9, cap, after };
}
function checkOverProduction(plannedQty, producedSoFar, wasteSoFar, addGood, addWaste, tol) {
  const t = tol != null ? tol : overProductionTolerance();
  const cap = round4(Number(plannedQty) * (1 + t));
  const after = round4(Number(producedSoFar) + Number(wasteSoFar) + Number(addGood) + Number(addWaste));
  return { ok: after <= cap + 1e-9, cap, after };
}

// ── Output-event costing ─────────────────────────────────────────────────────
// remainingExpected = max(planned − producedSoFar(incl. waste), eventQty) so a
// short-planned or over-produced event still prices sanely (never divide-by-less
// -than-the-event). u = wip / remainingExpected. Values are then capped so WIP
// can never go negative: if fg+waste value would exceed wip, both scale down
// proportionally (the close step flushes any residual to variance).
function priceOutputEvent(o) {
  const wip = round4(Math.max(0, Number(o.wipBalance) || 0));
  const planned = Number(o.plannedQty) || 0;
  const producedSoFar = (Number(o.producedSoFar) || 0) + (Number(o.wasteSoFar) || 0);
  const good = Number(o.goodQty) || 0;
  const waste = Number(o.wasteQty) || 0;
  const eventQty = good + waste;
  if (eventQty <= 0) { const e = new Error('كمية الحدث يجب أن تكون موجبة'); e.code = 'VALIDATION_ERROR'; throw e; }
  const remainingExpected = Math.max(round4(planned - producedSoFar), eventQty);
  const unitCost = remainingExpected > 0 ? round4(wip / remainingExpected) : 0;
  let fgValue = round2(good * unitCost);
  let wasteValue = round2(waste * unitCost);
  let scaled = false;
  const totalValue = round2(fgValue + wasteValue);
  if (totalValue > wip + 0.005 && totalValue > 0) {
    const k = wip / totalValue;
    fgValue = round2(fgValue * k);
    wasteValue = round2(wip - fgValue); // exact remainder → relief never exceeds WIP
    scaled = true;
  }
  const relief = round2(fgValue + wasteValue);
  return {
    unitCost,
    fgUnitCost: good > 0 ? round4(fgValue / good) : 0,
    fgValue, wasteValue, relief, remainingExpected, scaled,
  };
}

// ── GL spec builders (pure; posted via gl.postJournal, reversed via E.reverseSpec)
function _dims(o) { return { warehouseId: o.warehouseId || null, brandId: o.brandId || null, branchId: o.branchId || null, costCenterId: o.costCenterId || null }; }
function _base(o) { return { journalDate: o.journalDate, postedBy: o.postedBy, referenceId: o.referenceId, description: o.description }; }

// Materials converted into another inventory item remain in the same legal
// entity and the same Inventory Control account. The inventory value ledger
// carries raw/WIP/finished detail; GL only records externally-added production
// cost and genuine waste/variance.
function glProdIssue(o) {
  const labor = round2(o.laborCost || 0);
  const overhead = round2(o.overheadCost || 0);
  const entries = [];
  if (labor > 0) {
    entries.push(Object.assign({ accountCode: A.INVENTORY.code, debit: labor, credit: 0 }, _dims(o)));
    entries.push({ accountCode: A.LABOR_APPLIED.code, debit: 0, credit: labor, brandId: o.brandId || null });
  }
  if (overhead > 0) {
    entries.push(Object.assign({ accountCode: A.INVENTORY.code, debit: overhead, credit: 0 }, _dims(o)));
    entries.push({ accountCode: A.OVERHEAD_APPLIED.code, debit: 0, credit: overhead, brandId: o.brandId || null });
  }
  return Object.assign(_base(o), { referenceType: 'prod_issue', entries });
}

// Good output is an internal reclassification in the subledger. Only waste
// leaves Inventory Control and reaches the income statement.
function glProdOutput(o) {
  const waste = round2(o.wasteValue || 0);
  const entries = [];
  if (waste > 0) entries.push(Object.assign({ accountCode: A.WASTE_FINISHED.code, debit: waste, credit: 0 }, _dims(o)));
  if (waste > 0) entries.push(Object.assign({ accountCode: A.INVENTORY.code, debit: 0, credit: waste }, _dims(o)));
  return Object.assign(_base(o), { referenceType: 'prod_output', entries });
}

// Close: a real residual reduces Inventory Control and is expensed.
function glProdClose(o) {
  const v = round2(o.variance);
  const entries = [];
  if (v > 0) {
    entries.push(Object.assign({ accountCode: A.PRODUCTION_VARIANCE.code, debit: v, credit: 0 }, _dims(o)));
    entries.push(Object.assign({ accountCode: A.INVENTORY.code, debit: 0, credit: v }, _dims(o)));
  }
  return Object.assign(_base(o), { referenceType: 'prod_close', entries });
}

// Waste allowance gate. A gate, never a costing rule — waste is expensed at
// cost either way.
//
// SEMANTICS CHANGED (deliberately). This used to read
//     const pct = Number(allowedScrapPct) || 0; if (pct <= 0) return false;
// so 0 meant "no gate, unlimited waste" — the exact opposite of what
// "allowed scrap = 0%" says, and unfixable because 0 was also the column
// default and what both create routes wrote when the field was omitted. There
// was therefore NO WAY to express a zero-scrap order, and the gate never fired
// on any order in the system.
//
// Now:
//   null / undefined → no explicit policy; the default applies (not gated here)
//   0                → ZERO scrap permitted; ANY waste needs a manager override
//   n                → cumulative waste above n% of planned needs an override
//
// Migration 0027 rewrote every EXISTING row holding 0 to NULL, so no historical
// order changes behaviour — 0 only starts meaning zero for orders created after
// the change, where someone actually chose it.
//
// The rule itself lives in lib/recipeEngine so the recipe side and the
// production side can never drift apart; this stays as the call site the
// production route already uses.
function wasteAllowanceExceeded(plannedQty, wasteSoFar, addWaste, allowedScrapPct) {
  return require('./recipeEngine').wasteAllowanceExceeded(plannedQty, wasteSoFar, addWaste, allowedScrapPct);
}
/** Is an explicit (non-default) allowance configured on this order? */
function hasExplicitScrapAllowance(allowedScrapPct) {
  return require('./recipeEngine').scrapAllowanceFor(allowedScrapPct).explicit;
}

function specBalances(spec) {
  let d = 0, c = 0;
  for (const e of (spec.entries || [])) { d += Number(e.debit) || 0; c += Number(e.credit) || 0; }
  return round2(d) === round2(c);
}

module.exports = {
  round2, round4,
  V2_STATUSES, LEGACY_STATUSES, isV2Status,
  canEdit, canApprove, canIssue, canOutput, canComplete, canClose, canCancel, canReverse, canDelete,
  isPartiallyCompleted,
  assertCanEdit, assertCanApprove, assertCanIssue, assertCanOutput, assertCanComplete,
  assertCanClose, assertCanCancel, assertCanReverse, assertCanDelete, assertV2,
  overIssueTolerance, overProductionTolerance, checkOverIssue, checkOverProduction,
  priceOutputEvent, wasteAllowanceExceeded, hasExplicitScrapAllowance,
  glProdIssue, glProdOutput, glProdClose, specBalances,
};
