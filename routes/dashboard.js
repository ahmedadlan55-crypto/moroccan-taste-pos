const router = require('express').Router();
const db = require('../db/connection');

// ═══════════════════════════════════════════════════════════════════
// Enterprise Command Center — single-call aggregator
// GET /api/dashboard/overview?brandId=&branchId=&from=YYYY-MM-DD&to=YYYY-MM-DD&preset=today|week|month|quarter|year
// ═══════════════════════════════════════════════════════════════════

function _ymd(d) { return d.toISOString().slice(0, 10); }

function _resolvePeriod(query) {
  const now = new Date();
  const today = _ymd(now);
  let from = query.from || today;
  let to   = query.to   || today;

  const p = (query.preset || '').toLowerCase();
  if (p === 'today')   { from = today; to = today; }
  else if (p === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    from = _ymd(y); to = from;
  }
  else if (p === 'week')    { const d=new Date(now); d.setDate(d.getDate()-6); from = _ymd(d); to = today; }
  else if (p === 'month')   { const d=new Date(now.getFullYear(), now.getMonth(), 1); from = _ymd(d); to = today; }
  else if (p === 'quarter') { const qStart = Math.floor(now.getMonth()/3)*3; const d=new Date(now.getFullYear(), qStart, 1); from = _ymd(d); to = today; }
  else if (p === 'year')    { const d=new Date(now.getFullYear(), 0, 1); from = _ymd(d); to = today; }
  return { from, to, preset: p };
}

