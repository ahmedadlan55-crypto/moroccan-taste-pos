#!/usr/bin/env node
'use strict';
/**
 * The Income Statement's comparison column.
 *
 * ─── WHY A COMPARISON IS DANGEROUS ──────────────────────────────────────────
 * A comparison column invites the reader to subtract one number from another.
 * That is only meaningful if BOTH numbers were computed the same way. Every bug
 * pinned below is a way for the two columns to be built on different bases
 * while still rendering as a tidy pair — which is worse than showing nothing,
 * because the reader cannot see the difference and will act on it.
 *
 *   1. BOTH COLUMNS RUN THE SAME AGGREGATE. One `netByAccount`, called twice.
 *   2. BOTH COLUMNS APPLY THE SAME SIGN RULE. A raw net beside a normalised one
 *      shows an expense negative in one column and positive in the next.
 *   3. THE PRIOR LADDER IS THE SAME LADDER. Gross → operating → net written out
 *      a second time by hand is how a comparison silently drifts.
 *   4. ABSENT IS NOT ZERO. With no comparison requested every prior field is
 *      null, never 0 — a client must be able to tell the two apart.
 *   5. A HALF-SPECIFIED RANGE IS NOT A RANGE. Supplying only one edge must not
 *      quietly become "everything since the books opened", presented beside a
 *      single month as though the two were comparable.
 *   6. AN ACCOUNT THAT MOVED IN EITHER COLUMN BELONGS IN THE STATEMENT.
 *      Judging membership on the current period alone drops the line that had
 *      activity last year and none this year — the very change the reader
 *      opened a comparison to see.
 */

const path = require('path');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra || '');
}

// ── Fixture ────────────────────────────────────────────────────────────────
// Two revenue-and-expense accounts, with deliberately DIFFERENT activity in the
// two windows, and one account that moved ONLY in the prior window.
const ACCOUNTS = [
  { id: 'REV', code: '411', name_ar: 'مبيعات', name_en: 'Sales', type: 'revenue',
    level: 1, is_active: 1, status: 'active', report_section: 'revenue',
    normal_balance: 'credit', is_contra: 0, parent_id: null, is_folder: 0, display_order: 1 },
  { id: 'EXP', code: '521', name_ar: 'رواتب', name_en: 'Salaries', type: 'expense',
    level: 1, is_active: 1, status: 'active', report_section: 'opex',
    normal_balance: 'debit', is_contra: 0, parent_id: null, is_folder: 0, display_order: 2 },
  // ARCHIVED on purpose. `classify.isReportable` (lib/coa/classify.js:388) only
  // demands movement of an ARCHIVED account — "history is never erased" — so an
  // archived line is exactly where the membership rule bites, and exactly where
  // judging it on the current period alone loses the row the comparison exists
  // to show.
  { id: 'OLD', code: '522', name_ar: 'إيجار قديم', name_en: 'Old rent', type: 'expense',
    level: 1, is_active: 0, status: 'archived', report_section: 'opex',
    normal_balance: 'debit', is_contra: 0, parent_id: null, is_folder: 0, display_order: 3 },
];

// account → { current: [debit, credit], prior: [debit, credit] }
const MOVEMENT = {
  REV: { current: [0, 1000], prior: [0, 400] },
  EXP: { current: [300, 0],  prior: [100, 0] },
  OLD: { current: [0, 0],    prior: [250, 0] },   // moved ONLY in the prior window
};

const CURRENT = { from: '2026-02-01', to: '2026-02-28' };
const PRIOR   = { from: '2026-01-01', to: '2026-01-31' };

function fakePool() {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      seen.push({ sql: text, params: params || [] });
      if (/^SHOW TABLES LIKE/i.test(text)) return [[]];      // no 0036 map
      if (/^SHOW COLUMNS/i.test(text)) return [[]];
      if (/FROM gl_accounts a/i.test(text) && !/gl_entries/i.test(text)) return [ACCOUNTS];

      if (/FROM gl_entries e/i.test(text)) {
        // Which window is this? Read the dates actually bound to the statement,
        // rather than trusting call order — call order is exactly what a
        // refactor reorders.
        const dates = (params || []).filter((p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p));
        const isPrior = dates.includes(PRIOR.from) && dates.includes(PRIOR.to);
        const key = isPrior ? 'prior' : 'current';
        return [Object.keys(MOVEMENT).map((id) => ({
          account_id: id,
          d: MOVEMENT[id][key][0],
          c: MOVEMENT[id][key][1],
        }))];
      }
      return [[]];
    },
  };
}

function loadIncomeRoute() {
  const dbPath = require.resolve(path.join(__dirname, '..', 'db', 'connection.js'));
  const routePath = require.resolve(path.join(__dirname, '..', 'routes', 'erp', 'reports', 'income.js'));
  const savedDb = require.cache[dbPath];
  delete require.cache[routePath];
  const pool = fakePool();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  let router;
  try {
    router = require(routePath);
  } finally {
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    delete require.cache[routePath];
  }
  return { router, pool };
}

async function callIncome(query) {
  const glBoundaries = require('../lib/reports/glBoundaries');
  glBoundaries.resetCanonicalMapCache();
  const { router, pool } = loadIncomeRoute();
  const layer = router.stack.find((l) => l.route);
  const stack = layer.route.stack.map((s) => s.handle);
  const handler = stack[stack.length - 1];
  const req = { query, user: { username: 't', role: 'admin' }, method: 'GET', url: '/' };
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler(req, res, () => {});
  glBoundaries.resetCanonicalMapCache();
  return { body: res.body, pool };
}

