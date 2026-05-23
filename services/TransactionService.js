/**
 * ─── TransactionService ───────────────────────────────────────────
 *
 * Orchestrator for the transaction lifecycle. Composes repositories +
 * supporting services to deliver atomic operations:
 *
 *   create(payload, actor)
 *   forceDelete(txnId, payload, actor)
 *   transition(txnId, action, payload, actor)   ← TODO Phase 1.5
 *
 * Each method takes an explicit `actor` parameter:
 *
 *   { username, role, ip }
 *
 * No `req`/`res` ever leaks into this layer. Errors are thrown as
 * Error subclasses; the controller maps them to HTTP status codes.
 *
 * v6.8.0 — Phase 1
 */
'use strict';

const db          = require('../db/connection');
const repos       = require('../repositories');
const AssigneeR   = require('./AssigneeResolverService');
const Audit       = require('./AuditService');
const Notify      = require('./NotificationService');
const logger      = require('../lib/logger').child({ module: 'txn-svc' });

// ─── Errors ─────────────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
    this.field = field;
    this.statusCode = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.statusCode = 404;
  }
}

class PermissionDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionDeniedError';
    this.code = 'PERMISSION_DENIED';
    this.statusCode = 403;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function _todayYmd(d) {
  d = d || new Date();
  return d.getFullYear().toString()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
}

function _sanitizeCode(s, fallback) {
  if (!s) return fallback || 'GEN';
  const clean = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return clean || (fallback || 'GEN');
}

function _clamp(s, n) {
  return String(s || '').slice(0, n);
}

function _genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

// ─── CREATE ─────────────────────────────────────────────────────────

/**
 * Create a new transaction. Mirrors the legacy POST /transactions handler
 * line-for-line on observable behaviour (same fields validated, same
 * txnNumber format, same insert columns, same step log).
 *
 * @param {object} payload — full create payload (see route handler)
 * @param {object} actor   — { username, role, ip }
 * @returns {{ success: true, id, txnNumber, currentAssignee }}
 */
