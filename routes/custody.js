/**
 * Custody Management (العهد) — complete CRUD + approval workflow + GL posting
 */
const router = require('express').Router();
const db = require('../db/connection');

// ═══════════════════════════════════════
// GL ACCOUNT HELPERS — auto-create custody accounts in chart of accounts
// ═══════════════════════════════════════

// Ensure a parent "عهد الموظفين" group exists under assets (113xx)
async function ensureCustodyParentAccount() {
  const code = '1130';
  const [existing] = await db.query('SELECT id FROM gl_accounts WHERE code = ?', [code]);
  if (existing.length) return existing[0].id;
  // Find parent 113 or 11
  let parentId = null;
  const [p113] = await db.query("SELECT id FROM gl_accounts WHERE code = '113'");
  if (p113.length) parentId = p113[0].id;
  else {
    const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11'");
    if (p11.length) parentId = p11[0].id;
  }
  const id = 'GL-' + code;
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
    [id, code, 'عهد الموظفين', 'asset', parentId, parentId ? 3 : 2]);
  return id;
}

// Create a GL account for a specific custody user (e.g. 11301 — عهدة أحمد)
async function createCustodyUserGLAccount(custodyUserName) {
  const parentId = await ensureCustodyParentAccount();
  // Find next code under 1130x
  const [children] = await db.query("SELECT code FROM gl_accounts WHERE code LIKE '1130%' AND code != '1130' ORDER BY code DESC LIMIT 1");
  let nextCode = '11301';
  if (children.length) {
    const lastNum = parseInt(children[0].code.replace('1130', '')) || 0;
    nextCode = '1130' + String(lastNum + 1);
  }
  const id = 'GL-' + nextCode;
  const name = 'عهدة ' + custodyUserName;
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
    [id, nextCode, name, 'asset', parentId, 4]);
  return { id, code: nextCode, name };
}

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
    // Auto-create GL account for this custody user
    try { await createCustodyUserGLAccount(name); } catch(e) { console.log('[CUSTODY] GL account creation warning:', e.message); }
    res.json({ success: true, id: newId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Delete custody user
router.delete('/users/:id', async (req, res) => {
  try {
    // Check if has active custodies
    const [custs] = await db.query('SELECT id FROM custodies WHERE user_id = ? AND status = "active"', [req.params.id]);
    if (custs.length) return res.json({ success: false, error: 'لا يمكن حذف مسؤول عهدة لديه عهد نشطة — أغلق العهد أولاً' });
    await db.query('DELETE FROM custody_users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
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

// ═══════════════════════════════════════
// MY CUSTODY (شاشة مسؤول العهدة الخاصة)
// ═══════════════════════════════════════

// Delete custody (with all topups & expenses)
router.delete('/:id', async (req, res) => {
  try {
    // Delete related records (CASCADE should handle expenses & topups)
    await db.query('DELETE FROM custody_topups WHERE custody_id = ?', [req.params.id]);
    await db.query('DELETE FROM custody_expenses WHERE custody_id = ?', [req.params.id]);
    await db.query('DELETE FROM custodies WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.get('/my-custody', async (req, res) => {
  try {
    const username = req.query.username;
    if (!username) return res.json({ error: 'Username required' });

    // Find custody user linked to this username — auto-create if missing
    let [cuUsers] = await db.query('SELECT * FROM custody_users WHERE linked_username = ? AND is_active = 1', [username]);
    if (!cuUsers.length) {
      // Auto-create custody_users record for this custody-role user
      const [userRow] = await db.query('SELECT role FROM users WHERE username = ?', [username]);
      if (!userRow.length || userRow[0].role !== 'custody') {
        return res.json({ error: 'هذا الحساب ليس مسؤول عهدة', noCustody: true });
      }
      const cuId = 'CU-' + Date.now();
      await db.query(
        'INSERT INTO custody_users (id, name, job_title, linked_username) VALUES (?,?,?,?)',
        [cuId, username, 'مسؤول عهدة', username]
      );
      [cuUsers] = await db.query('SELECT * FROM custody_users WHERE id = ?', [cuId]);
    }
    const cuUser = cuUsers[0];

    // Find the active custody — auto-create if none exists
    let [custodies] = await db.query('SELECT * FROM custodies WHERE user_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1', [cuUser.id]);
    if (!custodies.length) {
      const cusId = 'CUS-' + Date.now();
      const [last] = await db.query('SELECT custody_number FROM custodies ORDER BY created_at DESC LIMIT 1');
      let nextNum = 1;
      if (last.length && last[0].custody_number) {
        const m = last[0].custody_number.match(/(\d+)/);
        if (m) nextNum = parseInt(m[1]) + 1;
      }
      const cusNumber = 'CUS-' + String(nextNum).padStart(5, '0');
      await db.query(
        'INSERT INTO custodies (id, custody_number, user_id, user_name, created_date, created_by) VALUES (?,?,?,?,?,?)',
        [cusId, cusNumber, cuUser.id, cuUser.name, new Date(), 'auto']
      );
      [custodies] = await db.query('SELECT * FROM custodies WHERE id = ?', [cusId]);
    }
    const custody = custodies[0];

    // Get expenses
    const [expenses] = await db.query('SELECT * FROM custody_expenses WHERE custody_id = ? ORDER BY created_at DESC', [custody.id]);

    // Get topups
    const [topups] = await db.query('SELECT * FROM custody_topups WHERE custody_id = ? ORDER BY created_at DESC', [custody.id]);

    // Get GL expense accounts for expense type dropdown
    let expenseAccounts = [];
    try {
      const [glRows] = await db.query("SELECT id, code, name_ar FROM gl_accounts WHERE type = 'expense' ORDER BY code");
      expenseAccounts = glRows.map(g => ({ id: g.id, code: g.code, name: g.name_ar }));
    } catch(e) {}

    // Get company settings (branch name)
    let branchName = '';
    let companyName = '';
    try {
      const [settings] = await db.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','BranchName')");
      settings.forEach(s => {
        if (s.setting_key === 'BranchName') branchName = s.setting_value || '';
        if (s.setting_key === 'CompanyName') companyName = s.setting_value || '';
      });
    } catch(e) {}

    res.json({
      success: true,
      user: {
        id: cuUser.id, name: cuUser.name, idNumber: cuUser.id_number,
        phone: cuUser.phone, jobTitle: cuUser.job_title
      },
      custody: {
        id: custody.id, custodyNumber: custody.custody_number, userName: custody.user_name,
        createdDate: custody.created_date, balance: Number(custody.balance),
        totalTopups: Number(custody.total_topups), totalExpenses: Number(custody.total_expenses),
        status: custody.status
      },
      expenses: expenses.map(e => ({
        id: e.id, expenseDate: e.expense_date, description: e.description,
        amount: Number(e.amount), hasVat: e.has_vat, vatRate: Number(e.vat_rate),
        vatAmount: Number(e.vat_amount), totalWithVat: Number(e.total_with_vat),
        invoiceImage: e.invoice_image, notes: e.notes, status: e.status,
        rejectionReason: e.rejection_reason, createdBy: e.created_by,
        approvedBy: e.approved_by, approvedAt: e.approved_at,
        glAccountId: e.gl_account_id, glAccountName: e.gl_account_name
      })),
      topups: topups.map(t => ({
        id: t.id, amount: Number(t.amount), paymentMethod: t.payment_method,
        notes: t.notes, createdAt: t.created_at
      })),
      expenseAccounts,
      branchName,
      companyName
    });
  } catch (e) { res.json({ error: e.message }); }
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
    const { expenseDate, description, amount, hasVat, vatRate, invoiceImage, notes, username, overrideBalance, glAccountId, glAccountName } = req.body;
    const amt = Number(amount) || 0;
    if (amt <= 0 || !description) return res.json({ success: false, error: 'Amount and description required' });
    const vRate = hasVat ? (Number(vatRate) || 15) : 0;
    const vAmt = hasVat ? amt * (vRate / 100) : 0;
    const total = amt + vAmt;

    // Check balance — block if expense exceeds balance (unless override requested)
    const [cust] = await db.query('SELECT balance FROM custodies WHERE id = ?', [req.params.id]);
    if (cust.length) {
      const currentBalance = Number(cust[0].balance) || 0;
      if (total > currentBalance && !overrideBalance) {
        return res.json({
          success: false,
          needsOverride: true,
          error: 'المبلغ (' + total.toFixed(2) + ') يتجاوز الرصيد المتاح (' + currentBalance.toFixed(2) + '). يرجى طلب تجاوز الرصيد.'
        });
      }
    }

    // Status: if override requested, mark as 'override_pending' so admin must approve first
    const status = overrideBalance ? 'override_pending' : 'pending';

    const expId = 'CEXP-' + Date.now();
    await db.query(
      `INSERT INTO custody_expenses (id, custody_id, expense_date, description, amount, has_vat, vat_rate, vat_amount, total_with_vat, invoice_image, notes, status, created_by, gl_account_id, gl_account_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [expId, req.params.id, expenseDate || new Date(), description, amt, hasVat ? 1 : 0, vRate, vAmt, total,
       invoiceImage || null, notes || '', status, username || '', glAccountId || null, glAccountName || '']
    );
    res.json({ success: true, id: expId, status });
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

// Delete expense (admin only — pending/override_pending/rejected only)
router.delete('/expenses/:expId', async (req, res) => {
  try {
    const [exps] = await db.query('SELECT * FROM custody_expenses WHERE id = ?', [req.params.expId]);
    if (!exps.length) return res.json({ success: false, error: 'المصروف غير موجود' });
    const exp = exps[0];
    if (exp.status === 'approved' || exp.status === 'posted') {
      return res.json({ success: false, error: 'لا يمكن حذف مصروف معتمد أو مرحّل' });
    }
    await db.query('DELETE FROM custody_expenses WHERE id = ?', [req.params.expId]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Return expense to user for editing
router.post('/expenses/:expId/return', async (req, res) => {
  try {
    const { username, reason } = req.body;
    const [exps] = await db.query('SELECT * FROM custody_expenses WHERE id = ?', [req.params.expId]);
    if (!exps.length) return res.json({ success: false, error: 'المصروف غير موجود' });
    const exp = exps[0];
    if (exp.status === 'posted') return res.json({ success: false, error: 'لا يمكن إرجاع مصروف مرحّل' });
    await db.query(
      'UPDATE custody_expenses SET status = "returned", rejection_reason = ?, approved_by = ?, approved_at = ? WHERE id = ?',
      [(reason || 'يرجى التعديل وإعادة الإرسال'), username || '', new Date(), req.params.expId]
    );
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update returned expense (user edits and resubmits)
router.put('/expenses/:expId', async (req, res) => {
  try {
    const { expenseDate, description, amount, hasVat, vatRate, invoiceImage, notes, username } = req.body;
    const [exps] = await db.query('SELECT * FROM custody_expenses WHERE id = ?', [req.params.expId]);
    if (!exps.length) return res.json({ success: false, error: 'المصروف غير موجود' });
    const exp = exps[0];
    if (exp.status !== 'returned') return res.json({ success: false, error: 'فقط المصروفات المُرجعة يمكن تعديلها' });

    const amt = Number(amount) || Number(exp.amount);
    const vRate = hasVat ? (Number(vatRate) || 15) : 0;
    const vAmt = hasVat ? amt * (vRate / 100) : 0;
    const total = amt + vAmt;

    await db.query(
      `UPDATE custody_expenses SET expense_date=?, description=?, amount=?, has_vat=?, vat_rate=?, vat_amount=?, total_with_vat=?,
       invoice_image=COALESCE(?,invoice_image), notes=?, status='pending', rejection_reason=NULL, approved_by=NULL, approved_at=NULL
       WHERE id=?`,
      [expenseDate || exp.expense_date, description || exp.description, amt,
       hasVat ? 1 : 0, vRate, vAmt, total,
       invoiceImage || null, notes || '', req.params.expId]
    );
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

    // Resolve GL account IDs from chart of accounts
    // Helper: find account by code or type fallback
    async function findGLAccount(codes, type) {
      for (const code of codes) {
        const [rows] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE code = ?', [code]);
        if (rows.length) return rows[0];
      }
      // Fallback: any account of this type
      if (type) {
        const [rows] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE type = ? ORDER BY code LIMIT 1', [type]);
        if (rows.length) return rows[0];
      }
      return null;
    }

    // Expense account: use linked gl_account_id, or search by code
    let expAccId = exp.gl_account_id || null;
    let expAccCode = '';
    let expAccName = exp.gl_account_name || 'مصروفات عهدة';
    if (expAccId) {
      const [accRow] = await db.query('SELECT code, name_ar FROM gl_accounts WHERE id = ?', [expAccId]);
      if (accRow.length) { expAccCode = accRow[0].code; expAccName = accRow[0].name_ar; }
      else { expAccId = null; } // ID invalid, fallback below
    }
    if (!expAccId) {
      const acc = await findGLAccount(['61','611','6'], 'expense');
      if (acc) { expAccId = acc.id; expAccCode = acc.code; expAccName = acc.name_ar; }
    }

    // VAT account
    let vatAccId = null;
    if (vat > 0) {
      const acc = await findGLAccount(['21301','213','2130'], 'liability');
      if (acc) vatAccId = acc.id;
    }

    // Custody user GL account — find by name match "عهدة USERNAME"
    let cusAccId = null;
    let cusAccCode = '1130';
    let cusAccName = 'عهدة ' + (exp.user_name || '');
    const [cusAccRows] = await db.query("SELECT id, code, name_ar FROM gl_accounts WHERE name_ar LIKE ? AND code LIKE '1130%'", ['عهدة ' + (exp.user_name||'').substring(0,20) + '%']);
    if (cusAccRows.length) {
      cusAccId = cusAccRows[0].id; cusAccCode = cusAccRows[0].code; cusAccName = cusAccRows[0].name_ar;
    } else {
      // Auto-create if missing
      try {
        const newAcc = await createCustodyUserGLAccount(exp.user_name || 'موظف');
        cusAccId = newAcc.id; cusAccCode = newAcc.code; cusAccName = newAcc.name;
      } catch(e) {
        // Fallback to any asset account
        const fallback = await findGLAccount(['11101','1110','111'], 'asset');
        if (fallback) { cusAccId = fallback.id; cusAccCode = fallback.code; cusAccName = fallback.name_ar; }
      }
    }

    console.log('[CUSTODY POST] expAcc:', expAccId, expAccCode, '| vatAcc:', vatAccId, '| cusAcc:', cusAccId, cusAccCode);

    // Insert journal header — status 'posted' with balance updates
    await db.query(
      `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by, posted_by, posted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [jrnId, journalNumber, exp.expense_date || now, 'custody_expense', req.params.expId, desc, total, total, 'posted', username || '', username || '', now]
    );

    // Debit: Expenses account
    const gleExpId = 'GLE-' + Date.now() + '-1';
    await db.query(
      `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)`,
      [gleExpId, jrnId, expAccId, expAccCode, expAccName, amt, 0, desc]
    );
    if (expAccId) await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [amt, expAccId]);

    // Debit: Input VAT (if any)
    if (vat > 0) {
      const gleVatId = 'GLE-' + Date.now() + '-2';
      await db.query(
        `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)`,
        [gleVatId, jrnId, vatAccId, '21301', 'ضريبة القيمة المضافة المستحقة', vat, 0, 'ضريبة — ' + desc]
      );
      if (vatAccId) await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [vat, vatAccId]);
    }

    // Credit: Custody user account
    const gleCusId = 'GLE-' + Date.now() + '-3';
    await db.query(
      `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)`,
      [gleCusId, jrnId, cusAccId, cusAccCode, cusAccName, 0, total, desc]
    );
    if (cusAccId) await db.query('UPDATE gl_accounts SET balance = balance - ? WHERE id = ?', [total, cusAccId]);

    // Update expense status
    await db.query('UPDATE custody_expenses SET status="posted", posted_by=?, posted_at=?, journal_id=? WHERE id=?',
      [username || '', now, jrnId, req.params.expId]);

    res.json({ success: true, journalNumber });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// CLOSE CUSTODY REQUEST (طلب إقفال العهدة)
// ═══════════════════════════════════════

// User submits close request
router.post('/:id/close-request', async (req, res) => {
  try {
    const { username, notes } = req.body;
    const [custs] = await db.query('SELECT * FROM custodies WHERE id = ?', [req.params.id]);
    if (!custs.length) return res.json({ success: false, error: 'العهدة غير موجودة' });
    const c = custs[0];
    if (c.status === 'closed') return res.json({ success: false, error: 'العهدة مغلقة بالفعل' });

    // Calculate difference: positive = user owes company, negative = company owes user
    const balance = Number(c.balance) || 0;
    const totalExpApproved = Number(c.total_expenses) || 0;

    await db.query(
      'UPDATE custodies SET status = "close_pending", close_requested_by = ?, close_requested_at = ?, close_notes = ? WHERE id = ?',
      [username || '', new Date(), notes || '', req.params.id]
    );
    res.json({ success: true, balance });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Admin approves close request
router.post('/:id/close-approve', async (req, res) => {
  try {
    const { username } = req.body;
    const [custs] = await db.query('SELECT * FROM custodies WHERE id = ?', [req.params.id]);
    if (!custs.length) return res.json({ success: false, error: 'العهدة غير موجودة' });
    const c = custs[0];
    if (c.status !== 'close_pending') return res.json({ success: false, error: 'لا يوجد طلب إقفال معلق' });

    await db.query(
      'UPDATE custodies SET status = "closed", close_approved_by = ?, close_approved_at = ? WHERE id = ?',
      [username || '', new Date(), req.params.id]
    );
    res.json({ success: true, balance: Number(c.balance) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Admin rejects close request — back to active
router.post('/:id/close-reject', async (req, res) => {
  try {
    const { username, reason } = req.body;
    await db.query(
      'UPDATE custodies SET status = "active", close_notes = ? WHERE id = ?',
      [(reason || '') + ' [رفض بواسطة ' + (username || '') + ']', req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Approve override expense (admin approves over-balance expense)
router.post('/expenses/:expId/approve-override', async (req, res) => {
  try {
    const { username } = req.body;
    const [exps] = await db.query('SELECT * FROM custody_expenses WHERE id = ?', [req.params.expId]);
    if (!exps.length) return res.json({ success: false, error: 'المصروف غير موجود' });
    const exp = exps[0];
    if (exp.status !== 'override_pending') return res.json({ success: false, error: 'هذا المصروف ليس بانتظار موافقة تجاوز' });

    // Move to normal pending (so it follows the regular approval flow)
    await db.query('UPDATE custody_expenses SET status = "pending", approved_by = ?, approved_at = ? WHERE id = ?',
      [username || '', new Date(), req.params.expId]);
    res.json({ success: true });
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
       WHERE ce.status IN ('pending','approved','override_pending','returned')
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
