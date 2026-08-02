/**
 * Source routing: rollup vs live vs hybrid — end to end through the real engine.
 * Run: node tests/analyticsRollupRouting.test.js
 *
 * THE DEFECT
 *   services/analytics/RollupService.js has always maintained four
 *   pre-aggregated tables (analytics_daily_branch / _daily_item /
 *   _daily_payment / _hourly_branch), the projector has always enqueued dirty
 *   (branch, day) pairs, the worker has always drained them — and the planner
 *   never emitted a single query against any of them. Every request, however
 *   historical and however settled, re-scanned the raw fact tables. Meanwhile
 *   lib/analytics/freshness.js reported `source: 'live'` as a hardcoded
 *   constant, so the response was accidentally honest for the wrong reason and
 *   would have gone on saying 'live' the day routing landed.
 *
 * WHAT THIS FILE GUARDS, in order of how much it would cost to get wrong
 *   1. THE NUMBERS. A routing change that alters a figure is a money bug: the
 *      same period must total the same riyals whether it was answered from the
 *      rollup or from the facts. The last test runs one request twice over the
 *      SAME canned truth — once routed to the rollup, once forced live with
 *      `noRollup` — and compares rows, subtotals and grand totals field for
 *      field. Everything else here is routing plumbing; this one is the money.
 *   2. That a settled window really does hit the rollup table (otherwise the
 *      whole feature is a no-op that merely renames the source).
 *   3. That a window reaching into today is served hybrid — rollup for the
 *      closed days, raw facts for the open tail — and reports 'hybrid'.
 *   4. That anything the rollup cannot PROVE it expresses falls back to live.
 *      A wrong number from the wrong table is far worse than a slow right one,
 *      so the fallbacks are asserted individually, not as a single happy path.
 *
 * HOW IT RUNS WITHOUT A DATABASE
 *   `QueryService.run(db, …)` takes its db as an argument (the pattern proven
 *   in tests/analyticsTwoFactDerived.test.js), so a fake that answers
 *   `query(sql, params)` drives the REAL planner, the REAL routing decision,
 *   the REAL cross-fact merge and the REAL derived-metric computation. Only
 *   the SQL execution is stubbed.
 *
 *   The fake answers on the shape the planner actually asked for: it reads the
 *   table name out of the emitted FROM clause, reads the metric aliases out of
 *   the SELECT list, and reads the date window out of the bound parameters. A
 *   change to the planner's routing or aliasing therefore fails this file
 *   rather than passing quietly.
 */
'use strict';

