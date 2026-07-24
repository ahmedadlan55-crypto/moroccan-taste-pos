/**
 * routes/analytics/metadata.js — GET /api/analytics/metadata
 *
 * The registry, filtered to what THIS caller may see (capability-masked
 * metrics/dimensions are omitted entirely — the UI builds its picker from
 * this and must not render what the caller can't query), plus:
 *   dateBases    — the canonical basis list the planner accepts.
 *   mealPeriods  — the GLOBAL analytics_meal_periods rows (v1 ignores branch
 *                  overrides — same limitation as the planner, kept honest).
 *   freshness    — lib/analytics/freshness (live watermark).
 *   availableFrom — for modifier-fact metrics only: the earliest LIVE
 *                  business day in analytics_order_facts. Modifier facts
 *                  (combo choices, price deltas) exist only for live-projected
 *                  sales — the backfill can't reconstruct them — so any
 *                  earlier date would silently under-report. Honest floor,
 *                  simple query, null when nothing live exists yet.
 */
'use strict';

const express = require('express');
const db = require('../../db/connection');
const { FACTS } = require('../../lib/analytics/registry/facts');
const DIMS = require('../../lib/analytics/registry/dimensions');
const METRICS = require('../../lib/analytics/registry/metrics');
const planner = require('../../lib/analytics/planner');
const freshness = require('../../lib/analytics/freshness');

const router = express.Router();

/** Metric ids whose facts only exist for live-projected documents. */
function isLiveOnlyMetric(m) {
  if (m.kind === 'additive') return m.fact === 'modifier';
  return (m.inputs || []).some((id) => {
    const im = METRICS.byId[id];
    return im && im.kind === 'additive' && im.fact === 'modifier';
  });
}

router.get('/', async (req, res) => {
  try {
    const caps = req.analyticsScope.caps;

    // earliest live business day — one small indexed query
    let liveFrom = null;
    try {
      const [r] = await db.query(
        "SELECT MIN(business_day) AS d FROM analytics_order_facts WHERE provenance = 'live'");
      if (r.length && r[0].d != null) {
        const v = r[0].d;
        liveFrom = v instanceof Date
          ? new Date(v.getTime() + 3 * 3600000).toISOString().slice(0, 10)
          : String(v).slice(0, 10);
      }
    } catch (_) { /* facts table absent — availableFrom stays null */ }

    const metrics = METRICS.METRICS
      .filter((m) => !m.requiresCap || caps.has(m.requiresCap))
      .map((m) => {
        const out = {
          id: m.id,
          kind: m.kind,
          fact: m.kind === 'additive' ? m.fact : null,
          format: m.format,
          equationKey: m.equationKey,
          version: m.version,
        };
        if (m.requiresCap) out.requiresCap = m.requiresCap;
        if (m.takesMetricParam) out.takesMetricParam = true;
        if (isLiveOnlyMetric(m)) out.availableFrom = liveFrom;
        return out;
      });

    const dimensions = DIMS.DIMENSIONS
      .filter((d) => !d.requiresCap || caps.has(d.requiresCap))
      .map((d) => {
        const out = {
          id: d.id,
          kind: d.kind,
          ops: d.ops,
          groupable: !!d.groupable,
          facts: Object.keys(d.facts || {}),
        };
        if (d.requiresCap) out.requiresCap = d.requiresCap;
        if (d.label) out.hasLabels = true;
        return out;
      });

    let mealPeriods = [];
    try {
      const [rows] = await db.query(
        'SELECT period_key, start_time, end_time, sort FROM analytics_meal_periods WHERE branch_id IS NULL ORDER BY sort, period_key');
      mealPeriods = rows.map((r) => ({
        periodKey: String(r.period_key),
        startTime: String(r.start_time),
        endTime: String(r.end_time),
        sort: Number(r.sort) || 0,
      }));
    } catch (_) { /* not migrated yet */ }

    const fresh = await freshness.read(db);

    return res.json({
      success: true,
      data: {
        metrics,
        dimensions,
        dateBases: planner.DATE_BASES,
        facts: Object.keys(FACTS),
        mealPeriods,
        freshness: fresh,
        limits: {
          maxDimensions: planner.MAX_DIMENSIONS,
          maxMetrics: planner.MAX_METRICS,
          maxRangeDays: planner.MAX_RANGE_DAYS,
          defaultLimit: planner.DEFAULT_LIMIT,
          maxLimit: planner.MAX_LIMIT,
        },
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[analytics/metadata] failed:', e && (e.code || ''), e && e.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', error: 'تعذّر تحميل بيانات التحليلات' });
  }
});

module.exports = router;
