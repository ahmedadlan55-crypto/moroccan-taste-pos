const router = require('express').Router();
const db = require('../db/connection');

// Save order
router.post('/', async (req, res) => {
  try {
    const { items, total, totalFinal, paymentMethod, discountName, discountAmount, kitaServiceFee, splitDetails } = req.body;
    const { username, shiftId, warehouseId: reqWhId } = req.body;
    const warehouseId = reqWhId || (req.user && req.user.default_warehouse_id) || null;
    const orderId = shiftId + '-' + Date.now();
    const now = new Date();

    // Determine payment method string
    let payStr = paymentMethod;
    if (paymentMethod === 'Split' && splitDetails) {
      payStr = Object.entries(splitDetails).filter(([k,v]) => v > 0).map(([k,v]) => k+':'+Math.round(v)).join('/');
    }

    // Insert sale
    await db.query('INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, discount_name, discount_amount, kita_service_fee) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [orderId, now, JSON.stringify(items), totalFinal, payStr, username, shiftId, discountName || '', discountAmount || 0, kitaServiceFee || 0]);

    // Build recipe map: menu_id → [{ invId, invName, qtyUsed }]
    // Fetch ingredient name too so the inventory_movements row carries it.
    const [recipes] = await db.query('SELECT * FROM recipe');
    const recipeMap = {};
    recipes.forEach(r => {
      if (!recipeMap[r.menu_id]) recipeMap[r.menu_id] = [];
      recipeMap[r.menu_id].push({
        invId: r.inv_item_id,
        invName: r.inv_item_name || '',
        qtyUsed: Number(r.qty_used)
      });
    });

    // Production: removed debug log

    // Diagnostic info to return to the frontend so we can verify deductions worked
    const recipesApplied = []; // [{ menuId, menuName, deductions: [{invId, invName, deducted, affected}] }]
    const itemsWithoutRecipe = []; // menu items that have no recipe attached

    for (const item of items) {
      // sales_items log row
      await db.query('INSERT INTO sales_items (order_id, order_date, item_name, qty, price, total, payment_method, username, shift_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [orderId, now, item.name, item.qty, item.price, item.qty * item.price, payStr, username, shiftId]);

      // Stock deduction via recipe.
      if (!item.id) {
        // Production: removed debug log
        itemsWithoutRecipe.push({ name: item.name, reason: 'no item id' });
        continue;
      }
      if (!recipeMap[item.id]) {
        // Production: removed debug log
        itemsWithoutRecipe.push({ id: item.id, name: item.name, reason: 'no recipe defined' });
        continue;
      }

      const deductions = [];
      for (const ing of recipeMap[item.id]) {
        const deduct = ing.qtyUsed * item.qty;

        // CRITICAL: deduct from central inventory
        const [updateResult] = await db.query(
          'UPDATE inv_items SET stock = stock - ? WHERE id = ?',
          [deduct, ing.invId]
        );
        const affected = updateResult.affectedRows;

        // Deduct from warehouse stock (branch-specific)
        if (warehouseId) {
          await db.query(
            'UPDATE warehouse_stock SET qty = GREATEST(0, qty - ?) WHERE warehouse_id = ? AND item_id = ?',
            [deduct, warehouseId, ing.invId]
          );
        }

        // Record movement with warehouse reference
        const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4) + '-' + deductions.length;
        await db.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [movId, now, ing.invId, ing.invName, 'out', deduct, 'مبيعات', username, orderId, warehouseId || null]
        );

        deductions.push({
          invId: ing.invId,
          invName: ing.invName,
          deducted: deduct,
          affected: affected
        });
      }

      recipesApplied.push({
        menuId: item.id,
        menuName: item.name,
        deductions: deductions
      });
    }

    // Production: removed debug log

    res.json({
      success: true,
      orderId,
      recipesApplied: recipesApplied,
      itemsWithoutRecipe: itemsWithoutRecipe
    });
  } catch (e) {
    // Production: removed debug log
    res.json({ success: false, error: e.message });
  }
});

