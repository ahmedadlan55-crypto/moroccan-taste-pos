#!/usr/bin/env node
'use strict';
/**
 * tests/coaReportClassification.test.js — PACKAGE G.
 *
 * Four financial statements used to classify the same chart four different
 * ways, and every one of them was inference:
 *
 *  1. routes/erp/reports/balance-sheet.js ran a REGEX OVER THE ARABIC NAME
 *     before it read the stored report_section, so RENAMING AN ACCOUNT MOVED
 *     IT ON THE BALANCE SHEET. The regex needed 'مجمَّع الإهلاك' and
 *     'مجمع الإهلاك' as two separate alternatives — a name is not a
 *     classification, and that is the proof.
 *  2. routes/erp/reports/cash-flow.js was 100% code prefix and never read
 *     report_section at all. It called code `112` INVENTORY while the balance
 *     sheet called the same account RECEIVABLES: two statements, one account,
 *     two answers.
 *  3. lib/reports/trialBalance.js derived the expected side from `type` alone
 *     and had NO contra concept, so accumulated depreciation, drawings and the
 *     doubtful-debt allowance were flagged `abnormalSign` on every run and
 *     inflated totals.abnormalCount permanently.
 *  4. routes/erp/reports/income.js bucketed by code prefix (51x/52x/53x/6x).
 *
 * These tests are PURE — no database, no express, no fixtures — because the
 * defect is in the decision function, and a decision function is exactly what
 * a unit test pins. Plus two STATIC assertions on the report sources, because
 * "the old heuristic is deleted" is a property of the file, not of a value.
 *
 * Run: node tests/coaReportClassification.test.js   (pure, no DB)
 */
const fs = require('fs');
const path = require('path');
const c = require('../lib/coa/classify');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A fully-migrated account: every classification column populated.
const acc = (over) => Object.assign({
  id: 'A1', code: '1130', name_ar: 'المخزون الرئيسي', name_en: 'Main inventory',
  type: 'asset', report_section: 'inventory',
  normal_balance: 'debit', is_contra: 0, cash_flow_activity: null, status: 'active',
  is_active: 1,
}, over || {});

// ═════════════════════════════════════════════════════════════════════════
// 1. STORED BEATS LEGACY — the column wins over the code prefix
// ═════════════════════════════════════════════════════════════════════════
{
  // Code 112 is RECEIVABLES to the legacy asset prefix table. Give the same
  // account a stored report_section of 'inventory' and the stored value wins.
  const a = acc({ code: '112', report_section: 'inventory' });
  const s = c.sectionOf(a);
  check('stored report_section beats the code prefix', s.section === 'inventory', s);
  check('…and says so: source=stored', s.source === c.SOURCES.STORED, s.source);
  check('…and is not flagged unmapped', s.unmapped === false, s);

  const legacy = c.legacySectionByCode(a);
  check('the legacy table really would have said receivables for 112',
    legacy.section === 'receivables', legacy);
  check('the legacy table always admits it guessed',
    legacy.source === c.SOURCES.LEGACY_PREFIX && legacy.unmapped === true, legacy);
}

// ═════════════════════════════════════════════════════════════════════════
// 2. THE BALANCE-SHEET RENAME REGRESSION — a renamed account does not move
// ═════════════════════════════════════════════════════════════════════════
{
  // The old classifyAssetByName matched /إهلاك|depreciation/ on any 1x asset
  // and forced it into nonCurrentAssets.accDep, BEFORE report_section was
  // consulted. Same account, four names, one answer.
  const base = { code: '1130', type: 'asset', report_section: 'inventory', normal_balance: 'debit', is_contra: 0 };
  const names = [
    'المخزون الرئيسي',
    'مجمع الإهلاك',            // used to hijack it to accDep
    'مجمَّع الإهلاك',          // …and this spelling needed its OWN regex branch
    'مخصص الديون المشكوك فيها', // used to hijack it to allowanceDoubtful
    'عهدة ADLAN',              // used to hijack it to receivables
    'Accumulated depreciation',
  ];
  const results = names.map((n) => JSON.stringify(c.balanceSheetGroupOf(acc(Object.assign({ name_ar: n, name_en: n }, base))).group));
  check('renaming an account does NOT move it on the balance sheet',
    new Set(results).size === 1, results);
  check('…and it stays where report_section put it (currentAssets.inventory)',
    results[0] === JSON.stringify(['currentAssets', 'inventory']), results[0]);

  // Same proof from the other direction: a name that says nothing about
  // depreciation still lands in accDep when the SECTION says acc_dep.
  const g = c.balanceSheetGroupOf(acc({ code: '9999', name_ar: 'حساب بلا اسم دال', report_section: 'acc_dep' }));
  check('the section alone puts an account in accDep, no name needed',
    JSON.stringify(g.group) === JSON.stringify(['nonCurrentAssets', 'accDep']), g);
  check('…from stored data, not a guess', g.source === c.SOURCES.STORED && g.unmapped === false, g);
}

