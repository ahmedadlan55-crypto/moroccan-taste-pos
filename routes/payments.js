/**
 * Payment Records — Phase C
 * Unified payment flow: purchase → finance → bank → receipt → close → auto-GL.
 *
 * Endpoints:
 *   GET    /api/erp/payments                  — list with filters
 *   GET    /api/erp/payments/:id              — single
 *   POST   /api/erp/payments                  — create (status=requested)
 *   POST   /api/erp/payments/:id/authorize    — finance approves
 *   POST   /api/erp/payments/:id/pay          — bank team executes + uploads receipt
 *   POST   /api/erp/payments/:id/close        — final close + posts GL
 *   POST   /api/erp/payments/:id/cancel       — cancel (only pre-paid)
 *   POST   /api/erp/payments/:id/receipt      — upload receipt (base64)
 *
 * GL posting happens ONLY at /close step. Journal links back to
 * payment_records.gl_journal_id for traceability.
 */
const router = require('express').Router();
const db = require('../db/connection');
const gl = require('../lib/glPosting');

function _ymd(d) {
  d = d || new Date();
  return d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
}

async function _nextSerial(ymd) {
  await db.query(
    `INSERT INTO payment_counter (ymd, last_serial) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE last_serial = last_serial + 1`,
    [ymd]);
  const [rows] = await db.query(
    `SELECT last_serial FROM payment_counter WHERE ymd = ?`, [ymd]);
  return rows[0] ? rows[0].last_serial : 1;
}