// Get sales list (detailed)
router.get('/', async (req, res) => {
  try {
    let query = 'SELECT * FROM sales WHERE 1=1';
    const params = [];
    if (req.query.startDate) { query += ' AND DATE(order_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND DATE(order_date) <= ?'; params.push(req.query.endDate); }
    if (req.query.username) { query += ' AND username = ?'; params.push(req.query.username); }
    if (req.query.paymentMethod) { query += ' AND LOWER(payment_method) = ?'; params.push(req.query.paymentMethod.toLowerCase()); }
    query += ' ORDER BY order_date DESC LIMIT 500';

    const [rows] = await db.query(query, params);
    res.json(rows.map(r => ({
      orderId: r.id, date: r.order_date, total: Number(r.total_final),
      payment: r.payment_method, username: r.username,
      items: JSON.parse(r.items_json || '[]'),
      discount: Number(r.discount_amount) || 0, shiftId: r.shift_id
    })));
  } catch (e) { res.json([]); }
});

// Get invoice
router.get('/invoice/:orderId', async (req, res) => {
  try {
    const [sales] = await db.query('SELECT * FROM sales WHERE id = ?', [req.params.orderId]);
    if (!sales.length) return res.json(null);
    const sale = sales[0];
    const [items] = await db.query('SELECT * FROM sales_items WHERE order_id = ?', [req.params.orderId]);
    res.json({
      orderId: sale.id, date: sale.order_date, payment: sale.payment_method,
      totalFinal: Number(sale.total_final), username: sale.username,
      discountName: sale.discount_name, discountAmount: Number(sale.discount_amount),
      items: items.map(i => ({ name: i.item_name, qty: i.qty, price: Number(i.price), total: Number(i.total) }))
    });
  } catch (e) { res.json(null); }
});

