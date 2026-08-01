/**
 * lib/analytics/planner.js — request → parameterized SQL statements. PURE:
 * no DB, no clock, no config reads. QueryService loads whatever runtime
 * config the planner needs (meal-period rows, the rollup horizon) and passes
 * it in.
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
 * ─────────────────────────────────────────────────────────────────────────
 * SOURCE ROUTING (rollup vs live) — see ROLLUP_SOURCES below
 * ─────────────────────────────────────────────────────────────────────────
 * The rollup worker (services/analytics/RollupService.js) has always
 * maintained analytics_daily_branch / _daily_item / _daily_payment /
 * _hourly_branch, and this planner never read a single one of them: every
 * request scanned the raw fact tables. This module now routes a request to a
 * rollup when — and ONLY when — the request is PROVABLY expressible from it,
 * and reports which physical source actually answered as meta.source
 * ('rollup' | 'live' | 'hybrid') so the response can never claim a freshness
 * it does not have.
 *
 * Eligibility is derived from the REGISTRY, never from a report name: each
 * rollup declares the registry METRIC ids and DIMENSION ids it can express,
 * those keys are checked against the registry at require time (see the
 * assertion under ROLLUP_SOURCES), and a metric or dimension that is not in
 * the map is simply not expressible — so a metric added tomorrow falls back
 * to live instead of silently reading a column that does not mean what its
 * name suggests.
 *
 * CORRECTNESS BEATS SPEED. Every one of the following makes the whole
 * request fall back to live, because in each case the rollup's numbers are
 * not the numbers the live path would produce:
 *   - dateBasis is not business_day (every rollup is keyed by business_day;
 *     calendar_day, paid_at and closed_at slice the data differently),
 *   - the request lifts a default the rollup has BAKED IN (includeVoided,
 *     an order_status filter, a `source` filter, or a voids_* metric whose
 *     SQL drops the void exclusion for its whole statement),
 *   - any requested/filtered dimension is not in the rollup's dimension map,
 *   - any additive metric is not in the rollup's metric map,
 *   - the rollup horizon is unknown (opts.rollupClosedThrough == null), which
 *     is what happens when analytics_rollup_dirty cannot be read at all.
 * A request the planner cannot PROVE is expressible is answered live: a slow
 * correct number beats a fast wrong one.
 *
 * `request.noRollup === true` forces the live path — the parity harness and
 * anyone debugging a suspected rollup drift need to be able to ask the raw
 * facts directly.
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

/**
 * The DECLARED HARD CAP on how deep paging can reach.
 *
 * `fetchN` used to be the constant MAX_LIMIT (500) no matter which page was
 * asked for, so `offset: 500` fetched the same first 500 merged rows and then
 * sliced [500..1000) out of a 500-row array — an empty page. Every caller that
 * pages ("export all", the Explorer's next-page button) therefore stopped dead
 * at row 500 while reporting success, and an export of a 4,000-row report
 * silently produced a 500-row file that looked complete.
 *
 * Paging now fetches offset+limit rows per statement, clamped here. When the
 * clamp bites, page.truncated says so — a caller must never be able to present
 * a clipped result as the whole thing.
 */
const MAX_FETCH_ROWS = 10000;

/**
 * Bound on the totals/subtotals statement. WITH ROLLUP emits one super
 * aggregate per prefix of the GROUP BY plus the grand total; at three
 * dimensions that set can itself be large, so it is ordered aggregates-first
 * (grand, then level-1, then level-2) and capped. Ordering matters: MySQL
 * emits a super-aggregate AFTER the group it summarizes, so a bare LIMIT
 * would cut the GRAND TOTAL off the end of the result.
 */
