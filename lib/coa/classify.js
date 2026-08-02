'use strict';
/**
 * lib/coa/classify.js — the ONE classifier every financial statement uses.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Before 0028_coa_metadata.sql an account's place on a financial statement was
 * *inferred*, and every report inferred it differently:
 *
 *   • routes/erp/reports/balance-sheet.js ran a REGEX OVER THE ARABIC NAME
 *     (classifyAssetByName) BEFORE consulting the stored report_section — so
 *     renaming an account moved it on the balance sheet. The regex had to list
 *     'مجمَّع الإهلاك' and 'مجمع الإهلاك' as separate alternatives, which is the
 *     clearest possible proof that a name is not a classification.
 *   • routes/erp/reports/cash-flow.js was 100% code prefix and never read
 *     report_section at all. It called code `112` INVENTORY while the balance
 *     sheet called the same `112` RECEIVABLES. The two statements disagreed
 *     about the same account by construction.
 *   • lib/reports/trialBalance.js derived the expected side from `type` alone
 *     and had no concept of a contra account, so accumulated depreciation,
 *     drawings and the doubtful-debt allowance — every one of them sitting on
 *     exactly the side it is supposed to sit on — were flagged `abnormalSign`
 *     and counted in totals.abnormalCount.
 *   • routes/erp/reports/income.js classified by code prefix (51x/52x/53x/6x).
 *
 * The fix is not a better heuristic. The account states its own classification
 * (gl_accounts.normal_balance / is_contra / report_section / cash_flow_activity)
 * and this module reads it. Inference still exists — a chart is not migrated in
 * a day — but it is QUARANTINED behind the `legacy*` functions below, it is
 * only consulted when the stored value is absent, and it always reports
 * source='legacy_prefix' + unmapped=true so it shows up in the report payload's
 * `unmapped` array instead of passing for a real answer.
 *
 * PROVENANCE IS THE POINT. Every result carries `source` and `unmapped`. That
 * is what lets a diagnostic tell "classified correctly" apart from "fell
 * through to a guess" — the distinction the old code made structurally
 * impossible.
 *
 * ONE DELIBERATE EXCEPTION TO "every return value carries source/unmapped":
 * `isContra(account)` returns a plain boolean, because a predicate named
 * `is…` that returns an object is always truthy, and `if (isContra(a))` would
 * then silently be true for every account — precisely the class of defect this
 * package exists to remove. The provenance-carrying form is `contraOf(account)`.
 *
 * Pure module: no database, no I/O, no requires. Unit-testable in isolation
 * (tests/coaReportClassification.test.js).
 */

// ── Provenance vocabulary ────────────────────────────────────────────────
const SOURCES = {
  STORED: 'stored',               // read from a gl_accounts column — authoritative
  LEGACY_PREFIX: 'legacy_prefix', // inferred from the account CODE — a guess
  TYPE_FALLBACK: 'type_fallback', // inferred from gl_accounts.type — a guess
  NONE: 'none',                   // nothing stored and nothing inferable
};

// ════════════════════════════════════════════════════════════════════════
// THE SECTION CATALOG
// ────────────────────────────────────────────────────────────────────────
// Mirrors `statement_sections` (0028_coa_metadata.sql §12, 29 rows) exactly:
// same ids, same statement, same parent_group, same normal_balance, same
// is_contra, same display_order. Those rows are marked inCatalogTable: true.
//
// gl_accounts.report_section, however, is written by routes/erp.js and
// server.js with a vocabulary that predates the table and is WIDER than it:
// 12 further section ids are live in the data (rou, intangibles, net_vat,
// gosi, withholding, short_term_debt, other_current_liability,
// other_current_asset, long_term_debt, lease_obligation, eosb, zakat) and 5
// live ids are SPELLED DIFFERENTLY from the table's (vat_input/input_vat,
// vat_output/output_vat, prepaid/prepayments, customer_deposits/
// customer_advances, retained/retained_earnings).
//
// Treating that gap as "unmapped" would push a third of the chart onto the
// legacy prefix path on day one — a regression dressed as rigour. So the
// catalog carries the FULL live vocabulary, the table's spelling is canonical
// where the table has a row, the live spelling is registered as an alias, and
// the 12 rows the table lacks are marked inCatalogTable: false so
// `catalogGaps()` can name exactly what statement_sections still owes.
// Those rows classify normally (source='stored') — they are stored data, not
// guesses. `catalogGap: true` on the result says the CATALOG is incomplete,
// which is a different problem from the ACCOUNT being unclassified.
// ════════════════════════════════════════════════════════════════════════
function S(id, statement, group, nameAr, nameEn, normalBalance, isContra, displayOrder, extra) {
  return Object.assign({
    id, statement, group, nameAr, nameEn,
    normalBalance, isContra: !!isContra, displayOrder,
    inCatalogTable: true,
    bsGroup: null,        // [topGroup, subGroup] keys used by balance-sheet.js `groups`
    incomeBucket: null,   // bucket key used by income.js
    cfBucket: null,       // bucket key used by cash-flow.js
  }, extra || {});
}

