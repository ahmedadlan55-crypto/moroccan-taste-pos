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
  currentLiab:      ['payables', 'accrued', 'vatOutput', 'netVat', 'gosi', 'withholding', 'customerDeposits', 'shortTermDebt', 'otherCL'],
  nonCurrentLiab:   ['longTermDebt', 'leaseObligation', 'eosb'],
  equity:           ['capital', 'retained', 'drawings', 'reserves', 'zakat']
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
  let where = "j.status = 'posted'";
  const params = [];
  if (asOfDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(asOfDate); }
  if (brandId  && hasBrandId)  { where += ' AND (e.brand_id IS NULL OR e.brand_id = ?)';   params.push(brandId); }
  if (branchId && hasBranchId) { where += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; params.push(branchId); }
  const [rows] = await db.query(
    `SELECT a.id, a.code, a.type, a.report_section,
            COALESCE(SUM(CASE WHEN ${where} THEN e.debit  ELSE 0 END), 0) AS d,
            COALESCE(SUM(CASE WHEN ${where} THEN e.credit ELSE 0 END), 0) AS c
       FROM gl_accounts a
       LEFT JOIN gl_entries e   ON e.account_id = a.id
       LEFT JOIN gl_journals j  ON j.id = e.journal_id
      WHERE COALESCE(a.is_folder, 0) = 0 AND a.is_active = 1
      GROUP BY a.id`,
    [...params, ...params]
  );
  // Bucket totals using the same `report_section` map the main pass uses.
  const sectionTotals = {};
  let totalAssets = 0, totalLiab = 0, totalEq = 0;
  let netIncomeRevenue = 0, netIncomeExpense = 0;
  rows.forEach(r => {
    const net = (Number(r.d) || 0) - (Number(r.c) || 0);
    if (Math.abs(net) < 0.001) return;
    if (r.type === 'asset') {
      const mag = net;
      totalAssets += (String(r.report_section || '').match(/(acc_dep|allowance_doubtful)/) ? -mag : mag);
    } else if (r.type === 'liability') {
      totalLiab += -net;
    } else if (r.type === 'equity') {
      const mag = -net;
      totalEq += (String(r.report_section || '') === 'drawings' ? -Math.abs(mag) : mag);
    } else if (r.type === 'revenue') {
      netIncomeRevenue += (Number(r.c) || 0) - (Number(r.d) || 0);
    } else if (r.type === 'expense') {
      netIncomeExpense += (Number(r.d) || 0) - (Number(r.c) || 0);
    }
    if (r.report_section) {
      sectionTotals[r.report_section] = (sectionTotals[r.report_section] || 0) + (r.type === 'asset' ? net : -net);
    }
  });
  const netIncome = netIncomeRevenue - netIncomeExpense;
  totalEq += netIncome;  // Period income goes to retained earnings until close
  return {
    asOfDate, totalAssets, totalLiabilities: totalLiab, totEq: totalEq,
    netIncome, sectionTotals,
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
const CONTRA_REPORT_SECTIONS = new Set(['allowance_doubtful', 'acc_dep', 'drawings']);
function _isContraAccount(a) {
  if (CONTRA_REPORT_SECTIONS.has(a.report_section)) return true;
  // v5.10.84 — In the new GGMMPP standard, Accumulated Depreciation
  // lives under MM=06 (e.g., 100600, 100601). Detect by code prefix as
  // a defensive fallback when report_section is NULL on a fresh row.
  const c = String(a.code || '');
  if (/^\d{6}$/.test(c) && c.startsWith('1006')) return true;
  const ar = String(a.name_ar || '');
  const en = String(a.name_en || '');
  if (/مخصص الديون|مجمَّع الإهلاك|مجمع الإهلاك|المسحوبات|مسحوبات/i.test(ar)) return true;
  if (/allowance|accumulated depreciation|drawings/i.test(en)) return true;
  return false;
}

// Sort by code, numerically-aware (so 1130 < 11201, etc.)
function _codeCompare(a, b) {
  return String(a.code || '').localeCompare(String(b.code || ''), 'en', { numeric: true });
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

router.get('/reports/balance-sheet-ifrs', async (req, res) => {
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
    const [accounts] = await db.query(
      "SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.parent_id, a.level, " +
      "       a.balance, a.is_active, " +
      "       COALESCE(a.is_folder, 0) AS is_folder, " +
      "       COALESCE(a.account_class, 'detail') AS account_class, " +
      "       a.report_section " +
      "FROM gl_accounts a " +
      "WHERE a.is_active = 1 " +
      "  AND COALESCE(a.is_folder, 0) = 0 " +
      "  AND a.id NOT IN (SELECT DISTINCT parent_id FROM gl_accounts WHERE parent_id IS NOT NULL) " +
      "ORDER BY a.code"
    );
    // Full CoA (folders + leaves) for the hierarchical tree view.
    const [allAccountsForTree] = await db.query(
      "SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.parent_id, a.level, " +
      "       COALESCE(a.is_folder, 0) AS is_folder, " +
      "       COALESCE(a.account_class, 'detail') AS account_class, " +
      "       a.report_section " +
      "FROM gl_accounts a " +
      "WHERE a.is_active = 1 " +
      "ORDER BY a.code"
    );

    // Detect dimension columns once so the brand/branch filters degrade
    // gracefully when the columns haven't been added to gl_entries yet.
    const [dimCols] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'brand_id'");
    const hasBrandId = dimCols.length > 0;
    const [dimCols2] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'branch_id'");
    const hasBranchId = dimCols2.length > 0;

    // Get balances from gl_entries up to asOfDate
    let where = "j.status = 'posted'";
    const params = [];
    if (asOfDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(asOfDate); }
    if (brandId  && hasBrandId)  { where += ' AND (e.brand_id IS NULL OR e.brand_id = ?)';   params.push(brandId); }
    if (branchId && hasBranchId) { where += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; params.push(branchId); }
    const [entries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c, COUNT(e.id) AS cnt
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${where} GROUP BY e.account_id`, params
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
        reserves:   makeGroup('الاحتياطيات'),
        zakat:      makeGroup('مخصص الزكاة الشرعية')                  // v5.10.78
      }
    };

    // v5.10.78 — Single source of truth: report_section → [topGroup, subGroup].
    // The wipe-and-seed function (routes/erp.js) writes this column for every
    // CoA template account, and the server-start backfill (server.js v5.10.78)
    // populates it for legacy installs via the same heuristics. Classifiers
    // below check this column FIRST; only fall through to prefix-matching
    // when the column is NULL (unmigrated row).
    const reportSectionMap = {
      // Assets
      cash:               ['currentAssets',    'cash'],
      receivables:        ['currentAssets',    'receivables'],
      allowance_doubtful: ['currentAssets',    'allowanceDoubtful'],
      inventory:          ['currentAssets',    'inventory'],
      vat_input:          ['currentAssets',    'vatInput'],
      prepaid:            ['currentAssets',    'prepaid'],
      other_current_asset:['currentAssets',    'otherCA'],
      ppe:                ['nonCurrentAssets', 'ppe'],
      rou:                ['nonCurrentAssets', 'rou'],            // v5.10.81 — IFRS 16
      acc_dep:            ['nonCurrentAssets', 'accDep'],
      intangibles:        ['nonCurrentAssets', 'intangibles'],
      // Liabilities
      payables:           ['currentLiab',      'payables'],
      accrued:            ['currentLiab',      'accrued'],
      vat_output:         ['currentLiab',      'vatOutput'],
      net_vat:            ['currentLiab',      'netVat'],
      gosi:               ['currentLiab',      'gosi'],
      withholding:        ['currentLiab',      'withholding'],
      customer_deposits:  ['currentLiab',      'customerDeposits'],
      short_term_debt:    ['currentLiab',      'shortTermDebt'],
      other_current_liability: ['currentLiab', 'otherCL'],
      long_term_debt:     ['nonCurrentLiab',   'longTermDebt'],
      lease_obligation:   ['nonCurrentLiab',   'leaseObligation'],  // v5.10.81 — IFRS 16
      eosb:               ['nonCurrentLiab',   'eosb'],
      // Equity
      capital:            ['equity',           'capital'],
      retained:           ['equity',           'retained'],
      drawings:           ['equity',           'drawings'],
      reserves:           ['equity',           'reserves'],
      zakat:              ['equity',           'zakat']
    };
    function classifyByReportSection(reportSection) {
      if (!reportSection) return null;
      return reportSectionMap[reportSection] || null;
    }

    // v5.10.80 — Name-based override that runs BEFORE the explicit
    // report_section lookup. Rescues legacy mis-coded accounts whose
    // names clearly identify their nature (e.g. 11301 "عهدة ADLAN" coded
    // under 113=Inventory). Otherwise report_section would dominate and
    // pin them to the wrong bucket forever — the user can't un-stick
    // them without re-coding every row.
    function classifyAssetByName(code, nameAr) {
      const c = String(code || '');
      const name = String(nameAr || '');
      if (/إهلاك|depreciation/i.test(name) && /^1[0-9]/.test(c)) return ['nonCurrentAssets', 'accDep'];
      if (/مخصص|allowance|provision/i.test(name) && /^11/.test(c)) return ['currentAssets', 'allowanceDoubtful'];
      if (/عهدة|سلفة|سلف|advance|custody/i.test(name) && /^11/.test(c)) return ['currentAssets', 'receivables'];
      return null;
    }

    function classifyAsset(code, nameAr) {
      const c = String(code || '');
      const name = String(nameAr || '');
      // ── Step A: keyword-based override (template-agnostic) ──
      const nameHit = classifyAssetByName(code, nameAr);
      if (nameHit) return nameHit;
      // ── Step B: v5.10.84 — Saudi/International standard 6-digit GGMMPP ──
      // GG=10 → Assets. MM bucket map:
      //   01 cash, 02 receivables, 03 inventory, 04 prepaid,
      //   05 fixed assets (PPE), 06 accumulated depreciation (contra).
      if (/^\d{6}$/.test(c) && c.startsWith('10')) {
        const mm = c.substr(2, 2);
        if (mm === '01') return ['currentAssets',    'cash'];
        if (mm === '02') return ['currentAssets',    'receivables'];
        if (mm === '03') return ['currentAssets',    'inventory'];
        if (mm === '04') return ['currentAssets',    'prepaid'];
        if (mm === '05') return ['nonCurrentAssets', 'ppe'];
        if (mm === '06') return ['nonCurrentAssets', 'accDep'];
        return ['currentAssets', 'otherCA'];
      }
      // ── Step C: legacy fallback (pre-v5.10.84 codes) ──
      if (c.startsWith('111')) return ['currentAssets', 'cash'];
      if (c.startsWith('1124')) return ['currentAssets', 'allowanceDoubtful'];
      if (c.startsWith('112')) return ['currentAssets', 'receivables'];
      if (c.startsWith('113')) return ['currentAssets', 'inventory'];
      if (c.startsWith('114')) return ['currentAssets', 'prepaid'];
      if (c.startsWith('115')) return ['currentAssets', 'receivables'];
      if (c.startsWith('116')) return ['currentAssets', 'vatInput'];
      if (c.startsWith('122')) return ['nonCurrentAssets', 'accDep'];
      if (c.startsWith('124')) return ['nonCurrentAssets', 'rou'];
      if (c.startsWith('121')) return ['nonCurrentAssets', 'ppe'];
      if (c.startsWith('123')) return ['nonCurrentAssets', 'intangibles'];
      if (c.startsWith('125') || c.startsWith('126'))
        return ['nonCurrentAssets', 'intangibles'];
      if (c.startsWith('11')) return ['currentAssets', 'otherCA'];
      if (c.startsWith('12')) return ['nonCurrentAssets', 'ppe'];
      return null;
    }
    function classifyLiability(code) {
      const c = String(code || '');
      // ── v5.10.84 — Saudi/International standard 6-digit GGMMPP ──
      // GG=20 → Liabilities. MM bucket map:
      //   01 payables, 02 accrued, 03 VAT payable, 04 loans.
      if (/^\d{6}$/.test(c) && c.startsWith('20')) {
        const mm = c.substr(2, 2);
        if (mm === '01') return ['currentLiab',    'payables'];
        if (mm === '02') return ['currentLiab',    'accrued'];
        if (mm === '03') return ['currentLiab',    'vatOutput'];
        if (mm === '04') return ['nonCurrentLiab', 'longTermDebt'];
        if (mm === '05') return ['nonCurrentLiab', 'eosb'];            // v5.10.85 — IAS 19
        if (mm === '06') return ['currentLiab',    'customerDeposits']; // v5.10.85
        return ['currentLiab', 'otherCL'];
      }
      // ── Legacy fallback (pre-v5.10.84) ──
      if (c.startsWith('211')) return ['currentLiab', 'payables'];
      if (c.startsWith('212')) return ['currentLiab', 'accrued'];
      if (c.startsWith('2132')) return ['currentLiab', 'netVat'];
      if (c.startsWith('2131')) return ['currentLiab', 'vatOutput'];
      if (c === '213' || c.startsWith('213')) return ['currentLiab', 'vatOutput'];
      if (c.startsWith('214')) return ['currentLiab', 'customerDeposits'];
      if (c.startsWith('215')) return ['currentLiab', 'otherCL'];
      if (c.startsWith('216')) return ['currentLiab', 'gosi'];
      if (c.startsWith('217')) return ['currentLiab', 'withholding'];
      if (c.startsWith('218') || c.startsWith('219')) return ['currentLiab', 'shortTermDebt'];
      if (c.startsWith('223')) return ['nonCurrentLiab', 'eosb'];
      if (c.startsWith('222')) return ['nonCurrentLiab', 'leaseObligation'];
      if (c.startsWith('221')) return ['nonCurrentLiab', 'longTermDebt'];
      if (c.startsWith('22'))  return ['nonCurrentLiab', 'longTermDebt'];
      if (c.startsWith('21'))  return ['currentLiab', 'otherCL'];
      return null;
    }
    function classifyEquity(code) {
      const c = String(code || '');
      // ── v5.10.84 — Saudi/International standard 6-digit GGMMPP ──
      // GG=30 → Equity. MM bucket map:
      //   01 capital, 02 retained earnings, 03 period P&L (folds
      //   into 'retained' per IAS 1 Statement of Changes in Equity).
      if (/^\d{6}$/.test(c) && c.startsWith('30')) {
        const mm = c.substr(2, 2);
        if (mm === '01') return ['equity', 'capital'];
        if (mm === '02') return ['equity', 'retained'];
        if (mm === '03') return ['equity', 'retained'];
        if (mm === '04') return ['equity', 'reserves'];   // v5.10.85
        if (mm === '05') return ['equity', 'drawings'];   // v5.10.85 (contra)
        return ['equity', 'capital'];
      }
      // ── Legacy fallback (pre-v5.10.84) ──
      if (c.startsWith('31')) return ['equity', 'capital'];
      if (c.startsWith('32')) return ['equity', 'retained'];
      if (c.startsWith('33')) return ['equity', 'drawings'];
      if (c.startsWith('343')) return ['equity', 'zakat'];
      if (c.startsWith('34')) return ['equity', 'reserves'];
      return ['equity', 'capital'];
    }

    // Backward-compat flat arrays
    const currentAssets = [], nonCurrentAssets = [], currentLiab = [], nonCurrentLiab = [], equityItems = [];
    let totCA = 0, totNCA = 0, totCL = 0, totNCL = 0, totEq = 0;
    let netIncome = 0;
    // v5.10.38 — collect accounts that don't fit any classification rule
    // so the UI can surface a "Unclassified" warning section.
    const unclassified = [];

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
      // v5.10.38 — primary filter: no posted journal entries means no
      // display, regardless of stored balance.
      if ((entry.count || 0) === 0 && !includeZero) return;
      // Secondary filter: belt-and-suspenders against zombie balances.
      if (Math.abs(net) < 0.001 && !includeZero) return;

      const flatItem = { id: a.id, code: a.code, name: a.name_ar, balance: 0, level: a.level };

      // v5.10.78 — Prefer the explicit report_section column. Falls back to
      // the legacy prefix classifier for unmigrated rows (report_section
      // IS NULL). New installs + post-migration rows take the fast path
      // and stay correctly classified even if codes are later renamed.
      const fromSection = classifyByReportSection(a.report_section);

      if (a.type === 'asset') {
        const magnitude = net;
        // v5.10.80 — name-based override beats report_section so legacy
        // mis-coded custody/allowance/depreciation accounts get routed
        // by their semantic name first.
        const cls = classifyAssetByName(a.code, a.name_ar)
                 || fromSection
                 || classifyAsset(a.code, a.name_ar);
        if (cls && groups[cls[0]] && groups[cls[0]][cls[1]]) {
          const targetGroup = groups[cls[0]][cls[1]];
          const signed = pushToGroup(targetGroup, a, magnitude);
          flatItem.balance = signed;
          if (cls[0] === 'nonCurrentAssets') { nonCurrentAssets.push(flatItem); totNCA += signed; }
          else                                { currentAssets.push(flatItem);    totCA  += signed; }
        } else {
          flatItem.balance = magnitude;
          unclassified.push({ id: a.id, code: a.code, nameAr: a.name_ar, type: a.type, balance: magnitude });
          if (a.code && a.code.startsWith('12')) { nonCurrentAssets.push(flatItem); totNCA += magnitude; }
          else                                    { currentAssets.push(flatItem);    totCA  += magnitude; }
        }
      } else if (a.type === 'liability') {
        const magnitude = -net;
        const cls = fromSection || classifyLiability(a.code);
        if (cls && groups[cls[0]] && groups[cls[0]][cls[1]]) {
          const targetGroup = groups[cls[0]][cls[1]];
          const signed = pushToGroup(targetGroup, a, magnitude);
          flatItem.balance = signed;
          if (cls[0] === 'nonCurrentLiab') { nonCurrentLiab.push(flatItem); totNCL += signed; }
          else                              { currentLiab.push(flatItem);    totCL  += signed; }
        } else {
          flatItem.balance = magnitude;
          unclassified.push({ id: a.id, code: a.code, nameAr: a.name_ar, type: a.type, balance: magnitude });
          if (a.code && a.code.startsWith('22')) { nonCurrentLiab.push(flatItem); totNCL += magnitude; }
          else                                    { currentLiab.push(flatItem);    totCL  += magnitude; }
        }
      } else if (a.type === 'equity') {
        const magnitude = -net;
        const cls = fromSection || classifyEquity(a.code);
        if (cls && groups[cls[0]] && groups[cls[0]][cls[1]]) {
          const targetGroup = groups[cls[0]][cls[1]];
          const signed = pushToGroup(targetGroup, a, magnitude);
          flatItem.balance = signed;
          equityItems.push(flatItem);
          totEq += signed;
        } else {
          flatItem.balance = magnitude;
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
    const coaTree = _buildCoaTree(allAccountsForTree, balMap, includeZero, netIncome);

    res.json({
      currentAssets, totCA, nonCurrentAssets, totNCA, totalAssets,
      currentLiab, totCL, nonCurrentLiab, totNCL, totalLiabilities,
      equityItems, totEq,
      netIncome,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totEq)) < 0.01,
      asOfDate: asOfDate || new Date().toISOString().split('T')[0],
      groups: groups,
      orderedGroups: orderedGroups,   // v5.10.79 — IFRS-ordered arrays
      coaTree: coaTree,                // v5.10.82 — CoA-mirrored hierarchical tree
      unclassified: unclassified,
      prior: priorSnapshot,           // v5.10.79 — comparison snapshot (or null)
      change: change                   // v5.10.79 — deltas (or null)
    });
  } catch (e) { res.json({ currentAssets:[], nonCurrentAssets:[], currentLiab:[], nonCurrentLiab:[], equityItems:[], totCA:0, totNCA:0, totCL:0, totNCL:0, totEq:0, totalAssets:0, totalLiabilities:0, netIncome:0, isBalanced:false, groups:{}, unclassified:[] }); }
});

module.exports = router;
