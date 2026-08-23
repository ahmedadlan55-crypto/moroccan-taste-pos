/**
 * routes/erp/reports/ap-aging.js — A/P (Accounts Payable) Aging.
 *
 * GET /api/erp/reports/ap-aging?asOfDate=YYYY-MM-DD&brandId=&branchId=
 *
 * ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 *
 * This report read the LEGACY `purchases` table, selected rows by matching
 * free text in `payment_method` ('آجل' / 'credit'), and then looked for
 * payments in a table called `supplier_payments` — which **does not exist in
 * this repository at all**. That lookup sat in a bare `catch (_) {}`, so the
 * paid amount silently resolved to zero for every row.
 *
 * The result: every supplier appeared 100% unpaid, and the entire live V2
 * procurement ledger (`supplier_invoices` + `payment_allocations`) was
 * invisible to the report. It was not approximately wrong; it was reporting on
 * a subsystem the business had stopped using.
 *
 * ─── WHAT IT DOES NOW ───────────────────────────────────────────────────────
 *
 * Reads the same tables the procurement module and `v_supplier_ap_balance`
 * read, so the aging report, the supplier list and the AP balance can no
 * longer disagree — they are three views of one query shape.
 *
 * Ages by **DUE DATE**, not invoice date. "Overdue" is a statement about the
 * agreed terms; ageing a 90-day-terms invoice from its issue date reports a
 * supplier as 90 days late on the day the payment first becomes due.
 * `issue_date` is the fallback only when no terms were recorded.
 */

const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const glBoundaries = require('../../../lib/reports/glBoundaries');

const BUCKETS = ['0-30', '31-60', '61-90', '91-120', '120+'];

function _bucket(days) {
  if (days <= 30)  return '0-30';
  if (days <= 60)  return '31-60';
  if (days <= 90)  return '61-90';
  if (days <= 120) return '91-120';
  return '120+';
}

function _daysBetween(a, b) {
  const aMs = (a instanceof Date) ? a.getTime() : new Date(a).getTime();
  const bMs = (b instanceof Date) ? b.getTime() : new Date(b).getTime();
  if (isNaN(aMs) || isNaN(bMs)) return 0;
  return Math.max(0, Math.floor((bMs - aMs) / 86400000));
}

const emptyBuckets = () => BUCKETS.reduce((o, k) => { o[k] = 0; return o; }, {});
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

