/**
 * routes/erp/reports/ar-aging.js — A/R Aging report.
 *
 * GET /api/erp/reports/ar-aging?asOfDate=YYYY-MM-DD&brandId=&branchId=
 *
 * Buckets every open receivable by days outstanding:
 *   0-30 / 31-60 / 61-90 / 91-120 / 120+
 *
 * Strategy:
 *   1. Read the AR subledger (`ar_documents`) — one row per invoice and credit
 *      note, `balance_amount` already net of everything applied to it.
 *   2. Age each row by its DUE DATE, falling back to the issue date only when
 *      no terms were recorded — and count how often that fallback was needed.
 *   3. Report a reconciliation against the receivables control account, so the
 *      ageing total and the balance sheet can be compared rather than assumed
 *      to agree.
 *
 * The previous strategy is described at the query below, along with why each
 * part of it moved money. In short: it reconstructed the receivable from POS
 * orders by free-text-matching `payment_method`, aged by ORDER date, and had no
 * link to the ledger at all.
 *
 * v6.2.0 — Wave F.1 · rewritten onto the subledger
 */

const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const glBoundaries = require('../../../lib/reports/glBoundaries');
const RE = require('../../../lib/reportErrors');

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
  return Math.max(0, Math.floor((bMs - aMs) / 86400000));
}

