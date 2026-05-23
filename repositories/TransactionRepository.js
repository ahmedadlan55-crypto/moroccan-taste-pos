/**
 * ─── TransactionRepository ────────────────────────────────────────
 *
 * All SQL touching the `transactions` table and its closely-associated
 * children (`txn_recipients`, `transaction_steps_log`, `transaction_replies`,
 * `txn_attachments`, `memo_read_receipts`, `notifications` link rows).
 *
 * Methods that accept a `conn` first argument run inside the caller's
 * DB transaction. Methods without `conn` use the shared pool. Multi-step
 * services should always use the `*Tx` flavor with a `withTransaction`
 * wrapper to keep cascades atomic.
 *
 * v6.8.0 — Phase 1 (Strangler Fig). The legacy in-file SQL inside
 * routes/workflow.js continues to exist for the 51 not-yet-migrated
 * endpoints. As each is migrated, its SQL collapses into a method here.
 */
'use strict';

const db = require('../db/connection');

// ─── Helpers ────────────────────────────────────────────────────────

function _genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

/** Maps a raw transactions row to a camelCase domain object. */
function _toDomain(row) {
  if (!row) return null;
  return {
    id: row.id,
    txnNumber: row.transaction_number,
    transactionTypeId: row.transaction_type_id,
    typeCode: row.type_code,
    dailySerial: row.daily_serial,
    createdBy: row.created_by,
    branchId: row.branch_id,
    branchCode: row.branch_code,
    branchName: row.branch_name,
    brandId: row.brand_id,
    deptId: row.dept_id,
    deptCode: row.dept_code,
    deptName: row.dept_name,
    title: row.title,
    subject: row.subject,
    description: row.description,
    contentHtml: row.content_html,
    amount: row.amount,
    importance: row.importance,
    contentSecrecy: row.content_secrecy,
    attachmentsSecrecy: row.attachments_secrecy,
    issuingEntityId: row.issuing_entity_id,
    issuingEntityName: row.issuing_entity_name,
    hijriDate: row.hijri_date,
    status: row.status,
    currentStepId: row.current_step_id,
    currentRoleId: row.current_role_id,
    currentRoleName: row.current_role_name,
    currentAssignee: row.current_assignee,
    attachment: row.attachment,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    costCenterId: row.cost_center_id,
    costCenterName: row.cost_center_name,
    recipientUsername: row.recipient_username,
    senderName: row.sender_name,
    senderPosition: row.sender_position,
    initiatorPositionId: row.initiator_position_id,
    version: Number(row.version) || 0,
    returnedAt: row.returned_at,
    returnedBy: row.returned_by,
    returnedReason: row.returned_reason,
    returnedToStepId: row.returned_to_step_id,
    returnCount: Number(row.return_count) || 0,
    slaHours: row.sla_hours,
    slaDueDate: row.sla_due_date,
    escalatedAt: row.escalated_at,
    escalationCount: Number(row.escalation_count) || 0,
    expenseCategoryId: row.expense_category_id,
    expenseCategoryName: row.expense_category_name,
    dueDate: row.due_date,
    transactionScope: row.transaction_scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    deletedReason: row.deleted_reason,
    // Keep the raw row available for callers who need columns we
    // haven't mapped yet — extracted progressively.
    _raw: row
  };
}

// ─── Read ───────────────────────────────────────────────────────────

async function findById(id) {
  if (!id) return null;
  const [rows] = await db.query('SELECT * FROM transactions WHERE id = ?', [id]);
  return rows.length ? _toDomain(rows[0]) : null;
}

async function findByIdTx(conn, id, opts) {
  if (!id) return null;
  opts = opts || {};
  const sql = opts.forUpdate
    ? 'SELECT * FROM transactions WHERE id = ? FOR UPDATE'
    : 'SELECT * FROM transactions WHERE id = ?';
  const [rows] = await conn.query(sql, [id]);
  return rows.length ? _toDomain(rows[0]) : null;
}

/** Slim projection used by force-delete (avoids loading large fields). */
async function findSnapshotById(id) {
  if (!id) return null;
  const [rows] = await db.query(
    'SELECT id, transaction_number, title, subject, created_by, amount FROM transactions WHERE id = ?',
    [id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    txnNumber: r.transaction_number,
    title: r.title,
    subject: r.subject,
    createdBy: r.created_by,
    amount: Number(r.amount) || 0
  };
}

// ─── Write ──────────────────────────────────────────────────────────

/**
 * Insert a transaction row. Caller must provide all canonical fields.
 * Returns the generated id (or the provided id).
 *
 * For multi-step operations (insert + child rows + step log), call this
 * inside a `db.withTransaction` block and pass `conn`.
 */
async function insertTx(conn, params) {
  const id = params.id || _genId('TXN');
  await conn.query(
    `INSERT INTO transactions (
       id, transaction_number, transaction_type_id, type_code, daily_serial,
       created_by, branch_id, branch_code, branch_name, brand_id,
       dept_id, dept_code, dept_name,
       title, subject, description, content_html, amount, importance,
       content_secrecy, attachments_secrecy, issuing_entity_id, issuing_entity_name, hijri_date,
       status, current_step_id, current_role_id, current_role_name, current_assignee, attachment,
       account_id, account_code, account_name, cost_center_id, cost_center_name,
       recipient_username, sender_name, sender_position, initiator_position_id)
     VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?)`,
    [
      id, params.txnNumber, params.transactionTypeId, params.typeCode, params.dailySerial,
      params.createdBy || '', params.branchId || null, params.branchCode || '', params.branchName || '', params.brandId || null,
      params.deptId || null, params.deptCode || '', params.deptName || '',
      params.title, params.subject, params.description || '', params.contentHtml || null, params.amount || 0, params.importance || 'medium',
      params.contentSecrecy || 'normal', params.attachmentsSecrecy || 'normal', params.issuingEntityId || null, params.issuingEntityName || '', params.hijriDate || '',
      params.status || 'draft', params.currentStepId || null, params.currentRoleId || null, params.currentRoleName || '', params.currentAssignee || '', params.attachment || null,
      params.accountId || null, params.accountCode || '', params.accountName || '', params.costCenterId || null, params.costCenterName || '',
      params.recipientUsername || '', params.senderName || '', params.senderPosition || '', params.initiatorPositionId || null
    ]
  );
  return id;
}

/**
 * Apply optional fields to a freshly-inserted transaction. Caller decides
 * which keys to set; the method gracefully tolerates unknown columns.
 */
async function updateOptionalFieldsTx(conn, id, updates) {
  if (!updates || Object.keys(updates).length === 0) return;
  const colMap = {
    expenseCategoryId: 'expense_category_id',
    expenseCategoryName: 'expense_category_name',
    dueDate: 'due_date',
    transactionScope: 'transaction_scope'
  };
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(updates)) {
    const col = colMap[k];
    if (!col) continue;
    sets.push(`${col}=?`);
    vals.push(v == null ? null : v);
  }
  if (!sets.length) return;
  vals.push(id);
  try {
    await conn.query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, vals);
  } catch (_) {
    // tolerate schema variants — column may not exist on older deploys
  }
}

