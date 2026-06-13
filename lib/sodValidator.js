/* ═══════════════════════════════════════════════════════════════════════
 * SoD (Segregation of Duties) Validator · v5.10.56
 *
 * Single-purpose module that enforces the four global SoD rules every
 * mature ERP / accounting platform requires:
 *
 *   SOD-1  Maker cannot be Approver
 *          → A user cannot approve a transaction they created.
 *
 *   SOD-2  Approver cannot be Payer
 *          → The user who gave final approval cannot be the one who
 *            executes the payment (only relevant for financial txns).
 *
 *   SOD-3  Payer cannot be Reconciler
 *          → The user who executed the payment cannot mark it as
 *            reconciled against the bank statement.
 *
 *   SOD-4  Two distinct approvers for high-value transactions
 *          → For amount ≥ HIGH_AMOUNT_THRESHOLD (default 200,000),
 *            at least two DIFFERENT users must approve. Same person
 *            approving twice at different steps does not count.
 *
 * The validator is BYPASSABLE only for users with role = 'admin' AND
 * the explicit emergency-override flag `SOD_OVERRIDE_REASON` in the
 * request body (audit-logged with reason). Without that, every
 * violation returns a structured error code the frontend i18n can map.
 *
 * Designed to be drop-in: call `sodCheck(rule, ctx)` before mutating
 * state. Returns `{ ok: true }` or `{ ok: false, code, message }`.
 * Caller is responsible for rollback + audit-log on failure.
 *
 * NOT a permission engine. Permission engine (lib/transactionPermissions.js)
 * answers "is this user *allowed*". SoD answers "even if allowed, is this
 * action a conflict-of-interest violation".
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';

// Threshold above which SOD-4 (two-distinct-approvers) kicks in.
// Read from env so finance can tune without a deploy.
const HIGH_AMOUNT_THRESHOLD = Number(process.env.SOD_HIGH_AMOUNT_THRESHOLD || 200000);

// Error codes — machine-readable, mapped to i18n on the frontend.
const CODES = {
  MAKER_APPROVER:        'SOD_VIOLATION_MAKER_APPROVER',
  APPROVER_PAYER:        'SOD_VIOLATION_APPROVER_PAYER',
  PAYER_RECONCILER:      'SOD_VIOLATION_PAYER_RECONCILER',
  HIGH_AMOUNT_2_DISTINCT:'SOD_VIOLATION_NEEDS_2_DISTINCT_APPROVERS',
  INVALID_RULE:          'SOD_INVALID_RULE'
};

// Human-readable Arabic messages (frontend can override via i18n keys).
const MESSAGES = {
  [CODES.MAKER_APPROVER]:
    'لا يمكنك الموافقة على معاملة أنشأتها بنفسك (فصل الواجبات — Maker ≠ Approver).',
  [CODES.APPROVER_PAYER]:
    'لا يمكنك تنفيذ دفعة معاملة وافقت عليها (فصل الواجبات — Approver ≠ Payer).',
  [CODES.PAYER_RECONCILER]:
    'لا يمكنك تسوية دفعة قمت بتنفيذها (فصل الواجبات — Payer ≠ Reconciler).',
  [CODES.HIGH_AMOUNT_2_DISTINCT]:
    'لمبالغ تتجاوز ' + HIGH_AMOUNT_THRESHOLD.toLocaleString('ar-SA') +
    ' يجب أن يوافق شخصان مختلفان (فصل الواجبات — Dual Approval Required).'
};

// ─── Helpers ──────────────────────────────────────────────────────────
function _norm(u) {
  return String(u || '').trim().toLowerCase();
}

function _isAdmin(user) {
  if (!user) return false;
  if (user.isAdmin || user.role === 'admin') return true;
  if (_norm(user.username) === 'admin') return true;
  return false;
}

function _hasOverride(reqBody) {
  // Emergency break-glass override — admin only, MUST supply reason.
  // The reason gets audit-logged at the caller site.
  if (!reqBody) return false;
  const reason = String(reqBody.SOD_OVERRIDE_REASON || '').trim();
  return reason.length >= 10;
}

function _distinctApprovers(actionLog) {
  // Count unique usernames that performed action_type === 'approve'.
  if (!Array.isArray(actionLog) || !actionLog.length) return 0;
  const set = new Set();
  for (const row of actionLog) {
    if (row && row.action_type === 'approve' && row.action_by) {
      set.add(_norm(row.action_by));
    }
  }
  return set.size;
}

// ─── Rule implementations ─────────────────────────────────────────────

/**
 * SOD-1 — Maker ≠ Approver
 * @param {Object} ctx { transaction, actor, action }
 *   transaction.created_by  — username of creator
 *   actor.username          — username trying to act
 *   action                  — 'approve' (only this triggers the rule)
 */
function checkMakerApprover(ctx) {
  if (!ctx || !ctx.transaction || !ctx.actor) return { ok: true };
  if (ctx.action !== 'approve') return { ok: true };
  const maker    = _norm(ctx.transaction.created_by);
  const approver = _norm(ctx.actor.username);
  if (maker && approver && maker === approver) {
    // v6.20.2 — "sole approver" exception. In small orgs/branches the maker is
    // often the ONLY holder of the approval position, so the workflow routes
    // the transaction back to its own creator. Hard-blocking then deadlocks it
    // forever (it can never be approved by anyone). When the caller has
    // verified there is NO other eligible approver for this step
    // (ctx.soleApprover === true), allow the self-approval but flag it so the
    // caller audit-logs it distinctly. SoD stays STRICT whenever an
    // alternative approver exists. (SOD-4 dual-approval is unaffected.)
    if (ctx.soleApprover === true) {
      return { ok: true, soleApproverException: true };
    }
    return { ok: false, code: CODES.MAKER_APPROVER, message: MESSAGES[CODES.MAKER_APPROVER] };
  }
  return { ok: true };
}

