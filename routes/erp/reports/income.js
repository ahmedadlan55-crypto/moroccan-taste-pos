// ═══════════════════════════════════════════════════════════════════
// /api/erp/reports/income — قائمة الدخل (Income Statement, IAS 1)
//
// Aggregates posted gl_entries inside [startDate, endDate] and splits
// revenue / expense leaf accounts into IFRS sections:
//   • Revenue            (sales_revenue + sales_returns — returns are
//                         contra-revenue and net INSIDE revenue)
//   • Other Income       (other_income)
//   • COGS               (cogs / waste / stock_variance)
//   • Operating Expenses (payroll / rent_utilities / marketing /
//                         depreciation / bank_gov_fees / franchise_fees)
//   • G&A                (legacy 53x — no section exists for it yet)
//   • Other Expenses     (legacy 6x)
//
// Returns totals + the derived figures: gross profit, operating
// income, and net income. Amounts use a normal-balance rule so abnormal
// balances appear with the correct sign instead of being absolute-valued.
//
// PACKAGE G — sections come from lib/coa/classify.js, i.e. from the stored
// gl_accounts.report_section validated against `statement_sections`. This
// file used to classify purely by code prefix (51x COGS / 52x OpEx / 53x G&A
// / 6x other), which meant renumbering an account silently moved it between
// gross profit and operating income. The prefix logic still exists for rows
// that carry no section, but it is quarantined inside classify.js's
// legacy* functions and every account that reaches it comes back in the
// response's `unmapped` array.
//
// NOTE: this is NOT the live P&L — routes/erp-core.js registers
// /reports/pnl, which mounts first and shadows nothing here. It is fixed
// anyway because it is the better implementation and is what /reports/pnl
// should converge on.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const coaTree = require('../../../lib/coa/tree');
const classify = require('../../../lib/coa/classify');
const glBoundaries = require('../../../lib/reports/glBoundaries');

