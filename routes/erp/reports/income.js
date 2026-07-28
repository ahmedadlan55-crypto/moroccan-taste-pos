// ═══════════════════════════════════════════════════════════════════
// /api/erp/reports/income — قائمة الدخل (Income Statement, IAS 1)
//
// Aggregates posted gl_entries inside [startDate, endDate] and splits
// revenue / expense leaf accounts into IFRS sections:
//   • Revenue                (codes that DON'T start with 42)
//   • Other Income           (codes starting with 42)
//   • COGS                   (codes starting with 51)
//   • Operating Expenses     (codes starting with 52)
//   • G&A                    (codes starting with 53)   ← NEW since v5.10.61
//   • Other Expenses         (codes starting with 6)
//   • everything else        → falls back into OpEx
//
// Returns totals + the derived figures: gross profit, operating
// income, and net income. Amounts use a type-aware normal-balance
// rule so abnormal balances appear with the correct sign instead of
// being silently absolute-valued.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');

router.get('/reports/income', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    // v5.11.18 — leaf accounts only.
    const [accounts] = await db.query(
      "SELECT * FROM gl_accounts a " +
      "WHERE a.is_active = 1 " +
      "  AND COALESCE(a.is_folder, 0) = 0 " +
      "  AND a.id NOT IN (SELECT DISTINCT parent_id FROM gl_accounts WHERE parent_id IS NOT NULL) " +
      "ORDER BY a.code"
    );

    // Get period balances from gl_entries (not gl_accounts.balance)
    let where = "j.status = 'posted'";
    const params = [];
    if (startDate) { where += ' AND DATE(j.journal_date) >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(endDate); }
    const [entries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${where} GROUP BY e.account_id`, params
    );
    const balMap = {};
    entries.forEach(e => { balMap[e.account_id] = (Number(e.c)||0) - (Number(e.d)||0); }); // credit-positive for revenue

    // v5.10.61 — Income Statement classification bugs fixed:
    //
    //   BEFORE: `if (a.code.startsWith('5'))` matched EVERY expense (since
    //           all expense codes start with '5' — 51 COGS / 52 OpEx /
    //           53 G&A) and dumped everything into COGS. OpEx and G&A
    //           sections were always empty.
    //
    //   AFTER:  Use 2-digit prefix (51/52/53) to keep COGS, OpEx, and G&A
    //           properly separated. Codes starting with '6' fall under
    //           "Other Expenses" (extraordinary / non-recurring).
    //
    // ALSO: `Math.abs(net)` was destroying signs, so an account with an
    // abnormal balance (e.g. refunds > sales) appeared positive. Replaced
    // with a type-aware normal-balance calculation that PRESERVES sign so
    // the user can spot anomalies in the report.
    const revenue = [], cogs = [], opex = [], gAndA = [], otherIncome = [], otherExpense = [];
    let totalRevenue = 0, totalCOGS = 0, totalOpex = 0, totalGAndA = 0, totalOtherInc = 0, totalOtherExp = 0;

    accounts.forEach(a => {
      const net = balMap[a.id] || 0;   // balMap is credit-positive (c - d)
      // Filter zero-balance rows by TYPE (was a fragile prefix-regex `^[456]`).
      if (Math.abs(net) < 0.001 && a.type !== 'revenue' && a.type !== 'expense') return;
      // Normal-balance display amount — preserves sign for anomaly detection.
      //   Revenue: credit-normal → net (positive when c > d) is already correct.
      //   Expense: debit-normal  → -net (positive when d > c) makes the amount appear positive.
      const bal = (a.type === 'revenue') ? net : -net;
      const item = { code: a.code, name: a.name_ar, balance: bal, level: a.level };

      if (a.type === 'revenue') {
        if (a.code.startsWith('42')) { otherIncome.push(item); totalOtherInc += bal; }
        else                          { revenue.push(item);     totalRevenue   += bal; }
      } else if (a.type === 'expense') {
        // 51x = COGS · 52x = OpEx · 53x = G&A · 6x = Extraordinary
        if      (a.code.startsWith('51')) { cogs.push(item);  totalCOGS  += bal; }
        else if (a.code.startsWith('52')) { opex.push(item);  totalOpex  += bal; }
        else if (a.code.startsWith('53')) { gAndA.push(item); totalGAndA += bal; }
        else if (a.code.startsWith('6'))  { otherExpense.push(item); totalOtherExp += bal; }
        else                              { opex.push(item);  totalOpex  += bal; }   // unknown → safest bucket
      }
    });

    const grossProfit = totalRevenue - totalCOGS;
    const operatingIncome = grossProfit - totalOpex - totalGAndA;
    const netIncome = operatingIncome + totalOtherInc - totalOtherExp;

    res.json({
      // IFRS sections
      revenue, totalRevenue,
      cogs, totalCOGS,
      grossProfit,
      opex, totalOpex,
      gAndA, totalGAndA,             // v5.10.61 NEW: G&A separated from OpEx
      operatingIncome,
      otherIncome, totalOtherInc,
      otherExpense, totalOtherExp,
      netIncome,
      period: { startDate: startDate || null, endDate: endDate || null }
    });
  } catch (e) { res.json({ revenue:[], cogs:[], opex:[], gAndA:[], otherIncome:[], otherExpense:[], totalRevenue:0, totalCOGS:0, grossProfit:0, totalOpex:0, totalGAndA:0, operatingIncome:0, totalOtherInc:0, totalOtherExp:0, netIncome:0 }); }
});

module.exports = router;
