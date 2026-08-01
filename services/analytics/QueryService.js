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
 * LANGUAGE: `request.lang` ('en' | 'ar', default 'ar') selects the language the
 * LABELS resolve in — it changes no number, no filter and no SQL of the fact
 * query. It rides on the request (not on a header or an opts field) for one
 * reason: the cache key is a hash of the request, so two languages can never
 * share a cache entry. See attachLabels for what it does per dimension.
 *
 * SOURCE ROUTING: before planning, run() reads the rollup horizon (the last
 * business day whose rollup is provably complete — see readRollupHorizon) and
 * hands it to the planner, which decides per request whether the pre-aggregated
 * rollup tables can answer it, whether a live tail is needed for the open days,
 * or whether the raw facts must serve the whole window. The verdict rides out
 * as meta.source ('rollup' | 'live' | 'hybrid') and is also written over
 * meta.freshness.source, which used to be the constant 'live'. A hybrid plan
 * marks its live statements combine:'add' — the two halves cover DISJOINT date
 * windows and the period's figure is their sum.
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
const displayName = require('../../lib/displayName');

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

/** Driver value → a finite number. Non-numeric and NULL are 0, same as
 *  fmtMetric's contract, but WITHOUT rounding: accumulation happens in full
 *  precision and is rounded exactly once, at the end. Rounding each half of a
 *  hybrid window and then adding would let a rollup+live answer differ from the
 *  all-live answer by a halala on every row — a routing change that moves money
 *  is a money bug, however small. */