router.get('/reports/income', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    // v5.11.18 — leaf accounts only.
    // PACKAGE G — REPORTABLE_ACCOUNT_SQL instead of is_active=1: a revenue
    // account archived in June must still show the sales it made in May.
    // Zero-movement archived rows are dropped in the JS pass below.
    const [accounts] = await db.query(
      "SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.level, a.is_active, a.status, " +
      "       a.report_section, a.normal_balance, a.is_contra " +
      "FROM gl_accounts a " +
      "WHERE " + classify.REPORTABLE_ACCOUNT_SQL('a') + " " +
      "  AND COALESCE(a.is_folder, 0) = 0 " +
      "  AND a.id NOT IN (SELECT DISTINCT parent_id FROM gl_accounts WHERE parent_id IS NOT NULL) " +
      "ORDER BY " + coaTree.ORDER_BY('a')
    );

    // Get period balances from gl_entries (not gl_accounts.balance).
    //
    // ── THE 0036 REMAP, which this report used to skip ───────────────────────
    // Migration 0036 rebuilt the chart and left the historical account rows
    // immutable, recording each one's canonical destination in
    // coa_0036_account_map and moving the money with one mechanical journal.
    // The Trial Balance and the General Ledger both group by the DESTINATION
    // account and exclude that journal (lib/reports/glBoundaries.js). This
    // report did neither — so for any period spanning the rebuild it counted
    // the old history AND the transfer, and disagreed with the Trial Balance
    // by construction. Not a rounding difference: a doubled account.
    const books = glBoundaries.inTheBooksSql('j');
    let where = books.sql;
    const params = [...books.params];
    if (startDate) { where += ' AND DATE(j.journal_date) >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(endDate); }
    // `canonicalForEntries` degrades to the raw account when the map table is
    // absent — a database that never ran 0036 has nothing to remap. Joining it
    // unconditionally raised "Table … doesn't exist", and this route's outer
    // catch turned that into an empty 200: an income statement reading as "no
    // activity at all". Caught live, not by a test.
    const canon = await glBoundaries.canonicalForEntries(db, 'e', 'coa_map');
    const [entries] = await db.query(
      `SELECT ${canon.account} AS account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       ${canon.join}
       WHERE ${where} GROUP BY ${canon.account}`, params
    );
    const balMap = {};
    entries.forEach(e => { balMap[e.account_id] = (Number(e.c)||0) - (Number(e.d)||0); }); // credit-positive for revenue

    // v5.10.61 — `Math.abs(net)` used to destroy signs, so an account with an
    // abnormal balance (e.g. refunds > sales) appeared positive. The
    // normal-balance calculation below PRESERVES sign so the user can spot
    // anomalies in the report.
    const buckets = {
      revenue:      { items: [], total: 0 },
      otherIncome:  { items: [], total: 0 },
      cogs:         { items: [], total: 0 },
      opex:         { items: [], total: 0 },
      gAndA:        { items: [], total: 0 },
      otherExpense: { items: [], total: 0 },
    };
    const unmapped = [];

    accounts.forEach(a => {
      if (a.type !== 'revenue' && a.type !== 'expense') return;
      const net = balMap[a.id] || 0;   // balMap is credit-positive (c - d)
      const hasMovement = Math.abs(net) >= 0.001;
      // Archived accounts appear only for the periods they actually moved in.
      if (!classify.isReportable(a, hasMovement)) return;

      // PACKAGE G — normal-balance display amount from the STORED column
      // (type only as a flagged fallback):
      //   credit-normal (revenue): net (positive when c > d) is correct as-is.
      //   debit-normal  (expense): -net makes the amount appear positive.
      const nb = classify.normalBalanceOf(a);
      const bal = (nb.normalBalance === 'credit') ? net : -net;
      const item = { id: a.id, code: a.code, name: a.name_ar, balance: bal, level: a.level };

      const cls = classify.incomeBucketOf(a);
      if (cls.unmapped || !cls.bucket) {
        unmapped.push(classify.unmappedRow(a, cls, { bucket: cls.bucket || null, balance: bal }));
      }
      const target = buckets[cls.bucket] || buckets.opex;   // unknown → safest bucket
      target.items.push(item);
      target.total += bal;
    });

    const totalRevenue  = buckets.revenue.total;
    const totalOtherInc = buckets.otherIncome.total;
    const totalCOGS     = buckets.cogs.total;
    const totalOpex     = buckets.opex.total;
    const totalGAndA    = buckets.gAndA.total;
    const totalOtherExp = buckets.otherExpense.total;

    const grossProfit = totalRevenue - totalCOGS;
    const operatingIncome = grossProfit - totalOpex - totalGAndA;
    const netIncome = operatingIncome + totalOtherInc - totalOtherExp;

    res.json({
      // IFRS sections
      revenue: buckets.revenue.items, totalRevenue,
      cogs: buckets.cogs.items, totalCOGS,
      grossProfit,
      opex: buckets.opex.items, totalOpex,
      gAndA: buckets.gAndA.items, totalGAndA,   // v5.10.61 — G&A separated from OpEx
      operatingIncome,
      otherIncome: buckets.otherIncome.items, totalOtherInc,
      otherExpense: buckets.otherExpense.items, totalOtherExp,
      netIncome,
      // PACKAGE G — accounts bucketed from a code-prefix guess, not stored data.
      unmapped,
      sectionCatalogGaps: classify.catalogGaps(),
      period: { startDate: startDate || null, endDate: endDate || null }
    });
  } catch (e) {
    console.error('[erp/reports/income]', req.requestId || '-', (e && e.stack) || e);
    res.json({ revenue:[], cogs:[], opex:[], gAndA:[], otherIncome:[], otherExpense:[], unmapped:[],
      totalRevenue:0, totalCOGS:0, grossProfit:0, totalOpex:0, totalGAndA:0, operatingIncome:0,
      totalOtherInc:0, totalOtherExp:0, netIncome:0, degraded: true });
  }
});

module.exports = router;