router.get('/reports/ap-aging', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    // Riyadh calendar date, not UTC — see lib/accountingDate.js. `toISOString()`
    // here reported yesterday's ageing for the first three hours of every day.
    const asOfDate = req.query.asOfDate || require('../../../lib/accountingDate').journalDate();

    const where = ["si.status NOT IN ('cancelled', 'draft')", 'DATE(si.issue_date) <= ?'];
    const args = [asOfDate];
    if (req.query.brandId)  { where.push('si.brand_id = ?');  args.push(req.query.brandId); }
    if (req.query.branchId) { where.push('si.branch_id = ?'); args.push(req.query.branchId); }

    // One query, mirroring v_supplier_ap_balance's allocation logic so the two
    // can never disagree. Allocations are bounded by asOfDate as well —
    // otherwise a back-dated report would net off payments that had not yet
    // happened on that date.
    //
    // COLLATE on both sides: these tables were created by different
    // migrations and do not reliably share a collation. Without it the JOIN
    // raises "Illegal mix of collations" on MySQL 8 — or, worse on some
    // configurations, matches nothing.
    const C = 'COLLATE utf8mb4_unicode_ci';
    let rows;
    try {
      [rows] = await db.query(
        `SELECT si.id, si.invoice_no, si.supplier_id, si.supplier_name,
                si.issue_date, si.due_date, si.total_amount,
                COALESCE(al.allocated, 0) AS allocated
           FROM supplier_invoices si
           LEFT JOIN (
             SELECT pa.supplier_invoice_id AS inv, SUM(pa.allocated_amount) AS allocated
               FROM payment_allocations pa
              WHERE pa.reversed = 0 AND DATE(pa.created_at) <= ?
              GROUP BY pa.supplier_invoice_id
           ) al ON al.inv ${C} = si.id ${C}
          WHERE ${where.join(' AND ')}
          ORDER BY si.issue_date ASC`,
        [asOfDate, ...args]);
    } catch (e) {
      // A genuinely absent procurement schema is a 503, NOT an empty report.
      // The previous version swallowed exactly this and answered 200 with a
      // clean-looking zero — the most expensive possible response, because it
      // is indistinguishable from "you owe nobody anything".
      if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR')) {
        return res.status(503).json({
          success: false, error: 'PROCUREMENT_SCHEMA_NOT_READY',
          message: 'دورة المشتريات غير مُهيّأة على هذه النسخة — لا يمكن حساب أعمار الذمم الدائنة',
        });
      }
      throw e;
    }

    const supplierMap = {};
    const grandBuckets = emptyBuckets();
    let grandTotal = 0;
    // How many invoices carried no terms and had to be aged from their issue
    // date. Counted and reported: an ageing computed on a different basis
    // than the reader assumes is one they will act on wrongly.
    let agedByIssueDate = 0;

    for (const r of rows) {
      const outstanding = round2((Number(r.total_amount) || 0) - (Number(r.allocated) || 0));
      if (outstanding <= 0.004) continue;

      // Age from the DUE date. Falling back to issue_date only when no terms
      // were recorded keeps a termless invoice visible rather than silently
      // ageing at zero.
      const ageFrom = r.due_date || r.issue_date;
      if (!r.due_date) agedByIssueDate += 1;
      const days = _daysBetween(ageFrom, asOfDate);
      const b = _bucket(days);

      const key = r.supplier_id || ('NAME:' + (r.supplier_name || 'UNKNOWN'));
      if (!supplierMap[key]) {
        supplierMap[key] = {
          supplierId: r.supplier_id || null,
          supplierName: r.supplier_name || '—',
          total: 0,
          buckets: emptyBuckets(),
          invoices: [],
        };
      }
      const s = supplierMap[key];
      s.total = round2(s.total + outstanding);
      s.buckets[b] = round2(s.buckets[b] + outstanding);
      s.invoices.push({
        id: r.id,
        invoiceNo: r.invoice_no || r.id,
        issueDate: r.issue_date,
        dueDate: r.due_date || null,
        total: round2(r.total_amount),
        paid: round2(r.allocated),
        outstanding,
        daysOverdue: days,
        bucket: b,
        /** Which date the age was measured from — never left to be inferred. */
        agedFrom: r.due_date ? 'due_date' : 'issue_date',
      });
      grandBuckets[b] = round2(grandBuckets[b] + outstanding);
      grandTotal = round2(grandTotal + outstanding);
    }

    const suppliers = Object.values(supplierMap).sort((a, b) => b.total - a.total);

    // ── The reconciliation the spec asks for ─────────────────────────────────
    // "إجمالي تقادم الدائنين = رصيد حساب الموردين". Reported, never used to
    // adjust the ageing: if the subledger and the ledger disagree, two numbers
    // and a difference is the honest output. Scaling one to match the other
    // would hide the break this exists to reveal.
    let reconciliation = null;
    try {
      const canon = await glBoundaries.canonicalForEntries(db, 'e', 'coa_map');
      const books = glBoundaries.inTheBooksSql('j');
      const [glRows] = await db.query(
        `SELECT a.code, a.name_ar AS name,
                ROUND(SUM(e.credit - e.debit), 2) AS bal
           FROM gl_entries e
           JOIN gl_journals j ON j.id = e.journal_id
           ${canon.join}
           JOIN gl_accounts a ON a.id = ${canon.account}
          WHERE ${books.sql}
            AND DATE(j.journal_date) <= ?
            AND a.report_section = 'payables'
            AND a.type = 'liability'
          GROUP BY a.code, a.name_ar
         HAVING bal <> 0
          ORDER BY ABS(bal) DESC`,
        [...books.params, asOfDate]
      );
      // Per-account, so a break names the accounts it came from rather than
            // leaving a bare number to be hunted down. The A/R side of this
            // reconciliation found the bank account classified as a receivable on
            // its very first live run; only the breakdown made that visible.
            const accounts = glRows.map((r) => ({ code: r.code, name: r.name, balance: Number(r.bal) || 0 }));
            const glBalance = round2(accounts.reduce((sum, a) => sum + a.balance, 0));
      reconciliation = {
        agingTotal: grandTotal,
        glControlBalance: glBalance,
        difference: round2(grandTotal - glBalance),
        isReconciled: Math.abs(grandTotal - glBalance) < 1,
        /** Which accounts the control side is made of — the diagnosis. */
        accounts,
        note: 'GL side = posted entries on accounts classified `payables`, credit-positive.',
      };
    } catch (e) {
      console.warn('[ap-aging] reconciliation unavailable:', e.message);
      reconciliation = null;
    }

    res.json({
      success: true,
      asOfDate,
      // Says which ledger answered. The old report silently reported on a
      // retired subsystem; naming the source makes that impossible to repeat.
      source: 'supplier_invoices',
      agedBy: 'due_date',
      /** How many invoices had no terms and were aged from their issue date. */
      rowsAgedByIssueDate: agedByIssueDate,
      reconciliation,
      suppliers,
      grandTotal,
      grandBuckets,
      topCreditor: suppliers[0] || null,
      overdue90PlusRatio: grandTotal > 0
        ? Math.round(((grandBuckets['91-120'] + grandBuckets['120+']) / grandTotal) * 10000) / 100
        : 0,
    });
  } catch (e) {
    console.error('[ap-aging]', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'ap_aging_failed' });
  }
});

module.exports = router;
