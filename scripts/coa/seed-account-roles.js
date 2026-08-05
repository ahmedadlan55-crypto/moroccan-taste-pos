#!/usr/bin/env node
/**
 * Populate account_roles, and report coverage honestly.
 *
 * account_roles has existed since migration 0018 with a validating writer, a
 * history table and optimistic concurrency — and ZERO rows in every
 * environment. Meanwhile every posting engine resolves its accounts by
 * hardcoded string code. This script is the bridge: it maps each role to a
 * real account so `getAccountByRole` can become the single resolution path.
 *
 * HOW A ROLE IS MATCHED, in strict order:
 *   1. an explicit code from ROLE_CODE_HINTS below — these are not guesses,
 *      they are the codes lib/glPosting.js CORE_ACCOUNTS and
 *      lib/hrGLPosting.js SALARY_ACCOUNTS ALREADY post to today, so adopting
 *      them changes nothing about where money lands;
 *   2. nothing else.
 *
 * There is deliberately no keyword/name fallback. A role pointed at the wrong
 * account by a fuzzy Arabic-name match is worse than an unmapped role: the
 * unmapped one fails closed and gets fixed, the mis-mapped one silently posts
 * real money to the wrong place for months. Roles this script cannot match
 * are REPORTED, not invented.
 *
 * Idempotent: re-running rewrites nothing that is already correct.
 *
 * Usage:
 *   node -r dotenv/config scripts/coa/seed-account-roles.js [--apply] [--company CO-MAIN]
 *
 * Without --apply it is a DRY RUN and writes nothing.
 */
'use strict';

const db = require('../../db/connection');
const { ROLE_CATALOG } = require('../../lib/accountRoleCatalog');
const { setAccountRole } = require('../../lib/accountRoles');
const CANONICAL_CHART = require('../../db/coa-saudi-canonical');

// The codes the engines post to TODAY. Sourced from lib/glPosting.js
// CORE_ACCOUNTS and lib/hrGLPosting.js SALARY_ACCOUNTS — adopting them means
// the role registry describes reality on day one instead of proposing a new
// reality nobody has migrated to yet.
//
// Several roles list more than one candidate because dev and production run
// DIFFERENT charts (dev: legacy 1-5 digit; production: 6-digit GGMMPP with a
// large template loaded). First match wins; a role with no match is reported.
const ROLE_CODE_HINTS = {
  CASH_ON_HAND:        ['1110', '100101', '1101'],
  BANK:                ['1120', '100105', '100107', '1102'],
  ACCOUNTS_RECEIVABLE: ['1150'],
  INVENTORY:           ['1200'],
  BRANCH_INVENTORY:    ['1210'],
  WORK_IN_PROGRESS:    ['1220'],
  FINISHED_GOODS:      ['1230'],
  INPUT_VAT:           ['1290'],
  EMPLOYEE_ADVANCES:   ['1130'],
  ACCOUNTS_PAYABLE:    ['2100'],
  GRNI:                ['2150'],
  PAYROLL_PAYABLE:     ['2201'],
  GOSI_EMPLOYEE_SHARE: ['2202'],
  OUTPUT_VAT:          ['2210'],
  ROYALTY_PAYABLE:     ['2310'],
  PLATFORM_PAYABLE:    ['2320'],
  SALES_REVENUE:       ['4100'],
  PENALTY_REVENUE:     ['4201'],
  STOCK_GAIN:          ['4910'],
  COGS:                ['5100'],
  WASTE_RAW:           ['5121'],
  WASTE_FINISHED:      ['5122'],
  WASTE_EXPIRED:       ['5123'],
  WASTE_SPILL:         ['5124'],
  WASTE_RETURNS:       ['5125'],
  WASTE_EXPENSE:       ['5200'],
  STOCK_VARIANCE:      ['5300'],
  SALARY_EXPENSE:      ['5301'],
  ALLOWANCES_EXPENSE:  ['5302'],
  OVERTIME_EXPENSE:    ['5303'],
  GOSI_COMPANY_SHARE:  ['5304'],
  PPV:                 ['5350'],
  LABOR_APPLIED:       ['5400'],
  OVERHEAD_APPLIED:    ['5410'],
  PRODUCTION_VARIANCE: ['5420'],
  PLATFORM_COMMISSION: ['5500'],
  FRANCHISE_FEE:       ['6100'],
  // No code exists for these today — they are reported unmapped until an
  // account is created for them, which is a decision, not a lookup.
  SALES_DISCOUNT:      [],
  INVENTORY_GAIN_LOSS: [],
  ZAKAT:               [],
  DELIVERY_COMMISSION: [],
  ROUNDING:            [],
  CUSTOMER_ADVANCES:   [],
  SUPPLIER_ADVANCES:   [],
  SUSPENSE:            [],
};