// ═════════════════════════════════════════════════════════════════════════
// 3. THE 112 CONTRADICTION — the two statements can no longer disagree
// ═════════════════════════════════════════════════════════════════════════
{
  const a = acc({ code: '112', report_section: 'receivables' });
  const bsGroup = c.balanceSheetGroupOf(a);
  const cf = c.cashFlowBucketOf(a);
  check('balance sheet puts stored-receivables in currentAssets.receivables',
    JSON.stringify(bsGroup.group) === JSON.stringify(['currentAssets', 'receivables']), bsGroup);
  check('cash flow puts the SAME account in the receivables bucket',
    cf.bucket === 'receivables', cf);
  check('cash flow read it from stored data, not a prefix', cf.source === c.SOURCES.STORED, cf);

  // And when BOTH are forced to guess (no report_section at all), they guess
  // identically — because both guesses come from the same table.
  const bare = { id: 'X', code: '112', type: 'asset' };
  const bsLegacy = c.balanceSheetGroupOf(bare);
  const cfLegacy = c.cashFlowBucketOf(bare);
  check('with no stored section, the balance sheet falls back to receivables',
    JSON.stringify(bsLegacy.group) === JSON.stringify(['currentAssets', 'receivables']), bsLegacy);
  check('with no stored section, cash flow ALSO says receivables (never inventory)',
    cfLegacy.bucket === 'receivables', cfLegacy);
  check('both flag the fallback as a guess',
    bsLegacy.unmapped === true && cfLegacy.unmapped === true, [bsLegacy.unmapped, cfLegacy.unmapped]);
  check('both stamp source=legacy_prefix',
    bsLegacy.source === c.SOURCES.LEGACY_PREFIX && cfLegacy.source === c.SOURCES.LEGACY_PREFIX,
    [bsLegacy.source, cfLegacy.source]);
}

// ═════════════════════════════════════════════════════════════════════════
// 4. CONTRA COMES FROM THE COLUMN — never from a name, never from a code
// ═════════════════════════════════════════════════════════════════════════
{
  const declared = acc({ code: '1220', name_ar: 'مجمع الإهلاك', type: 'asset', report_section: 'acc_dep', is_contra: 1 });
  check('a declared contra account is contra', c.isContra(declared) === true);
  check('…and says the flag came from the column',
    c.contraOf(declared).source === c.SOURCES.STORED, c.contraOf(declared));

  // The killer: the NAME screams accumulated depreciation, the column says no.
  const notDeclared = acc({ code: '1220', name_ar: 'مجمع الإهلاك', name_en: 'Accumulated depreciation', is_contra: 0 });
  check('a name that says "accumulated depreciation" does NOT make it contra',
    c.isContra(notDeclared) === false);
  const drawingsName = acc({ code: '3300', name_ar: 'المسحوبات', type: 'equity', is_contra: 0 });
  check('a name that says "المسحوبات" does NOT make it contra',
    c.isContra(drawingsName) === false);
  const codeOnly = acc({ code: '100600', name_ar: 'أصل ثابت', is_contra: 0 });
  check('the old 1006 code-prefix contra rule is gone too', c.isContra(codeOnly) === false);

  // A column that was never projected is NOT the same as a column that is 0.
  const noColumn = { id: 'N', code: '1220', type: 'asset' };
  const co = c.contraOf(noColumn);
  check('an unprojected is_contra reports unmapped, not a confident false',
    co.isContra === false && co.unmapped === true && co.source === c.SOURCES.NONE, co);

  // THE DATA GAP. is_contra is NOT NULL DEFAULT 0, and 0028 only seeded the
  // rows that existed on migration day. An account created afterwards
  // declaring report_section='drawings' arrives with the column at 0 —
  // reading the column alone would silently un-contra it.
  const freshDrawings = { id: 'D', code: 'X9', type: 'equity', report_section: 'drawings', is_contra: 0 };
  check('the raw column still reports the default 0', c.isContra(freshDrawings) === false);
  const eff = c.effectiveContraOf(freshDrawings);
  check('a section that DECLARES contra is honoured for the statements',
    eff.isContra === true, eff);
  check('…and the column/section disagreement is surfaced, not silently resolved',
    eff.disagreesWithSection === true, eff);
  check('…so the expected side flips, and it is not abnormal',
    c.expectedSideOf(freshDrawings).expectedSide === 'debit', c.expectedSideOf(freshDrawings));

  // A non-contra section does not manufacture contra out of nothing.
  const freshInventory = { id: 'V', code: 'X8', type: 'asset', report_section: 'inventory', is_contra: 0 };
  check('a non-contra section leaves a non-contra account alone',
    c.effectiveContraOf(freshInventory).isContra === false);
  check('…and reports no disagreement',
    c.effectiveContraOf(freshInventory).disagreesWithSection === false);

  // A NAME still cannot do it, whichever route you take.
  const namedOnly = { id: 'M', code: 'X7', type: 'asset', name_ar: 'مجمع الإهلاك', is_contra: 0 };
  check('a contra-sounding NAME with no section and no flag is still not contra',
    c.effectiveContraOf(namedOnly).isContra === false, c.effectiveContraOf(namedOnly));
}

