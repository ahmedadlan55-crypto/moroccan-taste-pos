/**
 * lib/analytics/planner.js — request → parameterized SQL statements. PURE:
 * no DB, no clock, no config reads. QueryService loads whatever runtime
 * config the planner needs (meal-period rows) and passes it in.
 *
 * DOCTRINE (mirrors the registry headers):
 *   • A fact is a constant FROM string. The planner NEVER adds a join —
 *     cross-fact math happens in QueryService by merging result sets on the
 *     composite dimension key.
 *   • Every identifier that reaches SQL text comes from the REGISTRY, never
 *     from the request. Request strings are only ever compared against
 *     registry ids or bound as `?` parameters — an id like "x; DROP TABLE"
 *     can only produce ANALYTICS_UNKNOWN_METRIC, never SQL.
 *   • The scope clause (fact.scopeColumn IN (...)) is appended for EVERY
 *     non-global caller on EVERY statement. Zero grants → `1=0` (empty
 *     result, fail-closed — never unscoped).
 *
 * DEFAULT FILTERS (each surfaced in meta.defaultsApplied, each overridable):
 *   excluded_voided — order/line/modifier statements exclude
 *     status='voided' rows unless (a) the request filters on order_status,
 *     (b) request.includeVoided === true, or (c) the statement itself
 *     computes a voids_* metric (excluding voided rows there would define
 *     the metric to zero).
 *   excluded_credit_note_docs — order/line/modifier statements exclude fact
 *     rows whose source is 'sales_return'/'credit_note' unless the request
 *     filters on `source` explicitly. WHY: SalesReturnService writes the
 *     credit note's ar_document_lines with POSITIVE amounts and
 *     ProjectionService projects an order fact for the CN document — without
 *     this default a returned invoice would count its money TWICE (once as
 *     the sale, once as the CN). Returns are measured by the return-fact
 *     metrics (returns_net / qty_returned / …), which is also how the legacy
 *     erp-core endpoint treats credit notes (excluded from sales).
 *
 * meal_period (kind derived-js) is planned as a SQL CASE built from the
 *   GLOBAL analytics_meal_periods rows passed in opts.mealPeriods (branch
 *   overrides are ignored in v1 — a per-branch CASE would need a branch
 *   column switch per fact; documented limitation). All boundary times are
 *   bound as parameters.
 *
 * Errors thrown carry { code, http }:
 *   ANALYTICS_UNKNOWN_METRIC / ANALYTICS_UNKNOWN_DIMENSION        422
 *   ANALYTICS_RANGE_TOO_WIDE                                       422
 *   ANALYTICS_UNSUPPORTED_COMBINATION (metric×dimension/basis/filter) 422
 *   VALIDATION_ERROR (shape problems)                              422
 *   ANALYTICS_ALL_MASKED (every requested metric capability-masked) 403
 *   PERMISSION_DENIED (dimension needs a capability the caller lacks) 403
 */
'use strict';

const { FACTS } = require('./registry/facts');
const DIMS = require('./registry/dimensions');
const METRICS = require('./registry/metrics');
const { rangeDays, parseIsoDate } = require('./compare');

const MAX_RANGE_DAYS = 400;
const MAX_DIMENSIONS = 3;
const MAX_METRICS = 12;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_IN_VALUES = 200;
const MAX_SORTS = 3;

const DATE_BASES = Object.freeze(['business_day', 'calendar_day', 'paid_at', 'closed_at']);

function perr(code, http, message) {
  const e = new Error(message || code);
  e.code = code;
  e.http = http;
  return e;
}

function isScalar(v) {
  return (typeof v === 'string' && v.length <= 200) ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    typeof v === 'boolean';
}

/** 'HH:mm[:ss]' guard for meal-period boundary rows (they feed `?` params). */
function timeParam(t) {
  const s = String(t == null ? '' : t);
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) throw perr('VALIDATION_ERROR', 422, `bad meal-period time "${s}"`);
  return s.length === 5 ? s + ':00' : s;
}

/**
 * Resolve a dimension's SQL expression on a fact.
 * Returns { sql, params } or null when the fact does not support it.
 * meal_period builds a parameterized CASE over the fact's local timestamp.
 */
