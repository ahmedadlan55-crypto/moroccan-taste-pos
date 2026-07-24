/**
 * routes/analytics/schedules.js — /api/analytics/schedules
 *
 *   POST   /      create a report schedule (cap analytics.schedule)
 *   GET    /      list MY schedules (all for admin)
 *   PUT    /:id   update (owner-or-admin; next_run_at recomputed)
 *   DELETE /:id   remove (owner-or-admin)
 *
 * Behind middleware/analyticsScope (mounted in ./index.js); error contract
 * identical to query.js — coded 4xx pass through, the rest is a sanitized 500.
 */
'use strict';

const express = require('express');
const db = require('../../db/connection');
const ScheduleService = require('../../services/analytics/ScheduleService');

const router = express.Router();

const KNOWN_HTTP = new Set([400, 403, 404, 409, 422, 429]);

function sendError(res, e, where) {
  if (e && e.code && KNOWN_HTTP.has(Number(e.http))) {
    return res.status(Number(e.http)).json({ success: false, code: e.code, error: e.message });
  }
  const correlationId = 'ANA-' + Math.random().toString(16).slice(2, 10);
  console.error(`[analytics/schedules:${where}][${correlationId}] internal error:`,
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
    const out = await ScheduleService.create(db, {
      user: req.user,
      scope: req.analyticsScope,
      payload: req.body || {},
    });
    return res.status(201).json({ success: true, data: out, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'create');
  }
});

router.get('/', async (req, res) => {
  try {
    const rows = await ScheduleService.list(db, { user: req.user, scope: req.analyticsScope });
    return res.json({ success: true, data: rows, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'list');
  }
});

router.put('/:id', async (req, res) => {
  try {
    const out = await ScheduleService.update(db, {
      user: req.user,
      scope: req.analyticsScope,
      id: req.params.id,
      payload: req.body || {},
    });
    return res.json({ success: true, data: out, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'update');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const out = await ScheduleService.remove(db, {
      user: req.user,
      scope: req.analyticsScope,
      id: req.params.id,
    });
    return res.json({ success: true, data: out, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'remove');
  }
});

module.exports = router;
