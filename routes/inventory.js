const router = require('express').Router();
const db = require('../db/connection');

// Get all inventory items
router.get('/items', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM inv_items ORDER BY category, name');
    res.json(rows.map(i => ({
      id: i.id, name: i.name, category: i.category,
      cost: Number(i.cost), stock: Number(i.stock), minStock: Number(i.min_stock),
      unit: i.unit, bigUnit: i.big_unit, convRate: Number(i.conv_rate), active: i.active
    })));
  } catch (e) {
    res.json([]);
  }
});

// Save inventory item (insert or update)
router.post('/items', async (req, res) => {
  try {
    const { id, name, category, cost, stock, minStock, unit, bigUnit, convRate, active } = req.body;

    if (id) {
      // Check if exists
      const [existing] = await db.query('SELECT id FROM inv_items WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE inv_items SET name=?, category=?, cost=?, stock=?, min_stock=?, unit=?, big_unit=?, conv_rate=?, active=? WHERE id=?`,
          [name, category || '', cost || 0, stock || 0, minStock || 0, unit || 'حبة', bigUnit || null, convRate || 1, active !== false, id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'INV-' + Date.now();
    await db.query(
      `INSERT INTO inv_items (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, category || '', cost || 0, stock || 0, minStock || 0, unit || 'حبة', bigUnit || null, convRate || 1, active !== false]
    );

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete inventory item
router.delete('/items/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM inv_items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Bulk import inventory items
router.post('/items/import', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'No items provided' });

    let imported = 0;
    let updated = 0;

    for (const item of items) {
      const id = item.id || 'INV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      const [existing] = await db.query('SELECT id FROM inv_items WHERE id = ? OR name = ?', [id, item.name]);

      if (existing.length) {
        await db.query(
          `UPDATE inv_items SET name=?, category=?, cost=?, stock=?, min_stock=?, unit=?, big_unit=?, conv_rate=? WHERE id=?`,
          [item.name, item.category || '', item.cost || 0, item.stock || 0, item.minStock || 0,
           item.unit || 'حبة', item.bigUnit || null, item.convRate || 1, existing[0].id]
        );
        updated++;
      } else {
        await db.query(
          `INSERT INTO inv_items (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, item.name, item.category || '', item.cost || 0, item.stock || 0, item.minStock || 0,
           item.unit || 'حبة', item.bigUnit || null, item.convRate || 1, true]
        );
        imported++;
      }
    }

    res.json({ success: true, imported, updated, total: items.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get inventory movements
router.get('/movements', async (req, res) => {
  try {
    let query = 'SELECT * FROM inventory_movements WHERE 1=1';
    const params = [];

    if (req.query.startDate) { query += ' AND DATE(movement_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND DATE(movement_date) <= ?'; params.push(req.query.endDate); }
    if (req.query.itemId) { query += ' AND item_id = ?'; params.push(req.query.itemId); }
    if (req.query.type) { query += ' AND type = ?'; params.push(req.query.type); }

    query += ' ORDER BY movement_date DESC LIMIT 500';

    const [rows] = await db.query(query, params);
    res.json(rows.map(m => ({
      id: m.id, date: m.movement_date, itemId: m.item_id, itemName: m.item_name,
      type: m.type, qty: Number(m.qty), reason: m.reason, username: m.username, notes: m.notes
    })));
  } catch (e) {
    res.json([]);
  }
});

// Stock update (in/out movement)
router.post('/stock-update', async (req, res) => {
  try {
    const { itemId, itemName, type, qty, reason, username, notes } = req.body;
    const now = new Date();
    const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);

    // Insert movement record
    await db.query(
      'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
      [movId, now, itemId, itemName || '', type, qty, reason || '', username || '', notes || '']
    );

    // Update stock on inv_items
    if (type === 'in') {
      await db.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?', [qty, itemId]);
    } else {
      await db.query('UPDATE inv_items SET stock = GREATEST(0, stock - ?) WHERE id = ?', [qty, itemId]);
    }

    res.json({ success: true, movementId: movId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get live inventory (current stock with movements summary)
router.get('/live', async (req, res) => {
  try {
    const [items] = await db.query('SELECT * FROM inv_items WHERE active = 1 ORDER BY category, name');
    const result = items.map(i => ({
      id: i.id,
      name: i.name,
      category: i.category || '',
      unit: i.unit || 'حبة',
      initialStock: 0,
      purchasedQty: 0,
      consumedQty: 0,
      currentStock: Number(i.stock) || 0,
      minStock: Number(i.min_stock) || 0,
      cost: Number(i.cost) || 0
    }));
    res.json(result);
  } catch (e) {
    res.json([]);
  }
});

module.exports = router;
