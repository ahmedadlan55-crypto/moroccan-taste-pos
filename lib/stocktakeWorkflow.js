/**
 * Stocktake Pro — canonical workflow + variance math.
 *
 * Phase 0 (Contracts & Safety). Pure rules shared by the HTTP route in
 * routes/stocktake-pro.js, the legacy delete guard in routes/inventory.js,
 * and the contract tests in tests/stocktakeWorkflow.test.js.
 *
 * Workflow (React blueprint §4.9):
 *   draft → in_progress → pending_approval → approved | rejected
 *   draft | in_progress → cancelled
 *
 * Hard rules:
 *   • Only `pending_approval` can be approved or rejected.
 *   • A posted count (`approved`, or the legacy `completed`) can NEVER be
 *     hard-deleted — the stock + GL it moved must be corrected by a new
 *     count / reversal, not erased.
 *   • A physical count line can never be negative.
 */
'use strict';

const STATES = [
  'draft',
  'in_progress',
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
];

// Statuses that have posted stock / GL. 'completed' is the legacy
// single-step path's terminal status (routes/inventory.js POST /stocktakes).
const POSTED = ['approved', 'completed'];

const TRANSITIONS = {
  draft:            { load: 'in_progress', submit: 'pending_approval', cancel: 'cancelled' },
  in_progress:      { submit: 'pending_approval', cancel: 'cancelled' },
  pending_approval: { approve: 'approved', reject: 'rejected' },
  approved:         {},
  rejected:         {},
  cancelled:        {},
};

function _err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function isPosted(status) {
  return POSTED.indexOf(String(status)) !== -1;
}

function canApprove(status) { return status === 'pending_approval'; }
function canReject(status)  { return status === 'pending_approval'; }
function canCancel(status)  { return status === 'draft' || status === 'in_progress'; }

function canDelete(status) {
  return !isPosted(status);
}
function assertCanDelete(status) {
  if (!canDelete(status)) {
    throw _err(
      'STK_POSTED_NO_DELETE',
      'لا يمكن حذف محضر جرد مُرحّل — صحّح الفرق بجرد/تسوية جديدة بدل الحذف.'
    );
  }
}

function transition(status, action) {
  const allowed = TRANSITIONS[status];
  if (!allowed || !(action in allowed)) {
    throw _err('INVALID_TRANSITION', 'انتقال غير مسموح: ' + status + ' → ' + action);
  }
  return allowed[action];
}

// A physical count can never be negative — block it before it locks a
// negative on-hand into stock + GL at approval time.
function assertNoNegativeCount(lines) {
  (lines || []).forEach(function (l) {
    if (Number(l.actualQty) < 0) {
      throw _err('NEGATIVE_COUNT', 'لا يمكن أن تكون الكمية الفعلية سالبة.');
    }
  });
}

// Variance math — the single source of truth for the per-line numbers the
// PUT /:id/items/:lineId endpoint persists and the UI renders.
//   variance      = actual − system        (rounded to 3 dp)
//   variancePct   = |variance| / system × 100   (100 when system is 0 and
//                   there is any variance)
//   varianceValue = variance × unitCost     (2 dp, signed)
//   isFlagged     = variancePct ≥ threshold
function computeVariance(opts) {
  const sys = Number((opts && opts.systemQty) || 0);
  const act = Number((opts && opts.actualQty) || 0);
  const unitCost = Number((opts && opts.unitCost) || 0);
  const thresholdPct = Number(opts && opts.thresholdPct != null ? opts.thresholdPct : 10);

  const variance = Math.round((act - sys) * 1000) / 1000;
  const variancePct = sys > 0
    ? Math.round((Math.abs(variance) / sys) * 10000) / 100
    : (variance ? 100 : 0);
  const varianceValue = Math.round(variance * unitCost * 100) / 100;
  const isFlagged = variancePct >= thresholdPct;

  return { variance, variancePct, varianceValue, isFlagged };
}

module.exports = {
  STATES,
  POSTED,
  TRANSITIONS,
  isPosted,
  canApprove,
  canReject,
  canCancel,
  canDelete,
  assertCanDelete,
  transition,
  assertNoNegativeCount,
  computeVariance,
};
