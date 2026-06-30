/**
 * Warehouse Transfer (Stock Issue) — canonical lifecycle + receipt math.
 *
 * Phase 0 (Contracts & Safety). A single pure module that encodes the
 * transfer/stock-issue business rules so the HTTP route in
 * routes/warehouse-ops.js and the contract tests in
 * tests/warehouseTransfer.test.js share ONE source of truth.
 *
 * No I/O, no DB — every export is a pure function. Errors carry a stable
 * `.code` so callers can map them to an HTTP status + a UI message.
 *
 * Lifecycle (the React blueprint, §4.8):
 *   draft → approved → issued → partially_received → received
 *   draft|approved → cancelled
 *   issued|partially_received|received → reversed
 *
 * Hard rules enforced here:
 *   • You may ONLY issue from `approved` (never straight from `draft`).
 *   • Receipt is CUMULATIVE per line: a line can be received across many
 *     shipments, never beyond the issued quantity (no over-receipt).
 *   • The header lands on `received` only once every line is fully received;
 *     otherwise it rests on `partially_received`.
 */
'use strict';

const STATES = [
  'draft',
  'approved',
  'issued',
  'partially_received',
  'received',
  'cancelled',
  'reversed',
];

// States from which no forward workflow action is possible.
const TERMINAL = ['received', 'cancelled', 'reversed'];

// status → { action: nextStatus }. `receive` is special: the resulting
// status is decided by computeNextReceiveStatus() from the line totals,
// so it is not encoded as a fixed target here.
const TRANSITIONS = {
  draft:              { approve: 'approved',  cancel: 'cancelled' },
  approved:           { issue: 'issued',      cancel: 'cancelled' },
  issued:             { reverse: 'reversed' },
  partially_received: { reverse: 'reversed' },
  received:           { reverse: 'reversed' },
  cancelled:          {},
  reversed:           {},
};

const EPS = 1e-6;

function _err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function isTerminal(status) {
  return TERMINAL.indexOf(String(status)) !== -1;
}

// ── Issue guard (Phase 0 §3) ───────────────────────────────────────────
// A draft must be approved before it can be issued. This is the single
// rule that makes the approval step non-bypassable.
function canIssue(status) {
  return status === 'approved';
}
function assertCanIssue(status) {
  if (!canIssue(status)) {
    throw _err(
      'ISSUE_REQUIRES_APPROVED',
      'لا يمكن صرف الإذن إلا بعد اعتماده (الحالة يجب أن تكون "approved"). الحالة الحالية: ' + status
    );
  }
}

// ── Receive guard ──────────────────────────────────────────────────────
function canReceive(status) {
  return status === 'issued' || status === 'partially_received';
}
function assertCanReceive(status) {
  if (!canReceive(status)) {
    throw _err(
      'RECEIVE_INVALID_STATE',
      'لا يمكن الاستلام إلا بعد الصرف (issued أو partially_received). الحالة الحالية: ' + status
    );
  }
}

function canCancel(status) {
  return status === 'draft' || status === 'approved';
}
function canReverse(status) {
  return status === 'issued' || status === 'partially_received' || status === 'received';
}

// ── Cumulative per-line receipt math (Phase 0 §4) ──────────────────────
// Given what was issued, what was already received on prior shipments, and
// what is being received NOW, validate and return the new cumulative total.
//   remaining = qtyIssued − qtyReceivedSoFar
//   0 ≤ qtyReceiveNow ≤ remaining     (no negative, no over-receipt)
function computeLineReceipt(opts) {
  const issued = Number((opts && opts.qtyIssued) || 0);
  const prev   = Number((opts && opts.qtyReceivedSoFar) || 0);
  const now    = Number((opts && opts.qtyReceiveNow) || 0);

  if (!isFinite(now)) throw _err('NEGATIVE_QTY', 'الكمية المستلَمة غير صالحة');
  if (now < -EPS) throw _err('NEGATIVE_QTY', 'الكمية المستلَمة لا يمكن أن تكون سالبة');

  const remaining = issued - prev;
  if (now > remaining + EPS) {
    throw _err(
      'OVER_RECEIPT',
      'الكمية المستلَمة (' + now + ') أكبر من المتبقي القابل للاستلام (' + remaining + '). غير مسموح.'
    );
  }
  const applied = now;
  return {
    applied,
    newQtyReceived: prev + applied,
    remaining: remaining - applied,
  };
}

// ── Header status after a receive (Phase 0 §4) ─────────────────────────
// lines: [{ qtyIssued, qtyReceived }] using the NEW cumulative qtyReceived.
// Fully received (every issued unit accounted for) → 'received',
// otherwise → 'partially_received'.
function computeNextReceiveStatus(lines) {
  let issuedTotal = 0;
  let receivedTotal = 0;
  (lines || []).forEach(function (l) {
    issuedTotal += Number(l.qtyIssued) || 0;
    receivedTotal += Number(l.qtyReceived) || 0;
  });
  if (issuedTotal <= EPS) return 'received'; // defensive: nothing to receive
  return receivedTotal >= issuedTotal - EPS ? 'received' : 'partially_received';
}

// ── Generic transition guard ───────────────────────────────────────────
function transition(status, action) {
  const allowed = TRANSITIONS[status];
  if (!allowed || !(action in allowed)) {
    throw _err('INVALID_TRANSITION', 'انتقال غير مسموح: ' + status + ' → ' + action);
  }
  return allowed[action];
}

module.exports = {
  STATES,
  TERMINAL,
  TRANSITIONS,
  EPS,
  isTerminal,
  canIssue,
  assertCanIssue,
  canReceive,
  assertCanReceive,
  canCancel,
  canReverse,
  computeLineReceipt,
  computeNextReceiveStatus,
  transition,
};