function dimExprFor(dim, factId, mealPeriods) {
  if (dim.kind === 'derived-js') {
    // meal_period — the only derived-js dimension in the registry.
    const col = dim.sourceColumn && dim.sourceColumn[factId];
    if (!col) return null;
    const rows = (mealPeriods && mealPeriods.length) ? mealPeriods : null;
    if (!rows) return null; // no config passed in → cannot plan the dimension
    const sorted = rows.slice().sort((a, b) => {
      const sa = Number(a.sort) || 0, sb = Number(b.sort) || 0;
      if (sa !== sb) return sa - sb;
      return String(a.period_key) < String(b.period_key) ? -1 : 1;
    });
    const parts = [];
    const params = [];
    for (const r of sorted) {
      const start = timeParam(r.start_time), end = timeParam(r.end_time);
      const overnight = start > end;
      if (overnight) {
        parts.push(`WHEN (TIME(${col}) >= ? OR TIME(${col}) <= ?) THEN ?`);
      } else {
        parts.push(`WHEN (TIME(${col}) BETWEEN ? AND ?) THEN ?`);
      }
      params.push(start, end, String(r.period_key));
    }
    return { sql: `CASE ${parts.join(' ')} ELSE NULL END`, params };
  }
  const expr = dim.facts && dim.facts[factId];
  if (!expr) return null;
  return { sql: expr, params: [] };
}

/** Wrap date-valued dims so the wire value is a plain 'YYYY-MM-DD' string. */
function selectWrap(dimId, sql) {
  if (dimId === 'business_day' || dimId === 'calendar_day') {
    return `DATE_FORMAT(${sql}, '%Y-%m-%d')`;
  }
  return sql;
}

/** Build one filter's WHERE fragment on a fact. Returns {sql, params}. */
function filterClause(dim, factId, filter, mealPeriods) {
  const expr = dimExprFor(dim, factId, mealPeriods);
  if (!expr) return null;
  const op = String(filter.op || '');
  if (!dim.ops.includes(op)) {
    throw perr('VALIDATION_ERROR', 422, `operator "${op}" not allowed on dimension "${dim.id}"`);
  }
  if (op === 'eq') {
    if (!isScalar(filter.value)) throw perr('VALIDATION_ERROR', 422, `filter "${dim.id}": eq needs a scalar value`);
    return { sql: `(${expr.sql}) = ?`, params: [...expr.params, filter.value] };
  }
  if (op === 'in' || op === 'not_in') {
    const values = filter.values;
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_IN_VALUES || !values.every(isScalar)) {
      throw perr('VALIDATION_ERROR', 422, `filter "${dim.id}": ${op} needs 1..${MAX_IN_VALUES} scalar values`);
    }
    const ph = values.map(() => '?').join(',');
    if (op === 'in') return { sql: `(${expr.sql}) IN (${ph})`, params: [...expr.params, ...values] };
    // not_in keeps NULL rows: SQL NOT IN silently drops them, which would
    // make "everything except X" quietly exclude unattributed rows too.
    return {
      sql: `((${expr.sql}) IS NULL OR (${expr.sql}) NOT IN (${ph}))`,
      params: [...expr.params, ...expr.params, ...values],
    };
  }
  if (op === 'between') {
    if (!isScalar(filter.from) || !isScalar(filter.to)) {
      throw perr('VALIDATION_ERROR', 422, `filter "${dim.id}": between needs scalar from/to`);
    }
    return { sql: `(${expr.sql}) BETWEEN ? AND ?`, params: [...expr.params, filter.from, filter.to] };
  }
  throw perr('VALIDATION_ERROR', 422, `unknown operator "${op}"`);
}

/**
 * plan(request, scope, opts) → { statements, meta }
 *
 * request: {
 *   metrics: [id...],               // 1..12, registry ids
 *   dimensions?: [id...],           // 0..3, groupable registry ids
 *   dateBasis?: 'business_day'|'calendar_day'|'paid_at'|'closed_at',
 *   range: { from:'YYYY-MM-DD', to:'YYYY-MM-DD' },   // REQUIRED, ≤400 days
 *   filters?: [{dimension, op, value|values|from,to}...],
 *   sort?: [{by: metricId|dimensionId, dir:'asc'|'desc'}...],
 *   limit?, offset?, includeVoided?, compare?: 'prevPeriod'|'prevYear'
 * }
 * scope: { all, branchIds, caps:Set } from lib/analytics/scope.js.
 * opts:  { mealPeriods: analytics_meal_periods rows (global) }
 */