// ─── Children (recipients, step log, notifications) ─────────────────

async function insertRecipientsTx(conn, txnId, recipients) {
  if (!Array.isArray(recipients) || !recipients.length) return 0;
  let inserted = 0;
  for (const r of recipients) {
    if (!r || (!r.username && !r.name && !r.positionId)) continue;
    const recId = _genId('RCP');
    await conn.query(
      `INSERT INTO txn_recipients
         (id, transaction_id, recipient_type, recipient_id, recipient_username,
          recipient_code, recipient_name, needs_response)
       VALUES (?,?,?,?,?,?,?,?)`,
      [recId, txnId, r.type || (r.positionId ? 'position' : 'user'),
       r.id || r.positionId || null, r.username || '',
       r.code || '', r.name || '', r.needsResponse ? 1 : 0]
    );
    inserted++;
  }
  return inserted;
}

async function insertStepLogTx(conn, txnId, params) {
  const logId = _genId('LOG');
  await conn.query(
    `INSERT INTO transaction_steps_log
       (id, transaction_id, workflow_definition_id, action_by, action_type, action_note, position_name)
     VALUES (?,?,?,?,?,?,?)`,
    [logId, txnId, params.workflowDefinitionId || null,
     params.actionBy || '', params.actionType || 'create',
     params.actionNote || '', params.positionName || '']
  );
  return logId;
}

// ─── Cascade delete (used by force-delete) ──────────────────────────

/**
 * Hard-delete a transaction + every child it owns, inside the caller's
 * transaction. Returns the snapshot used for audit logging.
 *
 * Tolerates missing tables — older deploys may not have every child.
 */
async function forceDeleteCascadeTx(conn, txnId) {
  const childTables = [
    'transaction_steps_log',
    'transaction_replies',
    'txn_attachments',
    'txn_recipients',
    'memo_read_receipts'
  ];
  for (const tbl of childTables) {
    try { await conn.query(`DELETE FROM ${tbl} WHERE transaction_id = ?`, [txnId]); }
    catch (_) { /* table may not exist on this deploy */ }
  }
  // Notifications that reference this txn — link_id+link_type, or related_id (legacy)
  try {
    await conn.query(
      `DELETE FROM notifications WHERE link_id = ? AND link_type = 'transaction'`,
      [txnId]
    );
  } catch (_) {
    try { await conn.query(`DELETE FROM notifications WHERE related_id = ?`, [txnId]); }
    catch (_) { /* schema variant */ }
  }
  // Detach payment_records (keep GL integrity — never delete payments)
  try {
    await conn.query(
      'UPDATE payment_records SET transaction_id = NULL WHERE transaction_id = ?',
      [txnId]
    );
  } catch (_) { /* table may not exist */ }
  // The transaction itself last
  await conn.query('DELETE FROM transactions WHERE id = ?', [txnId]);
}

// ─── Daily serial counter ───────────────────────────────────────────

/**
 * Atomically increments and returns the daily serial for a (branch, dept,
 * type, ymd) tuple. Uses `LAST_INSERT_ID(expr)` so increment+read happens
 * in one statement — no race window between two concurrent INSERTs.
 */
async function nextDailySerial(branchCode, deptCode, typeCode, ymd) {
  const key = [branchCode, deptCode, typeCode, ymd].join('|');
  await db.query(
    `INSERT INTO txn_daily_counter (counter_key, last_serial) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE last_serial = LAST_INSERT_ID(last_serial + 1)`,
    [key]
  );
  const [rows] = await db.query('SELECT LAST_INSERT_ID() AS id');
  const serial = rows && rows[0] && rows[0].id;
  if (!serial) {
    // First insert returns 0 from LAST_INSERT_ID — re-read
    const [r2] = await db.query(
      'SELECT last_serial FROM txn_daily_counter WHERE counter_key = ?',
      [key]
    );
    return r2.length ? r2[0].last_serial : 1;
  }
  return serial;
}

module.exports = {
  // Read
  findById,
  findByIdTx,
  findSnapshotById,
  // Write
  insertTx,
  updateOptionalFieldsTx,
  insertRecipientsTx,
  insertStepLogTx,
  // Delete
  forceDeleteCascadeTx,
  // Counters
  nextDailySerial,
  // Test seam
  _toDomain
};
