/**
 * Paging that actually reaches the rows it claims to.
 * Run: node tests/analyticsPagination.test.js
 *
 * THE DEFECT
 *   The planner's per-statement fetch depth was the CONSTANT `MAX_LIMIT`
 *   (500), whatever page was asked for:
 *
 *       const fetchN = MAX_LIMIT;                       // planner.js
 *       …
 *       LIMIT ? OFFSET ?   →   params [fetchN, 0]
 *       …
 *       mergedRows.slice(offset, offset + limit)        // QueryService.js
 *
 *   So every request fetched the same first 500 merged rows and then sliced
 *   [500, 550) out of a 500-element array. Offset 500 and beyond returned an
 *   EMPTY page — not an error, not a flag, just nothing — while the response
 *   went on saying `success: true`.
 *
 *   The damage is not a broken "next" button. ExportService.collectRows pages
 *   in 500-row chunks and stops when a page comes back short:
 *
 *       if (page.length < chunk) break;
 *
 *   An empty page IS short, so an export of a 4,000-row report wrote a
 *   500-row file, marked the job `done`, recorded row_count 500, and handed
 *   the owner a file that looks complete and is missing seven eighths of the
 *   business. Nothing in the CSV said so.
 *
 * WHY OFFSET PAGING AND NOT A KEYSET CURSOR
 *   A keyset cursor pushes `WHERE sortkey < :last` into SQL. Here the page is
 *   cut AFTER a cross-fact merge in Node: the sort key is often a metric the
 *   fact being seeked does not compute (the planner already falls back to
 *   `ORDER BY d0` for it), can be a DERIVED metric that only exists once the
 *   equations have run, and in a hybrid plan is split across two statements.
 *   A cursor built on any of those would skip or duplicate rows. Offset paging
 *   over the merged, sorted set is the mechanism that is correct here; what
 *   was broken was that it never fetched deep enough to reach the offset.
 *
 * THE CONTRACT THIS PINS
 *   - a page past 500 returns THE ROWS THAT LIVE THERE, in order;
 *   - `page.hasMore` is true while rows remain and false on the last page;
 *   - `page.total` / `page.totalIsExact` never publish a floor as a total;
 *   - `page.truncated` is set whenever the declared hard cap clipped the
 *     result, so no caller can present a partial file as complete;
 *   - totals and subtotals are computed over the WHOLE window and do not
 *     move when the page does.
 *
 * HOW IT RUNS WITHOUT A DATABASE — the fake-db pattern from
 * tests/analyticsTwoFactDerived.test.js: QueryService.run(db, …) takes its db
 * as an argument, so answering the emitted SQL drives the real planner, the
 * real merge and the real paging. The fake HONOURS the bound LIMIT, which is
 * the whole point: a fake that ignored it would hide the defect.
 */
'use strict';

const QueryService = require('../services/analytics/QueryService');
const planner = require('../lib/analytics/planner');

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

const SCOPE = { caps: new Set(['analytics.view']) };

/**
 * `n` branches, k0…k(n-1), with a strictly DESCENDING metric so the sort order
 * is total and every row's expected position is arithmetic: the row at merged
 * index i is always `k<i>`. That is what makes "offset 600 returned the wrong
 * rows" distinguishable from "offset 600 returned no rows".
 */
function keys(n) {
  return Array.from({ length: n }, (_, i) => ({ d0: 'k' + String(i).padStart(4, '0'), net: 10000 - i }));
}

/**
 * @param {Array} universe  rows from keys()
 * The fake applies the statement's own LIMIT, exactly as the server would, so
 * `fetchN` is under test rather than assumed.
 */
/**
 * Apply a totals statement's HAVING clause to candidate rows, as a server would.
 *
 * Handles the shape the planner emits — an OR chain of `g<i> = <0|1>` over the
 * GROUPING flags — and no more than that. Anything it does not recognise is
 * treated as NO filter, which is the safe direction here: an unrecognised
 * clause makes the fake ship everything, so the "does not stream 900 rows"
 * assertion FAILS rather than passing by accident.
 */
function applyHaving(sql, rows) {
  const m = /\bHAVING\s+\(([^)]*)\)/i.exec(String(sql));
  if (!m) return rows;
  const terms = m[1].split(/\s+OR\s+/i).map((t) => /^\s*g(\d+)\s*=\s*(\d+)\s*$/.exec(t));
  if (!terms.length || terms.some((t) => !t)) return rows; // unrecognised → no filter
  return rows.filter((r) => terms.some(([, i, want]) => Number(r['g' + i]) === Number(want)));
}