// ═════════════════════════════════════════════════════════════════════════
// 5. THE TRIAL-BALANCE ABNORMAL-SIGN RULE (defect #3), as pure logic
// ═════════════════════════════════════════════════════════════════════════
{
  // expectedSideOf() is the whole of the fix: contra flips the expected side.
  const accDep = acc({ code: '1220', type: 'asset', normal_balance: 'debit', is_contra: 1, report_section: 'acc_dep' });
  check('accumulated depreciation EXPECTS a credit balance',
    c.expectedSideOf(accDep).expectedSide === 'credit', c.expectedSideOf(accDep));

  const drawings = acc({ code: '3300', type: 'equity', normal_balance: 'credit', is_contra: 1, report_section: 'drawings' });
  check('owner drawings EXPECT a debit balance',
    c.expectedSideOf(drawings).expectedSide === 'debit', c.expectedSideOf(drawings));

  const allowance = acc({ code: '1124', type: 'asset', normal_balance: 'debit', is_contra: 1, report_section: 'allowance_doubtful' });
  check('the doubtful-debt allowance EXPECTS a credit balance',
    c.expectedSideOf(allowance).expectedSide === 'credit', c.expectedSideOf(allowance));

  // The check that must NOT be weakened.
  const plainAsset = acc({ code: '1110', type: 'asset', normal_balance: 'debit', is_contra: 0 });
  check('a NON-contra asset still expects a debit balance — a credit one is abnormal',
    c.expectedSideOf(plainAsset).expectedSide === 'debit', c.expectedSideOf(plainAsset));

  // Reproduce trialBalance.js's abnormalSign expression against both.
  const abnormal = (a, closeDebit, closeCredit) => {
    const expectsDebit = c.expectedSideOf(a).expectedSide !== 'credit';
    return expectsDebit ? closeCredit > 0.01 : closeDebit > 0.01;
  };
  check('acc-dep with a 5,000 CREDIT balance is NOT abnormal', abnormal(accDep, 0, 5000) === false);
  check('a cash account with a 5,000 CREDIT balance IS abnormal', abnormal(plainAsset, 0, 5000) === true);
  check('drawings with a 3,000 DEBIT balance is NOT abnormal', abnormal(drawings, 3000, 0) === false);
  check('ordinary equity with a 3,000 DEBIT balance IS abnormal',
    abnormal(acc({ type: 'equity', normal_balance: 'credit', is_contra: 0 }), 3000, 0) === true);
}

