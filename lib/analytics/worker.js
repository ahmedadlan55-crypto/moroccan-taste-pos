/**
 * lib/analytics/worker.js — background analytics worker (zatca-worker clone).
 *
 * Every tick (default 30s, ANALYTICS_WORKER_INTERVAL_MS override):
 *   1. RollupService.drainDirty  — rebuild rollups for queued (branch, day)
 *      pairs (analytics_rollup_dirty, filled by ProjectionService).
 *   2. RollupService.drainRepair — replay failed projections queued in
 *      analytics_projection_repair through ProjectionService.
 *   3. OPTIONAL sibling tasks, defensively: if services/analytics/
 *      ExportService.runPendingExports / ScheduleService.runDueSchedules
 *      exist they are called; their ABSENCE is silently fine (they are built
 *      concurrently by another workstream and may land after this file).
 *   4. Nightly hook — once per calendar day (analytics_rollup_state
 *      'last_nightly'): runs the anomaly rule scan (AnomalyService.scan) for
 *      yesterday+today across all branches, then the three-way reconciliation
 *      (ReconciliationService.threeWay, system scope) logging any day×branch
 *      drift. Each step is individually try/caught; the day-claim is written
 *      FIRST so a failing scan runs once per day, never every 30s all day.
 *
 * Safety properties (mirrors lib/zatca-worker.js):
 *   - kill-switch: ANALYTICS_DISABLE_WORKER=1 → start() is a no-op.
 *   - start() idempotent; first tick staggered 5s after boot.
 *   - setTimeout re-arm AFTER the tick finishes + an in-flight guard →
 *     ticks can never overlap, even if a tick outlives the interval.
 *   - every step individually try/caught — a failing step never skips the
 *     next step and never crashes the process.
 */
'use strict';

const db = require('../../db/connection');
const RollupService = require('../../services/analytics/RollupService');

const POLL_INTERVAL_MS = 30 * 1000;
const NIGHTLY_KEY = 'last_nightly';

// { module basename (services/analytics/…), exported fn called with (db) }
const OPTIONAL_TASKS = [
  { module: 'ExportService', fn: 'runPendingExports' },
  { module: 'ScheduleService', fn: 'runDueSchedules' },
];

let _started = false;
let _timer = null;
let _inFlight = false;

function _intervalMs() {
  const n = Number(process.env.ANALYTICS_WORKER_INTERVAL_MS);
  return Number.isFinite(n) && n >= 250 ? n : POLL_INTERVAL_MS;
}

/** Start the worker. Idempotent — safe to call multiple times. */
function start() {
  if (_started) return;
  if (process.env.ANALYTICS_DISABLE_WORKER === '1') {
    console.log('[analytics-worker] disabled via env');
    return;
  }
  _started = true;
  console.log('[analytics-worker] started, polling every ' + (_intervalMs() / 1000) + 's');
  // Stagger the first run by 5s so we don't race with server boot/migrations.
  _timer = setTimeout(_tick, 5000);
}

function stop() {
  _started = false;
  if (_timer) clearTimeout(_timer);
  _timer = null;
}

async function _tick() {
  if (!_started) return;
  if (_inFlight) {
    // Never overlap ticks — re-check after one interval.
    _timer = setTimeout(_tick, _intervalMs());
    return;
  }
  _inFlight = true;
  try {
    await runOnce();
  } finally {
    _inFlight = false;
    if (_started) _timer = setTimeout(_tick, _intervalMs());
  }
}

/** One full tick body — exported so tests can drive the worker without the
 *  timer. Every step is individually caught; this function never throws. */
async function runOnce() {
  // 1. rollup dirty queue
  try {
    const r = await RollupService.drainDirty(db, {});
    if (r.claimed) {
      console.log('[analytics-worker] rollup drain: claimed=' + r.claimed +
        ' rebuilt=' + r.rebuilt + ' failed=' + r.failed + ' mode=' + r.mode);
    }
  } catch (e) {
    console.warn('[analytics-worker] drainDirty error:', e && e.message);
  }

  // 2. projection repair queue
  try {
    const r = await RollupService.drainRepair(db, {});
    if (r.scanned) {
      console.log('[analytics-worker] repair drain: scanned=' + r.scanned +
        ' healed=' + r.healed + ' failed=' + r.failed + ' unknown=' + r.unknown);
    }
  } catch (e) {
    console.warn('[analytics-worker] drainRepair error:', e && e.message);
  }

  // 3. optional sibling services (may not exist yet — that is fine)
  await _runOptionalTasks();

  // 4. nightly placeholder hook
  try {
    await _nightly();
  } catch (e) {
    console.warn('[analytics-worker] nightly hook error:', e && e.message);
  }
}