function rawNum(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fold one statement's value for `id` into `values`.
 * combine 'add' is what a HYBRID plan needs: the rollup statement and the live
 * tail compute the SAME metric over DISJOINT date windows, and the period's
 * number is their sum. 'set' is the ordinary single-source case.
 */
function foldMetric(values, id, raw, combine) {
  const n = rawNum(raw);
  values[id] = combine === 'add' ? rawNum(values[id]) + n : n;
}

/** Round every accumulated additive value ONCE, after every statement has
 *  contributed. Runs before the zero/null fill so it can never turn a
 *  deliberate `null` ("this fact never looked") into a confident 0. */
function formatAccumulated(values) {
  for (const id of Object.keys(values)) values[id] = fmtMetric(id, values[id]);
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
  const cappedStatements = new Set();

  for (const st of plan.statements) {
    if (cancelState && cancelState.cancelled) {
      const e = new Error('client disconnected'); e.code = 'ANALYTICS_CANCELLED'; e.http = 499; throw e;
    }
    const combine = st.combine === 'add' ? 'add' : 'set';
    const [rows] = await conn.query(st.rows.sql, st.rows.params);
    if (nd === 0) {
      // single aggregate row (may be a NULL-sum row on an empty range)
      const r = rows[0] || {};
      for (const id of st.metrics) foldMetric(grand, id, r['m_' + id], combine);
      sawGrand = true;
      continue;
    }
    // Per-STATEMENT, not just per-request: which fact ran out of fetch depth
    // decides whose missing values are an honest zero and whose are unknown.
    if (rows.length >= plan.meta.fetchN) { anyCapped = true; cappedStatements.add(st); }
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
      for (const id of st.metrics) foldMetric(row.values, id, r['m_' + id], combine);
    }

    // Totals + subtotals. The statement is now HAVING-filtered server-side, so
    // only super-aggregate rows come back; the `rolled === 0` guard below stays
    // because a fake/legacy driver may still hand us detail rows and silently
    // treating one as a subtotal would print a single group's figure as the
    // period total.
    const [trows] = await conn.query(st.totals.sql, st.totals.params);
    for (const r of trows) {
      const flags = [];
      for (let i = 0; i < nd; i++) flags.push(Number(r['g' + i]) === 1);
      const rolled = flags.filter(Boolean).length;
      if (rolled === 0) continue;              // detail row — rows stmt owns it
      if (rolled === nd) {                     // grand total
        for (const id of st.metrics) foldMetric(grand, id, r['m_' + id], combine);
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
      for (const id of st.metrics) foldMetric(sub.values, id, r['m_' + id], combine);
    }
  }

  // Every statement has contributed; round the accumulated money exactly once.
  for (const row of rowsByKey.values()) formatAccumulated(row.values);
  for (const sub of subtotalsByKey.values()) formatAccumulated(sub.values);
  formatAccumulated(grand);

  /*
   * Fill the metrics a fact did not contribute for a key.
   *
   * ZERO IS ONLY TRUE WHEN THE FACT ACTUALLY LOOKED.
   *   Every fact statement fetches its OWN top-`fetchN` slice, and when the
   *   sort metric does not live on a fact the planner falls back to
   *   `ORDER BY d0` for it (planner.js emitStatementSql) — a lexicographic
   *   slice of one dimension, not a metric ranking. So two facts can each
   *   return a full fetch window of rows
   *   that barely intersect. Zero-filling the gap then prints a fabricated 0
   *   that is indistinguishable from a real one:
   *
   *     BR2 2025-12-06 h20   net 1,714.48   orders 0     ← truth: 6
   *
   *   A top-selling hour with no orders. Measured on a 400-day synthetic set,
   *   grouping branch × day × hour: 10 of 10 visible rows wrong.
   *
   *   The fix is not to hide the row — the sales figure on it is real — but to
   *   stop asserting the part we did not measure. A CAPPED statement's metrics
   *   fill with null, which every consumer already renders as "—" and which
   *   api.ts documents as "not computable; render '—', never 0". An honest
   *   unknown beats a confident wrong number.
   *
   *   `anyCapped` still rides out as page.rowCountCapped so the UI can say why.
   */
  const allAdditive = plan.meta.additiveMetrics;
  const truncated = new Set();
  for (const st of plan.statements) {
    if (cappedStatements.has(st)) for (const id of st.metrics) truncated.add(id);
  }
  const fill = (values) => {
    for (const id of allAdditive) {
      if (values[id] != null) continue;
      values[id] = truncated.has(id) ? null : 0;
    }
  };
  for (const row of rowsByKey.values()) fill(row.values);
  for (const sub of subtotalsByKey.values()) fill(sub.values);
  // The grand total comes from a ROLLUP over the WHOLE grouping, not from the
  // fetched page, so it is unaffected by the cap and still zero-fills.
  if (!sawGrand) for (const id of allAdditive) grand[id] = 0;
  for (const id of allAdditive) if (grand[id] == null) grand[id] = 0;

  return { rowsByKey, subtotalsByKey, grand, anyCapped, truncatedMetrics: [...truncated] };
}

// ── rollup horizon ───────────────────────────────────────────────────────────

/**
 * The LAST business day whose rollup is provably complete, or null when that
 * cannot be established (in which case the planner serves everything live).
 *
 * Two independent conditions, and the answer is the earlier of them:
 *
 *   today − 1        The current business day is still being written to, so it
 *                    is never "closed". business_day can also lag the calendar
 *                    date (a branch closing at 04:00 books a 01:30 sale to
 *                    yesterday), which is exactly what the dirty queue covers.
 *
 *   minDirty − 1     analytics_rollup_dirty holds every (branch, business_day)
 *                    pair whose rollup is out of date. ProjectionService
 *                    enqueues the pair INSIDE the projection transaction and
 *                    RollupService deletes it only after the rebuild has
 *                    committed, so a day with no dirty row is a day whose
 *                    rollup already reflects every fact row written to it. Any
 *                    day at or after the oldest dirty day is therefore suspect
 *                    and must be answered live.
 *
 * CURDATE() comes from the DB session (the same +03:00 clock the facts are
 * written on) rather than from Node — a server whose OS clock drifts would
 * otherwise start serving today's trade out of yesterday's rollup.
 *
 * ANY failure here — table not migrated, permission, a driver hiccup — returns
 * null, which means "live only". Fail-closed toward correctness: an unavailable
 * horizon must never be read as "everything is closed".
 */
async function readRollupHorizon(db, offsetMin) {
  try {
    const [rows] = await db.query(
      'SELECT (SELECT MIN(business_day) FROM analytics_rollup_dirty) AS min_dirty, CURDATE() AS today');
    if (!rows || !rows.length) return null;
    const today = normDimValue(rows[0].today, offsetMin);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return null;
    let closed = planner.addDaysIso(today, -1);
    const minDirty = normDimValue(rows[0].min_dirty, offsetMin);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(minDirty || ''))) {
      const beforeDirty = planner.addDaysIso(minDirty, -1);
      if (beforeDirty < closed) closed = beforeDirty;
    }
    return closed;
  } catch (_) {
    return null;
  }
}

// ── labels ───────────────────────────────────────────────────────────────────

/** NULLIF(TRIM(x),'') semantics, the rule the rest of the repo already uses:
 *  a whitespace-only column is EMPTY, not a name. */
function _labelText(v) {
  return v == null ? '' : String(v).trim();
}

