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

router.get('/reports/balance-sheet-ifrs', async (req, res) => {
  try {
    const { asOfDate, brandId, branchId, showZero } = req.query;
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
        ppe:          makeGroup('الممتلكات والمعدات'),
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
        longTermDebt: makeGroup('قروض ومطلوبات طويلة الأجل'),
        eosb:         makeGroup('مخصص مكافأة نهاية الخدمة (IAS 19)')  // v5.10.78
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

    function classifyAsset(code, nameAr) {
      const c = String(code || '');
      const name = String(nameAr || '');
      // ── Step A: keyword-based override (template-agnostic) ──
      if (/إهلاك|depreciation/i.test(name) && /^1[0-9]/.test(c)) return ['nonCurrentAssets', 'accDep'];
      if (/مخصص|allowance|provision/i.test(name) && /^11/.test(c)) return ['currentAssets', 'allowanceDoubtful'];
      // ── Step B: our actual seed (post-v5.10.0 template) ──
      if (c.startsWith('111')) return ['currentAssets', 'cash'];
      if (c.startsWith('112')) return ['currentAssets', 'inventory'];
      if (c.startsWith('113')) return ['currentAssets', 'receivables'];
      if (c.startsWith('114') || c.startsWith('115') || c.startsWith('116'))
        return ['currentAssets', 'otherCA'];
      if (c === '124' || c.startsWith('124')) return ['nonCurrentAssets', 'accDep'];
      if (c.startsWith('121') || c.startsWith('122') || c.startsWith('123'))
        return ['nonCurrentAssets', 'ppe'];
      if (c.startsWith('11')) return ['currentAssets', 'otherCA'];
      if (c.startsWith('12')) return ['nonCurrentAssets', 'ppe'];
      return null;
    }
    function classifyLiability(code) {
      const c = String(code || '');
      // v5.11.12 — calibrated for the v5.11.8 template:
      // 211=AP, 212=accrued, 213=Output VAT, 214=customer deposits,
      // 215=franchise/royalty, 216=GOSI, 217=withholding tax,
      // 218=short-term loans, 219=current portion of lease,
      // 22x=long-term liabilities.
      if (c.startsWith('211')) return ['currentLiab', 'payables'];
      if (c.startsWith('212')) return ['currentLiab', 'accrued'];
      if (c.startsWith('213') || c.startsWith('216') || c.startsWith('217')) return ['currentLiab', 'govDues'];
      if (c.startsWith('214')) return ['currentLiab', 'customerDeposits'];
      if (c.startsWith('218') || c.startsWith('219')) return ['currentLiab', 'shortTermDebt'];
      if (c.startsWith('22'))  return ['nonCurrentLiab', 'longTermDebt'];
      if (c.startsWith('21'))  return ['currentLiab', 'otherCL'];
      return null;
    }
    function classifyEquity(code) {
      const c = String(code || '');
      if (c.startsWith('31')) return ['equity', 'capital'];
      if (c.startsWith('32')) return ['equity', 'retained'];
      if (c.startsWith('33')) return ['equity', 'drawings'];
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
        const cls = fromSection || classifyAsset(a.code, a.name_ar);
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

    res.json({
      currentAssets, totCA, nonCurrentAssets, totNCA, totalAssets,
      currentLiab, totCL, nonCurrentLiab, totNCL, totalLiabilities,
      equityItems, totEq,
      netIncome,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totEq)) < 0.01,
      asOfDate: asOfDate || new Date().toISOString().split('T')[0],
      groups: groups,
      unclassified: unclassified
    });
  } catch (e) { res.json({ currentAssets:[], nonCurrentAssets:[], currentLiab:[], nonCurrentLiab:[], equityItems:[], totCA:0, totNCA:0, totCL:0, totNCL:0, totEq:0, totalAssets:0, totalLiabilities:0, netIncome:0, isBalanced:false, groups:{}, unclassified:[] }); }
});

module.exports = router;
