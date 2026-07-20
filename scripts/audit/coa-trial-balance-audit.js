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
 *
 * --env is a LABEL ONLY (stamped into the report header) — it does not change
 * which database is queried. Pointing this at production requires the caller
 * to supply production credentials via env vars themselves; this script does
 * not know how to reach Railway and will not attempt to.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../db/connection');

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

async function main() {
  const args = process.argv.slice(2);
  const envLabel = (args.includes('--env') ? args[args.indexOf('--env') + 1] : 'local') || 'local';
  const outArgIdx = args.indexOf('--out');
  const outPath = outArgIdx >= 0 ? args[outArgIdx + 1]
    : path.join(__dirname, '..', '..', 'docs', 'audits',
        envLabel === 'production' ? 'COA_TRIAL_BALANCE_AUDIT_PRODUCTION_AR.md'
                                   : 'COA_TRIAL_BALANCE_AUDIT_LOCAL_AR.md');

  const report = { envLabel, generatedAt: new Date().toISOString(), sections: {} };

  // Which physical database are we actually pointed at? (host+db name only,
  // never credentials) — stamped into the report so nobody mistakes this for
  // a different environment later.
  const [[target]] = await db.query('SELECT DATABASE() AS db, @@hostname AS host, @@version AS version');
  report.target = target;

  // ── 1. Raw counts ──
  const [accounts] = await db.query(
    'SELECT id, code, name_ar, name_en, type, parent_id, level, is_active, is_folder, ' +
    'balance, account_class, report_section, tax_nature FROM gl_accounts'
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
  };

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
  }, null, 2));

  await db.end();
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