/** 'en' | 'ar'. Anything else — absent, a locale tag, junk — is Arabic, which
 *  is what every caller got before a language existed. */
function normLang(v) {
  return String(v || '').trim().toLowerCase().slice(0, 2) === 'en' ? 'en' : 'ar';
}

/**
 * ids → display strings for every labeled dimension on the PAGE.
 *
 * TWO resolvers, chosen by the registry descriptor (registry/dimensions.js):
 *
 *   resolver:'person' — lib/displayName.js, the ONE authority for "what is this
 *     person called" (users.full_name → settings.user_meta[username].name →
 *     username). Employee fact columns hold usernames, so without this a report
 *     grouped by cashier printed the login id. It is called rather than
 *     re-implemented so a person cannot be named one thing on the receipt and
 *     another in the report.
 *
 *   table/idCol/cols — a master-table read. When the caller asked for English
 *     AND the descriptor declares `enCol`, the English column wins; when that
 *     column is NULL/blank the PRIMARY name is shown and the row is flagged in
 *     `labelFallback` — a silent Arabic fallback is indistinguishable from a
 *     translation, and the reader must be able to tell them apart.
 *
 * The flag is STRUCTURED DATA (row.labelFallback[dimId] === true), never a
 * marker glued onto the string: labels are exported to CSV, where a "‡" would
 * become part of the data.
 *
 * @param {'en'|'ar'} lang the language the caller asked for.
 */