const QueryService = require('../services/analytics/QueryService');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve()
    .then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} — expected ${expected}, got ${actual}`);
}

const SCOPE = { caps: new Set(['analytics.view']), branchIds: null, brandIds: null };

// ── the canned truth ─────────────────────────────────────────────────────────
// One number per (branch, business_day). BOTH the rollup table and the raw
// facts are answered FROM THIS SAME ARRAY, which is the whole point: if the two
// code paths disagree on anything — the window split, the merge, the rounding,
// which statement owns which metric — the identity test below catches it,
// because the underlying data cannot be the explanation.
//
// 2026-08-01 is deliberately "today" (open); everything before it is settled.
const TRUTH = [
  { branch: 'B1', day: '2026-07-29', net: 1200.50, orders: 30 },
  { branch: 'B1', day: '2026-07-30', net: 900.25, orders: 22 },
  { branch: 'B1', day: '2026-08-01', net: 415.75, orders: 11 },
  { branch: 'B2', day: '2026-07-29', net: 640.00, orders: 15 },
  { branch: 'B2', day: '2026-07-30', net: 310.75, orders: 8 },
  { branch: 'B2', day: '2026-08-01', net: 120.10, orders: 4 },
];

const COL = { net_ex_vat: 'net', orders: 'orders' };

/** Which m_<id> aliases did this statement ask for? Read from the SQL itself. */
function metricsOf(sql) {
  return [...String(sql).matchAll(/AS m_(\w+)/g)].map((m) => m[1]);
}

/**
 * Group TRUTH rows inside [from..to] by `dims`, summing the requested metrics.
 * Returns rows in the engine's column contract: d0..dn-1 + m_<id>.
 */
function aggregate(dims, metricIds, from, to) {
  const buckets = new Map();
  for (const t of TRUTH) {
    if (t.day < from || t.day > to) continue;
    const keys = dims.map((d) => (d === 'branch' ? t.branch : t.day));
    const k = JSON.stringify(keys);
    let b = buckets.get(k);
    if (!b) { b = { keys, sums: {} }; buckets.set(k, b); }
    for (const id of metricIds) b.sums[id] = (b.sums[id] || 0) + t[COL[id]];
  }
  return [...buckets.values()].map((b) => {
    const row = {};
    b.keys.forEach((v, i) => { row['d' + i] = v; });
    for (const id of metricIds) row['m_' + id] = b.sums[id];
    return row;
  }).sort((a, b) => (a.d0 < b.d0 ? -1 : a.d0 > b.d0 ? 1 : 0));
}

/**
 * The super-aggregate rows a HAVING-filtered `WITH ROLLUP` statement returns.
 *
 * The planner now pushes `HAVING (GROUPING(..) = 1 OR …)` into the totals
 * statement so the server discards detail rows instead of streaming them to
 * Node — so this fake returns ONLY the rows a real server would: the grand
 * total plus one subtotal per GROUP BY prefix. Emitting detail rows here would
 * make the fake more forgiving than production, which is how a fake starts
 * hiding the bug it was written to catch.
 */
function rollupAggregates(dims, metricIds, from, to) {
  const out = [];
  const nd = dims.length;
  for (let level = 0; level < nd; level++) {
    // level 0 = the grand total (every dim rolled up); level L>0 groups the
    // first L dims and rolls up the rest.
    const rows = level === 0 ? aggregate([], metricIds, from, to)
      : aggregate(dims.slice(0, level), metricIds, from, to);
    for (const r of rows) {
      const o = { ...r };
      for (let i = 0; i < nd; i++) {
        o['g' + i] = i < level ? 0 : 1;
        if (i >= level) o['d' + i] = null;
      }
      out.push(o);
    }
  }
  return out;
}

/**
 * @param {object} p { dims, today, minDirty, dirtyFails }
 *   dims       the dimension ids the request groups by, in request order.
 *   today      what the DB's CURDATE() reports.
 *   minDirty   oldest pending rollup day, or null for "queue empty".
 *   dirtyFails simulate analytics_rollup_dirty being unreadable.
 */
function makeDb(p) {
  const seen = [];
  const answer = (sql, params) => {
    const s = String(sql);
    seen.push(s);

    // the rollup horizon probe — the ONE query that decides how much of the
    // window is settled.
    if (/analytics_rollup_dirty/.test(s)) {
      if (p.dirtyFails) throw new Error('analytics_rollup_dirty: no such table');
      return [[{ min_dirty: p.minDirty || null, today: p.today }]];
    }
    if (/analytics_rollup_state|analytics_meal_periods/.test(s)) return [[]];

    // Every emitted statement binds its window as the first two parameters
    // (none of the dimensions used here contribute select-list params), so the
    // fake honours the SPLIT the planner chose rather than assuming one.
    const from = String((params || [])[0] || '0000-01-01');
    const to = String((params || [])[1] || '9999-12-31');
    const metricIds = metricsOf(s).filter((id) => COL[id]);
    const isRollupStmt = /analytics_daily_branch/.test(s);
    const isLine = /ar_document_lines/.test(s);
    const isOrder = !isLine && /analytics_order_facts f\b/.test(s);
    if (!isRollupStmt && !isLine && !isOrder) return [[]];
    if (!metricIds.length) return [[]];

    if (/WITH ROLLUP/i.test(s)) return [rollupAggregates(p.dims, metricIds, from, to)];
    return [aggregate(p.dims, metricIds, from, to)];
  };
  const conn = {
    connection: { threadId: 1 },
    query: async (sql, params) => answer(sql, params),
    release: () => {},
  };
  return {
    DB_TIME_ZONE: '+03:00',
    query: async (sql, params) => answer(sql, params),
    getConnection: async () => conn,
    _seen: seen,
    tables: () => ({
      rollup: seen.filter((s) => /FROM analytics_daily_branch/.test(s)).length,
      line: seen.filter((s) => /FROM ar_document_lines/.test(s)).length,
      order: seen.filter((s) => /FROM analytics_order_facts f\b/.test(s)).length,
    }),
  };
}

const TODAY = '2026-08-01';
const baseReq = (over) => Object.assign({
  metrics: ['net_ex_vat', 'orders'],
  dimensions: ['branch'],
  range: { from: '2026-07-29', to: '2026-07-30' },
  limit: 100,
  noCache: true,
}, over);

function byBranch(env) {
  const out = {};
  for (const r of env.data.rows) out[r.keys.branch] = r.values;
  return out;
}

(async () => {
  // ── 1. a CLOSED historical window is answered from the rollup ─────────────
  {
    const db = makeDb({ dims: ['branch'], today: TODAY, minDirty: null });
    const env = await QueryService.run(db, baseReq(), SCOPE);
    const t = db.tables();

    await test('a settled window emits SQL against the rollup TABLE, not the facts', () => {
      ok(t.rollup > 0, 'no statement was executed against analytics_daily_branch');
      eq(t.line, 0, 'the line fact was scanned anyway');
      eq(t.order, 0, 'the order fact was scanned anyway');
    });

    await test("…and REPORTS it: meta.source === 'rollup'", () => {
      eq(env.meta.source, 'rollup', 'meta.source');
      // freshness.source was a hardcoded 'live'; the envelope must not carry
      // two different answers to the same question.
      eq(env.meta.freshness.source, 'rollup', 'meta.freshness.source');
    });

    await test('the rollup answer is the arithmetic truth, not just a shape', () => {
      const rows = byBranch(env);
      eq(rows.B1.net_ex_vat, 2100.75, 'B1 net over 07-29..07-30');
      eq(rows.B1.orders, 52, 'B1 orders');
      eq(rows.B2.net_ex_vat, 950.75, 'B2 net');
      eq(env.data.totals.values.net_ex_vat, 3051.5, 'grand net');
      eq(env.data.totals.values.orders, 75, 'grand orders');
    });
  }

  // ── 2. a window that touches TODAY is served hybrid ───────────────────────
  {
    const db = makeDb({ dims: ['branch'], today: TODAY, minDirty: null });
    const env = await QueryService.run(
      db, baseReq({ range: { from: '2026-07-29', to: '2026-08-01' } }), SCOPE);
    const t = db.tables();

    await test('a window reaching into today emits BOTH a rollup and a live statement', () => {
      ok(t.rollup > 0, 'the settled days did not use the rollup');
      ok(t.line > 0, "the open tail did not query the line fact");
      ok(t.order > 0, 'the open tail did not query the order fact');
    });

    await test("…and reports 'hybrid', naming where the seam sits", () => {
      eq(env.meta.source, 'hybrid', 'meta.source');
      eq(env.meta.rollup.rollupRange.to, '2026-07-31', 'rollup window ends at the last closed day');
      eq(env.meta.rollup.liveRange.from, '2026-08-01', 'the live tail starts the day after');
    });

    await test('the two halves are SUMMED, not one overwriting the other', () => {
      // B1: 1200.50 + 900.25 (rollup) + 415.75 (live tail) = 2516.50
      // A hybrid plan puts the same metric on two statements; the pre-existing
      // merge OVERWROTE on collision, which would have silently published
      // either the settled days or the open day alone as the whole period.
      const rows = byBranch(env);
      eq(rows.B1.net_ex_vat, 2516.5, 'B1 net across the seam');
      eq(rows.B1.orders, 63, 'B1 orders across the seam');
      eq(rows.B2.net_ex_vat, 1070.85, 'B2 net across the seam');
      eq(env.data.totals.values.net_ex_vat, 3587.35, 'grand net across the seam');
      eq(env.data.totals.values.orders, 90, 'grand orders across the seam');
    });
  }

  // ── 3. what the rollup cannot express falls back to the raw facts ─────────
  {
    // `channel` is an ORDER-ATTRIBUTE dimension (f.channel_id): no rollup is
    // keyed by it and none stores it, so the request must land on the facts.
    //
    // This used to be `menu_item`, on the grounds that analytics_daily_item
    // dropped free-text (menu_id NULL) lines and so could never be routed. That
    // is no longer why it lands live — the rollup now STORES those lines under
    // the '' sentinel and the planner maps them back with NULLIF, so item
    // reporting routes. A dimension that genuinely no rollup expresses is what
    // this case is for, and channel is one.
    const db = makeDb({ dims: ['channel'], today: TODAY, minDirty: null });
    const env = await QueryService.run(
      db, baseReq({ metrics: ['net_ex_vat'], dimensions: ['channel'] }), SCOPE);

    await test("a dimension no rollup expresses falls back to the facts and says 'live'", () => {
      const t = db.tables();
      eq(t.rollup, 0, 'a rollup was consulted for a grouping it cannot express');
      ok(t.line > 0, 'the line fact was never queried');
      eq(env.meta.source, 'live', 'meta.source');
      eq(env.meta.freshness.source, 'live', 'meta.freshness.source');
      ok(env.meta.rollup.blockers.length > 0, 'the fallback reason must be reported, not silent');
    });
  }

  // ── 3b. the correctness guards, each on its own ───────────────────────────
  {
    const cases = [
      ['includeVoided lifts a default the rollup has baked in',
        baseReq({ includeVoided: true }), 'includeVoided'],
      ['a calendar_day basis is not the business_day the rollup is keyed by',
        baseReq({ dateBasis: 'calendar_day' }), 'date_basis'],
      ['an order_status filter changes the population the rollup froze',
        baseReq({ filters: [{ dimension: 'order_status', op: 'eq', value: 'closed' }] }),
        'order_status_filter'],
      // A voids_* metric drops the void exclusion for its fact's WHOLE
      // statement, so live computes `guests` over the void-INCLUSIVE
      // population here. analytics_daily_branch stores no voided-guests twin,
      // so it cannot reproduce that population and the request must go live.
      //
      // (This case used to pair voids_count with `orders`. That pair now ROUTES
      // — the rollup stores voids_count beside orders, so the void-inclusive
      // count is orders + voids_count exactly, and answering it live was
      // leaving a correct, cheap answer on the table. The guard being asserted
      // is the same one; `guests` is a metric the table genuinely cannot
      // express under a lift, which is what makes it the honest probe.)
      ['a voids_* metric drops the void exclusion for its whole statement',
        baseReq({ metrics: ['guests', 'voids_count'] }), 'voids_metric'],
      ['noRollup forces the facts, so a suspected drift can always be checked',
        baseReq({ noRollup: true }), 'noRollup'],
    ];
    for (const [name, request, blocker] of cases) {
      const db = makeDb({ dims: ['branch'], today: TODAY, minDirty: null });
      const env = await QueryService.run(db, request, SCOPE);
      await test(name, () => {
        eq(env.meta.source, 'live', 'must not be answered from a rollup');
        eq(db.tables().rollup, 0, 'a rollup statement was emitted anyway');
        ok(env.meta.rollup.blockers.includes(blocker),
          `expected blocker "${blocker}", got ${JSON.stringify(env.meta.rollup.blockers)}`);
      });
    }
  }

  // ── 3c. the horizon itself ────────────────────────────────────────────────
  {
    const db = makeDb({ dims: ['branch'], today: TODAY, minDirty: '2026-07-29' });
    const env = await QueryService.run(db, baseReq(), SCOPE);
    await test('a PENDING dirty day pushes the horizon back before it', () => {
      // 07-29 is queued for rebuild, so the rollup is only trustworthy through
      // 07-28 — and the requested window starts on 07-29, so nothing is
      // settled and the whole request must go live.
      eq(env.meta.rollup.closedThrough, '2026-07-28', 'closedThrough');
      eq(env.meta.source, 'live', 'a day awaiting rebuild must never be served from the rollup');
    });

    const db2 = makeDb({ dims: ['branch'], today: TODAY, dirtyFails: true });
    const env2 = await QueryService.run(db2, baseReq(), SCOPE);
    await test('an UNREADABLE dirty queue means live, never "assume it is settled"', () => {
      eq(env2.meta.rollup.closedThrough, null, 'closedThrough must be unknown, not guessed');
      eq(env2.meta.source, 'live', 'an unknown horizon must fail closed to the facts');
      eq(db2.tables().rollup, 0, 'a rollup was queried on an unknown horizon');
    });
  }

  // ── 4. THE ONE THAT MATTERS: the numbers do not move ──────────────────────
  {
    const request = {
      metrics: ['net_ex_vat', 'orders', 'avg_ticket'],
      dimensions: ['branch', 'business_day'],
      range: { from: '2026-07-29', to: '2026-07-30' },
      limit: 100,
      noCache: true,
    };
    const dbRollup = makeDb({ dims: ['branch', 'business_day'], today: TODAY, minDirty: null });
    const viaRollup = await QueryService.run(dbRollup, request, SCOPE);

    const dbLive = makeDb({ dims: ['branch', 'business_day'], today: TODAY, minDirty: null });
    const viaLive = await QueryService.run(
      dbLive, Object.assign({}, request, { noRollup: true }), SCOPE);

    await test('precondition: the two runs really did take different roads', () => {
      eq(viaRollup.meta.source, 'rollup', 'run A source');
      eq(viaLive.meta.source, 'live', 'run B source');
      ok(dbRollup.tables().rollup > 0 && dbRollup.tables().line === 0, 'run A must be rollup-only');
      ok(dbLive.tables().line > 0 && dbLive.tables().rollup === 0, 'run B must be fact-only');
    });

    const key = (r) => `${r.keys.branch}|${r.keys.business_day}`;

    await test('EVERY row value is identical between the rollup and live paths', () => {
      const a = Object.fromEntries(viaRollup.data.rows.map((r) => [key(r), r.values]));
      const b = Object.fromEntries(viaLive.data.rows.map((r) => [key(r), r.values]));
      eq(Object.keys(a).length, 4, 'expected 2 branches × 2 days');
      eq(Object.keys(a).sort().join(','), Object.keys(b).sort().join(','), 'the row KEYS differ');
      for (const k of Object.keys(a)) {
        for (const id of ['net_ex_vat', 'orders', 'avg_ticket']) {
          ok(a[k][id] === b[k][id],
            `${k}.${id}: rollup says ${a[k][id]}, live says ${b[k][id]} — routing moved money`);
        }
      }
    });

    await test('the grand total is identical between the two paths', () => {
      const a = viaRollup.data.totals.values, b = viaLive.data.totals.values;
      for (const id of ['net_ex_vat', 'orders', 'avg_ticket']) {
        ok(a[id] === b[id], `total ${id}: rollup ${a[id]} vs live ${b[id]}`);
      }
      eq(a.net_ex_vat, 3051.5, 'and it is the right number, not merely a matching one');
      eq(a.orders, 75, 'grand orders');
    });

    await test('the SUBTOTAL rows are identical too — the level, the key and the money', () => {
      // The subtotals come out of the HAVING-bounded ROLLUP statement, so this
      // also pins that the bounded form still yields every level it used to.
      const norm = (env) => env.data.subtotals
        .map((s) => `${s.level}|${JSON.stringify(s.keys)}|${s.values.net_ex_vat}|${s.values.orders}`)
        .sort().join('\n');
      const a = norm(viaRollup), b = norm(viaLive);
      ok(a === b, `subtotals differ:\n       rollup: ${a}\n       live:   ${b}`);
      ok(viaRollup.data.subtotals.length === 2,
        `expected one level-1 subtotal per branch, got ${viaRollup.data.subtotals.length}`);
    });

    await test('a hybrid answer equals the all-live answer for the SAME window', () => {
      // The seam is the risky part: two statements, two windows, one figure.
      // Run the identical open-ended window both ways and compare.
      const wide = {
        metrics: ['net_ex_vat', 'orders'],
        dimensions: ['branch'],
        range: { from: '2026-07-29', to: '2026-08-01' },
        limit: 100,
        noCache: true,
      };
      return (async () => {
        const h = await QueryService.run(
          makeDb({ dims: ['branch'], today: TODAY, minDirty: null }), wide, SCOPE);
        const l = await QueryService.run(
          makeDb({ dims: ['branch'], today: TODAY, minDirty: null }),
          Object.assign({}, wide, { noRollup: true }), SCOPE);
        eq(h.meta.source, 'hybrid', 'precondition: the first run must be hybrid');
        eq(l.meta.source, 'live', 'precondition: the second run must be live');
        const a = byBranch(h), b = byBranch(l);
        for (const br of ['B1', 'B2']) {
          for (const id of ['net_ex_vat', 'orders']) {
            ok(a[br][id] === b[br][id],
              `${br}.${id}: hybrid ${a[br][id]} vs live ${b[br][id]} — the seam moved money`);
          }
        }
        for (const id of ['net_ex_vat', 'orders']) {
          ok(h.data.totals.values[id] === l.data.totals.values[id],
            `total ${id}: hybrid ${h.data.totals.values[id]} vs live ${l.data.totals.values[id]}`);
        }
      })();
    });
  }

  console.log(`\nAnalytics rollup routing: ${_passed}/${_total} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
})();
