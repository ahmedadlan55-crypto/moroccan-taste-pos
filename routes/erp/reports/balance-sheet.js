// ═══════════════════════════════════════════════════════════════════
// /api/erp/reports/balance-sheet-ifrs — قائمة المركز المالي (IAS 1)
//
// Returns an IFRS-style balance sheet built from posted gl_entries
// summed up to ?asOfDate=. Optional ?brandId= / ?branchId= filters
// degrade gracefully when those dimension columns are missing.
//
// Output shape (backward-compatible with v5.10.4 UI):
//   • currentAssets / nonCurrentAssets   + their flat balances
//   • currentLiab / nonCurrentLiab       + their flat balances
//   • equityItems                        + total equity (drawings is
//                                          contra-equity and subtracts)
//   • netIncome                          (also injected as a synthetic
//                                          line inside groups.equity.retained
//                                          per IFRS Statement of Changes
//                                          in Equity)
//   • groups                             nested IFRS hierarchy used by
//                                          the new tree view
//   • unclassified                       accounts no rule matched
//   • isBalanced                         |Assets − (Liab + Eq)| < 0.01
//
// Endpoint name uses the explicit -ifrs suffix because routes/erp-core.js
// has a legacy /reports/balance-sheet that mounts first and was shadowing
// us before v5.10.4.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const coaTree = require('../../../lib/coa/tree');
const classify = require('../../../lib/coa/classify');
const glBoundaries = require('../../../lib/reports/glBoundaries');
const { todayYmd } = require('../../../lib/expiryPolicy');

// PACKAGE G — this report no longer decides where an account belongs. It ASKS
// lib/coa/classify.js, which reads the stored gl_accounts metadata added by
// db/migrations/0028_coa_metadata.sql. The Arabic-name regex that used to run
// FIRST — it had to match 'مجمَّع الإهلاك' and 'مجمع الإهلاك' as two separate
// alternatives — is DELETED: renaming an account must never move it on the
// balance sheet. Code-prefix inference still exists for un-migrated
// rows but only inside classify.js's quarantined legacy* functions, and every
// account that reaches it comes back in the response's `unmapped` array.

// v5.10.79 — Canonical IFRS-conventional ordering inside each Balance
// Sheet section. The most-liquid item appears first (cash before
// inventory), the most-tenured item appears first under Non-current
// (PP&E before intangibles), and contra-accounts appear right after
// the gross item they net against (allowance after receivables,
// accumulated depreciation after PP&E). This is the order Big-4 audit
// reports use and what SOCPA-trained accountants expect.
const IFRS_SUBGROUP_ORDER = {
  // v5.10.81 — Added 'rou' (IFRS 16 Right-of-Use assets) between PPE and
  // its contra. Conventional placement: tangible assets → RoU → contra
  // depreciation → intangibles. Matches Big-4 BS layout.
  currentAssets:    ['cash', 'receivables', 'allowanceDoubtful', 'inventory', 'vatInput', 'prepaid', 'otherCA'],
  nonCurrentAssets: ['ppe', 'rou', 'accDep', 'intangibles'],
  currentLiab:      ['payables', 'accrued', 'vatOutput', 'netVat', 'gosi', 'withholding', 'zakat', 'customerDeposits', 'shortTermDebt', 'otherCL'],
  nonCurrentLiab:   ['longTermDebt', 'leaseObligation', 'eosb'],
  equity:           ['capital', 'retained', 'drawings', 'reserves']
};

// Helper — returns groups as an ORDERED ARRAY of {key, label, total,
// accounts, isContra} so the frontend can render them in IFRS sequence
// without depending on JavaScript object insertion order (which the
// V8 engine guarantees but is brittle).
function orderSection(sectionKey, sectionObj) {
  const order = IFRS_SUBGROUP_ORDER[sectionKey] || [];
  const seen = {};
  const ordered = [];
  // First: emit keys IN the canonical order
  order.forEach(key => {
    if (sectionObj[key]) {
      ordered.push(Object.assign({ key }, sectionObj[key]));
      seen[key] = true;
    }
  });
  // Second: any keys NOT in the canonical list, in their original
  // order (defensive — surfaces new buckets without a code change).
  Object.keys(sectionObj).forEach(key => {
    if (!seen[key]) ordered.push(Object.assign({ key }, sectionObj[key]));
  });
  return ordered;
}

