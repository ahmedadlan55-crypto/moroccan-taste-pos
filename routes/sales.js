const router = require('express').Router();
const db = require('../db/connection');

// Save order
router.post('/', async (req, res) => {
  try {
    const { items, total, totalFinal, paymentMethod, discountName, discountAmount, kitaServiceFee, splitDetails } = req.body;
    const { username, shiftId } = req.body;
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

    console.log('[SALE] Order', orderId, '— processing', items.length, 'items, recipe table has', recipes.length, 'rows');

    // Diagnostic info to return to the frontend so we can verify deductions worked
    const recipesApplied = []; // [{ menuId, menuName, deductions: [{invId, invName, deducted, affected}] }]
    const itemsWithoutRecipe = []; // menu items that have no recipe attached

    for (const item of items) {
      // sales_items log row
      await db.query('INSERT INTO sales_items (order_id, order_date, item_name, qty, price, total, payment_method, username, shift_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [orderId, now, item.name, item.qty, item.price, item.qty * item.price, payStr, username, shiftId]);

      // Stock deduction via recipe.
      if (!item.id) {
        console.warn('[SALE]   item has no id —', item.name);
        itemsWithoutRecipe.push({ name: item.name, reason: 'no item id' });
        continue;
      }
      if (!recipeMap[item.id]) {
        console.warn('[SALE]   no recipe for menu id=', item.id, '(' + item.name + ')');
        itemsWithoutRecipe.push({ id: item.id, name: item.name, reason: 'no recipe defined' });
        continue;
      }

      const deductions = [];
      for (const ing of recipeMap[item.id]) {
        const deduct = ing.qtyUsed * item.qty;

        // CRITICAL: capture affectedRows so we know if the inv row exists.
        const [updateResult] = await db.query(
          'UPDATE inv_items SET stock = stock - ? WHERE id = ?',
          [deduct, ing.invId]
        );
        const affected = updateResult.affectedRows;

        console.log('[SALE]   ' + (affected > 0 ? 'OK' : 'FAIL'),
          'menu=' + item.id, '→', ing.invName, '(' + ing.invId + ')',
          'deduct=' + deduct,
          'affected=' + affected);

        // Record movement using a unique movement id (timestamp + random + counter)
        const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4) + '-' + deductions.length;
        await db.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
          [movId, now, ing.invId, ing.invName, 'out', deduct, 'مبيعات', username, orderId]
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

    console.log('[SALE] Done — recipes applied for', recipesApplied.length, 'items, missing recipe for', itemsWithoutRecipe.length);

    res.json({
      success: true,
      orderId,
      recipesApplied: recipesApplied,
      itemsWithoutRecipe: itemsWithoutRecipe
    });
  } catch (e) {
    console.error('[SALE] ERROR:', e.message);
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

module.exports = router;
