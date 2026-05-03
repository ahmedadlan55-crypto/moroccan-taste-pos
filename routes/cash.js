const router = require('express').Router();
const db = require('../db/connection');

// ═══════════════════════════════════════════════════════════════
// HELPER: Auto-create GL accounts for cash/bank + post journals
// ═══════════════════════════════════════════════════════════════
async function ensureCashAccount(cashBoxId, name, code) {
  const [existing] = await db.query('SELECT gl_account_id FROM cash_boxes WHERE id = ?', [cashBoxId]);
  if (existing.length && existing[0].gl_account_id) return existing[0].gl_account_id;
  // Create under 1101 (النقدية)
  const [parent] = await db.query("SELECT id FROM gl_accounts WHERE code = '1101' LIMIT 1");
  let parentId = parent.length ? parent[0].id : null;
  if (!parentId) {
    const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11' LIMIT 1");
    parentId = 'GL-1101';
    await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [parentId, '1101', 'النقدية', 'asset', p11.length ? p11[0].id : null, 3]);
  }
  const accId = 'GL-CB-' + Date.now();
  const accCode = '1101-' + code;
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
    [accId, accCode, name, 'asset', parentId, 4]);
  await db.query('UPDATE cash_boxes SET gl_account_id = ? WHERE id = ?', [accId, cashBoxId]);
  return accId;
}

async function ensureBankAccount(bankId, name, code) {
  const [existing] = await db.query('SELECT gl_account_id FROM bank_accounts WHERE id = ?', [bankId]);
  if (existing.length && existing[0].gl_account_id) return existing[0].gl_account_id;
  const [parent] = await db.query("SELECT id FROM gl_accounts WHERE code = '1102' LIMIT 1");
  let parentId = parent.length ? parent[0].id : null;
  if (!parentId) {
    const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11' LIMIT 1");
    parentId = 'GL-1102';
    await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [parentId, '1102', 'البنوك', 'asset', p11.length ? p11[0].id : null, 3]);
  }
  const accId = 'GL-BK-' + Date.now();
  const accCode = '1102-' + code;
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
    [accId, accCode, name, 'asset', parentId, 4]);
  await db.query('UPDATE bank_accounts SET gl_account_id = ? WHERE id = ?', [accId, bankId]);
  return accId;
}

async function getSourceAccount(type, id) {
  if (type === 'cash') {
    const [r] = await db.query('SELECT id, name, code, gl_account_id FROM cash_boxes WHERE id = ?', [id]);
    if (!r.length) throw new Error('الصندوق غير موجود');
    const gl = await ensureCashAccount(id, r[0].name, r[0].code || r[0].id);
    return { glId: gl, name: r[0].name, code: r[0].code };
  }
  const [r] = await db.query('SELECT id, bank_name, account_number, gl_account_id FROM bank_accounts WHERE id = ?', [id]);
  if (!r.length) throw new Error('الحساب البنكي غير موجود');
  const gl = await ensureBankAccount(id, r[0].bank_name, r[0].account_number || r[0].id.substring(0,6));
  return { glId: gl, name: r[0].bank_name, code: r[0].account_number || '' };
}

async function createJournal(date, description, lines, username) {
  const journalId = 'GLJ-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
  const [last] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
  let num = 1;
  if (last.length && last[0].journal_number) {
    const m = last[0].journal_number.match(/(\d+)/);
    if (m) num = parseInt(m[1]) + 1;
  }
  const jNum = 'JE-' + String(num).padStart(5, '0');
  let totalD = 0, totalC = 0;
  lines.forEach(l => { totalD += Number(l.debit)||0; totalC += Number(l.credit)||0; });
  if (Math.abs(totalD - totalC) > 0.01) throw new Error('القيد غير متوازن');
  await db.query(
    `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, description, total_debit, total_credit, status, created_by, posted_by, posted_at)
     VALUES (?,?,?,?,?,?,?,'posted',?,?,NOW())`,
    [journalId, jNum, date, 'cash', description, totalD, totalC, username||'', username||'']);
  for (const l of lines) {
    const entryId = 'GLE-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query(
      `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)`,
      [entryId, journalId, l.accountId||null, l.accountCode||'', l.accountName||'', Number(l.debit)||0, Number(l.credit)||0, l.description || description]);
    if (l.accountId) {
      const net = (Number(l.debit)||0) - (Number(l.credit)||0);
      await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [net, l.accountId]);
    }
  }
  return { id: journalId, journalNumber: jNum };
}

