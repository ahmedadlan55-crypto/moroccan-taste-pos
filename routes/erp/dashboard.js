// ═══════════════════════════════════════════════════════════════════
// /api/erp/dashboard — Admin dashboard KPIs
//
// Returns the headline numbers shown on the admin home page:
// today's sales / expenses / purchases, low-stock count, active
// customers + suppliers, open shifts, and a 30-day rolling sales,
// expense, and profit total.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

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

module.exports = router;
