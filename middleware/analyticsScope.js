/**
 * middleware/analyticsScope.js — mounted at the head of /api/analytics,
 * AFTER the global JWT gate (req.user is set for every non-public /api path).
 *
 *   1. resolves the caller's analytics scope ONCE per request
 *      (lib/analytics/scope.js) and attaches it as req.analyticsScope;
 *   2. refuses callers without the base `analytics.view` capability with the
 *      canonical 403 PERMISSION_DENIED body (same shape as
 *      middleware/requireCapability.js);
 *   3. maps resolver faults to a REAL 500 — never a 200 with success:false,
 *      and never a guessed scope (too wide leaks, too narrow lies).
 */
'use strict';

const db = require('../db/connection');
const { resolveScope } = require('../lib/analytics/scope');

async function analyticsScope(req, res, next) {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    const scope = await resolveScope(db, req.user);
    if (!scope.caps.has('analytics.view')) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض التحليلات' });
    }
    req.analyticsScope = scope;
    next();
  } catch (e) {
    console.error('[analytics] scope resolution failed:', e && (e.code || ''), e && e.message);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'تعذّر تحميل نطاق الصلاحيات — أعد المحاولة',
    });
  }
}

module.exports = analyticsScope;
