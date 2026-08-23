// ═══════════════════════════════════════════════════════════════════
// /api/erp/vat/* — Saudi VAT 15% reporting + posting
//
// Endpoints:
//   GET  /vat/transactions     — output (sales) + input (purchases) for a date range
//   POST /vat/post             — recompute the period, write a vat_reports row,
//                                and post the matching GL journal that debits
//                                output VAT and credits input VAT (auto-creates
//                                the input-VAT account under 113 if missing)
//   GET  /vat/reports          — list of submitted VAT reports
//   POST /vat/close-quarter    — mark a vat_reports row as submitted
//   POST /vat/close-year       — close all open accounting_periods for a year
//                                and lock every VAT report inside it
//
// VAT rate is read from settings.VATRate (defaults to 15).
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');
const glPosting = require('../../lib/glPosting');

/**
 * GET /api/erp/vat/transactions — the VAT return's working set.
 *
 * ─── WHAT THIS USED TO DO, AND WHY IT WAS WRONG ─────────────────────────────
 * It read one rate out of `settings.VATRate` and applied it to EVERY sale and
 * EVERY purchase:
 *
 *     vatAmount = total − total / (1 + rate/100)
 *
 * Three separate defects in one line:
 *
 *   1. IT TAXED THE UNTAXABLE. One rate for every document means a zero-rated
 *      export, an exempt sale and a standard-rated one all reported 15% VAT.
 *      The return's own box structure exists precisely because those are
 *      different — reporting them identically is not an approximation, it is a
 *      wrong filing.
 *
 *   2. IT IGNORED THE TAX THE SYSTEM HAD ALREADY RECORDED. Every AR document
 *      carries a stored `vat_amount`, and so does every supplier invoice. The
 *      figure was computed correctly at the time of the transaction, from that
 *      transaction's own rate, and then thrown away in favour of a re-derivation
 *      from a global constant.
 *
 *   3. IT READ THE WRONG LEDGER. `sales` is the POS order table; credit notes
 *      live in `ar_documents`. A refunded sale therefore stayed in the return at
 *      full value — output VAT overstated by the whole credit note.
 *
 * This project already forbids exactly this reasoning elsewhere: the analytics
 * engine has a standing audit (`scripts/audit/analytics-no-vat-constant.js`)
 * asserting that no metric derives VAT from a rate, because the stored column is
 * the only truthful source. The tax return itself was the one place still doing
 * it.
 *
 * ─── WHAT IT DOES NOW ───────────────────────────────────────────────────────
 * Sums the RECORDED tax:
 *   • output — `ar_documents.vat_amount`, with credit notes SIGNED NEGATIVE so a
 *     refund reduces the liability instead of inflating it;
 *   • input  — `supplier_invoices.vat_amount`.
 *
 * `vatRate` is still returned, because clients display it — but it is now
 * labelled for what it is: the configured default, used for NOTHING in this
 * calculation.
 */
