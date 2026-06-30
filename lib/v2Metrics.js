'use strict';
/**
 * ─── warehouse-v2 operational metrics ────────────────────────────────────────
 *
 * In-process counters for the v2 surface, scraped via /api/metrics (Prometheus)
 * and /api/metrics/json. Reset on restart (pair with a real TSDB in prod). The
 * two business-critical signals — lot_invariant_violation_total and
 * gl_imbalance_total — should ALERT at value > 0 (they mean data integrity is at
 * risk); the throw/return sites also emit a structured fatal log line.
 */
const counters = {
  v2_requests_total: 0,
  v2_responses_4xx: 0,
  v2_responses_5xx: 0,
  v2_conflicts_409: 0,
  v2_reversals_total: 0,
  lot_invariant_violation_total: 0,
  gl_imbalance_total: 0,
};

function inc(name, by) {
  if (counters[name] === undefined) counters[name] = 0;
  counters[name] += (by == null ? 1 : by);
}

function snapshot() { return Object.assign({}, counters); }

// Response-status counting middleware for the whole /api/inventory/v2 surface.
function track(req, res, next) {
  counters.v2_requests_total++;
  res.on('finish', function () {
    const s = res.statusCode;
    if (s === 409) counters.v2_conflicts_409++;
    else if (s >= 500) counters.v2_responses_5xx++;
    else if (s >= 400) counters.v2_responses_4xx++;
    if (s < 300 && req.method === 'POST' && /\/reverse$/.test(req.path || '')) counters.v2_reversals_total++;
  });
  next();
}

module.exports = { inc, snapshot, track, _counters: counters };
