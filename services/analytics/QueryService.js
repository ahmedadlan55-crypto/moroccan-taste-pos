/**
 * services/analytics/QueryService.js — executes a planned analytics request.
 *
 * plan (lib/analytics/planner) → per-fact statements → execute on ONE
 * dedicated pool connection → merge rows across facts on the composite
 * dimension key (a fact that has no row for a key contributes ZEROS) →
 * derived metrics via lib/analytics/equations (the one arithmetic contract)
 * → optional compare window (lib/analytics/compare) → labels (one batched
 * IN query per labeled dimension, page rows only) → envelope.
 *
 * NO cross-fact SQL joins, ever — merging is the only way facts meet.
 *
 * CACHE: in-memory Map, key = sha256(stableStringify(request) + scopeHash +
 * freshness watermark), TTL 60s, max 200 entries, LRU-ish (hit re-inserts;
 * overflow evicts the oldest). `request.noCache: true` bypasses both read
 * and write — tests and "hard refresh" callers use it. With no rollup
 * watermark yet, a cached answer can be up to 60s stale by design.
 *
 * CANCELLATION: run() takes opts.cancelState ({cancelled:false}). The route
 * flips `cancelled` when the client disconnects; killIfRunning() issues a
 * best-effort KILL QUERY <threadId> from a second connection. Both paths are
 * wrapped — a failed KILL can never take the server down.
 */
'use strict';

const crypto = require('crypto');

const planner = require('../../lib/analytics/planner');
const compare = require('../../lib/analytics/compare');
const freshness = require('../../lib/analytics/freshness');
const scopeLib = require('../../lib/analytics/scope');
const EQ = require('../../lib/analytics/equations');
const METRICS = require('../../lib/analytics/registry/metrics');
const DIMS = require('../../lib/analytics/registry/dimensions');

// ── stable stringify ─────────────────────────────────────────────────────────
// Reuse the O2C fingerprint helper if it's exported; else a local equivalent.
let _stable;
try {
  const http = require('../../lib/order-to-cash/http');
  _stable = typeof http._stable === 'function' ? http._stable : null;
} catch (_) { _stable = null; }
if (!_stable) {
  _stable = function stable(v) {
    if (v === undefined || v === null) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  };
}

// ── cache ────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 200;
const _cache = new Map(); // key → { at, envelope }

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { _cache.delete(key); return null; }
  _cache.delete(key); _cache.set(key, hit); // LRU-ish: refresh position
  return hit.envelope;
}
function cacheSet(key, envelope) {
  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { at: Date.now(), envelope });
}

// ── value normalization ──────────────────────────────────────────────────────
// mysql2 (timezone '+03:00') returns DATE columns as JS Dates whose UTC ms =
// wall-clock − offset. Recover the wall-clock calendar date before it becomes
// a grouping key — toISOString() alone would shift it back a day.
function _dbOffsetMinutes(db) {
  const tz = (db && db.DB_TIME_ZONE) || '+03:00';
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(tz));
  if (!m) return 180;
  const min = (+m[2]) * 60 + (+m[3]);
  return m[1] === '-' ? -min : min;
}

function normDimValue(v, offsetMin) {
  if (v == null) return null;
  if (v instanceof Date) {
    const shifted = new Date(v.getTime() + offsetMin * 60000);
    return shifted.toISOString().slice(0, 10);
  }
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return v;
}

function fmtMetric(id, raw) {
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const m = METRICS.byId[id];
  if (m && m.format === 'money') return EQ.roundMoney(n);
  return n;
}

// ── derived computation ──────────────────────────────────────────────────────
function computeDerived(values, derivedIds, grandValues) {
  for (const id of derivedIds) {
    const m = METRICS.byId[id];
    const fn = EQ[m.equationKey];
    if (typeof fn !== 'function') { values[id] = null; continue; }
    if (m.scope === 'group_vs_total') {
      const whole = grandValues ? grandValues[m.inputs[0]] : values[m.inputs[0]];
      values[id] = fn(values[m.inputs[0]], whole);
    } else {
      values[id] = fn(...m.inputs.map((i) => values[i]));
    }
  }
  return values;
}