// Delete sale (developer only — frontend checks isDeveloper)
router.delete('/:orderId', async (req, res) => {
  try {
    await db.query('DELETE FROM sales WHERE id = ?', [req.params.orderId]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Bulk delete sales
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ success: false, error: 'No IDs' });
    const placeholders = ids.map(() => '?').join(',');
    await db.query('DELETE FROM sales WHERE id IN (' + placeholders + ')', ids);
    res.json({ success: true, deleted: ids.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// ADVANCED FULL REPORT (التقارير المتطورة)
// ═══════════════════════════════════════

router.get('/report/advanced', async (req, res) => {
  try {
    const { startDate, endDate, username, paymentMethod } = req.query;

    // Build WHERE clause for sales
    let salesWhere = '1=1';
    const salesParams = [];
    if (startDate) { salesWhere += ' AND DATE(order_date) >= ?'; salesParams.push(startDate); }
    if (endDate)   { salesWhere += ' AND DATE(order_date) <= ?'; salesParams.push(endDate); }
    if (username)  { salesWhere += ' AND username = ?'; salesParams.push(username); }
    if (paymentMethod) { salesWhere += ' AND LOWER(payment_method) LIKE ?'; salesParams.push('%' + paymentMethod.toLowerCase() + '%'); }

    // 1) Fetch all sales in range (we need rows for payment parsing + product detail)
    const [allSales] = await db.query(
      `SELECT id, order_date, items_json, total_final, payment_method, username,
              discount_name, discount_amount, kita_service_fee
       FROM sales WHERE ${salesWhere} ORDER BY order_date`, salesParams
    );

    // ── Aggregate stats ──
    let totalSales = 0, totalDiscount = 0, totalKitaFees = 0;
    const orderCount = allSales.length;
    allSales.forEach(s => {
      totalSales += Number(s.total_final) || 0;
      totalDiscount += Number(s.discount_amount) || 0;
      totalKitaFees += Number(s.kita_service_fee) || 0;
    });

    // ── Payment method breakdown (supports split: "cash:100/card:50") ──
    const pay = { cash: { total: 0, count: 0 }, card: { total: 0, count: 0 }, kita: { total: 0, count: 0 } };

    function addPayment(method, amount) {
      const m = method.toLowerCase().trim();
      if (m.includes('kita'))      { pay.kita.total += amount; pay.kita.count++; }
      else if (m.includes('card') || m.includes('mada') || m.includes('شبكة') || m.includes('مدى'))
                                   { pay.card.total += amount; pay.card.count++; }
      else                         { pay.cash.total += amount; pay.cash.count++; }
    }

    allSales.forEach(s => {
      const pm = (s.payment_method || 'cash').trim();
      const total = Number(s.total_final) || 0;
      // Check for split payment format: "cash:100/card:50"
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, amt] = part.split(':');
          if (method && amt) addPayment(method, Number(amt) || 0);
        });
      } else {
        addPayment(pm, total);
      }
    });

    // ── Charts data ──

    // Sales by day
    const dayMap = {};
    allSales.forEach(s => {
      const d = new Date(s.order_date);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      dayMap[key] = (dayMap[key] || 0) + (Number(s.total_final) || 0);
    });
    const salesByDay = Object.entries(dayMap).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, value]) => ({ label, value }));

    // Sales by hour
    const hourMap = {};
    for (let i = 0; i < 24; i++) hourMap[i] = 0;
    allSales.forEach(s => {
      const h = new Date(s.order_date).getHours();
      hourMap[h] += Number(s.total_final) || 0;
    });
    const salesByHour = Object.entries(hourMap).map(([h, value]) => ({ label: h + ':00', value }));

    // Sales by cashier
    const cashierMap = {};
    allSales.forEach(s => {
      const u = s.username || 'unknown';
      if (!cashierMap[u]) cashierMap[u] = { total: 0, count: 0, cash: 0, card: 0, kita: 0 };
      cashierMap[u].total += Number(s.total_final) || 0;
      cashierMap[u].count++;
      // Payment breakdown per cashier
      const pm = (s.payment_method || 'cash').trim();
      const amt = Number(s.total_final) || 0;
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, a] = part.split(':');
          const val = Number(a) || 0;
          const ml = (method || '').toLowerCase();
          if (ml.includes('kita')) cashierMap[u].kita += val;
          else if (ml.includes('card') || ml.includes('mada')) cashierMap[u].card += val;
          else cashierMap[u].cash += val;
        });
      } else {
        const ml = pm.toLowerCase();
        if (ml.includes('kita')) cashierMap[u].kita += amt;
        else if (ml.includes('card') || ml.includes('mada') || ml.includes('شبكة') || ml.includes('مدى')) cashierMap[u].card += amt;
        else cashierMap[u].cash += amt;
      }
    });
    const salesByCashier = Object.entries(cashierMap)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([label, v]) => ({ label, value: v.total }));

    // Top products (from items_json)
    const prodMap = {}; // name → {qty, revenue, orders}
    allSales.forEach(s => {
      try {
        const items = JSON.parse(s.items_json || '[]');
        const orderProducts = new Set();
        items.forEach(item => {
          const name = item.name || 'Unknown';
          if (!prodMap[name]) prodMap[name] = { qty: 0, revenue: 0, orders: 0 };
          prodMap[name].qty += Number(item.qty) || 0;
          prodMap[name].revenue += (Number(item.qty) || 0) * (Number(item.price) || 0);
          orderProducts.add(name);
        });
        orderProducts.forEach(n => { prodMap[n].orders++; });
      } catch (e) { /* ignore parse errors */ }
    });
    const topProducts = Object.entries(prodMap)
      .sort((a, b) => b[1].qty - a[1].qty)
      .slice(0, 5)
      .map(([label, v]) => ({ label, value: v.qty }));

    // ── Tables data ──

    // Daily detail
    const dailyMap = {};
    allSales.forEach(s => {
      const d = new Date(s.order_date);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (!dailyMap[key]) dailyMap[key] = { date: key, cash: 0, card: 0, kita: 0, total: 0, orders: 0, discount: 0 };
      dailyMap[key].total += Number(s.total_final) || 0;
      dailyMap[key].orders++;
      dailyMap[key].discount += Number(s.discount_amount) || 0;
      // Payment breakdown per day
      const pm = (s.payment_method || 'cash').trim();
      const amt = Number(s.total_final) || 0;
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, a] = part.split(':');
          const val = Number(a) || 0;
          const ml = (method || '').toLowerCase();
          if (ml.includes('kita')) dailyMap[key].kita += val;
          else if (ml.includes('card') || ml.includes('mada')) dailyMap[key].card += val;
          else dailyMap[key].cash += val;
        });
      } else {
        const ml = pm.toLowerCase();
        if (ml.includes('kita')) dailyMap[key].kita += amt;
        else if (ml.includes('card') || ml.includes('mada') || ml.includes('شبكة') || ml.includes('مدى')) dailyMap[key].card += amt;
        else dailyMap[key].cash += amt;
      }
    });
    const dailyDetail = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // Cashier detail
    const cashierDetail = Object.entries(cashierMap)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, v]) => ({ name, cash: v.cash, card: v.card, kita: v.kita, total: v.total, orders: v.count }));

    // Product detail (all products, sorted by qty)
    const productDetail = Object.entries(prodMap)
      .sort((a, b) => b[1].qty - a[1].qty)
      .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue, orders: v.orders }));

    // ── Expenses by category (date filters only) ──
    let expWhere = '1=1';
    const expParams = [];
    if (startDate) { expWhere += ' AND DATE(expense_date) >= ?'; expParams.push(startDate); }
    if (endDate)   { expWhere += ' AND DATE(expense_date) <= ?'; expParams.push(endDate); }

    const [expRows] = await db.query(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS cnt FROM expenses
       WHERE ${expWhere} GROUP BY category ORDER BY total DESC`, expParams
    );
    const expensesByCategory = expRows.map(r => ({ category: r.category || 'أخرى', total: Number(r.total), count: r.cnt }));
    const totalExp = expensesByCategory.reduce((sum, e) => sum + e.total, 0);

    // ── Purchases by supplier (date filters only, received only) ──
    let purWhere = "status = 'received'";
    const purParams = [];
    if (startDate) { purWhere += ' AND DATE(purchase_date) >= ?'; purParams.push(startDate); }
    if (endDate)   { purWhere += ' AND DATE(purchase_date) <= ?'; purParams.push(endDate); }

    const [purRows] = await db.query(
      `SELECT supplier_name, SUM(total_price) AS total, COUNT(*) AS cnt FROM purchases
       WHERE ${purWhere} GROUP BY supplier_name ORDER BY total DESC`, purParams
    );
    const purchasesBySupplier = purRows.map(r => ({ supplier: r.supplier_name || 'غير محدد', total: Number(r.total), count: r.cnt }));
    const totalPur = purchasesBySupplier.reduce((sum, p) => sum + p.total, 0);

    // ── Computed stats ──
    const activeDays = salesByDay.length || 1;
    const avgOrderValue = orderCount > 0 ? totalSales / orderCount : 0;
    const avgDailyRevenue = totalSales / activeDays;
    const netProfit = totalSales - totalExp - totalPur;
    const profitMargin = totalSales > 0 ? ((netProfit / totalSales) * 100).toFixed(1) : '0.0';

    // ── Sales list for Excel export ──
    const salesList = allSales.map(s => ({
      orderId: s.id,
      date: s.order_date,
      username: s.username,
      paymentMethod: s.payment_method,
      discountName: s.discount_name || '',
      discountAmount: Number(s.discount_amount) || 0,
      total: Number(s.total_final) || 0
    }));

    res.json({
      success: true,
      stats: {
        totalSales, totalExp, totalPur, totalDiscount, totalKitaFees,
        orderCount, activeDays, avgOrderValue, avgDailyRevenue,
        netProfit, profitMargin
      },
      payments: pay,
      charts: { salesByDay, salesByHour, salesByCashier, topProducts },
      tables: { dailyDetail, cashierDetail, productDetail, expensesByCategory, purchasesBySupplier },
      salesList
    });

  } catch (e) {
    // Production: removed debug log
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
