/**
 * Transaction Permission Engine — V4
 * ──────────────────────────────────────────────────────────────────────────
 * Single source of truth for "who can do what" on a transaction.
 * Replaces the scattered if/else permission checks across routes/workflow.js
 * and the duplicated UI button-visibility logic.
 *
 * Usage:
 *   const { can, computePermissions } = require('./lib/transactionPermissions');
 *
 *   if (!can(user, 'txn.action.approve', { txn, currentStep })) {
 *     return res.status(403).json({ error: 'Not allowed' });
 *   }
 *
 *   // Bulk-compute for UI:
 *   const perms = computePermissions(user, txn, { currentStep, actionLog });
 *   //=> { canView: true, canEdit: false, canApprove: true, canReject: true, ... }
 */

'use strict';

const { STATES, isTerminal } = require('./transactionStateMachine');

// ─── Permission definitions ────────────────────────────────────────────────
// Each entry says WHO can do this, in WHICH states, with what extra constraints.
const PERMISSIONS = {
  // ─── View ──────────────────────────────────────────────────────────────
  'txn.view': {
    description: 'See the transaction at all',
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (user.isDeveloper || user.role === 'admin') return true;
      if (t.created_by === user.username) return true;
      if (t.current_assignee === user.username) return true;
      if (t.recipient_username === user.username) return true;
      if ((ctx.recipientUsernames || []).includes(user.username)) return true;
      return false;
    }
  },

  // ─── Create ────────────────────────────────────────────────────────────
  'txn.create': {
    check: (user) => !!user.username   // any authenticated user
  },

  // ─── Edit ──────────────────────────────────────────────────────────────
  'txn.edit': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      // Creator can edit drafts
      if (t.created_by === user.username && t.status === STATES.DRAFT) return true;
      // Creator can edit returned items (the whole point of returning)
      if (t.created_by === user.username && t.status === STATES.RETURNED) return true;
      // Creator can edit pending items IF no one else has acted
      if (t.created_by === user.username && t.status === STATES.PENDING) {
        const othersActed = (ctx.actionLog || []).some(l =>
          l.action_type !== 'create' && l.action_by !== user.username);
        if (!othersActed) return true;
      }
      return false;
    }
  },

  // ─── Delete — V5.4.3: DEVELOPER ONLY ────────────────────────────────────
  // Hard delete with full cascade across all related tables. Removes the
  // transaction from EVERY user's view (sender, recipients, assignees, audit).
  // Audit_logs preserved for compliance.
  'txn.delete': {
    check: (user) => !!(user && user.isDeveloper)
  },

  // ─── Force-delete (still developer only — same behavior as txn.delete now) ─
  'txn.delete.force': {
    check: (user) => !!(user && user.isDeveloper)
  },

  // ─── Open / mark as viewed (created → in_progress) ─────────────────────
  'txn.action.open': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (t.status !== STATES.CREATED) return false;
      return _isAssignee(user, t);
    }
  },

  // ─── Approve ───────────────────────────────────────────────────────────
  'txn.action.approve': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (![STATES.CREATED, STATES.IN_PROGRESS, STATES.REPLIED].includes(t.status)) return false;
      if (!_isAssignee(user, t)) return false;
      if (_actorAlreadyActedOnStage(user, ctx)) return false;
      // Step-level guard
      if (ctx.currentStep && ctx.currentStep.can_approve === 0) return false;
      return true;
    }
  },

  // ─── Reject ────────────────────────────────────────────────────────────
  'txn.action.reject': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (![STATES.CREATED, STATES.IN_PROGRESS, STATES.REPLIED].includes(t.status)) return false;
      if (!_isAssignee(user, t)) return false;
      if (_actorAlreadyActedOnStage(user, ctx)) return false;
      if (ctx.currentStep && ctx.currentStep.can_reject === 0) return false;
      return true;
    }
  },

  // ─── Return ────────────────────────────────────────────────────────────
  'txn.action.return': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (![STATES.CREATED, STATES.IN_PROGRESS, STATES.REPLIED].includes(t.status)) return false;
      if (!_isAssignee(user, t)) return false;
      if (_actorAlreadyActedOnStage(user, ctx)) return false;
      // Cannot return if there's no previous step / actor
      if (ctx.currentStep && ctx.currentStep.can_return_to_previous === 0) return false;
      return true;
    }
  },

  // ─── Forward ───────────────────────────────────────────────────────────
  'txn.action.forward': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (![STATES.IN_PROGRESS, STATES.REPLIED].includes(t.status)) return false;
      if (!_isAssignee(user, t)) return false;
      if (_actorAlreadyActedOnStage(user, ctx)) return false;
      return true;
    }
  },

  // ─── Reply (V4.6.1: REPLIES = COMMENTS — unlimited; only WORKFLOW-ADVANCING is once-per-stage) ─
  // Closed/rejected: still allow reply (post-mortem comments are useful).
  // Anyone who can VIEW the transaction can post comment-replies as many times as needed.
  // The "one per stage" rule applies ONLY to actions that advance the workflow (approve/reject/return/forward),
  // which are enforced separately by the action handler.
  'txn.reply': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (user.role === 'admin' || user.isDeveloper) return true;
      const canView =
        t.created_by === user.username ||
        _isAssignee(user, t) ||
        t.recipient_username === user.username ||
        (ctx.recipientUsernames || []).includes(user.username);
      return !!canView;   // V4.6.1: unlimited comment-replies for anyone who can view
    }
  },

  // ─── Resubmit ──────────────────────────────────────────────────────────
  'txn.action.resubmit': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (t.status !== STATES.RETURNED) return false;
      return t.created_by === user.username;
    }
  },

  // ─── Close ─────────────────────────────────────────────────────────────
  'txn.action.close': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      // Admin can force-close at any non-terminal state
      if ((user.role === 'admin' || user.isDeveloper) && !isTerminal(t.status)) return true;
      // Approved → can close to finalize
      if (t.status === STATES.APPROVED) return true;
      return false;
    }
  },

  // ─── Record payment ────────────────────────────────────────────────────
  'txn.action.record_payment': {
    check: (user, ctx) => {
      const t = ctx.txn;
      if (!t) return false;
      if (t.status !== STATES.APPROVED) return false;
      const requiresPayment = !!(t.requires_payment || t.requiresPayment);
      if (!requiresPayment) return false;
      if (t.payment_record_id || t.paymentRecordId) return false;   // already paid
      // Finance role or admin
      return ['admin','finance','manager'].includes(user.role) || !!user.isDeveloper;
    }
  }
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function _isAssignee(user, txn) {
  return txn.current_assignee === user.username || txn.currentAssignee === user.username;
}

