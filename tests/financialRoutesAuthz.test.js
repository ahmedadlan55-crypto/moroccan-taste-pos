#!/usr/bin/env node
'use strict';
/**
 * tests/financialRoutesAuthz.test.js — every financial route must be guarded.
 *
 * Thirteen financial endpoints shipped with NO capability guard at all: the
 * P&L, both balance sheets, the IAS-7 cash flow, the GL ledger, both agings,
 * profitability, inventory valuation, the account ledger, `/gl/diagnose`
 * (which returns every non-zero account balance in the company) and the COA
 * template. Any authenticated token could read them — a waiter's, an inventory
 * clerk's, a cashier's.
 *
 * Worse, `routes/erp/periods.js` exposed close / soft-close / lock / reopen
 * with no guard either. Closing a period blocks every subsequent sale in it
 * (lib/glPosting.js isPeriodClosed fails CLOSED) and re-opening one lets
 * journals be posted into books that were already signed off.
 * `middleware/posPortalScope.js` blocked the CASHIER role specifically, but it
 * is a deny-list for POS_ONLY_ROLES — every other non-admin role walked
 * straight through.
 *
 * This is a STATIC scan, deliberately: an HTTP test needs a DB, a seeded role
 * and a token, so it tends to be skipped in a hurry. A regex over the router
 * source is free, runs in the default `npm test` chain, and fails the moment
 * someone adds an unguarded financial route.
 *
 * It asserts the guard EXISTS and names a plausible capability — it cannot
 * prove the capability is seeded or that the middleware works. Those are
 * covered by middleware/requireCapability's own contract and by the RBAC
 * e2e spec (e2e/erp/trial-balance-rbac.spec.ts).
 *
 * Run: node tests/financialRoutesAuthz.test.js   (pure, no DB)
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Every route that reads or mutates financial data, and the capability it must
 * carry. Adding a financial endpoint without adding it here is fine — the
 * sweep in section 3 catches it. Listing it here pins the EXACT capability.
 */
const GUARDED = [
  // ── financial reports — finance.reports.view ──────────────────────────────
  ['routes/erp-core.js', "/reports/pnl", 'finance.reports.view'],
  ['routes/erp-core.js', "/reports/balance-sheet", 'finance.reports.view'],
  ['routes/erp-core.js', "/reports/profitability", 'finance.reports.view'],
  ['routes/erp-core.js', "/reports/inventory-valuation", 'finance.reports.view'],
  ['routes/erp-core.js', "/reports/trial-balance", 'finance.reports.view'],
  ['routes/erp/reports/balance-sheet.js', "/reports/balance-sheet-ifrs", 'finance.reports.view'],
  ['routes/erp/reports/cash-flow.js', "/reports/cash-flow-ias7", 'finance.reports.view'],
  ['routes/erp/reports/income.js', "/reports/income", 'finance.reports.view'],
  ['routes/erp/reports/equity-changes.js', "/reports/equity-changes", 'finance.reports.view'],
  ['routes/erp/reports/ar-aging.js', "/reports/ar-aging", 'finance.reports.view'],
  ['routes/erp/reports/ap-aging.js', "/reports/ap-aging", 'finance.reports.view'],
  // The ledger is the rawest financial read in the system — every posted line.
  ['routes/erp/reports/gl-ledger.js', "/reports/gl-ledger-multi", 'finance.reports.view'],
  ['routes/erp/reports/gl-ledger.js', "/gl/account-ledger/:accountId", 'finance.reports.view'],
  // ── chart-of-accounts surface — finance.accounts.manage ───────────────────
  // /gl/diagnose returns every account whose balance is non-zero.
  ['routes/erp.js', "/gl/diagnose", 'finance.accounts.manage'],
  ['routes/erp.js', "/gl/coa-template", 'finance.accounts.manage'],
  // ── period close — finance.periods.manage ─────────────────────────────────
  ['routes/erp/periods.js', "/periods/:label/close", 'finance.periods.manage'],
  ['routes/erp/periods.js', "/periods/:label/soft-close", 'finance.periods.manage'],
  ['routes/erp/periods.js', "/periods/:label/lock", 'finance.periods.manage'],
  ['routes/erp/periods.js', "/periods/:label/reopen", 'finance.periods.manage'],
  ['routes/erp.js', "/periods/:id/lock", 'finance.periods.manage'],
];

// ── 1. Each listed route carries its exact capability ──────────────────────
{
  const cache = new Map();
  for (const [file, route, cap] of GUARDED) {
    if (!cache.has(file)) cache.set(file, read(file));
    const src = cache.get(file);
    // Match `router.<verb>('<route>', ... requireCapability('<cap>')` on one
    // line — every registration in this repo is single-line up to the handler.
    const line = src
      .split('\n')
      .find((l) => l.includes("'" + route + "'") && /router\.(get|post|put|patch|delete)\(/.test(l));
    check(`${file} registers ${route}`, !!line, route);
    if (!line) continue;
    check(
      `${route} is guarded by requireCapability('${cap}')`,
      line.includes(`requireCapability('${cap}')`),
      line.trim().slice(0, 140),
    );
  }
}

// ── 2. The period router imports the guard at all ──────────────────────────
// It shipped without even requiring the middleware — the strongest signal that
// the omission was an oversight rather than a decision.
{
  const src = read('routes/erp/periods.js');
  check(
    'routes/erp/periods.js requires middleware/requireCapability',
    /require\(['"]\.\.\/\.\.\/middleware\/requireCapability['"]\)/.test(src),
  );
}

// ── 3. Sweep: no UNGUARDED route in any reports router ─────────────────────
// Section 1 pins the routes we know about. This catches the next one.
{
  const REPORT_ROUTERS = fs
    .readdirSync(path.join(ROOT, 'routes/erp/reports'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => 'routes/erp/reports/' + f);

  for (const file of REPORT_ROUTERS) {
    const src = read(file);
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      if (!/router\.(get|post|put|patch|delete)\(/.test(l)) return;
      // The retired trial-balance stub exports an empty router on purpose
      // (routes/erp/reports/trial-balance.js) — it registers nothing, so this
      // loop never sees it. Any real registration must be guarded.
      check(
        `${file}:${i + 1} route is guarded`,
        l.includes('requireCapability('),
        l.trim().slice(0, 140),
      );
    });
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ financial routes authz: every report, ledger and period-close endpoint is capability-guarded');