// v5.10.79 — Compute Balance Sheet snapshot totals for a given date.
// Returns ONLY the section/group totals (no per-account breakdown) —
// used for the period-over-period comparison column. Kept lightweight
// so providing a `compareDate` doesn't double the heavy main query.
async function _bsSnapshotTotals(asOfDate, brandId, branchId, hasBrandId, hasBranchId) {
  // Same 0036 discipline as the main pass, or the comparison column would be
  // computed on a different basis than the column it is compared against —
  // which is worse than having no comparison at all. The join moves from
  // `e.account_id = a.id` to the REMAPPED account, so a historical line lands
  // on its canonical account here exactly as it does above.
  const books = glBoundaries.inTheBooksSql('j');
  let where = books.sql;
  const params = [...books.params];
  if (asOfDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(asOfDate); }
  if (brandId  && hasBrandId)  { where += ' AND (e.brand_id IS NULL OR e.brand_id = ?)';   params.push(brandId); }
  if (branchId && hasBranchId) { where += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; params.push(branchId); }
  const canonAcc = await glBoundaries.canonicalForAccounts(db, 'a', 'e', 'coa_map');
  const [rows] = await db.query(
    `SELECT a.id, a.code, a.type, a.report_section, a.normal_balance, a.is_contra, a.status,
            COALESCE(SUM(CASE WHEN ${where} THEN e.debit  ELSE 0 END), 0) AS d,
            COALESCE(SUM(CASE WHEN ${where} THEN e.credit ELSE 0 END), 0) AS c
       FROM gl_accounts a
       ${canonAcc.join}
       LEFT JOIN gl_entries e   ON ${canonAcc.entryMatch}
       LEFT JOIN gl_journals j  ON j.id = e.journal_id
      WHERE COALESCE(a.is_folder, 0) = 0 AND ${classify.REPORTABLE_ACCOUNT_SQL('a')}
      GROUP BY a.id`,
    [...params, ...params]
  );
  // Bucket totals using the same classifier the main pass uses. The contra
  // flip is read from gl_accounts.is_contra (or the section's own is_contra),
  // NOT from a regex over report_section — the old
  // `.match(/(acc_dep|allowance_doubtful)/)` also matched any future section
  // whose name merely CONTAINED those substrings.
  const sectionTotals = {};
  // Per-ACCOUNT prior balances, keyed by account id.
  //
  // The comment this replaced said the per-account drilldown was "NOT
  // duplicated — that would double the heavy query for marginal UI value". The
  // heavy query is the main pass; THIS one already reads every account and
  // every entry, so the per-account figures were being computed and then thrown
  // away. Keeping them costs one map and is what a comparison COLUMN needs:
  // without it the client can only compare grand totals, and the spec's
  // per-account comparison is unbuildable.
  const accountBalances = {};
  let totalAssets = 0, totalLiab = 0, totalEq = 0;
  let netIncomeRevenue = 0, netIncomeExpense = 0;
  rows.forEach(r => {
    const net = (Number(r.d) || 0) - (Number(r.c) || 0);
    if (Math.abs(net) < 0.001) return;   // archived-with-no-movement drops out here
    const contra = _isContraAccount(r);
    if (r.type === 'asset') {
      // `-mag`, mirroring pushToGroup's `-magnitude` in the main pass.
      const mag = net;
      totalAssets += (contra ? -mag : mag);
    } else if (r.type === 'liability') {
      totalLiab += -net;
    } else if (r.type === 'equity') {
      // ── THE SIGN DEFECT THIS BRANCH CARRIED ──────────────────────────────
      // This read `contra ? -Math.abs(mag) : mag`, and the `Math.abs` was the
      // whole bug: it forces a contra-equity account NEGATIVE no matter which
      // way its balance actually runs. The main pass (pushToGroup:701) applies
      // `isContra ? -magnitude : magnitude` with no abs, and so does the asset
      // branch three lines above. Two of the three agreed; this one did not.
      //
      // The two are identical whenever `mag` is positive, and diverge when it
      // is negative. Since `mag = -net`, that means a POSITIVE net — drawings
      // sitting in DEBIT, which is the perfectly ORDINARY case:
      //
      //     d=800 c=0  →  net = +800  →  mag = -800
      //         correct  `contra ? -mag : mag`            →  +800
      //         defect   `contra ? -Math.abs(mag) : mag`  →  −800
      //
      // So the comparison column reported the opposite sign from the column
      // beside it on a normal drawings balance, and the delta between them was
      // wrong by twice the balance.
      //
      // Documented in-place as "a pre-existing defect… deliberately NOT touched
      // here: it is a money change and belongs to its own reviewed fix." This
      // is that fix: one sign rule, applied by all three sites.
      const mag = -net;
      totalEq += (contra ? -mag : mag);
    } else if (r.type === 'revenue') {
      netIncomeRevenue += (Number(r.c) || 0) - (Number(r.d) || 0);
    } else if (r.type === 'expense') {
      netIncomeExpense += (Number(r.d) || 0) - (Number(r.c) || 0);
    }
    if (r.report_section) {
      sectionTotals[r.report_section] = (sectionTotals[r.report_section] || 0) + (r.type === 'asset' ? net : -net);
    }
    // The RAW net for this account — debit minus credit, unsigned by any
    // presentation rule.
    //
    // Deliberately NOT signed here. This snapshot decides contra from the
    // ACCOUNT's own `is_contra`; the main pass decides it from the GROUP the
    // account classifies into (`pushToGroup` reads `group.isContra`). Those two
    // sources disagree — accumulated depreciation showed −2,000 in the current
    // column and +2,000 in the prior one, which is exactly the "two columns on
    // two bases" failure a comparison must never have.
    //
    // So the prior is signed later, by the SAME transformation that produced
    // the row's current balance (`__mul`, recorded per row in the main pass).
    // Agreement is then structural, not a coincidence maintained by hand.
    accountBalances[r.id] = net;
  });
  const netIncome = netIncomeRevenue - netIncomeExpense;
  totalEq += netIncome;  // Period income goes to retained earnings until close
  return {
    asOfDate, totalAssets, totalLiabilities: totalLiab, totEq: totalEq,
    netIncome, sectionTotals, accountBalances,
    isBalanced: Math.abs(totalAssets - (totalLiab + totalEq)) < 0.01
  };
}

// Helper — computes change object {abs, pct} between two values.
function _bsDelta(current, prior) {
  const abs = (Number(current) || 0) - (Number(prior) || 0);
  const pct = Math.abs(prior) > 0.001 ? (abs / Math.abs(prior)) * 100 : null;
  return { abs, pct };
}

// ════════════════════════════════════════════════════════════════════
// v5.10.82 — CoA-driven hierarchical Balance Sheet builder.
// Produces a recursive tree mirroring the actual Chart of Accounts
// structure. Each folder rolls up the balances of all its descendants;
// leaves carry their own posted-journal balance. Contra accounts (per
// either the `report_section` column or a name match) are flagged so
// the frontend can render them in red and the parent's signed sum
// correctly reflects the IFRS net presentation.
// ════════════════════════════════════════════════════════════════════
// PACKAGE G — contra is DECLARED, never detected. The bilingual name regex
// that used to live here (it needed 'مجمَّع الإهلاك' and 'مجمع الإهلاك' as two
// separate alternatives, plus an English pass, plus a '1006' code prefix) is
// gone. The rule is now: the account's own is_contra column OR the is_contra
// flag of the section it declares (is_contra is NOT NULL DEFAULT 0, so a
// drawings account created after 0028 carries 0 while its section says
// otherwise). Both inputs are stored data. Nothing here reads a name.
function _isContraAccount(a) {
  return classify.effectiveContraOf(a).isContra;
}

// Sort by code, numerically-aware (so 1130 < 11201, etc.)
function _codeCompare(a, b) {
  return String(a.code || '').localeCompare(String(b.code || ''), 'en', { numeric: true });
}

// ════════════════════════════════════════════════════════════════════
// Shared helpers (exported) — the Statement of Changes in Equity
// (routes/erp/reports/equity-changes.js) must reconcile EXACTLY with
// this report's totEq, so the pieces that define "which accounts count
// and under what bucket" live here, once. These are behavior-identical
// extractions from the route handler below — no logic change.
// ════════════════════════════════════════════════════════════════════

// The LEAF account predicate: reportable, not a folder, and not the parent
// of any other account. This is the exact filter the balance sheet uses
// to decide which gl_accounts rows carry balances.
//
// PACKAGE G — `a.is_active = 1` became REPORTABLE_ACCOUNT_SQL. An account
// closed this year still posted entries last year; filtering it out erased
// those entries from every historical statement AND the statement still
// balanced, so nothing ever complained. status='archived' rows are now
// selected, and the zero-movement filter in the JS pass below is what keeps
// them out of a report they did not move in.
const LEAF_ACCOUNT_WHERE =
  classify.REPORTABLE_ACCOUNT_SQL('a') + " " +
  "AND COALESCE(a.is_folder, 0) = 0 " +
  "AND a.id NOT IN (SELECT DISTINCT parent_id FROM gl_accounts WHERE parent_id IS NOT NULL)";

