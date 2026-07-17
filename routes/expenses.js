const router = require('express').Router();
const db = require('../db/connection');
const gl = require('../lib/glPosting');
// G-SALES hardening — expense writes post GL / open approval workflows: gated
// by the live finance.expenses.* capability family (custody/finance/manager
// hold `view`; only finance/manager hold `approve`; admin bypasses).
const requireCapability = require('../middleware/requireCapability');

const VAT_RATE = Number(process.env.VAT_RATE) || 15;

// Map an expense payment method → GL credit account code
function _expensePaymentCredit(method) {
  const m = (method || '').toLowerCase();
  if (m === 'bank' || m === 'card' || m === 'mada' || m === 'stc' || m === 'stc_pay' || m === 'transfer') return '1120';
  if (m === 'credit' || m === 'ap' || m === 'supplier' || m === 'عاجل') return '2100';
  return '1110';  // default = cash
}

// Ensure an 'Expense' transaction_type exists (Phase C bridge target)
async function _ensureExpenseTxnType() {
  const [rows] = await db.query("SELECT id FROM transaction_types WHERE code = 'EXP' LIMIT 1");
  if (rows.length) return rows[0].id;
  const id = 'TT-EXP';
  await db.query(
    "INSERT IGNORE INTO transaction_types (id, name, code) VALUES (?,?,?)",
    [id, 'طلب صرف مستحقات', 'EXP']);
  return id;
}

