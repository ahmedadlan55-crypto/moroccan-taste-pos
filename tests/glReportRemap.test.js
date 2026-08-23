#!/usr/bin/env node
'use strict';
/**
 * Every GL-derived report groups by the REMAPPED account and drops the transfer.
 *
 * ─── WHY THIS TEST DRIVES THE REAL HANDLERS ─────────────────────────────────
 * The first version of this check swept the SOURCE for the module's name. Two
 * mutants survived it: deleting the map join from the Income Statement's query,
 * and deleting the posted/transfer guard from the Balance Sheet's — because both
 * files still MENTIONED `glBoundaries` elsewhere, so a name-sweep stayed green
 * while the money changed. A test that cannot go red is not a test.
 *
 * So this one captures the SQL the handler actually issues, against a fake pool,
 * and asserts on that text. It is slower to write and it is the only version
 * that fails when the defect returns.
 *
 * ─── THE DEFECT IT PINS ─────────────────────────────────────────────────────
 * Migration 0036 rebuilt the chart of accounts, left the historical rows
 * immutable, recorded each one's canonical destination in
 * `coa_0036_account_map`, and moved the money with one mechanical journal
 * (`COA36-TRANSITION`). A report must group by the DESTINATION account AND
 * exclude that journal. The Trial Balance and General Ledger did both; the
 * Income Statement, Balance Sheet and Cash Flow did neither — so across the
 * rebuild they counted the old history and the transfer, and could not agree
 * with the Trial Balance no matter how carefully either was read.
 */

const path = require('path');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra || '');
}

// ── A fake pool that records every statement and answers plausibly ──────────
//
// `mapPresent` decides how it answers `SHOW TABLES LIKE 'coa_0036_account_map'`,
// because BOTH answers are real deployments and both must work:
//
//   present — a database that ran migration 0036. The remap is required, and
//             skipping it double-counts every account the rebuild folded.
//   absent  — a fresh install, a dev box, a deployment mid-rollout. There is
//             nothing to remap, and joining anyway raises "Table … doesn't
//             exist" — which this route's outer catch turned into an empty 200,
//             i.e. a financial statement reading as "no activity". That shipped
//             for the length of one live check and was caught by running the
//             endpoints, not by any test. Hence this parameter.
function recordingPool(mapPresent) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      seen.push(text);
      if (/^SHOW TABLES LIKE/i.test(text)) {
        return [mapPresent ? [{ t: 'coa_0036_account_map' }] : []];
      }
      if (/^SHOW COLUMNS/i.test(text)) return [[]];
      // Any account-shaped read: one leaf revenue account, enough to walk the
      // JS classification pass without pretending to be a real chart.
      if (/FROM gl_accounts a/i.test(text) && !/gl_entries/i.test(text)) {
        return [[{
          id: 'A1', code: '411', name_ar: 'مبيعات', name_en: 'Sales', type: 'revenue',
          level: 1, is_active: 1, status: 'active', report_section: 'revenue',
          normal_balance: 'credit', is_contra: 0, cash_flow_activity: 'operating',
          parent_id: null, is_folder: 0, display_order: 1,
        }]];
      }
      return [[]];
    },
  };
}

/** Load a route module with `db/connection` replaced by a recording fake. */
function loadRouteWithFakeDb(routeRel, mapPresent) {
  const dbPath = require.resolve(path.join(__dirname, '..', 'db', 'connection.js'));
  const routePath = require.resolve(path.join(__dirname, '..', routeRel));

  const savedDb = require.cache[dbPath];
  delete require.cache[routePath];

  const pool = recordingPool(mapPresent);
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };

  let router;
  try {
    router = require(routePath);
  } finally {
    // Restore immediately — a leaked fake pool would silently poison any test
    // that runs after this one in the same process.
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    delete require.cache[routePath];
  }
  return { router, pool };
}

/** Invoke the LAST handler on a route layer, skipping capability middleware. */
async function callRoute(router, pool, query) {
  const layer = router.stack.find((l) => l.route);
  if (!layer) throw new Error('no route registered on this router');
  const handlers = layer.route.stack.map((s) => s.handle);
  const handler = handlers[handlers.length - 1];

  const req = { query: query || {}, user: { username: 'test', role: 'admin' }, method: 'GET', url: '/' };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler(req, res, () => {});
  return res;
}

const REPORTS = [
  {
    label: 'Income Statement',
    rel: 'routes/erp/reports/income.js',
    query: { startDate: '2026-01-01', endDate: '2026-01-31' },
  },
  {
    label: 'Balance Sheet',
    rel: 'routes/erp/reports/balance-sheet.js',
    // `compareDate` is REQUIRED here, not incidental: the comparison snapshot
    // (`_bsSnapshotTotals`) is a SECOND ledger query on a different join shape,
    // and it only runs when a compare date is supplied. Without it a mutant
    // that stripped the remap from the snapshot survived this whole test — the
    // comparison column would have been computed on a different basis than the
    // column it is compared against.
    query: { asOfDate: '2026-01-31', compareDate: '2025-12-31' },
  },
  {
    label: 'Cash Flow',
    rel: 'routes/erp/reports/cash-flow.js',
    query: { from: '2026-01-01', to: '2026-01-31' },
  },
];

const glBoundaries = require('../lib/reports/glBoundaries');

async function runScenario(mapPresent) {
  const tag = mapPresent ? 'with map table' : 'WITHOUT map table';

  for (const rep of REPORTS) {
    // The probe caches for the life of the process — without this reset the
    // second scenario silently reuses the first scenario's answer and proves
    // nothing.
    glBoundaries.resetCanonicalMapCache();

    let pool;
    try {
      const loaded = loadRouteWithFakeDb(rep.rel, mapPresent);
      pool = loaded.pool;
      await callRoute(loaded.router, pool, rep.query);
    } catch (e) {
      check(`${rep.label} [${tag}]: handler runs`, false, e.message);
      continue;
    }

    // The statements that actually read the ledger — the only ones that matter.
    // `SHOW COLUMNS FROM gl_entries` names the table but reads no money; the
    // balance sheet probes for optional dimension columns that way.
    const ledgerReads = pool.seen.filter(
      (s) => /gl_entries/i.test(s) && /^SELECT/i.test(s),
    );
    check(`${rep.label} [${tag}]: issues at least one gl_entries read`,
      ledgerReads.length > 0, { statements: pool.seen.length });

    for (const sql of ledgerReads) {
      if (mapPresent) {
        check(`${rep.label} [${tag}]: groups by the remapped account`,
          /coa_0036_account_map/i.test(sql), sql.slice(0, 200));
        check(`${rep.label} [${tag}]: excludes the COA36 transfer journal`,
          /COA36-TRANSITION/i.test(sql) || /j\.id\s*<>\s*\?/i.test(sql), sql.slice(0, 200));
      } else {
        // The whole point: it must NOT reference a table that isn't there.
        check(`${rep.label} [${tag}]: does not touch the absent map table`,
          !/coa_0036_account_map/i.test(sql), sql.slice(0, 200));
      }
    }
  }
}

(async () => {
  await runScenario(true);
  await runScenario(false);
  glBoundaries.resetCanonicalMapCache();

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log("  ✅ income / balance-sheet / cash-flow: remap applied when the map exists, and skipped safely when it does not");
  console.log(pass + '/' + pass + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
