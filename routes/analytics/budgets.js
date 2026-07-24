/**
 * routes/analytics/budgets.js — /api/analytics/budgets
 *
 *   GET /   list budget rows, branch-scope-clamped
 *           (?branchIds=a,b&from=YYYY-MM&to=YYYY-MM&metric=...)
 *   PUT /   bulk upsert { lines: [...] } (cap analytics.budget.manage;
 *           every line's branch must be inside the caller's scope)
 *
 * Behind middleware/analyticsScope (mounted in ./index.js); error contract
 * identical to query.js — coded 4xx pass through, the rest is a sanitized 500.
 */
'use strict';

const express = require('express');
const db = require('../../db/connection');
const BudgetService = require('../../services/analytics/BudgetService');

const router = express.Router();

const KNOWN_HTTP = new Set([400, 403, 404, 409, 422, 429]);

function sendError(res, e, where) {
  if (e && e.code && KNOWN_HTTP.has(Number(e.http))) {
    return res.status(Number(e.http)).json({ success: false, code: e.code, error: e.message });
  }
  const correlationId = 'ANA-' + Math.random().toString(16).slice(2, 10);
  console.error(`[analytics/budgets:${where}][${correlationId}] internal error:`,
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
    const filters = {};
    if (req.query.branchIds) filters.branchIds = String(req.query.branchIds).split(',').filter(Boolean);
    if (req.query.from) filters.from = String(req.query.from);
    if (req.query.to) filters.to = String(req.query.to);
    if (req.query.metric) filters.metric = String(req.query.metric);
    const rows = await BudgetService.list(db, { scope: req.analyticsScope, filters });
    return res.json({ success: true, data: rows, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'list');
  }
});

router.put('/', async (req, res) => {
  try {
    const body = req.body || {};
    const out = await BudgetService.upsertLines(db, {
      user: req.user,
      scope: req.analyticsScope,
      lines: body.lines,
    });
    return res.json({ success: true, data: out, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'upsert');
  }
});

module.exports = router;
