#!/usr/bin/env node
/**
 * Chart of Accounts / Trial Balance — Phase 0 read-only inventory.
 *
 * READ-ONLY. Every statement below is SELECT/SHOW. Nothing here inserts,
 * updates, deletes, or reseeds anything. Safe to re-run at any time, against
 * any database this process is pointed at via the standard DB_* / DATABASE_URL
 * env vars consumed by db/connection.js.
 *
 * Usage:
 *   node scripts/audit/coa-trial-balance-audit.js [--out <path>] [--env local|production]
 *   node scripts/audit/coa-trial-balance-audit.js --target=prod --assert-readonly
 *
 * --env is a LABEL ONLY (stamped into the report header) — it does not change
 * which database is queried.
 *
 * --target DOES change it:
 *   dev  (default) — whatever DB_* / DATABASE_URL already point at.
 *   prod           — reads the connection URL from the COA_AUDIT_PROD_URL env
 *                    var. The URL is never read from a file in the repo and is
 *                    never printed; only host and database name are stamped
 *                    into the report. If the var is absent the script exits
 *                    rather than silently auditing dev and labelling it prod —
 *                    a mislabelled audit is worse than no audit.
 *
 * Pair --target=prod with --assert-readonly. Nothing here writes, but that flag
 * makes the CREDENTIAL prove it, which is the only guarantee that survives a
 * future edit to this file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
// Assigned in main() AFTER --target is resolved: db/connection.js builds its
// pool from env at require time, so requiring it here would pin the dev
// database before we ever get a chance to repoint it.
let db;

// ── Known hardcoded legacy account-code schemes we're checking for drift ──
// lib/glPosting.js CORE_ACCOUNTS, WITH the parent code each entry declares
// (verified against mt-pos:main on this audit date) — used for both
// existence AND parent-match checks below (item 8 of the corrective gate:
// "count Parent expectation for every CORE/SALARY account, not just
// whether the code exists").
const CORE_ACCOUNTS = {
  CASH: { code: '1110', parent: '111' }, BANK: { code: '1120', parent: '111' },
  AR: { code: '1150', parent: '112' }, INVENTORY: { code: '1200', parent: '113' },
  BRANCH_INVENTORY: { code: '1210', parent: '113' }, WIP: { code: '1220', parent: '113' },
  FINISHED_GOODS: { code: '1230', parent: '113' }, INPUT_VAT: { code: '1290', parent: '116' },
  AP: { code: '2100', parent: '211' }, OUTPUT_VAT: { code: '2210', parent: '213' },
  ROYALTY_PAYABLE: { code: '2310', parent: '215' }, SALES_REVENUE: { code: '4100', parent: '411' },
  STOCK_GAIN: { code: '4910', parent: '422' }, COGS: { code: '5100', parent: '51' },
  WASTE_EXPENSE: { code: '5200', parent: '521' }, WASTE_RAW: { code: '5121', parent: '521' },
  WASTE_FINISHED: { code: '5122', parent: '521' }, WASTE_EXPIRED: { code: '5123', parent: '521' },
  WASTE_SPILL: { code: '5124', parent: '521' }, WASTE_RETURNS: { code: '5125', parent: '521' },
  STOCK_VARIANCE: { code: '5300', parent: '522' }, PPV: { code: '5350', parent: '523' },
  LABOR_APPLIED: { code: '5400', parent: '53' }, OVERHEAD_APPLIED: { code: '5410', parent: '6' },
  PRODUCTION_VARIANCE: { code: '5420', parent: '522' }, FRANCHISE_FEE: { code: '6100', parent: '651' },
  PLATFORM_COMMISSION: { code: '5500', parent: '6' }, PLATFORM_PAYABLE: { code: '2320', parent: '215' },
};
// lib/hrGLPosting.js SALARY_ACCOUNTS (verified against mt-pos:main on this audit date)
const SALARY_ACCOUNTS = {
  SALARY_EXPENSE: { code: '5301', parent: '611' }, ALLOWANCES_EXPENSE: { code: '5302', parent: '611' },
  OVERTIME_EXPENSE: { code: '5303', parent: '611' }, GOSI_COMPANY_SHARE: { code: '5304', parent: '612' },
  SALARIES_PAYABLE: { code: '2201', parent: '212' }, GOSI_EMPLOYEE_SHARE: { code: '2202', parent: '216' },
  EMPLOYEE_ADVANCES: { code: '1130', parent: '115' }, PENALTY_REVENUE: { code: '4201', parent: '42' },
};
const SALARY_PARENTS_ALWAYS_ENSURED = ['53', '22', '11', '42'];

// The ~20 accounting roles requested in the overhaul brief. For each we search
// gl_accounts by plausible Arabic-name keywords and report CANDIDATES only —
// this script never assigns a role to an account. That judgment call belongs
// to the ADR / a human accountant, not to a heuristic string match.
const REQUESTED_ROLES = {
  CASH_ON_HAND: ['نقد', 'صندوق', 'الصندوق'],
  BANK: ['بنك', 'البنوك'],
  ACCOUNTS_RECEIVABLE: ['ذمم العملاء', 'عملاء'],
  ACCOUNTS_PAYABLE: ['ذمم الموردين', 'موردين'],
  INVENTORY: ['مخزون'],
  WORK_IN_PROGRESS: ['تحت التشغيل', 'إنتاج تحت'],
  FINISHED_GOODS: ['منتجات تامة', 'تامة الصنع'],
  INPUT_VAT: ['ضريبة المدخلات', 'ضريبة مدخلات'],
  OUTPUT_VAT: ['ضريبة المخرجات', 'ضريبة مخرجات'],
  SALES_REVENUE: ['إيرادات المبيعات', 'إيراد المبيعات'],
  SALES_DISCOUNT: ['خصم مبيعات', 'مسموحات مبيعات'],
  COGS: ['تكلفة المبيعات', 'تكلفة البضاعة'],
  INVENTORY_GAIN_LOSS: ['فروقات جرد', 'فروق جرد'],
  PAYROLL_PAYABLE: ['رواتب مستحقة', 'رواتب وأجور مستحقة'],
  ZAKAT: ['زكاة'],
  DELIVERY_COMMISSION: ['عمولات منصات', 'عمولة توصيل'],
  FRANCHISE_FEE: ['امتياز', 'فرنشايز'],
  ROUNDING: ['تقريب', 'فروق تقريب'],
  CUSTOMER_ADVANCES: ['دفعات مقدمة من عملاء', 'عربون عملاء'],
  SUPPLIER_ADVANCES: ['دفعات مقدمة لموردين', 'سلف موردين'],
};

function argValue(args, name) {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  // ── --target: which database, resolved BEFORE db/connection is required ──
  const dbTarget = (argValue(args, '--target') || 'dev').toLowerCase();
  if (dbTarget !== 'dev' && dbTarget !== 'prod') {
    console.error(`✗ unknown --target=${dbTarget}. Use dev or prod.`);
    process.exit(1);
  }
  if (dbTarget === 'prod') {
    const url = process.env.COA_AUDIT_PROD_URL;
    if (!url) {
      console.error('\n✗ --target=prod needs COA_AUDIT_PROD_URL in the environment.');
      console.error('  Auditing dev while labelling the report "production" would be');
      console.error('  worse than not running at all, so this exits instead.\n');
      console.error('  COA_AUDIT_PROD_URL=mysql://user:pass@host:port/db \\');
      console.error('    node scripts/audit/coa-trial-balance-audit.js --target=prod --assert-readonly\n');
      process.exit(1);
    }
    process.env.DATABASE_URL = url;
  }
  db = require('../../db/connection');

  // --env stays a pure label, but --target=prod implies it so the two can
  // never disagree in the header.
  const envLabel = dbTarget === 'prod' ? 'production'
    : (argValue(args, '--env') || 'local');
  const outPath = argValue(args, '--out')
    || path.join(__dirname, '..', '..', 'docs', 'audits',
        envLabel === 'production' ? 'COA_TRIAL_BALANCE_AUDIT_PRODUCTION_AR.md'
                                   : 'COA_TRIAL_BALANCE_AUDIT_LOCAL_AR.md');

  const report = { envLabel, dbTarget, generatedAt: new Date().toISOString(), sections: {} };

  // Which physical database are we actually pointed at? (host+db name only,
  // never credentials) — stamped into the report so nobody mistakes this for
  // a different environment later.
  const [[target]] = await db.query('SELECT DATABASE() AS db, @@hostname AS host, @@version AS version');
  report.target = target;

  // ── --assert-readonly: refuse to run with a credential that can WRITE ──
  //
  // "Every statement is a SELECT" is a promise about THIS file. It is not a
  // guarantee about the session: a typo, a future edit, or a mis-set env var
  // pointed at production with the application's own credential turns a
  // read-only audit into an unbounded risk against live books. The only
  // durable guarantee is a credential that CANNOT write, so this flag makes
  // the script prove it and exit rather than trust the promise.
  //
  // Ask the owner for a dedicated MySQL user with SELECT only. Do not point
  // this at production with the app credential just because it happens to
  // work.
  if (args.includes('--assert-readonly')) {
    const [grantRows] = await db.query('SHOW GRANTS FOR CURRENT_USER()');
    const grants = grantRows.map((r) => String(Object.values(r)[0] || ''));
    // A grant line is a write grant if it hands out ALL PRIVILEGES or names
    // any mutating privilege. Checked with word boundaries so `SELECT` inside
    // e.g. `SHOW VIEW` never trips it and `CREATE TEMPORARY TABLES` — which is
    // harmless to real data — does not either.
    const WRITE = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE(?! TEMPORARY)|TRUNCATE|REPLACE|GRANT OPTION|SUPER|FILE)\b/i;
    const offending = grants.filter((g) => WRITE.test(g));
    if (offending.length) {
      console.error('\n✗ REFUSING TO RUN — the current MySQL user can WRITE.');
      console.error('  This audit must be run with a SELECT-only credential.');
      console.error('  Offending grant(s):');
      // Grants are printed because they are the actionable diagnostic, and a
      // GRANT line never contains a password.
      offending.forEach((g) => console.error('    ' + g));
      console.error('\n  Create one, then re-run:');
      console.error("    CREATE USER 'coa_audit'@'%' IDENTIFIED BY '<a strong password>';");
      console.error("    GRANT SELECT ON <database>.* TO 'coa_audit'@'%';\n");
      process.exit(1);
    }
    console.log('✓ read-only credential verified (' + grants.length + ' grant line(s), none of them write)');
  }

  // ── 1. Raw counts ──
  const [accounts] = await db.query(
    'SELECT id, code, name_ar, name_en, type, parent_id, level, is_active, is_folder, ' +
    'display_order, balance, account_class, report_section, tax_nature FROM gl_accounts'
  );
  report.sections.totals = {
    totalAccounts: accounts.length,
    byType: groupCount(accounts, 'type'),
    byLevel: groupCount(accounts, 'level'),
    byActive: groupCount(accounts, a => (a.is_active ? 'active' : 'inactive')),
    byFolder: groupCount(accounts, a => (a.is_folder ? 'folder' : 'posting')),
    note: 'gl_accounts has NO company_id/legal_entity_id column today — counts below are ' +
          'for the single implicit legal scope (companies row CO-MAIN). Cannot be broken out ' +
          'per company until that column exists (see ADR 0002).',
  };

  const byId = new Map(accounts.map(a => [a.id, a]));

  // ── 2. Roots / orphans / self-parent / cycles / computed depth vs stored level ──
  const roots = accounts.filter(a => !a.parent_id);
  const orphans = accounts.filter(a => a.parent_id && !byId.has(a.parent_id));
  const selfParent = accounts.filter(a => a.parent_id === a.id);

  const cycles = [];
  const depthMismatch = [];
  for (const a of accounts) {
    if (a.parent_id === a.id) continue; // already reported as self-parent
    const seen = new Set([a.id]);
    let cur = a;
    let depth = 1;
    let broke = false;
    while (cur.parent_id) {
      if (seen.has(cur.parent_id)) { cycles.push({ start: a.code, id: a.id }); broke = true; break; }
      const parent = byId.get(cur.parent_id);
      if (!parent) break; // orphan, already reported
      seen.add(cur.parent_id);
      cur = parent;
      depth += 1;
      if (depth > accounts.length + 1) { cycles.push({ start: a.code, id: a.id }); broke = true; break; }
    }
    if (!broke && Number(a.level) !== depth) {
      depthMismatch.push({ code: a.code, name: a.name_ar, storedLevel: a.level, computedDepth: depth });
    }
  }

  report.sections.structure = {
    roots: roots.map(a => ({ code: a.code, name: a.name_ar, type: a.type })),
    orphans: orphans.map(a => ({ code: a.code, name: a.name_ar, parentId: a.parent_id })),
    selfParent: selfParent.map(a => ({ code: a.code, name: a.name_ar })),
    cycles,
    depthMismatch,
    // The depth walk above is 1-based (`let depth = 1`), matching the
    // canonical lib/coa/tree.js. A chart that was left 0-based by the old
    // deep-repair shows up as `zeroLevelAccounts > 0` AND as a depthMismatch
    // on essentially every row — that combination is the fingerprint of the
    // bug, and it is what makes the trial balance render «غير سليم».
    zeroLevelAccounts: accounts.filter(a => Number(a.level) === 0).length,
    nullLevelAccounts: accounts.filter(a => a.level == null).length,
    depthMismatchRatio: accounts.length
      ? Number((depthMismatch.length / accounts.length).toFixed(3)) : 0,
  };

  // ── 2b. display_order health ────────────────────────────────────────────
  // display_order is a PER-PARENT ordinal (every writer restarts the counter
  // at each parent). Duplicates WITHIN one parent are the real defect — they
  // make the sibling order non-deterministic. Duplicates ACROSS parents are
  // expected and are NOT reported, because reporting them would bury the one
  // that matters.
  {
    const byParent = new Map();
    for (const a of accounts) {
      const k = String(a.parent_id || '__ROOT__');
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(a);
    }
    const dupWithinParent = [];
    for (const [k, kids] of byParent) {
      const seen = new Map();
      for (const kid of kids) {
        if (kid.display_order == null) continue;
        const o = Number(kid.display_order);
        if (seen.has(o)) dupWithinParent.push({ parent: k, order: o, codes: [seen.get(o), kid.code] });
        else seen.set(o, kid.code);
      }
    }
    report.sections.ordering = {
      nullDisplayOrder: accounts.filter(a => a.display_order == null).length,
      duplicateWithinParent: dupWithinParent,
      note: 'display_order is per-parent; duplicates across DIFFERENT parents are normal ' +
            'and deliberately not listed. Only collisions inside one parent are defects.',
    };
  }

  // ── 2c. Which code scheme is this chart actually on? ────────────────────
  // The repo carries two: the live 1–5-digit family and db/coa-template.json's
  // 6-digit GGMMPP. Every root guard in routes/erp.js hard-codes ['1'..'5'],
  // and the prefix-based repair heuristics assume a parent's code is a strict
  // prefix of its child's — which is FALSE for GGMMPP (100200 is not prefixed
  // by 100000). Knowing which scheme production is on decides whether those
  // guards are doing anything at all.
  {
    const sixDigit = accounts.filter(a => /^\d{6}$/.test(String(a.code || ''))).length;
    const legacy = accounts.filter(a => /^\d{1,5}$/.test(String(a.code || ''))).length;
    const legacyRoots = ['1', '2', '3', '4', '5'];
    report.sections.codeScheme = {
      sixDigitCodes: sixDigit,
      legacyCodes: legacy,
      other: accounts.length - sixDigit - legacy,
      detected: sixDigit > legacy ? 'ggmmpp(6-digit)' : 'legacy(1-5 digit)',
      legacyRootGuardsMatch: legacyRoots.filter(c => accounts.some(a => String(a.code) === c)),
      legacyRootGuardsMissing: legacyRoots.filter(c => !accounts.some(a => String(a.code) === c)),
      note: 'Any code in legacyRootGuardsMissing means the hard-coded root guards in ' +
            'routes/erp.js silently match nothing for that root.',
    };
  }

  // ── 2d. Four-way posting-leaf disagreement ──────────────────────────────
  // The canonical rule is `is_active AND NOT is_folder AND NOT hasChildren`
  // (lib/coa/tree.js). Before this audit's companion fix, three call sites
  // checked children ONLY, so a CHILDLESS FOLDER was postable from the UI
  // while the trial balance refused to count it — which is what produces
  // `nonLeafPostingActivity` and flips `isClean` to false. This lists exactly
  // the accounts the two rules disagree about, so the owner can see the
  // blast radius rather than a count.
  {
    const parentSet = new Set(accounts.filter(a => a.parent_id).map(a => a.parent_id));
    const disagree = accounts
      .filter(a => a.is_active && !parentSet.has(a.id) && a.is_folder)
      .map(a => ({ code: a.code, name: a.name_ar, type: a.type }));
    report.sections.postingLeafDisagreement = {
      childlessFolders: disagree,
      note: 'Childless accounts flagged is_folder=1: the canonical rule says NOT postable, ' +
            'a children-only rule says postable. Any with posted activity are the ones the ' +
            'trial balance reports as nonLeafPostingActivity.',
    };
  }

  // ── 3. Non-aggregating parent: is a parent (has children) but not flagged is_folder ──
  const parentIds = new Set(accounts.filter(a => a.parent_id).map(a => a.parent_id));
  const nonAggregatingParents = accounts
    .filter(a => parentIds.has(a.id) && !a.is_folder)
    .map(a => ({ code: a.code, name: a.name_ar, is_folder: !!a.is_folder }));
  report.sections.nonAggregatingParents = nonAggregatingParents;

  // ── 4. Type mismatch parent → child ──
  const typeMismatch = accounts
    .filter(a => a.parent_id && byId.has(a.parent_id) && byId.get(a.parent_id).type !== a.type)
    .map(a => ({
      code: a.code, name: a.name_ar, childType: a.type,
      parentCode: byId.get(a.parent_id).code, parentType: byId.get(a.parent_id).type,
    }));
  report.sections.typeMismatch = typeMismatch;

  // ── 5. Duplicate codes (should be structurally impossible — UNIQUE(code) — verify anyway) ──
  const [[{ n: dupCount }]] = await db.query(
    'SELECT COUNT(*) n FROM (SELECT code FROM gl_accounts GROUP BY code HAVING COUNT(*) > 1) x'
  );
  report.sections.duplicateCodes = { count: dupCount, note: 'gl_accounts.code has a UNIQUE constraint; non-zero here would mean the constraint is missing/bypassed.' };

  // ── 6. Posting on folder ──
  const [postingOnFolder] = await db.query(
    `SELECT a.code, a.name_ar, COUNT(e.id) entryCount
     FROM gl_accounts a JOIN gl_entries e ON e.account_id = a.id
     WHERE COALESCE(a.is_folder,0) = 1
     GROUP BY a.id, a.code, a.name_ar`
  );
  report.sections.postingOnFolder = postingOnFolder;

  // ── 7. Inactive accounts with activity ──
  const [inactiveWithActivity] = await db.query(
    `SELECT a.code, a.name_ar, COUNT(e.id) entryCount
     FROM gl_accounts a JOIN gl_entries e ON e.account_id = a.id
     WHERE COALESCE(a.is_active,1) = 0
     GROUP BY a.id, a.code, a.name_ar`
  );
  report.sections.inactiveWithActivity = inactiveWithActivity;

  // ── 8. gl_entries with account_id IS NULL ──
  const [nullAccountEntries] = await db.query(
    `SELECT e.id, e.journal_id, e.account_code, e.account_name, e.debit, e.credit,
            j.journal_number, j.journal_date, j.status
     FROM gl_entries e JOIN gl_journals j ON j.id = e.journal_id
     WHERE e.account_id IS NULL
     ORDER BY j.journal_date`
  );
  report.sections.nullAccountEntries = nullAccountEntries;

  // ── 9. balance column vs derived from posted gl_entries ──
  // Corrective fix: the FIRST audit draft compared `balance` against a
  // type-flipped ("normal side") derivation (asset/expense=+1, else -1).
  // That is NOT how gl_accounts.balance is actually maintained — every
  // writer (routes/erp.js's approve_post / delete-reversal paths) does
  // `balance = balance + (debit - credit)` UNCONDITIONALLY, with no type
  // sign flip. Comparing against the wrong convention doesn't just get the
  // SIGN of a mismatch wrong, it can hide a real match or invent a fake
  // one for every liability/equity/revenue account. `derivedRaw` below
  // matches the real maintenance code exactly; `derivedNormalSide` is kept
  // ONLY as a separate, clearly-labeled, human-readability view — it is
  // never compared against the stored column.
  const [postedEntries] = await db.query(
    `SELECT e.account_id, e.debit, e.credit
     FROM gl_entries e JOIN gl_journals j ON j.id = e.journal_id
     WHERE j.status = 'posted' AND e.account_id IS NOT NULL`
  );
  const derivedRaw = new Map();
  const derivedNormalSide = new Map();
  for (const e of postedEntries) {
    const acc = byId.get(e.account_id);
    if (!acc) continue; // covered by null/orphan checks elsewhere
    const raw = Number(e.debit) - Number(e.credit);
    derivedRaw.set(e.account_id, (derivedRaw.get(e.account_id) || 0) + raw);
    const sign = (acc.type === 'asset' || acc.type === 'expense') ? 1 : -1;
    derivedNormalSide.set(e.account_id, (derivedNormalSide.get(e.account_id) || 0) + sign * raw);
  }
  const balanceMismatch = [];
  for (const a of accounts) {
    const dRaw = round2(derivedRaw.get(a.id) || 0);
    const dNormal = round2(derivedNormalSide.get(a.id) || 0);
    const stored = round2(Number(a.balance) || 0);
    if (Math.abs(dRaw - stored) > 0.01) {
      balanceMismatch.push({
        code: a.code, name: a.name_ar, type: a.type,
        storedBalance: stored,
        derivedRawDebitMinusCredit: dRaw,
        derivedNormalSidePresentation: dNormal,
      });
    }
  }
  report.sections.balanceMismatch = {
    note: 'Per rule 6, gl_accounts.balance must never be treated as the source of truth — this section ' +
          'exists only to show HOW STALE it already is. derivedRawDebitMinusCredit matches the ACTUAL ' +
          'maintenance code (routes/erp.js: balance = balance + (debit - credit), unconditionally, no ' +
          'type sign flip) and is what storedBalance is compared against. derivedNormalSidePresentation ' +
          'is a SEPARATE, human-readability-only view (type-flipped so liability/equity/revenue read ' +
          'positive-when-credit) — it is never compared against storedBalance directly.',
    mismatches: balanceMismatch,
  };

  // ── 10. Legacy hardcoded code sets vs actual accounts — existence AND
  // parent-match. A code existing under the WRONG parent is just as much a
  // hybrid-tree symptom as the code being entirely missing. ──
  const codeSet = new Set(accounts.map(a => a.code));
  const byCode = new Map(accounts.map(a => [a.code, a]));
  function checkLegacySet(entries) {
    const missing = [];
    const wrongParent = [];
    const incompleteMetadata = [];
    for (const [key, def] of Object.entries(entries)) {
      if (!codeSet.has(def.code)) { missing.push({ key, code: def.code }); continue; }
      const acc = byCode.get(def.code);
      const actualParent = acc.parent_id ? (byId.get(acc.parent_id) || {}).code : null;
      if (actualParent !== def.parent) {
        wrongParent.push({ key, code: def.code, declaredParent: def.parent, actualParent: actualParent || '(no parent / orphan)' });
      }
      const missingFields = [];
      if (!acc.name_en) missingFields.push('name_en');
      if (!acc.report_section) missingFields.push('report_section');
      if (!acc.account_class) missingFields.push('account_class');
      if (missingFields.length) incompleteMetadata.push({ key, code: def.code, missingFields });
    }
    return { missing, wrongParent, incompleteMetadata };
  }
  const coreCheck = checkLegacySet(CORE_ACCOUNTS);
  const salaryCheck = checkLegacySet(SALARY_ACCOUNTS);
  const salaryParentsDrift = SALARY_PARENTS_ALWAYS_ENSURED
    .map(code => ({ code, exists: codeSet.has(code) }))
    .filter(x => !x.exists);
  report.sections.legacyCodeDrift = {
    note: 'These are the accounts that lib/glPosting.js ensureCoreAccounts() / lib/hrGLPosting.js ' +
          'ensurePayrollAccounts() will SILENTLY RE-CREATE (with parent lookups keyed to the OLD ' +
          '1-3 digit scheme) the next time ANY journal posts, if missing. A non-empty "missing" list on ' +
          'a database already seeded from the new 6-digit template is the hybrid-tree landmine ' +
          'described in the brief, confirmed live. "wrongParent" catches the subtler case: the code ' +
          'exists but was re-parented (or never correctly parented) — checked against every account\'s ' +
          'ACTUAL parent_id chain, not just "does the code exist somewhere".',
    CORE_ACCOUNTS_missing: coreCheck.missing,
    CORE_ACCOUNTS_wrongParent: coreCheck.wrongParent,
    CORE_ACCOUNTS_incompleteMetadata: coreCheck.incompleteMetadata,
    SALARY_ACCOUNTS_missing: salaryCheck.missing,
    SALARY_ACCOUNTS_wrongParent: salaryCheck.wrongParent,
    SALARY_ACCOUNTS_incompleteMetadata: salaryCheck.incompleteMetadata,
    SALARY_PARENTS_missing: salaryParentsDrift,
  };

  // ── 11. Questionable tax_nature classification ──
  const taxKeywordFlags = { 'زكاة': 'zakat', 'تأمينات': 'gosi', 'استقطاع': 'withholding', 'خصم منبع': 'withholding', 'ضريبة': null };
  const taxNatureFlags = [];
  for (const a of accounts) {
    let expected = null;
    for (const [kw, exp] of Object.entries(taxKeywordFlags)) {
      if (a.name_ar && a.name_ar.includes(kw)) { expected = exp; break; }
    }
    if ((expected && a.tax_nature !== expected) || (!expected && a.tax_nature && a.tax_nature !== 'none' && !a.name_ar.includes('ضريبة'))) {
      taxNatureFlags.push({ code: a.code, name: a.name_ar, taxNature: a.tax_nature, suspectedCorrect: expected });
    }
  }
  report.sections.taxNatureFlags = {
    note: 'routes/erp.js _deriveTaxNature() (used only at wipe-and-seed time) maps ANY 6-digit ' +
          "code starting '2003' to vat_output — this mislabels 200303 GOSI / 200304 Withholding / " +
          '200305 Zakat Payable in the template. Confirmed by static read of routes/erp.js:1053-1068 ' +
          '(this section flags any LIVE accounts with a similar live mismatch, independently).',
    flags: taxNatureFlags,
  };

  // ── 12. Requested account-role candidates (report only, never assign) ──
  const roleCandidates = {};
  for (const [role, keywords] of Object.entries(REQUESTED_ROLES)) {
    const matches = accounts.filter(a => keywords.some(kw => a.name_ar && a.name_ar.includes(kw)));
    roleCandidates[role] = matches.map(a => ({ code: a.code, name: a.name_ar, type: a.type, isFolder: !!a.is_folder }));
  }
  report.sections.roleCandidates = {
    note: 'Candidates found by Arabic keyword match against CURRENT (legacy-scheme) local accounts. ' +
          'NONE of these are auto-assigned to account_roles — an empty array means no plausible local ' +
          'match exists yet, which is expected for roles like ROUNDING/CUSTOMER_ADVANCES/SUPPLIER_ADVANCES ' +
          'that do not exist under the legacy scheme at all.',
    candidates: roleCandidates,
  };

  // ── 13. gl_journals / gl_entries sanity ──
  const [[journalTotals]] = await db.query(
    `SELECT COUNT(*) n, SUM(status='posted') posted, SUM(status='draft') draft, SUM(status='approved') approved,
            SUM(total_debit) totalDebit, SUM(total_credit) totalCredit
     FROM gl_journals`
  );
  const [imbalanced] = await db.query(
    `SELECT id, journal_number, journal_date, total_debit, total_credit
     FROM gl_journals WHERE ABS(total_debit - total_credit) > 0.01`
  );
  report.sections.journals = { totals: journalTotals, imbalancedHeaders: imbalanced };

  // ── 14. Journal headers vs the sum of their own lines ──
  // Section 13 above only checks total_debit == total_credit WITHIN a
  // header row. This checks the header against gl_entries — a header could
  // be internally balanced (debit=credit) while still disagreeing with
  // what its lines actually add up to (a stale header after a line edit,
  // or a header written independently of its lines by some import path).
  const [headerVsLines] = await db.query(
    `SELECT j.id, j.journal_number, j.journal_date, j.total_debit AS headerDebit, j.total_credit AS headerCredit,
            COALESCE(SUM(e.debit),0) AS lineDebit, COALESCE(SUM(e.credit),0) AS lineCredit
     FROM gl_journals j LEFT JOIN gl_entries e ON e.journal_id = j.id
     GROUP BY j.id, j.journal_number, j.journal_date, j.total_debit, j.total_credit
     HAVING ABS(j.total_debit - lineDebit) > 0.01 OR ABS(j.total_credit - lineCredit) > 0.01`
  );
  report.sections.headerVsLinesTieOut = {
    note: 'Every gl_journals row\'s total_debit/total_credit compared against SUM(gl_entries.debit/credit) ' +
          'for that journal\'s own lines — independent of the header-internal debit=credit check above.',
    mismatches: headerVsLines,
  };

  // ── 15. UNCLASSIFIED ACCOUNTS — the release-gate signal ─────────────────
  //
  // The reports currently infer an account's statement section from its code
  // prefix and, for assets, from a regex over its ARABIC NAME. That is why
  // renaming an account can move it on the balance sheet. The end state is
  // that classification comes from stored columns only — so the count that
  // matters is "how many accounts could NOT be classified from stored data".
  //
  // Reported per-reason rather than as one number: an account missing
  // report_section is a different repair from one that is postable but has no
  // normal_balance. Columns added later by the CoA migration are probed
  // dynamically so this section keeps working before AND after it lands.
  const [colRows] = await db.query(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'gl_accounts'`);
  const have = new Set(colRows.map((r) => String(r.c || r.COLUMN_NAME).toLowerCase()));
  const postingLeaf =
    "COALESCE(a.is_folder,0) = 0 AND NOT EXISTS (SELECT 1 FROM gl_accounts _c WHERE _c.parent_id = a.id)";

  const unclassified = {};
  const countWhere = async (label, where) => {
    const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM gl_accounts a WHERE ${where}`);
    unclassified[label] = row.n;
  };
  await countWhere('missingReportSection', "(a.report_section IS NULL OR a.report_section = '')");
  await countWhere('missingReportSection_postingLeaf',
    `(a.report_section IS NULL OR a.report_section = '') AND ${postingLeaf}`);
  await countWhere('missingNameEn', "(a.name_en IS NULL OR a.name_en = '')");
  if (have.has('normal_balance')) {
    await countWhere('missingNormalBalance', "(a.normal_balance IS NULL OR a.normal_balance = '')");
  }
  if (have.has('cash_flow_activity')) {
    await countWhere('missingCashFlowActivity',
      `(a.cash_flow_activity IS NULL OR a.cash_flow_activity = '') AND ${postingLeaf}`);
  }
  const [unclassifiedSample] = await db.query(
    `SELECT a.id, a.code, a.name_ar, a.type, a.report_section, a.is_folder,
            (SELECT COUNT(*) FROM gl_entries e WHERE e.account_id = a.id) AS entries
       FROM gl_accounts a
      WHERE (a.report_section IS NULL OR a.report_section = '') AND ${postingLeaf}
      ORDER BY entries DESC, a.code LIMIT 50`);
  report.sections.unclassifiedAccounts = {
    note: 'Accounts that cannot be placed on a financial statement from STORED data alone. ' +
          'missingReportSection_postingLeaf is the release-gate number: a folder with no section is ' +
          'cosmetic, a POSTING account with no section silently lands in a fallback bucket. ' +
          'Columns not yet added by the CoA migration are skipped rather than reported as zero.',
    columnsPresent: [...have].sort(),
    counts: unclassified,
    sample: unclassifiedSample,
  };

  // ── 16. ACCOUNT REFERENCE SURFACE ───────────────────────────────────────
  //
  // Renumbering or deleting an account is only as safe as the set of things
  // pointing at it. Some tables reference by id, others by CODE — and a
  // code reference does not break loudly when the code changes, it silently
  // resolves to the wrong account or to nothing. This enumerates both and
  // counts live (non-null) references so the migration manifest can be honest
  // about blast radius instead of assuming gl_entries is the only consumer.
  const [refCols] = await db.query(
    `SELECT table_name AS t, column_name AS c
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name <> 'gl_accounts'
        AND (column_name LIKE '%account_id' OR column_name LIKE '%account_code')
      ORDER BY table_name, column_name`);
  const references = [];
  for (const r of refCols) {
    const t = r.t || r.TABLE_NAME;
    const c = r.c || r.COLUMN_NAME;
    // Identifiers come from information_schema, not user input, but they are
    // still backticked rather than interpolated bare.
    try {
      const [[row]] = await db.query(
        `SELECT COUNT(*) AS n FROM \`${t}\` WHERE \`${c}\` IS NOT NULL`);
      references.push({ table: t, column: c, by: /code$/i.test(c) ? 'code' : 'id', nonNull: row.n });
    } catch (e) {
      references.push({ table: t, column: c, by: /code$/i.test(c) ? 'code' : 'id', error: e.message });
    }
  }
  report.sections.accountReferences = {
    note: 'Every column outside gl_accounts that points at an account, with live reference counts. ' +
          'by="code" rows are the dangerous ones: a code change does not fail loudly there.',
    totalColumns: references.length,
    byCodeColumns: references.filter((x) => x.by === 'code').length,
    liveByCodeReferences: references.filter((x) => x.by === 'code').reduce((s, x) => s + (x.nonNull || 0), 0),
    references,
  };

  // ── 17. HARDCODED POSTING CODES IN THE REPO ─────────────────────────────
  //
  // The inventory that account_roles has to replace. Scanned from source, not
  // guessed: a literal 3-6 digit string on a line that also mentions an
  // account/posting concept. Deliberately reported per-file with the matched
  // line so the migration can be worked file by file and the number can be
  // watched down to zero, rather than being a single opaque total.
  report.sections.hardcodedPostingCodes = scanHardcodedCodes(
    path.join(__dirname, '..', '..'));

  writeReport(report, outPath);
  console.log('Audit complete. Report written to:', outPath);
  console.log(JSON.stringify({
    totalAccounts: report.sections.totals.totalAccounts,
    orphans: report.sections.structure.orphans.length,
    cycles: report.sections.structure.cycles.length,
    selfParent: report.sections.structure.selfParent.length,
    depthMismatch: report.sections.structure.depthMismatch.length,
    nonAggregatingParents: report.sections.nonAggregatingParents.length,
    typeMismatch: report.sections.typeMismatch.length,
    postingOnFolder: report.sections.postingOnFolder.length,
    inactiveWithActivity: report.sections.inactiveWithActivity.length,
    nullAccountEntries: report.sections.nullAccountEntries.length,
    balanceMismatch: report.sections.balanceMismatch.mismatches.length,
    coreAccountsMissing: report.sections.legacyCodeDrift.CORE_ACCOUNTS_missing.length,
    coreAccountsWrongParent: report.sections.legacyCodeDrift.CORE_ACCOUNTS_wrongParent.length,
    coreAccountsIncompleteMetadata: report.sections.legacyCodeDrift.CORE_ACCOUNTS_incompleteMetadata.length,
    salaryAccountsMissing: report.sections.legacyCodeDrift.SALARY_ACCOUNTS_missing.length,
    salaryAccountsWrongParent: report.sections.legacyCodeDrift.SALARY_ACCOUNTS_wrongParent.length,
    taxNatureFlags: report.sections.taxNatureFlags.flags.length,
    headerVsLinesMismatch: report.sections.headerVsLinesTieOut.mismatches.length,
    unclassifiedPostingAccounts: report.sections.unclassifiedAccounts.counts.missingReportSection_postingLeaf,
    accountsMissingNameEn: report.sections.unclassifiedAccounts.counts.missingNameEn,
    accountRefColumnsByCode: report.sections.accountReferences.byCodeColumns,
    liveByCodeReferences: report.sections.accountReferences.liveByCodeReferences,
    hardcodedPostingCodeLiterals: report.sections.hardcodedPostingCodes.totalLiterals,
    hardcodedPostingCodeFiles: report.sections.hardcodedPostingCodes.filesAffected,
  }, null, 2));

  await db.end();
}

// ── hardcoded posting-code scanner ────────────────────────────────────────
// A literal like '1110' is only interesting when it is being used AS an
// account. Requiring an account/posting word on the same line is what keeps
// this from drowning in timeouts, HTTP codes and array indexes; the cost is
// that a literal on its own line is missed, so treat the number as a floor.
const SCAN_DIRS = ['lib', 'routes', 'services'];
const CODE_LINE = /(account|acct|debit|credit|posting|coa|gl_|glAccount|CORE_ACCOUNTS|SALARY_ACCOUNTS)/i;
const CODE_LITERAL = /['"](\d{3,6})['"]/g;

function scanHardcodedCodes(root) {
  const perFile = {};
  let total = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      let src;
      try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const rel = path.relative(root, full).replace(/\\/g, '/');
      const hits = [];
      src.split('\n').forEach((line, i) => {
        if (!CODE_LINE.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments describe, they don't post
        const codes = [...line.matchAll(CODE_LITERAL)].map((m) => m[1]);
        if (codes.length) hits.push({ line: i + 1, codes, text: line.trim().slice(0, 160) });
      });
      if (hits.length) {
        perFile[rel] = hits;
        total += hits.reduce((s, h) => s + h.codes.length, 0);
      }
    }
  };
  SCAN_DIRS.forEach((d) => walk(path.join(root, d)));
  const ranked = Object.entries(perFile)
    .map(([file, hits]) => ({ file, literals: hits.reduce((s, h) => s + h.codes.length, 0), lines: hits.length }))
    .sort((a, b) => b.literals - a.literals);
  return {
    note: 'Account-code literals in lib/, routes/, services/ on lines that also mention an account or ' +
          'posting concept. A FLOOR, not an exact count — a literal alone on its own line is not matched. ' +
          'This is the inventory account_roles must replace; the target is zero.',
    scanned: SCAN_DIRS,
    totalLiterals: total,
    filesAffected: ranked.length,
    byFile: ranked,
    detail: perFile,
  };
}

function groupCount(rows, keyOrFn) {
  const out = {};
  for (const r of rows) {
    const k = typeof keyOrFn === 'function' ? keyOrFn(r) : r[keyOrFn];
    const kk = k === null || k === undefined ? 'NULL' : String(k);
    out[kk] = (out[kk] || 0) + 1;
  }
  return out;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function writeReport(report, outPath) {
  const md = renderMarkdown(report);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');
  fs.writeFileSync(outPath.replace(/\.md$/, '.json'), JSON.stringify(report, null, 2), 'utf8');
}

function renderMarkdown(r) {
  const s = r.sections;
  const lines = [];
  lines.push(`# تقرير جرد دليل الحسابات وميزان المراجعة — ${r.envLabel === 'production' ? 'الإنتاج' : 'محلي فقط'}`);
  lines.push('');
  lines.push(`> **تحذير:** هذا التقرير يعكس قاعدة بيانات \`${r.target.db}\` على المضيف \`${r.target.host}\` فقط.` +
    (r.envLabel !== 'production' ? ' **لا يمثل بيانات الإنتاج.** لم يُدقَّق الإنتاج بعد (بموافقة المستخدم على تأجيله).' : ''));
  lines.push('');
  lines.push(`تاريخ التوليد: ${r.generatedAt} — MySQL ${r.target.version}`);
  lines.push('');
  lines.push('## 1. الإجماليات');
  lines.push('');
  lines.push(`- إجمالي الحسابات: **${s.totals.totalAccounts}**`);
  lines.push(`- حسب النوع: ${JSON.stringify(s.totals.byType)}`);
  lines.push(`- حسب المستوى: ${JSON.stringify(s.totals.byLevel)}`);
  lines.push(`- نشط/غير نشط: ${JSON.stringify(s.totals.byActive)}`);
  lines.push(`- Folder/Posting: ${JSON.stringify(s.totals.byFolder)}`);
  lines.push(`- ${s.totals.note}`);
  lines.push('');
  lines.push('## 2. سلامة الشجرة');
  lines.push('');
  lines.push(`- الجذور (${s.structure.roots.length}): ${s.structure.roots.map(a => `${a.code} ${a.name}`).join('، ') || 'لا شيء'}`);
  lines.push(`- أيتام (parent_id لا يطابق حسابًا) (${s.structure.orphans.length}): ${fmtList(s.structure.orphans, a => `${a.code} ${a.name} → parent_id=${a.parentId}`)}`);
  lines.push(`- Self-parent (${s.structure.selfParent.length}): ${fmtList(s.structure.selfParent, a => `${a.code} ${a.name}`)}`);
  lines.push(`- حلقات (${s.structure.cycles.length}): ${fmtList(s.structure.cycles, c => `${c.start}`)}`);
  lines.push(`- اختلاف level المخزَّن عن عمق الشجرة الفعلي (${s.structure.depthMismatch.length}): ${fmtList(s.structure.depthMismatch, d => `${d.code} ${d.name} (مخزَّن=${d.storedLevel}, فعلي=${d.computedDepth})`)}`);
  lines.push('');
  lines.push('## 3. Parent غير تجميعي (له أبناء لكن is_folder=0)');
  lines.push('');
  lines.push(fmtList(s.nonAggregatingParents, a => `${a.code} ${a.name}`) || 'لا شيء');
  lines.push('');
  lines.push('## 4. اختلاف النوع بين الأب والابن');
  lines.push('');
  lines.push(fmtList(s.typeMismatch, a => `${a.code} ${a.name} (${a.childType}) تحت ${a.parentCode} (${a.parentType})`) || 'لا شيء');
  lines.push('');
  lines.push('## 5. أكواد مكررة');
  lines.push('');
  lines.push(`العدد: ${s.duplicateCodes.count} — ${s.duplicateCodes.note}`);
  lines.push('');
  lines.push('## 6. Posting على Folder');
  lines.push('');
  lines.push(fmtList(s.postingOnFolder, a => `${a.code} ${a.name_ar} — ${a.entryCount} قيد`) || 'لا شيء');
  lines.push('');
  lines.push('## 7. حسابات غير نشطة لها حركة');
  lines.push('');
  lines.push(fmtList(s.inactiveWithActivity, a => `${a.code} ${a.name_ar} — ${a.entryCount} قيد`) || 'لا شيء');
  lines.push('');
  lines.push(`## 8. قيود بـ account_id = NULL (${s.nullAccountEntries.length})`);
  lines.push('');
  lines.push(fmtList(s.nullAccountEntries, e => `journal ${e.journal_number || e.journal_id} (${fmtDate(e.journal_date)}, ${e.status}) — كود مسجَّل تاريخيًا: ${e.account_code || '—'} "${e.account_name || '—'}" مدين=${e.debit} دائن=${e.credit}`) || 'لا شيء');
  lines.push('');
  lines.push('## 9. اختلاف gl_accounts.balance عن المُشتق من القيود المرحّلة');
  lines.push('');
  lines.push(`> ${s.balanceMismatch.note}`);
  lines.push('');
  lines.push(fmtList(s.balanceMismatch.mismatches, m => `${m.code} ${m.name} (${m.type}) — مخزَّن=${m.storedBalance}، خام(مدين-دائن)=${m.derivedRawDebitMinusCredit}، عرض-الجانب-الطبيعي=${m.derivedNormalSidePresentation}`) || 'لا شيء');
  lines.push('');
  lines.push('## 10. انحراف الأكواد الثابتة القديمة (CORE_ACCOUNTS / SALARY_ACCOUNTS)');
  lines.push('');
  lines.push(`> ${s.legacyCodeDrift.note}`);
  lines.push('');
  lines.push(`- CORE_ACCOUNTS المفقودة من الشجرة الحالية: ${fmtList(s.legacyCodeDrift.CORE_ACCOUNTS_missing, x => `${x.key}=${x.code}`) || 'لا شيء (كلها موجودة بالفعل — الشجرة الحالية لا تزال بالنظام القديم)'}`);
  lines.push(`- CORE_ACCOUNTS بأب خاطئ (الكود موجود لكن تحت أب مختلف عمّا يُعرِّفه الكود المصدري): ${fmtList(s.legacyCodeDrift.CORE_ACCOUNTS_wrongParent, x => `${x.key}=${x.code} (مُعلَن=${x.declaredParent}، فعلي=${x.actualParent})`) || 'لا شيء'}`);
  lines.push(`- CORE_ACCOUNTS بحقول تصنيف/تقرير ناقصة (name_en/report_section/account_class): ${fmtList(s.legacyCodeDrift.CORE_ACCOUNTS_incompleteMetadata, x => `${x.key}=${x.code} (ناقص: ${x.missingFields.join(', ')})`) || 'لا شيء'}`);
  lines.push(`- SALARY_ACCOUNTS المفقودة: ${fmtList(s.legacyCodeDrift.SALARY_ACCOUNTS_missing, x => `${x.key}=${x.code}`) || 'لا شيء'}`);
  lines.push(`- SALARY_ACCOUNTS بأب خاطئ: ${fmtList(s.legacyCodeDrift.SALARY_ACCOUNTS_wrongParent, x => `${x.key}=${x.code} (مُعلَن=${x.declaredParent}، فعلي=${x.actualParent})`) || 'لا شيء'}`);
  lines.push(`- SALARY_ACCOUNTS بحقول تصنيف/تقرير ناقصة: ${fmtList(s.legacyCodeDrift.SALARY_ACCOUNTS_incompleteMetadata, x => `${x.key}=${x.code} (ناقص: ${x.missingFields.join(', ')})`) || 'لا شيء'}`);
  lines.push(`- SALARY parents المفقودة: ${fmtList(s.legacyCodeDrift.SALARY_PARENTS_missing, x => x.code) || 'لا شيء'}`);
  lines.push('');
  lines.push('## 11. تصنيف ضريبي مشكوك (tax_nature)');
  lines.push('');
  lines.push(`> ${s.taxNatureFlags.note}`);
  lines.push('');
  lines.push(fmtList(s.taxNatureFlags.flags, f => `${f.code} ${f.name} — tax_nature=${f.taxNature}، المتوقع=${f.suspectedCorrect || '—'}`) || 'لا شيء على القاعدة المحلية الحالية (القالب الجديد لم يُزرَع بعد هنا)');
  lines.push('');
  lines.push('## 12. مرشحو Account Role (لم يُعيَّن أي منها تلقائيًا)');
  lines.push('');
  for (const [role, cands] of Object.entries(s.roleCandidates.candidates)) {
    lines.push(`- **${role}**: ${cands.length ? cands.map(c => `${c.code} ${c.name}`).join('، ') : 'لا مرشح محلي'}`);
  }
  lines.push('');
  lines.push('## 13. سلامة القيود (gl_journals)');
  lines.push('');
  lines.push(`- الإجمالي: ${s.journals.totals.n} (posted=${s.journals.totals.posted}, draft=${s.journals.totals.draft}, approved=${s.journals.totals.approved})`);
  lines.push(`- إجمالي مدين=${s.journals.totals.totalDebit}, إجمالي دائن=${s.journals.totals.totalCredit}`);
  lines.push(`- قيود غير متوازنة على مستوى الرأس (${s.journals.imbalancedHeaders.length}): ${fmtList(s.journals.imbalancedHeaders, j => `${j.journal_number} (${fmtDate(j.journal_date)}) مدين=${j.total_debit} دائن=${j.total_credit}`) || 'لا شيء'}`);
  lines.push('');
  lines.push('## 14. تطابق رأس القيد مع مجموع سطوره');
  lines.push('');
  lines.push(`> ${s.headerVsLinesTieOut.note}`);
  lines.push('');
  lines.push(fmtList(s.headerVsLinesTieOut.mismatches, j => `${j.journal_number} (${fmtDate(j.journal_date)}) — رأس: مدين=${j.headerDebit} دائن=${j.headerCredit}؛ سطور: مدين=${j.lineDebit} دائن=${j.lineCredit}`) || 'لا شيء');
  lines.push('');
  return lines.join('\n');
}

function fmtList(arr, fn) {
  if (!arr || !arr.length) return '';
  return arr.map(fn).join('؛ ');
}

function fmtDate(d) {
  if (!d) return '—';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

main().catch(e => {
  console.error('AUDIT FAILED:', e);
  process.exitCode = 1;
});