function makeDb(universe) {
  const seen = [];
  let totalsRowsShipped = 0;
  const answer = (sql, params) => {
    const s = String(sql);
    seen.push({ sql: s, params });
    if (/analytics_rollup_dirty/.test(s)) throw new Error('no rollup in this fixture');
    if (/analytics_rollup_state|analytics_meal_periods/.test(s)) return [[]];
    if (!/ar_document_lines/.test(s)) return [[]];

    if (/WITH ROLLUP/i.test(s)) {
      // one dimension → the only super-aggregate is the grand total, and it is
      // computed over the WHOLE universe, never over the fetched page.
      const total = universe.reduce((a, r) => a + r.net, 0);
      const grand = { d0: null, g0: 1, m_net_ex_vat: total };
      // A real server APPLIES the statement's HAVING. Without one it streams
      // every detail row back beside the super-aggregates — the third defect
      // exactly: QueryService then dropped them one at a time
      // (`if (rolled === 0) continue`), a whole second result set over the wire
      // and through the driver to reach a single row at the end of it.
      //
      // This used to decide by matching the literal `HAVING (GROUPING(`. That
      // is a SPELLING, and it went stale the moment the clause had to reference
      // the select alias instead — restating a wrapped dimension expression
      // inside HAVING is an ER_BAD_FIELD_ERROR on a real server, so the spelling
      // it was pinned to could never have run. The fake then reported 901 rows
      // for a statement that ships 1.
      //
      // So it now EVALUATES the clause, the way the server does. That also makes
      // it faithful in the other direction: a HAVING that keeps the wrong
      // levels is reflected rather than waved through.
      const candidates = [
        ...universe.map((r) => ({ d0: r.d0, g0: 0, m_net_ex_vat: r.net })),
        grand,
      ];
      const shipped = applyHaving(s, candidates);
      totalsRowsShipped += shipped.length;
      return [shipped];
    }
    // rows statement: … LIMIT ? OFFSET ? — the last two bound params.
    const p = params || [];
    const limit = Number(p[p.length - 2]);
    ok(Number.isFinite(limit) && limit > 0, 'the rows statement must bind a positive LIMIT');
    return [universe.slice(0, limit).map((r) => ({ d0: r.d0, m_net_ex_vat: r.net }))];
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
    /** How many rows the server had to send back for the totals statement. */
    totalsRowsShipped: () => totalsRowsShipped,
    /** The LIMIT the rows statement actually asked the server for. */
    fetchedLimit: () => {
      const st = seen.find((x) => /ar_document_lines/.test(x.sql) && !/WITH ROLLUP/i.test(x.sql));
      return st ? Number(st.params[st.params.length - 2]) : null;
    },
  };
}

const req = (over) => Object.assign({
  metrics: ['net_ex_vat'],
  dimensions: ['branch'],
  range: { from: '2026-07-01', to: '2026-07-31' },
  noCache: true,
}, over);

const run = (universe, over) => QueryService.run(makeDb(universe), req(over), SCOPE);

