#!/usr/bin/env node
/**
 * RATCHET: the number of hardcoded GL account codes may go down, never up.
 *
 * Every posting engine currently resolves its accounts by literal string
 * code — lib/glPosting.js CORE_ACCOUNTS (25), lib/hrGLPosting.js
 * SALARY_ACCOUNTS (8), routes/erp-core.js WASTE_ACCOUNT_BY_REASON (6), and
 * roughly a hundred more scattered across routes/ and lib/. account_roles
 * exists to replace all of them.
 *
 * That migration cannot be done in one commit, so the risk is not the codes
 * that are there — it is the NEW ones added while the migration is in
 * progress. This test pins a per-file budget: touching a file is allowed,
 * adding a literal to it is not.
 *
 * Note the existing test suite currently does the OPPOSITE of this in places:
 * tests/coaSingleInventory.test.js and tests/custodyNotInventory.test.js
 * deliberately PIN specific literals so a boot migration cannot re-create
 * duplicate groups. Those pins are load-bearing and are exempted below by
 * living in tests/, which this scanner does not read.
 *
 * WHEN YOU MIGRATE A FILE TO account_roles: its count drops, this test fails
 * with "budget is now too generous", and you lower the number. That failure
 * is the ratchet tightening, and it is the point.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['lib', 'routes', 'services'];
// A literal is only interesting when it is being used AS an account, so the
// line must also mention an account/posting concept. Without that, this
// drowns in timeouts, HTTP status codes and array indexes.
const CODE_LINE = /(account|acct|debit|credit|posting|coa|gl_|glAccount|CORE_ACCOUNTS|SALARY_ACCOUNTS|\bcode\s*:|\bparent\s*:)/i;
const CODE_LITERAL = /['"](\d{3,6})['"]/g;

// Numeric literals that are NOT account codes but sit on lines mentioning
// debit/credit. Each exclusion is narrow and justified — a blanket ignore
// would quietly re-open the hole this test exists to close.
//
//   document_type  ZATCA document-type codes: 388 invoice, 381 credit note,
//                  383 debit note (services/order-to-cash/ZatcaDocumentService.js:120).
//                  The words "credit_note"/"debit_note" are what match, not an account.
const NOT_A_GL_CODE = [
  /document_type|docType|documentType/i,
];

// Measured on this branch. Each entry is a CEILING, not a target.
//
// The two biggest are the two that matter most:
//   routes/erp.js 123 — dominated by the inline chart inside POST /gl/seed,
//                       which is a whole chart of accounts expressed as string
//                       literals in a route handler.
//   lib/glPosting.js 52 — CORE_ACCOUNTS: 25 codes plus the parent code each
//                       one declares. This is THE map account_roles replaces.
const BUDGET = {
  'lib/glPosting.js': 52,
  'lib/hrGLPosting.js': 35,
  'lib/order-to-cash/accounts.js': 7,
  'lib/procurement/accounts.js': 3,
  'lib/procurement/posting.js': 6,
  'routes/erp.js': 123,
  'routes/erp-core.js': 7,
  'routes/cash.js': 2,
  'routes/custody.js': 9,
  'routes/inventory.js': 4,
  'routes/expenses.js': 3,
  'routes/sales.js': 5,
  'routes/erp/vat.js': 3,
  'routes/procurement/invoices.js': 1,
  'services/order-to-cash/InvoiceService.js': 1,
  'services/order-to-cash/O2CReconciliationService.js': 1,
};

function scan() {
  const perFile = {};
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      let src;
      try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
      let n = 0;
      for (const line of src.split('\n')) {
        if (!CODE_LINE.test(line)) continue;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // a comment describes, it does not post
        if (NOT_A_GL_CODE.some((re) => re.test(line))) continue;
        n += [...line.matchAll(CODE_LITERAL)].length;
      }
      if (n > 0) perFile[rel] = n;
    }
  };
  SCAN_DIRS.forEach((d) => walk(path.join(ROOT, d)));
  return perFile;
}

let passed = 0, failed = 0;
const found = scan();
const allFiles = new Set([...Object.keys(found), ...Object.keys(BUDGET)]);

console.log('\n▶ hardcoded GL account codes — per-file ratchet\n');

for (const file of [...allFiles].sort()) {
  const actual = found[file] || 0;
  const budget = BUDGET[file];

  if (budget === undefined) {
    console.log(`  ❌ ${file}: ${actual} hardcoded code literal(s) in a file with NO budget.`);
    console.log(`       Resolve them through account_roles (lib/accountRoles.js getAccountByRole).`);
    console.log(`       If this file genuinely must carry literals, add it to BUDGET with a reason.`);
    failed++; continue;
  }
  if (actual > budget) {
    console.log(`  ❌ ${file}: ${actual} literal(s), budget ${budget} — ${actual - budget} NEW one(s).`);
    console.log(`       New posting codes must come from account_roles, not from a string.`);
    failed++; continue;
  }
  if (actual < budget) {
    console.log(`  ❌ ${file}: ${actual} literal(s), budget ${budget}. Good news — the budget is now`);
    console.log(`       too generous. Lower BUDGET['${file}'] to ${actual} so the ground you gained is held.`);
    failed++; continue;
  }
  console.log(`  ✅ ${file}: ${actual}`);
  passed++;
}

const total = Object.values(found).reduce((s, n) => s + n, 0);
const budgetTotal = Object.values(BUDGET).reduce((s, n) => s + n, 0);
console.log(`\n  total: ${total} literal(s) across ${Object.keys(found).length} file(s) (budget ${budgetTotal})`);
console.log('  target is zero — every one of these should resolve through account_roles.\n');

console.log((failed === 0 ? '✅ ALL PASS' : '❌ FAILURES') + `: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
