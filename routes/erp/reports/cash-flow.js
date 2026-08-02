// ═══════════════════════════════════════════════════════════════════
// /api/erp/reports/cash-flow-ias7 — قائمة التدفقات النقدية (IAS 7)
//
// Indirect-method cash-flow statement. Computes:
//   1. Net income (revenue - expense for the period)
//   2. Working-capital changes (Δ in current assets / liabilities)
//   3. Investing activities (Δ in fixed assets)
//   4. Financing activities (Δ in equity / drawings / loans)
// The closing reconciliation matches the period's actual cash & bank
// movement — they should agree to the cent if the books are clean.
//
// All numbers are pulled from gl_entries joined to posted gl_journals.
// Filters: from/to dates, brandId (entries.brand_id if set), branchId,
// showZero (when '1', keeps zero-amount line items in each section).
//
// V5.10.4 — moved to /reports/cash-flow-ias7 because routes/erp-core.js
// also has a /reports/cash-flow handler (direct method, V3 shape) and the
// frontend v5.10.1 IAS 7 indirect-method UI was being shadowed.
//
// PACKAGE G — THE 112 CONTRADICTION IS GONE.
// This file used to own a private `category(code)` that was 100% code
// prefix and never read report_section at all. It classified code `112` as
// INVENTORY while routes/erp/reports/balance-sheet.js classified the very
// same `112` as RECEIVABLES: two statements, same account, different
// answers, by construction. Everything it could not match — including every
// 6-digit GGMMPP account and all of long-term debt — fell into a bucket
// called 'other' that no section consumed, so those balances silently
// vanished from the statement while the reconciliation line took the blame.
//
// Classification now comes from lib/coa/classify.js in this order:
//   1. gl_accounts.cash_flow_activity  (the IAS 7 activity, stated)
//   2. gl_accounts.report_section      (the balance-sheet section, stated)
//   3. the quarantined legacy code prefix — and every account that reaches
//      it is returned in `unmapped` instead of passing for a real answer.
// 0028 deliberately leaves cash_flow_activity NULL on 91 posting accounts;
// those come back as unmapped rather than being guessed into 'other'.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const coaTree = require('../../../lib/coa/tree');
const classify = require('../../../lib/coa/classify');

// Working-capital buckets that roll into Operating as an aggregated line.
// Assets consume cash when they grow; liabilities provide it.
const OPERATING_LINES = [
  { bucket: 'receivables',             label: 'الزيادة/(النقص) في الذمم المدينة',              sign: -1 },
  { bucket: 'inventory',               label: 'الزيادة/(النقص) في المخزون',                    sign: -1 },
  { bucket: 'otherCurrentAssets',      label: 'الزيادة/(النقص) في الأصول المتداولة الأخرى',    sign: -1 },
  { bucket: 'payables',                label: 'الزيادة/(النقص) في الذمم الدائنة',              sign:  1 },
  { bucket: 'otherCurrentLiabilities', label: 'الزيادة/(النقص) في الالتزامات المتداولة الأخرى', sign:  1 },
];