function pickRequested(values, requested) {
  const out = {};
  for (const id of requested) out[id] = values[id] != null ? values[id] : (values[id] === null ? null : 0);
  return out;
}

// ── execution ────────────────────────────────────────────────────────────────

/**
 * Execute a plan on `conn`, merge across facts.
 * Returns { rowsByKey: Map, subtotalsByKey: Map, grand: {} }.
 */
async function executePlan(conn, plan, offsetMin, cancelState) {
  const dims = plan.meta.dims;
  const nd = dims.length;
  const rowsByKey = new Map();       // keyJson → { keys:{}, values:{} }
  const subtotalsByKey = new Map();  // level|keyJson → { level, keys:{}, values:{} }
  const grand = {};
  let sawGrand = false;
  let anyCapped = false;

  for (const st of plan.statements) {
    if (cancelState && cancelState.cancelled) {
      const e = new Error('client disconnected'); e.code = 'ANALYTICS_CANCELLED'; e.http = 499; throw e;
    }
    const [rows] = await conn.query(st.rows.sql, st.rows.params);
    if (nd === 0) {
      // single aggregate row (may be a NULL-sum row on an empty range)
      const r = rows[0] || {};
      for (const id of st.metrics) {
        grand[id] = fmtMetric(id, r['m_' + id]);
      }
      sawGrand = true;
      continue;
    }
    if (rows.length >= plan.meta.fetchN) anyCapped = true;
    for (const r of rows) {
      const keyVals = [];
      const keys = {};
      for (let i = 0; i < nd; i++) {
        const v = normDimValue(r['d' + i], offsetMin);
        keyVals.push(v);
        keys[dims[i]] = v;
      }
      const keyJson = JSON.stringify(keyVals);
      let row = rowsByKey.get(keyJson);
      if (!row) { row = { keys, values: {} }; rowsByKey.set(keyJson, row); }
      for (const id of st.metrics) row.values[id] = fmtMetric(id, r['m_' + id]);
    }

    // totals / subtotals via ROLLUP + GROUPING flags
    const [trows] = await conn.query(st.totals.sql, st.totals.params);
    for (const r of trows) {
      const flags = [];
      for (let i = 0; i < nd; i++) flags.push(Number(r['g' + i]) === 1);
      const rolled = flags.filter(Boolean).length;
      if (rolled === 0) continue;              // detail row — rows stmt owns it
      if (rolled === nd) {                     // grand total
        for (const id of st.metrics) grand[id] = fmtMetric(id, r['m_' + id]);
        sawGrand = true;
        continue;
      }
      const level = nd - rolled;               // how many leading dims are grouped
      const keyVals = [];
      const keys = {};
      for (let i = 0; i < level; i++) {
        const v = normDimValue(r['d' + i], offsetMin);
        keyVals.push(v);
        keys[dims[i]] = v;
      }
      const skey = level + '|' + JSON.stringify(keyVals);
      let sub = subtotalsByKey.get(skey);
      if (!sub) { sub = { level, keys, values: {} }; subtotalsByKey.set(skey, sub); }
      for (const id of st.metrics) sub.values[id] = fmtMetric(id, r['m_' + id]);
    }
  }

  // zero-fill additive metrics a fact never contributed
  const allAdditive = plan.meta.additiveMetrics;
  const zeroFill = (values) => {
    for (const id of allAdditive) if (values[id] == null) values[id] = 0;
  };
  for (const row of rowsByKey.values()) zeroFill(row.values);
  for (const sub of subtotalsByKey.values()) zeroFill(sub.values);
  if (!sawGrand) for (const id of allAdditive) grand[id] = 0;
  zeroFill(grand);

  return { rowsByKey, subtotalsByKey, grand, anyCapped };
}

