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

    // Insert sale items + deduct stock via recipe
    const [recipes] = await db.query('SELECT * FROM recipe');
    const recipeMap = {};
    recipes.forEach(r => {
      if (!recipeMap[r.menu_id]) recipeMap[r.menu_id] = [];
      recipeMap[r.menu_id].push({ invId: r.inv_item_id, qtyUsed: Number(r.qty_used) });
    });

    for (const item of items) {
      await db.query('INSERT INTO sales_items (order_id, order_date, item_name, qty, price, total, payment_method, username, shift_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [orderId, now, item.name, item.qty, item.price, item.qty * item.price, payStr, username, shiftId]);

      // Stock deduction via recipe — the menu item itself has no stock,
      // it pulls the raw ingredients from inv_items via recipe mappings.
      if (item.id && recipeMap[item.id]) {
        for (const ing of recipeMap[item.id]) {
          const deduct = ing.qtyUsed * item.qty;
          await db.query('UPDATE inv_items SET stock = stock - ? WHERE id = ?', [deduct, ing.invId]);
          await db.query('INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
            ['MOV-'+Date.now()+'-'+Math.random().toString(36).substr(2,4), now, ing.invId, '', 'out', deduct, 'مبيعات', username, orderId]);
        }
      }
      // NOTE: we deliberately no longer touch menu.stock. The menu column
      // is a DB-level relic; menu availability is now purely driven by the
      // availability of its recipe ingredients in inv_items.
    }

    res.json({ success: true, orderId });
  } catch (e) { res.json({ success: false, error: e.message }); }
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
