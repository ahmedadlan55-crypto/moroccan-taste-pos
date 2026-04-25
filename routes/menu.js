const router = require('express').Router();
const db = require('../db/connection');

// ─── Helper: map a menu row to API response (includes semi-finished fields) ───
function _mapMenu(m) {
  return {
    id: m.id, name: m.name, price: Number(m.price), category: m.category,
    cost: Number(m.cost), stock: m.stock, minStock: m.min_stock, active: m.active, rowIndex: m.id,
    brandId: m.brand_id || '', brand_id: m.brand_id || '', brandName: m.brand_name || '',
    computedCost: Number(m.computed_cost) || 0, pricingMode: m.pricing_mode || 'fixed', markupPct: Number(m.markup_pct) || 30,
    // Semi-finished fields
    isSemiFinished: !!m.is_semi_finished,
    productionUnit: m.production_unit || 'pcs',
    consumesSemiId: m.consumes_semi_id || null,
    consumesSemiQty: Number(m.consumes_semi_qty || 0),
    productionWarehouseId: m.production_warehouse_id || null,
    salesWarehouseId: m.sales_warehouse_id || null
  };
}

// Get all menu items (active only). Optional ?brandId= and ?type= filter (finished|semi).
router.get('/', async (req, res) => {
  try {
    const { brandId, type } = req.query;
    let sql = 'SELECT m.*, b.name AS brand_name FROM menu m LEFT JOIN brands b ON b.id = m.brand_id WHERE m.active = 1';
    const params = [];
    if (brandId) { sql += ' AND m.brand_id = ?'; params.push(brandId); }
    if (type === 'semi')     sql += ' AND m.is_semi_finished = 1';
    if (type === 'finished') sql += ' AND (m.is_semi_finished IS NULL OR m.is_semi_finished = 0)';
    sql += ' ORDER BY m.category, m.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapMenu));
  } catch (e) { res.json([]); }
});

// Get all menu items (including inactive)
router.get('/all', async (req, res) => {
  try {
    const { brandId, type } = req.query;
    let sql = 'SELECT m.*, b.name AS brand_name FROM menu m LEFT JOIN brands b ON b.id = m.brand_id WHERE 1=1';
    const params = [];
    if (brandId) { sql += ' AND m.brand_id = ?'; params.push(brandId); }
    if (type === 'semi')     sql += ' AND m.is_semi_finished = 1';
    if (type === 'finished') sql += ' AND (m.is_semi_finished IS NULL OR m.is_semi_finished = 0)';
    sql += ' ORDER BY m.category, m.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapMenu));
  } catch (e) { res.json([]); }
});

// Get only semi-finished products (helper endpoint for production/sales pages)
router.get('/semi-finished', async (req, res) => {
  try {
    const { brandId } = req.query;
    let sql = 'SELECT m.*, b.name AS brand_name FROM menu m LEFT JOIN brands b ON b.id = m.brand_id WHERE m.is_semi_finished = 1';
    const params = [];
    if (brandId) { sql += ' AND m.brand_id = ?'; params.push(brandId); }
    sql += ' ORDER BY m.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapMenu));
  } catch (e) { res.json([]); }
});

// Add menu item
router.post('/', async (req, res) => {
  try {
    const {
      name, price, category, cost, stock, minStock, active, pricingMode, markupPct, brandId,
      isSemiFinished, productionUnit, consumesSemiId, consumesSemiQty,
      productionWarehouseId, salesWarehouseId
    } = req.body;
    const id = 'MENU-' + Date.now();
    await db.query(
      `INSERT INTO menu (id, name, price, category, cost, stock, min_stock, active, pricing_mode, markup_pct, brand_id,
                         is_semi_finished, production_unit, consumes_semi_id, consumes_semi_qty,
                         production_warehouse_id, sales_warehouse_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, price || 0, category || 'عام', cost || 0, stock || 0, minStock || 0, active !== false,
       pricingMode || 'fixed', markupPct || 30, brandId || null,
       isSemiFinished ? 1 : 0, productionUnit || 'pcs', consumesSemiId || null, consumesSemiQty || 0,
       productionWarehouseId || null, salesWarehouseId || null]
    );
    res.json({ success: true, id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update menu item
router.put('/:id', async (req, res) => {
  try {
    const {
      name, price, category, cost, stock, minStock, active, pricingMode, markupPct, brandId,
      isSemiFinished, productionUnit, consumesSemiId, consumesSemiQty,
      productionWarehouseId, salesWarehouseId
    } = req.body;
    // Price is ALWAYS manual (user sets it). pricing_mode only controls
    // whether the COST comes from recipes (variable) or manual input (fixed).
    await db.query(
      `UPDATE menu SET name=?, price=?, category=?, cost=?, stock=?, min_stock=?, active=?,
                       pricing_mode=?, markup_pct=?, brand_id=?,
                       is_semi_finished=?, production_unit=?, consumes_semi_id=?, consumes_semi_qty=?,
                       production_warehouse_id=?, sales_warehouse_id=?
       WHERE id=?`,
      [name, price || 0, category, cost || 0, stock, minStock, active, pricingMode || 'variable', markupPct || 0,
       brandId || null,
       isSemiFinished ? 1 : 0, productionUnit || 'pcs', consumesSemiId || null, consumesSemiQty || 0,
       productionWarehouseId || null, salesWarehouseId || null,
       req.params.id]
    );
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
    // Recompute the menu item's cost from the new recipe
    try {
      const { recomputeMenuCost } = require('./pricing-utils');
      const newCost = await recomputeMenuCost(menuId);
      res.json({ success: true, computedCost: newCost });
    } catch (e) {
      res.json({ success: true }); // recipe saved, cost recompute failed silently
    }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