function _sum(rows, col) { return rows.reduce((s, r) => s + Number(r[col] || 0), 0); }
function _pctChange(curr, prev) {
  if (!prev || prev === 0) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

router.get('/overview', async (req, res) => {
  try {
    const { brandId, branchId } = req.query;
    const { from, to } = _resolvePeriod(req.query);

    // Previous-period window (same length, immediately before "from") for
    // week-over-week comparisons
    const fromD = new Date(from + 'T00:00:00');
    const toD   = new Date(to   + 'T00:00:00');
    const rangeDays = Math.max(1, Math.round((toD - fromD) / 86400000) + 1);
    const prevTo   = new Date(fromD); prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (rangeDays - 1));

    const brandFilter  = brandId  ? ' AND brand_id = ?'  : '';
    const branchFilter = branchId ? ' AND branch_id = ?' : '';
    const brandParam   = brandId  ? [brandId] : [];
    const branchParam  = branchId ? [branchId] : [];

    // ─── PARALLEL queries (use Promise.all for speed) ───
    const [
      salesCurr, salesPrev, ordersCurr, ordersPrev,
      expCurr, expPrev, purCurr, purPrev,
      dailySales, hourlyToday, topItems, topCashiers,
      lowStock, expiringSoon,
      openTxns, pendingPayments, overdueAR, overdueAP,
      openShifts, cashPosition, bankBalances,
      suppliersCnt, customersCnt, brandsCnt, branchesCnt,
      topBrands
    ] = await Promise.all([
      // Sales total in range
      db.query(
        `SELECT COALESCE(SUM(total_final),0) AS v, COUNT(*) AS c
         FROM sales WHERE DATE(order_date) BETWEEN ? AND ?`,
        [from, to]),
      db.query(
        `SELECT COALESCE(SUM(total_final),0) AS v, COUNT(*) AS c
         FROM sales WHERE DATE(order_date) BETWEEN ? AND ?`,
        [_ymd(prevFrom), _ymd(prevTo)]),
      // Orders (per-row count; kept separately for clarity)
      db.query(
        `SELECT COUNT(*) AS c FROM sales WHERE DATE(order_date) BETWEEN ? AND ?`,
        [from, to]),
      db.query(
        `SELECT COUNT(*) AS c FROM sales WHERE DATE(order_date) BETWEEN ? AND ?`,
        [_ymd(prevFrom), _ymd(prevTo)]),
      // Expenses
      db.query(
        `SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE DATE(expense_date) BETWEEN ? AND ?`,
        [from, to]),
      db.query(
        `SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE DATE(expense_date) BETWEEN ? AND ?`,
        [_ymd(prevFrom), _ymd(prevTo)]),
      // Purchases
      db.query(
        `SELECT COALESCE(SUM(total_price),0) AS v FROM purchases WHERE DATE(purchase_date) BETWEEN ? AND ? ${brandFilter} ${branchFilter}`,
        [from, to, ...brandParam, ...branchParam]),
      db.query(
        `SELECT COALESCE(SUM(total_price),0) AS v FROM purchases WHERE DATE(purchase_date) BETWEEN ? AND ? ${brandFilter} ${branchFilter}`,
        [_ymd(prevFrom), _ymd(prevTo), ...brandParam, ...branchParam]),
      // Daily sales trend (for chart)
      db.query(
        `SELECT DATE(order_date) AS d,
                COALESCE(SUM(total_final),0) AS total,
                COUNT(*) AS cnt
         FROM sales WHERE DATE(order_date) BETWEEN ? AND ?
         GROUP BY DATE(order_date) ORDER BY d`,
        [from, to]),
      // Hourly today (for chart)
      db.query(
        `SELECT HOUR(order_date) AS h, COALESCE(SUM(total_final),0) AS total
         FROM sales WHERE DATE(order_date) = CURDATE()
         GROUP BY HOUR(order_date) ORDER BY h`),
      // Top 10 items in range
      db.query(
        `SELECT item_name AS name, SUM(qty) AS qty, SUM(line_total) AS rev
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE DATE(s.order_date) BETWEEN ? AND ?
         GROUP BY item_name ORDER BY rev DESC LIMIT 10`,
        [from, to]).catch(() => [[]]),
      // Top cashiers
      db.query(
        `SELECT username, COUNT(*) AS orders, COALESCE(SUM(total_final),0) AS total
         FROM sales WHERE DATE(order_date) BETWEEN ? AND ?
         GROUP BY username ORDER BY total DESC LIMIT 5`,
        [from, to]),
      // Low stock items
      db.query(
        `SELECT id, name, stock, min_stock, unit FROM inv_items
         WHERE active = 1 AND stock <= min_stock ORDER BY (min_stock - stock) DESC LIMIT 10`),
      // Expiring within 30 days
      db.query(
        `SELECT item_name AS name, batch_number, expiry_date, qty
         FROM inv_batches WHERE expiry_date IS NOT NULL
           AND expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
           AND qty > 0 ORDER BY expiry_date ASC LIMIT 10`).catch(() => [[]]),
      // Open workflow transactions
      db.query(
        `SELECT COUNT(*) AS c FROM transactions
         WHERE status IN ('pending','in_progress','approved_pending_payment')`).catch(() => [[{c:0}]]),
      // Pending payments
      db.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS v FROM payment_records
         WHERE status IN ('requested','authorized')`).catch(() => [[{c:0, v:0}]]),
      // AR overdue (customers owing)
      db.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(balance),0) AS v FROM customers
         WHERE balance > 0 AND is_active = 1`).catch(() => [[{c:0, v:0}]]),
      // AP overdue (suppliers we owe)
      db.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(balance),0) AS v FROM suppliers
         WHERE balance > 0 AND is_active = 1`).catch(() => [[{c:0, v:0}]]),
      // Open shifts
      db.query(`SELECT COUNT(*) AS c FROM shifts WHERE status='OPEN'`),
      // Cash position (sum of today's cash sales - today's expenses paid cash)
      db.query(`SELECT
          (SELECT COALESCE(SUM(amount),0) FROM sale_payments sp
            JOIN sales s ON s.id = sp.sale_id
            WHERE DATE(s.order_date) = CURDATE() AND sp.method = 'cash')
          -
          (SELECT COALESCE(SUM(amount),0) FROM expenses
            WHERE DATE(expense_date) = CURDATE() AND payment_method = 'cash')
          AS cash`).catch(() => [[{cash:0}]]),
      // Bank balances
      db.query(
        `SELECT account_name, bank_name, current_balance FROM bank_accounts
         WHERE is_active = 1 ORDER BY current_balance DESC LIMIT 10`).catch(() => [[]]),
      // Counts
      db.query(`SELECT COUNT(*) AS c FROM suppliers WHERE is_active = 1`),
      db.query(`SELECT COUNT(*) AS c FROM customers WHERE is_active = 1`),
      db.query(`SELECT COUNT(*) AS c FROM brands`).catch(() => [[{c:0}]]),
      db.query(`SELECT COUNT(*) AS c FROM branches`).catch(() => [[{c:0}]]),
      // Top brands by purchase value
      db.query(
        `SELECT b.id, b.name, COALESCE(SUM(p.total_price),0) AS total, COUNT(p.id) AS cnt
         FROM brands b LEFT JOIN purchases p ON p.brand_id = b.id
             AND DATE(p.purchase_date) BETWEEN ? AND ?
         GROUP BY b.id, b.name ORDER BY total DESC LIMIT 5`,
        [from, to]).catch(() => [[]])
    ]);

    // Extract values
    const salesV = Number(salesCurr[0][0].v || 0);
    const salesC = Number(salesCurr[0][0].c || 0);
    const salesVPrev = Number(salesPrev[0][0].v || 0);
    const ordersC = Number(ordersCurr[0][0].c || 0);
    const ordersCPrev = Number(ordersPrev[0][0].c || 0);
    const expV = Number(expCurr[0][0].v || 0);
    const expVPrev = Number(expPrev[0][0].v || 0);
    const purV = Number(purCurr[0][0].v || 0);
    const purVPrev = Number(purPrev[0][0].v || 0);

    res.json({
      period: { from, to, rangeDays, prevFrom: _ymd(prevFrom), prevTo: _ymd(prevTo) },
      filters: { brandId: brandId || '', branchId: branchId || '' },

      // Executive KPIs
      kpi: {
        sales:      { value: salesV,    prev: salesVPrev,  delta: _pctChange(salesV, salesVPrev) },
        orders:     { value: ordersC,   prev: ordersCPrev, delta: _pctChange(ordersC, ordersCPrev) },
        avgTicket:  { value: ordersC ? salesV / ordersC : 0, prev: ordersCPrev ? salesVPrev / ordersCPrev : 0,
                      delta: _pctChange(ordersC ? salesV/ordersC : 0, ordersCPrev ? salesVPrev/ordersCPrev : 0) },
        expenses:   { value: expV,      prev: expVPrev,    delta: _pctChange(expV, expVPrev) },
        purchases:  { value: purV,      prev: purVPrev,    delta: _pctChange(purV, purVPrev) },
        netIncome:  { value: salesV - expV, prev: salesVPrev - expVPrev,
                      delta: _pctChange(salesV - expV, salesVPrev - expVPrev) },
        grossMargin:{ value: salesV > 0 ? ((salesV - purV) / salesV) * 100 : 0 }
      },

      // Operational pulse
      ops: {
        openShifts:      Number(openShifts[0][0].c || 0),
        openTransactions:Number(openTxns[0][0].c || 0),
        pendingPayments: { count: Number(pendingPayments[0][0].c || 0), amount: Number(pendingPayments[0][0].v || 0) },
        arOutstanding:   { count: Number(overdueAR[0][0].c || 0), amount: Number(overdueAR[0][0].v || 0) },
        apOutstanding:   { count: Number(overdueAP[0][0].c || 0), amount: Number(overdueAP[0][0].v || 0) },
        cashInHand:      Number(cashPosition[0][0].cash || 0),
        lowStockCount:   lowStock[0].length,
        expiringCount:   expiringSoon[0].length
      },

      // Entity counters
      counts: {
        suppliers: Number(suppliersCnt[0][0].c || 0),
        customers: Number(customersCnt[0][0].c || 0),
        brands:    Number(brandsCnt[0][0].c || 0),
        branches:  Number(branchesCnt[0][0].c || 0)
      },

      // Charts
      charts: {
        dailySales:  dailySales[0].map(r => ({ date: _ymd(new Date(r.d)), total: Number(r.total), count: Number(r.cnt) })),
        hourlyToday: hourlyToday[0].map(r => ({ hour: Number(r.h), total: Number(r.total) })),
        topItems:    topItems[0].map(r => ({ name: r.name, qty: Number(r.qty), revenue: Number(r.rev) })),
        topCashiers: topCashiers[0].map(r => ({ name: r.username, orders: Number(r.orders), total: Number(r.total) })),
        topBrands:   topBrands[0].map(r => ({ id: r.id, name: r.name, total: Number(r.total), count: Number(r.cnt) }))
      },

      // Alerts lists
      alerts: {
        lowStock: lowStock[0].map(r => ({
          id: r.id, name: r.name,
          stock: Number(r.stock || 0),
          minStock: Number(r.min_stock || 0),
          unit: r.unit || 'وحدة',
          shortfall: Math.max(0, Number(r.min_stock || 0) - Number(r.stock || 0))
        })),
        expiringSoon: expiringSoon[0].map(r => ({
          name: r.name, batchNumber: r.batch_number,
          expiryDate: r.expiry_date ? _ymd(new Date(r.expiry_date)) : null,
          qty: Number(r.qty || 0),
          daysLeft: r.expiry_date ? Math.ceil((new Date(r.expiry_date) - new Date()) / 86400000) : null
        })),
        bankBalances: bankBalances[0].map(r => ({
          name: r.account_name || r.bank_name,
          bank: r.bank_name,
          balance: Number(r.current_balance || 0)
        }))
      }
    });
  } catch (e) {
    console.error('Dashboard overview error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