// Bucket keys whose group is created with makeGroup(label, /*isContra*/ true)
// inside the route handler. pushToGroup() SUBTRACTS the magnitude for these
// (signed = -magnitude). KEEP IN SYNC with the makeGroup(...) calls below —
// equity-changes mirrors this flip to reconcile with totEq.
const CONTRA_GROUP_KEYS = new Set(['allowanceDoubtful', 'accDep', 'drawings']);

// PACKAGE G — report_section → [topGroup, subGroup] now comes from the shared
// section catalog in lib/coa/classify.js, which mirrors the `statement_sections`
// table (0028 §12) and registers the live gl_accounts spellings that predate it
// (vat_input↔input_vat, prepaid↔prepayments, vat_output↔output_vat,
// customer_deposits↔customer_advances, retained↔retained_earnings) as aliases.
// Same inputs, same outputs, ONE vocabulary — instead of five private maps
// that disagree.
//
// Kept exported: routes/erp/reports/equity-changes.js imports this to
// reconcile exactly with totEq, and must never re-implement it.
function classifyByReportSection(reportSection) {
  const entry = classify.resolveSection(reportSection);
  return entry && entry.bsGroup ? entry.bsGroup.slice() : null;
}

// Legacy code-prefix equity classifier. Quarantined in classify.js; this stays
// as a named export because equity-changes.js calls it directly for the
// presentation bucket of a mis-sectioned equity account. Equity always lands
// somewhere (default 'capital') — totEq must never silently lose a row.
function classifyEquity(code) {
  const legacy = classify.legacySectionByCode({ code, type: 'equity' });
  const entry = legacy.section ? classify.SECTIONS[legacy.section] : null;
  return entry && entry.bsGroup ? entry.bsGroup.slice() : ['equity', 'capital'];
}

// Build the CoA tree with rolled-up balances. Returns the root nodes
// keyed by their account type (asset / liability / equity). Includes
// folders + leaves; the frontend collapses zero-balance subtrees when
// includeZero=false.
//
// v5.10.83 — STRICT TYPE FILTER: only assets/liabilities/equity nodes
// appear in the BS tree. If a revenue/expense account has been parented
// under a BS folder (legacy data corruption, manual mis-coding, etc.),
// it is now EXCLUDED instead of polluting the report. The exclusions
// are collected and surfaced back to the caller as `mistypedAccounts`
// so the UI can show a banner pointing the owner at the offenders.
const BS_TYPES = new Set(['asset', 'liability', 'equity']);
// v5.10.99 — Classification helper. Given the report_section of a top-
// level CoA account, decides whether it belongs to the current bucket
// or the non-current bucket. Falls back to GGMMPP MM digits if
// report_section is NULL (legacy install).
const CURRENT_ASSET_SECTIONS = new Set([
  'cash', 'receivables', 'allowance_doubtful', 'inventory',
  'vat_input', 'prepaid', 'other_current_asset'
]);
const NON_CURRENT_ASSET_SECTIONS = new Set([
  'ppe', 'rou', 'acc_dep', 'intangibles'
]);
const CURRENT_LIAB_SECTIONS = new Set([
  'payables', 'accrued', 'vat_output', 'net_vat', 'gosi', 'withholding',
  'customer_deposits', 'short_term_debt', 'other_current_liability'
]);
const NON_CURRENT_LIAB_SECTIONS = new Set([
  'long_term_debt', 'lease_obligation', 'eosb'
]);

function _classifyTopLevelChild(node, type) {
  const rs = node.reportSection || node.report_section || '';
  if (type === 'asset') {
    if (CURRENT_ASSET_SECTIONS.has(rs))     return 'current';
    if (NON_CURRENT_ASSET_SECTIONS.has(rs)) return 'non-current';
  } else if (type === 'liability') {
    if (CURRENT_LIAB_SECTIONS.has(rs))      return 'current';
    if (NON_CURRENT_LIAB_SECTIONS.has(rs))  return 'non-current';
  }
  // Fallback: GGMMPP MM digits → 01-04 current, 05-06 non-current (assets)
  // or 01-03 current, 04+ non-current (liabilities)
  const code = String(node.code || '');
  if (/^\d{6}$/.test(code)) {
    const mm = code.substr(2, 2);
    if (type === 'asset') {
      if (['01','02','03','04'].includes(mm)) return 'current';
      if (['05','06'].includes(mm))            return 'non-current';
    } else if (type === 'liability') {
      if (['01','02','03','06'].includes(mm)) return 'current';
      if (['04','05'].includes(mm))            return 'non-current';
    }
  }
  return 'current'; // safe default
}

// Build a virtual node wrapping a list of real CoA folders. Used to
// insert "الأصول المتداولة" / "غير المتداولة" presentation layer.
function _virtualSectionNode(label, children, parentLevel) {
  let rawBal = 0, displayBal = 0, postedCount = 0;
  children.forEach(c => {
    rawBal     += Number(c.rawBalance || 0);
    displayBal += Number(c.balance    || 0);
    postedCount += Number(c.postedCount || 0);
  });
  return {
    id: '__virtual_' + label.replace(/\s+/g, '_') + '__',
    code: '',                  // empty → frontend hides the code chip
    nameAr: label,
    nameEn: '',
    type: children[0] && children[0].type || '',
    level: (parentLevel || 1) + 1,
    accountClass: 'main',
    reportSection: null,
    isFolder: true,
    isVirtual: true,           // marker for the frontend
    isContra: false,
    rawBalance: rawBal,
    balance: displayBal,
    postedCount,
    children
  };
}

function _ifrsInterpose(rootNode, type) {
  if (!rootNode || !rootNode.children || !rootNode.children.length) return rootNode;
  const current = [], nonCurrent = [];
  for (const child of rootNode.children) {
    const cls = _classifyTopLevelChild(child, type);
    (cls === 'non-current' ? nonCurrent : current).push(child);
  }
  const labels = type === 'asset'
    ? { current: 'الأصول المتداولة', nonCurrent: 'الأصول غير المتداولة' }
    : { current: 'الالتزامات المتداولة', nonCurrent: 'الالتزامات غير المتداولة' };
  const newChildren = [];
  if (current.length) {
    // Each interposed child needs its depth shifted by +1 too so the
    // existing indent-by-level CSS still produces a clean cascade.
    current.forEach(c => { c.level = (c.level || 2) + 1; });
    newChildren.push(_virtualSectionNode(labels.current, current, rootNode.level));
  }
  if (nonCurrent.length) {
    nonCurrent.forEach(c => { c.level = (c.level || 2) + 1; });
    newChildren.push(_virtualSectionNode(labels.nonCurrent, nonCurrent, rootNode.level));
  }
  rootNode.children = newChildren;
  return rootNode;
}

