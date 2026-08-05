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

router.get('/vat/transactions', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.json({ error: 'startDate and endDate required' });

    // Output VAT (from sales)
    const [sales] = await db.query(
      'SELECT id, order_date, total_final, payment_method FROM sales WHERE DATE(order_date) >= ? AND DATE(order_date) <= ?',
      [startDate, endDate]
    );

    // Get VAT rate from settings
    const [settings] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'VATRate'");
    const vatRate = settings.length ? Number(settings[0].setting_value) : 15;

    let totalOutputVat = 0;
    const outputTransactions = sales.map(s => {
      const total = Number(s.total_final);
      const vatAmount = total - (total / (1 + vatRate / 100));
      totalOutputVat += vatAmount;
      return { id: s.id, date: s.order_date, type: 'output', total, vatAmount, source: 'sale' };
    });

    // Input VAT (from purchases)
    const [purchases] = await db.query(
      'SELECT id, purchase_date, total_price FROM purchases WHERE DATE(purchase_date) >= ? AND DATE(purchase_date) <= ? AND status = "received"',
      [startDate, endDate]
    );

    let totalInputVat = 0;
    const inputTransactions = purchases.map(p => {
      const total = Number(p.total_price);
      const vatAmount = total - (total / (1 + vatRate / 100));
      totalInputVat += vatAmount;
      return { id: p.id, date: p.purchase_date, type: 'input', total, vatAmount, source: 'purchase' };
    });

    res.json({
      vatRate,
      outputVat: totalOutputVat,
      inputVat: totalInputVat,
      netVat: totalOutputVat - totalInputVat,
      transactions: [...outputTransactions, ...inputTransactions]
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Post VAT journals — creates GL entries + vat_report
router.post('/vat/post', async (req, res) => {
  try {
    const { periodStart, periodEnd, username } = req.body;
    if (!periodStart || !periodEnd) return res.json({ success: false, error: 'حدد الفترة' });

    // Recalculate VAT from actual data
    const [vatSettings] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'VATRate'");
    const vatRate = vatSettings.length ? Number(vatSettings[0].setting_value) : 15;

    const [sales] = await db.query('SELECT SUM(total_final) AS total FROM sales WHERE DATE(order_date) >= ? AND DATE(order_date) <= ?', [periodStart, periodEnd]);
    const salesTotal = Number(sales[0].total) || 0;
    const outputVat = salesTotal - (salesTotal / (1 + vatRate / 100));

    const [purchases] = await db.query('SELECT SUM(total_price) AS total FROM purchases WHERE DATE(purchase_date) >= ? AND DATE(purchase_date) <= ? AND status = "received"', [periodStart, periodEnd]);
    const purchaseTotal = Number(purchases[0].total) || 0;
    const inputVat = purchaseTotal - (purchaseTotal / (1 + vatRate / 100));

    const netVat = outputVat - inputVat;

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
