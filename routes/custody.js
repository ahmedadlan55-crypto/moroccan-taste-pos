/**
 * Custody Management (العهد) — complete CRUD + approval workflow + GL posting
 */
const router = require('express').Router();
const db = require('../db/connection');

// ═══════════════════════════════════════
// CUSTODY USERS (مسؤولو العهدة)
// ═══════════════════════════════════════

router.get('/users', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM custody_users ORDER BY name');
    res.json(rows.map(u => ({
      id: u.id, name: u.name, idNumber: u.id_number, phone: u.phone,
      jobTitle: u.job_title, notes: u.notes, isActive: u.is_active,
      linkedUsername: u.linked_username
    })));
  } catch (e) { res.json([]); }
});

router.post('/users', async (req, res) => {
  try {
    const { id, name, idNumber, phone, jobTitle, notes, linkedUsername } = req.body;
    if (!name) return res.json({ success: false, error: 'Name required' });
    if (id) {
      await db.query(
        'UPDATE custody_users SET name=?, id_number=?, phone=?, job_title=?, notes=?, linked_username=? WHERE id=?',
        [name, idNumber || '', phone || '', jobTitle || '', notes || '', linkedUsername || '', id]
      );
      return res.json({ success: true, id });
    }
    const newId = 'CU-' + Date.now();
    await db.query(
      'INSERT INTO custody_users (id, name, id_number, phone, job_title, notes, linked_username) VALUES (?,?,?,?,?,?,?)',
      [newId, name, idNumber || '', phone || '', jobTitle || '', notes || '', linkedUsername || '']
    );
    res.json({ success: true, id: newId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/users/:id/toggle', async (req, res) => {
  try {
    await db.query('UPDATE custody_users SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// CUSTODIES (العهد)
// ═══════════════════════════════════════

router.get('/list', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM custodies ORDER BY created_at DESC');
    res.json(rows.map(c => ({
      id: c.id, custodyNumber: c.custody_number, userId: c.user_id, userName: c.user_name,
      createdDate: c.created_date, balance: Number(c.balance), totalTopups: Number(c.total_topups),
      totalExpenses: Number(c.total_expenses), status: c.status, createdBy: c.created_by
    })));
  } catch (e) { res.json([]); }
});

router.post('/create', async (req, res) => {
  try {
    const { userId, userName, username } = req.body;
    if (!userId) return res.json({ success: false, error: 'Select a custody user' });
    const cusId = 'CUS-' + Date.now();
    // Auto-generate sequential custody number
    const [last] = await db.query('SELECT custody_number FROM custodies ORDER BY created_at DESC LIMIT 1');
    let nextNum = 1;
    if (last.length && last[0].custody_number) {
      const m = last[0].custody_number.match(/(\d+)/);
      if (m) nextNum = parseInt(m[1]) + 1;
    }
    const cusNumber = 'CUS-' + String(nextNum).padStart(5, '0');
    await db.query(
      'INSERT INTO custodies (id, custody_number, user_id, user_name, created_date, created_by) VALUES (?,?,?,?,?,?)',
      [cusId, cusNumber, userId, userName || '', new Date(), username || '']
    );
    res.json({ success: true, id: cusId, custodyNumber: cusNumber });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const [custs] = await db.query('SELECT * FROM custodies WHERE id = ?', [req.params.id]);
    if (!custs.length) return res.json({ error: 'Not found' });
    const c = custs[0];
    const [topups] = await db.query('SELECT * FROM custody_topups WHERE custody_id = ? ORDER BY created_at DESC', [req.params.id]);
    const [expenses] = await db.query('SELECT * FROM custody_expenses WHERE custody_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json({
      id: c.id, custodyNumber: c.custody_number, userId: c.user_id, userName: c.user_name,
      createdDate: c.created_date, balance: Number(c.balance), totalTopups: Number(c.total_topups),
      totalExpenses: Number(c.total_expenses), status: c.status,
      topups: topups.map(t => ({
        id: t.id, amount: Number(t.amount), paymentMethod: t.payment_method,
        receiptImage: t.receipt_image, notes: t.notes, createdAt: t.created_at, createdBy: t.created_by
      })),
      expenses: expenses.map(e => ({
        id: e.id, expenseDate: e.expense_date, description: e.description,
        amount: Number(e.amount), hasVat: e.has_vat, vatRate: Number(e.vat_rate),
        vatAmount: Number(e.vat_amount), totalWithVat: Number(e.total_with_vat),
        invoiceImage: e.invoice_image, notes: e.notes, status: e.status,
        rejectionReason: e.rejection_reason, createdBy: e.created_by,
        approvedBy: e.approved_by, approvedAt: e.approved_at,
        postedBy: e.posted_by, postedAt: e.posted_at, journalId: e.journal_id
      }))
    });
  } catch (e) { res.json({ error: e.message }); }
});

// ═══════════════════════════════════════
// TOPUPS (تغذية الرصيد)
// ═══════════════════════════════════════

router.post('/:id/topup', async (req, res) => {
  try {
    const { amount, paymentMethod, receiptImage, notes, username } = req.body;
    const amt = Number(amount) || 0;
    if (amt <= 0) return res.json({ success: false, error: 'Amount must be > 0' });
    const topupId = 'TOP-' + Date.now();
    await db.query(
      'INSERT INTO custody_topups (id, custody_id, amount, payment_method, receipt_image, notes, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [topupId, req.params.id, amt, paymentMethod || 'cash', receiptImage || null, notes || '', new Date(), username || '']
    );
    await db.query('UPDATE custodies SET balance = balance + ?, total_topups = total_topups + ? WHERE id = ?',
      [amt, amt, req.params.id]);
    res.json({ success: true, id: topupId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// EXPENSES (مصروفات العهدة)
// ═══════════════════════════════════════

router.get('/:id/expenses', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM custody_expenses WHERE custody_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json(rows.map(e => ({
      id: e.id, expenseDate: e.expense_date, description: e.description,
      amount: Number(e.amount), hasVat: e.has_vat, vatRate: Number(e.vat_rate),
      vatAmount: Number(e.vat_amount), totalWithVat: Number(e.total_with_vat),
      invoiceImage: e.invoice_image, notes: e.notes, status: e.status,
      createdBy: e.created_by, approvedBy: e.approved_by
    })));
  } catch (e) { res.json([]); }
});

router.post('/:id/expenses', async (req, res) => {
  try {
    const { expenseDate, description, amount, hasVat, vatRate, invoiceImage, notes, username } = req.body;
    const amt = Number(amount) || 0;
    if (amt <= 0 || !description) return res.json({ success: false, error: 'Amount and description required' });
    const vRate = hasVat ? (Number(vatRate) || 15) : 0;
    const vAmt = hasVat ? amt * (vRate / 100) : 0;
    const total = amt + vAmt;
    const expId = 'CEXP-' + Date.now();
    await db.query(
      `INSERT INTO custody_expenses (id, custody_id, expense_date, description, amount, has_vat, vat_rate, vat_amount, total_with_vat, invoice_image, notes, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [expId, req.params.id, expenseDate || new Date(), description, amt, hasVat ? 1 : 0, vRate, vAmt, total,
       invoiceImage || null, notes || '', 'pending', username || '']
    );
    res.json({ success: true, id: expId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Approve expense — deduct from custody balance
router.post('/expenses/:expId/approve', async (req, res) => {
  try {
    const { username } = req.body;
    const [exps] = await db.query('SELECT * FROM custody_expenses WHERE id = ?', [req.params.expId]);
    if (!exps.length) return res.json({ success: false, error: 'Expense not found' });
    const exp = exps[0];
    if (exp.status !== 'pending') return res.json({ success: false, error: 'Only pending expenses can be approved' });
    const total = Number(exp.total_with_vat) || Number(exp.amount) || 0;
    await db.query('UPDATE custody_expenses SET status="approved", approved_by=?, approved_at=? WHERE id=?',
      [username || '', new Date(), req.params.expId]);
    await db.query('UPDATE custodies SET balance = balance - ?, total_expenses = total_expenses + ? WHERE id = ?',
      [total, total, exp.custody_id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Reject expense
router.post('/expenses/:expId/reject', async (req, res) => {
  try {
    const { username, reason } = req.body;
    await db.query('UPDATE custody_expenses SET status="rejected", rejection_reason=?, approved_by=?, approved_at=? WHERE id=?',
      [reason || '', username || '', new Date(), req.params.expId]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Post expense to GL — creates journal entry
router.post('/expenses/:expId/post', async (req, res) => {
  try {
    const { username } = req.body;
    const [exps] = await db.query('SELECT ce.*, c.user_name, c.custody_number FROM custody_expenses ce JOIN custodies c ON ce.custody_id = c.id WHERE ce.id = ?', [req.params.expId]);
    if (!exps.length) return res.json({ success: false, error: 'Expense not found' });
    const exp = exps[0];
    if (exp.status !== 'approved') return res.json({ success: false, error: 'Only approved expenses can be posted' });

    // Build GL journal entries
    const now = new Date();
    const jrnId = 'JRN-' + Date.now();
    const [lastJrn] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
    let jrnNum = 1;
    if (lastJrn.length && lastJrn[0].journal_number) {
      const m = lastJrn[0].journal_number.match(/(\d+)/);
      if (m) jrnNum = parseInt(m[1]) + 1;
    }
    const journalNumber = 'JV-' + String(jrnNum).padStart(6, '0');

    const amt = Number(exp.amount) || 0;
    const vat = Number(exp.vat_amount) || 0;
    const total = amt + vat;
    const desc = 'عهدة ' + (exp.custody_number || '') + ' — ' + (exp.description || '');

    // Insert journal header
    await db.query(
      `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [jrnId, journalNumber, exp.expense_date || now, 'custody_expense', req.params.expId, desc, total, total, 'posted', username || '']
    );

    // Debit: Expenses account
    const gleExpId = 'GLE-' + Date.now() + '-1';
    await db.query(
      `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)`,
      [gleExpId, jrnId, null, '5000', 'مصروفات عهدة', amt, 0, desc]
    );

    // Debit: Input VAT (if any)
    if (vat > 0) {
      const gleVatId = 'GLE-' + Date.now() + '-2';
      await db.query(
        `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)`,
        [gleVatId, jrnId, null, '1430', 'ضريبة المدخلات', vat, 0, 'ضريبة — ' + desc]
      );
    }

    // Credit: Custody account
    const gleCusId = 'GLE-' + Date.now() + '-3';
    await db.query(
      `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)`,
      [gleCusId, jrnId, null, '1200', 'عهدة ' + (exp.user_name || ''), 0, total, desc]
    );

    // Update expense status
    await db.query('UPDATE custody_expenses SET status="posted", posted_by=?, posted_at=?, journal_id=? WHERE id=?',
      [username || '', now, jrnId, req.params.expId]);

    res.json({ success: true, journalNumber });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// REPORTS (تقارير العهدة)
// ═══════════════════════════════════════

router.get('/:id/report', async (req, res) => {
  try {
    const [custs] = await db.query('SELECT * FROM custodies WHERE id = ?', [req.params.id]);
    if (!custs.length) return res.json({ error: 'Not found' });
    const c = custs[0];
    const [user] = await db.query('SELECT * FROM custody_users WHERE id = ?', [c.user_id]);
    const [topups] = await db.query('SELECT * FROM custody_topups WHERE custody_id = ? ORDER BY created_at', [req.params.id]);
    const [expenses] = await db.query('SELECT * FROM custody_expenses WHERE custody_id = ? ORDER BY expense_date', [req.params.id]);
    res.json({
      custody: {
        id: c.id, custodyNumber: c.custody_number, userName: c.user_name,
        createdDate: c.created_date, balance: Number(c.balance),
        totalTopups: Number(c.total_topups), totalExpenses: Number(c.total_expenses), status: c.status
      },
      user: user.length ? { name: user[0].name, idNumber: user[0].id_number, phone: user[0].phone, jobTitle: user[0].job_title } : null,
      topups: topups.map(t => ({ id: t.id, amount: Number(t.amount), paymentMethod: t.payment_method, date: t.created_at, notes: t.notes })),
      expenses: expenses.map(e => ({
        id: e.id, date: e.expense_date, description: e.description,
        amount: Number(e.amount), vatAmount: Number(e.vat_amount), totalWithVat: Number(e.total_with_vat),
        status: e.status, invoiceImage: e.invoice_image, createdBy: e.created_by
      }))
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Get all pending expenses across all custodies (for approval screen)
router.get('/approval/pending', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ce.*, c.custody_number, c.user_name FROM custody_expenses ce
       JOIN custodies c ON ce.custody_id = c.id
       WHERE ce.status IN ('pending','approved')
       ORDER BY ce.created_at DESC`
    );
    res.json(rows.map(e => ({
      id: e.id, custodyId: e.custody_id, custodyNumber: e.custody_number, userName: e.user_name,
      expenseDate: e.expense_date, description: e.description,
      amount: Number(e.amount), vatAmount: Number(e.vat_amount), totalWithVat: Number(e.total_with_vat),
      invoiceImage: e.invoice_image, notes: e.notes, status: e.status, createdBy: e.created_by
    })));
  } catch (e) { res.json([]); }
});

module.exports = router;
