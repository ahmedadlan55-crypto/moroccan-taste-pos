const router = require('express').Router();
const db = require('../db/connection');

// ─── Helper: map a menu row to API response (includes semi-finished fields) ───
function _mapMenu(m) {
  return {
    id: m.id, name: m.name,
    // V5.7.22 — bilingual name (English column added via migration)
    nameEn: m.name_en || '',
    price: Number(m.price), category: m.category,
    cost: Number(m.cost), stock: m.stock, minStock: m.min_stock, active: m.active, rowIndex: m.id,
    brandId: m.brand_id || '', brand_id: m.brand_id || '', brandName: m.brand_name || '',
    computedCost: Number(m.computed_cost) || 0, pricingMode: m.pricing_mode || 'fixed', markupPct: Number(m.markup_pct) || 30,
    // Semi-finished fields
    isSemiFinished: !!m.is_semi_finished,
    productionUnit: m.production_unit || 'pcs',
    consumesSemiId: m.consumes_semi_id || null,
    consumesSemiQty: Number(m.consumes_semi_qty || 0),
    productionWarehouseId: m.production_warehouse_id || null,
    salesWarehouseId: m.sales_warehouse_id || null,
    // V5.6 — recipe linkage + production metadata
    bomId: m.bom_id || null,
    productionMethod: m.production_method || 'made_at_branch',
    deductStrategy: m.deduct_strategy || 'on_sale',
    allowNegativeStock: m.allow_negative_stock !== 0,
    minStockAlert: Number(m.min_stock_alert) || 0
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
    // V3: include recipe count + consumer count (how many finished items use this semi)
    let sql = `
      SELECT m.*, b.name AS brand_name,
             (SELECT COUNT(*) FROM recipe r WHERE r.menu_id = m.id) AS recipe_count,
             (SELECT COUNT(*) FROM menu c WHERE c.consumes_semi_id = m.id) AS consumer_count
        FROM menu m
        LEFT JOIN brands b ON b.id = m.brand_id
       WHERE m.is_semi_finished = 1`;
    const params = [];
    if (brandId) { sql += ' AND m.brand_id = ?'; params.push(brandId); }
    sql += ' ORDER BY m.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => {
      const base = _mapMenu(r);
      base.recipeCount = Number(r.recipe_count || 0);
      base.consumerCount = Number(r.consumer_count || 0);
      base.hasBom = base.recipeCount > 0;
      return base;
    }));
  } catch (e) {
    // Fallback for old schemas without recipe/consumes_semi_id
    try {
      const { brandId } = req.query;
      let sql = 'SELECT m.*, b.name AS brand_name FROM menu m LEFT JOIN brands b ON b.id = m.brand_id WHERE m.is_semi_finished = 1';
      const params = [];
      if (brandId) { sql += ' AND m.brand_id = ?'; params.push(brandId); }
      sql += ' ORDER BY m.name';
      const [rows] = await db.query(sql, params);
      res.json(rows.map(_mapMenu));
    } catch(e2) { res.json([]); }
  }
});

