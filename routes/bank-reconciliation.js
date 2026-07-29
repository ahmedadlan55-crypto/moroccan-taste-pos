'use strict';
/*
 * routes/bank-reconciliation.js — mounted at /api/bank-recon (FC-P3, greenfield).
 *
 * Bank reconciliation: import a bank statement, match its lines against the
 * posted GL movements of the bank's account, post fee/interest adjustments as
 * real journals, and close the reconciliation. Plus cash-drawer closing with a
 * difference journal. All writes are capability-gated (permissions_v3) and the
 * actor comes from the JWT. GL postings go through the safe lib/glPosting poster.
 */
const router = require('express').Router();
const acctDate = require('../lib/accountingDate');
const db = require('../db/connection');
const glPosting = require('../lib/glPosting');
const requireCapability = require('../middleware/requireCapability');

function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _id(prefix) { return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
async function _codeOf(accountId) {
  const [r] = await db.query('SELECT code FROM gl_accounts WHERE id=? LIMIT 1', [accountId]);
  return r.length ? r[0].code : null;
}

const CAP = {
  view:  requireCapability('finance.bankrec.view'),
  manage: requireCapability('finance.bankrec.manage'),
  close: requireCapability('finance.bankrec.close'),
  cashClose: requireCapability('finance.cash.close'),
};

// ── Bank statements ─────────────────────────────────────────────────────────
router.get('/statements', CAP.view, async (req, res) => {
  try {
    const where = []; const params = [];
    if (req.query.bankAccountId) { where.push('s.bank_account_id=?'); params.push(req.query.bankAccountId); }
    const [rows] = await db.query(
      `SELECT s.*, ba.bank_name, ba.account_number,
              (SELECT COUNT(*) FROM bank_statement_lines l WHERE l.statement_id=s.id) AS line_count,
              (SELECT COUNT(*) FROM bank_statement_lines l WHERE l.statement_id=s.id AND l.match_status='unmatched') AS unmatched_count
         FROM bank_statements s
         LEFT JOIN bank_accounts ba ON ba.id=s.bank_account_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY s.created_at DESC LIMIT 200`, params);
    res.json(rows.map(r => ({
      id: r.id, bankAccountId: r.bank_account_id, bankName: r.bank_name || '', accountNumber: r.account_number || '',
      periodFrom: r.period_from, periodTo: r.period_to,
      openingBalance: Number(r.opening_balance) || 0, closingBalance: Number(r.closing_balance) || 0,
      status: r.status, lineCount: Number(r.line_count) || 0, unmatchedCount: Number(r.unmatched_count) || 0,
      createdBy: r.created_by || '', closedBy: r.closed_by || '',
    })));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/statements', CAP.manage, async (req, res) => {
  try {
    const { bankAccountId, periodFrom, periodTo, openingBalance, closingBalance, lines } = req.body || {};
    if (!bankAccountId) return res.status(400).json({ success: false, error: 'اختر الحساب البنكي' });
    const [ba] = await db.query('SELECT id FROM bank_accounts WHERE id=? AND is_active=1', [bankAccountId]);
    if (!ba.length) return res.status(400).json({ success: false, error: 'الحساب البنكي غير موجود' });
    const id = _id('BST');
    await db.withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO bank_statements (id, bank_account_id, period_from, period_to, opening_balance, closing_balance, status, created_by)
         VALUES (?,?,?,?,?,?, 'draft', ?)`,
        [id, bankAccountId, periodFrom || null, periodTo || null, Number(openingBalance) || 0, Number(closingBalance) || 0, _actor(req)]);
      for (const l of (Array.isArray(lines) ? lines : [])) {
        await conn.query(
          `INSERT INTO bank_statement_lines (id, statement_id, line_date, description, reference, amount, match_status)
           VALUES (?,?,?,?,?,?, 'unmatched')`,
          [_id('BSL'), id, l.lineDate || null, String(l.description || '').slice(0, 300), String(l.reference || '').slice(0, 100), Number(l.amount) || 0]);
      }
    });
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Statement detail: lines + the bank account's posted book movements in the period.
router.get('/statements/:id', CAP.view, async (req, res) => {
  try {
    const [srows] = await db.query('SELECT * FROM bank_statements WHERE id=?', [req.params.id]);
    if (!srows.length) return res.status(404).json({ success: false, error: 'الكشف غير موجود' });
    const s = srows[0];
    const [lines] = await db.query('SELECT * FROM bank_statement_lines WHERE statement_id=? ORDER BY line_date, id', [req.params.id]);
    const [ba] = await db.query('SELECT gl_account_id FROM bank_accounts WHERE id=?', [s.bank_account_id]);
    const glAccountId = ba.length ? ba[0].gl_account_id : null;
    let book = [];
    if (glAccountId) {
      const [entries] = await db.query(
        `SELECT e.id, e.debit, e.credit, e.description, j.journal_date, j.journal_number
           FROM gl_entries e JOIN gl_journals j ON e.journal_id=j.id
          WHERE e.account_id=? AND j.status='posted'
            AND (? IS NULL OR j.journal_date >= ?) AND (? IS NULL OR j.journal_date <= ?)
          ORDER BY j.journal_date, e.id`,
        [glAccountId, s.period_from, s.period_from, s.period_to, s.period_to]);
      const matchedIds = new Set(lines.filter(l => l.matched_gl_entry_id).map(l => l.matched_gl_entry_id));
      book = entries.map(e => ({
        id: e.id, date: e.journal_date, journalNumber: e.journal_number, description: e.description || '',
        amount: (Number(e.debit) || 0) - (Number(e.credit) || 0), matched: matchedIds.has(e.id),
      }));
    }
    res.json({
      statement: {
        id: s.id, bankAccountId: s.bank_account_id, glAccountId,
        periodFrom: s.period_from, periodTo: s.period_to,
        openingBalance: Number(s.opening_balance) || 0, closingBalance: Number(s.closing_balance) || 0, status: s.status,
      },
      lines: lines.map(l => ({
        id: l.id, lineDate: l.line_date, description: l.description || '', reference: l.reference || '',
        amount: Number(l.amount) || 0, matchStatus: l.match_status, matchedGlEntryId: l.matched_gl_entry_id || null,
      })),
      book,
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Auto-match: amount within 0.01 AND date within ±3 days, first free book entry.
router.post('/statements/:id/auto-match', CAP.manage, async (req, res) => {
  try {
    const [lines] = await db.query("SELECT * FROM bank_statement_lines WHERE statement_id=? AND match_status='unmatched'", [req.params.id]);
    const [srows] = await db.query('SELECT bank_account_id, period_from, period_to FROM bank_statements WHERE id=?', [req.params.id]);
    if (!srows.length) return res.status(404).json({ success: false, error: 'الكشف غير موجود' });
    const [ba] = await db.query('SELECT gl_account_id FROM bank_accounts WHERE id=?', [srows[0].bank_account_id]);
    const glAccountId = ba.length ? ba[0].gl_account_id : null;
    if (!glAccountId) return res.status(400).json({ success: false, error: 'الحساب البنكي غير مرتبط بحساب أستاذ' });
    const [entries] = await db.query(
      `SELECT e.id, e.debit, e.credit, j.journal_date FROM gl_entries e JOIN gl_journals j ON e.journal_id=j.id
        WHERE e.account_id=? AND j.status='posted'
          AND e.id NOT IN (SELECT matched_gl_entry_id FROM bank_statement_lines WHERE matched_gl_entry_id IS NOT NULL)`,
      [glAccountId]);
    const free = entries.map(e => ({ id: e.id, amount: (Number(e.debit) || 0) - (Number(e.credit) || 0), date: new Date(e.journal_date) }));
    const used = new Set();
    let matched = 0;
    const actor = _actor(req);
    for (const l of lines) {
      const amt = Number(l.amount) || 0;
      const ld = l.line_date ? new Date(l.line_date) : null;
      const hit = free.find(e => !used.has(e.id) && Math.abs(e.amount - amt) < 0.01 &&
        (!ld ? true : Math.abs((e.date - ld) / 86400000) <= 3));
      if (hit) {
        used.add(hit.id);
        await db.query("UPDATE bank_statement_lines SET match_status='matched', matched_gl_entry_id=?, matched_by=?, matched_at=NOW() WHERE id=?",
          [hit.id, actor, l.id]);
        matched++;
      }
    }
    res.json({ success: true, matched, remaining: lines.length - matched });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/lines/:lineId/match', CAP.manage, async (req, res) => {
  try {
    const { glEntryId } = req.body || {};
    if (!glEntryId) return res.status(400).json({ success: false, error: 'اختر حركة الدفتر' });
    const [dup] = await db.query("SELECT id FROM bank_statement_lines WHERE matched_gl_entry_id=? AND id<>?", [glEntryId, req.params.lineId]);
    if (dup.length) return res.status(409).json({ success: false, error: 'حركة الدفتر مطابَقة مسبقًا لسطر آخر' });
    await db.query("UPDATE bank_statement_lines SET match_status='matched', matched_gl_entry_id=?, matched_by=?, matched_at=NOW() WHERE id=?",
      [glEntryId, _actor(req), req.params.lineId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/lines/:lineId/unmatch', CAP.manage, async (req, res) => {
  try {
    await db.query("UPDATE bank_statement_lines SET match_status='unmatched', matched_gl_entry_id=NULL WHERE id=?", [req.params.lineId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Adjustment: post a fee/interest journal for an unmatched line and mark it adjusted.
// Body: { lineId, contraAccountId, kind:'fee'|'interest', amount, description }
router.post('/statements/:id/adjust', CAP.manage, async (req, res) => {
  try {
    const { lineId, contraAccountId, kind, amount, description } = req.body || {};
    const amt = Number(amount) || 0;
    if (!contraAccountId || amt <= 0) return res.status(400).json({ success: false, error: 'حدد الحساب المقابل والمبلغ' });
    const [srows] = await db.query('SELECT bank_account_id FROM bank_statements WHERE id=?', [req.params.id]);
    if (!srows.length) return res.status(404).json({ success: false, error: 'الكشف غير موجود' });
    const [ba] = await db.query('SELECT gl_account_id FROM bank_accounts WHERE id=?', [srows[0].bank_account_id]);
    const bankCode = ba.length && ba[0].gl_account_id ? await _codeOf(ba[0].gl_account_id) : null;
    const contraCode = await _codeOf(contraAccountId);
    if (!bankCode || !contraCode) return res.status(400).json({ success: false, error: 'حساب غير صالح' });
    // fee → Dr contra (expense), Cr bank; interest income → Dr bank, Cr contra (revenue).
    const isInterest = kind === 'interest';
    const entries = isInterest
      ? [{ accountCode: bankCode, debit: amt, credit: 0, description: description || 'فائدة بنكية' },
         { accountCode: contraCode, debit: 0, credit: amt, description: description || 'فائدة بنكية' }]
      : [{ accountCode: contraCode, debit: amt, credit: 0, description: description || 'رسوم بنكية' },
         { accountCode: bankCode, debit: 0, credit: amt, description: description || 'رسوم بنكية' }];
    const posted = await glPosting.postJournal(db, {
      journalDate: acctDate.journalDate(),
      description: 'تسوية بنكية — ' + (isInterest ? 'فائدة' : 'رسوم') + (description ? ' — ' + description : ''),
      referenceType: 'reconciliation', referenceId: req.params.id, postedBy: _actor(req), status: 'posted', entries,
    });
    if (!posted || posted.success === false) return res.status(400).json({ success: false, error: (posted && posted.error) || 'تعذّر ترحيل قيد التسوية' });
    if (lineId) {
      await db.query("UPDATE bank_statement_lines SET match_status='adjusted', matched_gl_entry_id=?, matched_by=?, matched_at=NOW() WHERE id=?",
        [posted.journalId, _actor(req), lineId]);
    }
    res.json({ success: true, journalId: posted.journalId, journalNumber: posted.journalNumber });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/statements/:id/close', CAP.close, async (req, res) => {
  try {
    const out = await db.withTransaction(async (conn) => {
      const [srows] = await conn.query('SELECT status FROM bank_statements WHERE id=? FOR UPDATE', [req.params.id]);
      if (!srows.length) return { error: 'الكشف غير موجود' };
      if (srows[0].status === 'closed') return { error: 'الكشف مُقفل مسبقًا' };
      const [un] = await conn.query("SELECT COUNT(*) AS n FROM bank_statement_lines WHERE statement_id=? AND match_status='unmatched'", [req.params.id]);
      if (Number(un[0].n) > 0) return { error: 'لا يمكن الإقفال — توجد سطور غير مطابَقة (' + un[0].n + ')' };
      await conn.query("UPDATE bank_statements SET status='closed', closed_by=?, closed_at=NOW() WHERE id=?", [_actor(req), req.params.id]);
      return { ok: true };
    });
    if (out.error) return res.status(409).json({ success: false, error: out.error });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/statements/:id/reopen', requireCapability('finance.bankrec.close'), async (req, res) => {
  try {
    await db.query("UPDATE bank_statements SET status='draft', closed_by=NULL, closed_at=NULL WHERE id=?", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Cash-drawer closing ─────────────────────────────────────────────────────
router.get('/cash-closings', CAP.view, async (req, res) => {
  try {
    const where = []; const params = [];
    if (req.query.cashboxId) { where.push('c.cashbox_id=?'); params.push(req.query.cashboxId); }
    const [rows] = await db.query(
      `SELECT c.*, cb.name AS cashbox_name FROM cashbox_closings c
         LEFT JOIN cash_boxes cb ON cb.id=c.cashbox_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.created_at DESC LIMIT 200`, params);
    res.json(rows.map(r => ({
      id: r.id, cashboxId: r.cashbox_id, cashboxName: r.cashbox_name || '', closingDate: r.closing_date,
      expectedBalance: Number(r.expected_balance) || 0, countedAmount: Number(r.counted_amount) || 0,
      difference: Number(r.difference) || 0, status: r.status, notes: r.notes || '', journalId: r.journal_id || null,
      createdBy: r.created_by || '', approvedBy: r.approved_by || '',
    })));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/cash-closings', CAP.cashClose, async (req, res) => {
  try {
    const { cashboxId, closingDate, countedAmount, notes } = req.body || {};
    if (!cashboxId) return res.status(400).json({ success: false, error: 'اختر الصندوق' });
    const [cb] = await db.query('SELECT balance FROM cash_boxes WHERE id=? AND is_active=1', [cashboxId]);
    if (!cb.length) return res.status(400).json({ success: false, error: 'الصندوق غير موجود' });
    const expected = Number(cb[0].balance) || 0;
    const counted = Number(countedAmount) || 0;
    const id = _id('CBC');
    await db.query(
      `INSERT INTO cashbox_closings (id, cashbox_id, closing_date, expected_balance, counted_amount, difference, notes, status, created_by)
       VALUES (?,?,?,?,?,?,?, 'draft', ?)`,
      [id, cashboxId, closingDate || new Date().toISOString().slice(0, 10), expected, counted, counted - expected, String(notes || '').slice(0, 300), _actor(req)]);
    res.json({ success: true, id, expectedBalance: expected, difference: counted - expected });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Approve: post the difference journal (surplus → Dr cashbox / Cr diff account;
// shortage → Dr diff account / Cr cashbox) and adjust the cashbox balance.
router.post('/cash-closings/:id/approve', CAP.cashClose, async (req, res) => {
  try {
    const { differenceAccountId } = req.body || {};
    const actor = _actor(req);
    const pre = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM cashbox_closings WHERE id=? FOR UPDATE', [req.params.id]);
      if (!rows.length) return { error: 'الإقفال غير موجود' };
      if (rows[0].status === 'approved') return { error: 'الإقفال معتمد مسبقًا' };
      return { row: rows[0] };
    });
    if (pre.error) return res.status(409).json({ success: false, error: pre.error });
    const row = pre.row;
    const diff = Number(row.difference) || 0;
    let journalId = null, journalNumber = null;
    if (Math.abs(diff) >= 0.01) {
      if (!differenceAccountId) return res.status(400).json({ success: false, error: 'اختر حساب فروقات الصندوق (عجز/زيادة)' });
      const [cbAcc] = await db.query('SELECT gl_account_id FROM cash_boxes WHERE id=?', [row.cashbox_id]);
      const cashCode = cbAcc.length && cbAcc[0].gl_account_id ? await _codeOf(cbAcc[0].gl_account_id) : null;
      const diffCode = await _codeOf(differenceAccountId);
      if (!cashCode || !diffCode) return res.status(400).json({ success: false, error: 'حساب غير صالح' });
      const amt = Math.abs(diff);
      const surplus = diff > 0; // counted > expected
      const entries = surplus
        ? [{ accountCode: cashCode, debit: amt, credit: 0, description: 'زيادة صندوق' },
           { accountCode: diffCode, debit: 0, credit: amt, description: 'زيادة صندوق' }]
        : [{ accountCode: diffCode, debit: amt, credit: 0, description: 'عجز صندوق' },
           { accountCode: cashCode, debit: 0, credit: amt, description: 'عجز صندوق' }];
      const closeDate = row.closing_date instanceof Date
        ? row.closing_date.toISOString().slice(0, 10)
        : (row.closing_date || new Date().toISOString().slice(0, 10));
      const posted = await glPosting.postJournal(db, {
        journalDate: closeDate,
        description: 'إقفال صندوق — فرق ' + (surplus ? 'زيادة' : 'عجز'),
        referenceType: 'cash_closing', referenceId: row.id, postedBy: actor, status: 'posted', entries,
      });
      if (!posted || posted.success === false) return res.status(400).json({ success: false, error: (posted && posted.error) || 'تعذّر ترحيل قيد الفرق' });
      journalId = posted.journalId; journalNumber = posted.journalNumber;
    }
    await db.withTransaction(async (conn) => {
      await conn.query("UPDATE cashbox_closings SET status='approved', journal_id=?, approved_by=?, approved_at=NOW() WHERE id=?",
        [journalId, actor, req.params.id]);
      // Reset the cashbox to the counted amount (the difference is now in GL).
      await conn.query('UPDATE cash_boxes SET balance=? WHERE id=?', [Number(row.counted_amount) || 0, row.cashbox_id]);
    });
    res.json({ success: true, journalId, journalNumber });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
