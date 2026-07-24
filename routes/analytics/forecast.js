/**
 * routes/analytics/forecast.js — GET /api/analytics/forecast
 *
 * Query: ?branchId=…[&weekday=0..6][&metric=net_ex_vat|orders|guests]
 * Per-slot30 hourly forecast from the trailing 8 full weeks of
 * analytics_hourly_branch — see services/analytics/ForecastService for the
 * suppression rules (never fabricates; insufficient history is said so).
 *
 * Behind middleware/analyticsScope (mounted in ./index.js) — analytics.view
 * is the gate; the SERVICE additionally 403s a branch outside the caller's
 * scope. Error contract identical to query.js.
 */
'use strict';

const express = require('express');
const db = require('../../db/connection');
const ForecastService = require('../../services/analytics/ForecastService');

const router = express.Router();

const KNOWN_HTTP = new Set([400, 403, 404, 409, 422, 429]);

function sendError(res, e, where) {
  if (e && e.code && KNOWN_HTTP.has(Number(e.http))) {
    return res.status(Number(e.http)).json({ success: false, code: e.code, error: e.message });
  }
  const correlationId = 'ANA-' + Math.random().toString(16).slice(2, 10);
  console.error(`[analytics/forecast:${where}][${correlationId}] internal error:`,
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
    const data = await ForecastService.hourly(db, {
      scope: req.analyticsScope,
      branchId: req.query.branchId,
      weekday: req.query.weekday,
      metric: req.query.metric,
    });
    return res.json({ success: true, data, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'hourly');
  }
});

module.exports = router;