async function create(payload, actor) {
  if (!payload || !payload.transactionTypeId || !payload.title) {
    throw new ValidationError('نوع المعاملة والعنوان مطلوبان');
  }
  const username = (actor && actor.username) || payload.username || '';
  if (!username) throw new ValidationError('مستخدم غير معروف');

  // Permission: any employee can create unless explicitly revoked
  const sender = await repos.users.getPermissionProfile(username);
  if (sender && sender.canCreate === false) {
    throw new PermissionDeniedError('ليس لديك صلاحية إنشاء معاملة');
  }

  // Resolve branch + department codes (with fallback to sender profile)
  const finalBranchId = payload.branchId || sender.branchId || '';
  const finalDeptId   = payload.deptId   || sender.deptId   || '';

  let branchCode = '', branchName = '';
  if (finalBranchId) {
    const br = await repos.users.findBranchById(finalBranchId);
    if (br) {
      branchCode = _sanitizeCode(br.code || br.name, 'BR');
      branchName = br.name || '';
    }
  }
  if (!branchCode) branchCode = _sanitizeCode(sender.branchCode || sender.branchName, 'BR');
  if (!branchName) branchName = sender.branchName || '';

  let deptCode = '', deptName = '';
  if (finalDeptId) {
    const dp = await repos.users.findDepartmentById(finalDeptId);
    if (dp) {
      deptCode = _sanitizeCode(dp.code || dp.name, 'DEP');
      deptName = dp.name || '';
    }
  }
  if (!deptCode) deptCode = _sanitizeCode(sender.deptCode || sender.deptName, 'DEP');
  if (!deptName) deptName = sender.deptName || '';

  // Resolve transaction type code
  const tt = await repos.workflow.findTypeById(payload.transactionTypeId);
  if (!tt) throw new NotFoundError('نوع المعاملة غير موجود');
  const typeCode = _sanitizeCode(tt.code, 'TXN');

  // Daily serial + structured txn number
  const ymd = _todayYmd();
  const serial = await repos.tx.nextDailySerial(branchCode, deptCode, typeCode, ymd);
  const txnNumber = [
    _clamp(branchCode, 6), _clamp(deptCode, 6), _clamp(typeCode, 6),
    ymd, String(serial).padStart(4, '0')
  ].join('-');
  const id = _genId('TXN');

  // Resolve the first workflow step:
  //   1. PRIMARY  — initiator's position-chain (position_workflow_steps)
  //   2. FALLBACK — legacy per-type chain (workflow_definitions)
  let firstStep = null;
  let stepSource = 'type';
  const initiatorPositionId = sender.positionId || '';
  if (initiatorPositionId) {
    const posFirst = await repos.workflow.getInitiatorFirstStep(initiatorPositionId);
    if (posFirst) {
      firstStep = repos.workflow.normalizePositionStep(posFirst);
      stepSource = 'position';
    }
  }
  if (!firstStep) {
    firstStep = await repos.workflow.getFirstStepForType(payload.transactionTypeId);
  }
  const currentStepId = firstStep ? firstStep.id : null;
  const currentRoleId = firstStep ? (firstStep.required_position_id || null) : null;

  // Resolve assignee — the 6-level layered fallback
  const { username: currentAssignee, roleName: currentRoleName } = await AssigneeR.resolveForCreate({
    recipientUsername: payload.recipientUsername,
    recipients: payload.recipients,
    firstStep,
    sender,
    branchId: finalBranchId,
    deptId: finalDeptId
  });

  // Validate enums
  const validImportance = ['critical', 'high', 'medium', 'low'].includes(payload.importance)
    ? payload.importance
    : 'medium';
  const secrecyValues = ['normal', 'confidential', 'secret', 'top_secret'];
  const finalContentSecrecy = secrecyValues.includes(payload.contentSecrecy) ? payload.contentSecrecy : 'normal';
  const finalAttSecrecy     = secrecyValues.includes(payload.attachmentsSecrecy) ? payload.attachmentsSecrecy : 'normal';
  const finalSubject = (payload.subject || payload.title || '').slice(0, 500);
  const finalIssuingEntityId   = payload.issuingEntityId   || sender.deptId   || sender.branchId   || '';
  const finalIssuingEntityName = payload.issuingEntityName || sender.deptName || sender.branchName || '';

  // Draft mode overrides routing
  const initialStatus = payload.saveAsDraft
    ? 'draft'
    : ((currentAssignee || currentStepId) ? 'pending' : 'draft');

  // Atomic insert + children + step log
  await db.withTransaction(async (conn) => {
    await repos.tx.insertTx(conn, {
      id, txnNumber,
      transactionTypeId: payload.transactionTypeId, typeCode, dailySerial: serial,
      createdBy: username, branchId: finalBranchId, branchCode, branchName, brandId: payload.brandId,
      deptId: finalDeptId, deptCode, deptName,
      title: payload.title, subject: finalSubject, description: payload.description || '',
      contentHtml: payload.contentHtml, amount: payload.amount, importance: validImportance,
      contentSecrecy: finalContentSecrecy, attachmentsSecrecy: finalAttSecrecy,
      issuingEntityId: finalIssuingEntityId, issuingEntityName: finalIssuingEntityName,
      hijriDate: payload.hijriDate,
      status: initialStatus,
      currentStepId, currentRoleId, currentRoleName, currentAssignee,
      attachment: payload.attachment,
      accountId: payload.accountId, accountCode: payload.accountCode, accountName: payload.accountName,
      costCenterId: payload.costCenterId, costCenterName: payload.costCenterName,
      recipientUsername: payload.recipientUsername || '',
      senderName: payload.senderName || '', senderPosition: payload.senderPosition || '',
      initiatorPositionId
    });

    // Optional fields applied via UPDATE — keeps INSERT signature small
    await repos.tx.updateOptionalFieldsTx(conn, id, {
      expenseCategoryId: payload.expenseCategoryId,
      expenseCategoryName: payload.expenseCategoryName,
      dueDate: payload.dueDate,
      transactionScope: payload.scope === 'external' ? 'external' : (payload.scope ? 'internal' : undefined)
    });

    if (Array.isArray(payload.recipients) && payload.recipients.length) {
      await repos.tx.insertRecipientsTx(conn, id, payload.recipients);
    }

    await repos.tx.insertStepLogTx(conn, id, {
      workflowDefinitionId: currentStepId,
      actionBy: username,
      actionType: 'create',
      actionNote: 'تم إنشاء المعاملة',
      positionName: payload.senderPosition || sender.positionName || ''
    });
  });

  // Best-effort audit + notification (post-commit, never throws)
  Audit.recordCreate({ txnId: id, txnNumber, actor: username, payload, ip: actor && actor.ip })
    .catch(e => logger.warn({ event: 'audit_create_failed', error: e.message }));

  if (currentAssignee && currentAssignee !== username) {
    Notify.notifyTransactionAction({
      txn: { id, txnNumber, subject: finalSubject, title: payload.title },
      action: 'created',
      actor: username,
      target: currentAssignee
    }).catch(e => logger.warn({ event: 'notify_create_failed', error: e.message }));
  }

  logger.info({
    event: 'txn_created',
    id,
    txnNumber,
    type: typeCode,
    stepSource,
    assignee: currentAssignee || null,
    status: initialStatus,
    actor: username
  });

  return { success: true, id, txnNumber, currentAssignee };
}

