const router = require('express').Router();
const db = require('../db/connection');

// Get all menu items (active only)
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM menu WHERE active = 1 ORDER BY category, name');
    res.json(rows.map(m => ({
      id: m.id, name: m.name, price: Number(m.price), category: m.category,
      cost: Number(m.cost), stock: m.stock, minStock: m.min_stock, active: m.active, rowIndex: m.id
    })));
  } catch (e) { res.json([]); }
});

// Get all menu items (including inactive)
router.get('/all', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM menu ORDER BY category, name');
    res.json(rows.map(m => ({
      id: m.id, name: m.name, price: Number(m.price), category: m.category,
      cost: Number(m.cost), stock: m.stock, minStock: m.min_stock, active: m.active
    })));
  } catch (e) { res.json([]); }
});

// Add menu item
router.post('/', async (req, res) => {
  try {
    const { name, price, category, cost, stock, minStock, active } = req.body;
    const id = 'MENU-' + Date.now();
    await db.query('INSERT INTO menu (id, name, price, category, cost, stock, min_stock, active) VALUES (?,?,?,?,?,?,?,?)',
      [id, name, price, category || 'عام', cost || 0, stock || 999, minStock || 5, active !== false]);
    res.json({ success: true, id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update menu item
router.put('/:id', async (req, res) => {
  try {
    const { name, price, category, cost, stock, minStock, active } = req.body;
    await db.query('UPDATE menu SET name=?, price=?, category=?, cost=?, stock=?, min_stock=?, active=? WHERE id=?',
      [name, price, category, cost || 0, stock, minStock, active, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update price only
router.patch('/:id/price', async (req, res) => {
  try {
    await db.query('UPDATE menu SET price = ? WHERE id = ?', [req.body.price, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Delete menu item
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM menu WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Bulk import menu items
router.post('/import', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'No items provided' });

    let imported = 0;
    let updated = 0;

    for (const item of items) {
      const id = item.id || 'MENU-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      const [existing] = await db.query('SELECT id FROM menu WHERE id = ? OR name = ?', [id, item.name]);

      if (existing.length) {
        await db.query(
          `UPDATE menu SET name=?, price=?, category=?, cost=?, stock=?, min_stock=?, active=? WHERE id=?`,
          [item.name, item.price || 0, item.category || 'عام', item.cost || 0, item.stock || 999, item.minStock || 5, item.active !== false, existing[0].id]
        );
        updated++;
      } else {
        await db.query(
          `INSERT INTO menu (id, name, price, category, cost, stock, min_stock, active) VALUES (?,?,?,?,?,?,?,?)`,
          [id, item.name, item.price || 0, item.category || 'عام', item.cost || 0, item.stock || 999, item.minStock || 5, item.active !== false]
        );
        imported++;
      }
    }

    res.json({ success: true, imported, updated, total: items.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Recipes ───
router.get('/recipes', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM recipe');
    res.json(rows.map(r => ({
      menuId: r.menu_id, menuName: r.menu_name,
      invItemId: r.inv_item_id, invItemName: r.inv_item_name, qtyUsed: Number(r.qty_used)
    })));
  } catch (e) { res.json([]); }
});

router.post('/recipes/:menuId', async (req, res) => {
  try {
    const { menuId } = req.params;
    const { menuName, ingredients } = req.body;
    // Delete old
    await db.query('DELETE FROM recipe WHERE menu_id = ?', [menuId]);
    // Insert new
    if (ingredients && ingredients.length) {
      const values = ingredients.map(ing => [menuId, menuName, ing.invItemId, ing.invItemName, ing.qtyUsed]);
      await db.query('INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used) VALUES ?', [values]);
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