async function nextNumber(table, column, prefix) {
  const [last] = await db.query(`SELECT ${column} FROM ${table} ORDER BY created_at DESC LIMIT 1`);
  let num = 1;
  if (last.length && last[0][column]) {
    const m = String(last[0][column]).match(/(\d+)/);
    if (m) num = parseInt(m[1]) + 1;
  }
  return prefix + String(num).padStart(5, '0');
}

// ═══════════════════════════════════════════════════════════════
// V5.9.13 — GL ACCOUNT TREE PICKER (for cash boxes / bank accounts)
//
// Returns active GL accounts under a given root (typically '1101' for
// cash, '1102' for banks) so the cash-box / bank-account create form
// can present an explicit dropdown instead of relying on auto-create.
// ═══════════════════════════════════════════════════════════════
router.get('/gl-accounts-tree', async (req, res) => {
  try {
    const root = String(req.query.root || '1101');
    if (!/^\d{1,4}(?:-\w+)?$/.test(root)) return res.json([]);
    // Return both the root row and any descendant whose code starts with the root.
    // The COA uses a hierarchical text code like 1101-01, 1101-02, …
    const [rows] = await db.query(
      `SELECT id, code, name_ar, type, parent_id, level, is_active
       FROM gl_accounts
       WHERE is_active = 1 AND (code = ? OR code LIKE CONCAT(?, '-%') OR code LIKE CONCAT(?, '%'))
       ORDER BY code ASC`,
      [root, root, root]);
    res.json(rows.map(r => ({
      id: r.id, code: r.code, nameAr: r.name_ar,
      level: Number(r.level)||0, parentId: r.parent_id, type: r.type,
      isLeaf: r.code !== root  // anything below the requested root is selectable
    })));
  } catch(e) { res.json([]); }
});

// ═══════════════════════════════════════════════════════════════
// CASH BOXES
// ═══════════════════════════════════════════════════════════════
router.get('/cash-boxes', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT cb.*, br.name AS branch_name, bd.name AS brand_name,
             ga.code AS gl_code, ga.name_ar AS gl_name
      FROM cash_boxes cb
      LEFT JOIN branches br ON cb.branch_id = br.id
      LEFT JOIN brands bd ON cb.brand_id = bd.id
      LEFT JOIN gl_accounts ga ON cb.gl_account_id = ga.id
      WHERE cb.is_active = 1 ORDER BY cb.name`);
    res.json(rows.map(r => ({
      id: r.id, name: r.name, code: r.code, type: r.type,
      branchId: r.branch_id, branchName: r.branch_name||'',
      brandId: r.brand_id, brandName: r.brand_name||'',
      keeperUsername: r.keeper_username, currency: r.currency,
      balance: Number(r.balance)||0, isActive: !!r.is_active,
      // V5.9.13 — surface the linked GL account so the edit form can preselect it
      glAccountId: r.gl_account_id || '',
      glAccountCode: r.gl_code || '',
      glAccountName: r.gl_name || ''
    })));
  } catch(e) { res.json([]); }
});

router.post('/cash-boxes', async (req, res) => {
  try {
    const { id, name, code, type, branchId, brandId, keeperUsername, currency, glAccountId, username } = req.body;
    if (!name) return res.json({ success:false, error: 'الاسم مطلوب' });
    // V5.9.13 — validate the chosen GL account exists and lives under root 1101 (النقدية).
    let glId = null;
    if (glAccountId) {
      const [g] = await db.query('SELECT code FROM gl_accounts WHERE id=? AND is_active=1', [glAccountId]);
      if (!g.length) return res.json({ success:false, error: 'حساب الأستاذ غير موجود' });
      if (g[0].code && !String(g[0].code).startsWith('1101'))
        return res.json({ success:false, error: 'حساب الصندوق يجب أن يكون تحت 1101 (النقدية)' });
      glId = glAccountId;
    }
    if (id) {
      await db.query(
        'UPDATE cash_boxes SET name=?, code=?, type=?, branch_id=?, brand_id=?, keeper_username=?, currency=?, gl_account_id = COALESCE(?, gl_account_id) WHERE id=?',
        [name, code||'', type||'branch', branchId||null, brandId||null, keeperUsername||'', currency||'SAR', glId, id]);
      return res.json({ success:true, id });
    }
    const newId = 'CB-' + Date.now();
    await db.query(
      'INSERT INTO cash_boxes (id, name, code, type, branch_id, brand_id, keeper_username, currency, gl_account_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [newId, name, code||'', type||'branch', branchId||null, brandId||null, keeperUsername||'', currency||'SAR', glId]);
    res.json({ success:true, id: newId });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

router.delete('/cash-boxes/:id', async (req, res) => {
  try { await db.query('UPDATE cash_boxes SET is_active=0 WHERE id=?', [req.params.id]); res.json({success:true}); }
  catch(e) { res.json({success:false, error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
// BANK ACCOUNTS
// ═══════════════════════════════════════════════════════════════
router.get('/bank-accounts', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ba.*, bd.name AS brand_name,
             ga.code AS gl_code, ga.name_ar AS gl_name
      FROM bank_accounts ba
      LEFT JOIN brands bd ON ba.brand_id = bd.id
      LEFT JOIN gl_accounts ga ON ba.gl_account_id = ga.id
      WHERE ba.is_active = 1 ORDER BY ba.bank_name`);
    res.json(rows.map(r => ({
      id: r.id, bankName: r.bank_name, accountName: r.account_name,
      accountNumber: r.account_number, iban: r.iban, currency: r.currency,
      brandId: r.brand_id, brandName: r.brand_name||'',
      balance: Number(r.balance)||0,
      // V5.9.13 — explicit GL link for the picker
      glAccountId: r.gl_account_id || '',
      glAccountCode: r.gl_code || '',
      glAccountName: r.gl_name || ''
    })));
  } catch(e) { res.json([]); }
});

