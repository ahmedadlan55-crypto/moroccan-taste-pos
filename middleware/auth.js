/**
 * middleware/auth.js
 *
 * Central authentication & authorization middleware.
 *
 * Exports:
 *   - default export : verifyToken  — JWT bearer-token guard
 *   - named export   : requireRole  — RBAC role guard (use AFTER verifyToken)
 *
 * Usage:
 *   const { requireRole } = require('../middleware/auth');
 *   const MGR       = requireRole('admin', 'manager');
 *   const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');
 *
 *   router.post('/x/:id/approve', MGR, handler);
 */

'use strict';

const jwt = require('jsonwebtoken');

/**
 * verifyToken — Express middleware that validates a JWT Bearer token.
 * On success it attaches the decoded payload to req.user:
 *   { id, username, role, iat, exp }
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, username, role, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}

/**
 * requireRole — Role-based authorization guard.
 *
 * Use as route middleware AFTER the request is authenticated (the global /api
 * gate in server.js already sets req.user for erp/inventory/sales routes;
 * menu mutations chain verifyToken first).
 *
 * An empty / unknown role normalizes to the least-privileged 'cashier' so a
 * legacy row with NULL role can never pass a privileged gate (fail closed).
 *
 * @param  {...string} allowed  One or more role names that are permitted.
 * @returns {Function}          Express middleware function.
 *
 * @example
 *   router.post('/x/:id/approve', requireRole('admin', 'manager'), handler);
 */
function requireRole(...allowed) {
  const allow = allowed.flat().map(r => String(r).toLowerCase());
  return function (req, res, next) {
    let role = String((req.user && req.user.role) || '').toLowerCase();
    if (!role) role = 'cashier';
    if (allow.indexOf(role) === -1) {
      return res.status(403).json({
        success: false,
        error: 'هذه العملية تتطلب صلاحية أعلى (مدير/مسؤول).',
        code: 'forbidden_role'
      });
    }
    next();
  };
}

module.exports = verifyToken;
module.exports.requireRole = requireRole;
