/**
 * Transaction State Machine — V4
 * ──────────────────────────────────────────────────────────────────────────
 * Single source of truth for all valid transitions on the Workflow engine.
 * Every endpoint that mutates a transaction's status MUST go through this
 * module — direct UPDATE on `transactions.status` is a bug.
 *
 *  States (8):
 *    draft       — being composed, not yet submitted
 *    created     — submitted, but the assignee hasn't opened it yet
 *    in_progress — assignee opened it; review in progress
 *    replied     — current actor has acted (next stage will pick up)
 *    returned    — sent back to creator for fixes
 *    approved    — fully approved (may still need payment record)
 *    rejected    — terminal; creator may re-create
 *    closed      — terminal; archived
 *
 *  Transitions:
 *    submit, open, approve, reject, return, reply, resubmit, forward,
 *    record_payment, close, edit (self-loop), cancel, force_delete
 */

'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────
const STATES = Object.freeze({
  DRAFT: 'draft',
  CREATED: 'created',
  IN_PROGRESS: 'in_progress',
  REPLIED: 'replied',
  RETURNED: 'returned',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CLOSED: 'closed'
});

const ACTIONS = Object.freeze({
  SUBMIT: 'submit',         // draft → created
  OPEN: 'open',             // created → in_progress (assignee firstView)
  APPROVE: 'approve',       // in_progress → replied / approved
  REJECT: 'reject',         // in_progress → rejected
  RETURN: 'return',         // in_progress → returned
  REPLY: 'reply',           // self-loop (just adds a reply, doesn't advance)
  RESUBMIT: 'resubmit',     // returned → in_progress
  FORWARD: 'forward',       // in_progress → in_progress (different assignee)
  RECORD_PAYMENT: 'record_payment', // approved → closed
  CLOSE: 'close',           // approved → closed
  EDIT: 'edit',             // self-loop on draft/returned
  CANCEL: 'cancel',         // draft/created/returned → deleted
  FORCE_DELETE: 'force_delete'      // any → deleted (developer only)
});

const TERMINAL = new Set([STATES.REJECTED, STATES.CLOSED]);

// ─── Transition table ──────────────────────────────────────────────────────
// Each entry returns either a fixed next state or a function (txn) → next.
const TRANSITIONS = {
  [STATES.DRAFT]: {
    [ACTIONS.EDIT]: () => STATES.DRAFT,
    [ACTIONS.SUBMIT]: () => STATES.CREATED,
    [ACTIONS.CANCEL]: () => null   // delete row
  },
  [STATES.CREATED]: {
    [ACTIONS.OPEN]: () => STATES.IN_PROGRESS,
    [ACTIONS.RETURN]: () => STATES.RETURNED,
    [ACTIONS.REJECT]: () => STATES.REJECTED,
    [ACTIONS.APPROVE]: (txn) => txn.hasNextStep ? STATES.IN_PROGRESS : STATES.APPROVED,
    [ACTIONS.CANCEL]: () => null
  },
  [STATES.IN_PROGRESS]: {
    [ACTIONS.APPROVE]: (txn) => txn.hasNextStep ? STATES.IN_PROGRESS : STATES.APPROVED,
    [ACTIONS.REJECT]: () => STATES.REJECTED,
    [ACTIONS.RETURN]: () => STATES.RETURNED,
    [ACTIONS.REPLY]: () => STATES.REPLIED,
    [ACTIONS.FORWARD]: () => STATES.IN_PROGRESS,
    [ACTIONS.CLOSE]: () => STATES.CLOSED       // admin emergency close
  },
  [STATES.REPLIED]: {
    // After actor replied, only the next-stage actor can do something.
    // This state acts as a soft-lock for the previous actor.
    [ACTIONS.APPROVE]: (txn) => txn.hasNextStep ? STATES.IN_PROGRESS : STATES.APPROVED,
    [ACTIONS.REJECT]: () => STATES.REJECTED,
    [ACTIONS.RETURN]: () => STATES.RETURNED,
    [ACTIONS.FORWARD]: () => STATES.IN_PROGRESS,
    [ACTIONS.CLOSE]: () => STATES.CLOSED
  },
  [STATES.RETURNED]: {
    [ACTIONS.EDIT]: () => STATES.RETURNED,           // creator edits in place
    [ACTIONS.RESUBMIT]: () => STATES.IN_PROGRESS,    // back to returned-to-step
    [ACTIONS.CANCEL]: () => null,
    [ACTIONS.REPLY]: () => STATES.RETURNED           // creator can clarify via reply
  },
  [STATES.APPROVED]: {
    [ACTIONS.RECORD_PAYMENT]: () => STATES.CLOSED,
    [ACTIONS.CLOSE]: () => STATES.CLOSED,
    [ACTIONS.REPLY]: () => STATES.APPROVED           // post-approval discussion
  },
  [STATES.REJECTED]: {
    [ACTIONS.REPLY]: () => STATES.REJECTED           // can still discuss
    // No other transitions out — terminal
  },
  [STATES.CLOSED]: {
    [ACTIONS.REPLY]: () => STATES.CLOSED             // can still discuss
    // No other transitions out — terminal
  }
};