// ═════════════════════════════════════════════════════════════════════════
// 6. NULL cash_flow_activity IS UNMAPPED — it is never guessed into 'other'
// ═════════════════════════════════════════════════════════════════════════
{
  // 0028 deliberately leaves this NULL on 91 posting accounts. NULL means
  // "nobody has decided", and a statement must not turn that into a number.
  const undecided = acc({ cash_flow_activity: null });
  const r = c.cashFlowActivityOf(undecided);
  check('a NULL cash_flow_activity comes back as null', r.activity === null, r);
  check('…flagged unmapped', r.unmapped === true, r);
  check('…and NEVER as the string "other"', r.activity !== 'other', r);
  check('…with source=none, not a fake "stored"', r.source === c.SOURCES.NONE, r);

  const stated = acc({ cash_flow_activity: 'investing' });
  const r2 = c.cashFlowActivityOf(stated);
  check('a stated activity is returned as stored',
    r2.activity === 'investing' && r2.source === c.SOURCES.STORED && r2.unmapped === false, r2);

  // A junk value is not an activity either.
  const junk = c.cashFlowActivityOf(acc({ cash_flow_activity: 'operatinggg' }));
  check('a value outside the ENUM is unmapped, not passed through',
    junk.activity === null && junk.unmapped === true, junk);

  // The stored activity outranks the bucket's default: a PPE account whose
  // owner declared it operating lands in operating.
  const ppeOperating = acc({ code: '1210', type: 'asset', report_section: 'ppe', cash_flow_activity: 'operating' });
  const cf = c.cashFlowBucketOf(ppeOperating);
  check('a stored activity outranks the bucket default', cf.activity === 'operating', cf);
  check('…while the bucket still describes WHAT it is', cf.bucket === 'fixedAssets', cf);
  const ppeDefault = acc({ code: '1210', type: 'asset', report_section: 'ppe', cash_flow_activity: null });
  check('with no stored activity, PP&E defaults to investing',
    c.cashFlowBucketOf(ppeDefault).activity === 'investing', c.cashFlowBucketOf(ppeDefault));
}

// ═════════════════════════════════════════════════════════════════════════
// 7. PROVENANCE IS CORRECT IN EVERY CASE
// ═════════════════════════════════════════════════════════════════════════
{
  const stored = c.normalBalanceOf(acc({ normal_balance: 'credit' }));
  check('normal_balance from the column → source=stored',
    stored.normalBalance === 'credit' && stored.source === c.SOURCES.STORED && stored.unmapped === false, stored);

  const fallback = c.normalBalanceOf({ id: 'F', code: '5100', type: 'expense' });
  check('normal_balance absent → derived from type',
    fallback.normalBalance === 'debit', fallback);
  check('…stamped source=type_fallback', fallback.source === c.SOURCES.TYPE_FALLBACK, fallback);
  check('…and flagged unmapped, because it is a derivation', fallback.unmapped === true, fallback);

  // The stored column WINS even when it contradicts the type. That is the
  // point of storing it — the type is the coarser fact.
  const contradiction = c.normalBalanceOf({ id: 'C', type: 'asset', normal_balance: 'credit' });
  check('a stored normal_balance overrides the type', contradiction.normalBalance === 'credit', contradiction);
  check('…without pretending it was derived', contradiction.source === c.SOURCES.STORED, contradiction);

  const nothing = c.normalBalanceOf({ id: 'Z' });
  check('no column and no type → null, source=none, unmapped',
    nothing.normalBalance === null && nothing.source === c.SOURCES.NONE && nothing.unmapped === true, nothing);

  // A report_section that is set but is NOT in the vocabulary is worse than
  // NULL: it LOOKS classified. It must not pass for stored data.
  const typo = c.sectionOf(acc({ report_section: 'inventtory' }));
  check('an unknown report_section does not silently classify',
    typo.unmapped === true, typo);
  check('…and the offending value is named for the diagnostic',
    typo.invalidStoredSection === 'inventtory', typo);

  // Live spellings that predate `statement_sections` still resolve.
  for (const [live, canonical] of [
    ['vat_input', 'input_vat'], ['vat_output', 'output_vat'], ['prepaid', 'prepayments'],
    ['customer_deposits', 'customer_advances'], ['retained', 'retained_earnings'],
  ]) {
    const s = c.sectionOf({ id: 'L', code: '0', type: 'asset', report_section: live });
    check(`live spelling '${live}' resolves to '${canonical}' as stored data`,
      s.section === canonical && s.source === c.SOURCES.STORED && s.unmapped === false, s);
  }

  // camelCase rows (hand-built objects, not mysql2 rows) must classify too —
  // an adapter that reads only snake_case reports everything as unmapped.
  const camel = c.sectionOf({ id: 'K', code: '1130', type: 'asset', reportSection: 'inventory' });
  check('a camelCase reportSection is read, not silently dropped',
    camel.section === 'inventory' && camel.source === c.SOURCES.STORED, camel);
}

