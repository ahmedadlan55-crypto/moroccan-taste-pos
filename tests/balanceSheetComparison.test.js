#!/usr/bin/env node
'use strict';
/**
 * The Balance Sheet's comparison column, and the sign defect it carried.
 *
 * ─── THE SIGN DEFECT ────────────────────────────────────────────────────────
 * Three sites decide how a CONTRA account is signed:
 *
 *   pushToGroup (main pass)   `isContra ? -magnitude : magnitude`
 *   snapshot, asset branch    `contra   ? -mag       : mag`
 *   snapshot, equity branch   `contra   ? -Math.abs(mag) : mag`   ← the outlier
 *
 * `Math.abs` forces a contra-equity account NEGATIVE regardless of which way its
 * balance actually runs. It only diverges on an ABNORMAL balance — drawings
 * sitting in credit rather than debit, i.e. an owner who has put money back in.
 * There the comparison column reported the OPPOSITE sign from the column beside
 * it, so the delta between them was wrong by twice the balance.
 *
 * The defect was documented in place and deliberately deferred as "a money
 * change [that] belongs to its own reviewed fix". This is that fix, and this is
 * the test that stops it coming back.
 *
 * ─── THE COMPARISON COLUMN ──────────────────────────────────────────────────
 * The snapshot used to return grand totals and section totals only, on the
 * reasoning that per-account priors would "double the heavy query". They would
 * not: the snapshot already reads every account and every entry, so the
 * per-account figures were computed and discarded. Without them a client can
 * only compare grand totals, and a per-account comparison column is unbuildable.
 */

const path = require('path');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra || '');
}

const AS_OF = '2026-02-28';
const COMPARE = '2026-01-31';

// ── The fixture is the whole test, so it is worth stating why ──────────────
//
// `-Math.abs(mag)` and `-mag` are IDENTICAL whenever `mag` is positive. They
// diverge only when `mag` is negative — and since `mag = -net`, that means a
// POSITIVE net, i.e. drawings sitting in DEBIT: the perfectly normal case.
//
//     drawings d=800 c=0  →  net = +800  →  mag = -800
//         fixed   `contra ? -mag : mag`        →  +800
//         defect  `contra ? -Math.abs(mag) : mag` →  −800
//
// A first version of this fixture used a CREDIT balance, where both rules give
// −800, and the mutation check duly reported that restoring the original defect
// changed nothing. The fixture, not the fix, was wrong.
const ACCOUNTS = [
  { id: 'CASH', code: '1113', name_ar: 'البنك', name_en: 'Bank', type: 'asset',
    level: 1, is_active: 1, status: 'active', report_section: 'cash',
    normal_balance: 'debit', is_contra: 0, parent_id: null, is_folder: 0, display_order: 1 },
  { id: 'DRAW', code: '3300', name_ar: 'مسحوبات', name_en: 'Drawings', type: 'equity',
    level: 1, is_active: 1, status: 'active', report_section: 'drawings',
    normal_balance: 'debit', is_contra: 1, parent_id: null, is_folder: 0, display_order: 2 },
  // Present TODAY, absent from the prior snapshot — the account opened after
  // the comparison date. Its prior must be null, never a confident 0.
  { id: 'NEW', code: '1114', name_ar: 'بنك جديد', name_en: 'New bank', type: 'asset',
    level: 1, is_active: 1, status: 'active', report_section: 'cash',
    normal_balance: 'debit', is_contra: 0, parent_id: null, is_folder: 0, display_order: 3 },
  // A contra ASSET (accumulated depreciation). The equity branch is not the
  // only one that applies a contra flip, and without this row a mutant that
  // dropped the flip from the ASSET branch survived the whole test.
  { id: 'ACCDEP', code: '1290', name_ar: 'مجمع الإهلاك', name_en: 'Accum. depreciation',
    type: 'asset', level: 1, is_active: 1, status: 'active', report_section: 'accDep',
    normal_balance: 'credit', is_contra: 1, parent_id: null, is_folder: 0, display_order: 4 },
  // A LIABILITY. Every account above happens to display with a +1 multiplier
  // (balance === raw net), so a mutant that dropped the per-row sign transform
  // entirely was indistinguishable from the real thing. A liability inverts —
  // `magnitude = -net` — and is the only row here that proves the transform is
  // applied at all.
  { id: 'AP', code: '2110', name_ar: 'الموردون', name_en: 'Payables', type: 'liability',
    level: 1, is_active: 1, status: 'active', report_section: 'payables',
    normal_balance: 'credit', is_contra: 0, parent_id: null, is_folder: 0, display_order: 5 },
];