/**
 * SOD-2 — Approver ≠ Payer
 * Final-approver (last approve in action_log) must differ from payer.
 * @param {Object} ctx { transaction, actor, actionLog }
 *   action being attempted is 'pay' (caller decides)
 */
function checkApproverPayer(ctx) {
  if (!ctx || !ctx.transaction || !ctx.actor) return { ok: true };
  if (ctx.action !== 'pay' && ctx.action !== 'execute_payment') return { ok: true };
  if (!Array.isArray(ctx.actionLog) || !ctx.actionLog.length) return { ok: true };
  // Last approve entry
  const lastApprove = [...ctx.actionLog].reverse().find(
    r => r && r.action_type === 'approve'
  );
  if (!lastApprove) return { ok: true };
  const approver = _norm(lastApprove.action_by);
  const payer    = _norm(ctx.actor.username);
  if (approver && payer && approver === payer) {
    return { ok: false, code: CODES.APPROVER_PAYER, message: MESSAGES[CODES.APPROVER_PAYER] };
  }
  return { ok: true };
}

/**
 * SOD-3 — Payer ≠ Reconciler
 * @param {Object} ctx { payment, actor }
 *   payment.executed_by — username who executed the payment
 *   actor.username      — username attempting to reconcile
 */
function checkPayerReconciler(ctx) {
  if (!ctx || !ctx.payment || !ctx.actor) return { ok: true };
  if (ctx.action !== 'reconcile') return { ok: true };
  const payer       = _norm(ctx.payment.executed_by || ctx.payment.action_by);
  const reconciler  = _norm(ctx.actor.username);
  if (payer && reconciler && payer === reconciler) {
    return { ok: false, code: CODES.PAYER_RECONCILER, message: MESSAGES[CODES.PAYER_RECONCILER] };
  }
  return { ok: true };
}

/**
 * SOD-4 — Two distinct approvers when amount ≥ threshold
 * Applied at the FINAL approval step: if the only existing approver
 * also happens to be the current actor, the transaction must wait for
 * a second distinct approver.
 *
 * @param {Object} ctx { transaction, actor, actionLog, isFinalStep }
 */
function checkHighAmountDualApproval(ctx) {
  if (!ctx || !ctx.transaction || !ctx.actor) return { ok: true };
  if (ctx.action !== 'approve') return { ok: true };
  const amount = Number(ctx.transaction.amount || 0);
  if (amount < HIGH_AMOUNT_THRESHOLD) return { ok: true };
  if (!ctx.isFinalStep) return { ok: true };           // only enforce at final step

  // Count distinct prior approvers + the current actor.
  const distinctBefore = _distinctApprovers(ctx.actionLog);
  const actor = _norm(ctx.actor.username);
  const priorIncludesActor = (Array.isArray(ctx.actionLog) ? ctx.actionLog : [])
    .some(r => r && r.action_type === 'approve' && _norm(r.action_by) === actor);

  // Distinct count after this approval would happen:
  const distinctAfter = priorIncludesActor ? distinctBefore : (distinctBefore + 1);

  if (distinctAfter < 2) {
    return {
      ok: false, code: CODES.HIGH_AMOUNT_2_DISTINCT,
      message: MESSAGES[CODES.HIGH_AMOUNT_2_DISTINCT]
    };
  }
  return { ok: true };
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Run all relevant SoD rules for the given context.
 * Caller passes the union of fields needed by any rule; each rule
 * picks what it needs and ignores the rest.
 *
 * @param {Object} ctx
 *   { transaction, actor, action, actionLog, payment, isFinalStep, reqBody }
 * @returns {{ ok:true } | { ok:false, code, message, rule }}
 */
function validate(ctx) {
  // Admin emergency override
  if (ctx && ctx.actor && _isAdmin(ctx.actor) && _hasOverride(ctx.reqBody)) {
    return { ok: true, override: true, reason: String(ctx.reqBody.SOD_OVERRIDE_REASON).trim() };
  }

  const checks = [
    { rule: 'SOD-1', fn: checkMakerApprover },
    { rule: 'SOD-2', fn: checkApproverPayer },
    { rule: 'SOD-3', fn: checkPayerReconciler },
    { rule: 'SOD-4', fn: checkHighAmountDualApproval }
  ];

  let soleApproverException = false;
  for (const c of checks) {
    const r = c.fn(ctx);
    if (!r.ok) return Object.assign({}, r, { rule: c.rule });
    if (r.soleApproverException) soleApproverException = true;
  }
  return soleApproverException ? { ok: true, soleApproverException: true } : { ok: true };
}

module.exports = {
  validate,
  CODES,
  MESSAGES,
  HIGH_AMOUNT_THRESHOLD,
  // exported for unit testing
  _checks: {
    checkMakerApprover,
    checkApproverPayer,
    checkPayerReconciler,
    checkHighAmountDualApproval
  }
};
