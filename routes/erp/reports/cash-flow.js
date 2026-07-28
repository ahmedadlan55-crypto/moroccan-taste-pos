// ═══════════════════════════════════════════════════════════════════
// /api/erp/reports/cash-flow-ias7 — قائمة التدفقات النقدية (IAS 7)
//
// Indirect-method cash-flow statement. Computes:
//   1. Net income (revenue - expense for the period)
//   2. Working-capital changes (Δ in current assets / liabilities)
//   3. Investing activities (Δ in fixed assets)
//   4. Financing activities (Δ in equity / drawings / loans)
// The closing reconciliation matches the period's actual cash & bank
// movement (codes 1101 + 1102) — they should agree to the cent if the
// books are clean.
//
// All numbers are pulled from gl_entries joined to posted gl_journals.
// Filters: from/to dates, brandId (entries.brand_id if set), branchId,
// showZero (when '1', keeps zero-amount line items in each section).
//
// V5.10.4 — moved to /reports/cash-flow-ias7 because routes/erp-core.js
// also has a /reports/cash-flow handler (direct method, V3 shape) and the
// frontend v5.10.1 IAS 7 indirect-method UI was being shadowed.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const coaTree = require('../../../lib/coa/tree');

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
      let sql = `
        SELECT a.id, a.code, a.name_ar, a.type,
               COALESCE(SUM(e.debit), 0)  AS debit,
               COALESCE(SUM(e.credit), 0) AS credit
        FROM gl_accounts a
        LEFT JOIN gl_entries e ON e.account_id = a.id
        LEFT JOIN gl_journals j ON j.id = e.journal_id
        WHERE COALESCE(a.is_active, 1) = 1
          AND COALESCE(a.is_folder, 0) = 0
          AND a.id NOT IN (SELECT DISTINCT parent_id FROM gl_accounts WHERE parent_id IS NOT NULL)
          AND (j.status IS NULL OR j.status = 'posted')
          AND (j.id IS NULL OR ${asOfClause})`;
      // Optional brand/branch filter on the entry itself (when columns exist).
      if (brandId)  { sql += ' AND (e.brand_id  IS NULL OR e.brand_id = ?)';  params.push(brandId); }
      if (branchId) { sql += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; params.push(branchId); }
      sql += ' GROUP BY a.id, a.code, a.name_ar, a.type ORDER BY ' + coaTree.ORDER_BY('a');
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

    // Build code→{opening, closing} map for asset/liability/equity accounts.
    const balByCode = {};
    function fillSide(rows, side) {
      rows.forEach(r => {
        const net = (Number(r.debit)||0) - (Number(r.credit)||0); // debit-normal
        if (!balByCode[r.code]) balByCode[r.code] = { code: r.code, nameAr: r.name_ar, type: r.type, opening: 0, closing: 0 };
        balByCode[r.code][side] = net;
      });
    }
    fillSide(openingRows, 'opening');
    fillSide(closingRows, 'closing');
    const balanceSheetCodes = Object.values(balByCode).filter(b => ['asset','liability','equity'].includes(b.type));

    // Helpers — categorise each account by code prefix.
    function category(code) {
      const c = String(code || '');
      // Cash & banks (1101 + 1102)
      if (c.startsWith('1101') || c.startsWith('1102')) return 'cash';
      // Inventory (1102? no — 1102 is bank above; inventory codes are 112* per the seed)
      if (c.startsWith('112')) return 'inventory';
      // Receivables (113, 1125)
      if (c.startsWith('113') || c.startsWith('1125')) return 'receivables';
      // Other current assets (114, 115)
      if (c.startsWith('114') || c.startsWith('115')) return 'otherCurrentAssets';
      // Fixed assets (12x — including accumulated depreciation 124)
      if (c.startsWith('12')) return 'fixedAssets';
      // Current liabilities — payables (211), accrued (212), tax (213)
      if (c.startsWith('211')) return 'payables';
      if (c.startsWith('212') || c.startsWith('213') || c.startsWith('214') || c.startsWith('21')) return 'otherCurrentLiabilities';
      // Equity / drawings / capital movements (3*)
      if (c.startsWith('3')) return 'equity';
      return 'other';
    }

    // Aggregate Δ (closing - opening) by category.
    const deltaByCat = {};
    const lineItemsByCat = {};
    balanceSheetCodes.forEach(b => {
      const delta = (b.closing||0) - (b.opening||0);
      const cat = category(b.code);
      if (!deltaByCat[cat]) deltaByCat[cat] = 0;
      if (!lineItemsByCat[cat]) lineItemsByCat[cat] = [];
      // For asset categories we use the delta as-is (debit-normal: increase = positive).
      // For liability/equity, positive net is "credit balance increased" but we want
      // to expose the same "Δ closing - opening" so the UI can decide signage.
      if (b.type === 'asset') {
        deltaByCat[cat] += delta;
      } else {
        // For liabilities/equity: storage is debit-normal (negative for credit
        // balances), so an increase in liability shows as MORE NEGATIVE delta.
        // Flip sign so positive = "liability went up".
        deltaByCat[cat] += -delta;
      }
      if (includeZero || Math.abs(delta) > 0.01) {
        lineItemsByCat[cat].push({
          code: b.code, name: b.nameAr, opening: b.opening, closing: b.closing, delta: delta
        });
      }
    });

    // Cash Flow assembly (indirect method).
    // Operating activities:
    //   + Net income
    //   - Increase in receivables (uses cash)
    //   - Increase in inventory   (uses cash)
    //   + Increase in payables    (provides cash)
    //   + Increase in accrued     (provides cash)
    //   + Depreciation (non-cash) — pulled from accumulated dep account 124*
    const operating = [];
    operating.push({ label: 'صافي ربح/خسارة الفترة', amount: netIncome, kind: 'subtotal' });
    // Non-cash adjustments — depreciation increase = non-cash add-back
    const depreciationDelta = (lineItemsByCat.fixedAssets||[])
      .filter(x => String(x.code).startsWith('124'))
      .reduce((s, x) => s + Math.abs(x.delta), 0);
    if (depreciationDelta > 0.01) {
      operating.push({ label: 'إضافة: استهلاك الأصول الثابتة (Non-cash)', amount: depreciationDelta });
    }
    // v5.10.4 — when showZero is on, push every standard working-capital
    // line so the user sees the full set even if no movement happened.
    const _zoThr = includeZero ? -1 : 0.01;
    if (includeZero || Math.abs(deltaByCat.receivables||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في الذمم المدينة', amount: -(deltaByCat.receivables||0) });
    if (includeZero || Math.abs(deltaByCat.inventory||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في المخزون', amount: -(deltaByCat.inventory||0) });
    if (includeZero || Math.abs(deltaByCat.otherCurrentAssets||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في الأصول المتداولة الأخرى', amount: -(deltaByCat.otherCurrentAssets||0) });
    if (includeZero || Math.abs(deltaByCat.payables||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في الذمم الدائنة', amount: (deltaByCat.payables||0) });
    if (includeZero || Math.abs(deltaByCat.otherCurrentLiabilities||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في الالتزامات المتداولة الأخرى', amount: (deltaByCat.otherCurrentLiabilities||0) });
    const operatingTotal = operating.reduce((s, l) => s + (l.amount||0), 0);

    // Investing activities — Δ fixed assets EXCLUDING accumulated depreciation
    const investing = [];
    (lineItemsByCat.fixedAssets||[])
      .filter(x => !String(x.code).startsWith('124'))
      .forEach(x => investing.push({ label: 'صافي حركة ' + x.name, amount: -x.delta, code: x.code }));
    const investingTotal = investing.reduce((s, l) => s + (l.amount||0), 0);

    // Financing activities — Δ equity (capital + drawings + retained)
    const financing = [];
    (lineItemsByCat.equity||[]).forEach(x => {
      // Equity is credit-normal; deltaByCat already flipped sign to "credit increased = positive".
      // For financing display: positive contribution from capital → +; drawings → −.
      // We pass the per-line raw delta with a flipped sign for liabilities/equity:
      const flipped = -x.delta;
      financing.push({ label: x.name, amount: flipped, code: x.code });
    });
    const financingTotal = financing.reduce((s, l) => s + (l.amount||0), 0);

    // Net change in cash should equal cash account closing-opening.
    const netChange = operatingTotal + investingTotal + financingTotal;
    const cashOpening = (lineItemsByCat.cash||[]).reduce((s, x) => s + (x.opening||0), 0);
    const cashClosing = (lineItemsByCat.cash||[]).reduce((s, x) => s + (x.closing||0), 0);
    const actualMovement = cashClosing - cashOpening;
    const reconciliationDiff = netChange - actualMovement;

    res.json({
      from, to,
      netIncome,
      operating: { lines: operating, total: operatingTotal },
      investing: { lines: investing, total: investingTotal },
      financing: { lines: financing, total: financingTotal },
      netChange,
      cashOpening, cashClosing, actualMovement,
      reconciliationDiff,
      isReconciled: Math.abs(reconciliationDiff) < 1.0  // tolerate 1 SAR rounding
    });
  } catch(e) {
    console.error('[cash-flow] error:', e);
    res.json({ error: e.message,
      operating:{lines:[],total:0}, investing:{lines:[],total:0}, financing:{lines:[],total:0},
      netChange:0, cashOpening:0, cashClosing:0, actualMovement:0, reconciliationDiff:0, isReconciled:false });
  }
});

module.exports = router;
