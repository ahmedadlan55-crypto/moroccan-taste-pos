/**
 * V4 — Lightweight metrics endpoint (Prometheus-style + JSON)
 * Exposes operational metrics without external monitoring infrastructure.
 *
 *   GET /api/metrics           → Prometheus text format (scrapable)
 *   GET /api/metrics/json      → JSON for dashboards
 *   GET /api/metrics/health    → liveness probe
 */

'use strict';

const router = require('express').Router();
const db = require('../db/connection');
const os = require('os');

const _bootedAt = Date.now();

// Counters (in-memory; reset on restart — for serious use, persist or use Prom client)
const _requestCounters = {
  total: 0,
  byStatus: { '2xx': 0, '4xx': 0, '5xx': 0 },
  byMethod: { GET: 0, POST: 0, PUT: 0, DELETE: 0 }
};

// Hook to track all requests (mounted by server.js as middleware on /api/)
function trackRequest(req, res, next) {
  _requestCounters.total++;
  if (_requestCounters.byMethod[req.method] !== undefined) _requestCounters.byMethod[req.method]++;
  res.on('finish', function() {
    const tier = res.statusCode < 300 ? '2xx' : res.statusCode < 500 ? '4xx' : '5xx';
    if (_requestCounters.byStatus[tier] !== undefined) _requestCounters.byStatus[tier]++;
  });
  next();
}

async function _collectDbMetrics() {
  const out = {};
  try {
    const [t] = await db.query("SELECT COUNT(*) AS c FROM transactions");
    out.transactions_total = Number(t[0].c) || 0;
  } catch(e) {}
  try {
    const [byStatus] = await db.query(
      "SELECT status, COUNT(*) AS c FROM transactions GROUP BY status");
    out.transactions_by_status = byStatus.reduce((a, r) => { a[r.status] = Number(r.c); return a; }, {});
  } catch(e) {}
  try {
    const [overdue] = await db.query(`
      SELECT COUNT(*) AS c FROM transactions
       WHERE due_date IS NOT NULL AND due_date < NOW()
         AND status IN ('pending','created','in_progress','replied')`);
    out.transactions_overdue = Number(overdue[0].c) || 0;
  } catch(e) {}
  try {
    const [users] = await db.query("SELECT COUNT(*) AS c FROM users");
    out.users_total = Number(users[0].c) || 0;
  } catch(e) {}
  try {
    const [notif] = await db.query("SELECT COUNT(*) AS c FROM notifications WHERE is_read = 0");
    out.notifications_unread_total = Number(notif[0].c) || 0;
  } catch(e) {}
  try {
    // Active workflow connections (pool stats)
    const pool = db.pool || db;
    if (pool && pool._allConnections) {
      out.db_pool_total = pool._allConnections.length || 0;
      out.db_pool_free = (pool._freeConnections && pool._freeConnections.length) || 0;
    }
  } catch(e) {}
  return out;
}

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - _bootedAt) / 1000),
    pid: process.pid,
    node_version: process.version
  });
});

router.get('/json', async (req, res) => {
  const dbMetrics = await _collectDbMetrics();
  res.json({
    process: {
      uptime_seconds: Math.floor((Date.now() - _bootedAt) / 1000),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      pid: process.pid,
      node_version: process.version
    },
    system: {
      load_avg: os.loadavg(),
      free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
      total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
      cpu_count: os.cpus().length
    },
    requests: _requestCounters,
    database: dbMetrics
  });
});

router.get('/', async (req, res) => {
  const m = await _collectDbMetrics();
  const lines = [];
  // Process metrics
  lines.push('# HELP process_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE process_uptime_seconds counter');
  lines.push(`process_uptime_seconds ${Math.floor((Date.now() - _bootedAt) / 1000)}`);
  lines.push('# HELP process_memory_rss_mb Resident memory in MB');
  lines.push('# TYPE process_memory_rss_mb gauge');
  lines.push(`process_memory_rss_mb ${Math.round(process.memoryUsage().rss / 1024 / 1024)}`);
  // Request counters
  lines.push('# HELP http_requests_total Total HTTP requests served');
  lines.push('# TYPE http_requests_total counter');
  lines.push(`http_requests_total ${_requestCounters.total}`);
  for (const [code, n] of Object.entries(_requestCounters.byStatus)) {
    lines.push(`http_responses_total{tier="${code}"} ${n}`);
  }
  for (const [meth, n] of Object.entries(_requestCounters.byMethod)) {
    lines.push(`http_requests_by_method_total{method="${meth}"} ${n}`);
  }
  // DB metrics
  lines.push('# HELP transactions_total Total transactions in DB');
  lines.push('# TYPE transactions_total gauge');
  lines.push(`transactions_total ${m.transactions_total || 0}`);
  for (const [s, n] of Object.entries(m.transactions_by_status || {})) {
    lines.push(`transactions_by_status{status="${s}"} ${n}`);
  }
  lines.push('# HELP transactions_overdue Number of overdue transactions');
  lines.push('# TYPE transactions_overdue gauge');
  lines.push(`transactions_overdue ${m.transactions_overdue || 0}`);
  lines.push('# HELP users_total Total users');
  lines.push(`users_total ${m.users_total || 0}`);
  lines.push('# HELP notifications_unread_total Unread notifications across all users');
  lines.push(`notifications_unread_total ${m.notifications_unread_total || 0}`);
  if (m.db_pool_total !== undefined) {
    lines.push('# HELP db_pool_total DB pool connection count');
    lines.push(`db_pool_total ${m.db_pool_total}`);
    lines.push(`db_pool_free ${m.db_pool_free}`);
  }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(lines.join('\n') + '\n');
});

router._trackRequest = trackRequest;

module.exports = router;
