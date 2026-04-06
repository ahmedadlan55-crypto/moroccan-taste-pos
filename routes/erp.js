const router = require('express').Router();
const db = require('../db/connection');

// ─── Dashboard ───

router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Today's sales
    const [salesToday] = await db.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(total_final),0) as total FROM sales WHERE DATE(order_date) = ?', [today]
    );

    // Today's expenses
    const [expensesToday] = await db.query(
      'SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE DATE(expense_date) = ?', [today]
    );

    // Today's purchases
    const [purchasesToday] = await db.query(
      'SELECT COALESCE(SUM(total_price),0) as total FROM purchases WHERE DATE(purchase_date) = ?', [today]
    );

    // Low stock items
    const [lowStock] = await db.query(
      'SELECT COUNT(*) as count FROM inv_items WHERE stock <= min_stock AND active = 1'
    );

    // Active customers
    const [customerCount] = await db.query('SELECT COUNT(*) as count FROM customers WHERE is_active = 1');

    // Active suppliers
    const [supplierCount] = await db.query('SELECT COUNT(*) as count FROM suppliers WHERE is_active = 1');

    // Open shifts
    const [openShifts] = await db.query('SELECT COUNT(*) as count FROM shifts WHERE status = "OPEN"');

    // Monthly sales (last 30 days)
    const [monthlySales] = await db.query(
      'SELECT COALESCE(SUM(total_final),0) as total FROM sales WHERE order_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );

    // Monthly expenses (last 30 days)
    const [monthlyExpenses] = await db.query(
      'SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE expense_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );

    res.json({
      salesToday: { count: salesToday[0].count, total: Number(salesToday[0].total) },
      expensesToday: Number(expensesToday[0].total),
      purchasesToday: Number(purchasesToday[0].total),
      lowStockCount: lowStock[0].count,
      customerCount: customerCount[0].count,
      supplierCount: supplierCount[0].count,
      openShifts: openShifts[0].count,
      monthlySales: Number(monthlySales[0].total),
      monthlyExpenses: Number(monthlyExpenses[0].total),
      monthlyProfit: Number(monthlySales[0].total) - Number(monthlyExpenses[0].total)
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ─── Customers ───

router.get('/customers', async (req, res) => {
  try {
    const activeOnly = req.query.activeOnly !== 'false';
    let query = 'SELECT * FROM customers';
    if (activeOnly) query += ' WHERE is_active = 1';
    query += ' ORDER BY name';

    const [rows] = await db.query(query);
    res.json(rows.map(c => ({
      id: c.id, name: c.name, nameEn: c.name_en, vatNumber: c.vat_number,
      phone: c.phone, email: c.email, address: c.address, city: c.city,
      customerType: c.customer_type, creditLimit: Number(c.credit_limit),
      balance: Number(c.balance), isActive: c.is_active,
      createdAt: c.created_at, createdBy: c.created_by
    })));
  } catch (e) {
    res.json([]);
  }
});

router.post('/customers', async (req, res) => {
  try {
    const { id, name, nameEn, vatNumber, phone, email, address, city, customerType, creditLimit, username } = req.body;

    if (id) {
      const [existing] = await db.query('SELECT id FROM customers WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE customers SET name=?, name_en=?, vat_number=?, phone=?, email=?, address=?, city=?, customer_type=?, credit_limit=?, updated_by=? WHERE id=?`,
          [name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
           customerType || 'B2C', creditLimit || 0, username || '', id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'CUST-' + Date.now();
    await db.query(
      `INSERT INTO customers (id, name, name_en, vat_number, phone, email, address, city, customer_type, credit_limit, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
       customerType || 'B2C', creditLimit || 0, username || '']
    );

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Deactivate customer (soft delete)
router.delete('/customers/:id', async (req, res) => {
  try {
    await db.query('UPDATE customers SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Suppliers ───

router.get('/suppliers', async (req, res) => {
  try {
    const activeOnly = req.query.activeOnly !== 'false';
    let query = 'SELECT * FROM suppliers';
    if (activeOnly) query += ' WHERE is_active = 1';
    query += ' ORDER BY name';

    const [rows] = await db.query(query);
    res.json(rows.map(s => ({
      id: s.id, name: s.name, nameEn: s.name_en, vatNumber: s.vat_number,
      phone: s.phone, email: s.email, address: s.address, city: s.city,
      paymentTerms: s.payment_terms, balance: Number(s.balance), isActive: s.is_active,
      createdAt: s.created_at, createdBy: s.created_by
    })));
  } catch (e) {
    res.json([]);
  }
});

router.post('/suppliers', async (req, res) => {
  try {
    const { id, name, nameEn, vatNumber, phone, email, address, city, paymentTerms, username } = req.body;

    if (id) {
      const [existing] = await db.query('SELECT id FROM suppliers WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE suppliers SET name=?, name_en=?, vat_number=?, phone=?, email=?, address=?, city=?, payment_terms=?, updated_by=? WHERE id=?`,
          [name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
           paymentTerms || 'Cash', username || '', id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'SUP-' + Date.now();
    await db.query(
      `INSERT INTO suppliers (id, name, name_en, vat_number, phone, email, address, city, payment_terms, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
       paymentTerms || 'Cash', username || '']
    );

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete supplier
router.delete('/suppliers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── GL Accounts (Chart of Accounts) ───

router.get('/gl/accounts', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM gl_accounts ORDER BY code');
    res.json(rows.map(a => ({
      id: a.id, code: a.code, nameAr: a.name_ar, nameEn: a.name_en,
      type: a.type, parentId: a.parent_id, level: a.level,
      isActive: a.is_active, balance: Number(a.balance)
    })));
  } catch (e) {
    res.json([]);
  }
});

router.post('/gl/accounts', async (req, res) => {
  try {
    const { id, code, nameAr, nameEn, type, parentId, level } = req.body;

    if (id) {
      const [existing] = await db.query('SELECT id FROM gl_accounts WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          'UPDATE gl_accounts SET code=?, name_ar=?, name_en=?, type=?, parent_id=?, level=? WHERE id=?',
          [code, nameAr, nameEn || '', type, parentId || null, level || 1, id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'GL-' + Date.now();
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level) VALUES (?,?,?,?,?,?,?)',
      [newId, code, nameAr, nameEn || '', type, parentId || null, level || 1]
    );

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── GL Journals ───

router.get('/gl/journals', async (req, res) => {
  try {
    let query = 'SELECT * FROM gl_journals WHERE 1=1';
    const params = [];

    if (req.query.startDate) { query += ' AND journal_date >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND journal_date <= ?'; params.push(req.query.endDate); }
    if (req.query.referenceType) { query += ' AND reference_type = ?'; params.push(req.query.referenceType); }
    if (req.query.status) { query += ' AND status = ?'; params.push(req.query.status); }

    query += ' ORDER BY journal_date DESC, created_at DESC LIMIT 500';

    const [journals] = await db.query(query, params);
    const result = [];

    for (const j of journals) {
      const [entries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ?', [j.id]);
      result.push({
        id: j.id, journalNumber: j.journal_number, journalDate: j.journal_date,
        referenceType: j.reference_type, referenceId: j.reference_id,
        description: j.description,
        totalDebit: Number(j.total_debit), totalCredit: Number(j.total_credit),
        periodId: j.period_id, status: j.status, createdBy: j.created_by,
        entries: entries.map(e => ({
          id: e.id, accountId: e.account_id, accountCode: e.account_code,
          accountName: e.account_name, debit: Number(e.debit), credit: Number(e.credit),
          description: e.description
        }))
      });
    }

    res.json(result);
  } catch (e) {
    res.json([]);
  }
});

// Create journal entry
router.post('/gl/journals', async (req, res) => {
  try {
    const { journalDate, referenceType, referenceId, description, entries, username } = req.body;
    const journalId = 'JRN-' + Date.now();

    // Auto-generate journal number
    const [lastJ] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
    let nextNum = 1;
    if (lastJ.length && lastJ[0].journal_number) {
      const match = lastJ[0].journal_number.match(/(\d+)/);
      if (match) nextNum = parseInt(match[1]) + 1;
    }
    const journalNumber = 'JV-' + String(nextNum).padStart(6, '0');

    // Calculate totals
    let totalDebit = 0;
    let totalCredit = 0;
    if (entries && entries.length) {
      for (const entry of entries) {
        totalDebit += Number(entry.debit) || 0;
        totalCredit += Number(entry.credit) || 0;
      }
    }

    // Validate balanced entry
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.json({ success: false, error: 'Journal entry is not balanced (debit != credit)' });
    }

    await db.query(
      `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [journalId, journalNumber, journalDate || new Date(), referenceType || '', referenceId || '',
       description || '', totalDebit, totalCredit, 'posted', username || '']
    );

    // Insert entries and update account balances
    if (entries && entries.length) {
      for (const entry of entries) {
        const entryId = 'GLE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description)
           VALUES (?,?,?,?,?,?,?,?)`,
          [entryId, journalId, entry.accountId || null, entry.accountCode || '',
           entry.accountName || '', entry.debit || 0, entry.credit || 0, entry.description || '']
        );

        // Update account balance
        if (entry.accountId) {
          const netAmount = (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
          await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [netAmount, entry.accountId]);
        }
      }
    }

    res.json({ success: true, id: journalId, journalNumber });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── VAT ───

// Get VAT transactions for period
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

// Post VAT journals
router.post('/vat/post', async (req, res) => {
  try {
    const { periodStart, periodEnd, outputVat, inputVat, netVat, username } = req.body;
    const reportId = 'VAT-' + Date.now();

    await db.query(
      `INSERT INTO vat_reports (id, period_start, period_end, total_output_vat, total_input_vat, net_vat, status, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [reportId, periodStart, periodEnd, outputVat || 0, inputVat || 0, netVat || 0, 'draft', username || '']
    );

    res.json({ success: true, id: reportId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
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