// The canonical six-digit code is always the first candidate. Legacy hints
// remain below it only so the diagnostic can still describe a database before
// migration 0036; after the migration every role resolves to this one source.
for (const account of CANONICAL_CHART) {
  for (const role of account.roles || []) {
    const hints = ROLE_CODE_HINTS[role] || (ROLE_CODE_HINTS[role] = []);
    ROLE_CODE_HINTS[role] = [account.code, ...hints.filter((code) => code !== account.code)];
  }
}

function argValue(args, name, dflt) {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const actor = argValue(args, '--actor', 'coa-role-seed');

  let companyId = argValue(args, '--company', null);
  if (!companyId) {
    const [rows] = await db.query(
      "SELECT id FROM companies ORDER BY (id = 'CO-MAIN') DESC, id ASC LIMIT 1");
    companyId = rows[0] ? rows[0].id : 'CO-MAIN';
  }

  const [accounts] = await db.query(
    `SELECT a.id, a.code, a.name_ar, a.type, a.is_folder, a.is_active,
            (SELECT COUNT(*) FROM gl_accounts c WHERE c.parent_id = a.id) AS kids
       FROM gl_accounts a`);
  const byCode = new Map(accounts.map((a) => [String(a.code), a]));

  const [existing] = await db.query(
    'SELECT role_key, account_id, version FROM account_roles WHERE company_id = ?', [companyId]);
  const current = new Map(existing.map((r) => [r.role_key, r]));

  const roles = Object.keys(ROLE_CATALOG).sort();
  const results = [];

  for (const role of roles) {
    const def = ROLE_CATALOG[role];
    const hints = ROLE_CODE_HINTS[role] || [];
    let picked = null, reason = '';

    for (const code of hints) {
      const acc = byCode.get(code);
      if (!acc) continue;
      // The catalog's own rules decide whether this account may hold the role;
      // an account of the wrong type is not a near-miss, it is a wrong answer.
      if (!def.allowedTypes.includes(acc.type)) { reason = `code ${code} is type=${acc.type}, role allows ${def.allowedTypes.join('/')}`; continue; }
      if (Number(acc.is_folder) === 1 || Number(acc.kids) > 0) { reason = `code ${code} is not a posting account`; continue; }
      picked = acc; reason = `matched code ${code}`; break;
    }

    const already = current.get(role);
    const status = !picked ? 'unmapped'
      : already && already.account_id === picked.id ? 'already-correct'
      : already ? 'remap'
      : 'new';

    results.push({
      role, status,
      accountCode: picked ? picked.code : null,
      accountName: picked ? picked.name_ar : null,
      note: picked ? reason : (hints.length ? (reason || 'no candidate code exists in this chart') : 'no code candidate defined — needs a decision'),
    });

    if (apply && picked && status !== 'already-correct') {
      // `reason` is mandatory in the writer by design — every mapping lands in
      // account_role_history as a governance record, so "who pointed OUTPUT_VAT
      // at this account, and why" is answerable later.
      //
      // One role failing must not abandon the other 44. The writer rejects a
      // mapping when the target account contradicts the catalog (wrong type,
      // wrong natural side, missing tax_nature) — those are real findings about
      // the CHART, not script errors, so they are collected and reported rather
      // than thrown. Aborting here would also leave the registry half-written.
      try {
        await setAccountRole(db, {
          roleKey: role, companyId, accountId: picked.id, actor,
          expectedVersion: already ? already.version : undefined,
          reason: `seed-account-roles: ${reason} (adopted from the code this engine already posts to)`,
        });
      } catch (e) {
        const rec = results[results.length - 1];
        rec.status = 'blocked';
        rec.note = `${e.code || 'ERROR'}: ${e.message}`;
      }
    }
  }

  const blocked = results.filter((r) => r.status === 'blocked');
  const unmapped = results.filter((r) => r.status === 'unmapped');
  const mapped = results.length - blocked.length - unmapped.length;
  const pct = ((mapped / roles.length) * 100).toFixed(1);

  console.table(results);
  console.log(`\ncompany: ${companyId}   mode: ${apply ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`coverage: ${mapped}/${roles.length} roles mapped (${pct}%)`);

  if (blocked.length) {
    console.log(`\nBLOCKED — the chart contradicts the catalog. These are findings about`);
    console.log(`the DATA, and each is a metadata fix on the account, not a role decision:`);
    blocked.forEach((r) => console.log(`  ${r.role.padEnd(22)} ${r.accountCode || '-'}  ${r.note}`));
  }
  if (unmapped.length) {
    console.log(`\nUNMAPPED — each of these needs an account, not a guess:`);
    unmapped.forEach((r) => console.log(`  ${r.role.padEnd(22)} ${r.note}`));
  }
  console.log('');
  await db.end();
  // Coverage below 100% is a real state of the system, not a script failure —
  // exit 0 so this can run in a report pipeline, and let the dedicated
  // coverage test be the thing that fails a gate.
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