/** What the PRIOR snapshot sees — deliberately missing 'NEW'. */
const SNAPSHOT_ROWS = [
  { id: 'CASH', code: '1113', type: 'asset', report_section: 'cash',
    normal_balance: 'debit', is_contra: 0, status: 'active', d: 5000, c: 0 },
  { id: 'DRAW', code: '3300', type: 'equity', report_section: 'drawings',
    normal_balance: 'debit', is_contra: 1, status: 'active', d: 800, c: 0 },
  // Credit balance, so net is NEGATIVE — the case where the asset branch's
  // contra flip is observable.
  { id: 'ACCDEP', code: '1290', type: 'asset', report_section: 'accDep',
    normal_balance: 'credit', is_contra: 1, status: 'active', d: 0, c: 2000 },
  { id: 'AP', code: '2110', type: 'liability', report_section: 'payables',
    normal_balance: 'credit', is_contra: 0, status: 'active', d: 0, c: 3000 },
];

/** What the CURRENT pass sees — the same two, plus the newly opened account. */
const CURRENT_ROWS = [
  ...SNAPSHOT_ROWS,
  { id: 'NEW', code: '1114', type: 'asset', report_section: 'cash',
    normal_balance: 'debit', is_contra: 0, status: 'active', d: 1200, c: 0 },
];

function fakePool() {
  const seen = [];
  return {
    seen,
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      seen.push(text);
      if (/^SHOW TABLES LIKE/i.test(text)) return [[]];
      if (/^SHOW COLUMNS/i.test(text)) return [[]];
      // Both of the next two mention `gl_entries`, so they are told apart by
      // HOW they use it — not by whether the name appears.
      //
      //   snapshot     gl_accounts LEFT JOIN gl_entries …  (aggregates money)
      //   account list gl_accounts … EXISTS (SELECT 1 FROM gl_entries …)
      //                              (asks only whether the account holds
      //                               direct postings, so a parent carrying
      //                               money is not dropped from the statement)
      //
      // A first version routed on "mentions gl_entries" and silently handed the
      // account list the SNAPSHOT rows — which quietly removed the
      // opened-after-the-comparison-date account the test exists to check.
      if (/FROM gl_accounts a/i.test(text) && /LEFT JOIN gl_entries/i.test(text)) return [SNAPSHOT_ROWS];
      // The main pass's account list.
      if (/FROM gl_accounts a/i.test(text)) return [ACCOUNTS];
      // The main pass's entry aggregate.
      if (/FROM gl_entries e/i.test(text)) {
        return [CURRENT_ROWS.map((r) => ({ account_id: r.id, d: r.d, c: r.c, cnt: 1 }))];
      }
      return [[]];
    },
  };
}

function loadRoute() {
  const dbPath = require.resolve(path.join(__dirname, '..', 'db', 'connection.js'));
  const routePath = require.resolve(path.join(__dirname, '..', 'routes', 'erp', 'reports', 'balance-sheet.js'));
  const savedDb = require.cache[dbPath];
  delete require.cache[routePath];
  const pool = fakePool();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  let router;
  try { router = require(routePath); }
  finally {
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    delete require.cache[routePath];
  }
  return { router, pool };
}