const SECTION_CATALOG = [
  // ── Balance sheet · assets ────────────────────────────────────────────
  S('cash', 'balance_sheet', 'currentAssets', 'النقدية وما في حكمها', 'Cash and cash equivalents', 'debit', 0, 10,
    { bsGroup: ['currentAssets', 'cash'], cfBucket: 'cash' }),
  S('receivables', 'balance_sheet', 'currentAssets', 'ذمم مدينة', 'Receivables', 'debit', 0, 20,
    { bsGroup: ['currentAssets', 'receivables'], cfBucket: 'receivables' }),
  S('allowance_doubtful', 'balance_sheet', 'currentAssets', 'مخصص الديون المشكوك فيها', 'Allowance for doubtful debts', 'credit', 1, 30,
    { bsGroup: ['currentAssets', 'allowanceDoubtful'], cfBucket: 'receivables' }),
  S('inventory', 'balance_sheet', 'currentAssets', 'المخزون', 'Inventory', 'debit', 0, 40,
    { bsGroup: ['currentAssets', 'inventory'], cfBucket: 'inventory' }),
  S('prepayments', 'balance_sheet', 'currentAssets', 'مصروفات مدفوعة مقدمًا', 'Prepayments', 'debit', 0, 50,
    { bsGroup: ['currentAssets', 'prepaid'], cfBucket: 'otherCurrentAssets' }),
  S('input_vat', 'balance_sheet', 'currentAssets', 'ضريبة المدخلات', 'Input VAT', 'debit', 0, 60,
    { bsGroup: ['currentAssets', 'vatInput'], cfBucket: 'otherCurrentAssets' }),
  S('other_current_asset', 'balance_sheet', 'currentAssets', 'أصول متداولة أخرى', 'Other current assets', 'debit', 0, 65,
    { inCatalogTable: false, bsGroup: ['currentAssets', 'otherCA'], cfBucket: 'otherCurrentAssets' }),
  S('ppe', 'balance_sheet', 'nonCurrentAssets', 'ممتلكات وآلات ومعدات', 'Property, plant and equipment', 'debit', 0, 70,
    { bsGroup: ['nonCurrentAssets', 'ppe'], cfBucket: 'fixedAssets' }),
  S('rou', 'balance_sheet', 'nonCurrentAssets', 'حق استخدام الأصول (IFRS 16)', 'Right-of-use assets', 'debit', 0, 75,
    { inCatalogTable: false, bsGroup: ['nonCurrentAssets', 'rou'], cfBucket: 'fixedAssets' }),
  S('acc_dep', 'balance_sheet', 'nonCurrentAssets', 'مجمع الإهلاك', 'Accumulated depreciation', 'credit', 1, 80,
    { bsGroup: ['nonCurrentAssets', 'accDep'], cfBucket: 'accDep' }),
  S('intangibles', 'balance_sheet', 'nonCurrentAssets', 'الأصول غير الملموسة', 'Intangible assets', 'debit', 0, 90,
    { inCatalogTable: false, bsGroup: ['nonCurrentAssets', 'intangibles'], cfBucket: 'fixedAssets' }),

  // ── Balance sheet · liabilities ───────────────────────────────────────
  S('payables', 'balance_sheet', 'currentLiabilities', 'ذمم دائنة', 'Payables', 'credit', 0, 110,
    { bsGroup: ['currentLiab', 'payables'], cfBucket: 'payables' }),
  S('grni', 'balance_sheet', 'currentLiabilities', 'بضاعة مستلمة لم تُفوتر', 'Goods received not invoiced', 'credit', 0, 120,
    { bsGroup: ['currentLiab', 'accrued'], cfBucket: 'payables' }),
  S('accrued', 'balance_sheet', 'currentLiabilities', 'مصروفات مستحقة', 'Accrued expenses', 'credit', 0, 130,
    { bsGroup: ['currentLiab', 'accrued'], cfBucket: 'otherCurrentLiabilities' }),
  S('output_vat', 'balance_sheet', 'currentLiabilities', 'ضريبة المخرجات', 'Output VAT', 'credit', 0, 140,
    { bsGroup: ['currentLiab', 'vatOutput'], cfBucket: 'otherCurrentLiabilities' }),
  S('net_vat', 'balance_sheet', 'currentLiabilities', 'صافي ضريبة القيمة المضافة', 'Net VAT', 'credit', 0, 145,
    { inCatalogTable: false, bsGroup: ['currentLiab', 'netVat'], cfBucket: 'otherCurrentLiabilities' }),
  S('customer_advances', 'balance_sheet', 'currentLiabilities', 'دفعات مقدمة من عملاء', 'Customer advances', 'credit', 0, 150,
    { bsGroup: ['currentLiab', 'customerDeposits'], cfBucket: 'otherCurrentLiabilities' }),
  S('gosi', 'balance_sheet', 'currentLiabilities', 'التأمينات الاجتماعية (GOSI)', 'GOSI', 'credit', 0, 155,
    { inCatalogTable: false, bsGroup: ['currentLiab', 'gosi'], cfBucket: 'otherCurrentLiabilities' }),
  S('withholding', 'balance_sheet', 'currentLiabilities', 'ضريبة الاستقطاع', 'Withholding tax', 'credit', 0, 160,
    { inCatalogTable: false, bsGroup: ['currentLiab', 'withholding'], cfBucket: 'otherCurrentLiabilities' }),
  S('short_term_debt', 'balance_sheet', 'currentLiabilities', 'قروض وإيجارات قصيرة الأجل', 'Short-term debt', 'credit', 0, 165,
    { inCatalogTable: false, bsGroup: ['currentLiab', 'shortTermDebt'], cfBucket: 'otherCurrentLiabilities' }),
  S('other_current_liability', 'balance_sheet', 'currentLiabilities', 'التزامات متداولة أخرى', 'Other current liabilities', 'credit', 0, 170,
    { inCatalogTable: false, bsGroup: ['currentLiab', 'otherCL'], cfBucket: 'otherCurrentLiabilities' }),
  S('long_term_debt', 'balance_sheet', 'nonCurrentLiabilities', 'قروض طويلة الأجل', 'Long-term debt', 'credit', 0, 180,
    { inCatalogTable: false, bsGroup: ['nonCurrentLiab', 'longTermDebt'], cfBucket: 'financingLiabilities' }),
  S('lease_obligation', 'balance_sheet', 'nonCurrentLiabilities', 'التزام الإيجار طويل الأجل (IFRS 16)', 'Lease obligation', 'credit', 0, 185,
    { inCatalogTable: false, bsGroup: ['nonCurrentLiab', 'leaseObligation'], cfBucket: 'financingLiabilities' }),
  S('eosb', 'balance_sheet', 'nonCurrentLiabilities', 'مخصص مكافأة نهاية الخدمة (IAS 19)', 'End-of-service benefits', 'credit', 0, 190,
    { inCatalogTable: false, bsGroup: ['nonCurrentLiab', 'eosb'], cfBucket: 'otherCurrentLiabilities' }),

  // ── Balance sheet · equity ────────────────────────────────────────────
  S('capital', 'balance_sheet', 'equity', 'رأس المال', 'Capital', 'credit', 0, 210,
    { bsGroup: ['equity', 'capital'], cfBucket: 'equity' }),
  S('retained_earnings', 'balance_sheet', 'equity', 'أرباح مبقاة', 'Retained earnings', 'credit', 0, 220,
    { bsGroup: ['equity', 'retained'], cfBucket: 'equity' }),
  S('drawings', 'balance_sheet', 'equity', 'المسحوبات', 'Drawings', 'debit', 1, 230,
    { bsGroup: ['equity', 'drawings'], cfBucket: 'equity' }),
  S('reserves', 'balance_sheet', 'equity', 'الاحتياطيات', 'Reserves', 'credit', 0, 240,
    { bsGroup: ['equity', 'reserves'], cfBucket: 'equity' }),
  S('zakat', 'balance_sheet', 'equity', 'مخصص الزكاة الشرعية', 'Zakat provision', 'credit', 0, 250,
    { inCatalogTable: false, bsGroup: ['equity', 'zakat'], cfBucket: 'equity' }),

  // ── Income statement ──────────────────────────────────────────────────
  S('sales_revenue', 'income_statement', 'revenue', 'إيرادات المبيعات', 'Sales revenue', 'credit', 0, 310,
    { incomeBucket: 'revenue' }),
  S('sales_returns', 'income_statement', 'revenue', 'مردودات وخصومات المبيعات', 'Sales returns and discounts', 'debit', 1, 320,
    { incomeBucket: 'revenue' }),   // contra-revenue: nets INSIDE revenue, never a separate section
  S('other_income', 'income_statement', 'revenue', 'إيرادات أخرى', 'Other income', 'credit', 0, 330,
    { incomeBucket: 'otherIncome' }),
  S('cogs', 'income_statement', 'cogs', 'تكلفة المبيعات', 'Cost of sales', 'debit', 0, 410,
    { incomeBucket: 'cogs' }),
  S('waste', 'income_statement', 'cogs', 'الهدر', 'Waste', 'debit', 0, 420,
    { incomeBucket: 'cogs' }),
  S('stock_variance', 'income_statement', 'cogs', 'فروقات الجرد', 'Stock variances', 'debit', 0, 430,
    { incomeBucket: 'cogs' }),
  S('payroll', 'income_statement', 'opex', 'الرواتب والأجور', 'Payroll', 'debit', 0, 510,
    { incomeBucket: 'opex' }),
  S('rent_utilities', 'income_statement', 'opex', 'الإيجار والمرافق', 'Rent and utilities', 'debit', 0, 520,
    { incomeBucket: 'opex' }),
  S('marketing', 'income_statement', 'opex', 'التسويق والعمولات', 'Marketing and commissions', 'debit', 0, 530,
    { incomeBucket: 'opex' }),
  S('depreciation', 'income_statement', 'opex', 'الإهلاك', 'Depreciation', 'debit', 0, 540,
    { incomeBucket: 'opex' }),
  S('bank_gov_fees', 'income_statement', 'opex', 'رسوم بنكية وحكومية', 'Bank and government fees', 'debit', 0, 550,
    { incomeBucket: 'opex' }),
  S('franchise_fees', 'income_statement', 'opex', 'رسوم الامتياز', 'Franchise fees', 'debit', 0, 560,
    { incomeBucket: 'opex' }),
];