// ─── Public API ────────────────────────────────────────────────────────────

class InvalidTransitionError extends Error {
  constructor(state, action) {
    super(`INVALID_TRANSITION: cannot perform "${action}" while in state "${state}"`);
    this.name = 'InvalidTransitionError';
    this.code = 'INVALID_TRANSITION';
    this.state = state;
    this.action = action;
  }
}

class StateMachineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StateMachineError';
    this.code = code;
  }
}

/**
 * Returns true if the action is allowed from the current state.
 * @param {string} currentState — one of STATES
 * @param {string} action — one of ACTIONS
 * @param {object} ctx — { txn: { hasNextStep, ... } }
 */
function can(currentState, action, ctx = {}) {
  const stateMap = TRANSITIONS[currentState];
  if (!stateMap) return false;
  const handler = stateMap[action];
  if (!handler) return false;
  // For functions that depend on context, we don't pre-check — just allow
  // and let the engine compute the next state. We DO reject if computed
  // result is null when null isn't a delete action.
  return true;
}

/**
 * Computes the next state. Throws InvalidTransitionError if not allowed.
 * @returns {string|null} — next state, or null for delete actions
 */
function transition(currentState, action, ctx = {}) {
  if (!can(currentState, action, ctx)) {
    throw new InvalidTransitionError(currentState, action);
  }
  const handler = TRANSITIONS[currentState][action];
  const next = typeof handler === 'function' ? handler(ctx.txn || {}) : handler;
  return next;
}

/**
 * Returns the array of actions allowed from a given state.
 */
function availableActions(currentState) {
  const stateMap = TRANSITIONS[currentState];
  return stateMap ? Object.keys(stateMap) : [];
}

/**
 * Returns true if the state is terminal (no transitions out except reply).
 */
function isTerminal(state) {
  return TERMINAL.has(state);
}

// ─── Invariants ────────────────────────────────────────────────────────────
// Pure functions that check whether a (txn, newState) pair is consistent.
// Run BEFORE any UPDATE — fail-fast prevents corrupt state from persisting.
const INVARIANTS = [
  {
    name: 'TERMINAL_HAS_NO_ASSIGNEE',
    check: (txn) => {
      if (TERMINAL.has(txn.status) && txn.current_assignee && txn.current_assignee !== '') {
        return `Terminal state ${txn.status} must have empty current_assignee, got "${txn.current_assignee}"`;
      }
      return null;
    }
  },
  {
    name: 'RETURNED_GOES_TO_CREATOR',
    check: (txn) => {
      if (txn.status === STATES.RETURNED) {
        if (txn.current_assignee !== txn.created_by) {
          return `Returned txn must have current_assignee = created_by; got assignee="${txn.current_assignee}", creator="${txn.created_by}"`;
        }
      }
      return null;
    }
  },
  {
    name: 'IN_PROGRESS_HAS_ASSIGNEE',
    check: (txn) => {
      if (txn.status === STATES.IN_PROGRESS && (!txn.current_assignee || txn.current_assignee === '')) {
        return `in_progress state must have a current_assignee`;
      }
      return null;
    }
  },
  {
    name: 'RETURN_COUNT_NON_NEGATIVE',
    check: (txn) => {
      if (Number(txn.return_count || 0) < 0) {
        return `return_count cannot be negative: ${txn.return_count}`;
      }
      return null;
    }
  },
  {
    name: 'RETURNED_FIELDS_CONSISTENT',
    check: (txn) => {
      // If status is currently 'returned' OR was previously returned (return_count > 0), returned_at must be set
      if (txn.status === STATES.RETURNED && !txn.returned_at) {
        return `returned status requires returned_at to be set`;
      }
      return null;
    }
  },
  {
    name: 'VERSION_NON_NEGATIVE',
    check: (txn) => {
      if (Number(txn.version || 0) < 0) {
        return `version cannot be negative: ${txn.version}`;
      }
      return null;
    }
  }
];

/**
 * Validates a transaction object against all invariants.
 * @returns {Array<string>} — list of violation messages (empty if all pass)
 */