// ── labels ───────────────────────────────────────────────────────────────────
async function attachLabels(conn, dims, pageRows) {
  const labelsByDim = {};
  for (const dimId of dims) {
    const d = DIMS.byId[dimId];
    if (!d || !d.label) continue;
    const ids = [...new Set(pageRows.map((r) => r.keys[dimId]).filter((v) => v != null))];
    if (!ids.length) continue;
    try {
      // table/idCol/cols are REGISTRY constants — never request input.
      const cols = d.label.cols.map((c) => `\`${c}\``).join(', ');
      const [rows] = await conn.query(
        `SELECT \`${d.label.idCol}\` AS __id, ${cols} FROM \`${d.label.table}\` WHERE \`${d.label.idCol}\` IN (?)`,
        [ids]);
      const map = {};
      for (const r of rows) {
        const primary = r[d.label.cols[0]];
        map[String(r.__id)] = primary != null ? String(primary) : null;
      }
      labelsByDim[dimId] = map;
    } catch (_) { /* label table missing — rows keep raw keys */ }
  }
  for (const row of pageRows) {
    row.labels = {};
    for (const dimId of dims) {
      const map = labelsByDim[dimId];
      const v = row.keys[dimId];
      if (map && v != null && map[String(v)] != null) row.labels[dimId] = map[String(v)];
    }
  }
}

