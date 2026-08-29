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
const RE = require('../../../lib/reportErrors');

router.get('/reports/income', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { startDate, endDate, compareStart, compareEnd } = req.query;
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
    //
    // `canonicalForEntries` degrades to the raw account when the map table is
    // absent — a database that never ran 0036 has nothing to remap. Joining it
    // unconditionally raised "Table … doesn't exist", and this route's outer
    // catch turned that into an empty 200: an income statement reading as "no
    // activity at all". Caught live, not by a test.
    const canon = await glBoundaries.canonicalForEntries(db, 'e', 'coa_map');

    // One aggregate, run once per column. Extracted so the comparison period
    // CANNOT be computed on a different basis than the period it is compared
    // against — the failure that makes a comparison column worse than none.
    async function netByAccount(rangeStart, rangeEnd) {
      const books = glBoundaries.inTheBooksSql('j');
      let clause = books.sql;
      const args = [...books.params];
      if (rangeStart) { clause += ' AND DATE(j.journal_date) >= ?'; args.push(rangeStart); }
      if (rangeEnd)   { clause += ' AND DATE(j.journal_date) <= ?'; args.push(rangeEnd); }
      const [rows] = await db.query(
        `SELECT ${canon.account} AS account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
         FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
         ${canon.join}
         WHERE ${clause} GROUP BY ${canon.account}`, args
      );
      const map = {};
      // credit-positive, so revenue reads naturally and expense reads negative.
      rows.forEach(r => { map[r.account_id] = (Number(r.c) || 0) - (Number(r.d) || 0); });
      return map;
    }

    const balMap = await netByAccount(startDate, endDate);

    // Comparison is OPT-IN and requires BOTH edges. A half-specified range would
    // silently become an unbounded one — every figure since the books opened,
    // presented beside a single month as if the two were comparable.
    const comparing = !!(compareStart && compareEnd);
    const priorMap = comparing ? await netByAccount(compareStart, compareEnd) : null;

    // v5.10.61 — `Math.abs(net)` used to destroy signs, so an account with an
    // abnormal balance (e.g. refunds > sales) appeared positive. The
    // normal-balance calculation below PRESERVES sign so the user can spot
    // anomalies in the report.
    const buckets = {
      revenue:      { items: [], total: 0, priorTotal: 0 },
      otherIncome:  { items: [], total: 0, priorTotal: 0 },
      cogs:         { items: [], total: 0, priorTotal: 0 },
      opex:         { items: [], total: 0, priorTotal: 0 },
      gAndA:        { items: [], total: 0, priorTotal: 0 },
      otherExpense: { items: [], total: 0, priorTotal: 0 },
    };
    const unmapped = [];

    accounts.forEach(a => {
      if (a.type !== 'revenue' && a.type !== 'expense') return;
      const net = balMap[a.id] || 0;   // balMap is credit-positive (c - d)
      const priorNet = comparing ? (priorMap[a.id] || 0) : 0;
      // An account that moved in EITHER column belongs in the statement. Judging
      // only the current period would drop a line that had activity last year
      // and none this year — and dropping it is exactly the change the reader
      // opened a comparison to see.
      const hasMovement = Math.abs(net) >= 0.001 || Math.abs(priorNet) >= 0.001;
      // Archived accounts appear only for the periods they actually moved in.
      if (!classify.isReportable(a, hasMovement)) return;

      // PACKAGE G — normal-balance display amount from the STORED column
      // (type only as a flagged fallback):
      //   credit-normal (revenue): net (positive when c > d) is correct as-is.
      //   debit-normal  (expense): -net makes the amount appear positive.
      const nb = classify.normalBalanceOf(a);
      const bal = (nb.normalBalance === 'credit') ? net : -net;
      // The prior column is flipped by the SAME rule — never a raw net beside a
      // normalised one, which would show an expense as negative in one column
      // and positive in the next.
      const priorBal = comparing ? ((nb.normalBalance === 'credit') ? priorNet : -priorNet) : null;
      const item = {
        id: a.id, code: a.code, name: a.name_ar, balance: bal, level: a.level,
        // null, not 0, when no comparison was asked for: an absent figure is
        // not a zero one, and a UI must be able to tell them apart.
        prior: priorBal,
      };

      const cls = classify.incomeBucketOf(a);
      if (cls.unmapped || !cls.bucket) {
        unmapped.push(classify.unmappedRow(a, cls, { bucket: cls.bucket || null, balance: bal }));
      }
      const target = buckets[cls.bucket] || buckets.opex;   // unknown → safest bucket
      target.items.push(item);
      target.total += bal;
      if (comparing) target.priorTotal += priorBal;
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

    // The prior column's derived figures come from the SAME three expressions.
    // Writing them out a second time by hand is how a comparison drifts: the
    // ladder must be one definition, applied twice.
    function ladder(rev, cogs, opex, gAndA, otherInc, otherExp) {
      const gross = rev - cogs;
      const operating = gross - opex - gAndA;
      return { gross, operating, net: operating + otherInc - otherExp };
    }
    const priorLadder = comparing
      ? ladder(
          buckets.revenue.priorTotal, buckets.cogs.priorTotal,
          buckets.opex.priorTotal, buckets.gAndA.priorTotal,
          buckets.otherIncome.priorTotal, buckets.otherExpense.priorTotal,
        )
      : null;

    // Proven, not assumed: the same ladder over the current period must
    // reproduce the figures computed above. If it ever does not, the two
    // definitions have drifted and the comparison column is lying.
    const selfCheck = ladder(
      totalRevenue, totalCOGS, totalOpex, totalGAndA, totalOtherInc, totalOtherExp,
    );
    if (Math.abs(selfCheck.net - netIncome) > 0.005) {
      console.error('[erp/reports/income] ladder drift', { selfCheck, netIncome });
    }

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
      // ── Comparison column (opt-in via compareStart + compareEnd) ──────────
      // `null` throughout when not requested — the client must be able to tell
      // "no comparison asked for" from "a comparison that came back zero".
      comparison: comparing ? {
        from: compareStart, to: compareEnd,
        totalRevenue:  buckets.revenue.priorTotal,
        totalCOGS:     buckets.cogs.priorTotal,
        totalOpex:     buckets.opex.priorTotal,
        totalGAndA:    buckets.gAndA.priorTotal,
        totalOtherInc: buckets.otherIncome.priorTotal,
        totalOtherExp: buckets.otherExpense.priorTotal,
        grossProfit:     priorLadder.gross,
        operatingIncome: priorLadder.operating,
        netIncome:       priorLadder.net,
      } : null,
      // PACKAGE G — accounts bucketed from a code-prefix guess, not stored data.
      unmapped,
      sectionCatalogGaps: classify.catalogGaps(),
      period: { startDate: startDate || null, endDate: endDate || null }
    });
  } catch (e) {
    // A zero-filled 200 here reads as "the company earned nothing". See
    // lib/reportErrors.js for why the flag that used to accompany it is not a
    // substitute for a status code.
    return RE.sendReportError(res, e, 'erp/reports/income', req);
  }
});

module.exports = router;