// ═════════════════════════════════════════════════════════════════════════
// 8. INCOME STATEMENT — sections, then the flagged prefix
// ═════════════════════════════════════════════════════════════════════════
{
  const cogs = c.incomeBucketOf({ id: 'I1', code: '9999', type: 'expense', report_section: 'waste' });
  check('a "waste" section lands in COGS regardless of its code',
    cogs.bucket === 'cogs' && cogs.source === c.SOURCES.STORED && cogs.unmapped === false, cogs);

  const payroll = c.incomeBucketOf({ id: 'I2', code: '6100', type: 'expense', report_section: 'payroll' });
  check('a "payroll" section is OpEx even though code 6x meant other-expense',
    payroll.bucket === 'opex' && payroll.unmapped === false, payroll);

  const returns = c.incomeBucketOf({ id: 'I3', code: '4150', type: 'revenue', report_section: 'sales_returns' });
  check('sales returns net INSIDE revenue (contra-revenue), not a section of their own',
    returns.bucket === 'revenue', returns);

  const gna = c.incomeBucketOf({ id: 'I4', code: '5310', type: 'expense' });
  check('G&A has no section in the vocabulary yet, so 53x still resolves',
    gna.bucket === 'gAndA', gna);
  check('…but is reported as a guess', gna.source === c.SOURCES.LEGACY_PREFIX && gna.unmapped === true, gna);
}

// ═════════════════════════════════════════════════════════════════════════
// 9. ARCHIVED ACCOUNTS KEEP THEIR HISTORY
// ═════════════════════════════════════════════════════════════════════════
{
  const archived = acc({ status: 'archived', is_active: 0 });
  check('an archived account WITH movement in the period still reports',
    c.isReportable(archived, true) === true);
  check('an archived account with NO movement does not',
    c.isReportable(archived, false) === false);
  check('an active account always reports', c.isReportable(acc({}), false) === true);
  check("a 'blocked' account still reports (it is refused new postings, not closed)",
    c.isReportable(acc({ status: 'blocked' }), false) === true);
  check('the SQL predicate keeps archived rows in the result set',
    /status/.test(c.REPORTABLE_ACCOUNT_SQL('a')) && /archived/.test(c.REPORTABLE_ACCOUNT_SQL('a')),
    c.REPORTABLE_ACCOUNT_SQL('a'));
}

// ═════════════════════════════════════════════════════════════════════════
// 10. THE CATALOG MIRRORS statement_sections
// ═════════════════════════════════════════════════════════════════════════
{
  const seeded = c.SECTION_CATALOG.filter((s) => s.inCatalogTable);
  check('the catalog carries all 29 statement_sections rows', seeded.length === 29, seeded.length);
  const statements = new Set(c.SECTION_CATALOG.map((s) => s.statement));
  check('every catalog row names a real statement',
    [...statements].every((s) => ['balance_sheet', 'income_statement', 'cash_flow', 'equity'].includes(s)),
    [...statements]);
  check('every balance-sheet section has a bucket the report can render',
    c.SECTION_CATALOG.filter((s) => s.statement === 'balance_sheet').every((s) => Array.isArray(s.bsGroup)));
  check('every income-statement section has a bucket the report can render',
    c.SECTION_CATALOG.filter((s) => s.statement === 'income_statement').every((s) => !!s.incomeBucket));
  check('the gaps between the live vocabulary and the table are NAMED, not hidden',
    c.catalogGaps().length > 0 && c.catalogGaps().includes('eosb'), c.catalogGaps());
  // Contra flags in the catalog match the migration's seed.
  check('acc_dep is contra in the catalog', c.SECTIONS.acc_dep.isContra === true);
  check('drawings is contra in the catalog', c.SECTIONS.drawings.isContra === true);
  check('allowance_doubtful is contra in the catalog', c.SECTIONS.allowance_doubtful.isContra === true);
  check('inventory is NOT contra', c.SECTIONS.inventory.isContra === false);
}