(async () => {
  // ── 1. rows past the old 500-row ceiling actually exist ───────────────────
  {
    const universe = keys(900);
    const db = makeDb(universe);
    const env = await QueryService.run(db, req({ offset: 600, limit: 100 }), SCOPE);
    const rows = env.data.rows;

    await test('offset 600 returns the 100 rows that LIVE there (it used to return none)', () => {
      eq(rows.length, 100, 'the page is empty or short — the fetch never reached the offset');
      eq(rows[0].keys.branch, 'k0600', 'first row of the page');
      eq(rows[99].keys.branch, 'k0699', 'last row of the page');
      eq(rows[0].values.net_ex_vat, 10000 - 600, 'the value belongs to that key');
    });

    await test('the fetch depth followed the page instead of the old constant 500', () => {
      eq(db.fetchedLimit(), 700, 'LIMIT should be offset+limit, clamped at the hard cap');
    });

    await test('a second, deeper page is disjoint from the first — no repeats, no gaps', () => {
      return QueryService.run(makeDb(universe), req({ offset: 700, limit: 100 }), SCOPE)
        .then((next) => {
          eq(next.data.rows[0].keys.branch, 'k0700', 'the next page must continue, not restart');
          const first = new Set(rows.map((r) => r.keys.branch));
          const overlap = next.data.rows.filter((r) => first.has(r.keys.branch));
          eq(overlap.length, 0, `${overlap.length} rows appear on both pages`);
        });
    });
  }

  // ── 2. hasMore / total, on a result that fits inside the fetch window ─────
  {
    const universe = keys(400); // < the 500-row fetch floor, so nothing is capped
    const first = await run(universe, { offset: 0, limit: 100 });
    const last = await run(universe, { offset: 300, limit: 100 });
    const past = await run(universe, { offset: 400, limit: 100 });

    await test('hasMore is TRUE while rows remain', () => {
      eq(first.data.page.hasMore, true, 'page 1 of 4 must report more');
      eq(first.data.rows.length, 100, 'page size');
    });

    await test('hasMore is FALSE on the last page — the only page that may say so', () => {
      eq(last.data.page.hasMore, false, 'the final page must not claim more');
      eq(last.data.rows.length, 100, 'the final page is full but final');
      eq(last.data.rows[99].keys.branch, 'k0399', 'and it ends on the last key');
      eq(past.data.page.hasMore, false, 'past the end there is certainly no more');
      eq(past.data.rows.length, 0, 'past the end there are no rows');
    });

    await test('total is the real count and is DECLARED exact', () => {
      eq(first.data.page.total, 400, 'total');
      eq(first.data.page.totalIsExact, true, 'totalIsExact');
      eq(first.data.page.truncated, false, 'nothing was clipped');
      eq(last.data.page.total, 400, 'the total does not change with the page');
    });
  }

  // ── 3. the hard cap announces itself ─────────────────────────────────────
  {
    // Ask for a page whose END lies past the declared hard cap. The engine
    // cannot see that far, and the one thing it must never do is answer with a
    // short page that looks like the end of the data.
    const beyond = planner.MAX_FETCH_ROWS - 100;
    const env = await run(keys(50), { offset: beyond, limit: 500 });

    await test('a page past the declared hard cap sets the truncation flag', () => {
      eq(env.data.page.truncated, true, 'page.truncated');
      eq(env.data.page.fetchCapped, true, 'page.fetchCapped');
      eq(env.data.page.maxFetchRows, planner.MAX_FETCH_ROWS, 'the cap is published so a caller can report it');
    });

    await test('…and refuses to publish a total or claim it is the last page', () => {
      eq(env.data.page.total, null, 'a count we cannot verify must be null, not a floor');
      eq(env.data.page.totalIsExact, false, 'totalIsExact');
      eq(env.data.page.hasMore, true, 'we cannot see past the cap, so we must not say "no more"');
    });

    await test('a statement that FILLS its fetch window is truncated too', () => {
      // 900 rows behind a 500-row fetch floor: the server returned exactly what
      // was asked for, which means there is more behind it.
      return run(keys(900), { offset: 0, limit: 50 }).then((e) => {
        eq(e.data.page.rowCountCapped, true, 'rowCountCapped');
        eq(e.data.page.truncated, true, 'truncated must cover this case as well');
        eq(e.data.page.total, null, 'a capped fetch has no trustworthy total');
      });
    });
  }

  // ── 4. paging must not touch the money ───────────────────────────────────
  {
    const universe = keys(900);
    const grand = universe.reduce((a, r) => a + r.net, 0);
    const p1 = await run(universe, { offset: 0, limit: 100 });
    const p7 = await run(universe, { offset: 600, limit: 100 });
    const pEnd = await run(universe, { offset: 850, limit: 100 });

    await test('the grand total is the same on every page, and is the WHOLE window', () => {
      // The totals statement aggregates the full grouping; it has no page in
      // it. A total that shifted with the offset would mean the report was
      // summing the visible rows — the classic "the export totals differ from
      // the screen" defect.
      eq(p1.data.totals.values.net_ex_vat, grand, 'page 1 total');
      eq(p7.data.totals.values.net_ex_vat, grand, 'page 7 total');
      eq(pEnd.data.totals.values.net_ex_vat, grand, 'last page total');
    });

    await test('the totals statement is never given a LIMIT tied to the page', () => {
      const db = makeDb(universe);
      return QueryService.run(db, req({ offset: 600, limit: 100 }), SCOPE).then(() => {
        const totalsStmt = db._seen.find((x) => /WITH ROLLUP/i.test(x.sql));
        ok(totalsStmt, 'no totals statement was executed');
        const bound = totalsStmt.params[totalsStmt.params.length - 1];
        eq(Number(bound), planner.MAX_SUBTOTAL_ROWS,
          'the totals bound must be the subtotal cap, not the page size');
      });
    });

    await test('the totals statement does not stream 900 detail rows back to be discarded', () => {
      // 900 groups, one grand total. The old statement made the server send all
      // 901 rows and Node throw 900 of them away; the detail grouping was
      // therefore materialised and shipped TWICE per request, once usefully and
      // once for nothing. The discard now happens in SQL, where it is free.
      const db = makeDb(universe);
      return QueryService.run(db, req({ offset: 0, limit: 100 }), SCOPE).then((e) => {
        ok(db.totalsRowsShipped() <= 2,
          `${db.totalsRowsShipped()} rows shipped for the totals of a 900-group query`);
        // …and it is still the right number: bounding it must not lose the grand.
        eq(e.data.totals.values.net_ex_vat, grand, 'the bounded totals statement still totals');
      });
    });
  }

  console.log(`\nAnalytics pagination: ${_passed}/${_total} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
})();
