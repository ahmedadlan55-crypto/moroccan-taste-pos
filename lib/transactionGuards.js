/**
 * V4 — Transaction Access Guards
 * Express middleware that gate-keeps transaction-specific routes.
 * Validates the user has a legitimate reason to read/write the txn id
 * BEFORE the route handler runs — eliminates per-handler boilerplate
 * + closes accidental info-leak gaps.
 */

'use strict';

const db = require('../db/connection');

/**
 * Loads txn into req.txn (404 if missing) AND validates that the current
 * user has at least VIEW access. Use as middleware before any route that
 * exposes data about a specific transaction.
 *
 * Usage:
 *   router.get('/transactions/:id/foo', guardTxnAccess, async (req, res) => {
 *     // req.txn is the loaded row
 *     // already validated user can view
 *   });
 */
async function guardTxnAccess(req, res, next) {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'transaction id required' });

    const username = (req.user && req.user.username) || req.query.username || (req.body && req.body.username);
    if (!username) return res.status(401).json({ success: false, error: 'unauthenticated' });

    // Load txn + recipients in parallel
    const [[txnRows], [recipientRows], [userRows]] = await Promise.all([
      db.query('SELECT * FROM transactions WHERE id = ?', [id]),
      db.query('SELECT recipient_username FROM txn_recipients WHERE transaction_id = ?', [id]),
      db.query('SELECT role FROM users WHERE username = ? LIMIT 1', [username])
    ]);

    if (!txnRows.length) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }
    const txn = txnRows[0];
    const recipientUsernames = recipientRows.map(r => r.recipient_username);
    const userRole = (userRows[0] || {}).role || 'employee';
    const isAdmin = userRole === 'admin' || username === 'admin';

    // Visibility rule (server-side gate — cannot be bypassed by frontend)
    const canView =
      isAdmin ||
      txn.created_by === username ||
      txn.current_assignee === username ||
      txn.recipient_username === username ||
      recipientUsernames.includes(username);

    if (!canView) {
      // Audit the denial (helps spot probing attempts)
      try {
        await db.query(
          `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, ip_address)
           VALUES (?, 'access_denied', 'transaction', ?, ?, ?)`,
          [username, id, JSON.stringify({ method: req.method, path: req.path }), req.ip || '']);
      } catch(_) {}
      return res.status(403).json({ success: false, error: 'لا تملك صلاحية الوصول لهذه المعاملة' });
    }

    // Stash for the handler
    req.txn = txn;
    req.txnRecipients = recipientUsernames;
    req.txnUserRole = userRole;
    req.txnIsAdmin = isAdmin;
    next();
  } catch (e) {
    console.error('[guardTxnAccess]', e);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * Stricter guard: requires the user to be either admin OR creator/assignee.
 * Blocks "incidental viewers" (recipients) from sensitive ops like edit/delete.
 */
async function guardTxnOwnership(req, res, next) {
  return guardTxnAccess(req, res, function(err) {
    if (err) return next(err);
    const { txn, txnIsAdmin } = req;
    const username = (req.user && req.user.username) || req.query.username || (req.body && req.body.username);
    if (!txnIsAdmin && txn.created_by !== username && txn.current_assignee !== username) {
      return res.status(403).json({ success: false, error: 'هذه العملية للمنشئ أو المسؤول الحالي فقط' });
    }
    next();
  });
}

/**
 * Developer-only guard. Used by force-delete + diagnostic endpoints.
 */
async function guardDeveloper(req, res, next) {
  try {
    const username = (req.user && req.user.username) || req.query.username || (req.body && req.body.username);
    if (!username) return res.status(401).json({ success: false, error: 'unauthenticated' });

    // V5.4.3: trust the JWT payload first — if isDeveloper claim is set, allow.
    if (req.user && req.user.isDeveloper) { req.isDeveloper = true; return next(); }

    if (username === 'admin') { req.isDeveloper = true; return next(); }

    // Check is_developer column on users table (newer schema)
    try {
      const [u] = await db.query('SELECT is_developer, role FROM users WHERE username = ? LIMIT 1', [username]);
      if (u.length && (u[0].is_developer || u[0].role === 'developer')) {
        req.isDeveloper = true;
        return next();
      }
    } catch(_) {}

    // Fallback: settings.user_meta JSON
    try {
      const [m] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
      if (m.length && m[0].setting_value) {
        const meta = JSON.parse(m[0].setting_value) || {};
        if (meta[username] && meta[username].isDeveloper) {
          req.isDeveloper = true;
          return next();
        }
      }
    } catch(_) {}

    res.status(403).json({ success: false, error: 'هذه العملية للمطور فقط — لا تملك صلاحية الحذف' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

module.exports = {
  guardTxnAccess,
  guardTxnOwnership,
  guardDeveloper
};