// ═════════════════════════════════════════════════════════════════════════
// 11. STATIC — the deleted heuristics are actually deleted
// ═════════════════════════════════════════════════════════════════════════
{
  const bsSrc = read('routes/erp/reports/balance-sheet.js');
  // The identifier itself, not a prose mention: matching a substring that also
  // appears in your own comment is how a "fixed" defect passes its own test.
  check('balance-sheet.js no longer defines the by-name asset classifier',
    !/function\s+classifyAssetByName/.test(bsSrc));
  check('balance-sheet.js no longer references classifyAssetByName at all',
    !/classifyAssetByName/.test(bsSrc));
  check('balance-sheet.js no longer regex-matches Arabic account names',
    !/مجمَّع الإهلاك\|مجمع الإهلاك/.test(bsSrc) && !/\/.*عهدة.*\//.test(bsSrc));
  check('balance-sheet.js no longer name-matches "accumulated depreciation" in English',
    !/accumulated depreciation\|drawings/i.test(bsSrc));
  check('balance-sheet.js delegates to the shared classifier',
    /require\(['"]\.\.\/\.\.\/\.\.\/lib\/coa\/classify['"]\)/.test(bsSrc));
  check('balance-sheet.js still exports what equity-changes.js imports',
    /module\.exports\.LEAF_ACCOUNT_WHERE/.test(bsSrc) &&
    /module\.exports\.CONTRA_GROUP_KEYS/.test(bsSrc) &&
    /module\.exports\.classifyByReportSection/.test(bsSrc) &&
    /module\.exports\.classifyEquity/.test(bsSrc));
  check('balance-sheet.js returns an unmapped array', /unmapped: unmapped/.test(bsSrc));

  const cfSrc = read('routes/erp/reports/cash-flow.js');
  check("cash-flow.js no longer hardcodes a '112' prefix rule",
    !/startsWith\(\s*'112'/.test(cfSrc) && !/'112'/.test(cfSrc));
  check('cash-flow.js no longer owns a private category() classifier',
    !/function\s+category\s*\(/.test(cfSrc));
  check('cash-flow.js no longer hardcodes the 124 accumulated-depreciation prefix',
    !/startsWith\(\s*'124'/.test(cfSrc) && !/'124'/.test(cfSrc));
  check('cash-flow.js no longer has a catch-all "other" bucket',
    !/return\s+'other'/.test(cfSrc));
  check('cash-flow.js delegates to the shared classifier',
    /require\(['"]\.\.\/\.\.\/\.\.\/lib\/coa\/classify['"]\)/.test(cfSrc));
  check('cash-flow.js returns an unmapped array', /unmapped,/.test(cfSrc));

  const incSrc = read('routes/erp/reports/income.js');
  check('income.js no longer buckets by code prefix',
    !/code\.startsWith\(\s*'5[123]'/.test(incSrc) && !/code\.startsWith\(\s*'42'/.test(incSrc));
  check('income.js delegates to the shared classifier',
    /classify\.incomeBucketOf/.test(incSrc));
  check('income.js returns an unmapped array', /unmapped,/.test(incSrc));

  const tbSrc = read('lib/reports/trialBalance.js');
  check('trialBalance.js no longer derives the abnormal flag from type alone',
    !/const abnormalSign = isDebitNormal \?/.test(tbSrc));
  check('trialBalance.js uses the contra-aware expected side',
    /expectsDebit \? closeCredit > 0\.01 : closeDebit > 0\.01/.test(tbSrc));
  check('trialBalance.js returns an unmapped array', /^\s*unmapped,$/m.test(tbSrc));
  check('trialBalance.js still includes every account regardless of is_active',
    /FROM gl_accounts a ORDER BY/.test(tbSrc));

  const eqSrc = read('routes/erp/reports/equity-changes.js');
  check('equity-changes.js returns an unmapped array', /unmapped$/m.test(eqSrc));
}

// ── Report ────────────────────────────────────────────────────────────────
console.log('\ntests/coaReportClassification.test.js');
if (failures.length === 0) {
  console.log(`  ✅ ${pass}/${pass} checks passed`);
  process.exit(0);
}
console.error(`  ❌ ${failures.length} failed, ${pass} passed`);
failures.forEach((f) => console.error('     - ' + f));
process.exit(1);