router.post('/bank-accounts', async (req, res) => {
  try {
    const { id, bankName, accountName, accountNumber, iban, currency, brandId, glAccountId } = req.body;
    if (!bankName) return res.json({ success:false, error: 'اسم البنك مطلوب' });
    // V5.9.13 — validate GL account is under root 1102 (البنوك)
    let glId = null;
    if (glAccountId) {
      const [g] = await db.query('SELECT code FROM gl_accounts WHERE id=? AND is_active=1', [glAccountId]);
      if (!g.length) return res.json({ success:false, error: 'حساب الأستاذ غير موجود' });
      if (g[0].code && !String(g[0].code).startsWith('1102'))
        return res.json({ success:false, error: 'حساب البنك يجب أن يكون تحت 1102 (البنوك)' });
      glId = glAccountId;
    }
    if (id) {
      await db.query(
        'UPDATE bank_accounts SET bank_name=?, account_name=?, account_number=?, iban=?, currency=?, brand_id=?, gl_account_id = COALESCE(?, gl_account_id) WHERE id=?',
        [bankName, accountName||'', accountNumber||'', iban||'', currency||'SAR', brandId||null, glId, id]);
      return res.json({ success:true, id });
    }
    const newId = 'BA-' + Date.now();
    await db.query(
      'INSERT INTO bank_accounts (id, bank_name, account_name, account_number, iban, currency, brand_id, gl_account_id) VALUES (?,?,?,?,?,?,?,?)',
      [newId, bankName, accountName||'', accountNumber||'', iban||'', currency||'SAR', brandId||null, glId]);
    res.json({ success:true, id: newId });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

router.delete('/bank-accounts/:id', async (req, res) => {
  try { await db.query('UPDATE bank_accounts SET is_active=0 WHERE id=?', [req.params.id]); res.json({success:true}); }
  catch(e) { res.json({success:false, error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
// RECEIPTS (سندات القبض)
// ═══════════════════════════════════════════════════════════════
router.get('/receipts', async (req, res) => {
  try {
    const { from, to, source_type } = req.query;
    let sql = 'SELECT * FROM cash_receipts WHERE 1=1';
    const params = [];
    if (from) { sql += ' AND receipt_date >= ?'; params.push(from); }
    if (to) { sql += ' AND receipt_date <= ?'; params.push(to); }
    if (source_type) { sql += ' AND source_type = ?'; params.push(source_type); }
    sql += ' ORDER BY receipt_date DESC, created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, receiptNumber: r.receipt_number, receiptDate: r.receipt_date,
      destinationType: r.destination_type, destinationId: r.destination_id,
      sourceType: r.source_type, sourceId: r.source_id, sourceName: r.source_name,
      amount: Number(r.amount)||0, reference: r.reference, description: r.description,
      status: r.status, journalId: r.journal_id, createdBy: r.created_by, createdAt: r.created_at
    })));
  } catch(e) { res.json([]); }
});

// V5.9.14 — Helper: resolve which source GL account a receipt should credit
// based on its source_type. Reused by POST /receipts (draft persist) and
// POST /receipts/:id/approve (GL posting).
async function _receiptSourceGl(sourceType) {
  let code = '4203', name = 'إيرادات أخرى';
  if (sourceType === 'customer') { code = '1125'; name = 'حسابات العملاء'; }
  else if (sourceType === 'employee') { code = '1130'; name = 'سلف الموظفين'; }
  else if (sourceType === 'rent')     { code = '4202'; name = 'إيرادات إيجارات'; }
  else if (sourceType === 'sales')    { code = '4101'; name = 'المبيعات'; }
  let [r] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  let id;
  if (r.length) id = r[0].id;
  else {
    id = 'GL-' + code;
    const parentCode = code[0] === '1' ? '11' : '4';
    const type = code[0] === '1' ? 'asset' : 'revenue';
    const [p] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [parentCode]);
    await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [id, code, name, type, p.length ? p[0].id : null, 3]);
  }
  return { id, code, name };
}

// V5.9.14 — Receipt creation now persists as DRAFT only — no GL journal,
// no balance update. The user must explicitly approve the receipt to post
// the journal and credit the destination account. Old behavior posted
// instantly which let unreviewed receipts hit the books.
router.post('/receipts', async (req, res) => {
  try {
    const { receiptDate, destinationType, destinationId, sourceType, sourceId, sourceName, amount, reference, description, username } = req.body;
    if (!amount || !destinationId || !destinationType) return res.json({ success:false, error: 'البيانات ناقصة' });
    // Validate destination exists (don't auto-create the GL account here — that
    // happens at approve time, so the audit trail is clean).
    const destTable = destinationType === 'cash' ? 'cash_boxes' : 'bank_accounts';
    const [chk] = await db.query('SELECT id FROM ' + destTable + ' WHERE id=? AND is_active=1', [destinationId]);
    if (!chk.length) return res.json({ success:false, error: 'الجهة المُستلِمة غير موجودة' });
    const number = await nextNumber('cash_receipts', 'receipt_number', 'REC-');
    const id = 'REC-' + Date.now();
    await db.query(
      `INSERT INTO cash_receipts (id, receipt_number, receipt_date, destination_type, destination_id, source_type, source_id, source_name, amount, reference, description, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft', ?)`,
      [id, number, receiptDate, destinationType, destinationId, sourceType||'other', sourceId||null, sourceName||'', amount, reference||'', description||'', username||'']);
    res.json({ success:true, id, number, status:'draft' });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// V5.9.14 — Approve a draft receipt: posts the GL journal and updates the
// destination balance. Idempotent (refuses to re-post a posted receipt).
router.post('/receipts/:id/approve', async (req, res) => {
  try {
    const id = req.params.id;
    const username = (req.body && req.body.username) || (req.user && req.user.username) || '';
    const [rows] = await db.query('SELECT * FROM cash_receipts WHERE id=?', [id]);
    if (!rows.length) return res.json({ success:false, error: 'السند غير موجود' });
    const r = rows[0];
    if (r.status !== 'draft') return res.json({ success:false, error: 'السند غير قابل للاعتماد (الحالة: ' + r.status + ')' });
    const destAcc = await getSourceAccount(r.destination_type, r.destination_id);
    const src = await _receiptSourceGl(r.source_type);
    const journal = await createJournal(r.receipt_date,
      'سند قبض ' + r.receipt_number + ' — ' + (r.source_name || src.name),
      [
        { accountId: destAcc.glId, accountCode: destAcc.code, accountName: destAcc.name, debit: r.amount, credit: 0 },
        { accountId: src.id,       accountCode: src.code,    accountName: src.name,    debit: 0, credit: r.amount }
      ], username);
    await db.query('UPDATE cash_receipts SET status=?, journal_id=?, approved_by=?, approved_at=NOW() WHERE id=?',
      ['posted', journal.id, username, id]);
    if (r.destination_type === 'cash') await db.query('UPDATE cash_boxes SET balance = balance + ? WHERE id = ?', [r.amount, r.destination_id]);
    else                               await db.query('UPDATE bank_accounts SET balance = balance + ? WHERE id = ?', [r.amount, r.destination_id]);
    res.json({ success:true, journalId: journal.id, journalNumber: journal.journalNumber });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// V5.9.14 — Cancel a draft receipt (refuses if posted — needs a reversal journal)
router.post('/receipts/:id/cancel', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query('SELECT status FROM cash_receipts WHERE id=?', [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    if (rows[0].status === 'posted') return res.json({ success:false, error:'لا يمكن إلغاء سند مُرحَّل — أعكسه بقيد مضاد' });
    if (rows[0].status === 'cancelled') return res.json({ success:false, error:'السند ملغى مسبقاً' });
    await db.query('UPDATE cash_receipts SET status=? WHERE id=?', ['cancelled', id]);
    res.json({ success:true });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// V5.9.14 — Print data: the row + linked accounts + company settings, in one
// round-trip so the e-voucher template doesn't need parallel fetches.
router.get('/receipts/:id/print-data', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query(`
      SELECT r.*,
             COALESCE(cb.name, ba.bank_name) AS dest_name,
             COALESCE(cb.code, ba.account_number) AS dest_code,
             ga.code AS dest_gl_code, ga.name_ar AS dest_gl_name,
             jr.journal_number,
             COALESCE(uc.full_name, uc.username, r.created_by) AS created_by_name,
             COALESCE(ua.full_name, ua.username, r.approved_by) AS approved_by_name
      FROM cash_receipts r
      LEFT JOIN cash_boxes cb ON r.destination_type='cash' AND r.destination_id=cb.id
      LEFT JOIN bank_accounts ba ON r.destination_type='bank' AND r.destination_id=ba.id
      LEFT JOIN gl_accounts ga ON ga.id = COALESCE(cb.gl_account_id, ba.gl_account_id)
      LEFT JOIN gl_journals jr ON jr.id = r.journal_id
      LEFT JOIN users uc ON uc.username = r.created_by
      LEFT JOIN users ua ON ua.username = r.approved_by
      WHERE r.id=?`, [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    const r = rows[0];
    const [stg] = await db.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyLogo')");
    const cfg = {};
    stg.forEach(s => { cfg[s.setting_key] = s.setting_value; });
    res.json({ success:true, voucher: r, company: cfg });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// PAYMENTS (سندات الصرف)
// ═══════════════════════════════════════════════════════════════
router.get('/payments', async (req, res) => {
  try {
    const { from, to, recipient_type } = req.query;
    let sql = 'SELECT * FROM cash_payments WHERE 1=1';
    const params = [];
    if (from) { sql += ' AND payment_date >= ?'; params.push(from); }
    if (to) { sql += ' AND payment_date <= ?'; params.push(to); }
    if (recipient_type) { sql += ' AND recipient_type = ?'; params.push(recipient_type); }
    sql += ' ORDER BY payment_date DESC, created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, paymentNumber: r.payment_number, paymentDate: r.payment_date,
      sourceType: r.source_type, sourceId: r.source_id,
      recipientType: r.recipient_type, recipientId: r.recipient_id, recipientName: r.recipient_name,
      amount: Number(r.amount)||0, reference: r.reference, description: r.description,
      status: r.status, journalId: r.journal_id, createdBy: r.created_by, createdAt: r.created_at
    })));
  } catch(e) { res.json([]); }
});

// V5.9.14 — Helper for payment recipient GL account resolution.
async function _paymentRecipientGl(recipientType, expenseAccountId) {
  if (expenseAccountId) {
    const [r] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE id = ?', [expenseAccountId]);
    if (r.length) return { id: r[0].id, code: r[0].code, name: r[0].name_ar };
  }
  let code = '5205', name = 'مصروفات أخرى';
  if (recipientType === 'supplier')      { code = '2101'; name = 'حسابات الموردين'; }
  else if (recipientType === 'employee') { code = '1130'; name = 'سلف الموظفين'; }
  const [r] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  let id;
  if (r.length) id = r[0].id;
  else {
    id = 'GL-' + code;
    const type = recipientType === 'supplier' ? 'liability' : (recipientType === 'employee' ? 'asset' : 'expense');
    const [p] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [code[0]]);
    await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [id, code, name, type, p.length ? p[0].id : null, 3]);
  }
  return { id, code, name };
}

// V5.9.14 — Payment creation persists as DRAFT only — same approval gate
// as receipts. Eliminates instant-post-on-create.
router.post('/payments', async (req, res) => {
  try {
    const { paymentDate, sourceType, sourceId, recipientType, recipientId, recipientName, expenseAccountId, amount, reference, description, username } = req.body;
    if (!amount || !sourceId || !sourceType) return res.json({ success:false, error: 'البيانات ناقصة' });
    const srcTable = sourceType === 'cash' ? 'cash_boxes' : 'bank_accounts';
    const [chk] = await db.query('SELECT id FROM ' + srcTable + ' WHERE id=? AND is_active=1', [sourceId]);
    if (!chk.length) return res.json({ success:false, error:'الجهة الدافعة غير موجودة' });
    const number = await nextNumber('cash_payments', 'payment_number', 'PAY-');
    const id = 'PAY-' + Date.now();
    await db.query(
      `INSERT INTO cash_payments (id, payment_number, payment_date, source_type, source_id, recipient_type, recipient_id, recipient_name, expense_account_id, amount, reference, description, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?)`,
      [id, number, paymentDate, sourceType, sourceId, recipientType||'other', recipientId||null, recipientName||'', expenseAccountId||null, amount, reference||'', description||'', username||'']);
    res.json({ success:true, id, number, status:'draft' });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// V5.9.14 — Approve a draft payment: posts the GL journal and decrements
// the source balance.
router.post('/payments/:id/approve', async (req, res) => {
  try {
    const id = req.params.id;
    const username = (req.body && req.body.username) || (req.user && req.user.username) || '';
    const [rows] = await db.query('SELECT * FROM cash_payments WHERE id=?', [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    const p = rows[0];
    if (p.status !== 'draft') return res.json({ success:false, error: 'السند غير قابل للاعتماد (الحالة: ' + p.status + ')' });
    const srcAcc = await getSourceAccount(p.source_type, p.source_id);
    const recip = await _paymentRecipientGl(p.recipient_type, p.expense_account_id);
    const journal = await createJournal(p.payment_date,
      'سند صرف ' + p.payment_number + ' — ' + (p.recipient_name || recip.name),
      [
        { accountId: recip.id,    accountCode: recip.code,    accountName: recip.name,    debit: p.amount, credit: 0 },
        { accountId: srcAcc.glId, accountCode: srcAcc.code,   accountName: srcAcc.name,   debit: 0, credit: p.amount }
      ], username);
    await db.query('UPDATE cash_payments SET status=?, journal_id=?, approved_by=?, approved_at=NOW() WHERE id=?',
      ['posted', journal.id, username, id]);
    if (p.source_type === 'cash') await db.query('UPDATE cash_boxes SET balance = balance - ? WHERE id = ?', [p.amount, p.source_id]);
    else                          await db.query('UPDATE bank_accounts SET balance = balance - ? WHERE id = ?', [p.amount, p.source_id]);
    res.json({ success:true, journalId: journal.id, journalNumber: journal.journalNumber });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

router.post('/payments/:id/cancel', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query('SELECT status FROM cash_payments WHERE id=?', [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    if (rows[0].status === 'posted') return res.json({ success:false, error:'لا يمكن إلغاء سند مُرحَّل — أعكسه بقيد مضاد' });
    if (rows[0].status === 'cancelled') return res.json({ success:false, error:'السند ملغى مسبقاً' });
    await db.query('UPDATE cash_payments SET status=? WHERE id=?', ['cancelled', id]);
    res.json({ success:true });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

router.get('/payments/:id/print-data', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query(`
      SELECT p.*,
             COALESCE(cb.name, ba.bank_name) AS src_name,
             COALESCE(cb.code, ba.account_number) AS src_code,
             ga.code AS src_gl_code, ga.name_ar AS src_gl_name,
             jr.journal_number,
             COALESCE(uc.full_name, uc.username, p.created_by) AS created_by_name,
             COALESCE(ua.full_name, ua.username, p.approved_by) AS approved_by_name
      FROM cash_payments p
      LEFT JOIN cash_boxes cb ON p.source_type='cash' AND p.source_id=cb.id
      LEFT JOIN bank_accounts ba ON p.source_type='bank' AND p.source_id=ba.id
      LEFT JOIN gl_accounts ga ON ga.id = COALESCE(cb.gl_account_id, ba.gl_account_id)
      LEFT JOIN gl_journals jr ON jr.id = p.journal_id
      LEFT JOIN users uc ON uc.username = p.created_by
      LEFT JOIN users ua ON ua.username = p.approved_by
      WHERE p.id=?`, [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    const [stg] = await db.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyLogo')");
    const cfg = {};
    stg.forEach(s => { cfg[s.setting_key] = s.setting_value; });
    res.json({ success:true, voucher: rows[0], company: cfg });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// TRANSFERS (تحويلات بين الصناديق والبنوك)
// ═══════════════════════════════════════════════════════════════
router.get('/transfers', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM cash_transfers ORDER BY transfer_date DESC LIMIT 200');
    res.json(rows);
  } catch(e) { res.json([]); }
});

router.post('/transfers', async (req, res) => {
  try {
    const { transferDate, fromType, fromId, toType, toId, amount, description, username } = req.body;
    if (!amount || !fromId || !toId) return res.json({ success:false, error: 'البيانات ناقصة' });
    if (fromType === toType && fromId === toId) return res.json({ success:false, error: 'لا يمكن التحويل لنفس الحساب' });
    const fromAcc = await getSourceAccount(fromType, fromId);
    const toAcc = await getSourceAccount(toType, toId);
    const number = await nextNumber('cash_transfers', 'transfer_number', 'TRF-');
    const id = 'TRF-' + Date.now();

    const journal = await createJournal(transferDate, 'تحويل ' + number + ' من ' + fromAcc.name + ' إلى ' + toAcc.name, [
      { accountId: toAcc.glId, accountCode: toAcc.code, accountName: toAcc.name, debit: amount, credit: 0 },
      { accountId: fromAcc.glId, accountCode: fromAcc.code, accountName: fromAcc.name, debit: 0, credit: amount }
    ], username);

    await db.query(
      `INSERT INTO cash_transfers (id, transfer_number, transfer_date, from_type, from_id, to_type, to_id, amount, description, journal_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, number, transferDate, fromType, fromId, toType, toId, amount, description||'', journal.id, username||'']);

    // Update balances
    if (fromType === 'cash') await db.query('UPDATE cash_boxes SET balance = balance - ? WHERE id = ?', [amount, fromId]);
    else await db.query('UPDATE bank_accounts SET balance = balance - ? WHERE id = ?', [amount, fromId]);
    if (toType === 'cash') await db.query('UPDATE cash_boxes SET balance = balance + ? WHERE id = ?', [amount, toId]);
    else await db.query('UPDATE bank_accounts SET balance = balance + ? WHERE id = ?', [amount, toId]);

    res.json({ success:true, id, number, journalNumber: journal.journalNumber });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CASH SUMMARY (for dashboard)
// ═══════════════════════════════════════════════════════════════
router.get('/summary', async (req, res) => {
  try {
    const [cash] = await db.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(balance),0) AS total FROM cash_boxes WHERE is_active=1');
    const [bank] = await db.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(balance),0) AS total FROM bank_accounts WHERE is_active=1');
    const today = new Date().toISOString().slice(0,10);
    const [monthStart] = [today.slice(0,7) + '-01'];
    let rcpt = 0, pay = 0;
    try {
      const [r] = await db.query('SELECT COALESCE(SUM(amount),0) AS t FROM cash_receipts WHERE receipt_date >= ?', [monthStart]);
      rcpt = Number(r[0].t)||0;
    } catch(e) {}
    try {
      const [r] = await db.query('SELECT COALESCE(SUM(amount),0) AS t FROM cash_payments WHERE payment_date >= ?', [monthStart]);
      pay = Number(r[0].t)||0;
    } catch(e) {}
    res.json({
      cashBoxCount: cash[0].cnt, cashTotal: Number(cash[0].total)||0,
      bankCount: bank[0].cnt, bankTotal: Number(bank[0].total)||0,
      monthReceipts: rcpt, monthPayments: pay,
      grandTotal: (Number(cash[0].total)||0) + (Number(bank[0].total)||0)
    });
  } catch(e) { res.json({ cashBoxCount:0, cashTotal:0, bankCount:0, bankTotal:0, monthReceipts:0, monthPayments:0, grandTotal:0 }); }
});

module.exports = router;