// Fetch an expense approval threshold. If workflow chain exists for the
// 'EXP' type, return true so UI knows to create workflow; otherwise false
// and we fall back to legacy immediate-GL behaviour.
async function _hasExpenseWorkflow() {
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS c FROM workflow_definitions
       WHERE transaction_type_id = 'TT-EXP'`);
    return (rows[0] && rows[0].c > 0);
  } catch(e) { return false; }
}

// ─── GET ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    let query = `
      SELECT e.*, t.status AS txn_status, t.id AS txn_id, t.payment_record_id
      FROM expenses e
      LEFT JOIN transactions t ON t.reference_id = e.id AND t.reference_type = 'expense'
      WHERE 1=1`;
    const params = [];

    if (req.query.startDate) { query += ' AND DATE(e.expense_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate)   { query += ' AND DATE(e.expense_date) <= ?'; params.push(req.query.endDate); }
    if (req.query.category)  { query += ' AND e.category = ?';            params.push(req.query.category); }
    if (req.query.username)  { query += ' AND e.username = ?';            params.push(req.query.username); }
    if (req.query.status)    { query += ' AND t.status = ?';              params.push(req.query.status); }

    query += ' ORDER BY e.expense_date DESC LIMIT 500';

    const [rows] = await db.query(query, params);
    res.json(rows.map(e => ({
      id: e.id, date: e.expense_date, category: e.category,
      description: e.description, amount: Number(e.amount),
      paymentMethod: e.payment_method, username: e.username, notes: e.notes,
      // Workflow bridge fields (new)
      txnId: e.txn_id || null,
      txnStatus: e.txn_status || null,
      paymentRecordId: e.payment_record_id || null,
      isManaged: !!e.txn_id  // managed = goes through workflow (vs legacy immediate post)
    })));
  } catch (e) {
    // G-SALES error honesty — was res.json([]) with HTTP 200: a DB failure
    // rendered as "no expenses" on the finance screen.
    console.error('[expenses GET]', e.message);
    res.status(500).json({ success: false, error: 'تعذّر تحميل المصروفات', code: 'expenses_list_failed' });
  }
});

// ─── POST — Create expense ───
// Phase C behavior:
//   - If expense workflow chain exists (workflow_definitions for TT-EXP)
//       → create a `transactions` row, status='pending'
//       → DO NOT post GL yet (will post at payment close)
//   - Else (legacy, no workflow defined)
//       → keep old immediate-GL behavior for backward compatibility
router.post('/', requireCapability('finance.expenses.view'), async (req, res) => {
  try {
    const {
      category, description, amount, paymentMethod, notes, date,
      accountCode, hasVat, brandId, branchId, costCenterId,
      forceLegacy  // optional client flag to skip workflow (emergency bypass)
    } = req.body;
    // G-SALES — the actor is the AUTHENTICATED user, never the body. The old
    // req.body.username let a caller file an expense under any user's name
    // (HR-profile resolution + workflow initiator + GL postedBy attribution).
    const username = req.user.username;

    const expenseId = 'EXP-' + Date.now();
    const expenseDate = date ? new Date(date) : new Date();

    // Resolve brand/branch from the creator's HR profile if not supplied
    let resolvedBrandId  = brandId  || null;
    let resolvedBranchId = branchId || null;
    if ((!resolvedBrandId || !resolvedBranchId) && username) {
      try {
        const [u] = await db.query(
          'SELECT brand_id, branch_id FROM users WHERE username = ? LIMIT 1', [username]);
        if (u.length) {
          if (!resolvedBrandId)  resolvedBrandId  = u[0].brand_id  || null;
          if (!resolvedBranchId) resolvedBranchId = u[0].branch_id || null;
        }
      } catch(e) { /* no-op — column may not yet exist in dev */ }
    }

    // Insert expense row (with brand/branch if columns present)
    await db.query(
      'INSERT INTO expenses (id, expense_date, category, description, amount, payment_method, username, notes, brand_id, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [expenseId, expenseDate, category || '', description || '', amount || 0,
       paymentMethod || 'Cash', username || '', notes || '',
       resolvedBrandId, resolvedBranchId]);

    const totalAmount = Number(amount) || 0;
    const useWorkflow = !forceLegacy && await _hasExpenseWorkflow();

    if (useWorkflow && totalAmount > 0) {
      // Phase C path: create workflow transaction, defer GL
      try {
        await _ensureExpenseTxnType();
        // Resolve initiator position from the creator's HR record
        let initiatorPosId = null;
        try {
          const [p] = await db.query(
            `SELECT hr.position_id FROM hr_employees hr WHERE hr.username = ? LIMIT 1`,
            [username || '']);
          if (p.length) initiatorPosId = p[0].position_id;
        } catch(e) { /* best-effort */ }

        // First step of the workflow (amount-aware)
        let firstStep = null;
        if (initiatorPosId) {
          const [step] = await db.query(
            `SELECT * FROM position_workflow_steps
             WHERE initiator_position_id = ? AND step_order = 1
               AND COALESCE(amount_from, 0) <= ?
               AND (amount_to IS NULL OR amount_to >= ?)
             ORDER BY COALESCE(amount_from, 0) DESC
             LIMIT 1`,
            [initiatorPosId, totalAmount, totalAmount]);
          if (step.length) firstStep = step[0];
        }
        if (!firstStep) {
          const [legacy] = await db.query(
            `SELECT id, required_position_id FROM workflow_definitions
             WHERE transaction_type_id = 'TT-EXP' AND step_order = 1 LIMIT 1`);
          if (legacy.length) firstStep = { id: legacy[0].id, required_position_id: legacy[0].required_position_id };
        }

        // Create transaction row
        const txnId = 'TXN-' + Date.now();
        const txnNum = 'TXN-EXP-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' +
          String(Math.floor(Math.random() * 10000)).padStart(4, '0');

        await db.query(
          `INSERT INTO transactions
           (id, transaction_number, transaction_type_id, title, subject, description,
            amount, status, current_step_id, initiator_position_id,
            branch_id, brand_id, created_by, requires_payment, reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [txnId, txnNum, 'TT-EXP',
           'مصروف: ' + (category || '') + (description ? ' — ' + description.substring(0, 60) : ''),
           description || category || '', notes || description || '',
           totalAmount, 'pending',
           firstStep ? firstStep.id : null, initiatorPosId,
           branchId || null, brandId || null, username || '',
           1, 'expense', expenseId]);

        return res.json({
          success: true, id: expenseId, txnId: txnId, txnNumber: txnNum,
          managed: true, message: 'تم إرسال طلب المصروف للاعتماد — لن يُرحَّل القيد إلا بعد إتمام الدفع'
        });
      } catch(bridgeErr) {
        console.error('[expenses POST workflow bridge]', bridgeErr.message);
        // Fall through to legacy path
      }
    }

    // ═══ LEGACY PATH (no workflow defined, or bridge failed) ═══
    let postingWarning = null;
    if (totalAmount > 0) {
      try {
        let net = totalAmount, vat = 0;
        if (hasVat) {
          net = Math.round((totalAmount / (1 + VAT_RATE / 100)) * 100) / 100;
          vat = Math.round((totalAmount - net) * 100) / 100;
        }
        const expAcct = accountCode || '5200';
        const payAcct = _expensePaymentCredit(paymentMethod);

        const entries = [
          { accountCode: expAcct, debit: net, credit: 0,
            description: 'Expense — ' + (description || category || expenseId),
            branchId: branchId || null, brandId: brandId || null, costCenterId: costCenterId || null }
        ];
        if (vat > 0) {
          entries.push({
            accountCode: '1290', debit: vat, credit: 0,
            description: 'Input VAT — ' + expenseId,
            branchId: branchId || null, brandId: brandId || null
          });
        }
        entries.push({
          accountCode: payAcct, debit: 0, credit: totalAmount,
          description: 'Payment — ' + (paymentMethod || 'cash'),
          brandId: brandId || null
        });

        const post = await gl.postJournal(db, {
          journalDate: expenseDate.toISOString().slice(0, 10),
          description: 'Expense ' + expenseId + ' — ' + (description || category || ''),
          referenceType: 'Expense',
          referenceId: expenseId,
          entries,
          postedBy: username || ''
        });
        if (!post.success) postingWarning = post.error;
      } catch(e) { postingWarning = e.message; }
    }

    res.json({ success: true, id: expenseId, managed: false, postingWarning });
  } catch (e) {
    // G-SALES error honesty — was res.json({success:false}) with HTTP 200.
    console.error('[expenses POST]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete expense — G-SALES: destructive + GL-affecting → `finance.expenses.approve`
// (sensitive; live grant = finance/manager, admin bypasses).
router.delete('/:id', requireCapability('finance.expenses.approve'), async (req, res) => {
  try {
    await db.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    // G-SALES error honesty — destructive endpoint must never mask failure as 200.
    console.error('[expenses DELETE]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
