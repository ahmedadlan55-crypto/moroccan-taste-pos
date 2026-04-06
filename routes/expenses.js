const router = require('express').Router();
const db = require('../db/connection');

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

// Add expense
router.post('/', async (req, res) => {
  try {
    const { category, description, amount, paymentMethod, username, notes, date } = req.body;
    const expenseId = 'EXP-' + Date.now();
    const expenseDate = date ? new Date(date) : new Date();

    await db.query(
      'INSERT INTO expenses (id, expense_date, category, description, amount, payment_method, username, notes) VALUES (?,?,?,?,?,?,?,?)',
      [expenseId, expenseDate, category || '', description || '', amount || 0, paymentMethod || 'Cash', username || '', notes || '']
    );

    res.json({ success: true, id: expenseId });
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
