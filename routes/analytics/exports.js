/**
 * routes/analytics/exports.js — /api/analytics/exports
 *
 *   POST /              create an export job (queued; a worker executes it).
 *                       Body: { request, format, columns?:[{key,label}] } —
 *                       `columns` carries the caller's resolved (localized)
 *                       header labels; the registry only knows ids.
 *   GET  /              list MY jobs (all jobs for admin)
 *   GET  /:id           one job (owner-or-admin; foreign ids read as 404)
 *   GET  /:id/download  stream the finished file (ownership + caps re-check)
 *
 * Behind middleware/analyticsScope (mounted in ./index.js). Error contract
 * identical to query.js: coded 4xx from the service pass through, everything
 * else is a sanitized 500 — NEVER success:false with a 200.
 */
'use strict';

const express = require('express');
const db = require('../../db/connection');
const ExportService = require('../../services/analytics/ExportService');

const router = express.Router();

const KNOWN_HTTP = new Set([400, 403, 404, 409, 422, 429]);

function sendError(res, e, where) {
  if (e && e.code && KNOWN_HTTP.has(Number(e.http))) {
    return res.status(Number(e.http)).json({ success: false, code: e.code, error: e.message });
  }
  const correlationId = 'ANA-' + Math.random().toString(16).slice(2, 10);
  console.error(`[analytics/exports:${where}][${correlationId}] internal error:`,
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
    const body = req.body || {};
    const out = await ExportService.createJob(db, {
      user: req.user,
      scope: req.analyticsScope,
      request: body.request,
      format: body.format,
      // Optional [{key,label}] header labels — the service validates the shape.
      columns: body.columns,
      ip: req.ip,
    });
    return res.status(201).json({ success: true, data: out, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'create');
  }
});

router.get('/', async (req, res) => {
  try {
    const jobs = await ExportService.listJobs(db, {
      user: req.user,
      scope: req.analyticsScope,
      limit: req.query.limit,
    });
    return res.json({ success: true, data: jobs, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'list');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const job = await ExportService.getJob(db, {
      user: req.user,
      scope: req.analyticsScope,
      id: req.params.id,
    });
    if (!job) {
      return res.status(404).json({ success: false, code: 'EXPORT_NOT_FOUND', error: 'التصدير غير موجود' });
    }
    return res.json({ success: true, data: job, generatedAt: new Date().toISOString() });
  } catch (e) {
    return sendError(res, e, 'get');
  }
});

router.get('/:id/download', async (req, res) => {
  try {
    await ExportService.streamDownload(db, res, {
      user: req.user,
      scope: req.analyticsScope,
      id: req.params.id,
      ip: req.ip,
    });
  } catch (e) {
    if (res.headersSent) return; // the stream already started — nothing to map
    return sendError(res, e, 'download');
  }
});

module.exports = router;