router.get('/reports/ar-aging', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const asOfDate = req.query.asOfDate || new Date().toISOString().slice(0, 10);
    const brandId = req.query.brandId || '';
    const branchId = req.query.branchId || '';

    // ── 1. The AR document ledger ────────────────────────────────────────
    //
    // WHAT THIS REPLACED, AND WHY
    //   The receivable used to be reconstructed from the POS order table by
    //   GUESSING which orders were on credit, with a free-text match:
    //
    //       LOWER(payment_method) LIKE '%kita%' OR LIKE '%credit%'
    //         OR LIKE '%ذمم%' OR LIKE '%آجل%' OR = 'Split' OR = 'Other'
    //
    //   Three things were wrong with that, and each one moves money:
    //
    //     · IT GUESSED. `payment_method` is free text written by a cashier UI.
    //       A credit sale spelled any other way was invisible to the ageing;
    //       an ordinary 'Other' sale was counted as a receivable that nobody
    //       owed. The set of debts was decided by string matching.
    //
    //     · IT AGED BY ORDER DATE. The spec, and ordinary practice, age by WHEN
    //       THE MONEY FELL DUE. An invoice on 30-day terms was already reported
    //       31 days overdue the day after it was raised.
    //
    //     · IT COULD NOT TIE TO THE LEDGER. Nothing linked those rows to the
    //       receivables control account, so the spec's acceptance criterion —
    //       ageing total = the AR balance on the balance sheet — was not merely
    //       unmet, it was uncheckable.
    //
    //   `ar_documents` is the receivables subledger: one row per invoice and
    //   credit note, with `balance_amount` already net of everything applied to
    //   it, a `due_date`, and `gl_journal_id` back to the posting. No guessing.
    let saleQuery = `
      SELECT d.id, d.document_number, d.document_type,
             d.issue_date, d.due_date,
             d.total_amount, d.paid_amount, d.balance_amount,
             d.customer_id, d.customer_name, d.gl_journal_id,
             c.phone AS customer_phone
      FROM ar_documents d
      LEFT JOIN customers c ON c.id = d.customer_id
      WHERE DATE(d.issue_date) <= ?
        AND COALESCE(d.status, '') NOT IN ('cancelled', 'reversed', 'draft')
        AND COALESCE(d.balance_amount, 0) <> 0`;
    const params = [asOfDate];
    if (brandId)  { saleQuery += ' AND d.brand_id = ?';  params.push(brandId); }
    if (branchId) { saleQuery += ' AND d.branch_id = ?'; params.push(branchId); }
    saleQuery += ' ORDER BY d.issue_date ASC';

    const [sales] = await db.query(saleQuery, params);

    // ── 2. No payment pass ───────────────────────────────────────────────
    // `ar_documents.balance_amount` is maintained net of every receipt and
    // allocation applied to the document. The old code subtracted
    // `customer_payments` itself because it was reading gross order totals;
    // doing that here would deduct the same money twice.
    // (The `customer_payments` query that used to live here is gone with the
    // gross-order source it existed to correct.)

    // ── 3. Bucket ────────────────────────────────────────────────────────────
    const customerMap = {};   // customerId → { name, phone, buckets: {...}, total, invoices: [] }
    let grandTotal = 0;
    const grandBuckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 };

    // How many rows had to fall back to the issue date because no due date
    // was recorded. Reported, not hidden: an ageing computed on a different
    // basis than the reader assumes is an ageing they will act on wrongly.
    let agedByIssueDate = 0;

    sales.forEach(s => {
      // A credit note carries a NEGATIVE receivable and must reduce the
      // customer's balance, so the sign is kept rather than floored at zero.
      const sign = s.document_type === 'credit_note' ? -1 : 1;
      const total = sign * (Number(s.total_amount) || 0);
      const paid = Number(s.paid_amount) || 0;
      const outstanding = sign * (Number(s.balance_amount) || 0);
      if (Math.abs(outstanding) <= 0.001) return;

      // AGE BY WHEN IT FELL DUE — the spec's rule and ordinary practice.
      // Falling back to the issue date is the honest answer when no terms were
      // recorded, and it is counted so the response can say how often.
      const ageFrom = s.due_date || s.issue_date;
      if (!s.due_date) agedByIssueDate += 1;
      const days = _daysBetween(ageFrom, asOfDate);
      const b = _bucket(days);
      if (!customerMap[s.customer_id]) {
        customerMap[s.customer_id] = {
          customerId: s.customer_id,
          customerName: s.customer_name || '—',
          customerPhone: s.customer_phone || '',
          total: 0,
          buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 },
          invoices: []
        };
      }
      customerMap[s.customer_id].buckets[b] += outstanding;
      customerMap[s.customer_id].total += outstanding;
      customerMap[s.customer_id].invoices.push({
        invoiceId: s.id,
        reference: s.document_number,
        documentType: s.document_type,
        issueDate: s.issue_date,
        dueDate: s.due_date || null,
        /** Which date the age was measured from — never left to be inferred. */
        agedFrom: s.due_date ? 'due_date' : 'issue_date',
        ageDays: days,
        bucket: b,
        totalFinal: total,
        paid,
        outstanding,
        glJournalId: s.gl_journal_id || null
      });
      grandBuckets[b] += outstanding;
      grandTotal += outstanding;
    });

    const customers = Object.values(customerMap).sort((a, b) => b.total - a.total);

    // ── The reconciliation the spec asks for ─────────────────────────────────
    // "إجمالي تقادم المدينين = رصيد حساب العملاء في المركز المالي".
    //
    // That criterion was previously UNCHECKABLE: the ageing was reconstructed
    // from POS orders and had no relationship to the control account at all.
    // Now both sides can be stated, so a difference is visible instead of
    // merely existing.
    //
    // The GL side is reported, never used to adjust the ageing. If the two
    // disagree, the honest output is two numbers and a difference — silently
    // scaling one to match the other would hide the very break this exists to
    // reveal.
    let reconciliation = null;
    try {
      const canon = await glBoundaries.canonicalForEntries(db, 'e', 'coa_map');
      const books = glBoundaries.inTheBooksSql('j');
      // Per ACCOUNT, not one lump sum. A bare "difference: −2,360" sends someone
      // hunting through the whole chart; naming the accounts that make up the
      // control side turns the break into a diagnosis.
      //
      // This is not hypothetical. The first live run of this reconciliation
      // reported a 2,360 difference whose entire balance was account 1120
      // «البنوك» — the BANK account, carrying `report_section = 'receivables'`.
      // The ageing was right and the classification was wrong, and only the
      // per-account breakdown made that visible in one glance.
      const [glRows] = await db.query(
        `SELECT a.code, a.name_ar AS name,
                ROUND(SUM(e.debit - e.credit), 2) AS bal
           FROM gl_entries e
           JOIN gl_journals j ON j.id = e.journal_id
           ${canon.join}
           JOIN gl_accounts a ON a.id = ${canon.account}
          WHERE ${books.sql}
            AND DATE(j.journal_date) <= ?
            AND a.report_section = 'receivables'
            AND a.type = 'asset'
          GROUP BY a.code, a.name_ar
         HAVING bal <> 0
          ORDER BY ABS(bal) DESC`,
        [...books.params, asOfDate]
      );
      const accounts = glRows.map((r) => ({
        code: r.code, name: r.name, balance: Number(r.bal) || 0,
      }));
      const glBalance = Math.round(
        accounts.reduce((sum, a) => sum + a.balance, 0) * 100
      ) / 100;
      const aged = Math.round(grandTotal * 100) / 100;
      reconciliation = {
        agingTotal: aged,
        glControlBalance: glBalance,
        difference: Math.round((aged - glBalance) * 100) / 100,
        isReconciled: Math.abs(aged - glBalance) < 1,
        /** Which accounts the control side is made of — the diagnosis. */
        accounts,
        note: 'GL side = posted entries on accounts classified `receivables`.',
      };
    } catch (e) {
      // Report the absence rather than a false "reconciled".
      console.warn('[ar-aging] reconciliation unavailable:', e.message);
      reconciliation = null;
    }

    res.json({
      success: true,
      asOfDate,
      /** What the age was measured from, and how often terms were missing. */
      basis: {
        source: 'ar_documents',
        agedBy: 'due_date',
        fallback: 'issue_date',
        rowsAgedByIssueDate: agedByIssueDate,
      },
      reconciliation,
      customers,
      grandTotal: Math.round(grandTotal * 100) / 100,
      grandBuckets: {
        '0-30':   Math.round(grandBuckets['0-30']   * 100) / 100,
        '31-60':  Math.round(grandBuckets['31-60']  * 100) / 100,
        '61-90':  Math.round(grandBuckets['61-90']  * 100) / 100,
        '91-120': Math.round(grandBuckets['91-120'] * 100) / 100,
        '120+':   Math.round(grandBuckets['120+']   * 100) / 100
      },
      topDebtor: customers[0] || null,
      overdue90PlusRatio: grandTotal > 0
        ? Math.round(((grandBuckets['91-120'] + grandBuckets['120+']) / grandTotal) * 10000) / 100
        : 0
    });
  } catch (e) {
    return RE.sendReportError(res, e, 'erp/reports/ar-aging', req);
  }
});

module.exports = router;
