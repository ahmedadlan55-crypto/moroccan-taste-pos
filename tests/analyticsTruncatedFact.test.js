/**
 * A truncated fact must not fabricate zeros.
 * Run: node tests/analyticsTruncatedFact.test.js
 *
 * THE DEFECT, measured on real data by an adversarial audit
 *   Every fact statement fetches its OWN top-`fetchN` (= MAX_LIMIT = 500)
 *   slice. When the sort metric does not live on a fact, the planner falls
 *   back to `ORDER BY d0 <dir>` for that fact (planner.js:396-399) — a
 *   lexicographic slice of one dimension value, not a metric ranking. So two
 *   facts can each return their 500 rows and barely intersect.
 *
 *   QueryService then merged them and ZERO-FILLED every gap, which printed:
 *
 *       BR2  2025-12-06 h20   net 1,714.48   orders 0        (truth: 6)
 *
 *   A top-selling hour with no orders. On a 400-day synthetic set grouped
 *   branch × day × hour, 10 of the 10 visible rows were wrong — and the zero
 *   is indistinguishable from a real one.
 *
 *   It predates the Group By work (two dimensions can already exceed 500
 *   groups), but opening the grouping from a curated 8 dimensions to all 41,
 *   three levels deep, turns it from an edge case into the normal case.
 *
 * THE RULE NOW
 *   Zero is only true when the fact actually LOOKED. A metric from a CAPPED
 *   statement fills missing keys with null, which api.ts already defines as
 *   "not computable; render '—', never 0", and `page.truncatedMetrics` names
 *   them so the reader knows which column to distrust rather than the page.
 *   The row itself stays: its sales figure is real.
 */
'use strict';

const QueryService = require('../services/analytics/QueryService');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve().then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const SCOPE = { caps: new Set(['analytics.view']) };
const FETCH_N = 500; // planner MAX_LIMIT

/** A db whose two facts return the given row sets. */
function makeDb(lineRows, orderRows) {
  const answer = (sql) => {
    if (/analytics_rollup_state|analytics_meal_periods/.test(sql)) return [[]];
    const isLine = /ar_document_lines/.test(sql);
    const isOrder = !isLine && /analytics_order_facts f\b/.test(sql);
    if (!isLine && !isOrder) return [[]];
    const rows = isLine ? lineRows : orderRows;
    if (/WITH ROLLUP/i.test(sql)) {
      const grand = isLine
        ? { d0: null, g0: 1, m_net_ex_vat: rows.reduce((a, r) => a + (r.m_net_ex_vat || 0), 0) }
        : { d0: null, g0: 1, m_orders: rows.reduce((a, r) => a + (r.m_orders || 0), 0) };
      return [[...rows.map((r) => ({ ...r, g0: 0 })), grand]];
    }
    return [rows];
  };
  const conn = { connection: { threadId: 1 }, query: async (s) => answer(String(s)), release() {} };
  return { DB_TIME_ZONE: '+03:00', query: async (s) => answer(String(s)), getConnection: async () => conn };
}

const REQUEST = {
  metrics: ['net_ex_vat', 'orders'],
  dimensions: ['branch'],
  range: { from: '2026-07-01', to: '2026-07-10' },
  limit: 6,
  noCache: true,
};

(async () => {
  // ── BOTH facts capped, slices DISJOINT (the audit's scenario) ────────────
  {
    const line = Array.from({ length: FETCH_N }, (_, i) => ({ d0: `k${i}`, m_net_ex_vat: 1000 - i }));
    // the order fact's ORDER BY d0 fallback hands it a different 500 keys
    const order = Array.from({ length: FETCH_N }, (_, i) => ({ d0: `k${400 + i}`, m_orders: 7 }));
    const res = await QueryService.run(makeDb(line, order), REQUEST, SCOPE);
    const rows = res.data.rows;

    await test('a metric from a TRUNCATED fact reads null, never a fabricated 0', () => {
      const zeros = rows.filter((r) => r.values.orders === 0);
      ok(zeros.length === 0,
        `${zeros.length} row(s) print orders=0 for keys the order fact never looked at`);
      ok(rows.every((r) => r.values.orders === null), 'expected null on every uncovered key');
    });

    await test('the row survives — its own fact measured it', () => {
      ok(rows.length > 0, 'rows were dropped');
      ok(rows.every((r) => typeof r.values.net_ex_vat === 'number'),
        'the sales figure is real and must still render');
    });

    await test('the response NAMES which metrics were truncated', () => {
      const t = res.data.page.truncatedMetrics || [];
      ok(t.includes('orders'), 'orders not reported as truncated');
      ok(res.data.page.rowCountCapped === true, 'rowCountCapped should still be set');
    });
  }

  // ── the mirror case: a fact that ran to completion ───────────────────────
  {
    const line = [{ d0: 'k0', m_net_ex_vat: 100 }, { d0: 'k1', m_net_ex_vat: 50 }];
    const order = [{ d0: 'k0', m_orders: 7 }]; // k1 genuinely had no orders
    const res = await QueryService.run(makeDb(line, order), REQUEST, SCOPE);
    const byKey = Object.fromEntries(res.data.rows.map((r) => [r.keys.branch, r.values]));

    await test('an UNCAPPED fact still zero-fills — a real absence is a real zero', () => {
      // Over-correcting would be its own defect: turning every honest zero into
      // "—" would make ordinary reports unreadable.
      ok(byKey.k1, 'k1 row missing');
      ok(byKey.k1.orders === 0,
        `k1 should read 0 (the order fact looked and found nothing), got ${byKey.k1.orders}`);
      ok((res.data.page.truncatedMetrics || []).length === 0, 'nothing was truncated here');
    });
  }

  console.log(`\nAnalytics truncated-fact fill: ${_passed}/${_total} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
})();