const MAX_SUBTOTAL_ROWS = 5000;

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

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar-shift an ISO day. Done in UTC space so no DST or locale is involved. */
function addDaysIso(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) throw perr('VALIDATION_ERROR', 422, `bad ISO day "${iso}"`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * 86400000);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** 'HH:mm[:ss]' guard for meal-period boundary rows (they feed `?` params). */
function timeParam(t) {
  const s = String(t == null ? '' : t);
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) throw perr('VALIDATION_ERROR', 422, `bad meal-period time "${s}"`);
  return s.length === 5 ? s + ':00' : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLLUP SOURCES
//
// Each entry is a pre-aggregated table the rollup worker maintains, described
// in the SAME vocabulary the live registry uses: registry metric ids → the
// aggregate expression over the rollup's own columns, registry dimension ids →
// the rollup's own key column. A request is expressible from a source only if
// EVERY additive metric and EVERY requested/filtered dimension appears here.
//
// Every rollup is keyed by (business_day, branch_id, …) and every one of them
// is built with the planner's default filters already applied
// (RollupService's PARITY CONTRACT) — which is exactly why a request that
// lifts one of those defaults may not use them.
//
// WHAT IS DELIBERATELY ABSENT, and why — these are not oversights:
//
//   week / month / quarter / year / weekday / hour on analytics_daily_branch
//     The live time dimensions are computed from f.occurred_at_local (see
//     registry/dimensions.js `timeExpr`), NOT from business_day. For a branch
//     that closes at 04:00 those two disagree for every sale between midnight
//     and the close, so YEARWEEK(business_day) is not YEARWEEK(occurred_at)
//     and the rollup answer would differ from the live one on precisely the
//     late-night trade a restaurant cares about. Only `business_day` itself
//     (and the scope keys) can be read off a daily rollup safely.
//
//   `brand` on analytics_daily_branch
//     The column is a denormalized MAX(f.brand_id) per (day, branch), and the
//     returns_net / refunds_amount inserts do not populate it at all — a
//     returns-only day carries brand_id NULL. Grouping by it would invent a
//     NULL brand bucket that live never shows.
//
//   analytics_daily_item entirely
//     Its PK cannot hold menu_id NULL, so RollupService skips free-text lines
//     (its own header documents the deviation) while the live path puts them
//     in a NULL group. Its totals are therefore NOT the live totals whenever a
//     free-text line exists, and nothing in the schema forbids one. Item
//     reporting stays live until the rollup can carry those lines.
//
//   `payment_method` on analytics_daily_payment
//     RollupService folds method_norm NULL into 'other' (documented
//     deviation); live keeps a NULL group. Day/branch/direction are exact, so
//     those are mapped and payment_method is not.
//
//   voids_count / voids_value
//     A voids_* metric makes the planner drop the void exclusion for its ENTIRE
//     statement, so live `orders` requested alongside `voids_count` COUNTS
//     voided orders — while the rollup's `orders` column never does. Rather
//     than encode that asymmetry, any void-lifting metric sends the request
//     live (see liftsVoidExclusion below).
// ─────────────────────────────────────────────────────────────────────────────
const ROLLUP_SOURCES = Object.freeze([
  Object.freeze({
    id: 'daily_branch',
    table: 'analytics_daily_branch',
    from: 'FROM analytics_daily_branch rb',
    dayColumn: 'rb.business_day',
    scopeColumn: 'rb.branch_id',
    metrics: Object.freeze({
      orders: 'SUM(rb.orders)',
      guests: 'SUM(rb.guests)',
      gross_product_sales: 'SUM(rb.gross_product)',
      discounts_total: 'SUM(rb.discounts)',
      returns_net: 'SUM(rb.returns_net)',
      net_ex_vat: 'SUM(rb.net_ex_vat)',
      vat_amount: 'SUM(rb.vat)',
      invoice_total: 'SUM(rb.invoice_total)',
      rounding_total: 'SUM(rb.rounding)',
      tips_total: 'SUM(rb.tips)',
      fees_total: 'SUM(rb.fees)',
      cogs: 'SUM(rb.cogs)',
      refunds_out: 'SUM(rb.refunds_amount)',
    }),
    dims: Object.freeze({
      business_day: 'rb.business_day',
      branch: 'rb.branch_id',
    }),
  }),
  Object.freeze({
    id: 'hourly_branch',
    table: 'analytics_hourly_branch',
    from: 'FROM analytics_hourly_branch hb',
    dayColumn: 'hb.business_day',
    scopeColumn: 'hb.branch_id',
    metrics: Object.freeze({
      orders: 'SUM(hb.orders)',
      guests: 'SUM(hb.guests)',
      net_ex_vat: 'SUM(hb.net_ex_vat)',
    }),
    dims: Object.freeze({
      business_day: 'hb.business_day',
      branch: 'hb.branch_id',
      // slot30 IS the live half_hour expression, stored: RollupService buckets
      // on (HOUR(f.occurred_at_local)*2 + FLOOR(MINUTE(...)/30)), which is the
      // registry's half_hour expression verbatim — so hour is FLOOR(slot30/2)
      // exactly, with no timezone reasoning required.
      half_hour: 'hb.slot30',
      hour: 'FLOOR(hb.slot30 / 2)',
    }),
  }),
  Object.freeze({
    id: 'daily_payment',
    table: 'analytics_daily_payment',
    from: 'FROM analytics_daily_payment dp',
    dayColumn: 'dp.business_day',
    scopeColumn: 'dp.branch_id',
    metrics: Object.freeze({
      payments_in: "SUM(CASE WHEN dp.direction = 'in' THEN dp.amount ELSE 0 END)",
      refunds_out: "SUM(CASE WHEN dp.direction = 'out' THEN dp.amount ELSE 0 END)",
    }),
    dims: Object.freeze({
      business_day: 'dp.business_day',
      branch: 'dp.branch_id',
      direction: 'dp.direction',
    }),
  }),
]);