// ─── FORCE DELETE ───────────────────────────────────────────────────

/**
 * Permanently delete a transaction + every child it owns. Caller must
 * have passed the `guardAdmin` middleware before reaching here — this
 * service does NOT re-check the admin role.
 *
 * @param {string} txnId
 * @param {object} payload — { confirm, reason }   (already schema-validated)
 * @param {object} actor   — { username, role, ip }
 * @returns {{ success: true, deletedId, txnNumber, message }}
 */
async function forceDelete(txnId, payload, actor) {
  if (!txnId) throw new ValidationError('معرّف المعاملة مطلوب', 'txnId');
  payload = payload || {};
  actor = actor || {};

  const snapshot = await repos.tx.findSnapshotById(txnId);
  if (!snapshot) throw new NotFoundError('المعاملة غير موجودة');

  await db.withTransaction(async (conn) => {
    // 1. Cascade delete children + the row itself
    await repos.tx.forceDeleteCascadeTx(conn, txnId);

    // 2. Audit row inside the same DB transaction — atomic with the delete
    try {
      await conn.query(
        `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at)
         VALUES (?, 'force_delete', 'transaction', ?, ?, NOW())`,
        [
          actor.username || '',
          txnId,
          JSON.stringify({
            txnNumber: snapshot.txnNumber,
            title: snapshot.subject || snapshot.title,
            createdBy: snapshot.createdBy,
            amount: Number(snapshot.amount) || 0,
            reason: String(payload.reason || '').trim()
          })
        ]
      );
    } catch (_) {
      // audit_logs may be absent or have a different schema in older deploys
    }
  });

  logger.warn({
    event: 'txn_force_deleted',
    txnId,
    txnNumber: snapshot.txnNumber,
    actor: actor.username,
    reason: String(payload.reason || '').slice(0, 80)
  });

  return {
    success: true,
    deletedId: txnId,
    txnNumber: snapshot.txnNumber || '',
    message: 'تم الحذف النهائي للمعاملة + كل ما يرتبط بها'
  };
}

// ─── TRANSITION (Phase 1.5 — not yet migrated) ──────────────────────
//
// The 446-line POST /transactions/:id/action handler in routes/workflow.js
// remains in place. Migration is split into a follow-up phase because the
// handler involves:
//   - SELECT … FOR UPDATE row lock
//   - Optimistic version check with 409 response
//   - Idempotency key lookup + replay
//   - SoD validator (lib/sodValidator.js) + admin break-glass override
//   - Amount-based step branching (getSiblingStep)
//   - Per-recipient sub_status sync
//   - Multiple notifications (creator + new assignee + CEO escalation)
//
// Each of those is a separable concern that benefits from its own service
// method. Tackling them in one commit would balloon this Phase 1 change.
// Phase 1.5 will land them iteratively, one concern per commit.

async function transition(/* txnId, action, payload, actor */) {
  throw new Error('TransactionService.transition() — Phase 1.5 (not yet migrated). The legacy POST /transactions/:id/action handler in routes/workflow.js remains the active code path.');
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  create,
  forceDelete,
  transition,
  // Error classes — controllers translate these to HTTP responses
  ValidationError,
  NotFoundError,
  PermissionDeniedError
};