function _buildCoaTree(allAccounts, balMap, includeZero, netIncome) {
  const byId = {};
  const kidsOf = {};
  allAccounts.forEach(a => {
    byId[a.id] = a;
    const pid = a.parent_id || '__root__';
    (kidsOf[pid] = kidsOf[pid] || []).push(a);
  });
  Object.keys(kidsOf).forEach(k => kidsOf[k].sort(_codeCompare));

  const mistypedAccounts = [];  // v5.10.83 — non-BS leaves under BS parents

  function build(a, expectedType) {
    // v5.10.83 — type guard. If this node's type differs from the
    // section's expected type AND it's not a BS type at all (revenue/
    // expense leaked into a BS subtree), record it and skip rendering.
    // Equity ↔ Liability mismatch within a BS section is tolerated
    // (those happen with mis-classified user accounts and would already
    // be visible).
    if (a.type !== expectedType) {
      if (!BS_TYPES.has(a.type)) {
        mistypedAccounts.push({
          id: a.id, code: a.code, nameAr: a.name_ar,
          type: a.type, expected: expectedType
        });
        return null;
      }
      // Cross-BS mismatch (e.g., asset under liability folder): also
      // skip to preserve section integrity; record so the owner sees it.
      mistypedAccounts.push({
        id: a.id, code: a.code, nameAr: a.name_ar,
        type: a.type, expected: expectedType
      });
      return null;
    }

    const isFolder = !!a.is_folder;
    const contra = _isContraAccount(a);
    let rawBalance = 0;        // debit-normal sum (raw)
    let postedCount = 0;        // # of leaf entries beneath
    const children = [];
    if (isFolder) {
      (kidsOf[a.id] || []).forEach(ch => {
        const node = build(ch, expectedType);
        if (node) {
          children.push(node);
          rawBalance += node.rawBalance;
          postedCount += node.postedCount;
        }
      });
    } else {
      const entry = balMap[a.id] || { debit: 0, credit: 0, count: 0 };
      rawBalance = (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
      postedCount = Number(entry.count) || 0;
    }
    // Hide zero-balance subtree unless includeZero
    if (!includeZero && postedCount === 0 && Math.abs(rawBalance) < 0.001) return null;

    // displayBalance: assets keep debit-normal (contra naturally negative);
    // liabilities + equity get sign-flipped to credit-normal positive;
    // contra-equity (drawings) explicitly negative.
    let displayBalance;
    if (a.type === 'asset') {
      displayBalance = rawBalance;
    } else if (a.type === 'liability') {
      displayBalance = -rawBalance;
    } else if (a.type === 'equity') {
      displayBalance = -rawBalance;
      if (contra) displayBalance = -Math.abs(displayBalance);
    } else {
      displayBalance = rawBalance;
    }
    return {
      id: a.id,
      code: a.code,
      nameAr: a.name_ar,
      nameEn: a.name_en,
      type: a.type,
      level: a.level,
      accountClass: a.account_class,
      reportSection: a.report_section,
      isFolder,
      isContra: contra,
      rawBalance,
      balance: displayBalance,
      postedCount,
      children
    };
  }

  // Top-level: find root nodes (parent_id IS NULL).
  // v5.10.83 — Pass the expected type into build() so the recursive
  // walk can reject any descendant whose type doesn't match the
  // section (e.g., a stray expense leaf under an asset folder).
  const roots = kidsOf['__root__'] || [];
  const result = { assets: null, liabilities: null, equity: null, mistypedAccounts: [] };
  roots.forEach(r => {
    if (r.type === 'asset')     result.assets      = build(r, 'asset');
    if (r.type === 'liability') result.liabilities = build(r, 'liability');
    if (r.type === 'equity')    result.equity      = build(r, 'equity');
  });
  result.mistypedAccounts = mistypedAccounts;

  // v5.10.99 — Interpose IFRS "current / non-current" virtual folders
  // between the section root (الأصول / الالتزامات) and the actual CoA
  // top-level accounts. Owner explicitly asked: "اريد فقط في قائمة
  // المركز المالي عند الاختيار اجد المسميات الرئيسية" — so the BS now
  // shows الأصول → (المتداولة / غير المتداولة) → cash/receivables/...
  // The interpolated nodes are pure presentation — never written to
  // the DB, never created in the CoA editor. CoA template (which the
  // owner wipes-and-seeds) stays flat.
  result.assets      = _ifrsInterpose(result.assets,      'asset');
  result.liabilities = _ifrsInterpose(result.liabilities, 'liability');
  // Equity gets no current/non-current split — IAS 1 reports it as a
  // single section. Drawings/Reserves/Retained sit at the same level
  // under the equity root.

  // Inject synthetic Net Income line into the equity tree under
  // Retained Earnings (typically code 32). If the equity tree doesn't
  // have a retained-earnings child, we append it to the root.
  if (Math.abs(netIncome) > 0.01 && result.equity) {
    const periodLabel = netIncome >= 0
      ? 'صافي ربح الفترة (قبل قيد الإغلاق)'
      : 'صافي خسارة الفترة (قبل قيد الإغلاق)';
    const syntheticNode = {
      id: '__period_income__',
      code: '(P&L)',
      nameAr: periodLabel,
      nameEn: 'Period Net Income (pre-closing)',
      type: 'equity',
      level: 3,
      accountClass: 'detail',
      reportSection: 'retained',
      isFolder: false,
      isContra: false,
      isComputed: true,
      isPeriodResult: true,
      rawBalance: -netIncome,
      balance: netIncome,
      postedCount: 1,
      children: []
    };
    // Find a "Retained Earnings" container and inject the period P&L.
    // v5.10.84 — Recognises BOTH the new GGMMPP code (300200 / 300300
    // for Retained Earnings / Period P&L) AND the legacy code "32"
    // for backward-compat with un-migrated installs.
    function injectIntoRetained(node) {
      if (!node) return false;
      const code = String(node.code || '');
      const isRetainedContainer =
        code === '32' ||
        code === '300200' ||
        code === '300300';
      if (isRetainedContainer) {
        node.children = node.children || [];
        node.children.push(syntheticNode);
        node.balance += netIncome;
        node.rawBalance += syntheticNode.rawBalance;
        node.postedCount += 1;
        return true;
      }
      for (let i = 0; i < (node.children || []).length; i++) {
        if (injectIntoRetained(node.children[i])) {
          node.balance += netIncome;
          node.rawBalance += syntheticNode.rawBalance;
          return true;
        }
      }
      return false;
    }
    if (!injectIntoRetained(result.equity)) {
      result.equity.children.push(syntheticNode);
      result.equity.balance += netIncome;
      result.equity.rawBalance += syntheticNode.rawBalance;
    }
  }

  return result;
}

router.get('/reports/balance-sheet-ifrs', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { asOfDate, compareDate, brandId, branchId, showZero } = req.query;
    const includeZero = showZero === '1' || showZero === 'true';
    // v5.11.18 — Balance Sheet shows leaf accounts only. Folders never
    // hold posted entries (only their leaves do), so they would never
    // contribute totals — but they DID show up as empty rows when
    // showZero=true. The groups/aggregations below already build their
    // own hierarchy from prefix matching, so folders add only noise.
    // v5.10.78 — include report_section + account_class in the projection
    // so the classifier can route by EXPLICIT column instead of fragile
    // code-prefix matching. The column was backfilled at server start +
    // is populated on every wipe-and-seed, so it's reliable for all
    // post-v5.10.78 installs. Pre-v5.10.78 rows will have NULL and fall
    // through to the legacy prefix logic — fully backward compatible.
    // v5.10.82 — Load LEAF accounts for the legacy buckets pass, then
    // load ALL accounts (folders + leaves) for the CoA-tree builder.
    // PACKAGE G — project the stored classification columns (0028). Without
    // them in the SELECT, classify.js correctly reports every account as
    // unmapped: a missing projection is indistinguishable from missing data,
    // which is exactly why the provenance field exists.
    const [accounts] = await db.query(
      "SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.parent_id, a.level, " +
      "       a.balance, a.is_active, a.status, " +
      "       a.normal_balance, a.is_contra, a.cash_flow_activity, " +
      "       COALESCE(a.is_folder, 0) AS is_folder, " +
      "       COALESCE(a.account_class, 'detail') AS account_class, " +
      "       a.report_section " +
      "FROM gl_accounts a " +
      "WHERE " + LEAF_ACCOUNT_WHERE + " " +
      "ORDER BY " + coaTree.ORDER_BY('a')
    );
    // Full CoA (folders + leaves) for the hierarchical tree view.
    const [allAccountsForTree] = await db.query(
      "SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.parent_id, a.level, " +
      "       a.status, a.normal_balance, a.is_contra, " +
      "       COALESCE(a.is_folder, 0) AS is_folder, " +
      "       COALESCE(a.account_class, 'detail') AS account_class, " +
      "       a.report_section " +
      "FROM gl_accounts a " +
      "WHERE " + classify.REPORTABLE_ACCOUNT_SQL('a') + " " +
      "ORDER BY " + coaTree.ORDER_BY('a')
    );

    // Detect dimension columns once so the brand/branch filters degrade
    // gracefully when the columns haven't been added to gl_entries yet.
    const [dimCols] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'brand_id'");
    const hasBrandId = dimCols.length > 0;
    const [dimCols2] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'branch_id'");
    const hasBranchId = dimCols2.length > 0;

    // Get balances from gl_entries up to asOfDate.
    //
    // ── THE 0036 REMAP, which this report used to skip ───────────────────────
    // Migration 0036 rebuilt the chart, left the historical account rows
    // immutable, recorded each one's canonical destination in
    // coa_0036_account_map, and moved the money with one mechanical journal.
    // The Trial Balance groups by the DESTINATION account and excludes that
    // journal (lib/reports/glBoundaries.js); this report did neither. For any
    // date after the rebuild it therefore counted the old history AND the
    // transfer — a doubled account, and a Balance Sheet that could not agree
    // with the Trial Balance no matter how carefully either was read.
    const books = glBoundaries.inTheBooksSql('j');
    let where = books.sql;
    const params = [...books.params];
    if (asOfDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(asOfDate); }
    if (brandId  && hasBrandId)  { where += ' AND (e.brand_id IS NULL OR e.brand_id = ?)';   params.push(brandId); }
    if (branchId && hasBranchId) { where += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; params.push(branchId); }
    // Degrades to the raw account when the 0036 map table is absent — see the
    // note in lib/reports/glBoundaries.js. Unconditional joining broke this
    // report on every database that had not run that migration.
    const canon = await glBoundaries.canonicalForEntries(db, 'e', 'coa_map');
    const [entries] = await db.query(
      `SELECT ${canon.account} AS account_id, SUM(e.debit) AS d, SUM(e.credit) AS c, COUNT(e.id) AS cnt
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       ${canon.join}
       WHERE ${where} GROUP BY ${canon.account}`, params
    );
    const balMap = {};
    entries.forEach(e => { balMap[e.account_id] = { debit: Number(e.d)||0, credit: Number(e.c)||0, count: Number(e.cnt)||0 }; });

    // V5.10.2 — IFRS / IAS 1 hierarchical classification.
    function makeGroup(label, isContra) {
      return { label: label, total: 0, accounts: [], isContra: !!isContra };
    }
    // v5.11.12 — granular liability + equity buckets so every template
    // account lands in a meaningful, accountancy-conventional group
    // instead of falling into a generic "أخرى" bucket.
    // v5.10.78 — granular IFRS + SOCPA buckets. Added Saudi-statutory
    // groups (VAT input/output, net VAT, GOSI, withholding, EOSB,
    // Zakat) that the prior generic `govDues` bucket was collapsing
    // into a single line — making it impossible for ZATCA-conscious
    // owners to see which obligation owes what.
    const groups = {
      currentAssets: {
        cash:               makeGroup('النقد وما في حكمه'),
        receivables:        makeGroup('الذمم المدينة'),
        allowanceDoubtful:  makeGroup('مخصص الديون المشكوك فيها', true),
        inventory:          makeGroup('المخزون'),
        vatInput:           makeGroup('ضريبة المدخلات المستردة'),  // v5.10.78
        prepaid:            makeGroup('مصروفات مدفوعة مقدماً'),     // v5.10.78
        otherCA:            makeGroup('أصول متداولة أخرى')
      },
      nonCurrentAssets: {
        ppe:          makeGroup('الممتلكات والآلات والمعدات'),
        rou:          makeGroup('حق استخدام الأصول (IFRS 16)'),     // v5.10.81 — separate IFRS 16 RoU line
        accDep:       makeGroup('مجمَّع الإهلاك', true),
        intangibles:  makeGroup('الأصول غير الملموسة')              // v5.10.78
      },
      currentLiab: {
        payables:         makeGroup('الذمم الدائنة (موردون)'),
        accrued:          makeGroup('المصروفات المستحقة'),
        vatOutput:        makeGroup('ضريبة المخرجات المستحقة'),     // v5.10.78
        netVat:           makeGroup('صافي ضريبة القيمة المضافة'),    // v5.10.78
        gosi:             makeGroup('التأمينات الاجتماعية (GOSI)'),  // v5.10.78
        withholding:      makeGroup('ضريبة الاستقطاع'),              // v5.10.78
        zakat:            makeGroup('الزكاة المستحقة'),
        customerDeposits: makeGroup('دفعات مقدمة من العملاء'),
        shortTermDebt:    makeGroup('قروض وإيجارات قصيرة الأجل'),
        otherCL:          makeGroup('التزامات متداولة أخرى')
      },
      nonCurrentLiab: {
        longTermDebt:    makeGroup('قروض طويلة الأجل'),
        leaseObligation: makeGroup('التزام الإيجار طويل الأجل (IFRS 16)'),  // v5.10.81
        eosb:            makeGroup('مخصص مكافأة نهاية الخدمة (IAS 19)')      // v5.10.78
      },
      equity: {
        capital:    makeGroup('رأس المال'),
        retained:   makeGroup('الأرباح المحتجزة'),
        drawings:   makeGroup('المسحوبات', true),
        reserves:   makeGroup('الاحتياطيات')
      }
    };

    // v5.10.78 — report_section → [topGroup, subGroup] lookup. The map +
    // classifyByReportSection now live at module scope (exported for the
    // equity-changes reconciliation) — same logic, same precedence.

    // PACKAGE G — the three local classifiers (by-name, by-asset-code,
    // by-liability-code) are GONE. The by-name one ran a regex over the Arabic
    // name BEFORE the stored report_section, so renaming an account moved it
    // on the balance sheet — it beat the very column that exists to prevent
    // that. The accounts it was "rescuing" (11301 عهدة under 113=Inventory) were fixed
    // at the DATA level instead: routes/custody.js now creates custody under
    // 115 with report_section='receivables' (tests/custodyNotInventory.test.js
    // pins that), which is where a classification belongs.
    //
    // Order is now: stored report_section → legacy code prefix (flagged).
    // classify.balanceSheetGroupOf() applies it for every type at once.

    // Backward-compat flat arrays
    const currentAssets = [], nonCurrentAssets = [], currentLiab = [], nonCurrentLiab = [], equityItems = [];
    let totCA = 0, totNCA = 0, totCL = 0, totNCL = 0, totEq = 0;
    let netIncome = 0;
    // v5.10.38 — collect accounts that don't fit any classification rule
    // so the UI can surface a "Unclassified" warning section.
    const unclassified = [];
    // PACKAGE G — accounts whose bucket did NOT come from stored metadata.
    // An empty array is the only honest way to claim the chart is migrated.
    const unmapped = [];
    function noteUnmapped(a, cls) {
      unmapped.push(classify.unmappedRow(a, cls, { bucket: cls && cls.group ? cls.group.join('.') : null }));
    }

    // v5.10.61 — pushAccount helper applies the correct sign convention
    // for both the group total AND the top-level total. For contra
    // accounts (مجمع الإهلاك / المسحوبات / مخصص الديون) the magnitude
    // is SUBTRACTED.
    function pushToGroup(group, account, magnitude) {
      const signed = group.isContra ? -magnitude : magnitude;
      group.accounts.push({
        id: account.id, code: account.code, nameAr: account.name_ar,
        balance: signed, magnitude: magnitude, isContra: !!group.isContra
      });
      group.total += signed;
      return signed;
    }

    accounts.forEach(a => {
      const entry = balMap[a.id] || { debit: 0, credit: 0, count: 0 };
      const net = entry.debit - entry.credit; // debit-normal
      const hasMovement = (entry.count || 0) > 0 || Math.abs(net) >= 0.001;
      // PACKAGE G — an archived account is in the result set ONLY so its
      // history survives. With no movement in scope it is not "a zero-balance
      // account the user asked to see" (showZero), it is a closed account —
      // never list it.
      if (!classify.isReportable(a, hasMovement)) return;
      // v5.10.38 — primary filter: no posted journal entries means no
      // display, regardless of stored balance.
      if ((entry.count || 0) === 0 && !includeZero) return;
      // Secondary filter: belt-and-suspenders against zombie balances.
      if (Math.abs(net) < 0.001 && !includeZero) return;

      const flatItem = { id: a.id, code: a.code, name: a.name_ar, balance: 0, level: a.level };

      // PACKAGE G — ONE call, one order of precedence, for every type:
      // stored report_section (validated against statement_sections) first,
      // legacy code prefix only when the column is absent — and when it is,
      // the account is reported in `unmapped` rather than passing silently.
      const cls = classify.balanceSheetGroupOf(a);
      const bucket = cls.group;
      if (cls.unmapped) noteUnmapped(a, cls);

      if (a.type === 'asset') {
        const magnitude = net;
        const assetBucket = bucket && ['currentAssets', 'nonCurrentAssets'].includes(bucket[0]) ? bucket : null;
        if (assetBucket && groups[assetBucket[0]] && groups[assetBucket[0]][assetBucket[1]]) {
          const targetGroup = groups[assetBucket[0]][assetBucket[1]];
          const signed = pushToGroup(targetGroup, a, magnitude);
          flatItem.balance = signed;
          flatItem.__mul = (net === 0 ? 1 : signed / net);
          if (assetBucket[0] === 'nonCurrentAssets') { nonCurrentAssets.push(flatItem); totNCA += signed; }
          else                                   { currentAssets.push(flatItem);    totCA  += signed; }
        } else {
          flatItem.balance = magnitude;
          flatItem.__mul = (net === 0 ? 1 : magnitude / net);
          unclassified.push({ id: a.id, code: a.code, nameAr: a.name_ar, type: a.type, balance: magnitude });
          if (a.code && a.code.startsWith('12')) { nonCurrentAssets.push(flatItem); totNCA += magnitude; }
          else                                    { currentAssets.push(flatItem);    totCA  += magnitude; }
        }
      } else if (a.type === 'liability') {
        const magnitude = -net;
        const liabilityBucket = bucket && ['currentLiab', 'nonCurrentLiab'].includes(bucket[0]) ? bucket : null;
        if (liabilityBucket && groups[liabilityBucket[0]] && groups[liabilityBucket[0]][liabilityBucket[1]]) {
          const targetGroup = groups[liabilityBucket[0]][liabilityBucket[1]];
          const signed = pushToGroup(targetGroup, a, magnitude);
          flatItem.balance = signed;
          flatItem.__mul = (net === 0 ? 1 : signed / net);
          if (liabilityBucket[0] === 'nonCurrentLiab') { nonCurrentLiab.push(flatItem); totNCL += signed; }
          else                                 { currentLiab.push(flatItem);    totCL  += signed; }
        } else {
          flatItem.balance = magnitude;
          flatItem.__mul = (net === 0 ? 1 : magnitude / net);
          unclassified.push({ id: a.id, code: a.code, nameAr: a.name_ar, type: a.type, balance: magnitude });
          if (a.code && a.code.startsWith('22')) { nonCurrentLiab.push(flatItem); totNCL += magnitude; }
          else                                    { currentLiab.push(flatItem);    totCL  += magnitude; }
        }
      } else if (a.type === 'equity') {
        const magnitude = -net;
        // Equity never falls through: classifyEquity's legacy default is
        // 'capital', so totEq keeps every row even on an un-coded chart.
        const cls2 = bucket && bucket[0] === 'equity' ? bucket : classifyEquity(a.code);
        if (cls2 && groups[cls2[0]] && groups[cls2[0]][cls2[1]]) {
          const targetGroup = groups[cls2[0]][cls2[1]];
          const signed = pushToGroup(targetGroup, a, magnitude);
          flatItem.balance = signed;
          flatItem.__mul = (net === 0 ? 1 : signed / net);
          equityItems.push(flatItem);
          totEq += signed;
        } else {
          flatItem.balance = magnitude;
          flatItem.__mul = (net === 0 ? 1 : magnitude / net);
          equityItems.push(flatItem);
          totEq += magnitude;
        }
      } else if (a.type === 'revenue') {
        netIncome += (entry.credit - entry.debit);
      } else if (a.type === 'expense') {
        netIncome -= (entry.debit - entry.credit);
      }
    });

    // v5.10.61 — Per IFRS Statement of Changes in Equity, the current-period
    // P&L is shown as a LINE WITHIN Retained Earnings — not as a separate
    // equity sub-group.
    if (Math.abs(netIncome) > 0.01) {
      const periodLabel = netIncome >= 0 ? 'صافي ربح الفترة (قبل قيد الإغلاق)' : 'صافي خسارة الفترة (قبل قيد الإغلاق)';
      equityItems.push({
        id: '__period_income__', code: '(P&L)', name: periodLabel,
        balance: netIncome, level: 3, isComputed: true, isPeriodResult: true
      });
      groups.equity.retained.accounts.push({
        id: '__period_income__', code: '(P&L)', nameAr: periodLabel,
        balance: netIncome, magnitude: Math.abs(netIncome),
        isComputed: true, isPeriodResult: true
      });
      groups.equity.retained.total += netIncome;
      totEq += netIncome;
    }

    const totalAssets = totCA + totNCA;
    const totalLiabilities = totCL + totNCL;

    // v5.10.79 — Optional period-over-period comparison. When the client
    // sends ?compareDate=YYYY-MM-DD, we run a slim 2nd snapshot to that
    // date and compute deltas (absolute + %) for the top totals + every
    // report_section bucket. The full per-account drilldown is NOT
    // duplicated — that would double the heavy query for marginal UI
    // value (the user wants the comparison in totals + section headers).
    let priorSnapshot = null;
    let change = null;
    if (compareDate) {
      try {
        priorSnapshot = await _bsSnapshotTotals(compareDate, brandId, branchId, hasBrandId, hasBranchId);

        // ── Per-account comparison ───────────────────────────────────────────
        // Attach each account's prior balance to the row it sits on, so the
        // client can render a real comparison COLUMN rather than a delta chip
        // on the grand totals.
        //
        // BOTH SHAPES, because this response carries the same account twice:
        // the FLAT arrays (currentAssets, equityItems, …) that the statement
        // renders from, and the nested `groups` tree used for the grouped view.
        // `pushToGroup` builds its own object, so they are different objects —
        // attaching to one alone leaves the other with no prior column, and the
        // flat arrays are the ones the page actually reads.
        //
        // Walked rather than enumerated: the bucket list has grown repeatedly
        // (Saudi-statutory VAT, GOSI, withholding, EOSB, Zakat…) and a
        // hand-written list would go stale silently.
        //
        // `null`, never 0, for an account absent from the prior snapshot: it
        // did not exist or had not moved by that date, and that is not the same
        // as having been worth zero.
        // `__mul` is the multiplier that took this row's RAW net to the balance
        // shown in the current column. Applying it to the prior raw net signs
        // the two columns identically by construction — the contra flip, the
        // debit/credit orientation, all of it — instead of re-deriving the rule
        // from a different source and hoping the two agree.
        const priorOf = (row) => {
          const net = priorSnapshot.accountBalances[row.id];
          if (net === undefined) return null;   // absent ≠ zero
          const mul = (typeof row.__mul === 'number' && Number.isFinite(row.__mul)) ? row.__mul : 1;
          return net * mul;
        };
        const flatLists = [currentAssets, nonCurrentAssets, currentLiab, nonCurrentLiab, equityItems];
        const mulById = new Map();
        flatLists.forEach((list) => list.forEach((row) => {
          if (typeof row.__mul === 'number') mulById.set(row.id, row.__mul);
          row.prior = priorOf(row);
        }));
        // The grouped tree holds DIFFERENT objects for the same accounts, and
        // they carry no `__mul` — reuse the flat row's, keyed by id.
        (function attachPriors(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node.accounts)) {
            node.accounts.forEach((acc) => {
              acc.prior = priorOf({ id: acc.id, __mul: mulById.get(acc.id) });
            });
          }
          Object.keys(node).forEach((k) => {
            if (k !== 'accounts') attachPriors(node[k]);
          });
        })(groups);
        // ── Prior TOTALS are summed from the prior COLUMN ────────────────────
        // Not taken from the snapshot's own roll-up, which signs contra from
        // the ACCOUNT's flag while the statement signs it from the GROUP's.
        // With accumulated depreciation in the fixture those two produced
        // −2,000 and +2,000 for the same account, so the asset delta came back
        // −2,800 when the only real change was a +1,200 account.
        //
        // Summing the column the reader actually sees makes the footer agree
        // with the lines above it by construction. A prior-only account that no
        // longer appears is therefore excluded — correctly: it has no line in
        // this statement for its figure to belong to.
        const sumPrior = (lists) => lists.reduce((acc, list) =>
          acc + list.reduce((s, r) => s + (typeof r.prior === 'number' ? r.prior : 0), 0), 0);

        priorSnapshot.totalAssets      = sumPrior([currentAssets, nonCurrentAssets]);
        priorSnapshot.totalLiabilities = sumPrior([currentLiab, nonCurrentLiab]);
        priorSnapshot.totEq            = sumPrior([equityItems]);

        // `__mul` is an internal working value, not part of the contract.
        flatLists.forEach((list) => list.forEach((row) => { delete row.__mul; }));

        change = {
          totalAssets:      _bsDelta(totalAssets,      priorSnapshot.totalAssets),
          totalLiabilities: _bsDelta(totalLiabilities, priorSnapshot.totalLiabilities),
          totEq:            _bsDelta(totEq,            priorSnapshot.totEq),
          netIncome:        _bsDelta(netIncome,        priorSnapshot.netIncome),
          sectionTotals: {}
        };
        // Per-section delta map keyed by report_section. Lets the
        // frontend show a small "Δ" next to each subgroup row.
        Object.keys(priorSnapshot.sectionTotals).forEach(k => {
          const cur = 0; // current is computed lazily by frontend from groups[].total
          change.sectionTotals[k] = priorSnapshot.sectionTotals[k];
        });
      } catch (e) {
        // Comparison is a soft feature; if it fails, log + return main data
        console.warn('[balance-sheet] compareDate snapshot failed:', e.message);
      }
    }

    // v5.10.79 — Order groups by IFRS liquidity convention before sending.
    // The frontend can iterate `orderedGroups.currentAssets` as an ordered
    // ARRAY (instead of relying on JavaScript object insertion order).
    const orderedGroups = {
      currentAssets:    orderSection('currentAssets',    groups.currentAssets),
      nonCurrentAssets: orderSection('nonCurrentAssets', groups.nonCurrentAssets),
      currentLiab:      orderSection('currentLiab',      groups.currentLiab),
      nonCurrentLiab:   orderSection('nonCurrentLiab',   groups.nonCurrentLiab),
      equity:           orderSection('equity',           groups.equity)
    };

    // v5.10.82 — CoA-driven hierarchical tree. Mirrors the actual Chart
    // of Accounts structure as configured by the owner. Each folder rolls
    // up the balances of its descendants; contra accounts (1124 allowance,
    // 122 acc dep, 33 drawings) are flagged so the frontend can color
    // them red and the parent's sum reflects the correct net amount.
    // Net Income is injected as a synthetic line under Retained Earnings
    // (code 32) per IAS 1 Statement of Changes in Equity.
    // NAMED `coaTreeView`, not `coaTree`. The module import at the top of this
    // file is `const coaTree = require('../../../lib/coa/tree')`, and this
    // declaration sits INSIDE the same try block that uses it at
    // `coaTree.ORDER_BY('a')` further up. A `const` shadow puts that import in
    // the temporal dead zone for the WHOLE block, so those earlier lines threw
    // `ReferenceError: Cannot access 'coaTree' before initialization` on every
    // single request — and the catch below turned it into a 200 full of zeros.
    // The response key stays `coaTree`, so the API contract is unchanged.
    const coaTreeView = _buildCoaTree(allAccountsForTree, balMap, includeZero, netIncome);

    res.json({
      currentAssets, totCA, nonCurrentAssets, totNCA, totalAssets,
      currentLiab, totCL, nonCurrentLiab, totNCL, totalLiabilities,
      equityItems, totEq,
      netIncome,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totEq)) < 0.01,
      // Same UTC-vs-Riyadh-session-timezone mistake as routes/hr.js's
      // /my-clock (fixed alongside this) — toISOString() is UTC, not this
      // codebase's canonical Riyadh session timezone, so the default as-of
      // date could silently label itself "yesterday" for ~3h every day.
      asOfDate: asOfDate || todayYmd(),
      groups: groups,
      orderedGroups: orderedGroups,   // v5.10.79 — IFRS-ordered arrays
      coaTree: coaTreeView,            // v5.10.82 — CoA-mirrored hierarchical tree
      unclassified: unclassified,
      // PACKAGE G — accounts whose bucket did NOT come from stored metadata
      // (report_section absent or not in the section catalog, so the legacy
      // code-prefix guess was used). `unclassified` above means "landed
      // nowhere"; `unmapped` means "landed somewhere, but on a guess".
      unmapped: unmapped,
      sectionCatalogGaps: classify.catalogGaps(),
      prior: priorSnapshot,           // v5.10.79 — comparison snapshot (or null)
      change: change                   // v5.10.79 — deltas (or null)
    });
  } catch (e) {
    // LOG, always. This catch answering 200 with an all-zero balance sheet is
    // precisely why a `ReferenceError` on the line above lived on main
    // undetected: the endpoint never failed, it just quietly reported that the
    // company owns nothing. A financial statement that silently zeroes itself is
    // worse than one that errors — nothing downstream can tell the difference
    // between "no data" and "the report is broken".
    //
    // The zeroed shape is kept so existing callers do not crash, but it now
    // carries `degraded: true` and the request id, so the UI and the logs can
    // both say so instead of presenting zeros as fact.
    console.error('[erp/reports/balance-sheet-ifrs]', req.requestId || '-', (e && e.stack) || e);
    res.json({
      currentAssets: [], nonCurrentAssets: [], currentLiab: [], nonCurrentLiab: [], equityItems: [],
      totCA: 0, totNCA: 0, totCL: 0, totNCL: 0, totEq: 0,
      totalAssets: 0, totalLiabilities: 0, netIncome: 0,
      isBalanced: false, groups: {}, unclassified: [], unmapped: [],
      degraded: true, requestId: req.requestId || null,
    });
  }
});

module.exports = router;
// Shared with routes/erp/reports/equity-changes.js — the Statement of
// Changes in Equity must reconcile exactly with this report's totEq,
// so it reuses the SAME leaf predicate, classification and contra set
// instead of re-implementing them (and drifting).
module.exports.LEAF_ACCOUNT_WHERE = LEAF_ACCOUNT_WHERE;
module.exports.CONTRA_GROUP_KEYS = CONTRA_GROUP_KEYS;
module.exports.classifyByReportSection = classifyByReportSection;
module.exports.classifyEquity = classifyEquity;