function plan(request, scope, opts = {}) {
  const req = request || {};
  const caps = scope && scope.caps instanceof Set ? scope.caps
    : new Set((scope && scope.caps) || []);
  const mealPeriods = opts.mealPeriods || null;

  // ── shape ────────────────────────────────────────────────────────────────
  if (!Array.isArray(req.metrics) || req.metrics.length === 0) {
    throw perr('VALIDATION_ERROR', 422, 'metrics: a non-empty array is required');
  }
  if (req.metrics.length > MAX_METRICS) {
    throw perr('VALIDATION_ERROR', 422, `metrics: at most ${MAX_METRICS} per request`);
  }
  const dimensionIds = Array.isArray(req.dimensions) ? req.dimensions : [];
  if (dimensionIds.length > MAX_DIMENSIONS) {
    throw perr('VALIDATION_ERROR', 422, `dimensions: at most ${MAX_DIMENSIONS} per request`);
  }
  if (!req.range || typeof req.range !== 'object') {
    throw perr('VALIDATION_ERROR', 422, 'range: {from,to} ISO dates are required');
  }
  let span;
  try {
    parseIsoDate(req.range.from);
    parseIsoDate(req.range.to);
    span = rangeDays(req.range);
  } catch (e) {
    throw perr('VALIDATION_ERROR', 422, e.message);
  }
  if (span < 1) throw perr('VALIDATION_ERROR', 422, 'range: to precedes from');
  if (span > MAX_RANGE_DAYS) {
    throw perr('ANALYTICS_RANGE_TOO_WIDE', 422,
      `range spans ${span} days — live fact queries are capped at ${MAX_RANGE_DAYS}`);
  }

  const basis = req.dateBasis == null ? 'business_day' : String(req.dateBasis);
  if (!DATE_BASES.includes(basis)) {
    throw perr('VALIDATION_ERROR', 422, `dateBasis must be one of ${DATE_BASES.join(', ')}`);
  }

  // ── metrics: resolve + capability mask ───────────────────────────────────
  const maskedMetrics = [];
  const visibleMetricIds = [];
  for (const raw of req.metrics) {
    const id = String(raw);
    const m = METRICS.byId[id];
    if (!m) throw perr('ANALYTICS_UNKNOWN_METRIC', 422, `unknown metric "${id.slice(0, 60)}"`);
    if (m.takesMetricParam) {
      throw perr('VALIDATION_ERROR', 422,
        `metric "${id}" is parameterized — request a base metric with compare instead`);
    }
    if (m.requiresCap && !caps.has(m.requiresCap)) {
      if (!maskedMetrics.includes(id)) maskedMetrics.push(id);
      continue;
    }
    if (!visibleMetricIds.includes(id)) visibleMetricIds.push(id);
  }
  if (!visibleMetricIds.length) {
    throw perr('ANALYTICS_ALL_MASKED', 403, 'every requested metric is capability-masked');
  }

  // Expand derived → the additive inputs each fact statement must compute.
  const derivedIds = [];
  const additiveIds = [];
  const addAdditive = (id) => { if (!additiveIds.includes(id)) additiveIds.push(id); };
  for (const id of visibleMetricIds) {
    const m = METRICS.byId[id];
    if (m.kind === 'additive') { addAdditive(id); continue; }
    derivedIds.push(id);
    for (const input of m.inputs) {
      const im = METRICS.byId[input];
      if (!im || im.kind !== 'additive') {
        throw perr('VALIDATION_ERROR', 422, `derived metric "${id}" has a non-additive input "${input}"`);
      }
      addAdditive(input);
    }
  }

  // ── dimensions: resolve + capability gate ────────────────────────────────
  const dims = dimensionIds.map((raw) => {
    const id = String(raw);
    const d = DIMS.byId[id];
    if (!d) throw perr('ANALYTICS_UNKNOWN_DIMENSION', 422, `unknown dimension "${id.slice(0, 60)}"`);
    if (!d.groupable) throw perr('VALIDATION_ERROR', 422, `dimension "${id}" is not groupable`);
    if (d.requiresCap && !caps.has(d.requiresCap)) {
      throw perr('PERMISSION_DENIED', 403, `dimension "${id}" requires ${d.requiresCap}`);
    }
    return d;
  });

  // ── filters: resolve dimensions + capability gate ────────────────────────
  const filters = Array.isArray(req.filters) ? req.filters : [];
  const filterDims = filters.map((f) => {
    if (!f || typeof f !== 'object') throw perr('VALIDATION_ERROR', 422, 'filters: each entry must be an object');
    const id = String(f.dimension || '');
    const d = DIMS.byId[id];
    if (!d) throw perr('ANALYTICS_UNKNOWN_DIMENSION', 422, `unknown filter dimension "${id.slice(0, 60)}"`);
    if (d.requiresCap && !caps.has(d.requiresCap)) {
      throw perr('PERMISSION_DENIED', 403, `filter dimension "${id}" requires ${d.requiresCap}`);
    }
    return d;
  });
  const hasStatusFilter = filterDims.some((d) => d.id === 'order_status');
  const hasSourceFilter = filterDims.some((d) => d.id === 'source');

  // ── sort: allow-listed against requested ids ─────────────────────────────
  const sorts = Array.isArray(req.sort) ? req.sort.slice(0, MAX_SORTS) : [];
  const sortSpecs = sorts.map((s) => {
    const by = String((s && s.by) || '');
    const dir = String((s && s.dir) || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const isMetric = visibleMetricIds.includes(by);
    const isDim = dims.some((d) => d.id === by);
    if (!isMetric && !isDim) {
      throw perr('VALIDATION_ERROR', 422, `sort.by "${by.slice(0, 60)}" is not a requested metric or dimension`);
    }
    return { by, dir, kind: isMetric ? 'metric' : 'dimension' };
  });

  const limit = Math.min(Math.max(1, Number(req.limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, Number(req.offset) || 0);
  // Per-fact fetch depth is ALWAYS the hard cap, never the page size: facts
  // are merged on the dimension key in QueryService, and two facts ordered
  // by different columns would otherwise fetch DISJOINT top-N slices — the
  // merged page would then show silent zeros for the secondary fact's
  // metrics. Fetch everything up to the cap, sort+page post-merge; a fact
  // that actually hits the cap raises page.rowCountCapped.
  const fetchN = MAX_LIMIT;

  // ── partition additive metrics by fact ───────────────────────────────────
  const byFact = new Map();
  for (const id of additiveIds) {
    const m = METRICS.byId[id];
    if (!byFact.has(m.fact)) byFact.set(m.fact, []);
    byFact.get(m.fact).push(m);
  }

  const defaultsApplied = new Set();
  const statements = [];

  for (const [factId, factMetrics] of byFact) {
    const fact = FACTS[factId];
    if (!fact) throw perr('VALIDATION_ERROR', 422, `registry names unknown fact "${factId}"`);

    // date basis on this fact
    const basisCol = fact.dateBases[basis];
    if (!basisCol) {
      throw perr('ANALYTICS_UNSUPPORTED_COMBINATION', 422,
        `date basis "${basis}" is not available on fact "${factId}" (metrics: ${factMetrics.map((m) => m.id).join(', ')})`);
    }

    // dimensions on this fact
    const dimExprs = dims.map((d) => {
      const e = dimExprFor(d, factId, mealPeriods);
      if (!e) {
        throw perr('ANALYTICS_UNSUPPORTED_COMBINATION', 422,
          `dimension "${d.id}" is not available on fact "${factId}" (metrics: ${factMetrics.map((m) => m.id).join(', ')})`);
      }
      return e;
    });

    // WHERE
    const whereParts = [];
    const whereParams = [];
    whereParts.push(`${basisCol} >= ? AND ${basisCol} < DATE_ADD(?, INTERVAL 1 DAY)`);
    whereParams.push(req.range.from, req.range.to);

    for (let i = 0; i < filters.length; i++) {
      const clause = filterClause(filterDims[i], factId, filters[i], mealPeriods);
      if (!clause) {
        throw perr('ANALYTICS_UNSUPPORTED_COMBINATION', 422,
          `filter dimension "${filterDims[i].id}" is not available on fact "${factId}"`);
      }
      whereParts.push(clause.sql);
      whereParams.push(...clause.params);
    }

    // default filters — only on facts that expose the order-fact alias `f`
    if (fact.aliases.includes('f')) {
      const hasVoidMetric = factMetrics.some((m) => String(m.sql).includes("'voided'"));
      if (!hasStatusFilter && req.includeVoided !== true && !hasVoidMetric) {
        whereParts.push("(f.status IS NULL OR f.status <> 'voided')");
        defaultsApplied.add('excluded_voided');
      }
      if (!hasSourceFilter) {
        whereParts.push("(f.source IS NULL OR f.source NOT IN ('sales_return','credit_note'))");
        defaultsApplied.add('excluded_credit_note_docs');
      }
    }

    // scope — ALWAYS for non-global
    if (!scope || !scope.all) {
      const branchIds = (scope && scope.branchIds) || [];
      if (!branchIds.length) {
        whereParts.push('1=0'); // fail-closed: zero grants → zero rows
      } else {
        const ph = branchIds.map(() => '?').join(',');
        whereParts.push(`${fact.scopeColumn} IN (${ph})`);
        whereParams.push(...branchIds.map(String));
      }
    }

    const metricSelect = factMetrics.map((m) => `${m.sql} AS m_${m.id}`).join(', ');
    const whereSql = whereParts.join(' AND ');

    // ── rows statement ──
    let rowsSql, rowsParams;
    if (dims.length) {
      const selParts = [];
      const selParams = [];
      dims.forEach((d, i) => {
        selParts.push(`${selectWrap(d.id, dimExprs[i].sql)} AS d${i}`);
        selParams.push(...dimExprs[i].params);
      });
      const aliasList = dims.map((_, i) => `d${i}`).join(', ');
      let orderSql = '';
      if (sortSpecs.length) {
        orderSql = ' ORDER BY ' + sortSpecs.map((s) => {
          if (s.kind === 'metric') {
            // sort by a metric this fact computes, else fall back to dims
            const onFact = factMetrics.some((m) => m.id === s.by);
            return onFact ? `m_${s.by} ${s.dir.toUpperCase()}` : `d0 ${s.dir.toUpperCase()}`;
          }
          const idx = dims.findIndex((d) => d.id === s.by);
          return `d${idx} ${s.dir.toUpperCase()}`;
        }).join(', ');
      } else {
        orderSql = ` ORDER BY m_${factMetrics[0].id} DESC`;
      }
      rowsSql = `SELECT ${selParts.join(', ')}, ${metricSelect} ${fact.from} ` +
        `WHERE ${whereSql} GROUP BY ${aliasList}${orderSql} LIMIT ? OFFSET ?`;
      rowsParams = [...selParams, ...whereParams, fetchN, 0];
    } else {
      rowsSql = `SELECT ${metricSelect} ${fact.from} WHERE ${whereSql}`;
      rowsParams = [...whereParams];
    }

    // ── totals statement (ROLLUP + GROUPING flags) ──
    let totalsSql, totalsParams;
    if (dims.length) {
      // ONE canonical expression per dim, reused VERBATIM in SELECT, in
      // GROUPING() and in GROUP BY — ONLY_FULL_GROUP_BY (and GROUPING()
      // itself) match expressions by exact text, so select-wrapping a dim
      // differently from its GROUP BY entry is a hard error.
      const selParts = [];
      const selParams = [];
      dims.forEach((d, i) => {
        selParts.push(`${selectWrap(d.id, dimExprs[i].sql)} AS d${i}`);
        selParams.push(...dimExprs[i].params);
      });
      const groupingParts = [];
      const groupingParams = [];
      dims.forEach((d, i) => {
        groupingParts.push(`GROUPING(${selectWrap(d.id, dimExprs[i].sql)}) AS g${i}`);
        groupingParams.push(...dimExprs[i].params);
      });
      const groupParts = [];
      const groupParams = [];
      dims.forEach((d, i) => {
        groupParts.push(selectWrap(d.id, dimExprs[i].sql));
        groupParams.push(...dimExprs[i].params);
      });
      totalsSql = `SELECT ${selParts.join(', ')}, ${groupingParts.join(', ')}, ${metricSelect} ` +
        `${fact.from} WHERE ${whereSql} GROUP BY ${groupParts.join(', ')} WITH ROLLUP`;
      totalsParams = [...selParams, ...groupingParams, ...whereParams, ...groupParams];
    } else {
      totalsSql = rowsSql;
      totalsParams = [...rowsParams];
    }

    statements.push({
      fact: factId,
      metrics: factMetrics.map((m) => m.id),
      rows: { sql: rowsSql, params: rowsParams },
      totals: { sql: totalsSql, params: totalsParams },
    });
  }

  return {
    statements,
    meta: {
      basis,
      range: { from: req.range.from, to: req.range.to },
      dims: dims.map((d) => d.id),
      requestedMetrics: visibleMetricIds,
      additiveMetrics: additiveIds,
      derivedMetrics: derivedIds,
      maskedMetrics,
      defaultsApplied: [...defaultsApplied],
      limit,
      offset,
      fetchN,
      sort: sortSpecs,
    },
  };
}

module.exports = {
  plan,
  MAX_RANGE_DAYS, MAX_DIMENSIONS, MAX_METRICS, DEFAULT_LIMIT, MAX_LIMIT,
  DATE_BASES,
};