router.get('/vat/transactions', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.json({ error: 'startDate and endDate required' });

    // Kept only so the UI can show the configured rate. NOT used to derive a
    // single riyal below — see the note above.
    const [settings] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'VATRate'");
    const configuredRate = settings.length ? Number(settings[0].setting_value) : 15;

    // ── Output VAT — the AR document ledger, credit notes signed ─────────────
    // `status` excludes documents that never became a tax point: a cancelled or
    // reversed invoice is not a supply.
    const [outRows] = await db.query(
      `SELECT id, document_number, document_type, issue_date,
              subtotal, vat_amount, total_amount, customer_name, zatca_status
         FROM ar_documents
        WHERE DATE(issue_date) >= ? AND DATE(issue_date) <= ?
          AND COALESCE(status, '') NOT IN ('cancelled', 'reversed', 'draft')
        ORDER BY issue_date ASC`,
      [startDate, endDate]
    );

    let totalOutputVat = 0;
    let outputTaxable = 0;
    const outputTransactions = outRows.map((r) => {
      // A credit note REDUCES the liability. Summing its VAT positively would
      // report a refund as though it were another sale.
      const sign = r.document_type === 'credit_note' ? -1 : 1;
      const vatAmount = sign * (Number(r.vat_amount) || 0);
      const taxable = sign * (Number(r.subtotal) || 0);
      totalOutputVat += vatAmount;
      outputTaxable += taxable;
      return {
        id: r.id, reference: r.document_number, date: r.issue_date,
        type: 'output', documentType: r.document_type,
        party: r.customer_name, taxable, vatAmount,
        total: sign * (Number(r.total_amount) || 0),
        zatcaStatus: r.zatca_status || null,
        source: 'ar_document',
      };
    });

    // ── Input VAT — the supplier-invoice subledger ───────────────────────────
    let inputTransactions = [];
    let totalInputVat = 0;
    let inputTaxable = 0;
    try {
      const [inRows] = await db.query(
        `SELECT id, invoice_no, issue_date, subtotal, vat_amount, total_amount,
                supplier_name, vat_number
           FROM supplier_invoices
          WHERE DATE(issue_date) >= ? AND DATE(issue_date) <= ?
            AND COALESCE(status, '') NOT IN ('cancelled', 'draft')
          ORDER BY issue_date ASC`,
        [startDate, endDate]
      );
      inputTransactions = inRows.map((r) => {
        const vatAmount = Number(r.vat_amount) || 0;
        const taxable = Number(r.subtotal) || 0;
        totalInputVat += vatAmount;
        inputTaxable += taxable;
        return {
          id: r.id, reference: r.invoice_no, date: r.issue_date,
          type: 'input', party: r.supplier_name, partyVatNumber: r.vat_number || null,
          taxable, vatAmount, total: Number(r.total_amount) || 0,
          source: 'supplier_invoice',
        };
      });
    } catch (e) {
      // The subledger is absent on an older deployment. Report the ABSENCE —
      // never a zero, which would read as "no purchases this period" and
      // understate the deductible tax.
      inputTransactions = [];
      totalInputVat = null;
      inputTaxable = null;
      console.warn('[erp/vat] supplier_invoices unavailable:', e.message);
    }

    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    res.json({
      /** The configured default rate. Displayed only — no figure is derived from it. */
      vatRate: configuredRate,
      basis: {
        output: 'ar_documents.vat_amount',
        input: inputTaxable === null ? 'unavailable' : 'supplier_invoices.vat_amount',
        derivedFromRate: false,
      },
      outputVat: r2(totalOutputVat),
      outputTaxable: r2(outputTaxable),
      inputVat: totalInputVat === null ? null : r2(totalInputVat),
      inputTaxable: inputTaxable === null ? null : r2(inputTaxable),
      netVat: totalInputVat === null ? null : r2(totalOutputVat - totalInputVat),
      transactions: [...outputTransactions, ...inputTransactions],
    });
  } catch (e) {
    console.error('[erp/vat] transactions failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Post VAT journals — creates GL entries + vat_report
router.post('/vat/post', async (req, res) => {
  try {
    const { periodStart, periodEnd, username } = req.body;
    if (!periodStart || !periodEnd) return res.json({ success: false, error: 'حدد الفترة' });

    // ── The settlement figures ───────────────────────────────────────────────
    // This handler POSTS A JOURNAL and writes a filed return, so its numbers end
    // up in the ledger and in front of ZATCA. It used to derive them the same
    // way the report did — one configured rate applied to a period's gross
    // sales and gross purchases — which means the wrong figure was not merely
    // displayed, it was POSTED.
    //
    // Now it sums the tax the system recorded, by the same rule as
    // GET /vat/transactions: `ar_documents.vat_amount` with credit notes signed
    // negative, and `supplier_invoices.vat_amount` for input.
    const [outAgg] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN document_type = 'credit_note'
                                THEN -vat_amount ELSE vat_amount END), 0) AS vat
         FROM ar_documents
        WHERE DATE(issue_date) >= ? AND DATE(issue_date) <= ?
          AND COALESCE(status, '') NOT IN ('cancelled', 'reversed', 'draft')`,
      [periodStart, periodEnd]
    );
    const outputVat = Math.round((Number(outAgg[0].vat) || 0) * 100) / 100;

    // An absent supplier subledger must ABORT, not settle at zero. Treating the
    // deductible tax as nil would post a liability for the full output VAT and
    // file a return claiming the company reclaimed nothing.
    let inputVat;
    try {
      const [inAgg] = await db.query(
        `SELECT COALESCE(SUM(vat_amount), 0) AS vat
           FROM supplier_invoices
          WHERE DATE(issue_date) >= ? AND DATE(issue_date) <= ?
            AND COALESCE(status, '') NOT IN ('cancelled', 'draft')`,
        [periodStart, periodEnd]
      );
      inputVat = Math.round((Number(inAgg[0].vat) || 0) * 100) / 100;
    } catch (e) {
      console.error('[erp/vat] cannot settle without the supplier subledger:', e.message);
      return res.status(409).json({
        success: false,
        code: 'INPUT_VAT_UNAVAILABLE',
        error: 'تعذّر قراءة ضريبة المدخلات — لا يمكن ترحيل تسوية الضريبة بدونها',
      });
    }

    const netVat = Math.round((outputVat - inputVat) * 100) / 100;

    const reportId = 'VAT-' + Date.now();
    const result = await db.withTransaction(async (conn) => {
      const entries = [];
      if (outputVat > 0) entries.push({ accountCode: glPosting.CORE_ACCOUNTS.OUTPUT_VAT.code, debit: outputVat, credit: 0 });
      if (inputVat > 0) entries.push({ accountCode: glPosting.CORE_ACCOUNTS.INPUT_VAT.code, debit: 0, credit: inputVat });
      if (netVat > 0) entries.push({ accountCode: '213200', debit: 0, credit: netVat });
      if (netVat < 0) entries.push({ accountCode: '115200', debit: Math.abs(netVat), credit: 0 });

      const posted = await glPosting.postJournal(conn, {
        journalDate: periodEnd,
        referenceType: 'vat_settlement',
        referenceId: reportId,
        description: 'تسوية ضريبة القيمة المضافة — ' + periodStart + ' إلى ' + periodEnd,
        postedBy: username || '',
        entries,
      });
      if (!posted.success) throw new Error(posted.error || 'تعذر ترحيل تسوية ضريبة القيمة المضافة');

      await conn.query(
        `INSERT INTO vat_reports (id, period_start, period_end, total_output_vat, total_input_vat, net_vat, status, created_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [reportId, periodStart, periodEnd, outputVat, inputVat, netVat, 'submitted', username || '']
      );
      return posted;
    });

    res.json({ success: true, id: reportId, journalNumber: result.journalNumber, outputVat, inputVat, netVat });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get VAT reports list
router.get('/vat/reports', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM vat_reports ORDER BY period_start DESC');
    res.json(rows.map(r => ({
      id: r.id, periodStart: r.period_start, periodEnd: r.period_end,
      totalOutputVat: Number(r.total_output_vat), totalInputVat: Number(r.total_input_vat),
      netVat: Number(r.net_vat), status: r.status, createdBy: r.created_by
    })));
  } catch(e) { res.json([]); }
});

// Close VAT quarter
router.post('/vat/close-quarter', async (req, res) => {
  try {
    const { reportId, username } = req.body;

    const [existing] = await db.query('SELECT * FROM vat_reports WHERE id = ?', [reportId]);
    if (!existing.length) return res.json({ success: false, error: 'VAT report not found' });

    await db.query('UPDATE vat_reports SET status = "submitted" WHERE id = ?', [reportId]);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Close financial year
router.post('/vat/close-year', async (req, res) => {
  try {
    const { year, username } = req.body;
    const periodId = 'FY-' + year;

    // Close all open periods for the year
    await db.query(
      `UPDATE accounting_periods SET status = 'closed', closed_by = ?, closed_at = NOW()
       WHERE YEAR(start_date) = ? AND status = 'open'`,
      [username || '', year]
    );

    // Close all VAT reports for the year
    await db.query(
      `UPDATE vat_reports SET status = 'closed'
       WHERE YEAR(period_start) = ? AND status != 'closed'`,
      [year]
    );

    res.json({ success: true, closedYear: year });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