async function _runOptionalTasks() {
  for (const t of OPTIONAL_TASKS) {
    let mod = null;
    try {
      mod = require('../../services/analytics/' + t.module);
    } catch (e) {
      // Module absent → silently fine (built concurrently). Anything else
      // (e.g. a syntax error in a half-landed file) is worth one warn line.
      if (!e || e.code !== 'MODULE_NOT_FOUND') {
        console.warn('[analytics-worker] optional ' + t.module + ' failed to load:',
          e && e.message);
      }
      continue;
    }
    if (!mod || typeof mod[t.fn] !== 'function') continue; // fn not there yet
    try {
      await mod[t.fn](db);
    } catch (e) {
      console.warn('[analytics-worker] ' + t.module + '.' + t.fn + ' error:',
        e && e.message);
    }
  }
}

function _localDayString(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/** Once per calendar day (server-local): anomaly scan + reconciliation drift
 *  log for yesterday+today. Tracked in analytics_rollup_state so a restart
 *  mid-day does not re-run it. The day-claim is written BEFORE the scans —
 *  a failing scan is a once-a-day failure (logged), not a 30s retry storm.
 *  Services are required lazily + defensively, matching _runOptionalTasks. */
async function _nightly() {
  const now = new Date();
  const today = _localDayString(now);
  const [rows] = await db.query(
    'SELECT v FROM analytics_rollup_state WHERE k = ? LIMIT 1', [NIGHTLY_KEY]);
  const last = rows.length && rows[0].v != null ? String(rows[0].v) : '';
  if (last === today) return;
  await db.query(
    `INSERT INTO analytics_rollup_state (k, v) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v)`, [NIGHTLY_KEY, today]);

  const yesterday = _localDayString(new Date(now.getTime() - 86400000));

  // 1. anomaly rule scan — yesterday+today, all branches (derived from facts).
  try {
    const AnomalyService = require('../../services/analytics/AnomalyService');
    const r = await AnomalyService.scan(db, { from: yesterday, to: today });
    console.log('[analytics-worker] nightly anomaly scan ' + yesterday + '..' + today +
      ': created=' + r.created + ' refreshed=' + r.refreshed +
      ' byRule=' + JSON.stringify(r.byRule));
  } catch (e) {
    console.warn('[analytics-worker] nightly anomaly scan error:', e && e.message);
  }

  // 2. reconciliation drift log — system scope (the worker is not a user).
  try {
    const ReconciliationService = require('../../services/analytics/ReconciliationService');
    const scope = {
      all: true, brandIds: [], branchIds: [],
      caps: new Set(['analytics.reconciliation.view']),
    };
    const rec = await ReconciliationService.threeWay(db, { scope, from: yesterday, to: today });
    const drifted = rec.rows.filter((row) =>
      Math.abs(Number(row.deltas.salesVsPayments) || 0) > 0.01 ||
      Math.abs(Number(row.deltas.cashExpectedVsCounted) || 0) > 0.01 ||
      row.exceptions.paymentsWithoutOrder.count > 0 ||
      row.exceptions.ordersWithoutPayment.count > 0);
    if (drifted.length) {
      console.warn('[analytics-worker] nightly reconciliation: ' + drifted.length +
        ' day×branch cell(s) with drift/exceptions');
      for (const row of drifted.slice(0, 10)) {
        console.warn('[analytics-worker]   ' + row.business_day + ' ' + row.branch_id +
          ' salesVsPayments=' + row.deltas.salesVsPayments +
          ' cashExpectedVsCounted=' + row.deltas.cashExpectedVsCounted +
          ' paymentsWithoutOrder=' + row.exceptions.paymentsWithoutOrder.count +
          ' ordersWithoutPayment=' + row.exceptions.ordersWithoutPayment.count);
      }
      if (drifted.length > 10) {
        console.warn('[analytics-worker]   … +' + (drifted.length - 10) + ' more');
      }
    } else {
      console.log('[analytics-worker] nightly reconciliation clean for ' +
        yesterday + '..' + today);
    }
  } catch (e) {
    console.warn('[analytics-worker] nightly reconciliation error:', e && e.message);
  }

  console.log('[analytics-worker] nightly hook ran for ' + today);
}

module.exports = { start, stop, runOnce };