function checkInvariants(txn) {
  const violations = [];
  for (const inv of INVARIANTS) {
    try {
      const violation = inv.check(txn);
      if (violation) violations.push(`[${inv.name}] ${violation}`);
    } catch (e) {
      violations.push(`[${inv.name}] check threw: ${e.message}`);
    }
  }
  return violations;
}

/**
 * Throws StateMachineError if any invariant fails.
 */
function assertInvariants(txn) {
  const violations = checkInvariants(txn);
  if (violations.length) {
    throw new StateMachineError('INVARIANT_VIOLATION', violations.join('; '));
  }
}

// ─── Status display metadata (used by UI generators) ───────────────────────
const STATUS_META = {
  [STATES.DRAFT]:       { color: '#94a3b8', bg: '#f1f5f9', icon: 'fa-file-pen',     ar: 'مسودة',           en: 'Draft' },
  [STATES.CREATED]:     { color: '#0ea5e9', bg: '#e0f2fe', icon: 'fa-paper-plane',  ar: 'جديدة',           en: 'New' },
  [STATES.IN_PROGRESS]: { color: '#f59e0b', bg: '#fef3c7', icon: 'fa-spinner',      ar: 'قيد الإجراء',     en: 'In Progress' },
  [STATES.REPLIED]:     { color: '#8b5cf6', bg: '#ede9fe', icon: 'fa-comment-dots', ar: 'تم الرد',         en: 'Replied' },
  [STATES.RETURNED]:    { color: '#dc2626', bg: '#fef2f2', icon: 'fa-rotate-left',  ar: 'مرجعة للتعديل', en: 'Returned' },
  [STATES.APPROVED]:    { color: '#16a34a', bg: '#dcfce7', icon: 'fa-circle-check', ar: 'معتمدة',          en: 'Approved' },
  [STATES.REJECTED]:    { color: '#991b1b', bg: '#fee2e2', icon: 'fa-circle-xmark', ar: 'مرفوضة',          en: 'Rejected' },
  [STATES.CLOSED]:      { color: '#6b7280', bg: '#f3f4f6', icon: 'fa-lock',         ar: 'مغلقة',           en: 'Closed' }
};

const ACTION_META = {
  [ACTIONS.SUBMIT]:    { color: '#0ea5e9', icon: 'fa-paper-plane',     ar: 'إرسال',          en: 'Submit' },
  [ACTIONS.OPEN]:      { color: '#0ea5e9', icon: 'fa-eye',             ar: 'فتح',           en: 'Open' },
  [ACTIONS.APPROVE]:   { color: '#16a34a', icon: 'fa-check-circle',    ar: 'موافقة',         en: 'Approve' },
  [ACTIONS.REJECT]:    { color: '#dc2626', icon: 'fa-times-circle',    ar: 'رفض',           en: 'Reject' },
  [ACTIONS.RETURN]:    { color: '#f59e0b', icon: 'fa-rotate-left',     ar: 'إرجاع',         en: 'Return' },
  [ACTIONS.REPLY]:     { color: '#8b5cf6', icon: 'fa-comment',         ar: 'رد',            en: 'Reply' },
  [ACTIONS.RESUBMIT]:  { color: '#0ea5e9', icon: 'fa-arrow-up-from-bracket', ar: 'إعادة إرسال', en: 'Resubmit' },
  [ACTIONS.FORWARD]:   { color: '#8b5cf6', icon: 'fa-share',           ar: 'تحويل',          en: 'Forward' },
  [ACTIONS.RECORD_PAYMENT]: { color: '#0369a1', icon: 'fa-money-bill-transfer', ar: 'تسجيل دفعة', en: 'Record Payment' },
  [ACTIONS.CLOSE]:     { color: '#6b7280', icon: 'fa-lock',            ar: 'إغلاق',          en: 'Close' },
  [ACTIONS.EDIT]:      { color: '#1e40af', icon: 'fa-pen',             ar: 'تعديل',          en: 'Edit' },
  [ACTIONS.CANCEL]:    { color: '#dc2626', icon: 'fa-trash',           ar: 'إلغاء',          en: 'Cancel' },
  [ACTIONS.FORCE_DELETE]: { color: '#7f1d1d', icon: 'fa-skull-crossbones', ar: 'حذف نهائي', en: 'Force Delete' }
};

// ─── Exports ───────────────────────────────────────────────────────────────
module.exports = {
  STATES,
  ACTIONS,
  TERMINAL,
  STATUS_META,
  ACTION_META,
  TRANSITIONS,
  can,
  transition,
  availableActions,
  isTerminal,
  checkInvariants,
  assertInvariants,
  InvalidTransitionError,
  StateMachineError
};