// Fail LOUD at require time if a rollup map names something the registry does
// not define. A silent typo here would route a real request to a real column
// with the wrong meaning, which is the single worst outcome this file can
// produce — far worse than not routing at all.
for (const src of ROLLUP_SOURCES) {
  for (const id of Object.keys(src.metrics)) {
    const m = METRICS.byId[id];
    if (!m || m.kind !== 'additive') {
      throw new Error(`analytics planner: rollup "${src.id}" maps "${id}", which is not an additive registry metric`);
    }
  }
  for (const id of Object.keys(src.dims)) {
    const d = DIMS.byId[id];
    if (!d || !d.groupable) {
      throw new Error(`analytics planner: rollup "${src.id}" maps "${id}", which is not a groupable registry dimension`);
    }
  }
}

/**
 * Does this metric's SQL drop the void exclusion for its whole statement?
 * Read off the registry SQL exactly the way the statement builder below reads
 * it, so the two can never disagree — a hardcoded list of "the voids metrics"
 * would drift the day someone adds a third one.
 */
function liftsVoidExclusion(metric) {
  return String(metric.sql).includes("'voided'");
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

/**
 * Build one filter's WHERE fragment from an ALREADY-RESOLVED dimension
 * expression. Taking the expression rather than looking it up keeps one filter
 * implementation for both the live facts and the rollup sources — the operator
 * allow-list and the NULL-preserving not_in are security/correctness rules that
 * must not exist in two copies.
 */
function filterClauseFrom(dim, expr, filter) {
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

/** Live-fact convenience wrapper — resolve then delegate. */
function filterClause(dim, factId, filter, mealPeriods) {
  return filterClauseFrom(dim, dimExprFor(dim, factId, mealPeriods), filter);
}

/**
 * Emit the { rows, totals } SQL pair for ONE source (a live fact or a rollup
 * table). Everything above the FROM/WHERE line is identical between the two,
 * so it lives here once.
 *
 * rows   — the detail grouping, LIMIT fetchN OFFSET 0. OFFSET stays 0 on
 *          purpose: facts are merged on the dimension key in QueryService, and
 *          two sources paged independently in SQL would return DISJOINT
 *          windows whose merge is nonsense. The page is cut after the merge.
 *
 * totals — the grand total and every subtotal level, and NOTHING ELSE. WITH
 *          ROLLUP alone streams every detail row back to Node beside the
 *          super-aggregates, and Node dropped them one by one (`if (rolled ===
 *          0) continue`) — a second full-size result set over the wire and
 *          through the driver purely to reach one row at the end of it. The
 *          HAVING pushes that discard into the server, which is the only place
 *          it costs nothing, and the ORDER BY + LIMIT bound what comes back
 *          with the GRAND TOTAL FIRST so the bound can never eat it.
 */
function emitStatementSql(o) {
  const { dims, dimExprs, metricDefs, from, whereSql, whereParams, sortSpecs, fetchN } = o;
  const metricSelect = metricDefs.map((m) => `${m.sql} AS m_${m.id}`).join(', ');

  if (!dims.length) {
    const sql = `SELECT ${metricSelect} ${from} WHERE ${whereSql}`;
    const params = [...whereParams];
    // With no GROUP BY the single aggregate row IS the grand total; a separate
    // totals statement would be the identical query run twice.
    return { rows: { sql, params }, totals: { sql, params: [...params] } };
  }

  // ONE canonical expression per dim, reused VERBATIM in SELECT, in GROUPING(),
  // in GROUP BY and in HAVING — ONLY_FULL_GROUP_BY (and GROUPING() itself)
  // match expressions by exact text, so select-wrapping a dim differently from
  // its GROUP BY entry is a hard error.
  const selParts = [];
  const selParams = [];
  dims.forEach((d, i) => {
    selParts.push(`${selectWrap(d.id, dimExprs[i].sql)} AS d${i}`);
    selParams.push(...dimExprs[i].params);
  });
  const aliasList = dims.map((_, i) => `d${i}`).join(', ');

  let orderSql;
  if (sortSpecs.length) {
    orderSql = ' ORDER BY ' + sortSpecs.map((s) => {
      if (s.kind === 'metric') {
        // sort by a metric this source computes, else fall back to dims
        const onSource = metricDefs.some((m) => m.id === s.by);
        return onSource ? `m_${s.by} ${s.dir.toUpperCase()}` : `d0 ${s.dir.toUpperCase()}`;
      }
      const idx = dims.findIndex((d) => d.id === s.by);
      return `d${idx} ${s.dir.toUpperCase()}`;
    }).join(', ');
  } else {
    orderSql = ` ORDER BY m_${metricDefs[0].id} DESC`;
  }

  const rowsSql = `SELECT ${selParts.join(', ')}, ${metricSelect} ${from} ` +
    `WHERE ${whereSql} GROUP BY ${aliasList}${orderSql} LIMIT ? OFFSET ?`;
  const rowsParams = [...selParams, ...whereParams, fetchN, 0];

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
  // HAVING references the SELECT ALIAS `g{i}`, and must not restate the
  // expression the way SELECT / GROUPING() / GROUP BY do.
  //
  // It used to say `GROUPING(<the wrapped expr>) = 1`, matching the sibling
  // clauses above. For a bare column that parses; for a WRAPPED one it does
  // not, because HAVING is resolved after grouping and cannot see the
  // underlying column:
  //
  //   HAVING (GROUPING(DATE_FORMAT(f.business_day,'%Y-%m-%d')) = 1)
  //   → ER_BAD_FIELD_ERROR: Unknown column 'f.business_day' in 'having clause'
  //
  // Every TIME dimension is select-wrapped, so this 500'd business_day,
  // calendar_day, week, month, quarter, year, hour, half_hour and weekday —
  // i.e. every time-series report in the product — while branch, channel,
  // cashier, menu_item and the other bare-column dims worked fine. That split
  // is exactly why a spot-check on one dimension proved nothing: I verified
  // this statement against a live server using GROUPING(branch_id) and it
  // passed, which is true and irrelevant.
  //
  // MySQL resolves a select alias in HAVING, so `g0 = 1` is both correct and
  // cheaper — and it drops a set of bound params, since the expression is no
  // longer repeated a fourth time.
  const havingParts = dims.map((_, i) => `g${i} = 1`);
  // aggregates first: (1,1,1) grand, then (0,1,1), then (0,0,1) — so a LIMIT
  // trims the deepest, most numerous subtotals and never the grand total.
  const aggOrder = dims.map((_, i) => `g${i} DESC`).join(', ');

  const totalsSql = `SELECT ${selParts.join(', ')}, ${groupingParts.join(', ')}, ${metricSelect} ` +
    `${from} WHERE ${whereSql} GROUP BY ${groupParts.join(', ')} WITH ROLLUP ` +
    `HAVING (${havingParts.join(' OR ')}) ORDER BY ${aggOrder} LIMIT ?`;
  // No havingParams: the alias carries no placeholders of its own.
  const totalsParams = [
    ...selParams, ...groupingParams, ...whereParams, ...groupParams,
    MAX_SUBTOTAL_ROWS,
  ];

  return {
    rows: { sql: rowsSql, params: rowsParams },
    totals: { sql: totalsSql, params: totalsParams },
  };
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
 *   limit?, offset?, includeVoided?, noRollup?, compare?: 'prevPeriod'|'prevYear'
 * }
 * scope: { all, branchIds, caps:Set } from lib/analytics/scope.js.
 * opts:  { mealPeriods: analytics_meal_periods rows (global),
 *          rollupClosedThrough: 'YYYY-MM-DD' | null — the LAST business day
 *            whose rollup is provably complete. null = unknown = live only. }
 *
 * Each returned statement carries:
 *   { source: 'rollup'|'live', combine: 'set'|'add', fact, metrics,
 *     rows, totals }
 * `combine` is the merge rule QueryService must apply when two statements
 * compute the SAME metric id: 'set' replaces, 'add' accumulates. A hybrid plan
 * splits one metric across two disjoint date windows, and only summing them
 * gives the period's number.
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
  // Per-statement fetch depth = everything up to the END of the requested page,
  // clamped at the declared hard cap. It is NOT the page size: statements are
  // merged on the dimension key in QueryService, and two sources ordered by
  // different columns would otherwise fetch DISJOINT slices whose merged page
  // shows silent zeros for the secondary source's metrics. Fetch the head,
  // merge, then cut the page — and when the clamp bites, say so
  // (meta.fetchCapped → page.truncated) rather than serve a short page as if it
  // were the end of the data.
  //
  // The MAX_LIMIT floor is deliberate and is NOT about paging depth: a
  // statement that returns exactly `fetchN` rows is treated as truncated, and
  // its metrics then fill with null instead of 0 on keys it never reached
  // (see QueryService's zero-fill note). Fetching only offset+limit would make
  // a 50-row first page of a 300-row report look truncated and blank out
  // columns that are perfectly well known today. Keeping the old 500-row floor
  // leaves every report that fits inside it behaving exactly as it does now,
  // and changes only the deep pages that were previously unreachable.
  const wantN = Math.max(offset + limit, MAX_LIMIT);
  const fetchN = Math.min(wantN, MAX_FETCH_ROWS);
  const fetchCapped = wantN > MAX_FETCH_ROWS;

  const defaultsApplied = new Set();

  // ── SOURCE ROUTING ───────────────────────────────────────────────────────
  // Decide, from the registry alone, whether a rollup can answer this request
  // and how much of the requested window it can answer. See the module header
  // for why each of these is disqualifying.
  const closedThrough = ISO_DAY_RE.test(String(opts.rollupClosedThrough || ''))
    ? String(opts.rollupClosedThrough) : null;

  let rollupPlanByMetric = null;   // Map<sourceId, {src, metricIds[]}>
  const rollupBlockers = [];
  if (req.noRollup === true) {
    rollupBlockers.push('noRollup');
  } else if (!closedThrough) {
    rollupBlockers.push('horizon_unknown');
  } else if (basis !== 'business_day') {
    rollupBlockers.push('date_basis');
  } else if (req.includeVoided === true) {
    rollupBlockers.push('includeVoided');
  } else if (hasStatusFilter) {
    rollupBlockers.push('order_status_filter');
  } else if (hasSourceFilter) {
    rollupBlockers.push('source_filter');
  } else if (additiveIds.some((id) => liftsVoidExclusion(METRICS.byId[id]))) {
    rollupBlockers.push('voids_metric');
  } else if (closedThrough < req.range.from) {
    rollupBlockers.push('window_entirely_open');
  } else {
    // Every requested/filtered dimension AND every additive metric must live
    // on one source; a metric that needs a source which cannot express the
    // grouping disqualifies the request, it does not get its own grouping.
    const neededDimIds = [...new Set([...dims.map((d) => d.id), ...filterDims.map((d) => d.id)])];
    const assignment = new Map();
    let ok = true;
    for (const id of additiveIds) {
      const src = ROLLUP_SOURCES.find((s) =>
        s.metrics[id] && neededDimIds.every((dimId) => s.dims[dimId]));
      if (!src) {
        ok = false;
        // Name the WHOLE combination, not just the metric: "net_ex_vat" is
        // expressible on its own and the reason it fell back is the grouping
        // it was asked for. A blocker that blames the wrong half sends the
        // next reader looking in the wrong file.
        rollupBlockers.push(
          `no_rollup_expresses:${id}` + (neededDimIds.length ? ` by ${neededDimIds.join('+')}` : ''));
        break;
      }
      if (!assignment.has(src.id)) assignment.set(src.id, { src, metricIds: [] });
      assignment.get(src.id).metricIds.push(id);
    }
    if (ok) rollupPlanByMetric = assignment;
  }

  // The window split. rollupTo is the last day the rollup owns; liveFrom is the
  // first day the raw facts own. A request whose whole window is closed is pure
  // rollup; one that reaches into today is served hybrid — rollup for the
  // settled days plus a live tail — because the alternative is either a stale
  // "today" or scanning a year of facts to read one open day.
  const rollupTo = rollupPlanByMetric
    ? (closedThrough < req.range.to ? closedThrough : req.range.to) : null;
  const liveFrom = rollupTo && rollupTo < req.range.to ? addDaysIso(rollupTo, 1) : null;
  const useRollup = !!rollupPlanByMetric;
  const useLive = !useRollup || !!liveFrom;

  const statements = [];

  // ── rollup statements ────────────────────────────────────────────────────
  if (useRollup) {
    for (const { src, metricIds } of rollupPlanByMetric.values()) {
      const dimExprs = dims.map((d) => ({ sql: src.dims[d.id], params: [] }));

      const whereParts = [`${src.dayColumn} BETWEEN ? AND ?`];
      const whereParams = [req.range.from, rollupTo];

      for (let i = 0; i < filters.length; i++) {
        const d = filterDims[i];
        const clause = filterClauseFrom(d, { sql: src.dims[d.id], params: [] }, filters[i]);
        // Unreachable by construction (the assignment above required every
        // filter dimension), but a null clause silently dropping a filter would
        // widen the population, so it is refused rather than trusted.
        if (!clause) {
          throw perr('ANALYTICS_UNSUPPORTED_COMBINATION', 422,
            `filter dimension "${d.id}" is not available on rollup "${src.id}"`);
        }
        whereParts.push(clause.sql);
        whereParams.push(...clause.params);
      }

      // scope — ALWAYS for non-global, exactly as on a live fact.
      if (!scope || !scope.all) {
        const branchIds = (scope && scope.branchIds) || [];
        if (!branchIds.length) {
          whereParts.push('1=0'); // fail-closed: zero grants → zero rows
        } else {
          const ph = branchIds.map(() => '?').join(',');
          whereParts.push(`${src.scopeColumn} IN (${ph})`);
          whereParams.push(...branchIds.map(String));
        }
      }

      const emitted = emitStatementSql({
        dims,
        dimExprs,
        metricDefs: metricIds.map((id) => ({ id, sql: src.metrics[id] })),
        from: src.from,
        whereSql: whereParts.join(' AND '),
        whereParams,
        sortSpecs,
        fetchN,
      });

      statements.push({
        source: 'rollup',
        combine: 'set',
        fact: src.id,
        table: src.table,
        metrics: metricIds.slice(),
        range: { from: req.range.from, to: rollupTo },
        rows: emitted.rows,
        totals: emitted.totals,
      });
    }
    // The rollup is BUILT with both defaults applied (RollupService's parity
    // contract), so the response must keep reporting them — the numbers really
    // do exclude voids and credit-note documents.
    defaultsApplied.add('excluded_voided');
    defaultsApplied.add('excluded_credit_note_docs');
  }

  // ── live statements ──────────────────────────────────────────────────────
  if (useLive) {
    // A hybrid plan's live half covers ONLY the open tail; a pure-live plan
    // covers the whole window. The two windows never overlap, which is what
    // makes 'add' a sum and not a double count.
    const fromDay = useRollup ? liveFrom : req.range.from;
    const toDay = req.range.to;
    const combine = useRollup ? 'add' : 'set';

    // ── partition additive metrics by fact ───────────────────────────────
    const byFact = new Map();
    for (const id of additiveIds) {
      const m = METRICS.byId[id];
      if (!byFact.has(m.fact)) byFact.set(m.fact, []);
      byFact.get(m.fact).push(m);
    }

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
      whereParams.push(fromDay, toDay);

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
        const hasVoidMetric = factMetrics.some((m) => liftsVoidExclusion(m));
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

      const emitted = emitStatementSql({
        dims,
        dimExprs,
        metricDefs: factMetrics.map((m) => ({ id: m.id, sql: m.sql })),
        from: fact.from,
        whereSql: whereParts.join(' AND '),
        whereParams,
        sortSpecs,
        fetchN,
      });

      statements.push({
        source: 'live',
        combine,
        fact: factId,
        metrics: factMetrics.map((m) => m.id),
        range: { from: fromDay, to: toDay },
        rows: emitted.rows,
        totals: emitted.totals,
      });
    }
  }

  const source = useRollup ? (useLive ? 'hybrid' : 'rollup') : 'live';

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
      fetchCapped,
      maxFetchRows: MAX_FETCH_ROWS,
      sort: sortSpecs,
      // Which physical source really answered — never a hardcoded 'live'.
      source,
      rollup: {
        closedThrough,
        // The exact window each half owns, so a caller (or a bug report) can
        // see WHERE the seam sits rather than guessing.
        rollupRange: useRollup ? { from: req.range.from, to: rollupTo } : null,
        liveRange: useLive
          ? { from: useRollup ? liveFrom : req.range.from, to: req.range.to } : null,
        // Why a request stayed live. Empty on a rollup/hybrid plan.
        blockers: rollupBlockers,
      },
    },
  };
}

module.exports = {
  plan,
  MAX_RANGE_DAYS, MAX_DIMENSIONS, MAX_METRICS, DEFAULT_LIMIT, MAX_LIMIT,
  MAX_FETCH_ROWS, MAX_SUBTOTAL_ROWS,
  DATE_BASES,
  // exported for tests / anyone auditing what the rollup path may answer
  ROLLUP_SOURCES,
  addDaysIso,
};
