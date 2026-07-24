/**
 * routes/analytics/query.js — POST /api/analytics/query
 *
 * Body = the planner request contract (see lib/analytics/planner.js header).
 * Success → the QueryService envelope. Failure → a REAL HTTP error status:
 *   422 ANALYTICS_UNKNOWN_METRIC / ANALYTICS_UNKNOWN_DIMENSION /
 *       ANALYTICS_RANGE_TOO_WIDE / ANALYTICS_UNSUPPORTED_COMBINATION /
 *       VALIDATION_ERROR
 *   403 ANALYTICS_ALL_MASKED / PERMISSION_DENIED
 *   500 INTERNAL_ERROR (sanitized — no SQL, no table names, no stack)
 * NEVER res.json({success:false}) with a 200.
 *
 * Cancellation: when the client disconnects mid-query the route flips the
 * cancel flag and QueryService issues a best-effort KILL QUERY on the worker
 * connection's thread — a dashboard that navigated away stops burning the DB.
 */
'use strict';

const express = require('express');
const db = require('../../db/connection');
const QueryService = require('../../services/analytics/QueryService');

const router = express.Router();

const KNOWN_HTTP = new Set([400, 403, 404, 409, 422, 429]);

router.post('/', async (req, res) => {
  const cancelState = { cancelled: false, threadId: null };
  const onClose = () => {
    if (!res.writableEnded) {
      // fire-and-forget; killIfRunning never throws
      QueryService.killIfRunning(db, cancelState);
    }
  };
  req.on('close', onClose);

  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(422).json({ success: false, code: 'VALIDATION_ERROR', error: 'جسم الطلب يجب أن يكون JSON object' });
    }
    const envelope = await QueryService.run(db, req.body, req.analyticsScope, { cancelState });
    if (res.writableEnded) return; // client gone — nothing to write
    return res.json(envelope);
  } catch (e) {
    if (res.writableEnded) return;
    if (e && e.code === 'ANALYTICS_CANCELLED') return; // client disconnected
    if (e && e.code && KNOWN_HTTP.has(Number(e.http))) {
      return res.status(Number(e.http)).json({ success: false, code: e.code, error: e.message });
    }
    // internal — sanitized (correlation id + full detail server-side only)
    const correlationId = 'ANA-' + Math.random().toString(16).slice(2, 10);
    console.error(`[analytics/query][${correlationId}] internal error:`,
      e && (e.code || ''), e && e.message);
    if (e && e.stack) console.error(e.stack);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'تعذّر تنفيذ الاستعلام. أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول.',
      correlationId,
    });
  } finally {
    req.removeListener('close', onClose);
  }
});

module.exports = router;
