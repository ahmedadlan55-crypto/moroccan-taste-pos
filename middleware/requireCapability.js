/**
 * middleware/requireCapability.js — fine-grained capability guard for the
 * /api/procurement module. Runs AFTER verifyToken (req.user set).
 *
 * Effective permission = role_permissions ∪ {override:grant} \ {override:revoke}
 * — the exact model computed in routes/auth.js. admin (and developer) bypass.
 *
 * Fails closed: any DB error or missing grant → generic 403 with the canonical
 * PERMISSION_DENIED code (never leaks which capability/document exists).
 */
'use strict';

const db = require('../db/connection');

function _isAdmin(user) {
  const role = String((user && user.role) || '').toLowerCase();
  return role === 'admin' || !!(user && (user.isDeveloper === true || user.isDeveloper === 1));
}

async function hasCapability(user, capId) {
  if (!user || !user.username) return false;
  if (_isAdmin(user)) return true;
  const role = String(user.role || 'employee').toLowerCase();
  const [rows] = await db.query(
    `SELECT (rp.permission_id IS NOT NULL) AS by_role, upo.grant_type AS override_type
       FROM permissions_v3 p
       LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role = ?
       LEFT JOIN user_permission_overrides upo ON upo.permission_id = p.id AND upo.username = ?
      WHERE p.id = ? LIMIT 1`,
    [role, user.username, capId]
  );
  if (!rows.length) return false;
  const r = rows[0];
  const byRole = !!Number(r.by_role);
  const override = r.override_type || null;
  return (byRole && override !== 'revoke') || override === 'grant';
}

function requireCapability(capId) {
  return async function (req, res, next) {
    try {
      if (!req.user || !req.user.username) {
        return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
      }
      const ok = await hasCapability(req.user, capId);
      if (!ok) {
        return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لهذه العملية' });
      }
      next();
    } catch (e) {
      // fail closed
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لهذه العملية' });
    }
  };
}

module.exports = requireCapability;
module.exports.hasCapability = hasCapability;