async function attachLabels(conn, dims, pageRows, lang) {
  const wantEn = normLang(lang) === 'en';
  const labelsByDim = {};
  const fallbackByDim = {};
  for (const dimId of dims) {
    const d = DIMS.byId[dimId];
    if (!d || !d.label) continue;
    const ids = [...new Set(pageRows.map((r) => r.keys[dimId]).filter((v) => v != null))];
    if (!ids.length) continue;

    if (d.label.resolver === 'person') {
      try {
        const people = await displayName.resolveCashierIdentities(conn, ids.map(String));
        const map = {};
        for (const uname of Object.keys(people)) {
          const nm = _labelText(people[uname].name);
          map[uname] = nm || null;
        }
        labelsByDim[dimId] = map;
      } catch (_) { /* a cosmetic name may never break a report */ }
      continue;
    }

    try {
      // table/idCol/cols/enCol are REGISTRY constants — never request input.
      const cols = d.label.cols.map((c) => `\`${c}\``).join(', ');
      const [rows] = await conn.query(
        `SELECT \`${d.label.idCol}\` AS __id, ${cols} FROM \`${d.label.table}\` WHERE \`${d.label.idCol}\` IN (?)`,
        [ids]);
      const enCol = d.label.enCol && d.label.cols.indexOf(d.label.enCol) >= 0 ? d.label.enCol : null;
      const map = {};
      const missing = {};
      for (const r of rows) {
        const primary = _labelText(r[d.label.cols[0]]);
        const english = enCol ? _labelText(r[enCol]) : '';
        let text = primary;
        if (wantEn && enCol) {
          if (english) text = english;
          else if (primary) missing[String(r.__id)] = true; // shown, but NOT English
        }
        map[String(r.__id)] = text || null;
      }
      labelsByDim[dimId] = map;
      if (Object.keys(missing).length) fallbackByDim[dimId] = missing;
    } catch (_) { /* label table missing — rows keep raw keys */ }
  }
  for (const row of pageRows) {
    row.labels = {};
    row.labelFallback = {};
    for (const dimId of dims) {
      const map = labelsByDim[dimId];
      const v = row.keys[dimId];
      if (map && v != null && map[String(v)] != null) row.labels[dimId] = map[String(v)];
      const miss = fallbackByDim[dimId];
      if (miss && v != null && miss[String(v)]) row.labelFallback[dimId] = true;
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
  const offsetMin = _dbOffsetMinutes(db);
  const rollupClosedThrough = await readRollupHorizon(db, offsetMin);

  // The horizon is part of the cache identity. The watermark alone is not
  // enough: it advances when the worker drains, but the horizon ALSO moves at
  // midnight with no write anywhere, and a cached hybrid answer keyed only on
  // the watermark would keep serving yesterday's live tail as today's.
  const cacheKey = crypto.createHash('sha256')
    .update(_stable(request) + '|' + scopeLib.scopeHash(scope) + '|' + String(fresh.watermark) +
      '|' + String(rollupClosedThrough))
    .digest('hex');
  if (request && request.noCache !== true) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }

  const plan = planner.plan(request, scope, { mealPeriods, rollupClosedThrough });

  const conn = await db.getConnection();
  cancelState.threadId = (conn.connection && conn.connection.threadId) || null;
  try {
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

    /*
     * SORT, THEN PAGE — and why this is OFFSET paging rather than keyset.
     *
     * A keyset ("seek") cursor works by pushing `WHERE (sortkey) < :last` into
     * the SQL, and nothing here can do that honestly:
     *   • the page is cut AFTER a cross-fact merge in Node, so the ordering the
     *     reader pages through is not the ordering of any single statement;
     *   • the sort key is frequently a metric that the fact being seeked does
     *     not compute (the planner already falls back to `ORDER BY d0` for it),
     *     and it can be a DERIVED metric that exists only once the merge and
     *     equations have run — there is no column to compare against;
     *   • a hybrid plan splits one metric across two statements, so even a
     *     shared metric's per-statement value is not the value being sorted on.
     * A cursor built on any of those would skip or repeat rows. Offset paging
     * over the merged, sorted set is the mechanism that is actually correct
     * here; what was broken was that it never fetched deep enough to reach the
     * offset (see planner.MAX_FETCH_ROWS), and that is what is fixed.
     */
    sortMerged(mergedRows, plan.meta.sort, plan);
    const pageRows = mergedRows.slice(plan.meta.offset, plan.meta.offset + plan.meta.limit);

    // Is what we merged the WHOLE result, or only as far as the fetch reached?
    // Either a statement filled its fetch window (there is more behind it) or
    // the requested page ran past the declared hard cap. In both cases the row
    // count is a floor, not a total, and must not be published as one.
    const exhausted = !!exec.anyCapped || !!plan.meta.fetchCapped;
    const totalMerged = mergedRows.length;
    const hasMore = exhausted
      ? true // we cannot see past the cap, so we must not claim this is the end
      : (plan.meta.offset + pageRows.length) < totalMerged;

    // ── compare window ──
    let compareTotals = null;
    let totalsDelta = null;
    const mode = request && request.compare;
    if (mode === 'prevPeriod' || mode === 'prevYear') {
      const prevRange = compare.shiftRange(plan.meta.range, mode);
      const prevReq = Object.assign({}, request, { range: prevRange, compare: null, noCache: true });
      const prevPlan = planner.plan(prevReq, scope, { mealPeriods, rollupClosedThrough });
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

    // labels — one batched lookup per labeled dim, for the PAGE only.
    // `request.lang` is part of the request, so it is part of the cache key
    // above: an English page can never be served out of the Arabic entry.
    await attachLabels(conn, dims, pageRows, request && request.lang);

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
          // labelFallback[dimId] === true ⇒ the label in `labels` is NOT in the
          // requested language (the English name is genuinely missing) — a flag,
          // never a marker inside the string, because labels reach CSV.
          const out = {
            keys: r.keys,
            labels: r.labels || {},
            labelFallback: r.labelFallback || {},
            values: pickRequested(r.values, requested),
          };
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
          // Which metrics came from a TRUNCATED fact statement. Their missing
          // values are null ("—"), not 0, and the UI names them so the reader
          // knows which column to distrust rather than the whole page.
          truncatedMetrics: exec.truncatedMetrics || [],
          // ── real paging ──
          // hasMore: false ONLY on a page we can prove is the last one.
          hasMore,
          // total is the merged row count, and totalIsExact says whether that
          // count is the whole result or just how far the fetch reached. A
          // caller that shows "1–50 of 500" must read the flag: publishing a
          // floor as a total is how an export of 4,000 rows got presented as a
          // complete 500-row file.
          total: exhausted ? null : totalMerged,
          totalIsExact: !exhausted,
          // The declared hard cap was hit — the result is KNOWN-incomplete.
          // Anything writing a file must record this; a partial export may
          // never be handed over as the whole report.
          truncated: exhausted,
          fetchCapped: !!plan.meta.fetchCapped,
          maxFetchRows: plan.meta.maxFetchRows,
        },
      },
      meta: {
        // The physical source that actually answered. This used to be a
        // hardcoded 'live' in lib/analytics/freshness.js while the four rollup
        // tables sat unread; freshness.source is overwritten here so the
        // envelope cannot carry two different answers to the same question.
        source: plan.meta.source,
        rollup: plan.meta.rollup,
        freshness: Object.assign({}, fresh, { source: plan.meta.source }),
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
