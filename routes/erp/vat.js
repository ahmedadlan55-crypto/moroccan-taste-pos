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
const { nextFlatJournalNumber } = require('../../lib/glPosting'); // FC-B1 atomic JV numbering

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

    // Create VAT report
    const reportId = 'VAT-' + Date.now();
    await db.query(
      `INSERT INTO vat_reports (id, period_start, period_end, total_output_vat, total_input_vat, net_vat, status, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [reportId, periodStart, periodEnd, outputVat, inputVat, netVat, 'submitted', username || '']
    );

    // Create GL journal entry for VAT
    // Find VAT GL accounts
    let outputVatAccId = null, inputVatAccId = null;
    const [outAcc] = await db.query("SELECT id FROM gl_accounts WHERE code = '21301' OR (name_ar LIKE '%ضريبة%مخرجات%' AND type='liability') ORDER BY code LIMIT 1");
    if (outAcc.length) outputVatAccId = outAcc[0].id;
    else {
      // Try generic VAT account
      const [genAcc] = await db.query("SELECT id FROM gl_accounts WHERE code LIKE '213%' AND type='liability' ORDER BY code LIMIT 1");
      if (genAcc.length) outputVatAccId = genAcc[0].id;
    }

    // Ensure input VAT account exists (1430 or create under 113)
    const [inAcc] = await db.query("SELECT id FROM gl_accounts WHERE code = '1430' OR (name_ar LIKE '%ضريبة%مدخلات%' AND type='asset') ORDER BY code LIMIT 1");
    if (inAcc.length) inputVatAccId = inAcc[0].id;
    else {
      // Auto-create input VAT account
      const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '113' OR code = '11' ORDER BY code DESC LIMIT 1");
      inputVatAccId = 'GL-1430';
      await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
        [inputVatAccId, '1430', 'ضريبة المدخلات', 'asset', p11.length ? p11[0].id : null, 4]);
    }

    let journalNumber = '';
    if (outputVatAccId || inputVatAccId) {
      const jrnId = 'JRN-VAT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); // FC-B1 unique under concurrency
      journalNumber = await nextFlatJournalNumber(); // FC-B1 atomic (was created_at DESC race)
      const desc = 'تسوية ضريبة القيمة المضافة — ' + periodStart + ' إلى ' + periodEnd;
      const now = new Date();

      await db.query(
        `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by, posted_by, posted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [jrnId, journalNumber, now, 'vat_settlement', reportId, desc,
         Math.abs(netVat), Math.abs(netVat), 'posted', username||'', username||'', now]
      );

      if (netVat > 0 && outputVatAccId) {
        // Net VAT payable: Debit output VAT (reduce liability), Credit cash/payable
        const gle1 = 'GLE-VAT-' + Date.now() + '-1';
        await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
          [gle1, jrnId, outputVatAccId, '21301', 'ضريبة المخرجات', outputVat, 0, 'ضريبة مخرجات — ' + periodStart]);
        await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [outputVat, outputVatAccId]);

        if (inputVatAccId && inputVat > 0) {
          const gle2 = 'GLE-VAT-' + Date.now() + '-2';
          await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
            [gle2, jrnId, inputVatAccId, '1430', 'ضريبة المدخلات', 0, inputVat, 'ضريبة مدخلات — ' + periodStart]);
          await db.query('UPDATE gl_accounts SET balance = balance - ? WHERE id = ?', [inputVat, inputVatAccId]);
        }
      } else if (inputVatAccId && inputVat > 0) {
        const gle1 = 'GLE-VAT-' + Date.now() + '-1';
        await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
          [gle1, jrnId, inputVatAccId, '1430', 'ضريبة المدخلات', inputVat, 0, 'ضريبة مدخلات — ' + periodStart]);
        await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [inputVat, inputVatAccId]);
      }
    }

    res.json({ success: true, id: reportId, journalNumber, outputVat, inputVat, netVat });
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