(async () => {
  // ── No comparison requested ───────────────────────────────────────────────
  {
    const { body } = await callIncome({ startDate: CURRENT.from, endDate: CURRENT.to });

    check('plain: revenue is credit-positive', body.totalRevenue === 1000, body.totalRevenue);
    // Expense is debit-normal, so it is flipped to read positive on the page.
    // 300 and NOT 550: the account that moved only in the prior window is
    // rightly absent here, because no comparison was asked for. That exclusion
    // is the mirror of the inclusion asserted in the comparison block below —
    // the same rule, read from both sides.
    check('plain: expense reads positive after the normal-balance flip',
      body.totalOpex === 300, body.totalOpex);
    check('plain: an ARCHIVED account with no current movement is excluded',
      !body.opex.some((i) => i.code === '522'), body.opex.map((i) => i.code));
    check('plain: net income = revenue − expenses', Math.abs(body.netIncome - (1000 - body.totalOpex)) < 0.005,
      { netIncome: body.netIncome, totalOpex: body.totalOpex });

    // ABSENT IS NOT ZERO.
    check('plain: comparison block is null, not an empty object',
      body.comparison === null, body.comparison);
    const allItems = [...body.revenue, ...body.opex];
    check('plain: every item.prior is null, never 0',
      allItems.every((i) => i.prior === null), allItems.map((i) => [i.code, i.prior]));
  }

  // ── Comparison requested ──────────────────────────────────────────────────
  {
    const { body, pool } = await callIncome({
      startDate: CURRENT.from, endDate: CURRENT.to,
      compareStart: PRIOR.from, compareEnd: PRIOR.to,
    });

    check('compare: block is present with its own dates',
      !!body.comparison && body.comparison.from === PRIOR.from && body.comparison.to === PRIOR.to,
      body.comparison);

    check('compare: prior revenue is the PRIOR window, not the current one',
      body.comparison.totalRevenue === 400, body.comparison.totalRevenue);
    check('compare: current revenue is unchanged by asking for a comparison',
      body.totalRevenue === 1000, body.totalRevenue);

    // SAME SIGN RULE: expense positive in BOTH columns.
    const exp = [...body.opex].find((i) => i.code === '521');
    check('compare: expense is positive in both columns (one sign rule)',
      exp && exp.balance === 300 && exp.prior === 100, exp);

    // SAME LADDER, EVERY RUNG. Checking only the final figure let a mutant that
    // hardcoded `grossProfit: 0` survive — the bottom line still added up while
    // an intermediate subtotal on the page was a fabricated zero.
    const c = body.comparison;
    const expectedPriorGross = c.totalRevenue - c.totalCOGS;
    const expectedPriorOperating = expectedPriorGross - c.totalOpex - c.totalGAndA;
    const expectedPriorNet = expectedPriorOperating + c.totalOtherInc - c.totalOtherExp;

    check('compare: prior gross profit = prior revenue − prior COGS',
      Math.abs(c.grossProfit - expectedPriorGross) < 0.005,
      { got: c.grossProfit, expected: expectedPriorGross });
    check('compare: prior operating income = prior gross − prior opex − prior G&A',
      Math.abs(c.operatingIncome - expectedPriorOperating) < 0.005,
      { got: c.operatingIncome, expected: expectedPriorOperating });
    check('compare: the prior ladder reproduces prior net income',
      Math.abs(c.netIncome - expectedPriorNet) < 0.005,
      { netIncome: c.netIncome, expectedPriorNet });

    // And the rungs must be consistent with EACH OTHER, not merely with the
    // inputs — a ladder whose middle is detached still reads as a ladder.
    check('compare: the prior rungs chain (gross → operating → net)',
      Math.abs((c.grossProfit - c.totalOpex - c.totalGAndA) - c.operatingIncome) < 0.005 &&
      Math.abs((c.operatingIncome + c.totalOtherInc - c.totalOtherExp) - c.netIncome) < 0.005,
      { gross: c.grossProfit, operating: c.operatingIncome, net: c.netIncome });

    // AN ARCHIVED ACCOUNT THAT MOVED ONLY IN THE PRIOR WINDOW MUST STILL APPEAR.
    // This is the row a reader opens a comparison to find: spend that stopped.
    const old = [...body.opex].find((i) => i.code === '522');
    check('compare: an archived account that moved ONLY last period is still listed',
      !!old, body.opex.map((i) => i.code));
    check('compare: …with 0 current and its real prior figure',
      old && old.balance === 0 && old.prior === 250, old);

    // BOTH COLUMNS RAN THE SAME AGGREGATE — same SQL text, different dates.
    const ledgerReads = pool.seen.filter((s) => /FROM gl_entries e/i.test(s.sql));
    check('compare: exactly two ledger aggregates were issued',
      ledgerReads.length === 2, ledgerReads.length);
    check('compare: both aggregates are the SAME statement, differing only in dates',
      ledgerReads.length === 2 && ledgerReads[0].sql === ledgerReads[1].sql,
      ledgerReads.map((r) => r.sql.slice(0, 90)));
  }

  // ── A half-specified comparison is not a comparison ───────────────────────
  for (const half of [{ compareStart: PRIOR.from }, { compareEnd: PRIOR.to }]) {
    const { body, pool } = await callIncome({
      startDate: CURRENT.from, endDate: CURRENT.to, ...half,
    });
    const label = Object.keys(half)[0];
    check('half (' + label + '): no comparison block is produced',
      body.comparison === null, body.comparison);
    // …and crucially, no second unbounded aggregate was run.
    const reads = pool.seen.filter((s) => /FROM gl_entries e/i.test(s.sql));
    check('half (' + label + '): only ONE ledger aggregate is issued',
      reads.length === 1, reads.length);
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ income comparison: one aggregate, one sign rule, one ladder — and absent is not zero');
  console.log(pass + '/' + pass + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