router.get('/reports/cash-flow-ias7', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { from, to, brandId, branchId, showZero } = req.query;
    const includeZero = showZero === '1' || showZero === 'true';
    if (!from || !to) return res.json({ error: 'from + to required' });

    // Build a parameterised entry query that we'll reuse twice — once for
    // opening balances (anything before `from`) and once for the period
    // movement (between `from` and `to`).
    function balQuery(asOfClause, params) {
      // v5.11.18 — leaf accounts only (folders don't hold balances).
      // PACKAGE G — the active filter became REPORTABLE_ACCOUNT_SQL so an
      // account archived AFTER it moved still appears in a historical
      // statement. A zero Δ keeps it out of every line anyway.
      let sql = `
        SELECT a.id, a.code, a.name_ar, a.type, a.report_section,
               a.normal_balance, a.is_contra, a.cash_flow_activity, a.status,
               COALESCE(SUM(e.debit), 0)  AS debit,
               COALESCE(SUM(e.credit), 0) AS credit
        FROM gl_accounts a
        LEFT JOIN gl_entries e ON e.account_id = a.id
        LEFT JOIN gl_journals j ON j.id = e.journal_id
        WHERE ${classify.REPORTABLE_ACCOUNT_SQL('a')}
          AND COALESCE(a.is_folder, 0) = 0
          AND a.id NOT IN (SELECT DISTINCT parent_id FROM gl_accounts WHERE parent_id IS NOT NULL)
          AND (j.status IS NULL OR j.status = 'posted')
          AND (j.id IS NULL OR ${asOfClause})`;
      // Optional brand/branch filter on the entry itself (when columns exist).
      if (brandId)  { sql += ' AND (e.brand_id  IS NULL OR e.brand_id = ?)';  params.push(brandId); }
      if (branchId) { sql += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; params.push(branchId); }
      sql += ' GROUP BY a.id, a.code, a.name_ar, a.type, a.report_section,' +
             ' a.normal_balance, a.is_contra, a.cash_flow_activity, a.status' +
             ' ORDER BY ' + coaTree.ORDER_BY('a');
      return [sql, params];
    }

    // Opening balances: every posted entry before `from`.
    let [oSql, oParams] = balQuery('DATE(j.journal_date) < ?', [from]);
    const [openingRows] = await db.query(oSql, oParams);

    // Closing balances: every posted entry on or before `to`.
    let [cSql, cParams] = balQuery('DATE(j.journal_date) <= ?', [to]);
    const [closingRows] = await db.query(cSql, cParams);

    // Period revenue / expense (between from..to) — gives us net income.
    const piParams = [from, to];
    let piSql = `
      SELECT a.code, a.type,
             COALESCE(SUM(e.debit), 0)  AS debit,
             COALESCE(SUM(e.credit), 0) AS credit
      FROM gl_accounts a
      JOIN gl_entries e ON e.account_id = a.id
      JOIN gl_journals j ON j.id = e.journal_id
      WHERE j.status = 'posted'
        AND DATE(j.journal_date) >= ? AND DATE(j.journal_date) <= ?
        AND a.type IN ('revenue','expense')`;
    if (brandId)  { piSql += ' AND (e.brand_id  IS NULL OR e.brand_id = ?)';  piParams.push(brandId); }
    if (branchId) { piSql += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; piParams.push(branchId); }
    piSql += ' GROUP BY a.code, a.type';
    const [piRows] = await db.query(piSql, piParams);
    let netIncome = 0;
    piRows.forEach(r => {
      if (r.type === 'revenue') netIncome += (Number(r.credit)||0) - (Number(r.debit)||0);
      else                      netIncome -= (Number(r.debit)||0)  - (Number(r.credit)||0);
    });

    // Build id→{opening, closing} for asset/liability/equity accounts.
    // Keyed by ACCOUNT ID, not code: `code` is a business identifier that
    // 0028's alias table exists precisely because it can change.
    const balById = {};
    function fillSide(rows, side) {
      rows.forEach(r => {
        const net = (Number(r.debit)||0) - (Number(r.credit)||0); // debit-normal
        if (!balById[r.id]) balById[r.id] = { account: r, code: r.code, nameAr: r.name_ar, type: r.type, opening: 0, closing: 0 };
        balById[r.id][side] = net;
      });
    }
    fillSide(openingRows, 'opening');
    fillSide(closingRows, 'closing');
    const balanceSheetRows = Object.values(balById).filter(b => ['asset','liability','equity'].includes(b.type));

    // ── Classify every balance-sheet account ONCE, via the shared classifier.
    // No local category() any more: the balance sheet and this statement now
    // read the same stored metadata and cannot disagree about an account.
    const deltaByBucket = {};
    const lineItemsByBucket = {};
    const byActivity = { operating: [], investing: [], financing: [], non_cash: [] };
    const unmapped = [];

    balanceSheetRows.forEach(b => {
      const a = b.account;
      const delta = (b.closing||0) - (b.opening||0);
      const hasMovement = Math.abs(delta) > 0.001 || Math.abs(b.opening||0) > 0.001 || Math.abs(b.closing||0) > 0.001;
      if (!classify.isReportable(a, hasMovement)) return;   // archived + never moved

      const cls = classify.cashFlowBucketOf(a);
      const bucket = cls.bucket;
      if (cls.unmapped || !bucket) {
        unmapped.push(classify.unmappedRow(a, cls, {
          bucket: bucket || null,
          activity: cls.activity || null,
          cashFlowActivityStored: cls.activityStored,
          delta,
        }));
      }
      if (!bucket && !cls.activity) return;   // nothing to place — already reported

      const item = {
        id: a.id, code: b.code, name: b.nameAr, type: b.type,
        opening: b.opening, closing: b.closing, delta,
        bucket: bucket || null, activity: cls.activity, section: cls.section,
        classification: cls.source,
      };

      if (bucket) {
        if (!deltaByBucket[bucket]) deltaByBucket[bucket] = 0;
        if (!lineItemsByBucket[bucket]) lineItemsByBucket[bucket] = [];
        // Assets are stored debit-normal (increase = positive delta). For
        // liabilities/equity a credit increase reads as a MORE NEGATIVE delta,
        // so flip it: positive always means "this balance went up".
        deltaByBucket[bucket] += (b.type === 'asset') ? delta : -delta;
        if (includeZero || Math.abs(delta) > 0.01) lineItemsByBucket[bucket].push(item);
      }
      if (cls.activity && byActivity[cls.activity]) byActivity[cls.activity].push(item);
    });

    // ── Operating (indirect method) ────────────────────────────────────
    //   + Net income
    //   + Depreciation (non-cash add-back, from the accDep bucket)
    //   ± Working-capital movements
    const operating = [];
    operating.push({ label: 'صافي ربح/خسارة الفترة', amount: netIncome, kind: 'subtotal' });

    // Depreciation add-back — the accumulated-depreciation bucket, identified
    // by the acc_dep SECTION (or is_contra), never by an account-code prefix.
    const depreciationDelta = (lineItemsByBucket.accDep || [])
      .reduce((s, x) => s + Math.abs(x.delta), 0);
    if (depreciationDelta > 0.01 || includeZero) {
      operating.push({ label: 'إضافة: استهلاك الأصول الثابتة (Non-cash)', amount: depreciationDelta, bucket: 'accDep' });
    }

    // v5.10.4 — when showZero is on, push every standard working-capital
    // line so the user sees the full set even if no movement happened.
    OPERATING_LINES.forEach(l => {
      const amount = l.sign * (deltaByBucket[l.bucket] || 0);
      if (includeZero || Math.abs(amount) > 0.01) {
        operating.push({ label: l.label, amount, bucket: l.bucket });
      }
    });

    // An account whose STORED cash_flow_activity says 'operating' but whose
    // section is not a working-capital bucket still belongs in Operating —
    // the column is authoritative. Aggregated so it can never be lost.
    const strayOperating = byActivity.operating
      .filter(x => !OPERATING_LINES.some(l => l.bucket === x.bucket) && x.bucket !== 'accDep')
      .reduce((s, x) => s + ((x.type === 'asset') ? -x.delta : x.delta), 0);
    if (Math.abs(strayOperating) > 0.01) {
      operating.push({ label: 'حركات تشغيلية أخرى', amount: strayOperating });
    }
    const operatingTotal = operating.reduce((s, l) => s + (l.amount||0), 0);

    // ── Investing — per-account, everything whose activity is 'investing'
    // (stored, or the fixedAssets bucket's default). Accumulated depreciation
    // is NOT here: it is the non-cash add-back above.
    const investing = byActivity.investing
      .filter(x => x.bucket !== 'accDep')
      .filter(x => includeZero || Math.abs(x.delta) > 0.01)
      .map(x => ({ label: 'صافي حركة ' + x.name, amount: -x.delta, code: x.code, id: x.id }));
    const investingTotal = investing.reduce((s, l) => s + (l.amount||0), 0);

    // ── Financing — equity movements AND long-term debt. The old prefix
    // table matched only `3*`, so drawing down or repaying a loan (22x) fell
    // into 'other' and left the reconciliation to absorb it.
    const financing = byActivity.financing
      .filter(x => includeZero || Math.abs(x.delta) > 0.01)
      .map(x => ({ label: x.name, amount: -x.delta, code: x.code, id: x.id }));
    const financingTotal = financing.reduce((s, l) => s + (l.amount||0), 0);

    // ── Non-cash disclosures — declared via cash_flow_activity='non_cash'.
    // Excluded from all three sections by definition (IAS 7.43).
    const nonCash = byActivity.non_cash
      .filter(x => includeZero || Math.abs(x.delta) > 0.01)
      .map(x => ({ label: x.name, amount: x.delta, code: x.code, id: x.id }));

    // Net change in cash should equal cash account closing-opening.
    const netChange = operatingTotal + investingTotal + financingTotal;
    const cashOpening = (lineItemsByBucket.cash||[]).reduce((s, x) => s + (x.opening||0), 0);
    const cashClosing = (lineItemsByBucket.cash||[]).reduce((s, x) => s + (x.closing||0), 0);
    const actualMovement = cashClosing - cashOpening;
    const reconciliationDiff = netChange - actualMovement;

    res.json({
      from, to,
      netIncome,
      operating: { lines: operating, total: operatingTotal },
      investing: { lines: investing, total: investingTotal },
      financing: { lines: financing, total: financingTotal },
      nonCash,
      netChange,
      cashOpening, cashClosing, actualMovement,
      reconciliationDiff,
      isReconciled: Math.abs(reconciliationDiff) < 1.0,  // tolerate 1 SAR rounding
      // PACKAGE G — accounts this statement could not classify from stored
      // metadata. A non-empty array is the honest explanation for a
      // reconciliation difference; the old code hid these in 'other'.
      unmapped,
      sectionCatalogGaps: classify.catalogGaps(),
    });
  } catch(e) {
    console.error('[cash-flow]', req.requestId || '-', (e && e.stack) || e);
    res.json({ error: e.message,
      operating:{lines:[],total:0}, investing:{lines:[],total:0}, financing:{lines:[],total:0},
      nonCash: [], unmapped: [],
      netChange:0, cashOpening:0, cashClosing:0, actualMovement:0, reconciliationDiff:0, isReconciled:false });
  }
});

module.exports = router;
