/**
 * ─── NotificationService ──────────────────────────────────────────
 *
 * In-app notification dispatch. Today this writes directly to the
 * `notifications` table — the same path the SSE endpoint polls every
 * 5 seconds (routes/sse.js). The interface is shaped so that Phase 6's
 * event_outbox + multi-channel dispatcher can replace the body without
 * touching callers.
 *
 * Methods:
 *   notify({ username, type, title, body, link, icon, severity })
 *   notifyTransactionAction({ txn, action, actor, target })
 *
 * Errors are logged but never thrown — notifications must not break
 * business operations. Use a structured event for monitoring.
 *
 * v6.8.0 — Phase 1
 */
'use strict';

const db = require('../db/connection');
const logger = require('../lib/logger').child({ module: 'notif' });

function _genId() {
  return 'NOT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * Insert a notification row. Caller must provide at least `username` +
 * `type` + `title`. All other fields are optional.
 *
 *   @param username  recipient
 *   @param type      free-form category (e.g. 'workflow.approved')
 *   @param title     short headline
 *   @param body      longer text (optional)
 *   @param linkType  deep-link target type (e.g. 'transaction')
 *   @param linkId    deep-link target id
 *   @param icon      FontAwesome icon name (optional)
 *   @param severity  'info' | 'warning' | 'error' (optional)
 */
async function notify(opts) {
  if (!opts || !opts.username || !opts.type) {
    logger.warn({ event: 'notify_skipped', reason: 'missing_fields' });
    return;
  }
  const id = _genId();
  try {
    await db.query(
      `INSERT INTO notifications
         (id, username, type, title, body, link_type, link_id, icon, severity, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
      [
        id,
        opts.username,
        opts.type,
        opts.title || '',
        opts.body || '',
        opts.linkType || null,
        opts.linkId || null,
        opts.icon || null,
        opts.severity || 'info'
      ]
    );
    logger.info({
      event: 'notify_emitted',
      id,
      username: opts.username,
      type: opts.type,
      linkType: opts.linkType,
      linkId: opts.linkId
    });
  } catch (e) {
    // Schema variants — some deployments lack severity, icon, body, etc.
    // Try a minimal insert before giving up.
    try {
      await db.query(
        `INSERT INTO notifications
           (id, username, type, title, link_type, link_id, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
        [id, opts.username, opts.type, opts.title || '', opts.linkType || null, opts.linkId || null]
      );
      logger.info({ event: 'notify_emitted_minimal', id, username: opts.username });
    } catch (e2) {
      logger.error({ event: 'notify_failed', error: e2.message, original: e.message });
    }
  }
  return id;
}

/**
 * Convenience: notify the recipient of a transaction action.
 *
 *   action: 'created' | 'forwarded' | 'returned' | 'approved' | 'rejected'
 */
async function notifyTransactionAction({ txn, action, actor, target }) {
  if (!txn || !action || !target) return;
  const titleMap = {
    created:   'معاملة جديدة بانتظارك',
    forwarded: 'تم تحويل معاملة إليك',
    returned:  'تم إرجاع معاملة إليك',
    approved:  'تم اعتماد معاملتك',
    rejected:  'تم رفض معاملتك'
  };
  const iconMap = {
    created:   'fa-paper-plane',
    forwarded: 'fa-share',
    returned:  'fa-rotate-left',
    approved:  'fa-circle-check',
    rejected:  'fa-circle-xmark'
  };
  const severityMap = {
    returned: 'warning',
    rejected: 'error'
  };
  await notify({
    username: target,
    type: 'workflow.' + action,
    title: titleMap[action] || ('إجراء على معاملة #' + (txn.txnNumber || txn.id)),
    body: (txn.subject || txn.title || '') + ' — ' + (actor || ''),
    linkType: 'transaction',
    linkId: txn.id,
    icon: iconMap[action] || 'fa-bell',
    severity: severityMap[action] || 'info'
  });
}

module.exports = {
  notify,
  notifyTransactionAction
};