// ── sorting (post-merge, cross-fact-correct) ─────────────────────────────────
function sortMerged(rows, sortSpecs, plan) {
  const specs = sortSpecs.length ? sortSpecs
    : [{ by: plan.meta.requestedMetrics[0], dir: 'desc', kind: METRICS.byId[plan.meta.requestedMetrics[0]] ? 'metric' : 'dimension' }];
  rows.sort((a, b) => {
    for (const s of specs) {
      let av, bv;
      if (s.kind === 'metric') { av = a.values[s.by]; bv = b.values[s.by]; }
      else { av = a.keys[s.by]; bv = b.keys[s.by]; }
      if (av == null && bv == null) continue;
      if (av == null) return 1;              // nulls last, both directions
      if (bv == null) return -1;
      let cmp;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av) < String(bv) ? -1 : (String(av) > String(bv) ? 1 : 0);
      if (cmp !== 0) return s.dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
  return rows;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * run(db, request, scope, opts) → response envelope (see module header).
 * opts: { cancelState?: {cancelled:boolean, threadId:number|null} }
 */
async function run(db, request, scope, opts = {}) {
  const cancelState = opts.cancelState || { cancelled: false, threadId: null };

  // meal-period config (global rows only, v1) — loaded before planning
  let mealPeriods = null;
  const needsMeal =
    (Array.isArray(request && request.dimensions) && request.dimensions.includes('meal_period')) ||
    (Array.isArray(request && request.filters) && request.filters.some((f) => f && f.dimension === 'meal_period'));
  if (needsMeal) {
    const [rows] = await db.query(
      'SELECT period_key, start_time, end_time, sort FROM analytics_meal_periods WHERE branch_id IS NULL ORDER BY sort, period_key');
    mealPeriods = rows.map((r) => ({
      period_key: String(r.period_key),
      start_time: String(r.start_time),
      end_time: String(r.end_time),
      sort: Number(r.sort) || 0,
    }));
  }

  const fresh = await freshness.read(db);

  const cacheKey = crypto.createHash('sha256')
    .update(_stable(request) + '|' + scopeLib.scopeHash(scope) + '|' + String(fresh.watermark))
    .digest('hex');
  if (request && request.noCache !== true) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }

  const plan = planner.plan(request, scope, { mealPeriods });

  const conn = await db.getConnection();
  cancelState.threadId = (conn.connection && conn.connection.threadId) || null;
  try {
    const offsetMin = _dbOffsetMinutes(db);
    const exec = await executePlan(conn, plan, offsetMin, cancelState);

    const dims = plan.meta.dims;
    const requested = plan.meta.requestedMetrics;
    const derived = plan.meta.derivedMetrics;

    // grand + subtotals + rows: derived metrics computed against the grand
    computeDerived(exec.grand, derived, exec.grand);
    const mergedRows = [...exec.rowsByKey.values()];
    for (const row of mergedRows) computeDerived(row.values, derived, exec.grand);
    const subtotals = [...exec.subtotalsByKey.values()];
    for (const sub of subtotals) computeDerived(sub.values, derived, exec.grand);

    // sort merged rows (cross-fact correct), then page
    sortMerged(mergedRows, plan.meta.sort, plan);
    const pageRows = mergedRows.slice(plan.meta.offset, plan.meta.offset + plan.meta.limit);

    // ── compare window ──
    let compareTotals = null;
    let totalsDelta = null;
    const mode = request && request.compare;
    if (mode === 'prevPeriod' || mode === 'prevYear') {
      const prevRange = compare.shiftRange(plan.meta.range, mode);
      const prevReq = Object.assign({}, request, { range: prevRange, compare: null, noCache: true });
      const prevPlan = planner.plan(prevReq, scope, { mealPeriods });
      const prevExec = await executePlan(conn, prevPlan, offsetMin, cancelState);
      computeDerived(prevExec.grand, derived, prevExec.grand);
      const prevRows = new Map();
      for (const [k, v] of prevExec.rowsByKey) {
        computeDerived(v.values, derived, prevExec.grand);
        prevRows.set(k, v);
      }
      const deltaOf = (cur, prev) => ({
        abs: EQ.round2((Number(cur) || 0) - (Number(prev) || 0)),
        pct: EQ.growth(cur, prev),
      });
      for (const row of pageRows) {
        const keyJson = JSON.stringify(dims.map((d) => row.keys[d]));
        const prev = prevRows.get(keyJson);
        row.compare = {};
        row.delta = {};
        for (const id of requested) {
          // A group absent from the previous window: additive metrics are
          // honestly 0 (nothing summed); derived ratios are honestly NULL
          // (an avg_ticket of "0" would read as a real zero-value ticket).
          const kind = METRICS.byId[id] && METRICS.byId[id].kind;
          const absentVal = kind === 'derived' ? null : 0;
          const prevVal = prev ? (prev.values[id] !== undefined ? prev.values[id] : absentVal) : absentVal;
          row.compare[id] = prevVal;
          row.delta[id] = prevVal == null
            ? { abs: null, pct: null }
            : deltaOf(row.values[id], prevVal);
        }
      }
      compareTotals = pickRequested(prevExec.grand, requested);
      totalsDelta = {};
      for (const id of requested) totalsDelta[id] = deltaOf(exec.grand[id], prevExec.grand[id]);
    }

    // labels — one batched lookup per labeled dim, for the PAGE only
    await attachLabels(conn, dims, pageRows);

    const columns = [
      ...dims.map((d) => ({ key: d, type: 'dimension' })),
      ...requested.map((id) => {
        const m = METRICS.byId[id];
        return { key: id, type: 'metric', format: m.format, definitionVersion: m.version };
      }),
    ];

    const envelope = {
      success: true,
      data: {
        columns,
        rows: pageRows.map((r) => {
          const out = { keys: r.keys, labels: r.labels || {}, values: pickRequested(r.values, requested) };
          if (r.compare) { out.compare = r.compare; out.delta = r.delta; }
          return out;
        }),
        subtotals: subtotals
          .sort((a, b) => a.level - b.level)
          .map((s) => ({ level: s.level, keys: s.keys, values: pickRequested(s.values, requested) })),
        totals: Object.assign(
          { values: pickRequested(exec.grand, requested) },
          compareTotals ? { compare: compareTotals, delta: totalsDelta } : {}
        ),
        page: {
          limit: plan.meta.limit,
          offset: plan.meta.offset,
          rowCountCapped: !!exec.anyCapped,
        },
      },
      meta: {
        freshness: fresh,
        completeness: [],
        maskedMetrics: plan.meta.maskedMetrics,
        defaultsApplied: plan.meta.defaultsApplied,
      },
      generatedAt: new Date().toISOString(),
    };

    if (!(request && request.noCache === true)) cacheSet(cacheKey, envelope);
    return envelope;
  } finally {
    cancelState.threadId = null;
    try { conn.release(); } catch (_) { /* never throw from cleanup */ }
  }
}

/**
 * Best-effort cancellation: KILL QUERY on the worker connection's thread from
 * a second connection. Wrapped top to bottom — never throws, never crashes.
 */
async function killIfRunning(db, cancelState) {
  try {
    if (!cancelState) return;
    cancelState.cancelled = true;
    const tid = Number(cancelState.threadId);
    if (!Number.isInteger(tid) || tid <= 0) return;
    await db.query(`KILL QUERY ${tid}`);
  } catch (_) { /* the query may have already finished — fine */ }
}

module.exports = { run, killIfRunning, _cache };
