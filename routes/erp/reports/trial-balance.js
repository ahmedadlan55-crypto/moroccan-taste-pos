// ═══════════════════════════════════════════════════════════════════
// /api/erp/reports/trial-balance — ميزان المراجعة (Trial Balance)
//
// Returns per posting (leaf) account:
//   • opening debit + credit  (everything before startDate, plus any
//     entries flagged reference_type = 'opening')
//   • period  debit + credit  (movements inside the [startDate, endDate]
//     window, excluding opening entries)
//   • closing debit + credit  (opening ± period, classified on the
//     account's natural side)
//
// Accepts both legacy (?from=&to=) and new (?startDate=&endDate=) param
// names plus optional dimension filters: brandId / branchId /
// costCenterId. Each dimension query gracefully degrades if the
// matching column doesn't exist on gl_entries yet.
//
// Also returns three granular balance flags (opening / period /
// closing) so the UI can pinpoint which side of the ledger is off,
// plus an abnormalCount of accounts whose closing side disagrees
// with their natural side.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../../db/connection');

router.get('/reports/trial-balance', async (req, res) => {
  try {
    // v5.11.13 — Accept both legacy (from/to) and new (startDate/endDate)
    // param names so the existing frontend keeps working. Same for the
    // dimension filters: brand/branch/costCenter from the new UI dropdowns.
    const startDate    = req.query.startDate || req.query.from || '';
    const endDate      = req.query.endDate   || req.query.to   || '';
    const accountType  = req.query.accountType || '';
    const createdBy    = req.query.createdBy   || '';
    const brandId      = req.query.brandId      || req.query.brand      || '';
    const branchId     = req.query.branchId     || req.query.branch     || '';
    const costCenterId = req.query.costCenterId || req.query.cost_center_id || '';

    // v5.11.18 — Trial balance shows POSTING accounts only (leaves), not
    // folders. A row is a folder if EITHER is_folder is set OR any other
    // account references it as parent — using both checks defends against
    // a stale is_folder column on legacy rows.
    const [accounts] = await db.query(
      'SELECT * FROM gl_accounts a ' +
      'WHERE a.is_active = 1 ' +
      '  AND COALESCE(a.is_folder, 0) = 0 ' +
      '  AND a.id NOT IN (SELECT DISTINCT parent_id FROM gl_accounts WHERE parent_id IS NOT NULL) ' +
      'ORDER BY a.code'
    );

    // Detect dimension columns — graceful degrade if they aren't present yet.
    const [dimCols1] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'brand_id'");
    const hasBrandId = dimCols1.length > 0;
    const [dimCols2] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'branch_id'");
    const hasBranchId = dimCols2.length > 0;
    const [dimCols3] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'cost_center_id'");
    const hasCostCenterId = dimCols3.length > 0;

    // Build journal filter for period (exclude opening entries — they go to opening balance)
    let jrnWhere = "j.status = 'posted' AND j.reference_type != 'opening'";
    const jrnParams = [];
    if (startDate)    { jrnWhere += ' AND DATE(j.journal_date) >= ?'; jrnParams.push(startDate); }
    if (endDate)      { jrnWhere += ' AND DATE(j.journal_date) <= ?'; jrnParams.push(endDate); }
    if (createdBy)    { jrnWhere += ' AND j.created_by = ?';          jrnParams.push(createdBy); }
    if (brandId      && hasBrandId)      { jrnWhere += ' AND (e.brand_id IS NULL OR e.brand_id = ?)';             jrnParams.push(brandId); }
    if (branchId     && hasBranchId)     { jrnWhere += ' AND (e.branch_id IS NULL OR e.branch_id = ?)';           jrnParams.push(branchId); }
    if (costCenterId && hasCostCenterId) { jrnWhere += ' AND (e.cost_center_id IS NULL OR e.cost_center_id = ?)'; jrnParams.push(costCenterId); }

    // Get period movements (non-opening posted journals)
    const [periodEntries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS totalDebit, SUM(e.credit) AS totalCredit
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${jrnWhere} GROUP BY e.account_id`, jrnParams
    );
    const periodMap = {};
    periodEntries.forEach(e => { periodMap[e.account_id] = { debit: Number(e.totalDebit)||0, credit: Number(e.totalCredit)||0 }; });

    // Opening balance = ALL opening entries + non-opening entries BEFORE startDate.
    // Dimension filters apply here too — opening for brand X means only the
    // opening lines tagged with brand X (or untagged legacy lines).
    let openMap = {};
    let openWhere = "j.status = 'posted' AND j.reference_type = 'opening'";
    const openParams = [];
    if (brandId      && hasBrandId)      { openWhere += ' AND (e.brand_id IS NULL OR e.brand_id = ?)';             openParams.push(brandId); }
    if (branchId     && hasBranchId)     { openWhere += ' AND (e.branch_id IS NULL OR e.branch_id = ?)';           openParams.push(branchId); }
    if (costCenterId && hasCostCenterId) { openWhere += ' AND (e.cost_center_id IS NULL OR e.cost_center_id = ?)'; openParams.push(costCenterId); }
    const [openingEntries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS totalDebit, SUM(e.credit) AS totalCredit
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${openWhere}
       GROUP BY e.account_id`, openParams
    );
    openingEntries.forEach(e => {
      openMap[e.account_id] = { debit: Number(e.totalDebit)||0, credit: Number(e.totalCredit)||0 };
    });
    // 2. Non-opening entries before startDate
    if (startDate) {
      let priorWhere = "j.status = 'posted' AND j.reference_type != 'opening' AND DATE(j.journal_date) < ?";
      const priorParams = [startDate];
      if (brandId      && hasBrandId)      { priorWhere += ' AND (e.brand_id IS NULL OR e.brand_id = ?)';             priorParams.push(brandId); }
      if (branchId     && hasBranchId)     { priorWhere += ' AND (e.branch_id IS NULL OR e.branch_id = ?)';           priorParams.push(branchId); }
      if (costCenterId && hasCostCenterId) { priorWhere += ' AND (e.cost_center_id IS NULL OR e.cost_center_id = ?)'; priorParams.push(costCenterId); }
      const [priorEntries] = await db.query(
        `SELECT e.account_id, SUM(e.debit) AS totalDebit, SUM(e.credit) AS totalCredit
         FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
         WHERE ${priorWhere}
         GROUP BY e.account_id`, priorParams
      );
      priorEntries.forEach(e => {
        if (!openMap[e.account_id]) openMap[e.account_id] = { debit: 0, credit: 0 };
        openMap[e.account_id].debit += Number(e.totalDebit)||0;
        openMap[e.account_id].credit += Number(e.totalCredit)||0;
      });
    }

    const typeLabels = {asset:'أصول',liability:'التزامات',equity:'حقوق ملكية',revenue:'إيرادات',expense:'مصروفات'};
    const rows = [];
    let totals = { openDebit:0, openCredit:0, periodDebit:0, periodCredit:0, closeDebit:0, closeCredit:0 };

    accounts.forEach(a => {
      if (accountType && a.type !== accountType) return;

      const open = openMap[a.id] || { debit: 0, credit: 0 };
      const period = periodMap[a.id] || { debit: 0, credit: 0 };

      // Opening net balance
      const openNet = open.debit - open.credit;
      let openDebit = 0, openCredit = 0;
      if (a.type === 'asset' || a.type === 'expense') {
        if (openNet >= 0) openDebit = openNet; else openCredit = Math.abs(openNet);
      } else {
        if (openNet <= 0) openCredit = Math.abs(openNet); else openDebit = openNet;
      }

      // Closing net = opening + period
      const closeNet = openNet + (period.debit - period.credit);
      let closeDebit = 0, closeCredit = 0;
      if (a.type === 'asset' || a.type === 'expense') {
        if (closeNet >= 0) closeDebit = closeNet; else closeCredit = Math.abs(closeNet);
      } else {
        if (closeNet <= 0) closeCredit = Math.abs(closeNet); else closeDebit = closeNet;
      }

      totals.openDebit += openDebit; totals.openCredit += openCredit;
      totals.periodDebit += period.debit; totals.periodCredit += period.credit;
      totals.closeDebit += closeDebit; totals.closeCredit += closeCredit;

      // v5.10.61 — abnormal-sign detection. If a debit-normal account
      // (asset/expense) ends up with a credit balance — or a credit-
      // normal account (liability/equity/revenue) ends up with a debit
      // balance — flag the row so the UI can highlight it in orange.
      const isDebitNormal = (a.type === 'asset' || a.type === 'expense');
      const abnormalSign = isDebitNormal
        ? (closeCredit > 0.01)
        : (closeDebit  > 0.01);

      rows.push({
        code: a.code, nameAR: a.name_ar, type: a.type, typeLabel: typeLabels[a.type]||a.type,
        level: a.level, parentId: a.parent_id,
        openDebit, openCredit,
        periodDebit: period.debit, periodCredit: period.credit,
        closeDebit, closeCredit,
        abnormalSign     // NEW: true when balance side doesn't match account's natural side
      });
    });

    // v5.10.61 — individual balance checks per column. The old single
    // `isBalanced` only checked the closing column, so a historical
    // imbalance in the opening side or a one-sided period entry could
    // pass unnoticed if the totals happened to cancel out at close.
    const isOpeningBalanced = Math.abs(totals.openDebit  - totals.openCredit)  < 0.01;
    const isPeriodBalanced  = Math.abs(totals.periodDebit - totals.periodCredit) < 0.01;
    const isClosingBalanced = Math.abs(totals.closeDebit - totals.closeCredit) < 0.01;

    res.json({
      // Backward-compatible field — kept so existing UI still works
      isBalanced: isClosingBalanced,
      // v5.10.61 — granular balance checks for the trial-balance toolbar
      isOpeningBalanced,
      isPeriodBalanced,
      isClosingBalanced,
      abnormalCount: rows.filter(r => r.abnormalSign).length,
      rows, totals
    });
  } catch (e) { res.json({ isBalanced: false, isOpeningBalanced: false, isPeriodBalanced: false, isClosingBalanced: false, abnormalCount: 0, rows: [], totals: {} }); }
});

module.exports = router;