async function callBs(query) {
  const glBoundaries = require('../lib/reports/glBoundaries');
  glBoundaries.resetCanonicalMapCache();
  const { router, pool } = loadRoute();
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

/**
 * The account rows the STATEMENT renders from.
 *
 * Deliberately the flat arrays, not the `groups` tree: the response carries the
 * same account in both shapes, as two different objects, and a first version of
 * this test read only the tree. It passed while the flat arrays — the ones the
 * page actually renders — had no prior column at all.
 */
/** The statement's own current-column asset total. */
function totalsCurrentAssets(body) {
  return (body.totalAssets !== undefined) ? body.totalAssets : ((body.totCA || 0) + (body.totNCA || 0));
}

function statementRows(body) {
  return [
    ...(body.currentAssets || []), ...(body.nonCurrentAssets || []),
    ...(body.currentLiab || []), ...(body.nonCurrentLiab || []),
    ...(body.equityItems || []),
  ];
}

(async () => {
  // ── The sign rule agrees across all three sites ───────────────────────────
  {
    const { body } = await callBs({ asOfDate: AS_OF, compareDate: COMPARE, showZero: '1' });
    check('handler answered', !!body, body);

    const rows = statementRows(body);
    const draw = rows.find((a) => a.code === '3300');
    check('the contra-equity account is present', !!draw, rows.map((a) => a.code));

    if (draw) {
      // Same date, same data, both columns — so the current and prior figures
      // MUST be identical. They differ only if the two sign rules disagree,
      // which is precisely the defect.
      check('contra-equity: prior carries the SAME sign as the current column',
        draw.prior !== null && Math.sign(draw.prior) === Math.sign(draw.balance),
        { balance: draw.balance, prior: draw.prior });
      check('contra-equity: prior equals current when both read the same books',
        draw.prior !== null && Math.abs(draw.prior - draw.balance) < 0.005,
        { balance: draw.balance, prior: draw.prior });
      // What is NOT asserted here, on purpose: which way a contra-equity
      // account should point in absolute terms. That convention belongs to the
      // main pass (pushToGroup), and redefining it would be a presentation
      // change nobody asked for. The defect was never "the sign is wrong" — it
      // was "the two columns disagree", and agreement is what is pinned.
      //
      // The magnitude is asserted so the fix cannot be faked by zeroing both.
      check('contra-equity: both columns carry the real magnitude, not zero',
        Math.abs(draw.balance) > 0.005, { balance: draw.balance, prior: draw.prior });
    }

    // ── THE ASSERTION THAT ACTUALLY CATCHES THE DEFECT ──────────────────────
    // The prior snapshot and the main pass read the SAME books here (the fake
    // pool answers both identically), so every rolled-up delta must be exactly
    // zero. Under the old `-Math.abs(mag)` the equity total came back with the
    // opposite sign, making `change.totEq.abs` twice the drawings balance.
    //
    // Per-account `prior` alone did NOT catch this — the mutation check proved
    // it survived — because the account rows are attached from
    // `accountBalances`, which the defect never touched. The defect lived in
    // the ROLL-UP.
    if (body.change) {
      check('totals: equity delta is zero when both columns read the same books',
        Math.abs(body.change.totEq.abs) < 0.005,
        { totEq: body.change.totEq, hint: 'non-zero means the two sign rules disagree' });
      // Assets, by contrast, SHOULD differ — by exactly the account that opened
      // after the comparison date and by nothing else. Asserting "zero" here
      // would have been wrong, and asserting the exact figure proves the delta
      // arithmetic rather than merely that two numbers happen to match.
      check('totals: asset delta is exactly the newly opened account',
        Math.abs(body.change.totalAssets.abs - 1200) < 0.005, body.change.totalAssets);

      // ── THE FOOTER AGREES WITH THE COLUMN ABOVE IT ────────────────────────
      // The prior totals are summed from the prior column, so the footer cannot
      // disagree with the lines it sits under. This is the guarantee that makes
      // the snapshot's own contra roll-up irrelevant to the comparison — and it
      // is why a mutation that restores the original `Math.abs` on that roll-up
      // now survives this test: the value it corrupts no longer reaches the
      // response. The line is kept correct because `isBalanced` still reads it,
      // but it is no longer load-bearing here, and pinning the mechanism would
      // pin something the report does not depend on.
      const priorAssets = [...(body.currentAssets || []), ...(body.nonCurrentAssets || [])]
        .reduce((s, r) => s + (typeof r.prior === 'number' ? r.prior : 0), 0);
      check('totals: prior asset total is the sum of the prior column',
        Math.abs((totalsCurrentAssets(body) - body.change.totalAssets.abs) - priorAssets) < 0.005,
        { priorAssets, delta: body.change.totalAssets.abs });
    }
  }

  // ── Per-account priors reach every bucket, and absent is null ─────────────
  {
    const { body } = await callBs({ asOfDate: AS_OF, compareDate: COMPARE, showZero: '1' });
    const rows = statementRows(body);
    check('every account row carries a `prior` field',
      rows.length > 0 && rows.every((a) => Object.prototype.hasOwnProperty.call(a, 'prior')),
      rows.map((a) => [a.code, a.prior]));

    const cash = rows.find((a) => a.code === '1113');
    check('an ordinary asset carries its prior too', cash && cash.prior !== null && cash.prior !== undefined,
      cash);

    // The contra flip is applied by the ASSET branch as well as the equity one.
    // Both columns read the same books, so they must agree here too.
    const accDep = rows.find((a) => a.code === '1290');
    check('contra-asset: prior agrees with the current column',
      accDep && accDep.prior !== null && Math.abs(accDep.prior - accDep.balance) < 0.005,
      accDep);

    // The liability is the row whose displayed balance is the NEGATION of its
    // raw net, so it is the one that proves the per-row transform runs.
    const ap = rows.find((a) => a.code === '2110');
    check('liability: prior agrees with the current column',
      ap && ap.prior !== null && Math.abs(ap.prior - ap.balance) < 0.005, ap);
    check('liability: displays as a positive obligation, not a raw negative net',
      ap && ap.balance > 0 && ap.prior > 0, ap);

    // ABSENT IS NOT ZERO. This account opened AFTER the comparison date, so it
    // has no prior balance at all. Reporting 0 would claim it existed and was
    // worth nothing — and a delta computed from that fabricated 0 reads as
    // growth from nothing rather than "not comparable".
    const fresh = rows.find((a) => a.code === '1114');
    check('an account absent from the prior snapshot has prior === null, not 0',
      fresh && fresh.prior === null, fresh);
  }

  // ── No comparison requested → no prior fields fabricated ──────────────────
  {
    const { body } = await callBs({ asOfDate: AS_OF, showZero: '1' });
    const rows = statementRows(body);
    check('without compareDate the comparison block is null',
      body.change === null || body.change === undefined, body.change);
    check('without compareDate no row claims a prior of 0',
      rows.every((a) => a.prior === undefined || a.prior === null),
      rows.map((a) => [a.code, a.prior]));
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ balance sheet: one sign rule across all three sites, and a real per-account prior column');
  console.log(pass + '/' + pass + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
