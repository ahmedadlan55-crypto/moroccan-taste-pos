/**
 * routes/analytics/reconciliation.js — GET /api/analytics/reconciliation
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD[&branchIds=a,b]
 * Three-way (sales / payments / till) daily reconciliation — see
 * services/analytics/ReconciliationService for the row contract.
 *
 * Behind middleware/analyticsScope (mounted in ./index.js). The
 * analytics.reconciliation.view capability is enforced by the service (403);
 * branch clamping too. Error contract identical to query.js: coded 4xx pass
 * through, everything else is a sanitized 500 — NEVER success:false with 200.
 */
'use strict';

const express = require('express');
const db = require('../../db/connection');
const ReconciliationService = require('../../services/analytics/ReconciliationService');

const router = express.Router();

const KNOWN_HTTP = new Set([400, 403, 404, 409, 422, 429]);

function sendError(res, e, where) {
  if (e && e.code && KNOWN_HTTP.has(Number(e.http))) {
    return res.status(Number(e.http)).json({ success: false, code: e.code, error: e.message });
  }
  const correlationId = 'ANA-' + Math.random().toString(16).slice(2, 10);
  console.error(`[analytics/reconciliation:${where}][${correlationId}] internal error:`,
    e && (e.code || ''), e && e.message);
  if (e && e.stack) console.error(e.stack);
  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'تعذّر تنفيذ العملية. أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول.',
    correlationId,
  });
}

router.get('/', async (req, res) => {
  try {
    const branchIds = req.query.branchIds
      ? String(req.query.branchIds).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const data = await ReconciliationService.threeWay(db, {
      scope: req.analyticsScope,
      from: req.query.from,
      to: req.query.to,
      branchIds,
    });
    return res.json({ success: true, data, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'threeWay');
  }
});

module.exports = router;
