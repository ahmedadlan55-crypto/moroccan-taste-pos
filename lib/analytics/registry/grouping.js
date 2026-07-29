/**
 * lib/analytics/registry/grouping.js — which (metric, dimension) pairs the
 * planner will actually accept.
 *
 * WHY THIS EXISTS
 *   The planner enforces one rule, deep inside statement assembly:
 *
 *     dimension "x" is not available on fact "y" (metrics: …)   → 422
 *
 *   It is enforced PER FACT STATEMENT, after metrics have been partitioned by
 *   fact — so a request for eight metrics and one dimension fails ENTIRELY the
 *   moment a single metric lives on a fact that cannot express the dimension.
 *   The whole report goes red; nothing on screen says which of the eight was
 *   the problem, and the user's only recourse is to remove metrics one at a
 *   time until the red goes away.
 *
 *   A grouping UI that offers every groupable dimension against every metric
 *   would produce that red screen constantly. So the rule is lifted OUT of the
 *   planner into this module, projected to the client through
 *   /api/analytics/metadata, and the client disables the illegal pairs before
 *   anyone submits them.
 *
 * THE TWO TRAPS THIS MODULE EXISTS TO AVOID
 *
 *   1. `Object.keys(d.facts)` IS NOT the dimension's fact support.
 *      `meal_period` is kind 'derived-js': it has NO `facts` map at all and is
 *      planned from `sourceColumn` instead (planner.js:90-96). Reading `facts`
 *      alone reports zero support and would hide the single most useful
 *      restaurant grouping there is.
 *
 *   2. A DERIVED metric has no `fact` of its own.
 *      It is expanded into its additive inputs, and EVERY input's fact must
 *      support the dimension — `margin_pct` is only groupable where BOTH
 *      `net_ex_vat` and `cogs` are. Reporting `fact: null` (as the metadata
 *      route did) tells the client nothing, so the client cannot predict the
 *      422 and the red screen comes back.
 *
 * `discount_reason` supports NO fact by design (registry/dimensions.js:270 —
 * the contract reserves the id, no projector fills it). It is `groupable: true`
 * yet the planner rejects it against every metric in the registry. That is not
 * a bug to paper over here: this module reports it honestly as supported on
 * zero facts, and the caller decides how to present a dimension nothing can
 * group by.
 *
 * tests/analyticsGrouping.test.js proves this module agrees with the planner
 * on ALL metric × dimension pairs — by actually planning each one.
 */
'use strict';

const METRICS = require('./metrics');
const DIMS = require('./dimensions');

/**
 * Fact ids a DIMENSION can be expressed on — the union of its SQL `facts` map
 * and, for kind 'derived-js', the `sourceColumn` map the planner buckets from.
 * @returns {string[]}
 */
function dimensionFacts(dimId) {
  const d = DIMS.byId[String(dimId)];
  if (!d) return [];
  const out = new Set(Object.keys(d.facts || {}));
  for (const f of Object.keys(d.sourceColumn || {})) out.add(f);
  return [...out];
}

/**
 * Fact ids a METRIC needs. Additive → its own fact. Derived → the facts of its
 * additive inputs, ALL of which the planner will compute, so all must support
 * whatever dimension is grouped.
 * @returns {string[]}
 */
function metricFacts(metricId) {
  const m = METRICS.byId[String(metricId)];
  if (!m) return [];
  if (m.kind === 'additive') return m.fact ? [m.fact] : [];
  const out = new Set();
  for (const input of m.inputs || []) {
    const im = METRICS.byId[input];
    if (im && im.kind === 'additive' && im.fact) out.add(im.fact);
  }
  return [...out];
}

/**
 * Can this metric be grouped by this dimension? True when EVERY fact the
 * metric needs can express the dimension — the planner's own condition, since
 * it raises on the first fact statement that cannot.
 */
function supports(metricId, dimId) {
  const need = metricFacts(metricId);
  if (!need.length) return false;
  const have = new Set(dimensionFacts(dimId));
  return need.every((f) => have.has(f));
}

/**
 * Does this metric LIFT the void exclusion for its whole fact statement?
 *
 * planner.js:350-356, verbatim:
 *
 *     const hasVoidMetric = factMetrics.some((m) => String(m.sql).includes("'voided'"));
 *     if (!hasStatusFilter && req.includeVoided !== true && !hasVoidMetric) {
 *       whereParts.push("(f.status IS NULL OR f.status <> 'voided')");
 *     }
 *
 * `factMetrics` is EVERY metric on that statement. So asking for `voids_value`
 * beside `orders` silently drops the exclusion for `orders` too: the order
 * count starts including voided orders, and `avg_ticket` — a line-fact
 * numerator over that order-fact denominator — becomes void-excluded ÷
 * void-included. Two populations inside one number, with nothing on screen.
 *
 * The condition is a substring test on SQL the client never sees, so the FLAG
 * is projected instead (routes/analytics/metadata.js). Restating "which
 * metrics are void metrics" as a hardcoded list on the client would be a
 * second copy of the rule, free to drift; this is the rule itself.
 */
function liftsVoidExclusion(metricId) {
  const m = METRICS.byId[String(metricId)];
  if (!m) return false;
  if (m.kind === 'additive') return String(m.sql || '').includes("'voided'");
  // A derived metric is expanded into its inputs, and the planner tests the
  // inputs' SQL — so a derived metric lifts the exclusion iff any input does.
  return (m.inputs || []).some((i) => liftsVoidExclusion(i));
}

module.exports = { dimensionFacts, metricFacts, supports, liftsVoidExclusion };
