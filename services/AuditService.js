/**
 * ─── AuditService ─────────────────────────────────────────────────
 *
 * Thin wrapper around lib/auditLogger.js with a cleaner API + named
 * convenience methods for the most common audit events emitted by the
 * transaction subsystem. Services should ALWAYS go through here rather
 * than calling `lib/auditLogger` directly — that gives us one place to
 * add fields (device_fingerprint, trace_id, etc.) when Phase 5 lands.
 *
 * Two backing tables exist today:
 *   - audit_logs (legacy, no hash chain)   ← logAudit()
 *   - audit_log  (v6.2.0 with hash chain)  ← appendAuditEntry()
 *
 * Until Phase 5 consolidates them, this service exposes both:
 *   - record(...)       — writes the legacy audit_logs row
 *   - appendChain(conn) — writes a hash-chained audit_log row
 *
 * v6.8.0 — Phase 1
 */
'use strict';

const auditLogger = require('../lib/auditLogger');
const logger = require('../lib/logger').child({ module: 'audit' });

/**
 * Record an audit event in the legacy audit_logs table. Never throws
 * (the underlying logAudit silently swallows DB errors — auditing must
 * not break business operations). Returns a Promise that resolves when
 * the row is persisted.
 *
 * @param {object} evt
 *   - action       (string) e.g. 'create', 'force_delete', 'approve'
 *   - resourceType (string) e.g. 'transaction'
 *   - resourceId   (string)
 *   - actor        (string) username
 *   - details      (object) serialized to JSON
 *   - ip           (string|optional)
 */
async function record(evt) {
  if (!evt || !evt.action) {
    logger.warn({ event: 'audit_skipped', reason: 'missing_action' });
    return;
  }
  try {
    await auditLogger.logAudit(
      evt.action,
      evt.resourceType || 'unknown',
      evt.resourceId || '',
      evt.actor || 'system',
      evt.details || {},
      evt.ip || ''
    );
  } catch (e) {
    logger.error({ event: 'audit_record_failed', error: e.message });
  }
}

/**
 * Append a tamper-evident audit_log row inside the caller's DB
 * transaction. Use this for events that MUST be durable in the same
 * commit as the business change (e.g., force-delete + audit row must
 * land together or neither).
 *
 * @param {object} conn — DB transaction handle from db.withTransaction
 * @param {object} entry — see auditLogger.appendAuditEntry signature
 */
async function appendChain(conn, entry) {
  try {
    return await auditLogger.appendAuditEntry(conn, entry);
  } catch (e) {
    logger.error({ event: 'audit_chain_failed', error: e.message });
    // Surface to caller — chain integrity matters
    throw e;
  }
}

/**
 * Convenience: emit a force-delete audit row in the standard shape used
 * by the workflow module. Writes to audit_logs (legacy) — Phase 5 will
 * migrate to the hash chain.
 */
async function recordForceDelete({ txnId, snapshot, actor, reason, ip }) {
  await record({
    action: 'force_delete',
    resourceType: 'transaction',
    resourceId: txnId,
    actor: actor || 'system',
    details: {
      txnNumber: snapshot ? snapshot.txnNumber : null,
      title: snapshot ? (snapshot.subject || snapshot.title) : null,
      createdBy: snapshot ? snapshot.createdBy : null,
      amount: snapshot ? Number(snapshot.amount) || 0 : 0,
      reason: String(reason || '').trim()
    },
    ip: ip || ''
  });
}

/**
 * Convenience: emit a create audit row.
 */
async function recordCreate({ txnId, txnNumber, actor, payload, ip }) {
  await record({
    action: 'create',
    resourceType: 'transaction',
    resourceId: txnId,
    actor: actor || 'system',
    details: {
      txnNumber,
      typeId: payload ? payload.transactionTypeId : null,
      title: payload ? payload.title : null,
      amount: payload ? Number(payload.amount) || 0 : 0
    },
    ip: ip || ''
  });
}

module.exports = {
  record,
  appendChain,
  recordForceDelete,
  recordCreate
};