// Add menu item
router.post('/', async (req, res) => {
  try {
    const {
      name, nameEn, price, category, cost, stock, minStock, active, pricingMode, markupPct, brandId,
      isSemiFinished, productionUnit, consumesSemiId, consumesSemiQty,
      productionWarehouseId, salesWarehouseId
    } = req.body;
    const id = 'MENU-' + Date.now();
    await db.query(
      `INSERT INTO menu (id, name, name_en, price, category, cost, stock, min_stock, active, pricing_mode, markup_pct, brand_id,
                         is_semi_finished, production_unit, consumes_semi_id, consumes_semi_qty,
                         production_warehouse_id, sales_warehouse_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, nameEn || null, price || 0, category || 'عام', cost || 0, stock || 0, minStock || 0, active !== false,
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
      name, nameEn, price, category, cost, stock, minStock, active, pricingMode, markupPct, brandId,
      isSemiFinished, productionUnit, consumesSemiId, consumesSemiQty,
      productionWarehouseId, salesWarehouseId
    } = req.body;
    // Price is ALWAYS manual (user sets it). pricing_mode only controls
    // whether the COST comes from recipes (variable) or manual input (fixed).
    await db.query(
      `UPDATE menu SET name=?, name_en=?, price=?, category=?, cost=?, stock=?, min_stock=?, active=?,
                       pricing_mode=?, markup_pct=?, brand_id=?,
                       is_semi_finished=?, production_unit=?, consumes_semi_id=?, consumes_semi_qty=?,
                       production_warehouse_id=?, sales_warehouse_id=?
       WHERE id=?`,
      [name, nameEn || null, price || 0, category, cost || 0, stock, minStock, active, pricingMode || 'variable', markupPct || 0,
       brandId || null,
       isSemiFinished ? 1 : 0, productionUnit || 'pcs', consumesSemiId || null, consumesSemiQty || 0,
       productionWarehouseId || null, salesWarehouseId || null,
       req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update price only
// V5.7.4: now records price history for traceability + returns the new price + cost margin.
router.patch('/:id/price', async (req, res) => {
  try {
    const newPrice = Number(req.body.price);
    const reason = (req.body.reason || '').toString().slice(0, 200);
    const username = (req.user && req.user.username) || req.body.username || 'system';
    if (newPrice < 0 || isNaN(newPrice)) return res.status(400).json({ success: false, error: 'سعر غير صالح' });
    // Read OLD price + cost for the audit trail and return payload
    const [old] = await db.query('SELECT price AS old_price, cost FROM menu WHERE id = ?', [req.params.id]);
    if (!old.length) return res.status(404).json({ success: false, error: 'منتج غير موجود' });
    const oldPrice = Number(old[0].old_price) || 0;
    const cost = Number(old[0].cost) || 0;
    if (Math.abs(newPrice - oldPrice) < 0.001) {
      return res.json({ success: true, noop: true, oldPrice, newPrice, cost });
    }
    await db.query('UPDATE menu SET price = ? WHERE id = ?', [newPrice, req.params.id]);
    // Audit log (best-effort — table might be missing on old deploys)
    try {
      await db.query(
        `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at)
         VALUES (?, 'menu_price_change', 'menu', ?, ?, NOW())`,
        [username, req.params.id, JSON.stringify({ oldPrice, newPrice, cost, reason })]);
    } catch(_){}
    const margin = newPrice > 0 ? ((newPrice - cost) / newPrice * 100) : 0;
    res.json({ success: true, oldPrice, newPrice, cost, marginPct: Math.round(margin * 100) / 100 });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// V5.7.4 — Bulk price update for a brand/category.
// Body: { itemIds?: [...], categoryFilter?, brandId?, mode: 'percent'|'fixed_set'|'fixed_add', value: number, reason? }
//   - percent       → newPrice = oldPrice * (1 + value/100)
//   - fixed_set     → newPrice = value (set to exact)
//   - fixed_add     → newPrice = oldPrice + value
// Returns: { affected, before, after, items: [...] }
router.post('/bulk-price-update', async (req, res) => {
  try {
    const b = req.body || {};
    const mode = b.mode || 'percent';
    const value = Number(b.value);
    if (!['percent', 'fixed_set', 'fixed_add'].includes(mode)) return res.status(400).json({ success: false, error: 'mode invalid' });
    if (isNaN(value)) return res.status(400).json({ success: false, error: 'value invalid' });
    const username = (req.user && req.user.username) || b.username || 'system';
    // V5.7.4-FIX: REQUIRE explicit targets — never allow accidental "update all".
    // The bug: previously the semi-finished filter was added unconditionally, so
    // when no itemIds and no brandId/categoryFilter were supplied, the query
    // matched ALL non-semi items. Now we explicitly require itemIds OR a filter.
    const hasIds = Array.isArray(b.itemIds) && b.itemIds.length > 0;
    const hasFilter = !!(b.brandId || b.categoryFilter);
    if (!hasIds && !hasFilter) {
      return res.status(400).json({
        success: false,
        error: 'حدد أصنافاً صراحةً (itemIds) أو فلتراً (brandId / categoryFilter). لا يُسمح بتطبيق التغيير على كل المنيو دون فلترة.'
      });
    }
    const conds = []; const params = [];
    if (hasIds) {
      conds.push(`id IN (${b.itemIds.map(()=>'?').join(',')})`);
      params.push(...b.itemIds);
    } else {
      if (b.brandId) { conds.push('brand_id = ?'); params.push(b.brandId); }
      if (b.categoryFilter) { conds.push('category = ?'); params.push(b.categoryFilter); }
      // Skip semi-finished (they're cost-driven, not priced for sale)
      conds.push('(is_semi_finished IS NULL OR is_semi_finished = 0)');
    }

    const where = conds.join(' AND ');
    const [items] = await db.query(`SELECT id, name, price, cost FROM menu WHERE ${where}`, params);
    if (!items.length) return res.json({ success: true, affected: 0, items: [] });

    let affected = 0;
    const beforeAfter = [];
    for (const it of items) {
      const oldPrice = Number(it.price) || 0;
      let newPrice;
      if (mode === 'percent') newPrice = Math.round(oldPrice * (1 + value/100) * 100) / 100;
      else if (mode === 'fixed_set') newPrice = Math.round(value * 100) / 100;
      else newPrice = Math.round((oldPrice + value) * 100) / 100;
      if (newPrice < 0) newPrice = 0;
      if (Math.abs(newPrice - oldPrice) < 0.001) continue;
      try {
        await db.query('UPDATE menu SET price = ? WHERE id = ?', [newPrice, it.id]);
        affected++;
        beforeAfter.push({
          id: it.id, name: it.name,
          oldPrice, newPrice,
          cost: Number(it.cost)||0,
          marginPct: newPrice > 0 ? Math.round(((newPrice - (Number(it.cost)||0)) / newPrice * 100) * 100)/100 : 0
        });
      } catch(_) {}
    }
    // Audit log
    try {
      await db.query(
        `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at)
         VALUES (?, 'menu_bulk_price', 'menu', '*', ?, NOW())`,
        [username, JSON.stringify({ mode, value, affected, brandId: b.brandId, categoryFilter: b.categoryFilter, reason: b.reason })]);
    } catch(_) {}
    res.json({ success: true, affected, mode, value, items: beforeAfter });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// V5.7.4 — Price history for a single menu item (last N changes).
router.get('/:id/price-history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const userCol = await (async () => {
      try {
        const [cols] = await db.query(`SHOW COLUMNS FROM audit_logs`);
        const names = cols.map(c => c.Field || c.field);
        return names.includes('user_username') ? 'user_username' : 'username';
      } catch(_) { return 'username'; }
    })();
    const [rows] = await db.query(
      `SELECT id, ${userCol} AS user_col, details, created_at
       FROM audit_logs
       WHERE action = 'menu_price_change' AND entity_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [req.params.id, limit]);
    res.json(rows.map(r => {
      let d = {};
      try { d = JSON.parse(r.details||'{}'); } catch(_){}
      return {
        id: r.id, user: r.user_col, at: r.created_at,
        oldPrice: d.oldPrice, newPrice: d.newPrice, cost: d.cost, reason: d.reason
      };
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ═══════════════════════════════════════════════════════════════════
// V5.6 — Per-menu-item dedicated recipe (BOM) endpoints
// Each finished menu item can have its own BOM. When the item is sold,
// the recipe ingredients are auto-deducted from the branch's warehouse.
// ═══════════════════════════════════════════════════════════════════

// GET /api/menu/:id/recipe-bom — fetch the BOM linked to this menu item (with lines)
router.get('/:id/recipe-bom', async (req, res) => {
  try {
    const menuId = req.params.id;
    // Load menu row to get bom_id
    const [menuRows] = await db.query(
      'SELECT id, name, bom_id, production_method, deduct_strategy, allow_negative_stock, min_stock_alert FROM menu WHERE id = ?',
      [menuId]);
    if (!menuRows.length) return res.status(404).json({ error: 'منتج غير موجود' });
    const menu = menuRows[0];
    // Try the modern BOM linkage first; fall back to legacy recipe table.
    let bom = null, lines = [];
    if (menu.bom_id) {
      const [b] = await db.query(`SELECT * FROM bom WHERE id = ?`, [menu.bom_id]);
      if (b.length) {
        bom = b[0];
        const [bl] = await db.query(`
          SELECT bl.*, COALESCE(i.name, '') AS item_name, i.unit AS item_unit,
                 COALESCE(i.cost,0) AS avg_cost
          FROM bom_lines bl
          LEFT JOIN inv_items i ON i.id = bl.component_item_id
          WHERE bl.bom_id = ?`, [menu.bom_id]);
        lines = bl.map(l => ({
          id: l.id,
          componentItemId: l.component_item_id,
          itemName: l.item_name,
          unit: l.unit || l.item_unit || 'PCS',
          quantity: Number(l.quantity)||0,
          wastePct: Number(l.waste_pct)||0,
          avgCost: Number(l.avg_cost)||0,
          lineCost: (Number(l.quantity)||0) * (Number(l.avg_cost)||0) * (1 + (Number(l.waste_pct)||0)/100)
        }));
      }
    }
    // Legacy fallback
    if (!bom) {
      try {
        const [legacyRows] = await db.query(`
          SELECT r.*, i.cost AS avg_cost, i.unit AS item_unit
          FROM recipe r LEFT JOIN inv_items i ON i.id = r.inv_item_id
          WHERE r.menu_id = ?`, [menuId]);
        if (legacyRows.length) {
          lines = legacyRows.map(l => ({
            id: 'legacy-'+l.inv_item_id,
            componentItemId: l.inv_item_id,
            itemName: l.inv_item_name,
            unit: l.unit || l.item_unit || 'PCS',
            quantity: Number(l.qty_used)||0,
            wastePct: 0,
            avgCost: Number(l.avg_cost)||0,
            lineCost: (Number(l.qty_used)||0) * (Number(l.avg_cost)||0)
          }));
        }
      } catch(_){}
    }
    const totalCost = lines.reduce((s,l)=>s+l.lineCost, 0);
    res.json({
      menuId: menu.id,
      menuName: menu.name,
      bomId: bom ? bom.id : null,
      version: bom ? bom.version : 1,
      yieldQuantity: bom ? Number(bom.yield_quantity)||1 : 1,
      yieldUnit: bom ? (bom.yield_unit||'PCS') : 'PCS',
      productionMethod: menu.production_method || 'made_at_branch',
      deductStrategy: menu.deduct_strategy || 'on_sale',
      allowNegativeStock: !!menu.allow_negative_stock,
      minStockAlert: Number(menu.min_stock_alert)||0,
      lines: lines,
      totalCost: totalCost,
      hasLegacyRecipe: (!bom && lines.length > 0)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// V5.7 — Computed availability for made-to-order items
// "How many of this menu item can we make RIGHT NOW given current ingredient stock?"
// Returns: min(ingredient_stock / ingredient_qty_per_unit) across all BOM lines.
// If item has no recipe AND production_method='made_at_branch' → returns 0 (cannot determine).
// If item is "imported" or "prepared" → returns menu.stock as-is (these ARE stocked).
//
//   GET /api/menu/:id/availability?warehouseId=X
async function _computeMenuAvailability(menuId, warehouseId) {
  // Load menu meta
  const [mRows] = await db.query(
    `SELECT id, name, bom_id, production_method, deduct_strategy, stock,
            allow_negative_stock, min_stock_alert
     FROM menu WHERE id = ?`, [menuId]);
  if (!mRows.length) return null;
  const m = mRows[0];

  // For "imported" / "prepared" / "stocked" items → stock IS the truth
  if (['imported', 'prepared'].includes(m.production_method) || m.deduct_strategy === 'none') {
    return {
      menuId: m.id, name: m.name,
      productionMethod: m.production_method,
      mode: 'stocked',
      stockedQty: Number(m.stock) || 0,
      makeable: Number(m.stock) || 0,
      ingredientsNeeded: [],
      blockerIngredients: [],
      hasRecipe: !!m.bom_id
    };
  }

  // For made-to-order items → compute from BOM
  if (!m.bom_id) {
    // Check legacy recipe table fallback
    let legacyLines = [];
    try {
      const [r] = await db.query(`SELECT * FROM recipe WHERE menu_id = ?`, [menuId]);
      legacyLines = r;
    } catch(_){}
    if (!legacyLines.length) {
      return {
        menuId: m.id, name: m.name,
        productionMethod: m.production_method || 'made_at_branch',
        mode: 'mto_no_recipe',
        makeable: 0,
        warning: 'لا توجد وصفة — حدد المكوّنات لمعرفة الكمية المتاحة',
        ingredientsNeeded: [],
        blockerIngredients: [],
        hasRecipe: false
      };
    }
    // Use legacy recipe to compute
    return await _computeFromIngredients(m, legacyLines.map(l => ({
      itemId: l.inv_item_id, name: l.inv_item_name, qtyPer: Number(l.qty_used)||0, wastePct: 0
    })), warehouseId);
  }

  // Modern BOM path
  const [bomRows] = await db.query('SELECT yield_quantity FROM bom WHERE id = ?', [m.bom_id]);
  const yieldQ = bomRows.length ? (Number(bomRows[0].yield_quantity)||1) : 1;
  const [lines] = await db.query(`
    SELECT bl.component_item_id AS item_id, bl.quantity, bl.waste_pct,
           COALESCE(i.name, '') AS name
    FROM bom_lines bl LEFT JOIN inv_items i ON i.id = bl.component_item_id
    WHERE bl.bom_id = ?`, [m.bom_id]);
  const ingredients = lines.map(l => ({
    itemId: l.item_id, name: l.name,
    qtyPer: ((Number(l.quantity)||0) * (1 + (Number(l.waste_pct)||0)/100)) / Math.max(1, yieldQ),
    wastePct: Number(l.waste_pct)||0
  }));
  return await _computeFromIngredients(m, ingredients, warehouseId);
}

async function _computeFromIngredients(menu, ingredients, warehouseId) {
  if (!ingredients.length) {
    return {
      menuId: menu.id, name: menu.name, mode: 'mto', makeable: 0,
      warning: 'الوصفة فارغة', ingredientsNeeded: [], blockerIngredients: [],
      hasRecipe: !!menu.bom_id
    };
  }
  // Bulk-load stock for all ingredients (per warehouse if provided, else global inv_items.stock)
  const itemIds = ingredients.map(i => i.itemId).filter(Boolean);
  const placeholders = itemIds.map(()=>'?').join(',');
  let stockMap = {};
  if (warehouseId) {
    try {
      const [ws] = await db.query(
        `SELECT item_id, qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id IN (${placeholders})`,
        [warehouseId, ...itemIds]);
      ws.forEach(r => { stockMap[r.item_id] = Number(r.qty)||0; });
    } catch(_){}
  }
  // Fallback to global stock for items not in warehouse_stock
  try {
    const [rows] = await db.query(
      `SELECT id, COALESCE(stock,0) AS stock FROM inv_items WHERE id IN (${placeholders})`, itemIds);
    rows.forEach(r => {
      if (stockMap[r.id] === undefined) stockMap[r.id] = Number(r.stock)||0;
    });
  } catch(_){}

  // For each ingredient: how many units of finished can we make?
  let makeable = Infinity;
  const blockers = [];
  const breakdown = [];
  for (const ing of ingredients) {
    const stock = stockMap[ing.itemId] || 0;
    const canMake = ing.qtyPer > 0 ? Math.floor(stock / ing.qtyPer) : Infinity;
    breakdown.push({
      itemId: ing.itemId, name: ing.name,
      stockOnHand: stock, qtyPer: ing.qtyPer,
      canMake: canMake === Infinity ? null : canMake
    });
    if (canMake < makeable) makeable = canMake;
    if (canMake === 0) blockers.push({ itemId: ing.itemId, name: ing.name, stock });
  }
  if (makeable === Infinity) makeable = 0;
  return {
    menuId: menu.id, name: menu.name,
    productionMethod: menu.production_method || 'made_at_branch',
    mode: 'mto',
    makeable: makeable,
    minAlert: Number(menu.min_stock_alert)||0,
    isLowStock: makeable <= (Number(menu.min_stock_alert)||0) && makeable > 0,
    isOutOfStock: makeable === 0,
    ingredientsNeeded: breakdown,
    blockerIngredients: blockers,
    hasRecipe: !!menu.bom_id
  };
}

router.get('/:id/availability', async (req, res) => {
  try {
    const result = await _computeMenuAvailability(req.params.id, req.query.warehouseId || null);
    if (!result) return res.status(404).json({ error: 'منتج غير موجود' });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// V5.7 — Bulk: availability for an entire brand (or all menu) in one call.
// Used by the menu hub list to show "متوفر للصنع" per row.
router.get('/availability/bulk', async (req, res) => {
  try {
    const { brandId, warehouseId } = req.query;
    let sql = 'SELECT id FROM menu WHERE active = 1';
    const params = [];
    if (brandId) { sql += ' AND brand_id = ?'; params.push(brandId); }
    sql += ' ORDER BY name LIMIT 500';
    const [rows] = await db.query(sql, params);
    const out = {};
    for (const r of rows) {
      try {
        const a = await _computeMenuAvailability(r.id, warehouseId || null);
        if (a) {
          out[r.id] = {
            mode: a.mode,
            makeable: a.makeable,
            isOutOfStock: !!a.isOutOfStock,
            isLowStock: !!a.isLowStock,
            blockerCount: (a.blockerIngredients||[]).length,
            hasRecipe: a.hasRecipe
          };
        }
      } catch(_) {}
    }
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/menu/:id/recipe-bom — upsert the recipe BOM for this menu item.
// Body: { lines: [{ componentItemId, quantity, unit, wastePct }],
//         yieldQuantity?, yieldUnit?, productionMethod?, deductStrategy?,
//         allowNegativeStock?, minStockAlert? }
router.post('/:id/recipe-bom', async (req, res) => {
  try {
    const menuId = req.params.id;
    const b = req.body || {};
    const [menuRows] = await db.query('SELECT id, name, bom_id FROM menu WHERE id = ?', [menuId]);
    if (!menuRows.length) return res.status(404).json({ success: false, error: 'منتج غير موجود' });
    const menu = menuRows[0];

    // Build/upsert BOM
    let bomId = menu.bom_id;
    if (!bomId) {
      bomId = 'BOM-' + Date.now() + '-' + Math.random().toString(36).slice(2,5);
      await db.query(`
        INSERT INTO bom (id, product_id, product_source, version, yield_quantity, yield_unit, notes, is_active)
        VALUES (?, ?, 'menu', 1, ?, ?, ?, 1)`,
        [bomId, menuId, Number(b.yieldQuantity)||1, b.yieldUnit||'PCS', b.notes||'وصفة لـ '+menu.name]);
      await db.query('UPDATE menu SET bom_id = ? WHERE id = ?', [bomId, menuId]);
    } else {
      await db.query(`
        UPDATE bom SET product_source='menu', yield_quantity=?, yield_unit=?, notes=COALESCE(?, notes), is_active=1
        WHERE id = ?`,
        [Number(b.yieldQuantity)||1, b.yieldUnit||'PCS', b.notes||null, bomId]);
    }

    // Replace lines
    if (Array.isArray(b.lines)) {
      await db.query('DELETE FROM bom_lines WHERE bom_id = ?', [bomId]);
      for (const ln of b.lines) {
        const compId = ln.componentItemId || ln.itemId;
        if (!compId) continue;
        await db.query(`
          INSERT INTO bom_lines (id, bom_id, component_item_id, quantity, unit, waste_pct)
          VALUES (?, ?, ?, ?, ?, ?)`,
          ['BL-'+Date.now()+'-'+Math.random().toString(36).slice(2,5),
           bomId, compId, Number(ln.quantity)||0, ln.unit||'PCS', Number(ln.wastePct)||0]);
      }
    }

    // Update menu meta (production method, deduct strategy, etc.)
    const mfields = []; const mparams = [];
    if (b.productionMethod !== undefined) { mfields.push('production_method=?'); mparams.push(b.productionMethod); }
    if (b.deductStrategy !== undefined)   { mfields.push('deduct_strategy=?');   mparams.push(b.deductStrategy); }
    if (b.allowNegativeStock !== undefined){ mfields.push('allow_negative_stock=?'); mparams.push(b.allowNegativeStock?1:0); }
    if (b.minStockAlert !== undefined)    { mfields.push('min_stock_alert=?'); mparams.push(Number(b.minStockAlert)||0); }
    if (mfields.length) {
      mparams.push(menuId);
      await db.query('UPDATE menu SET '+mfields.join(',')+' WHERE id=?', mparams);
    }

    // Recompute cost from new recipe
    let computedCost = null;
    try {
      const [agg] = await db.query(`
        SELECT SUM(bl.quantity * COALESCE(i.cost,0) * (1 + COALESCE(bl.waste_pct,0)/100)) AS total_cost
        FROM bom_lines bl LEFT JOIN inv_items i ON i.id = bl.component_item_id
        WHERE bl.bom_id = ?`, [bomId]);
      if (agg.length && agg[0].total_cost != null) {
        const yieldQ = Number(b.yieldQuantity)||1;
        computedCost = Number(agg[0].total_cost) / Math.max(1, yieldQ);
        await db.query('UPDATE menu SET cost = ? WHERE id = ?', [computedCost, menuId]);
      }
    } catch(_){}

    res.json({ success: true, bomId, computedCost });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