function _actorAlreadyActedOnStage(user, ctx) {
  // Has the user already done a workflow-advancing action (approve/reject/return/forward) on this stage?
  const log = ctx.actionLog || [];
  const stepId = ctx.txn.current_step_id || ctx.txn.currentStepId;
  if (!stepId) return false;
  return log.some(l =>
    l.action_by === user.username &&
    (l.workflow_definition_id === stepId || l.workflowDefinitionId === stepId) &&
    ['approve','reject','return','forward'].includes(l.action_type || l.actionType)
  );
}

function _actorAlreadyRepliedThisStage(user, ctx) {
  // For replies, "stage" = current step. One reply per stage per actor.
  const replies = ctx.replies || [];
  const stepId = ctx.txn.current_step_id || ctx.txn.currentStepId;
  return replies.some(r =>
    (r.author_username === user.username || r.authorUsername === user.username) &&
    (r.stage_step_id === stepId || r.stageStepId === stepId)
  );
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns true if the user can perform the named permission in the given context.
 */
function can(user, permission, ctx = {}) {
  const def = PERMISSIONS[permission];
  if (!def) {
    console.warn('[permissions] Unknown permission:', permission);
    return false;
  }
  // V5-SEC: developer NO LONGER blanket-bypasses every check.
  // - For VIEW/EDIT/DELETE/FORCE-DELETE: developer always allowed (incident-response).
  // - For workflow actions (approve/reject/return/forward/close/etc.): developer
  //   must still pass the check() — so a step with can_approve=0 cannot be force-approved.
  // - The check() functions themselves treat user.isDeveloper or role==='admin' as
  //   "always view-allowed" but enforce business rules for state-changing actions.
  const isDevOverride = (
    user && user.isDeveloper &&
    ['txn.view', 'txn.edit', 'txn.delete', 'txn.delete.force'].includes(permission)
  );
  if (isDevOverride) {
    if (def.check) return def.check(user, ctx);
    return true;
  }
  return def.check(user, ctx);
}

/**
 * Returns an object with all permissions pre-computed for the UI.
 * Frontend uses this to decide which buttons to render.
 */
function computePermissions(user, txn, ctx = {}) {
  const fullCtx = Object.assign({ txn }, ctx);
  return {
    canView:           can(user, 'txn.view',                 fullCtx),
    canEdit:           can(user, 'txn.edit',                 fullCtx),
    canDelete:         can(user, 'txn.delete',               fullCtx),
    canForceDelete:    can(user, 'txn.delete.force',         fullCtx),
    canOpen:           can(user, 'txn.action.open',          fullCtx),
    canApprove:        can(user, 'txn.action.approve',       fullCtx),
    canReject:         can(user, 'txn.action.reject',        fullCtx),
    canReturn:         can(user, 'txn.action.return',        fullCtx),
    canForward:        can(user, 'txn.action.forward',       fullCtx),
    canReply:          can(user, 'txn.reply',                fullCtx),
    canResubmit:       can(user, 'txn.action.resubmit',      fullCtx),
    canClose:          can(user, 'txn.action.close',         fullCtx),
    canRecordPayment:  can(user, 'txn.action.record_payment',fullCtx)
  };
}

module.exports = {
  PERMISSIONS,
  can,
  computePermissions
};