// ─── LIST ──────────────────────────────────────────
router.get('/payments', async (req, res) => {
  try {
    const { status, direction, method, dateFrom, dateTo, transactionId, brandId, branchId } = req.query;
    let sql = `
      SELECT p.*,
             b.name AS brand_name,
             br.name AS branch_name,
             ba.name AS bank_account_name,
             cb.name AS cash_box_name
      FROM payment_records p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN branches br ON br.id = p.branch_id
      LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
      LEFT JOIN cash_boxes cb ON cb.id = p.cash_box_id
      WHERE 1=1`;
    const params = [];
    if (status)        { sql += ' AND p.status = ?';        params.push(status); }
    if (direction)     { sql += ' AND p.direction = ?';     params.push(direction); }
    if (method)        { sql += ' AND p.payment_method = ?'; params.push(method); }
    if (transactionId) { sql += ' AND p.transaction_id = ?'; params.push(transactionId); }
    if (brandId)       { sql += ' AND p.brand_id = ?';      params.push(brandId); }
    if (branchId)      { sql += ' AND p.branch_id = ?';     params.push(branchId); }
    if (dateFrom)      { sql += ' AND DATE(p.created_at) >= ?'; params.push(dateFrom); }
    if (dateTo)        { sql += ' AND DATE(p.created_at) <= ?'; params.push(dateTo); }
    sql += ' ORDER BY p.created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SINGLE ──────────────────────────────────────────
router.get('/payments/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.*,
             b.name AS brand_name, br.name AS branch_name,
             ba.name AS bank_account_name, cb.name AS cash_box_name,
             j.journal_number AS gl_journal_number
      FROM payment_records p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN branches br ON br.id = p.branch_id
      LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
      LEFT JOIN cash_boxes cb ON cb.id = p.cash_box_id
      LEFT JOIN gl_journals j ON j.id = p.gl_journal_id
      WHERE p.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CREATE ──────────────────────────────────────────
router.post('/payments', async (req, res) => {
  try {
    const {
      transactionId, referenceType, referenceId, direction, amount,
      paymentMethod, bankAccountId, cashBoxId,
      expenseAccountCode, counterAccountCode,
      brandId, branchId, costCenterId, notes, requestedBy
    } = req.body;

    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });

    const ymd = _ymd();
    const serial = await _nextSerial(ymd);
    const paymentNumber = 'PMT-' + ymd + '-' + String(serial).padStart(4, '0');
    const id = 'PR-' + Date.now();

    await db.query(
      `INSERT INTO payment_records
       (id, payment_number, transaction_id, reference_type, reference_id,
        direction, amount, payment_method, bank_account_id, cash_box_id,
        expense_account_code, counter_account_code,
        brand_id, branch_id, cost_center_id, notes, requested_by, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, paymentNumber, transactionId || null, referenceType || null, referenceId || null,
       direction || 'out', Number(amount), paymentMethod || 'bank',
       bankAccountId || null, cashBoxId || null,
       expenseAccountCode || null, counterAccountCode || null,
       brandId || null, branchId || null, costCenterId || null,
       notes || '', requestedBy || '', 'requested']);

    // Link back to transaction if provided
    if (transactionId) {
      try {
        await db.query('UPDATE transactions SET payment_record_id = ? WHERE id = ?', [id, transactionId]);
      } catch(e) { /* best-effort */ }
    }

    res.json({ success: true, id, paymentNumber });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── AUTHORIZE (finance manager approves payment) ──────────
router.post('/payments/:id/authorize', async (req, res) => {
  try {
    const { authorizedBy } = req.body;
    const [rows] = await db.query('SELECT status FROM payment_records WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].status !== 'requested') return res.status(400).json({ error: 'only requested payments can be authorized' });
    await db.query(
      `UPDATE payment_records SET status='authorized', authorized_by=?, authorized_at=NOW() WHERE id=?`,
      [authorizedBy || '', req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PAY (bank team executes the payment) ──────────
router.post('/payments/:id/pay', async (req, res) => {
  try {
    const { paidBy, receiptAttachment, receiptNumber, receiptDate } = req.body;
    const [rows] = await db.query('SELECT status, receipt_attachment FROM payment_records WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].status !== 'authorized') return res.status(400).json({ error: 'must be authorized first' });
    const finalReceipt = receiptAttachment || rows[0].receipt_attachment;
    if (!finalReceipt) return res.status(400).json({ error: 'receipt attachment is required to mark as paid' });

    await db.query(
      `UPDATE payment_records
       SET status='paid', paid_by=?, paid_at=NOW(),
           receipt_attachment=?, receipt_number=?, receipt_date=?
       WHERE id=?`,
      [paidBy || '', finalReceipt, receiptNumber || '', receiptDate || null, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── RECEIPT UPLOAD (standalone — can be done before pay) ──────────
router.post('/payments/:id/receipt', async (req, res) => {
  try {
    const { receiptAttachment, receiptNumber, receiptDate } = req.body;
    if (!receiptAttachment) return res.status(400).json({ error: 'receiptAttachment required' });
    await db.query(
      `UPDATE payment_records
       SET receipt_attachment=?, receipt_number=?, receipt_date=?
       WHERE id=?`,
      [receiptAttachment, receiptNumber || '', receiptDate || null, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CLOSE (posts GL journal) ──────────
router.post('/payments/:id/close', async (req, res) => {
  try {
    const { closedBy } = req.body;
    const [rows] = await db.query(`
      SELECT p.*, b.name AS brand_name, br.name AS branch_name
      FROM payment_records p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN branches br ON br.id = p.branch_id
      WHERE p.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const p = rows[0];
    if (p.status !== 'paid') return res.status(400).json({ error: 'must be paid first' });

    // Determine counter account (cash vs bank vs AP)
    let counterAcc = p.counter_account_code;
    if (!counterAcc) {
      if (p.payment_method === 'cash') counterAcc = gl.CORE_ACCOUNTS.CASH.code;
      else if (p.payment_method === 'bank' || p.payment_method === 'wire') counterAcc = gl.CORE_ACCOUNTS.BANK.code;
      else counterAcc = gl.CORE_ACCOUNTS.BANK.code;  // cheque/card → treat as bank
    }
    // Expense account (debit side for 'out' direction)
    const expenseAcc = p.expense_account_code || gl.CORE_ACCOUNTS.AP.code;  // fallback to AP for vendor payments

    const entries = p.direction === 'out' ? [
      // Payment out: Dr expense/AP, Cr bank/cash
      { accountCode: expenseAcc, debit:  Number(p.amount), credit: 0,
        brandId: p.brand_id, branchId: p.branch_id, costCenterId: p.cost_center_id },
      { accountCode: counterAcc, debit: 0, credit: Number(p.amount),
        brandId: p.brand_id, branchId: p.branch_id }
    ] : [
      // Payment in (customer receipt): Dr bank/cash, Cr AR
      { accountCode: counterAcc, debit: Number(p.amount), credit: 0,
        brandId: p.brand_id, branchId: p.branch_id },
      { accountCode: expenseAcc, debit: 0, credit: Number(p.amount),
        brandId: p.brand_id, branchId: p.branch_id }
    ];

    let journalId = null;
    try {
      const r = await gl.postJournal(db, {
        referenceType: 'payment',
        referenceId: p.id,
        description: 'دفع ' + p.payment_number + (p.notes ? ' — ' + p.notes : ''),
        entries: entries,
        postedBy: closedBy || p.paid_by || '',
        status: 'posted'
      });
      if (r && r.success) journalId = r.journalId;
      else throw new Error(r && r.error ? r.error : 'GL posting failed');
    } catch(glErr) {
      console.error('[payments/close] GL post failed:', glErr.message);
      return res.status(500).json({ error: 'GL posting failed: ' + glErr.message });
    }

    await db.query(
      `UPDATE payment_records
       SET status='closed', closed_at=NOW(), gl_journal_id=?
       WHERE id=?`,
      [journalId, req.params.id]);

    // If linked to a transaction, mark transaction as closed too
    if (p.transaction_id) {
      try {
        await db.query(
          `UPDATE transactions SET status = 'closed' WHERE id = ? AND status != 'closed'`,
          [p.transaction_id]);
      } catch(e) { /* best-effort */ }
    }

    res.json({ success: true, glJournalId: journalId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CANCEL ──────────
router.post('/payments/:id/cancel', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT status FROM payment_records WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].status === 'closed') return res.status(400).json({ error: 'cannot cancel a closed payment' });
    await db.query(`UPDATE payment_records SET status='cancelled' WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