const SECTIONS = Object.create(null);
SECTION_CATALOG.forEach((s) => { SECTIONS[s.id] = s; });

// Live gl_accounts.report_section spellings → canonical statement_sections id.
// NOT a heuristic: each pair is the same section under two names, one written
// by the seeder and one seeded into the catalog table.
const SECTION_ALIASES = Object.create(null);
Object.assign(SECTION_ALIASES, {
  vat_input: 'input_vat',
  vat_output: 'output_vat',
  prepaid: 'prepayments',
  customer_deposits: 'customer_advances',
  retained: 'retained_earnings',
});

/** Section ids that are live in gl_accounts but missing from statement_sections. */
function catalogGaps() {
  return SECTION_CATALOG.filter((s) => !s.inCatalogTable).map((s) => s.id);
}

/** Resolve a raw report_section string to a catalog entry, or null. */
function resolveSection(raw) {
  if (raw === undefined || raw === null) return null;
  const key = String(raw).trim();
  if (!key) return null;
  const canonical = SECTION_ALIASES[key] || key;
  return SECTIONS[canonical] || null;
}

// ── Field access ────────────────────────────────────────────────────────
// Rows arrive snake_case from mysql2 but several call sites hand-build
// camelCase objects (the CoA tree builder, the equity-changes mirror). A
// classifier that reads only one casing silently returns "unmapped" for the
// other — which is how a lot-genealogy screen once went blank. Read both.
function field(account, ...names) {
  if (!account) return undefined;
  for (const n of names) {
    const v = account[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function truthy(v) {
  return v === 1 || v === true || v === '1' || v === 'true';
}

// ════════════════════════════════════════════════════════════════════════
// 1. NORMAL BALANCE — stored column, type only as a flagged fallback
// ════════════════════════════════════════════════════════════════════════
function normalBalanceOf(account) {
  const stored = field(account, 'normal_balance', 'normalBalance');
  if (stored === 'debit' || stored === 'credit') {
    return { normalBalance: stored, source: SOURCES.STORED, unmapped: false };
  }
  const type = String(field(account, 'type') || '').toLowerCase();
  if (type === 'asset' || type === 'expense') {
    return { normalBalance: 'debit', source: SOURCES.TYPE_FALLBACK, unmapped: true };
  }
  if (type === 'liability' || type === 'equity' || type === 'revenue') {
    return { normalBalance: 'credit', source: SOURCES.TYPE_FALLBACK, unmapped: true };
  }
  return { normalBalance: null, source: SOURCES.NONE, unmapped: true };
}

// ════════════════════════════════════════════════════════════════════════
// 2. CONTRA — the stored column and nothing else. No name matching, ever.
// ════════════════════════════════════════════════════════════════════════
function contraOf(account) {
  const raw = field(account, 'is_contra', 'isContra');
  if (raw === undefined) {
    // The column was not projected (or predates 0028). Absent ≠ false: say so.
    return { isContra: false, source: SOURCES.NONE, unmapped: true };
  }
  return { isContra: truthy(raw), source: SOURCES.STORED, unmapped: false };
}

/** Boolean predicate — see the header note on why this one is not an object. */
function isContra(account) {
  return contraOf(account).isContra;
}

/**
 * Contra as the STATEMENTS must read it: the account's own is_contra column
 * OR the is_contra flag of the section it declares.
 *
 * Why the OR is not a heuristic. `is_contra` is `NOT NULL DEFAULT 0`, and 0028
 * seeded it to 1 exactly WHERE report_section IN ('allowance_doubtful',
 * 'acc_dep','drawings') — for the rows that existed on migration day. Every
 * account created AFTER that, by any code path that does not set the column,
 * arrives with is_contra = 0 while declaring report_section='drawings'. A
 * column-only read would quietly un-contra it: defect #3 returning through a
 * data gap instead of through a name regex. Both inputs are stored data and
 * both are declarations, so the section is honoured too — and when they
 * disagree, `disagreesWithSection` says so rather than picking a winner in
 * silence.
 */
function effectiveContraOf(account) {
  const own = contraOf(account);
  const sec = sectionOf(account);
  const sectionSaysContra = sec.source === SOURCES.STORED && sec.sectionIsContra === true;
  return {
    isContra: own.isContra || sectionSaysContra,
    fromColumn: own.isContra,
    fromSection: sectionSaysContra,
    disagreesWithSection: !own.unmapped && own.isContra !== sectionSaysContra,
    source: (!own.unmapped || sectionSaysContra) ? SOURCES.STORED : SOURCES.NONE,
    unmapped: own.unmapped && !sectionSaysContra,
  };
}

/**
 * The side an account's balance is EXPECTED to sit on. A contra account's
 * expected side is the opposite of its class's normal balance: accumulated
 * depreciation is an asset with a natural CREDIT balance, and that is not an
 * anomaly. This is the whole of defect #3.
 */
function expectedSideOf(account) {
  const nb = normalBalanceOf(account);
  const contra = effectiveContraOf(account);
  let side = nb.normalBalance;
  if (side && contra.isContra) side = side === 'debit' ? 'credit' : 'debit';
  return {
    expectedSide: side,
    isContra: contra.isContra,
    contraSource: contra.source,
    source: contra.isContra && contra.source === SOURCES.STORED ? SOURCES.STORED : nb.source,
    unmapped: nb.unmapped || contra.unmapped,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 3. SECTION — stored report_section, validated against the catalog
// ════════════════════════════════════════════════════════════════════════
function _sectionResult(entry, source, unmapped) {
  return {
    section: entry ? entry.id : null,
    group: entry ? entry.group : null,
    statement: entry ? entry.statement : null,
    bsGroup: entry && entry.bsGroup ? entry.bsGroup.slice() : null,
    incomeBucket: entry ? entry.incomeBucket : null,
    cfBucket: entry ? entry.cfBucket : null,
    sectionIsContra: entry ? entry.isContra : null,
    sectionNormalBalance: entry ? entry.normalBalance : null,
    catalogGap: entry ? !entry.inCatalogTable : false,
    source,
    unmapped,
  };
}

function sectionOf(account) {
  const raw = field(account, 'report_section', 'reportSection');
  const entry = resolveSection(raw);
  if (entry) return _sectionResult(entry, SOURCES.STORED, false);

  // A report_section that is set but is NOT in the catalog is worse than a
  // NULL — it looks classified and is not. Surface it as unmapped and keep
  // the offending value so the diagnostic can name it.
  const invalid = raw !== undefined && raw !== null && String(raw).trim() !== '';

  const legacy = legacySectionByCode(account);
  if (legacy.section) {
    const res = _sectionResult(SECTIONS[legacy.section], SOURCES.LEGACY_PREFIX, true);
    if (invalid) res.invalidStoredSection = String(raw);
    return res;
  }
  const res = _sectionResult(null, invalid ? SOURCES.STORED : SOURCES.NONE, true);
  if (invalid) res.invalidStoredSection = String(raw);
  return res;
}

// ════════════════════════════════════════════════════════════════════════
// 4. CASH-FLOW ACTIVITY — stored column; NULL stays NULL
// ────────────────────────────────────────────────────────────────────────
// 0028 leaves cash_flow_activity NULL on 91 posting accounts ON PURPOSE:
// nobody has decided yet. Returning 'other' (what cash-flow.js used to do for
// every unmatched prefix) turns "undecided" into a number on a statement.
// NULL comes back as NULL with unmapped: true.
// ════════════════════════════════════════════════════════════════════════
const CASH_FLOW_ACTIVITIES = new Set(['operating', 'investing', 'financing', 'non_cash']);

function cashFlowActivityOf(account) {
  const stored = field(account, 'cash_flow_activity', 'cashFlowActivity');
  if (stored && CASH_FLOW_ACTIVITIES.has(String(stored))) {
    return { activity: String(stored), source: SOURCES.STORED, unmapped: false };
  }
  return { activity: null, source: SOURCES.NONE, unmapped: true };
}

// ════════════════════════════════════════════════════════════════════════
// 5. LIFECYCLE — archived accounts still belong in historical reports
// ────────────────────────────────────────────────────────────────────────
// An account closed last year still posted entries the year before. Filtering
// on is_active=1 erases those entries from every historical statement and the
// statement still balances, so nothing complains. `status='archived'` with
// movement inside the requested period MUST appear.
// ════════════════════════════════════════════════════════════════════════
function statusOf(account) {
  const stored = field(account, 'status');
  if (stored === 'active' || stored === 'blocked' || stored === 'archived') {
    return { status: stored, source: SOURCES.STORED, unmapped: false };
  }
  const active = field(account, 'is_active', 'isActive');
  if (active === undefined) return { status: 'active', source: SOURCES.NONE, unmapped: true };
  return {
    status: truthy(active) ? 'active' : 'archived',
    source: SOURCES.TYPE_FALLBACK,
    unmapped: true,
  };
}

/** Should this account appear in a report covering a period it moved in? */
function isReportable(account, hasMovement) {
  const st = statusOf(account).status;
  if (st === 'archived') return !!hasMovement;   // history is never erased
  return true;                                    // active + blocked always show
}

// SQL predicate matching isReportable()'s first half. Kept here so every
// report's WHERE clause and every report's JS filter come from one place.
const REPORTABLE_ACCOUNT_SQL = (alias) =>
  `(${alias}.is_active = 1 OR COALESCE(${alias}.status, 'active') = 'archived')`;

// ════════════════════════════════════════════════════════════════════════
// QUARANTINE — everything below infers from the CODE.
// ────────────────────────────────────────────────────────────────────────
// These functions exist only so an un-migrated chart still renders. They are
// consulted ONLY when the stored value is absent, and every result they feed
// is stamped source='legacy_prefix' + unmapped=true, so it lands in the
// report's `unmapped` array and gets a decision instead of passing silently
// for stored data. Do not call them directly from a report's happy path.
// ════════════════════════════════════════════════════════════════════════
function _legacyAssetSection(c) {
  // Saudi/International 6-digit GGMMPP, GG=10 → assets.
  if (/^\d{6}$/.test(c) && c.startsWith('10')) {
    const mm = c.substr(2, 2);
    if (mm === '01') return 'cash';
    if (mm === '02') return 'receivables';
    if (mm === '03') return 'inventory';
    if (mm === '04') return 'prepayments';
    if (mm === '05') return 'ppe';
    if (mm === '06') return 'acc_dep';
    return 'other_current_asset';
  }
  // Legacy 3/4-digit chart.
  if (c.startsWith('111')) return 'cash';
  if (c.startsWith('1124')) return 'allowance_doubtful';
  if (c.startsWith('112')) return 'receivables';
  if (c.startsWith('113')) return 'inventory';
  if (c.startsWith('114')) return 'prepayments';
  if (c.startsWith('115')) return 'receivables';     // العهد والسلف — custody is AR-natured
  if (c.startsWith('116')) return 'input_vat';
  if (c.startsWith('122')) return 'acc_dep';
  if (c.startsWith('124')) return 'rou';
  if (c.startsWith('121')) return 'ppe';
  if (c.startsWith('123')) return 'intangibles';
  if (c.startsWith('125') || c.startsWith('126')) return 'intangibles';
  if (c.startsWith('11')) return 'other_current_asset';
  if (c.startsWith('12')) return 'ppe';
  return null;
}

function _legacyLiabilitySection(c) {
  if (/^\d{6}$/.test(c) && c.startsWith('20')) {
    const mm = c.substr(2, 2);
    if (mm === '01') return 'payables';
    if (mm === '02') return 'accrued';
    if (mm === '03') return 'output_vat';
    if (mm === '04') return 'long_term_debt';
    if (mm === '05') return 'eosb';
    if (mm === '06') return 'customer_advances';
    return 'other_current_liability';
  }
  if (c.startsWith('211')) return 'payables';
  if (c.startsWith('212')) return 'accrued';
  if (c.startsWith('2132')) return 'net_vat';
  if (c.startsWith('2131')) return 'output_vat';
  if (c.startsWith('213')) return 'output_vat';
  if (c.startsWith('214')) return 'customer_advances';
  if (c.startsWith('215')) return 'other_current_liability';
  if (c.startsWith('216')) return 'gosi';
  if (c.startsWith('217')) return 'withholding';
  if (c.startsWith('218') || c.startsWith('219')) return 'short_term_debt';
  if (c.startsWith('223')) return 'eosb';
  if (c.startsWith('222')) return 'lease_obligation';
  if (c.startsWith('221')) return 'long_term_debt';
  if (c.startsWith('22')) return 'long_term_debt';
  if (c.startsWith('21')) return 'other_current_liability';
  return null;
}

function _legacyEquitySection(c) {
  if (/^\d{6}$/.test(c) && c.startsWith('30')) {
    const mm = c.substr(2, 2);
    if (mm === '01') return 'capital';
    if (mm === '02') return 'retained_earnings';
    if (mm === '03') return 'retained_earnings';  // period P&L folds into retained (IAS 1)
    if (mm === '04') return 'reserves';
    if (mm === '05') return 'drawings';
    return 'capital';
  }
  if (c.startsWith('31')) return 'capital';
  if (c.startsWith('32')) return 'retained_earnings';
  if (c.startsWith('33')) return 'drawings';
  if (c.startsWith('343')) return 'zakat';
  if (c.startsWith('34')) return 'reserves';
  return 'capital';   // equity always lands somewhere — totEq must not lose a row
}

/** Legacy code-prefix → section id. Always source='legacy_prefix'. */
function legacySectionByCode(account) {
  const c = String(field(account, 'code') || '');
  const type = String(field(account, 'type') || '').toLowerCase();
  let section = null;
  if (type === 'asset') section = _legacyAssetSection(c);
  else if (type === 'liability') section = _legacyLiabilitySection(c);
  else if (type === 'equity') section = _legacyEquitySection(c);
  else if (type === 'revenue') section = c.startsWith('42') ? 'other_income' : 'sales_revenue';
  else if (type === 'expense') section = c.startsWith('51') ? 'cogs' : null;
  // 52x OpEx / 53x G&A / 6x other-expense have no section in the vocabulary —
  // legacyIncomeBucketByCode() answers those, and says it guessed.
  return { section, source: SOURCES.LEGACY_PREFIX, unmapped: true };
}

/** Legacy code-prefix → income.js bucket. Always source='legacy_prefix'. */
function legacyIncomeBucketByCode(account) {
  const c = String(field(account, 'code') || '');
  const type = String(field(account, 'type') || '').toLowerCase();
  let bucket = null;
  if (type === 'revenue') bucket = c.startsWith('42') ? 'otherIncome' : 'revenue';
  else if (type === 'expense') {
    if (c.startsWith('51')) bucket = 'cogs';
    else if (c.startsWith('52')) bucket = 'opex';
    else if (c.startsWith('53')) bucket = 'gAndA';
    else if (c.startsWith('6')) bucket = 'otherExpense';
    else bucket = 'opex';                      // unknown → safest bucket, still flagged
  }
  return { bucket, source: SOURCES.LEGACY_PREFIX, unmapped: true };
}

/**
 * Legacy code-prefix → cash-flow bucket. Always source='legacy_prefix'.
 *
 * THE 112 CONTRADICTION LIVED HERE. cash-flow.js's own category() read `112`
 * as INVENTORY while balance-sheet.js read it as RECEIVABLES. There is no
 * third opinion to have: this table is derived from _legacyAssetSection()
 * above via the catalog's cfBucket, so both statements now guess identically
 * when they are forced to guess at all.
 */
function legacyCashFlowBucketByCode(account) {
  const legacy = legacySectionByCode(account);
  const entry = legacy.section ? SECTIONS[legacy.section] : null;
  return {
    bucket: entry ? entry.cfBucket : null,
    section: legacy.section,
    source: SOURCES.LEGACY_PREFIX,
    unmapped: true,
  };
}

// ════════════════════════════════════════════════════════════════════════
// PER-REPORT RESOLVERS — stored first, legacy only as a flagged fallback
// ════════════════════════════════════════════════════════════════════════

/** balance-sheet.js: → { group: [topGroup, subGroup], … } */
function balanceSheetGroupOf(account) {
  const sec = sectionOf(account);
  if (sec.bsGroup) {
    return {
      group: sec.bsGroup, section: sec.section, catalogGap: sec.catalogGap,
      source: sec.source, unmapped: sec.unmapped,
    };
  }
  return { group: null, section: sec.section, catalogGap: false, source: sec.source, unmapped: true };
}

/** income.js: → { bucket: revenue|otherIncome|cogs|opex|gAndA|otherExpense } */
function incomeBucketOf(account) {
  const sec = sectionOf(account);
  if (sec.source === SOURCES.STORED && sec.incomeBucket) {
    return { bucket: sec.incomeBucket, section: sec.section, catalogGap: sec.catalogGap, source: SOURCES.STORED, unmapped: false };
  }
  const legacy = legacyIncomeBucketByCode(account);
  return {
    bucket: legacy.bucket,
    section: sec.section,
    catalogGap: false,
    source: legacy.bucket ? SOURCES.LEGACY_PREFIX : SOURCES.NONE,
    unmapped: true,
  };
}

// Which IAS 7 activity a bucket rolls into when the account itself does not
// say. Used ONLY to place a line once the bucket is known; it never invents an
// activity for an account that has neither a stored activity nor a section.
const BUCKET_DEFAULT_ACTIVITY = {
  cash: null,                       // cash is the reconciliation target, not a line
  receivables: 'operating',
  inventory: 'operating',
  otherCurrentAssets: 'operating',
  payables: 'operating',
  otherCurrentLiabilities: 'operating',
  accDep: 'operating',              // depreciation is a non-cash add-back inside operating
  fixedAssets: 'investing',
  financingLiabilities: 'financing',
  equity: 'financing',
};

/**
 * cash-flow.js: cash_flow_activity → report_section → legacy prefix.
 * Returns { bucket, activity, section, source, unmapped }.
 * A stored activity WINS over the bucket's default — that is the point of
 * the column.
 */
function cashFlowBucketOf(account) {
  const act = cashFlowActivityOf(account);
  const sec = sectionOf(account);

  let bucket = null;
  let source = SOURCES.NONE;
  let unmapped = true;

  if (sec.source === SOURCES.STORED && sec.cfBucket) {
    bucket = sec.cfBucket;
    source = SOURCES.STORED;
    unmapped = false;
  } else {
    const legacy = legacyCashFlowBucketByCode(account);
    if (legacy.bucket) {
      bucket = legacy.bucket;
      source = SOURCES.LEGACY_PREFIX;
      unmapped = true;
    }
  }

  let activity = act.activity;
  let activitySource = act.source;
  if (!activity) {
    activity = bucket ? (BUCKET_DEFAULT_ACTIVITY[bucket] || null) : null;
    activitySource = bucket ? source : SOURCES.NONE;
  } else {
    // A stored activity is authoritative even when the section is missing.
    if (source === SOURCES.NONE) { source = SOURCES.STORED; unmapped = false; }
  }

  return {
    bucket,
    activity,
    activitySource,
    activityStored: !act.unmapped,
    section: sec.section,
    catalogGap: sec.catalogGap,
    source,
    unmapped,
  };
}

/**
 * Build one row of a report's `unmapped` payload array. Uniform shape across
 * all four statements so a single UI banner can render any of them.
 */
function unmappedRow(account, result, extra) {
  return Object.assign({
    id: field(account, 'id') || null,
    code: field(account, 'code') || null,
    nameAr: field(account, 'name_ar', 'nameAr') || null,
    type: field(account, 'type') || null,
    reportSection: field(account, 'report_section', 'reportSection') || null,
    source: result ? result.source : SOURCES.NONE,
    reason: result && result.source === SOURCES.LEGACY_PREFIX
      ? 'classified from the account CODE, not from stored metadata'
      : 'no stored classification for this account',
  }, extra || {});
}

module.exports = {
  SOURCES,
  SECTION_CATALOG,
  SECTIONS,
  SECTION_ALIASES,
  CASH_FLOW_ACTIVITIES,
  BUCKET_DEFAULT_ACTIVITY,
  catalogGaps,
  resolveSection,
  normalBalanceOf,
  isContra,
  contraOf,
  effectiveContraOf,
  expectedSideOf,
  sectionOf,
  cashFlowActivityOf,
  statusOf,
  isReportable,
  REPORTABLE_ACCOUNT_SQL,
  balanceSheetGroupOf,
  incomeBucketOf,
  cashFlowBucketOf,
  legacySectionByCode,
  legacyIncomeBucketByCode,
  legacyCashFlowBucketByCode,
  unmappedRow,
};
