/**
 * routes/analytics/anomalies.js — POST /api/analytics/anomaly-scan
 *
 * Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', branchIds?: string[] }
 * Runs the anomaly rule catalog over the window and upserts anomaly_alerts
 * (dedupe-keyed — see services/analytics/AnomalyService). Response:
 * { created, refreshed, byRule }.
 *
 * Capability analytics.anomaly.manage is enforced HERE (the service's scan()
 * signature is scope-free — the worker calls it as system). Branch set is
 * clamped to the caller's scope for non-admin callers: an explicit
 * out-of-scope branch is silently dropped; no branchIds means "my branches"
 * (fail-closed — a zero-grant caller scans nothing).
 *
 * Behind middleware/analyticsScope (mounted in ./index.js). Error contract
 * identical to query.js.
 */
'use strict';

const express = require('express');
const db = require('../../db/connection');
const AnomalyService = require('../../services/analytics/AnomalyService');

const router = express.Router();

const KNOWN_HTTP = new Set([400, 403, 404, 409, 422, 429]);

function sendError(res, e, where) {
  if (e && e.code && KNOWN_HTTP.has(Number(e.http))) {
    return res.status(Number(e.http)).json({ success: false, code: e.code, error: e.message });
  }
  const correlationId = 'ANA-' + Math.random().toString(16).slice(2, 10);
  console.error(`[analytics/anomaly-scan:${where}][${correlationId}] internal error:`,
    e && (e.code || ''), e && e.message);
  if (e && e.stack) console.error(e.stack);
  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'تعذّر تنفيذ العملية. أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول.',
    correlationId,
  });
}

router.post('/', async (req, res) => {
  try {
    const scope = req.analyticsScope;
    if (!scope || !scope.caps || !scope.caps.has('analytics.anomaly.manage')) {
      return res.status(403).json({
        success: false, code: 'PERMISSION_DENIED',
        error: 'صلاحية غير كافية لتشغيل فحص الشذوذ (analytics.anomaly.manage)',
      });
    }
    const body = req.body || {};
    let branchIds = Array.isArray(body.branchIds)
      ? [...new Set(body.branchIds.map(String).filter(Boolean))] : [];
    if (!scope.all) {
      const allowed = new Set((scope.branchIds || []).map(String));
      branchIds = branchIds.length
        ? branchIds.filter((b) => allowed.has(b))
        : [...allowed];
      if (!branchIds.length) {
        // fail-closed: nothing in scope → nothing scanned, never an error
        return res.json({
          success: true,
          data: { created: 0, refreshed: 0, byRule: {} },
          generatedAt: new Date().toISOString(),
        });
      }
    }
    const data = await AnomalyService.scan(db, {
      from: body.from,
      to: body.to,
      branchIds: branchIds.length ? branchIds : undefined,
    });
    return res.json({ success: true, data, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'scan');
  }
});

module.exports = router;
