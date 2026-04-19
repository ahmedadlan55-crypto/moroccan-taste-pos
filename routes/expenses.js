const router = require('express').Router();
const db = require('../db/connection');
const gl = require('../lib/glPosting');

const VAT_RATE = Number(process.env.VAT_RATE) || 15;

// Map an expense payment method → GL credit account code
// (cash/card/stc → bank or cash; supplier/ap → AP)
function _expensePaymentCredit(method) {
  const m = (method || '').toLowerCase();
  if (m === 'bank' || m === 'card' || m === 'mada' || m === 'stc' || m === 'stc_pay' || m === 'transfer') return '1120';
  if (m === 'credit' || m === 'ap' || m === 'supplier' || m === 'عاجل') return '2100';
  return '1110';  // default = cash
}

// Get expenses (with date filters)
router.get('/', async (req, res) => {
  try {
    let query = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];

    if (req.query.startDate) { query += ' AND DATE(expense_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND DATE(expense_date) <= ?'; params.push(req.query.endDate); }
    if (req.query.category) { query += ' AND category = ?'; params.push(req.query.category); }
    if (req.query.username) { query += ' AND username = ?'; params.push(req.query.username); }

    query += ' ORDER BY expense_date DESC LIMIT 500';

    const [rows] = await db.query(query, params);
    res.json(rows.map(e => ({
      id: e.id, date: e.expense_date, category: e.category,
      description: e.description, amount: Number(e.amount),
      paymentMethod: e.payment_method, username: e.username, notes: e.notes
    })));
  } catch (e) {
    res.json([]);
  }
});

// Add expense (with optional auto-GL posting)
router.post('/', async (req, res) => {
  try {
    const {
      category, description, amount, paymentMethod, username, notes, date,
      // Optional GL / dimension hints
      accountCode,        // e.g. '5200' — overrides category-based fallback
      hasVat,             // if true, amount is VAT-inclusive; split net + input VAT
      brandId, branchId, costCenterId
    } = req.body;

    const expenseId = 'EXP-' + Date.now();
    const expenseDate = date ? new Date(date) : new Date();

    await db.query(
      'INSERT INTO expenses (id, expense_date, category, description, amount, payment_method, username, notes) VALUES (?,?,?,?,?,?,?,?)',
      [expenseId, expenseDate, category || '', description || '', amount || 0, paymentMethod || 'Cash', username || '', notes || '']
    );

    // ═══ AUTO GL POSTING ═══
    // Dr Expense Account (from accountCode or 5200 default) + optional Dr Input VAT
    // Cr Cash / Bank / AP (depending on payment method)
    let postingWarning = null;
    const totalAmount = Number(amount) || 0;
    if (totalAmount > 0) {
      try {
        let net = totalAmount, vat = 0;
        if (hasVat) {
          net = Math.round((totalAmount / (1 + VAT_RATE / 100)) * 100) / 100;
          vat = Math.round((totalAmount - net) * 100) / 100;
        }
        const expAcct = accountCode || '5200';   // default: waste/misc expense bucket
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

    res.json({ success: true, id: expenseId, postingWarning });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete expense
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
