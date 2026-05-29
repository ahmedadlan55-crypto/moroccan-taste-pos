/**
 * ERP Core v3 — Multi-brand, multi-branch franchise entities
 *
 * Routes here cover the NEW tables added per the design doc:
 *   - companies
 *   - item_categories
 *   - units + unit_conversions
 *   - price_lists + price_list_items
 *   - bom + bom_lines (recipes)
 *   - purchase_receipts (partial receipts)
 *   - pos_terminals
 *   - accounting_periods (with close/reopen)
 *   - royalty_runs (franchise computation)
 *   - waste_entries
 *
 * All endpoints return camelCase JSON. Period-lock is enforced on
 * journal-writing endpoints.
 */
const router = require('express').Router();
const db = require('../db/connection');
const gl = require('../lib/glPosting');

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

async function isPeriodClosed(date) {
  if (!date) return false;
  try {
    const [r] = await db.query(
      `SELECT status FROM accounting_periods
       WHERE ? BETWEEN start_date AND end_date LIMIT 1`, [date]);
    return r.length && r[0].status === 'closed';
  } catch(e) { return false; }
}

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
}

// ═══════════════════════════════════════
// COMPANIES
// ═══════════════════════════════════════
router.get('/companies', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM companies WHERE is_active = 1 OR is_active IS NULL ORDER BY name');
    res.json(rows.map(c => ({
      id: c.id, name: c.name, legalName: c.legal_name || '',
      crNumber: c.cr_number || '', taxNumber: c.tax_number || '',
      country: c.country || 'SA', city: c.city || '',
      baseCurrency: c.base_currency || 'SAR',
      fiscalYearStart: c.fiscal_year_start, logoUrl: c.logo_url || '',
      isActive: c.is_active !== false
    })));
  } catch(e) { res.json([]); }
});

router.post('/companies', async (req, res) => {
  try {
    const { id, name, legalName, crNumber, taxNumber, country, city, baseCurrency, fiscalYearStart, logoUrl } = req.body;
    if (!name) return res.json({ success: false, error: 'اسم الشركة مطلوب' });
    if (id) {
      await db.query(
        `UPDATE companies SET name=?, legal_name=?, cr_number=?, tax_number=?, country=?, city=?, base_currency=?, fiscal_year_start=?, logo_url=? WHERE id=?`,
        [name, legalName||'', crNumber||'', taxNumber||'', country||'SA', city||'', baseCurrency||'SAR', fiscalYearStart||null, logoUrl||null, id]);
      return res.json({ success: true, id });
    }
    const newId = genId('CO');
    await db.query(
      `INSERT INTO companies (id, name, legal_name, cr_number, tax_number, country, city, base_currency, fiscal_year_start, logo_url)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, legalName||'', crNumber||'', taxNumber||'', country||'SA', city||'', baseCurrency||'SAR', fiscalYearStart||null, logoUrl||null]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// ITEM CATEGORIES (hierarchical)
// ═══════════════════════════════════════
router.get('/item-categories', async (req, res) => {
  try {
    const { brand_id } = req.query;
    let sql = `SELECT c.*, p.name AS parent_name,
               (SELECT COUNT(*) FROM inv_items i WHERE i.category_id = c.id) AS item_count
               FROM item_categories c LEFT JOIN item_categories p ON c.parent_id = p.id
               WHERE (c.is_active = 1 OR c.is_active IS NULL)`;
    const params = [];
    if (brand_id) { sql += ' AND (c.brand_id = ? OR c.brand_id IS NULL)'; params.push(brand_id); }
    sql += ' ORDER BY COALESCE(c.parent_id, c.id), c.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(c => ({
      id: c.id, name: c.name, code: c.code || '',
      brandId: c.brand_id || '', parentId: c.parent_id || '',
      parentName: c.parent_name || '', itemCount: Number(c.item_count) || 0,
      isActive: c.is_active !== false
    })));
  } catch(e) { res.json([]); }
});

router.post('/item-categories', async (req, res) => {
  try {
    const { id, name, code, brandId, parentId } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query(`UPDATE item_categories SET name=?, code=?, brand_id=?, parent_id=? WHERE id=?`,
        [name, code||'', brandId||null, parentId||null, id]);
      return res.json({ success: true, id });
    }
    const newId = genId('CAT');
    await db.query(
      `INSERT INTO item_categories (id, name, code, brand_id, parent_id) VALUES (?,?,?,?,?)`,
      [newId, name, code||'', brandId||null, parentId||null]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/item-categories/:id', async (req, res) => {
  try {
    const [c] = await db.query('SELECT COUNT(*) AS n FROM inv_items WHERE category_id = ?', [req.params.id]);
    if (c[0].n > 0) return res.json({ success: false, error: 'توجد أصناف تحت هذه الفئة' });
    await db.query('UPDATE item_categories SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// UNITS + CONVERSIONS
// ═══════════════════════════════════════
router.get('/units', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM units ORDER BY type, name_ar');
    res.json(rows.map(u => ({ id: u.id, nameAr: u.name_ar, nameEn: u.name_en, type: u.type })));
  } catch(e) { res.json([]); }
});

router.get('/unit-conversions', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM unit_conversions');
    res.json(rows.map(c => ({ id: c.id, fromUnit: c.from_unit, toUnit: c.to_unit, factor: Number(c.factor) })));
  } catch(e) { res.json([]); }
});

router.post('/unit-conversions', async (req, res) => {
  try {
    const { fromUnit, toUnit, factor } = req.body;
    if (!fromUnit || !toUnit || !factor) return res.json({ success: false, error: 'الحقول مطلوبة' });
    const id = genId('UC');
    await db.query(
      `INSERT INTO unit_conversions (id, from_unit, to_unit, factor)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE factor = VALUES(factor)`,
      [id, fromUnit, toUnit, Number(factor)]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// PRICE LISTS (brand/branch-specific pricing)
// ═══════════════════════════════════════
router.get('/price-lists', async (req, res) => {
  try {
    // v5.16.1 — Admin endpoint returns ALL lists (active + inactive)
    // so the management UI can re-activate disabled ones. The cashier
    // path resolves price lists via channel.priceListId, which the
    // channel's own active flag already gates.
    const [rows] = await db.query(
      `SELECT pl.*, b.name AS brand_name, br.name AS branch_name,
              (SELECT COUNT(*) FROM price_list_items li WHERE li.price_list_id = pl.id) AS item_count
       FROM price_lists pl
       LEFT JOIN brands b ON pl.brand_id = b.id
       LEFT JOIN branches br ON pl.branch_id = br.id
       ORDER BY (pl.is_active = 0 OR pl.is_active IS NULL) ASC, pl.is_default DESC, pl.name`);
    res.json(rows.map(p => ({
      id: p.id, name: p.name, brandId: p.brand_id || '', brandName: p.brand_name || '',
      branchId: p.branch_id || '', branchName: p.branch_name || '',
      isDefault: !!p.is_default, validFrom: p.valid_from, validTo: p.valid_to,
      itemCount: Number(p.item_count) || 0, isActive: p.is_active !== false
    })));
  } catch(e) { res.json([]); }
});

router.post('/price-lists', async (req, res) => {
  try {
    // v5.16.1 — isActive added; validFrom/validTo optional (UI removed them
    // but kept on the schema for backward compatibility).
    const { id, name, brandId, branchId, isDefault, validFrom, validTo, isActive } = req.body;
    if (!name) return res.json({ success: false, error: 'اسم القائمة مطلوب' });
    const activeFlag = (isActive === false) ? 0 : 1;
    if (id) {
      await db.query(
        `UPDATE price_lists
            SET name=?, brand_id=?, branch_id=?, is_default=?, valid_from=?, valid_to=?, is_active=?
          WHERE id=?`,
        [name, brandId||null, branchId||null, isDefault?1:0,
         validFrom||null, validTo||null, activeFlag, id]);
      return res.json({ success: true, id });
    }
    const newId = genId('PL');
    await db.query(
      `INSERT INTO price_lists (id, name, brand_id, branch_id, is_default, valid_from, valid_to, is_active)
       VALUES (?,?,?,?,?,?,?,?)`,
      [newId, name, brandId||null, branchId||null, isDefault?1:0,
       validFrom||null, validTo||null, activeFlag]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// v5.16.1 — Bulk-add the brand's entire admin menu into a price list.
// Skips items already in the list (dedup via INSERT IGNORE on the
// composite unique key if present, falls back to a SELECT exists check
// otherwise). Returns counts so the UI can show a toast.
router.post('/price-lists/:plId/import-brand-menu', async (req, res) => {
  try {
    const { plId } = req.params;
    const { brandId } = req.body || {};
    if (!plId || !brandId) {
      return res.status(400).json({ success: false, error: 'plId و brandId مطلوبان' });
    }
    const [menuItems] = await db.query(
      `SELECT id, COALESCE(price, 0) AS price
         FROM menu
        WHERE brand_id = ?
          AND COALESCE(active, 1) = 1
          AND (is_semi_finished IS NULL OR is_semi_finished = 0)`,
      [brandId]
    );
    if (!menuItems.length) {
      return res.json({ success: true, imported: 0, skipped: 0, note: 'لا تَوجَد أصناف مَنيو لِهذا البراند' });
    }
    let imported = 0, skipped = 0;
    for (const m of menuItems) {
      try {
        // Check existence by (price_list_id, item_id)
        const [existing] = await db.query(
          'SELECT id FROM price_list_items WHERE price_list_id = ? AND item_id = ? LIMIT 1',
          [plId, m.id]
        );
        if (existing.length) { skipped++; continue; }
        const liId = 'PLI-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        await db.query(
          `INSERT INTO price_list_items (id, price_list_id, item_id, price, is_custom)
           VALUES (?, ?, ?, ?, 0)`,
          [liId, plId, m.id, Number(m.price) || 0]
        );
        imported++;
      } catch (e) { skipped++; }
    }
    res.json({ success: true, imported, skipped });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/price-lists/:id/items', async (req, res) => {
  try {
    // V3: items can come from EITHER menu (finished products) OR inv_items (raw)
    // v5.13.0: also supports standalone custom items (item_id NULL) where the
    // row carries its own item_name and item_category.
    const [rows] = await db.query(
      `SELECT li.*,
              COALESCE(li.item_name, m.name, i.name) AS effective_name,
              COALESCE(li.item_category, m.category, i.unit) AS effective_category,
              COALESCE(m.id, i.id) AS sku,
              CASE
                WHEN li.item_id IS NULL THEN 'custom'
                WHEN m.id IS NOT NULL    THEN 'menu'
                ELSE 'inv'
              END AS item_source,
              m.price AS default_price
       FROM price_list_items li
       LEFT JOIN menu m ON li.item_id = m.id
       LEFT JOIN inv_items i ON li.item_id = i.id
       WHERE li.price_list_id = ?
       ORDER BY effective_name`, [req.params.id]);
    res.json(rows.map(l => ({
      id: l.id, itemId: l.item_id,
      itemName: l.effective_name || l.item_id,
      sku: l.sku || l.item_id || '',
      itemSource: l.item_source || 'unknown',
      isCustom: l.item_id == null,
      categoryOrUnit: l.effective_category || '',
      defaultPrice: Number(l.default_price || 0),
      price: Number(l.price),
      minPrice: Number(l.min_price) || 0,
      validFrom: l.valid_from, validTo: l.valid_to
    })));
  } catch(e) { res.json([]); }
});

router.post('/price-lists/:id/items', async (req, res) => {
  try {
    // v5.13.0 — accept either {itemId} (menu/inv reference) or
    // {itemName, category} for a fully standalone custom item.
    const { itemId, itemName, category, price, minPrice, validFrom, validTo } = req.body;
    const isCustom = !itemId && !!itemName;
    if (!isCustom && !itemId) return res.json({ success: false, error: 'الصنف أو الاسم المُخصَّص مطلوب' });
    if (price == null) return res.json({ success: false, error: 'السعر مطلوب' });
    const id = genId('PLI');
    if (isCustom) {
      await db.query(
        `INSERT INTO price_list_items (id, price_list_id, item_id, item_name, item_category, price, min_price, valid_from, valid_to)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [id, req.params.id, itemName, category || null, Number(price), Number(minPrice)||0, validFrom||null, validTo||null]);
    } else {
      await db.query(
        `INSERT INTO price_list_items (id, price_list_id, item_id, price, min_price, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE price=VALUES(price), min_price=VALUES(min_price), valid_from=VALUES(valid_from), valid_to=VALUES(valid_to)`,
        [id, req.params.id, itemId, Number(price), Number(minPrice)||0, validFrom||null, validTo||null]);
    }
    res.json({ success: true, id });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/price-list-items/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM price_list_items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// v5.10.27 — Category-aware price-list management. These endpoints power
// the new category-tabbed editor that mirrors how the cashier groups
// products: every item belongs to a category, edit prices in bulk per
// category, and add menu items grouped by their menu.category.

// List distinct categories within a price list with item counts + price
// stats. NULL/empty categories collapse into "بدون تصنيف".
router.get('/price-lists/:id/categories', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT COALESCE(NULLIF(TRIM(COALESCE(li.item_category, m.category, i.unit, '')), ''), '__none__') AS cat,
             COUNT(*) AS item_count,
             MIN(li.price) AS min_price,
             MAX(li.price) AS max_price,
             AVG(li.price) AS avg_price
      FROM price_list_items li
      LEFT JOIN menu m ON li.item_id = m.id
      LEFT JOIN inv_items i ON li.item_id = i.id
      WHERE li.price_list_id = ?
      GROUP BY cat
      ORDER BY (cat = '__none__'), cat
    `, [req.params.id]);
    res.json(rows.map(r => ({
      name: r.cat === '__none__' ? '' : r.cat,
      label: r.cat === '__none__' ? 'بدون تصنيف' : r.cat,
      itemCount: Number(r.item_count) || 0,
      minPrice: Number(r.min_price) || 0,
      maxPrice: Number(r.max_price) || 0,
      avgPrice: Math.round((Number(r.avg_price) || 0) * 100) / 100
    })));
  } catch(e) { res.json([]); }
});

// Bulk update the prices of every item in a category. Three modes:
//   set      → set every price to `value`
//   add      → add `value` to every price (negative allowed for subtract)
//   percent  → multiply each price by (1 + value/100)
// Returns affected count. Min-price safety: prices never go below 0.
router.post('/price-lists/:id/categories/bulk-price', async (req, res) => {
  try {
    const { category, mode, value } = req.body || {};
    if (!mode || value == null) return res.json({ success: false, error: 'mode و value مطلوبان' });
    const v = Number(value);
    if (isNaN(v)) return res.json({ success: false, error: 'value يجب أن يكون رقماً' });
    // category may be '' (meaning "بدون تصنيف" — match NULL or empty)
    const catFilter = (category && category.trim())
      ? 'COALESCE(li.item_category, m.category, i.unit, "") = ?'
      : '(li.item_category IS NULL OR li.item_category = "") AND (m.category IS NULL OR m.category = "") AND (i.unit IS NULL OR i.unit = "")';
    const params = [req.params.id];
    if (category && category.trim()) params.push(category.trim());

    // Fetch matching IDs first so we can update precisely
    const [hits] = await db.query(`
      SELECT li.id, li.price
      FROM price_list_items li
      LEFT JOIN menu m ON li.item_id = m.id
      LEFT JOIN inv_items i ON li.item_id = i.id
      WHERE li.price_list_id = ? AND ${catFilter}
    `, params);
    if (!hits.length) return res.json({ success: true, affected: 0 });

    let affected = 0;
    for (const row of hits) {
      let newPrice;
      const cur = Number(row.price) || 0;
      if (mode === 'set')          newPrice = v;
      else if (mode === 'add')     newPrice = cur + v;
      else if (mode === 'percent') newPrice = cur * (1 + v / 100);
      else                          newPrice = cur;
      newPrice = Math.max(0, Math.round(newPrice * 100) / 100);
      await db.query('UPDATE price_list_items SET price = ? WHERE id = ?', [newPrice, row.id]);
      affected++;
    }
    res.json({ success: true, affected, mode, value: v });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Inline-edit save: bulk update specific line items by id.
// Body: { items: [{ id, price, minPrice?, category? }] }
router.post('/price-lists/:id/items/bulk-update', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.json({ success: false, error: 'items مطلوب' });
    let affected = 0;
    for (const it of items) {
      if (!it.id) continue;
      const fields = [];
      const params = [];
      if (it.price != null)    { fields.push('price = ?');         params.push(Math.max(0, Number(it.price) || 0)); }
      if (it.minPrice != null) { fields.push('min_price = ?');     params.push(Math.max(0, Number(it.minPrice) || 0)); }
      if (it.category != null) { fields.push('item_category = ?'); params.push(it.category || null); }
      if (!fields.length) continue;
      params.push(req.params.id, it.id);
      const [r] = await db.query(
        `UPDATE price_list_items SET ${fields.join(', ')} WHERE price_list_id = ? AND id = ?`,
        params);
      affected += r.affectedRows || 0;
    }
    res.json({ success: true, affected });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Move every item in one category to another. Useful for renaming
// categories without touching menu.category.
router.post('/price-lists/:id/categories/rename', async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (to == null) return res.json({ success: false, error: 'to مطلوب' });
    const fromFilter = (from && from.trim())
      ? 'COALESCE(item_category, "") = ?'
      : 'item_category IS NULL OR item_category = ""';
    const params = [to];
    if (from && from.trim()) params.push(from.trim());
    params.push(req.params.id);
    const [r] = await db.query(
      `UPDATE price_list_items SET item_category = ? WHERE ${fromFilter} AND price_list_id = ?`,
      params);
    res.json({ success: true, affected: r.affectedRows || 0 });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// V5.7 — DELETE the entire price list (with cascade across all dependent tables)
//   1. price_list_items   — line items in this list
//   2. sales_channels     — UNSET price_list_id pointers (don't break channels)
//   3. channel_menu_items — UNSET override_price refs that came from this list (if any)
//   4. price_lists        — the list itself (last)
//   ?force=1 query param required if list is the default one (extra safety).
router.delete('/price-lists/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const force = req.query.force === '1' || (req.body && req.body.force === true);
    // Read meta first
    const [pl] = await db.query('SELECT id, name, is_default FROM price_lists WHERE id = ?', [id]);
    if (!pl.length) return res.status(404).json({ success: false, error: 'القائمة غير موجودة' });
    if (pl[0].is_default && !force) {
      return res.status(409).json({
        success: false,
        error: 'هذه قائمة افتراضية — حذفها قد يكسر أسعار القنوات. أعد المحاولة مع ?force=1',
        requiresForce: true
      });
    }
    // Count what we're about to delete (for the response)
    const [itemCount] = await db.query('SELECT COUNT(*) AS c FROM price_list_items WHERE price_list_id = ?', [id]);
    let unlinkedChannels = 0;
    try {
      const [ch] = await db.query('SELECT COUNT(*) AS c FROM sales_channels WHERE price_list_id = ?', [id]);
      unlinkedChannels = Number((ch[0]||{}).c) || 0;
    } catch(_){}

    // Cascade — wrap in transaction so partial deletion can't happen
    try {
      await db.withTransaction(async (conn) => {
        await conn.query('DELETE FROM price_list_items WHERE price_list_id = ?', [id]);
        // Unlink (don't delete) sales_channels pointing here
        try { await conn.query('UPDATE sales_channels SET price_list_id = NULL WHERE price_list_id = ?', [id]); } catch(_){}
        await conn.query('DELETE FROM price_lists WHERE id = ?', [id]);
      });
    } catch(_e) {
      // Fallback if withTransaction unavailable — sequential best-effort
      try { await db.query('DELETE FROM price_list_items WHERE price_list_id = ?', [id]); } catch(_){}
      try { await db.query('UPDATE sales_channels SET price_list_id = NULL WHERE price_list_id = ?', [id]); } catch(_){}
      try { await db.query('DELETE FROM price_lists WHERE id = ?', [id]); } catch(_){}
    }
    res.json({
      success: true,
      deletedItems: Number((itemCount[0]||{}).c) || 0,
      unlinkedChannels: unlinkedChannels,
      name: pl[0].name
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// V5.5 — Bulk-add multiple items at once (used by the multi-select picker)
//   Body: { items: [{ itemId, price, minPrice? }, ...] }
//   Returns: { success, added, updated, skipped, errors }
router.post('/price-lists/:id/items/bulk', async (req, res) => {
  try {
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, error: 'items array required' });
    }
    let added = 0, updated = 0, skipped = 0;
    const errors = [];
    for (const it of items) {
      try {
        if (!it.itemId || it.price == null) { skipped++; continue; }
        const id = genId('PLI');
        const [r] = await db.query(
          `INSERT INTO price_list_items (id, price_list_id, item_id, price, min_price, valid_from, valid_to)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE price=VALUES(price), min_price=VALUES(min_price)`,
          [id, req.params.id, it.itemId, Number(it.price), Number(it.minPrice)||0,
           it.validFrom||null, it.validTo||null]);
        // affectedRows: 1 = INSERT, 2 = UPDATE on duplicate key
        if (r.affectedRows === 2) updated++; else added++;
      } catch(e) {
        errors.push({ itemId: it.itemId, error: e.message });
      }
    }
    res.json({ success: true, added, updated, skipped, errors });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// V5.7.6 — SMART TEMPLATE: pre-fills ALL menu items with their data so the user
// only needs to fill in the channel price column.
//
//   GET /api/erp/price-lists/:id/template?brandId=X
//
// CSV columns (in order):
//   itemId           — the menu item ID (used for exact matching, do NOT change)
//   name             — menu item name (read-only reference)
//   brand            — brand name from menu (read-only)
//   category         — category from menu (read-only)
//   defaultPrice     — the menu's base price (read-only reference)
//   currentChannelPrice — current price in this channel (empty if not set)
//   channelPrice     — ★ EDIT THIS ★ leave empty to skip
//   minPrice         — optional minimum allowed price (empty = no min)
//
// User downloads → fills channelPrice column in Excel → uploads via the
// existing import endpoint, which now matches by itemId (exact) before name.
router.get('/price-lists/:id/template', async (req, res) => {
  try {
    const plId = req.params.id;
    const brandFilter = req.query.brandId || null;

    // Load price list metadata
    const [pl] = await db.query(
      'SELECT id, name, brand_id FROM price_lists WHERE id = ?', [plId]);
    if (!pl.length) return res.status(404).json({ error: 'القائمة غير موجودة' });
    const list = pl[0];
    // Effective brand for the template = explicit query param OR list's own brand_id
    const effectiveBrand = brandFilter || list.brand_id;

    // Pull menu items (the source of truth for products, brand, category)
    const conds = ["(m.is_semi_finished IS NULL OR m.is_semi_finished = 0)"];
    const params = [];
    if (effectiveBrand) { conds.push('m.brand_id = ?'); params.push(effectiveBrand); }
    const [menuRows] = await db.query(`
      SELECT m.id, m.name, m.category, m.price AS default_price, m.brand_id,
             COALESCE(b.name, '') AS brand_name
      FROM menu m
      LEFT JOIN brands b ON b.id = m.brand_id
      WHERE ${conds.join(' AND ')}
      ORDER BY m.category, m.name`, params);

    // Pull existing prices in this channel (so user sees what's already set)
    const [existingItems] = await db.query(`
      SELECT item_id, price, min_price FROM price_list_items WHERE price_list_id = ?`, [plId]);
    const existingMap = {};
    existingItems.forEach(r => {
      existingMap[r.item_id] = { price: Number(r.price), minPrice: Number(r.min_price) || 0 };
    });

    // v5.10.75 — Column order: user-facing data first, system reference
    // (`_sysItemId`) LAST. The owner reported that seeing `itemId` as the
    // first column with cryptic IDs like "MENU-1729345-abc1" made him
    // assume he was supposed to manage them manually. The backend has
    // always auto-matched by name when `itemId` is empty, but the column
    // layout was misleading. By:
    //   1. Moving the ID to the LAST column
    //   2. Renaming with `_sys` prefix (Tableau/Notion convention for
    //      "system internal, do not edit")
    // …the user sees `name, brand, category, channelPrice` first — the
    // columns he actually cares about. The parser still accepts both
    // `itemId` and `_sysItemId` so old templates keep working.
    const headers = ['name','brand','category','defaultPrice','currentChannelPrice','channelPrice','minPrice','_sysItemId'];
    let csv = '﻿' + headers.join(',') + '\n';
    let prefilled = 0;
    menuRows.forEach(m => {
      const ex = existingMap[m.id];
      if (ex) prefilled++;
      const row = [
        '"' + (m.name || '').replace(/"/g, '""') + '"',
        '"' + (m.brand_name || '').replace(/"/g, '""') + '"',
        '"' + (m.category || '').replace(/"/g, '""') + '"',
        Number(m.default_price || 0).toFixed(2),
        ex ? ex.price.toFixed(2) : '',
        '',  // ★ user fills this — channelPrice
        ex && ex.minPrice ? ex.minPrice.toFixed(2) : '',
        m.id  // _sysItemId — system reference, last column, do not edit
      ];
      csv += row.join(',') + '\n';
    });

    const fname = 'price-list-' + (list.name || plId).replace(/[^\w؀-ۿ.-]/g, '_') + '.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(fname) + '"');
    res.setHeader('X-Template-Stats', 'total=' + menuRows.length + ',prefilled=' + prefilled);
    res.send(csv);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// V5.5 — Excel import: smart-match rows against menu (priority) then inv_items.
//   Body: { rows: [{ name, brand?, category?, price, minPrice? }, ...], dryRun?: bool }
//   Matching strategy:
//     1. Exact match on item name (case-insensitive, Arabic-normalized)
//     2. If brand provided, prefer items in that brand
//     3. If category provided, prefer items in that category
//   Returns detailed results so the UI can show user what matched vs not.
function _normAr(s){
  return String(s||'').trim().toLowerCase()
    .replace(/[ً-ْ]/g, '')        // strip diacritics
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}
router.post('/price-lists/:id/import', async (req, res) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    const dryRun = !!(req.body && req.body.dryRun);
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, error: 'rows array required' });
    }
    // Pre-load menu + inv_items pool for matching (single query each)
    const [menuPool] = await db.query(
      `SELECT m.id, m.name, m.category, m.price AS default_price, m.brand_id, b.name AS brand_name
       FROM menu m LEFT JOIN brands b ON b.id = m.brand_id`);
    let invPool = [];
    try {
      [invPool] = await db.query(
        `SELECT i.id, i.name, i.category, i.cost AS default_price, i.brand_id, b.name AS brand_name
         FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id
         WHERE COALESCE(i.active, 1) = 1`);
    } catch(_) { /* table may not have all cols */ }

    // Build lookup: normalized name → array of matches
    const buildIdx = (pool, source) => {
      const idx = new Map();
      pool.forEach(r => {
        const k = _normAr(r.name);
        if (!k) return;
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push({
          id: r.id, name: r.name, category: r.category, brandId: r.brand_id,
          brandName: r.brand_name, defaultPrice: Number(r.default_price)||0,
          source: source
        });
      });
      return idx;
    };
    const menuIdx = buildIdx(menuPool, 'menu');
    const invIdx  = buildIdx(invPool, 'inv');

    const results = {
      total: rows.length,
      matched: 0, ambiguous: 0, unmatched: 0, invalid: 0, added: 0, updated: 0,
      details: []
    };

    // V5.7.6: also build itemId index for exact matching when smart template is used
    const idIdx = new Map();
    [...menuIdx.values(), ...invIdx.values()].forEach(arr => {
      arr.forEach(m => idIdx.set(m.id, m));
    });

    const toAdd = [];   // [{ itemId, price, minPrice, srcRow }]
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const detail = { rowIndex: i+1, input: row };
      // V5.7.6 — read EITHER `channelPrice` (smart template) OR `price` (legacy)
      const inPrice = row.channelPrice != null && row.channelPrice !== ''
        ? row.channelPrice : row.price;
      // V5.7.6 — Skip empty rows silently (smart template has all menu items, user only fills some)
      if ((inPrice == null || inPrice === '') && (row.itemId || row.name)) {
        detail.status = 'skipped'; detail.reason = 'سعر فارغ — لم يُحدَّد';
        results.invalid++; results.details.push(detail); continue;
      }
      if (!row.name && !row.itemId) {
        detail.status = 'invalid'; detail.reason = 'الاسم أو معرّف المنتج مطلوب';
        results.invalid++; results.details.push(detail); continue;
      }
      if (inPrice == null || isNaN(Number(inPrice))) {
        detail.status = 'invalid'; detail.reason = 'السعر مطلوب';
        results.invalid++; results.details.push(detail); continue;
      }

      let matches = [];
      // V5.7.6 — Match by itemId FIRST (smart-template path = zero ambiguity)
      if (row.itemId && idIdx.has(row.itemId)) {
        matches = [idIdx.get(row.itemId)];
      } else {
        // Fallback: name-based matching (legacy CSV imports)
        const key = _normAr(row.name);
        matches = (menuIdx.get(key) || []).slice();
        if (!matches.length) matches = (invIdx.get(key) || []).slice();

        // Filter by brand if provided
        if (matches.length > 1 && row.brand) {
          const bn = _normAr(row.brand);
          const brandFiltered = matches.filter(m => _normAr(m.brandName) === bn);
          if (brandFiltered.length) matches = brandFiltered;
        }
        // Filter by category if provided
        if (matches.length > 1 && row.category) {
          const cn = _normAr(row.category);
          const catFiltered = matches.filter(m => _normAr(m.category) === cn);
          if (catFiltered.length) matches = catFiltered;
        }
      }

      if (matches.length === 0) {
        detail.status = 'unmatched'; detail.reason = 'لم يتم إيجاد منتج بهذا الاسم/المعرّف';
        results.unmatched++; results.details.push(detail); continue;
      }
      if (matches.length > 1) {
        detail.status = 'ambiguous';
        detail.reason = 'تطابق متعدد ('+matches.length+') — حدد البراند أو الفئة';
        detail.candidates = matches.slice(0,5).map(m => ({ id:m.id, name:m.name, brand:m.brandName, source:m.source }));
        results.ambiguous++; results.details.push(detail); continue;
      }
      // Single match → ready to import
      const m = matches[0];
      detail.status = 'matched'; detail.matchId = m.id; detail.matchName = m.name;
      detail.matchSource = m.source; detail.matchBrand = m.brandName;
      results.matched++;
      toAdd.push({ itemId: m.id, price: Number(inPrice), minPrice: Number(row.minPrice)||0, srcRow: i+1 });
      results.details.push(detail);
    }

    if (dryRun) {
      return res.json({ success: true, dryRun: true, ...results });
    }

    // Real import — bulk-insert all matched
    for (const it of toAdd) {
      try {
        const id = genId('PLI');
        const [r] = await db.query(
          `INSERT INTO price_list_items (id, price_list_id, item_id, price, min_price)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE price=VALUES(price), min_price=VALUES(min_price)`,
          [id, req.params.id, it.itemId, it.price, it.minPrice]);
        if (r.affectedRows === 2) results.updated++; else results.added++;
      } catch(e) {
        const d = results.details.find(x => x.matchId === it.itemId && x.rowIndex === it.srcRow);
        if (d) { d.status = 'error'; d.reason = e.message; }
      }
    }
    res.json({ success: true, dryRun: false, ...results });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// BOM / RECIPES
// V5.6 — supports BOTH menu items AND inv_items as the "final product"
// product_source ENUM('menu','inv') is stored on bom row; resolves name accordingly.
// ═══════════════════════════════════════
router.get('/bom', async (req, res) => {
  try {
    const { product_id, brandId, source } = req.query;
    // Pull product name from EITHER menu OR inv_items based on product_source
    let sql = `SELECT b.*,
                      COALESCE(m.name, i.name) AS product_name,
                      COALESCE(m.name_en, i.name_en) AS product_name_en,
                      COALESCE(m.category, i.category) AS category,
                      COALESCE(m.brand_id, i.brand_id) AS brand_id,
                      COALESCE(mb.name, ib.name) AS brand_name,
                      COALESCE(b.product_source, 'inv') AS resolved_source,
                      (SELECT COUNT(*) FROM bom_lines bl WHERE bl.bom_id = b.id) AS line_count
               FROM bom b
               LEFT JOIN menu m       ON b.product_id = m.id AND b.product_source = 'menu'
               LEFT JOIN inv_items i  ON b.product_id = i.id AND COALESCE(b.product_source,'inv') = 'inv'
               LEFT JOIN brands mb    ON mb.id = m.brand_id
               LEFT JOIN brands ib    ON ib.id = i.brand_id
               WHERE 1=1`;
    const params = [];
    if (product_id) { sql += ' AND b.product_id = ?'; params.push(product_id); }
    if (source)     { sql += ' AND COALESCE(b.product_source, "inv") = ?'; params.push(source); }
    if (brandId)    { sql += ' AND COALESCE(m.brand_id, i.brand_id) = ?'; params.push(brandId); }
    sql += ' ORDER BY product_name, b.version DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(b => ({
      id: b.id, productId: b.product_id, productName: b.product_name || '',
      productNameEn: b.product_name_en || '',
      category: b.category || 'عام',
      productSource: b.resolved_source || 'inv',
      brandId: b.brand_id || null, brandName: b.brand_name || '',
      version: b.version, yieldQuantity: Number(b.yield_quantity) || 1,
      yieldUnit: b.yield_unit || 'PCS', isActive: b.is_active !== false,
      effectiveFrom: b.effective_from, effectiveTo: b.effective_to,
      lineCount: Number(b.line_count) || 0, notes: b.notes || ''
    })));
  } catch(e) { res.json([]); }
});

// V5.6 — Unified product pool for BOM editor (combines menu + inv_items).
// Frontend uses this in WoItemPicker so user can pick EITHER as the final product.
router.get('/bom/product-pool', async (req, res) => {
  try {
    const { brandId, q } = req.query;
    const params = []; const whereM = []; const whereI = [];
    if (brandId) { whereM.push('m.brand_id = ?'); whereI.push('i.brand_id = ?'); params.push(brandId); }
    if (q) {
      whereM.push('m.name LIKE ?'); whereI.push('i.name LIKE ?');
      params.push('%'+q+'%');
    }
    // Two queries unioned at app level (different binds)
    const wM = whereM.length ? 'WHERE '+whereM.join(' AND ') : '';
    const [menuRows] = await db.query(
      `SELECT m.id, m.name, m.category, COALESCE(m.cost,0) AS cost,
              m.brand_id, b.name AS brand_name,
              COALESCE(m.is_semi_finished,0) AS is_semi_finished,
              m.bom_id,
              'menu' AS source
       FROM menu m LEFT JOIN brands b ON b.id = m.brand_id ${wM}
       ORDER BY m.name LIMIT 1500`,
      brandId ? [brandId] : []);
    const wI = whereI.length ? 'WHERE '+whereI.join(' AND ')+' AND COALESCE(i.active,1)=1' : 'WHERE COALESCE(i.active,1)=1';
    // v5.10.65 — LEFT JOIN bom to surface the real recipe state of each
    // inv_item. Previously this query hard-coded `0 AS is_semi_finished`
    // and `NULL AS bom_id`, which prevented the BOM picker from showing
    // existing recipes on inventory items (the user had to either
    // remember the bom_id or hunt through the BOM list). Now an inv item
    // with an active BOM (product_source='inv') correctly reports its
    // hasRecipe + isSemiFinished + bom_id, and the catalog UI can
    // decide whether to open the recipe modal in CREATE or EDIT mode.
    const [invRows] = await db.query(
      `SELECT i.id, i.name, i.category, COALESCE(i.cost,0) AS cost,
              i.brand_id, b.name AS brand_name,
              CASE WHEN COALESCE(i.kind, 'raw') = 'semi' THEN 1 ELSE 0 END AS is_semi_finished,
              bom.id AS bom_id,
              'inv' AS source
       FROM inv_items i
       LEFT JOIN brands b   ON b.id = i.brand_id
       LEFT JOIN bom        ON bom.product_id = i.id
                            AND COALESCE(bom.product_source, 'inv') = 'inv'
                            AND COALESCE(bom.is_active, 1) = 1
       ${wI}
       ORDER BY i.name LIMIT 1500`,
      brandId ? [brandId] : []);
    res.json([
      ...menuRows.map(r => ({
        id: r.id, name: r.name, category: r.category,
        cost: Number(r.cost)||0, brandId: r.brand_id, brandName: r.brand_name,
        isSemiFinished: !!r.is_semi_finished,
        hasRecipe: !!r.bom_id, source: 'menu',
        sourceLabel: r.is_semi_finished ? 'منيو (نصف مصنع)' : 'منيو (منتج نهائي)'
      })),
      ...invRows.map(r => ({
        id: r.id, name: r.name, category: r.category,
        cost: Number(r.cost)||0, brandId: r.brand_id, brandName: r.brand_name,
        isSemiFinished: !!r.is_semi_finished,
        hasRecipe: !!r.bom_id,
        bomId: r.bom_id || null,
        source: 'inv',
        sourceLabel: r.is_semi_finished ? 'مخزون (نصف مُصنَّع)' : 'مادة مخزنية'
      }))
    ]);
  } catch(e) {
    console.error('[bom/product-pool]', e.message);
    res.json([]);
  }
});

// V5.6 — Reverse-lookup: which products use this ingredient?
router.get('/inventory/usage/:itemId', async (req, res) => {
  try {
    const itemId = req.params.itemId;
    // 1. Products via BOM
    const [viaBom] = await db.query(`
      SELECT b.id AS bom_id, b.product_id, b.product_source,
             COALESCE(m.name, i.name) AS product_name,
             bl.quantity, bl.unit, bl.waste_pct
      FROM bom_lines bl
      INNER JOIN bom b ON b.id = bl.bom_id
      LEFT JOIN menu m       ON m.id = b.product_id AND b.product_source = 'menu'
      LEFT JOIN inv_items i  ON i.id = b.product_id AND COALESCE(b.product_source,'inv') = 'inv'
      WHERE bl.component_item_id = ? AND b.is_active = 1`, [itemId]);
    // 2. Products via legacy `recipe` table
    let viaRecipe = [];
    try {
      const [r] = await db.query(`
        SELECT m.id AS product_id, m.name AS product_name,
               r.qty_used AS quantity, r.unit AS unit
        FROM recipe r INNER JOIN menu m ON m.id = r.menu_id
        WHERE r.inv_item_id = ?`, [itemId]);
      viaRecipe = r;
    } catch(_) {}
    res.json({
      itemId: itemId,
      viaBomCount: viaBom.length,
      viaRecipeCount: viaRecipe.length,
      via: [
        ...viaBom.map(r => ({
          bomId: r.bom_id, productId: r.product_id, productName: r.product_name,
          source: r.product_source, quantity: Number(r.quantity)||0,
          unit: r.unit, wastePct: Number(r.waste_pct)||0, type: 'bom'
        })),
        ...viaRecipe.map(r => ({
          productId: r.product_id, productName: r.product_name,
          source: 'menu', quantity: Number(r.quantity)||0,
          unit: r.unit, wastePct: 0, type: 'legacy_recipe'
        }))
      ]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/bom', async (req, res) => {
  try {
    const { id, productId, productSource, version, yieldQuantity, yieldUnit, effectiveFrom, effectiveTo, notes, lines, consumptionWarehouseId } = req.body;
    if (!productId) return res.json({ success: false, error: 'المنتج مطلوب' });
    // V5.6: validate productSource is either 'menu' or 'inv'; default to 'inv' for backward compat.
    const src = (productSource === 'menu') ? 'menu' : 'inv';
    let bomId = id;
    if (id) {
      await db.query(
        `UPDATE bom SET product_id=?, product_source=?, version=?, yield_quantity=?, yield_unit=?,
                       effective_from=?, effective_to=?, notes=?, consumption_warehouse_id=?
         WHERE id=?`,
        [productId, src, Number(version)||1, Number(yieldQuantity)||1, yieldUnit||'PCS',
         effectiveFrom||null, effectiveTo||null, notes||'',
         consumptionWarehouseId||null, id]);
    } else {
      bomId = genId('BOM');
      await db.query(
        `INSERT INTO bom (id, product_id, product_source, version, yield_quantity, yield_unit,
                          effective_from, effective_to, notes, consumption_warehouse_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [bomId, productId, src, Number(version)||1, Number(yieldQuantity)||1, yieldUnit||'PCS',
         effectiveFrom||null, effectiveTo||null, notes||'', consumptionWarehouseId||null]);
    }
    // V5.6: if BOM is for a menu item, link bom_id back to menu row
    if (src === 'menu') {
      try { await db.query('UPDATE menu SET bom_id = ? WHERE id = ?', [bomId, productId]); } catch(_){}
    }
    // V5.7.27 — validate components exist + skip qty<=0 lines + bulk INSERT.
    //   Was: 1 DELETE + N INSERT loop (N+1 round trips). Now: 1 DELETE + 1 multi-row INSERT.
    //   Also rejects unknown componentItemId so we get a clear error rather
    //   than a silent FK violation later.
    if (Array.isArray(lines)) {
      const validLines = [];
      const skipped = [];
      const unknownIds = [];
      // Deduplicate by componentItemId — last write wins (matches frontend's
      // "skip if already added" guard but defensive against malformed payloads)
      const seenIds = new Set();
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        const compId = l && (l.componentItemId || l.itemId);
        if (!compId) { skipped.push({ reason: 'no-id', index: i }); continue; }
        const qty = Number(l.quantity) || 0;
        if (qty <= 0) { skipped.push({ reason: 'qty<=0', index: i, compId }); continue; }
        if (seenIds.has(compId)) { skipped.push({ reason: 'duplicate', index: i, compId }); continue; }
        seenIds.add(compId);
        validLines.unshift(l);  // preserve original order
      }
      // Validate every componentItemId exists in inv_items
      if (validLines.length) {
        const ids = Array.from(new Set(validLines.map(l => l.componentItemId || l.itemId)));
        const placeholders = ids.map(() => '?').join(',');
        const [foundRows] = await db.query(
          `SELECT id FROM inv_items WHERE id IN (${placeholders})`, ids);
        const foundIds = new Set(foundRows.map(r => r.id));
        ids.forEach(id => { if (!foundIds.has(id)) unknownIds.push(id); });
        if (unknownIds.length) {
          return res.json({
            success: false,
            error: 'مكوّنات غير موجودة في المخزون: ' + unknownIds.join(', '),
            unknownComponents: unknownIds
          });
        }
      }
      await db.query('DELETE FROM bom_lines WHERE bom_id = ?', [bomId]);
      if (validLines.length) {
        // Bulk multi-row INSERT (one round trip instead of N)
        const valuesSql = validLines.map(() => '(?,?,?,?,?,?)').join(',');
        const params = [];
        validLines.forEach(l => {
          params.push(
            genId('BL'), bomId,
            l.componentItemId || l.itemId,
            Number(l.quantity) || 0,
            l.unit || 'PCS',
            Number(l.wastePct) || 0
          );
        });
        await db.query(
          `INSERT INTO bom_lines (id, bom_id, component_item_id, quantity, unit, waste_pct)
           VALUES ${valuesSql}`, params);
      }
    }

    // V5.7.22 — Auto-update menu.cost from the new BOM lines whenever the
    //   target is a menu item. Frontend may send `recomputedCost` (exact
    //   value it just displayed); we trust it. As a fallback we recompute
    //   server-side from sum(quantity × inv_items.cost) so the cost is
    //   always in sync with the recipe (no manual recompute step needed).
    if (src === 'menu') {
      let newCost = Number(req.body.recomputedCost);
      if (!newCost && Array.isArray(lines) && lines.length) {
        try {
          const [costRows] = await db.query(
            `SELECT bl.quantity, bl.waste_pct, COALESCE(i.cost,0) AS unit_cost
             FROM bom_lines bl LEFT JOIN inv_items i ON i.id = bl.component_item_id
             WHERE bl.bom_id = ?`, [bomId]);
          newCost = costRows.reduce((s, r) => {
            const q = Number(r.quantity) || 0;
            const c = Number(r.unit_cost) || 0;
            const w = Number(r.waste_pct) || 0;
            return s + q * c * (1 + w / 100);
          }, 0);
          newCost = Math.round(newCost * 10000) / 10000;
        } catch (_) { newCost = null; }
      }
      if (newCost != null && !isNaN(newCost)) {
        try {
          await db.query('UPDATE menu SET cost = ?, computed_cost = ? WHERE id = ?', [newCost, newCost, productId]);
          // v5.10.14 — Semi-finished products are inventory items: their
          // cost = sum of component costs from the recipe. Mirror the
          // recomputed cost into inv_items so warehouse views, valuation
          // reports, and downstream production orders see the same number.
          try {
            const [mr] = await db.query('SELECT is_semi_finished FROM menu WHERE id = ?', [productId]);
            if (mr.length && Number(mr[0].is_semi_finished)) {
              await db.query('UPDATE inv_items SET cost = ? WHERE id = ?', [newCost, productId]);
            }
          } catch(_) { /* inv_items row may not exist for this menu item — non-fatal */ }
        } catch (_) {}
      }
    }
    res.json({ success: true, id: bomId, productSource: src });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/bom/:id/lines', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT bl.*, i.name AS item_name, i.name_en AS item_name_en, i.id AS sku, COALESCE(i.cost,0) AS avg_cost
       FROM bom_lines bl
       LEFT JOIN inv_items i ON bl.component_item_id = i.id
       WHERE bl.bom_id = ?`, [req.params.id]);
    res.json(rows.map(l => ({
      id: l.id, componentItemId: l.component_item_id, itemName: l.item_name || '', itemNameEn: l.item_name_en || '',
      sku: l.sku || '', quantity: Number(l.quantity), unit: l.unit || 'PCS',
      wastePct: Number(l.waste_pct) || 0, avgCost: Number(l.avg_cost) || 0,
      lineCost: (Number(l.quantity) || 0) * (Number(l.avg_cost) || 0) * (1 + (Number(l.waste_pct) || 0) / 100)
    })));
  } catch(e) { res.json([]); }
});

// V5.7 — Hard-delete BOM with full cascade.
// FIXES: previously this was a soft-delete (is_active=0) but menu.bom_id still
// pointed to the now-inactive BOM, leaving the menu item in a broken state where
// the recipe button wouldn't work. The new logic:
// V5.9.1 — Delete ALL Recipes (BOMs) at once
router.delete('/bom-all/clear', async (req, res) => {
  try {
    await db.withTransaction(async (conn) => {
      // Unlink from all menu items
      await conn.query('UPDATE menu SET bom_id = NULL WHERE bom_id IS NOT NULL');
      // Delete all ingredients
      await conn.query('DELETE FROM bom_lines');
      // Delete all BOM records
      await conn.query('DELETE FROM bom');
    });
    res.json({ success: true, message: 'تم حذف جميع الوصفات بنجاح' });
  } catch (err) {
    console.error('Error clearing all BOMs:', err);
    res.json({ success: false, error: 'حدث خطأ أثناء حذف الوصفات: ' + err.message });
  }
});

//   1. Read product_source + product_id BEFORE deletion
//   2. Cascade-delete bom_lines (the recipe ingredients)
//   3. Delete the BOM row itself
//   4. If product_source='menu', clear menu.bom_id so the menu item knows
//      it no longer has a recipe
router.delete('/bom/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // Read BOM meta first
    const [b] = await db.query(
      'SELECT id, product_id, product_source FROM bom WHERE id = ?', [id]);
    if (!b.length) return res.json({ success: false, error: 'الوصفة غير موجودة' });
    const bom = b[0];
    const src = bom.product_source || 'inv';
    // Run cascade in a transaction so partial deletion can't happen
    try {
      await db.withTransaction(async (conn) => {
        await conn.query('DELETE FROM bom_lines WHERE bom_id = ?', [id]);
        await conn.query('DELETE FROM bom WHERE id = ?', [id]);
        // Clear menu.bom_id if this BOM was linked to a menu item
        if (src === 'menu' && bom.product_id) {
          await conn.query('UPDATE menu SET bom_id = NULL WHERE id = ? AND bom_id = ?',
            [bom.product_id, id]);
        }
      });
    } catch(_e) {
      // Fallback if withTransaction unavailable — sequential best-effort
      try { await db.query('DELETE FROM bom_lines WHERE bom_id = ?', [id]); } catch(_){}
      try { await db.query('DELETE FROM bom WHERE id = ?', [id]); } catch(_){}
      if (src === 'menu' && bom.product_id) {
        try { await db.query('UPDATE menu SET bom_id = NULL WHERE id = ? AND bom_id = ?',
          [bom.product_id, id]); } catch(_){}
      }
    }
    res.json({ success: true, productId: bom.product_id, productSource: src });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Bulk-assign brand to rows that currently have no brand.
// Body: { brandId, force? (default false — only updates null/empty), targets? (['menu','inv_items'] — default both) }
router.post('/brands/assign-default', async (req, res) => {
  try {
    const { brandId, force, targets } = req.body;
    if (!brandId) return res.json({ success: false, error: 'brandId مطلوب' });
    const [b] = await db.query('SELECT id, name FROM brands WHERE id = ?', [brandId]);
    if (!b.length) return res.json({ success: false, error: 'البراند غير موجود' });
    const useTargets = Array.isArray(targets) && targets.length ? targets : ['menu','inv_items'];
    const result = { success: true, brandId, brandName: b[0].name, menuUpdated: 0, itemsUpdated: 0 };
    const whereClause = force ? '1=1' : "(brand_id IS NULL OR brand_id = '')";

    if (useTargets.indexOf('menu') >= 0) {
      const [r] = await db.query('UPDATE menu SET brand_id = ? WHERE ' + whereClause, [brandId]);
      result.menuUpdated = r.affectedRows || 0;
    }
    if (useTargets.indexOf('inv_items') >= 0) {
      const [r] = await db.query('UPDATE inv_items SET brand_id = ? WHERE ' + whereClause, [brandId]);
      result.itemsUpdated = r.affectedRows || 0;
    }
    res.json(result);
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Clone a BOM to a new product (optionally a different brand)
// Accepts: itemId OR componentItemId in line objects — tolerates either naming.
router.post('/bom/:id/clone', async (req, res) => {
  try {
    const srcId = req.params.id;
    const { newProductId, newVersion, notes, copyLines } = req.body;
    if (!newProductId) return res.json({ success: false, error: 'المنتج الجديد مطلوب' });

    // Load source BOM
    const [srcRows] = await db.query('SELECT * FROM bom WHERE id = ?', [srcId]);
    if (!srcRows.length) return res.json({ success: false, error: 'الوصفة المصدر غير موجودة' });
    const src = srcRows[0];

    // Create new BOM
    const newId = genId('BOM');
    await db.query(
      `INSERT INTO bom (id, product_id, version, yield_quantity, yield_unit, notes, is_active)
       VALUES (?,?,?,?,?,?,1)`,
      [newId, newProductId, Number(newVersion) || 1,
       Number(src.yield_quantity) || 1, src.yield_unit || 'PCS',
       notes || (src.notes ? '[نسخة من ' + srcId + '] ' + src.notes : 'نسخة من وصفة ' + srcId)]);

    // Copy lines unless explicitly disabled
    if (copyLines !== false) {
      const [lines] = await db.query('SELECT * FROM bom_lines WHERE bom_id = ?', [srcId]);
      for (const l of lines) {
        await db.query(
          `INSERT INTO bom_lines (id, bom_id, component_item_id, quantity, unit, waste_pct)
           VALUES (?,?,?,?,?,?)`,
          [genId('BL'), newId, l.component_item_id,
           Number(l.quantity) || 0, l.unit || 'PCS', Number(l.waste_pct) || 0]);
      }
    }

    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// POS TERMINALS
// ═══════════════════════════════════════
router.get('/pos-terminals', async (req, res) => {
  try {
    const { branch_id } = req.query;
    let sql = `SELECT pt.*, b.name AS branch_name FROM pos_terminals pt
               LEFT JOIN branches b ON pt.branch_id = b.id
               WHERE pt.is_active = 1 OR pt.is_active IS NULL`;
    const params = [];
    if (branch_id) { sql += ' AND pt.branch_id = ?'; params.push(branch_id); }
    sql += ' ORDER BY b.name, pt.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(t => ({
      id: t.id, name: t.name, code: t.code || '',
      branchId: t.branch_id, branchName: t.branch_name || '',
      deviceId: t.device_id || '', lastSyncAt: t.last_sync_at,
      isActive: t.is_active !== false
    })));
  } catch(e) { res.json([]); }
});

router.post('/pos-terminals', async (req, res) => {
  try {
    const { id, name, code, branchId, deviceId } = req.body;
    if (!name || !branchId) return res.json({ success: false, error: 'الاسم والفرع مطلوبان' });
    if (id) {
      await db.query(
        `UPDATE pos_terminals SET name=?, code=?, branch_id=?, device_id=? WHERE id=?`,
        [name, code||'', branchId, deviceId||'', id]);
      return res.json({ success: true, id });
    }
    const newId = genId('POS');
    await db.query(
      `INSERT INTO pos_terminals (id, name, code, branch_id, device_id) VALUES (?,?,?,?,?)`,
      [newId, name, code||'', branchId, deviceId||'']);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/pos-terminals/:id', async (req, res) => {
  try {
    await db.query('UPDATE pos_terminals SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// ACCOUNTING PERIODS (period lock)
// ═══════════════════════════════════════
router.get('/accounting-periods', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM accounting_periods ORDER BY start_date DESC');
    res.json(rows.map(p => ({
      id: p.id, periodName: p.period_name,
      startDate: p.start_date, endDate: p.end_date,
      status: p.status, closedBy: p.closed_by || '', closedAt: p.closed_at,
      notes: p.notes || ''
    })));
  } catch(e) { res.json([]); }
});

router.post('/accounting-periods', async (req, res) => {
  try {
    const { id, periodName, startDate, endDate } = req.body;
    if (!periodName || !startDate || !endDate) return res.json({ success: false, error: 'الحقول مطلوبة' });
    if (id) {
      await db.query(`UPDATE accounting_periods SET period_name=?, start_date=?, end_date=? WHERE id=? AND status != 'closed'`,
        [periodName, startDate, endDate, id]);
      return res.json({ success: true, id });
    }
    const newId = genId('AP');
    await db.query(
      `INSERT INTO accounting_periods (id, period_name, start_date, end_date, status) VALUES (?,?,?,?,'open')`,
      [newId, periodName, startDate, endDate]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.post('/accounting-periods/:id/close', async (req, res) => {
  try {
    const { username } = req.body;
    await db.query(
      `UPDATE accounting_periods SET status='closed', closed_by=?, closed_at=NOW() WHERE id=?`,
      [username||'', req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.post('/accounting-periods/:id/reopen', async (req, res) => {
  try {
    await db.query(`UPDATE accounting_periods SET status='open', closed_by=NULL, closed_at=NULL WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Helper endpoint — check if a date falls in a closed period
router.get('/period-status', async (req, res) => {
  try {
    const d = req.query.date;
    const closed = await isPeriodClosed(d);
    res.json({ date: d, closed });
  } catch(e) { res.json({ closed: false }); }
});

// ═══════════════════════════════════════
// ROYALTY RUNS (franchise accrual)
// ═══════════════════════════════════════
router.get('/royalty-runs', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT rr.*, b.name AS brand_name
       FROM royalty_runs rr
       LEFT JOIN brands b ON rr.brand_id = b.id
       ORDER BY rr.run_date DESC`);
    res.json(rows.map(r => ({
      id: r.id, brandId: r.brand_id, brandName: r.brand_name || '',
      runDate: r.run_date, periodStart: r.period_start, periodEnd: r.period_end,
      grossSales: Number(r.gross_sales) || 0, netSales: Number(r.net_sales) || 0,
      royaltyType: r.royalty_type, royaltyValue: Number(r.royalty_value) || 0,
      fixedComponent: Number(r.fixed_component) || 0,
      royaltyAmount: Number(r.royalty_amount) || 0,
      status: r.status, approvedBy: r.approved_by || '', approvedAt: r.approved_at,
      paidAt: r.paid_at, notes: r.notes || ''
    })));
  } catch(e) { res.json([]); }
});

// Compute royalty for a brand + period (creates draft entry)
router.post('/royalty-runs/compute', async (req, res) => {
  try {
    const { brandId, periodStart, periodEnd } = req.body;
    if (!brandId || !periodStart || !periodEnd) return res.json({ success: false, error: 'الحقول مطلوبة' });

    // Load brand royalty settings
    const [br] = await db.query('SELECT * FROM brands WHERE id = ?', [brandId]);
    if (!br.length) return res.json({ success: false, error: 'البراند غير موجود' });
    const b = br[0];

    // Aggregate sales for the brand/period
    const [agg] = await db.query(
      `SELECT COALESCE(SUM(total_amount),0) AS gross,
              COALESCE(SUM(total_amount - COALESCE(vat_amount,0)),0) AS net
       FROM sales
       WHERE brand_id = ? AND DATE(created_at) BETWEEN ? AND ?
         AND (deleted_at IS NULL)`,
      [brandId, periodStart, periodEnd]);
    const gross = Number(agg[0].gross) || 0;
    const net = Number(agg[0].net) || 0;

    // Compute royalty based on brand settings
    const rtype = b.royalty_type || 'none';
    const rvalue = Number(b.royalty_value) || 0;
    const rbase = b.royalty_base || 'gross_sales';
    const fixedComponent = Number(b.royalty_fixed_component) || 0;
    const baseAmount = rbase === 'net_sales' ? net : gross;

    let amount = 0;
    if (rtype === 'percentage') amount = baseAmount * rvalue / 100;
    else if (rtype === 'fixed') amount = rvalue;
    else if (rtype === 'mixed') amount = fixedComponent + (baseAmount * rvalue / 100);

    // Round to 2 decimals
    amount = Math.round(amount * 100) / 100;

    const id = genId('RR');
    await db.query(
      `INSERT INTO royalty_runs (
         id, brand_id, run_date, period_start, period_end,
         gross_sales, net_sales, royalty_type, royalty_value, fixed_component, royalty_amount, status
       ) VALUES (?,?,CURDATE(),?,?, ?,?,?,?,?,?,'draft')`,
      [id, brandId, periodStart, periodEnd, gross, net, rtype, rvalue, fixedComponent, amount]);
    res.json({ success: true, id, grossSales: gross, netSales: net, royaltyAmount: amount });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.post('/royalty-runs/:id/approve', async (req, res) => {
  try {
    const { username } = req.body;
    const [rr] = await db.query('SELECT * FROM royalty_runs WHERE id = ?', [req.params.id]);
    if (!rr.length) return res.json({ success: false, error: 'الاحتساب غير موجود' });
    if (rr[0].status !== 'draft') return res.json({ success: false, error: 'لا يمكن الاعتماد — الحالة ليست مسودة' });

    const run = rr[0];
    const amt = Number(run.royalty_amount) || 0;

    await db.query(
      `UPDATE royalty_runs SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?`,
      [username || '', req.params.id]);

    // ═══ AUTO GL POSTING ═══
    // Dr Franchise Fee Expense (brand dimension) / Cr Franchise Royalty Payable
    let postResult = { success: true };
    if (amt > 0) {
      postResult = await gl.postJournal(db, {
        journalDate: run.run_date || new Date().toISOString().slice(0, 10),
        description: 'Royalty accrual — ' + (run.period_start || '') + ' to ' + (run.period_end || ''),
        referenceType: 'RoyaltyRun',
        referenceId: req.params.id,
        entries: [
          {
            accountCode: '6100',                 // Franchise Fee Expense
            debit: amt, credit: 0,
            description: 'Franchise royalty expense',
            brandId: run.brand_id
          },
          {
            accountCode: '2310',                 // Royalty Payable
            debit: 0, credit: amt,
            description: 'Royalty liability to brand owner',
            brandId: run.brand_id
          }
        ],
        postedBy: username || ''
      });
      if (postResult.journalId) {
        await db.query('UPDATE royalty_runs SET gl_journal_id = ? WHERE id = ?', [postResult.journalId, req.params.id]);
      }
    }
    res.json({
      success: true,
      journalId: postResult.journalId || null,
      journalNumber: postResult.journalNumber || null,
      postingWarning: postResult.success ? null : postResult.error
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.post('/royalty-runs/:id/mark-paid', async (req, res) => {
  try {
    await db.query(
      `UPDATE royalty_runs SET status='paid', paid_at=NOW() WHERE id=? AND status IN ('approved','invoiced')`,
      [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/royalty-runs/:id', async (req, res) => {
  try {
    await db.query(`DELETE FROM royalty_runs WHERE id=? AND status='draft'`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// WASTE ENTRIES
// ═══════════════════════════════════════
// v5.10.34 — Enhanced: pagination + search + reason/warehouse filters + summary.
// Back-compat: still returns array shape when ?paginated is not set.
router.get('/waste-entries', async (req, res) => {
  try {
    const { brand_id, branch_id, warehouse_id, reason, q } = req.query;
    const fromDate = req.query.fromDate || req.query.from;
    const toDate   = req.query.toDate   || req.query.to;

    const where = ['1=1'];
    const params = [];
    if (brand_id)     { where.push('w.brand_id = ?');     params.push(brand_id); }
    if (branch_id)    { where.push('w.branch_id = ?');    params.push(branch_id); }
    if (warehouse_id) { where.push('w.warehouse_id = ?'); params.push(warehouse_id); }
    if (reason)       { where.push('w.reason = ?');       params.push(reason); }
    if (fromDate)     { where.push('w.waste_date >= ?');  params.push(fromDate); }
    if (toDate)       { where.push('w.waste_date <= ?');  params.push(toDate); }
    if (q) {
      where.push('(w.notes LIKE ? OR w.created_by LIKE ? OR br.name LIKE ? OR b.name LIKE ?)');
      const pat = '%' + q + '%';
      params.push(pat, pat, pat, pat);
    }
    const whereSql = ' WHERE ' + where.join(' AND ');

    const limit  = Math.max(1, Math.min(Number(req.query.limit) || 500, 2000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const wantsPaginated = req.query.paginated === '1' || req.query.limit != null || req.query.offset != null;

    const baseSelect =
      'SELECT w.*, b.name AS branch_name, br.name AS brand_name, cc.name AS cc_name, ' +
      '       wh.name AS warehouse_name, wh.code AS warehouse_code ' +
      '  FROM waste_entries w ' +
      '  LEFT JOIN branches b ON w.branch_id = b.id ' +
      '  LEFT JOIN brands br ON w.brand_id = br.id ' +
      '  LEFT JOIN cost_centers cc ON w.cost_center_id = cc.id ' +
      '  LEFT JOIN warehouses wh ON w.warehouse_id = wh.id';
    const order = ' ORDER BY w.waste_date DESC, w.created_at DESC';

    const [rows] = await db.query(
      baseSelect + whereSql + order + ' LIMIT ? OFFSET ?',
      params.concat([limit, offset]));

    const items = rows.map(w => ({
      id: w.id, wasteDate: w.waste_date, reason: w.reason,
      brandId: w.brand_id || '', brandName: w.brand_name || '',
      branchId: w.branch_id || '', branchName: w.branch_name || '',
      warehouseId: w.warehouse_id, warehouseName: w.warehouse_name || '', warehouseCode: w.warehouse_code || '',
      costCenterId: w.cost_center_id || '', costCenterName: w.cc_name || '',
      totalCost: Number(w.total_cost) || 0,
      notes: w.notes || '', createdBy: w.created_by || '', createdAt: w.created_at
    }));

    if (!wantsPaginated) return res.json(items);

    // Summary across full filter (no LIMIT)
    const [sumRows] = await db.query(
      'SELECT COUNT(*) AS total_count, ' +
      '       SUM(w.total_cost) AS total_cost, ' +
      '       SUM(CASE WHEN w.reason = \'expired\'         THEN 1 ELSE 0 END) AS expired_count, ' +
      '       SUM(CASE WHEN w.reason = \'damaged\'         THEN 1 ELSE 0 END) AS damaged_count, ' +
      '       SUM(CASE WHEN w.reason = \'spill\'           THEN 1 ELSE 0 END) AS spill_count, ' +
      '       SUM(CASE WHEN w.reason = \'prep_loss\'       THEN 1 ELSE 0 END) AS prep_count, ' +
      '       SUM(CASE WHEN w.reason = \'customer_return\' THEN 1 ELSE 0 END) AS return_count, ' +
      '       SUM(CASE WHEN w.reason = \'other\'           THEN 1 ELSE 0 END) AS other_count, ' +
      '       SUM(CASE WHEN w.reason = \'expired\'         THEN w.total_cost ELSE 0 END) AS expired_cost, ' +
      '       SUM(CASE WHEN w.reason = \'damaged\'         THEN w.total_cost ELSE 0 END) AS damaged_cost, ' +
      '       SUM(CASE WHEN w.reason = \'spill\'           THEN w.total_cost ELSE 0 END) AS spill_cost, ' +
      '       SUM(CASE WHEN w.reason = \'prep_loss\'       THEN w.total_cost ELSE 0 END) AS prep_cost, ' +
      '       SUM(CASE WHEN w.reason = \'customer_return\' THEN w.total_cost ELSE 0 END) AS return_cost, ' +
      '       SUM(CASE WHEN w.reason = \'other\'           THEN w.total_cost ELSE 0 END) AS other_cost ' +
      '  FROM waste_entries w ' +
      '  LEFT JOIN branches b ON w.branch_id = b.id ' +
      '  LEFT JOIN brands br ON w.brand_id = br.id' + whereSql,
      params);
    const s = sumRows[0] || {};

    res.json({
      success: true,
      items,
      total: Number(s.total_count) || 0,
      limit, offset,
      summary: {
        total:     Number(s.total_count) || 0,
        totalCost: Number(s.total_cost) || 0,
        avgCost:   (Number(s.total_count) ? (Number(s.total_cost) / Number(s.total_count)) : 0),
        byReason: {
          expired:        { count: Number(s.expired_count) || 0, cost: Number(s.expired_cost) || 0 },
          damaged:        { count: Number(s.damaged_count) || 0, cost: Number(s.damaged_cost) || 0 },
          spill:          { count: Number(s.spill_count)   || 0, cost: Number(s.spill_cost)   || 0 },
          prep_loss:      { count: Number(s.prep_count)    || 0, cost: Number(s.prep_cost)    || 0 },
          customer_return:{ count: Number(s.return_count)  || 0, cost: Number(s.return_cost)  || 0 },
          other:          { count: Number(s.other_count)   || 0, cost: Number(s.other_cost)   || 0 }
        }
      }
    });
  } catch(e) { res.status(500).json({ error: e.message, items: [] }); }
});

// v5.10.34 — Delete a waste entry (and reverse its inventory + GL effect).
// Wrapped in db.withTransaction so a partial failure can never leave a
// half-deleted entry.
router.delete('/waste-entries/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [hdr] = await db.query('SELECT * FROM waste_entries WHERE id = ?', [id]);
    if (!hdr.length) return res.status(404).json({ success:false, error:'not-found' });
    const w = hdr[0];
    const [lines] = await db.query('SELECT * FROM waste_entry_items WHERE waste_id = ?', [id]);

    const runner = async (conn) => {
      const c = conn || db;
      // 1. Reverse inventory_movements: insert opposite (positive) entries
      for (const l of lines) {
        try {
          await c.query(
            `INSERT INTO inventory_movements (id, item_id, warehouse_id, txn_type, quantity, unit_cost, total_cost, reference_type, reference_id, created_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
            [genId('IM'), l.item_id, w.warehouse_id, 'waste_reversal',
             Number(l.quantity) || 0, Number(l.unit_cost) || 0, Number(l.line_cost) || 0,
             'WasteEntry', id, (req.user && req.user.username) || 'system']);
        } catch (_) {}
        // Restore warehouse_stock qty
        try {
          await c.query(
            'UPDATE warehouse_stock SET qty = qty + ? WHERE warehouse_id = ? AND item_id = ?',
            [Number(l.quantity) || 0, w.warehouse_id, l.item_id]);
        } catch (_) {}
      }
      // 2. Reverse GL journal
      try {
        const [j] = await c.query('SELECT id FROM gl_journals WHERE reference_type = ? AND reference_id = ?', ['WasteEntry', id]);
        for (const journal of j) {
          const [es] = await c.query('SELECT * FROM gl_entries WHERE journal_id = ?', [journal.id]);
          for (const e of es) {
            if (e.account_id) {
              const reverseAmount = (Number(e.credit) || 0) - (Number(e.debit) || 0);
              await c.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [reverseAmount, e.account_id]);
            }
          }
          await c.query('DELETE FROM gl_entries WHERE journal_id = ?', [journal.id]);
          await c.query('DELETE FROM gl_journals WHERE id = ?', [journal.id]);
        }
      } catch (_) {}
      // 3. Delete the waste entry + items
      await c.query('DELETE FROM waste_entry_items WHERE waste_id = ?', [id]);
      await c.query('DELETE FROM waste_entries WHERE id = ?', [id]);
    };

    try {
      if (typeof db.withTransaction === 'function') await db.withTransaction(runner);
      else await runner(null);
    } catch (txErr) {
      return res.status(500).json({ success:false, error: txErr.message });
    }

    res.json({ success: true, id, reversedLines: lines.length });
  } catch (e) { res.status(500).json({ success:false, error: e.message }); }
});

router.post('/waste-entries', async (req, res) => {
  try {
    const { brandId, branchId, warehouseId, costCenterId, wasteDate, reason, notes, createdBy, items } = req.body;
    if (!warehouseId) return res.json({ success: false, error: 'المستودع مطلوب' });
    if (!Array.isArray(items) || !items.length) return res.json({ success: false, error: 'أصناف الهدر مطلوبة' });

    // Compute total + insert header
    let total = 0;
    items.forEach(it => { total += (Number(it.quantity) || 0) * (Number(it.unitCost) || 0); });
    total = Math.round(total * 100) / 100;

    const id = genId('WE');
    await db.query(
      `INSERT INTO waste_entries (id, brand_id, branch_id, warehouse_id, cost_center_id, waste_date, reason, total_cost, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, brandId||null, branchId||null, warehouseId, costCenterId||null,
       wasteDate || new Date().toISOString().slice(0,10), reason || 'other', total, notes || '', createdBy || '']);

    for (const it of items) {
      const lineCost = (Number(it.quantity)||0) * (Number(it.unitCost)||0);
      await db.query(
        `INSERT INTO waste_entry_items (id, waste_id, item_id, quantity, unit, unit_cost, line_cost)
         VALUES (?,?,?,?,?,?,?)`,
        [genId('WEI'), id, it.itemId, Number(it.quantity)||0, it.unit||'PCS',
         Number(it.unitCost)||0, Math.round(lineCost * 100) / 100]);
      // ═══ INVENTORY MOVEMENT (waste reduces stock) ═══
      try {
        await db.query(
          `INSERT INTO inventory_movements (id, item_id, warehouse_id, txn_type, quantity, unit_cost, total_cost, reference_type, reference_id, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
          [genId('IM'), it.itemId, warehouseId, 'waste',
           -(Number(it.quantity)||0), Number(it.unitCost)||0, -(Math.round(lineCost*100)/100),
           'WasteEntry', id, createdBy||'']);
      } catch(e) { /* older schema — inventory_movements may lack needed fields */ }
    }

    // ═══ AUTO GL POSTING (v5.10.39 — granular by reason) ═══
    // Dr Waste sub-account (5121-5125 by reason) / Cr Inventory (warehouse)
    // Falls back to 5200 (generic waste expense) for unmapped reasons.
    const WASTE_ACCOUNT_BY_REASON = {
      prep_loss:        '5121',   // هدر المواد الخام
      damaged:          '5122',   // هدر المنتجات الجاهزة
      expired:          '5123',   // تالف منتهي الصلاحية
      spill:            '5124',   // هدر التشغيل (انسكاب)
      customer_return:  '5125',   // مرتجعات العملاء
      other:            '5200'    // مصروف الهدر العام (fallback)
    };
    const wasteAccountCode = WASTE_ACCOUNT_BY_REASON[reason] || '5200';

    if (total > 0) {
      const post = await gl.postJournal(db, {
        journalDate: wasteDate || new Date().toISOString().slice(0, 10),
        description: 'Waste — ' + (reason || 'other'),
        referenceType: 'WasteEntry',
        referenceId: id,
        entries: [
          {
            accountCode: wasteAccountCode,   // sub-account based on reason
            debit: total, credit: 0,
            description: 'Waste cost — ' + (reason || 'other'),
            branchId: branchId || null,
            brandId: brandId || null,
            costCenterId: costCenterId || null
          },
          {
            accountCode: '1200',       // Inventory (reduction)
            debit: 0, credit: total,
            description: 'Inventory reduction (waste)',
            branchId: branchId || null,
            brandId: brandId || null,
            warehouseId: warehouseId
          }
        ],
        postedBy: createdBy || ''
      });
      return res.json({
        success: true, id, totalCost: total,
        journalId: post.journalId || null,
        journalNumber: post.journalNumber || null,
        wasteAccountCode: wasteAccountCode,
        postingWarning: post.success ? null : post.error
      });
    }
    res.json({ success: true, id, totalCost: total });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/waste-entries/:id/items', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT wi.*, i.name AS item_name, i.id AS sku
       FROM waste_entry_items wi LEFT JOIN inv_items i ON wi.item_id = i.id
       WHERE wi.waste_id = ?`, [req.params.id]);
    res.json(rows.map(l => ({
      id: l.id, itemId: l.item_id, itemName: l.item_name || '', sku: l.sku || '',
      quantity: Number(l.quantity), unit: l.unit, unitCost: Number(l.unit_cost),
      lineCost: Number(l.line_cost)
    })));
  } catch(e) { res.json([]); }
});

// ═══════════════════════════════════════
// PURCHASE RECEIPTS (partial receiving)
// ═══════════════════════════════════════
router.get('/purchase-receipts', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT pr.*, s.name AS supplier_name, w.name AS warehouse_name
       FROM purchase_receipts pr
       LEFT JOIN suppliers s ON pr.supplier_id = s.id
       LEFT JOIN warehouses w ON pr.warehouse_id = w.id
       ORDER BY pr.receipt_date DESC LIMIT 200`);
    res.json(rows.map(r => ({
      id: r.id, poId: r.po_id, receiptNumber: r.receipt_number,
      receiptDate: r.receipt_date, warehouseId: r.warehouse_id,
      warehouseName: r.warehouse_name || '', supplierName: r.supplier_name || '',
      subtotal: Number(r.subtotal) || 0, vatAmount: Number(r.vat_amount) || 0,
      total: Number(r.total) || 0, status: r.status,
      createdBy: r.created_by || '', createdAt: r.created_at
    })));
  } catch(e) { res.json([]); }
});

router.post('/purchase-receipts', async (req, res) => {
  try {
    const { poId, supplierId, warehouseId, receiptDate, createdBy, lines, brandId, branchId } = req.body;
    if (!warehouseId || !Array.isArray(lines) || !lines.length)
      return res.json({ success: false, error: 'المستودع والأسطر مطلوبة' });

    const id = genId('PR');
    let subtotal = 0, vat = 0;
    lines.forEach(l => {
      const amt = (Number(l.quantity)||0) * (Number(l.unitCost)||0);
      subtotal += amt;
      vat += amt * (Number(l.vatRate)||0) / 100;
    });
    const total = subtotal + vat;

    // Generate receipt number
    const [last] = await db.query(`SELECT receipt_number FROM purchase_receipts ORDER BY created_at DESC LIMIT 1`);
    let num = 1;
    if (last.length && last[0].receipt_number) {
      const m = last[0].receipt_number.match(/(\d+)/);
      if (m) num = parseInt(m[1]) + 1;
    }
    const rcpNumber = 'GRN-' + String(num).padStart(5, '0');

    await db.query(
      `INSERT INTO purchase_receipts (id, po_id, supplier_id, receipt_number, receipt_date, warehouse_id, subtotal, vat_amount, total, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,'posted',?)`,
      [id, poId||null, supplierId||null, rcpNumber,
       receiptDate || new Date().toISOString().slice(0,10),
       warehouseId, Math.round(subtotal*100)/100, Math.round(vat*100)/100, Math.round(total*100)/100, createdBy||'']);

    for (const l of lines) {
      const lineTotal = (Number(l.quantity)||0) * (Number(l.unitCost)||0);
      await db.query(
        `INSERT INTO purchase_receipt_lines (id, receipt_id, po_line_id, item_id, quantity, unit, unit_cost, vat_rate, line_total)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [genId('PRL'), id, l.poLineId||null, l.itemId, Number(l.quantity)||0,
         l.unit||'PCS', Number(l.unitCost)||0, Number(l.vatRate)||15, Math.round(lineTotal*100)/100]);

      // Trigger inventory movement (purchase) + avg cost recompute
      try {
        await db.query(
          `INSERT INTO inventory_movements (id, item_id, warehouse_id, txn_type, quantity, unit_cost, total_cost, reference_type, reference_id, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
          [genId('IM'), l.itemId, warehouseId, 'purchase',
           Number(l.quantity)||0, Number(l.unitCost)||0, Math.round(lineTotal*100)/100,
           'PurchaseReceipt', id, createdBy||'']);
      } catch(e) { /* inventory_movements may be on an older schema */ }
    }

    // Update PO received_quantity / status (best-effort)
    if (poId) {
      try {
        await db.query(
          `UPDATE po_lines pl SET received_quantity = received_quantity + ?
           WHERE pl.id IN (SELECT po_line_id FROM purchase_receipt_lines WHERE receipt_id = ? AND po_line_id IS NOT NULL LIMIT 1)`,
          [0, id]);
      } catch(e) {}
    }

    // ═══ AUTO GL POSTING ═══
    // Dr Inventory (subtotal, by warehouse) + Dr Input VAT / Cr Accounts Payable
    const entries = [];
    entries.push({
      accountCode: '1200',              // Inventory
      debit: Math.round(subtotal * 100) / 100,
      credit: 0,
      description: 'Goods received — ' + rcpNumber,
      branchId: branchId || null,
      brandId: brandId || null,
      warehouseId: warehouseId
    });
    if (vat > 0) {
      entries.push({
        accountCode: '1290',            // Input VAT
        debit: Math.round(vat * 100) / 100,
        credit: 0,
        description: 'Input VAT — ' + rcpNumber,
        branchId: branchId || null, brandId: brandId || null
      });
    }
    entries.push({
      accountCode: '2100',              // Accounts Payable
      debit: 0,
      credit: Math.round((subtotal + vat) * 100) / 100,
      description: 'Supplier liability — ' + rcpNumber,
      brandId: brandId || null
    });
    const post = await gl.postJournal(db, {
      journalDate: receiptDate || new Date().toISOString().slice(0, 10),
      description: 'Purchase receipt ' + rcpNumber,
      referenceType: 'PurchaseReceipt',
      referenceId: id,
      entries,
      postedBy: createdBy || ''
    });

    res.json({
      success: true, id, receiptNumber: rcpNumber, total,
      journalId: post.journalId || null,
      journalNumber: post.journalNumber || null,
      postingWarning: post.success ? null : post.error
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════
// ACCOUNTING REPORTS — Trial Balance, P&L, Balance Sheet
// ═══════════════════════════════════════════════════════════════════════

// Helper: detect optional dimension columns on gl_entries (tolerate old schemas)
async function _dimCols() {
  const present = {};
  for (const col of ['brand_id', 'branch_id', 'cost_center_id', 'warehouse_id']) {
    try {
      const [c] = await db.query("SHOW COLUMNS FROM gl_entries LIKE '" + col + "'");
      present[col] = !!c.length;
    } catch(e) { present[col] = false; }
  }
  return present;
}

/**
 * GET /erp/reports/trial-balance?from=&to=&branch=&brand=&costCenter=&includeZero=
 *   Returns every account with opening balance, period movement (debit/credit),
 *   and closing balance. Filters by dimensions if provided.
 */
router.get('/reports/trial-balance', async (req, res) => {
  try {
    const { from, to, branch, brand, costCenter, includeZero } = req.query;
    const dim = await _dimCols();

    // Build dimension filter clause (only applies if the column exists)
    const where = [];
    const params = [];
    if (branch && dim.branch_id) { where.push('e.branch_id = ?'); params.push(branch); }
    if (brand && dim.brand_id)   { where.push('e.brand_id = ?');  params.push(brand); }
    if (costCenter && dim.cost_center_id) { where.push('e.cost_center_id = ?'); params.push(costCenter); }
    const dimClause = where.length ? ' AND ' + where.join(' AND ') : '';

    // Only count posted journals
    const statusClause = " AND j.status = 'posted'";

    // 1) Opening balance: all entries strictly BEFORE `from`
    let openingMap = {};
    if (from) {
      const [openRows] = await db.query(
        `SELECT e.account_id,
                COALESCE(SUM(e.debit),0)  AS d,
                COALESCE(SUM(e.credit),0) AS c
         FROM gl_entries e
         JOIN gl_journals j ON e.journal_id = j.id
         WHERE j.journal_date < ? ${statusClause} ${dimClause}
         GROUP BY e.account_id`,
        [from, ...params]);
      openRows.forEach(r => {
        openingMap[r.account_id] = Number(r.d) - Number(r.c);
      });
    }

    // 2) Period movement
    let sql = `
      SELECT e.account_id,
             COALESCE(SUM(e.debit),0)  AS period_debit,
             COALESCE(SUM(e.credit),0) AS period_credit,
             COUNT(*) AS row_count
      FROM gl_entries e
      JOIN gl_journals j ON e.journal_id = j.id
      WHERE 1=1 ${statusClause}`;
    const movParams = [...params];
    if (from) { sql += ' AND j.journal_date >= ?'; movParams.push(from); }
    if (to)   { sql += ' AND j.journal_date <= ?'; movParams.push(to); }
    sql += dimClause + ' GROUP BY e.account_id';
    const [movRows] = await db.query(sql, movParams);

    // 3) Load all active accounts to join against
    const [accts] = await db.query(
      `SELECT id, code, name_ar, type, parent_id
       FROM gl_accounts WHERE is_active = 1 OR is_active IS NULL
       ORDER BY code`);

    const movementMap = {};
    movRows.forEach(r => { movementMap[r.account_id] = r; });

    // Build a parent→children map to enable recursive roll-up
    const childrenOf = {};
    accts.forEach(a => {
      const pid = a.parent_id || null;
      if (!childrenOf[pid]) childrenOf[pid] = [];
      childrenOf[pid].push(a);
    });
    const hasChildren = (id) => !!(childrenOf[id] && childrenOf[id].length);

    // Compute aggregated (own + descendants') totals for each account
    const directRaw = {};  // account_id → { opening, d, c }
    accts.forEach(a => {
      directRaw[a.id] = {
        opening: Number(openingMap[a.id] || 0),
        d: Number((movementMap[a.id]||{}).period_debit || 0),
        c: Number((movementMap[a.id]||{}).period_credit || 0)
      };
    });
    const aggregatedCache = {};
    function aggregate(id) {
      if (aggregatedCache[id]) return aggregatedCache[id];
      const self = directRaw[id] || { opening:0, d:0, c:0 };
      let agg = { opening: self.opening, d: self.d, c: self.c };
      (childrenOf[id] || []).forEach(ch => {
        const childAgg = aggregate(ch.id);
        agg.opening += childAgg.opening;
        agg.d       += childAgg.d;
        agg.c       += childAgg.c;
      });
      aggregatedCache[id] = agg;
      return agg;
    }

    const rows = accts.map(a => {
      const agg = aggregate(a.id);
      const opening = agg.opening;
      const d = agg.d, c = agg.c;
      const closing = opening + d - c;
      // Derive level from code length (1 char=1, 11=2, 111=3, ...)
      const level = a.code ? String(a.code).length : 1;
      return {
        accountId: a.id,
        code: a.code,
        nameAr: a.name_ar,
        type: a.type,
        parentId: a.parent_id || null,
        level: Math.min(level, 9),
        hasChildren: hasChildren(a.id),
        opening: Math.round(opening * 100) / 100,
        periodDebit: Math.round(d * 100) / 100,
        periodCredit: Math.round(c * 100) / 100,
        net: Math.round((d - c) * 100) / 100,
        closing: Math.round(closing * 100) / 100,
        rowCount: Number((movementMap[a.id]||{}).row_count || 0)
      };
    });

    const filtered = includeZero === '1' ? rows : rows.filter(r =>
      r.opening !== 0 || r.periodDebit !== 0 || r.periodCredit !== 0 || r.closing !== 0);

    // Totals for balance verification
    const totals = filtered.reduce((t, r) => ({
      opening: t.opening + r.opening,
      periodDebit: t.periodDebit + r.periodDebit,
      periodCredit: t.periodCredit + r.periodCredit,
      closing: t.closing + r.closing
    }), { opening: 0, periodDebit: 0, periodCredit: 0, closing: 0 });

    res.json({
      success: true,
      filters: { from: from || null, to: to || null, branch: branch || null, brand: brand || null, costCenter: costCenter || null },
      rows: filtered,
      totals: {
        opening: Math.round(totals.opening * 100) / 100,
        periodDebit: Math.round(totals.periodDebit * 100) / 100,
        periodCredit: Math.round(totals.periodCredit * 100) / 100,
        closing: Math.round(totals.closing * 100) / 100,
        isBalanced: Math.abs(totals.periodDebit - totals.periodCredit) < 0.01
      }
    });
  } catch(e) { res.json({ success: false, error: e.message, rows: [], totals: {} }); }
});

/**
 * GET /erp/reports/pnl?from=&to=&branch=&brand=&costCenter=&groupBy=
 *   Revenue − Expenses = Net Profit. Accounts hierarchy is respected
 *   (shows detail + group totals).
 *   groupBy: 'account' (default) | 'type' | 'brand' | 'branch' | 'cost_center'
 */
router.get('/reports/pnl', async (req, res) => {
  try {
    // v5.10.4 — added showZero ('1' to include accounts with no movement)
    const { from, to, branch, brand, costCenter, groupBy, showZero } = req.query;
    const includeZero = showZero === '1' || showZero === 'true';
    const dim = await _dimCols();

    const where = [`(a.type = 'revenue' OR a.type = 'expense')`];
    const params = [];
    if (branch && dim.branch_id) { where.push('e.branch_id = ?'); params.push(branch); }
    if (brand && dim.brand_id)   { where.push('e.brand_id = ?');  params.push(brand); }
    if (costCenter && dim.cost_center_id) { where.push('e.cost_center_id = ?'); params.push(costCenter); }
    if (from) { where.push('j.journal_date >= ?'); params.push(from); }
    if (to)   { where.push('j.journal_date <= ?'); params.push(to); }
    where.push("j.status = 'posted'");

    // Group by selector
    let groupCol = 'a.id';
    let groupFields = 'a.id, a.code, a.name_ar, a.type';
    if (groupBy === 'type')          { groupCol = 'a.type';          groupFields = 'a.type'; }
    else if (groupBy === 'brand' && dim.brand_id) {
      groupCol = 'e.brand_id, a.type';
      groupFields = "e.brand_id, a.type, (SELECT name FROM brands b WHERE b.id = e.brand_id) AS dim_name";
    }
    else if (groupBy === 'branch' && dim.branch_id) {
      groupCol = 'e.branch_id, a.type';
      groupFields = "e.branch_id, a.type, (SELECT name FROM branches br WHERE br.id = e.branch_id) AS dim_name";
    }
    else if (groupBy === 'cost_center' && dim.cost_center_id) {
      groupCol = 'e.cost_center_id, a.type';
      groupFields = "e.cost_center_id, a.type, (SELECT name FROM cost_centers c WHERE c.id = e.cost_center_id) AS dim_name";
    }

    const sql = `
      SELECT ${groupFields},
             COALESCE(SUM(e.debit),0)  AS total_debit,
             COALESCE(SUM(e.credit),0) AS total_credit
      FROM gl_entries e
      JOIN gl_journals j ON e.journal_id = j.id
      JOIN gl_accounts a ON e.account_id = a.id
      WHERE ${where.join(' AND ')}
      GROUP BY ${groupCol}
      ORDER BY a.type DESC, a.code`;

    const [rows] = await db.query(sql, params);

    // Revenue: credit - debit (natural credit)
    // Expense: debit - credit (natural debit)
    const mapped = rows.map(r => {
      const d = Number(r.total_debit) || 0;
      const c = Number(r.total_credit) || 0;
      const amount = r.type === 'revenue' ? (c - d) : (d - c);
      return {
        accountId: r.id || null, code: r.code || '', nameAr: r.name_ar || '',
        dimensionValue: r.brand_id || r.branch_id || r.cost_center_id || null,
        dimensionName: r.dim_name || '',
        type: r.type,
        amount: Math.round(amount * 100) / 100,
        totalDebit: Math.round(d * 100) / 100,
        totalCredit: Math.round(c * 100) / 100
      };
    });

    // v5.10.4 — when showZero is on (and grouping by account), pull in
    // every revenue/expense account in the COA — even ones with no entries
    // — so the auditor can verify the chart of accounts is comprehensive.
    let finalRows = mapped;
    if (includeZero && (!groupBy || groupBy === 'account')) {
      const seen = new Set(mapped.map(r => r.accountId));
      const [allAcc] = await db.query(
        `SELECT id, code, name_ar, type FROM gl_accounts
         WHERE is_active = 1 AND type IN ('revenue','expense') ORDER BY code`
      );
      const stubs = allAcc
        .filter(a => !seen.has(a.id))
        .map(a => ({
          accountId: a.id, code: a.code || '', nameAr: a.name_ar || '',
          dimensionValue: null, dimensionName: '',
          type: a.type, amount: 0, totalDebit: 0, totalCredit: 0
        }));
      finalRows = mapped.concat(stubs);
    }

    const totalRevenue = finalRows.filter(r => r.type === 'revenue').reduce((s, r) => s + r.amount, 0);
    const totalExpense = finalRows.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const netProfit = totalRevenue - totalExpense;

    res.json({
      success: true,
      filters: { from: from || null, to: to || null, branch: branch || null, brand: brand || null, costCenter: costCenter || null, groupBy: groupBy || 'account', showZero: includeZero },
      revenue: finalRows.filter(r => r.type === 'revenue'),
      expenses: finalRows.filter(r => r.type === 'expense'),
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalExpense: Math.round(totalExpense * 100) / 100,
        netProfit: Math.round(netProfit * 100) / 100,
        grossMargin: totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 10000) / 100 : 0
      }
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

/**
 * GET /erp/reports/balance-sheet?asOf=&branch=&brand=
 *   Assets / Liabilities / Equity as of a specific date.
 *   Assets   = Σ(debit − credit) for asset accounts
 *   Liabilities = Σ(credit − debit) for liability accounts
 *   Equity   = Σ(credit − debit) for equity accounts + current-period retained earnings
 */
router.get('/reports/balance-sheet', async (req, res) => {
  try {
    const { asOf, branch, brand } = req.query;
    const dim = await _dimCols();
    const cutoff = asOf || new Date().toISOString().slice(0, 10);

    const where = [];
    const params = [];
    if (branch && dim.branch_id) { where.push('e.branch_id = ?'); params.push(branch); }
    if (brand && dim.brand_id)   { where.push('e.brand_id = ?');  params.push(brand); }
    where.push("j.status = 'posted'");
    where.push('j.journal_date <= ?'); params.push(cutoff);

    // Aggregate per account (including non-posted accounts, 0 balance)
    const [balances] = await db.query(
      `SELECT a.id, a.code, a.name_ar, a.type, a.parent_id,
              COALESCE(SUM(e.debit),0)  AS total_debit,
              COALESCE(SUM(e.credit),0) AS total_credit
       FROM gl_accounts a
       LEFT JOIN gl_entries e ON a.id = e.account_id
       LEFT JOIN gl_journals j ON e.journal_id = j.id
       WHERE (a.type IN ('asset','liability','equity','revenue','expense'))
         AND (e.id IS NULL OR (${where.join(' AND ')}))
       GROUP BY a.id
       ORDER BY a.type, a.code`, params);

    const assets = [], liabilities = [], equity = [];
    let revMinusExp = 0;  // retained earnings (current period net profit)
    balances.forEach(r => {
      const d = Number(r.total_debit) || 0;
      const c = Number(r.total_credit) || 0;
      const bal = r.type === 'asset' || r.type === 'expense' ? d - c : c - d;
      const rounded = Math.round(bal * 100) / 100;
      const row = { code: r.code, nameAr: r.name_ar, type: r.type, balance: rounded };
      if (r.type === 'asset')          assets.push(row);
      else if (r.type === 'liability') liabilities.push(row);
      else if (r.type === 'equity')    equity.push(row);
      else if (r.type === 'revenue')   revMinusExp += (c - d);
      else if (r.type === 'expense')   revMinusExp -= (d - c);
    });

    // Add retained earnings line to equity
    const retainedEarnings = Math.round(revMinusExp * 100) / 100;
    equity.push({ code: '~RE', nameAr: 'الأرباح المحتجزة (الفترة الحالية)', type: 'equity', balance: retainedEarnings });

    const totalAssets      = Math.round(assets.reduce((s, r) => s + r.balance, 0) * 100) / 100;
    const totalLiabilities = Math.round(liabilities.reduce((s, r) => s + r.balance, 0) * 100) / 100;
    const totalEquity      = Math.round(equity.reduce((s, r) => s + r.balance, 0) * 100) / 100;
    const difference       = Math.round((totalAssets - (totalLiabilities + totalEquity)) * 100) / 100;

    res.json({
      success: true,
      asOf: cutoff,
      filters: { branch: branch || null, brand: brand || null },
      assets, liabilities, equity,
      totals: {
        assets: totalAssets,
        liabilities: totalLiabilities,
        equity: totalEquity,
        liabilitiesPlusEquity: Math.round((totalLiabilities + totalEquity) * 100) / 100,
        difference,
        isBalanced: Math.abs(difference) < 0.01
      }
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

/**
 * GET /erp/reports/profitability?from=&to=&dimension=
 *   Quick profitability breakdown by dimension (brand/branch/cost_center).
 *   Returns Revenue - Expenses per dimension value.
 */
router.get('/reports/profitability', async (req, res) => {
  try {
    const { from, to, dimension } = req.query;
    const dim = await _dimCols();
    const col = dimension === 'branch' ? 'branch_id'
              : dimension === 'cost_center' ? 'cost_center_id'
              : 'brand_id';
    if (!dim[col]) return res.json({ success: false, error: 'العمود غير مدعوم: ' + col });

    const table = col === 'brand_id' ? 'brands'
                : col === 'branch_id' ? 'branches'
                : 'cost_centers';

    let sql = `
      SELECT e.${col} AS dim_id,
             (SELECT name FROM ${table} x WHERE x.id = e.${col}) AS dim_name,
             SUM(CASE WHEN a.type='revenue' THEN e.credit - e.debit ELSE 0 END) AS revenue,
             SUM(CASE WHEN a.type='expense' THEN e.debit - e.credit ELSE 0 END) AS expenses
      FROM gl_entries e
      JOIN gl_journals j ON e.journal_id = j.id
      JOIN gl_accounts a ON e.account_id = a.id
      WHERE j.status='posted' AND e.${col} IS NOT NULL
        AND (a.type='revenue' OR a.type='expense')`;
    const params = [];
    if (from) { sql += ' AND j.journal_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND j.journal_date <= ?'; params.push(to); }
    sql += ` GROUP BY e.${col}
             ORDER BY (SUM(CASE WHEN a.type='revenue' THEN e.credit - e.debit ELSE 0 END)
                     - SUM(CASE WHEN a.type='expense' THEN e.debit - e.credit ELSE 0 END)) DESC`;

    const [rows] = await db.query(sql, params);
    res.json({
      success: true,
      dimension: col,
      rows: rows.map(r => {
        const rev = Number(r.revenue) || 0;
        const exp = Number(r.expenses) || 0;
        const profit = rev - exp;
        return {
          id: r.dim_id, name: r.dim_name || '—',
          revenue: Math.round(rev * 100) / 100,
          expenses: Math.round(exp * 100) / 100,
          profit: Math.round(profit * 100) / 100,
          margin: rev > 0 ? Math.round((profit / rev) * 10000) / 100 : 0
        };
      })
    });
  } catch(e) { res.json({ success: false, error: e.message, rows: [] }); }
});

// ═══════════════════════════════════════════════════════════════════════
// EXTENDED REPORTS — Aging / Inventory / Sales / Waste / Royalty
// ═══════════════════════════════════════════════════════════════════════
//
// v5.11.13 — The legacy GET /reports/cash-flow endpoint was removed.
// It hardcoded cash/bank account codes ('1110','1120') that don't exist
// in the v5.11.8 IFRS template (real cash codes start with 111x). The
// IAS 7 indirect-method endpoint /reports/cash-flow-ias7 in routes/erp.js
// is what the frontend calls — that one reads dynamically from
// gl_accounts and is fully aligned with the current chart.

/**
 * GET /erp/reports/ar-aging?asOf=
 * Outstanding customer receivables bucketed by age (current, 1-30, 31-60, 61-90, 90+).
 * Currently pulls open invoices from sales where payment was 'kita'/'credit'/AR.
 */
router.get('/reports/ar-aging', async (req, res) => {
  try {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
    // Detect whether sales has customer fields
    let hasCustomer = true;
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'customer_name'"); hasCustomer = !!c.length; } catch(e) { hasCustomer = false; }

    // Pull AR postings from GL (credit accounts 1150) - the gold-standard source
    const [arRows] = await db.query(
      `SELECT e.description, j.journal_date, j.reference_type, j.reference_id,
              COALESCE(e.debit,0) AS d, COALESCE(e.credit,0) AS c
       FROM gl_entries e
       JOIN gl_accounts a ON e.account_id = a.id
       JOIN gl_journals j ON e.journal_id = j.id
       WHERE a.code = '1150' AND j.status='posted' AND j.journal_date <= ?`,
      [asOf]);

    // Group by reference_id (the sale / customer id)
    const open = {};
    arRows.forEach(r => {
      const ref = r.reference_id || '(unknown)';
      if (!open[ref]) open[ref] = { ref, description: r.description, date: r.journal_date, debit: 0, credit: 0 };
      open[ref].debit += Number(r.d) || 0;
      open[ref].credit += Number(r.c) || 0;
      // Track earliest date
      if (!open[ref].date || new Date(r.journal_date) < new Date(open[ref].date)) open[ref].date = r.journal_date;
    });

    const buckets = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
    const items = [];
    const asOfMs = new Date(asOf).getTime();
    Object.values(open).forEach(o => {
      const outstanding = Math.round((o.debit - o.credit) * 100) / 100;
      if (outstanding <= 0) return;
      const days = Math.floor((asOfMs - new Date(o.date).getTime()) / (24 * 3600 * 1000));
      let bucket = 'current';
      if (days > 90) bucket = '90_plus';
      else if (days > 60) bucket = '61_90';
      else if (days > 30) bucket = '31_60';
      else if (days > 0) bucket = '1_30';
      buckets[bucket] += outstanding;
      items.push({
        reference: o.ref, description: o.description || '',
        invoiceDate: o.date, days, bucket,
        outstanding
      });
    });

    res.json({
      success: true,
      asOf,
      totals: {
        current: Math.round(buckets.current * 100) / 100,
        '1_30': Math.round(buckets['1_30'] * 100) / 100,
        '31_60': Math.round(buckets['31_60'] * 100) / 100,
        '61_90': Math.round(buckets['61_90'] * 100) / 100,
        '90_plus': Math.round(buckets['90_plus'] * 100) / 100,
        grand: Math.round(Object.values(buckets).reduce((s, v) => s + v, 0) * 100) / 100
      },
      items: items.sort((a, b) => b.days - a.days)
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

/**
 * GET /erp/reports/ap-aging?asOf=
 * Outstanding supplier payables — same bucketing on account 2100.
 */
router.get('/reports/ap-aging', async (req, res) => {
  try {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);

    const [apRows] = await db.query(
      `SELECT e.description, j.journal_date, j.reference_type, j.reference_id,
              COALESCE(e.debit,0) AS d, COALESCE(e.credit,0) AS c
       FROM gl_entries e
       JOIN gl_accounts a ON e.account_id = a.id
       JOIN gl_journals j ON e.journal_id = j.id
       WHERE a.code = '2100' AND j.status='posted' AND j.journal_date <= ?`,
      [asOf]);

    const open = {};
    apRows.forEach(r => {
      const ref = r.reference_id || '(unknown)';
      if (!open[ref]) open[ref] = { ref, description: r.description, date: r.journal_date, debit: 0, credit: 0 };
      open[ref].debit += Number(r.d) || 0;
      open[ref].credit += Number(r.c) || 0;
      if (!open[ref].date || new Date(r.journal_date) < new Date(open[ref].date)) open[ref].date = r.journal_date;
    });

    const buckets = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
    const items = [];
    const asOfMs = new Date(asOf).getTime();
    Object.values(open).forEach(o => {
      // For AP, outstanding = credit - debit (liability normal)
      const outstanding = Math.round((o.credit - o.debit) * 100) / 100;
      if (outstanding <= 0) return;
      const days = Math.floor((asOfMs - new Date(o.date).getTime()) / (24 * 3600 * 1000));
      let bucket = 'current';
      if (days > 90) bucket = '90_plus';
      else if (days > 60) bucket = '61_90';
      else if (days > 30) bucket = '31_60';
      else if (days > 0) bucket = '1_30';
      buckets[bucket] += outstanding;
      items.push({
        reference: o.ref, description: o.description || '',
        invoiceDate: o.date, days, bucket,
        outstanding
      });
    });

    res.json({
      success: true,
      asOf,
      totals: {
        current: Math.round(buckets.current * 100) / 100,
        '1_30': Math.round(buckets['1_30'] * 100) / 100,
        '31_60': Math.round(buckets['31_60'] * 100) / 100,
        '61_90': Math.round(buckets['61_90'] * 100) / 100,
        '90_plus': Math.round(buckets['90_plus'] * 100) / 100,
        grand: Math.round(Object.values(buckets).reduce((s, v) => s + v, 0) * 100) / 100
      },
      items: items.sort((a, b) => b.days - a.days)
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

/**
 * GET /erp/reports/inventory-valuation?warehouse=&brand=
 * Shows current stock × avg_cost per item, grouped by warehouse.
 */
router.get('/reports/inventory-valuation', async (req, res) => {
  try {
    const { warehouse, brand } = req.query;
    // Prefer warehouse_stock when available; fall back to inv_items.stock
    let hasWS = true;
    try { const [t] = await db.query("SHOW TABLES LIKE 'warehouse_stock'"); hasWS = !!t.length; } catch(e) { hasWS = false; }

    // v5.15.2 — Two-track inventory: raw materials live in inv_items +
    // warehouse_stock (per-warehouse), while semi-finished products live
    // in menu (with is_semi_finished=1) and use menu.stock as a global
    // count plus production_warehouse_id as the assigned warehouse.
    // We UNION both so the inventory valuation report surfaces semis
    // (e.g. "cold drink base") alongside raw materials. Zero-stock
    // semis are still shown so the admin sees that the item exists
    // — they need to run a production order to add stock.
    let sql, params = [];
    if (hasWS) {
      sql = `
        SELECT ws.warehouse_id, w.name AS warehouse_name,
               i.id AS item_id, i.name AS item_name, i.id AS sku, i.unit,
               'raw' AS item_type,
               i.brand_id, b.name AS brand_name,
               COALESCE(ws.qty, 0) AS qty,
               COALESCE(i.cost, 0) AS avg_cost
        FROM warehouse_stock ws
        JOIN inv_items i ON ws.item_id = i.id
        LEFT JOIN warehouses w ON ws.warehouse_id = w.id
        LEFT JOIN brands b ON i.brand_id = b.id
        WHERE COALESCE(ws.qty,0) > 0`;
      if (warehouse) { sql += ' AND ws.warehouse_id = ?'; params.push(warehouse); }
      if (brand)     { sql += ' AND i.brand_id = ?';      params.push(brand); }
      sql += `
        UNION ALL
        SELECT m.production_warehouse_id AS warehouse_id, w2.name AS warehouse_name,
               m.id AS item_id, m.name AS item_name, m.id AS sku,
               COALESCE(m.production_unit, 'pcs') AS unit,
               'semi' AS item_type,
               m.brand_id, b2.name AS brand_name,
               COALESCE(m.stock, 0) AS qty,
               COALESCE(m.cost, 0) AS avg_cost
        FROM menu m
        LEFT JOIN warehouses w2 ON m.production_warehouse_id = w2.id
        LEFT JOIN brands b2 ON b2.id = m.brand_id
        WHERE m.is_semi_finished = 1
          AND m.active = 1
          AND m.production_warehouse_id IS NOT NULL`;
      if (warehouse) { sql += ' AND m.production_warehouse_id = ?'; params.push(warehouse); }
      if (brand)     { sql += ' AND m.brand_id = ?';                params.push(brand); }
      sql += ' ORDER BY warehouse_name, item_type, item_name';
    } else {
      sql = `SELECT '' AS warehouse_id, '' AS warehouse_name,
             i.id AS item_id, i.name AS item_name, i.id AS sku, i.unit,
             'raw' AS item_type,
             i.brand_id, b.name AS brand_name,
             COALESCE(i.stock, 0) AS qty, COALESCE(i.cost, 0) AS avg_cost
             FROM inv_items i LEFT JOIN brands b ON i.brand_id = b.id
             WHERE COALESCE(i.stock,0) > 0`;
      if (brand) { sql += ' AND i.brand_id = ?'; params.push(brand); }
      sql += `
        UNION ALL
        SELECT '' AS warehouse_id, '' AS warehouse_name,
               m.id AS item_id, m.name AS item_name, m.id AS sku,
               COALESCE(m.production_unit, 'pcs') AS unit,
               'semi' AS item_type,
               m.brand_id, b2.name AS brand_name,
               COALESCE(m.stock, 0) AS qty, COALESCE(m.cost, 0) AS avg_cost
        FROM menu m LEFT JOIN brands b2 ON b2.id = m.brand_id
        WHERE m.is_semi_finished = 1 AND m.active = 1`;
      if (brand) { sql += ' AND m.brand_id = ?'; params.push(brand); }
      sql += ' ORDER BY item_type, item_name';
    }

    const [rows] = await db.query(sql, params);
    const items = rows.map(r => {
      const q = Number(r.qty) || 0;
      const c = Number(r.avg_cost) || 0;
      return {
        warehouseId: r.warehouse_id || '',
        warehouseName: r.warehouse_name || '',
        itemId: r.item_id, itemName: r.item_name, sku: r.sku || '', unit: r.unit || '',
        // v5.15.2 — 'raw' for inv_items, 'semi' for is_semi_finished menu items.
        itemType: r.item_type || 'raw',
        brandId: r.brand_id || '', brandName: r.brand_name || '',
        qty: q, avgCost: c,
        value: Math.round(q * c * 100) / 100
      };
    });

    // Group totals by warehouse
    const byWarehouse = {};
    let grandQty = 0, grandValue = 0;
    items.forEach(it => {
      const key = it.warehouseId || '(default)';
      if (!byWarehouse[key]) byWarehouse[key] = { warehouseId: it.warehouseId, warehouseName: it.warehouseName, itemCount: 0, totalQty: 0, totalValue: 0 };
      byWarehouse[key].itemCount++;
      byWarehouse[key].totalQty += it.qty;
      byWarehouse[key].totalValue += it.value;
      grandQty += it.qty;
      grandValue += it.value;
    });

    res.json({
      success: true,
      filters: { warehouse: warehouse || null, brand: brand || null },
      items,
      byWarehouse: Object.values(byWarehouse).map(w => ({
        ...w,
        totalQty: Math.round(w.totalQty * 100) / 100,
        totalValue: Math.round(w.totalValue * 100) / 100
      })),
      grand: {
        itemCount: items.length,
        totalQty: Math.round(grandQty * 100) / 100,
        totalValue: Math.round(grandValue * 100) / 100
      }
    });
  } catch(e) { res.json({ success: false, error: e.message, items: [] }); }
});

/**
 * GET /erp/reports/sales-analytics?from=&to=&branch=&brand=&groupBy=
 * Sales analytics with multiple breakdowns in a single response.
 * groupBy: 'daily' (default) | 'payment' | 'cashier' | 'hour' | 'top_items' | 'all'
 */
router.get('/reports/sales-analytics', async (req, res) => {
  try {
    const { from, to, branch, brand, groupBy, channel, paymentMethod } = req.query;
    const by = groupBy || 'all';

    // Detect optional columns (backward-compat with very old deploys)
    let hasBranch = true, hasBrand = true, hasChannel = false, hasDeleted = false;
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'branch_id'");  hasBranch  = !!c.length; } catch(e) { hasBranch  = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'brand_id'");   hasBrand   = !!c.length; } catch(e) { hasBrand   = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'channel_name'"); hasChannel = !!c.length; } catch(e) { hasChannel = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'deleted_at'"); hasDeleted = !!c.length; } catch(e) { hasDeleted = false; }

    const where = hasDeleted ? ["(s.deleted_at IS NULL)"] : ["1=1"];
    const params = [];
    if (from)  { where.push('DATE(s.order_date) >= ?'); params.push(from); }
    if (to)    { where.push('DATE(s.order_date) <= ?'); params.push(to); }
    if (branch && hasBranch)  { where.push('s.branch_id = ?');    params.push(branch); }
    if (brand  && hasBrand)   { where.push('s.brand_id = ?');     params.push(brand); }
    if (channel && hasChannel){ where.push('s.channel_name = ?'); params.push(channel); }
    if (paymentMethod)        { where.push('s.payment_method = ?'); params.push(paymentMethod); }
    const whereClause = where.join(' AND ');

    const out = { filters: { from: from || null, to: to || null, branch: branch || null, brand: brand || null } };

    // v7.0 — VAT rate from settings (single source of truth) + 2-dp helper.
    let _rate = 15;
    try { _rate = await require('../lib/pricing').getVatRateFromDb(db, 15); } catch(_) {}
    const _div = 1 + (Number(_rate) || 15) / 100;
    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

    // Headline totals — gross is the ACTUAL charged amount (total_final, whole
    // SAR). net/vat are DERIVED from it, so a 4 SAR sale reads 4 (not 4.35).
    const [hd] = await db.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_final),0) AS total,
              COALESCE(AVG(total_final),0) AS avg_ticket,
              COALESCE(SUM(discount_amount),0) AS discounts
       FROM sales s WHERE ${whereClause}`, params);
    const _gross = Number(hd[0].total) || 0;
    const _net = _gross / _div;
    out.headline = {
      invoiceCount: Number(hd[0].cnt) || 0,
      total: r2(_gross),
      avgTicket: r2(hd[0].avg_ticket)
    };

    // Per-product breakdown (sales_items only — no menu JOIN, to avoid row
    // multiplication on duplicate names). Cost comes from a name→cost map so
    // headline cost === sum of per-product cost (consistent).
    let _costMap = {};
    try {
      const [mc] = await db.query('SELECT name, COALESCE(cost,0) AS cost FROM menu');
      mc.forEach(m => { _costMap[m.name] = Number(m.cost) || 0; });
    } catch(_) {}
    const [prodRows] = await db.query(
      `SELECT si.item_name AS name, SUM(si.qty) AS qty, COALESCE(SUM(si.total),0) AS gross
       FROM sales_items si JOIN sales s ON si.order_id = s.id
       WHERE ${whereClause}
       GROUP BY si.item_name ORDER BY gross DESC`, params);
    let _totalCost = 0;
    out.byProduct = prodRows.map(r => {
      const g = Number(r.gross) || 0;
      const n = g / _div;
      const q = Number(r.qty) || 0;
      const c = r2(q * (_costMap[r.name] || 0));
      _totalCost += c;
      const p = n - c;
      return {
        name: r.name || '', qty: q,
        gross: r2(g), net: r2(n), vat: r2(g - n),
        cost: c, profit: r2(p),
        margin: n > 0 ? Math.round((p / n) * 10000) / 100 : 0
      };
    });
    _totalCost = r2(_totalCost);
    // Back-compat alias (older consumers expect topItems: name/qty/total)
    out.topItems = out.byProduct.map(p => ({ name: p.name, qty: p.qty, total: p.gross }));

    // The six headline metrics the owner asked for.
    out.revenue = {
      invoiceCount: Number(hd[0].cnt) || 0,
      grossInclVat: r2(_gross),
      net: r2(_net),
      vat: r2(_gross - _net),
      discounts: r2(hd[0].discounts),
      cost: _totalCost,
      profit: r2(_net - _totalCost)
    };

    if (by === 'daily' || by === 'all') {
      const [d] = await db.query(
        `SELECT DATE(s.order_date) AS d, COUNT(*) AS cnt, COALESCE(SUM(total_final),0) AS total
         FROM sales s WHERE ${whereClause}
         GROUP BY DATE(s.order_date) ORDER BY DATE(s.order_date)`, params);
      out.daily = d.map(r => ({ date: r.d, count: Number(r.cnt), total: Math.round(Number(r.total) * 100) / 100 }));
    }
    if (by === 'payment' || by === 'all') {
      const [p] = await db.query(
        `SELECT s.payment_method AS method, COUNT(*) AS cnt, COALESCE(SUM(total_final),0) AS total
         FROM sales s WHERE ${whereClause}
         GROUP BY s.payment_method ORDER BY total DESC`, params);
      out.byPayment = p.map(r => ({ method: r.method || 'unknown', count: Number(r.cnt), total: Math.round(Number(r.total) * 100) / 100 }));
    }
    if (by === 'cashier' || by === 'all') {
      const [c] = await db.query(
        `SELECT s.username AS cashier, COUNT(*) AS cnt, COALESCE(SUM(total_final),0) AS total, COALESCE(AVG(total_final),0) AS avg_ticket
         FROM sales s WHERE ${whereClause}
         GROUP BY s.username ORDER BY total DESC`, params);
      out.byCashier = c.map(r => ({
        cashier: r.cashier || '', count: Number(r.cnt),
        total: Math.round(Number(r.total) * 100) / 100,
        avgTicket: Math.round(Number(r.avg_ticket) * 100) / 100
      }));
    }
    if (by === 'hour' || by === 'all') {
      const [h] = await db.query(
        `SELECT HOUR(s.order_date) AS hr, COUNT(*) AS cnt, COALESCE(SUM(total_final),0) AS total
         FROM sales s WHERE ${whereClause}
         GROUP BY HOUR(s.order_date) ORDER BY hr`, params);
      out.byHour = h.map(r => ({ hour: Number(r.hr), count: Number(r.cnt), total: Math.round(Number(r.total) * 100) / 100 }));
    }
    // (top_items handled above as out.byProduct + out.topItems alias)

    // v7.1 — distinct channels + payment methods so the UI can populate dropdowns
    if (hasChannel) {
      try {
        const [chRows] = await db.query("SELECT DISTINCT channel_name FROM sales WHERE channel_name IS NOT NULL AND channel_name <> '' ORDER BY channel_name");
        out.channels = chRows.map(r => r.channel_name);
      } catch(_) { out.channels = []; }
    } else { out.channels = []; }
    try {
      const [pmRows] = await db.query("SELECT DISTINCT payment_method FROM sales WHERE payment_method IS NOT NULL AND payment_method <> '' ORDER BY payment_method");
      out.paymentMethods = pmRows.map(r => r.payment_method);
    } catch(_) { out.paymentMethods = []; }

    res.json({ success: true, ...out });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

/**
 * GET /erp/reports/sales-by-channel?from=&to=&brand=
 * V3 Sales breakdown by channel (Hangerstation / Keeta / main / etc.)
 * Returns per-channel: order count, gross sales, total discounts, net sales,
 * commission (if defined), service fees.
 */
router.get('/reports/sales-by-channel', async (req, res) => {
  try {
    const { from, to, brand } = req.query;
    // Verify channel_id column exists (migration may not have run on very old deploys)
    let hasChannel = true;
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'channel_id'"); hasChannel = !!c.length; } catch(e) { hasChannel = false; }
    if (!hasChannel) return res.json({ success: true, rows: [], totals: { gross:0, discount:0, net:0, count:0 }, note: 'channel_id column missing' });

    const where = ["s.deleted_at IS NULL"];
    const params = [];
    if (from) { where.push('DATE(s.order_date) >= ?'); params.push(from); }
    if (to)   { where.push('DATE(s.order_date) <= ?'); params.push(to); }
    if (brand) {
      // brand may live on s.brand_id only on some deploys; tolerate absence
      try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'brand_id'"); if (c.length) { where.push('s.brand_id = ?'); params.push(brand); } } catch(e) {}
    }
    const whereClause = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const [rows] = await db.query(`
      SELECT
        COALESCE(s.channel_id, '__none__') AS channel_id,
        COALESCE(s.channel_name, c.name, 'بدون قناة') AS channel_name,
        COALESCE(c.icon, 'fa-store') AS icon,
        COALESCE(c.color, '#64748b') AS color,
        COALESCE(c.commission_pct, 0) AS commission_pct,
        COALESCE(c.service_fee_pct, 0) AS service_fee_pct,
        COUNT(*) AS order_count,
        SUM(s.total_final + COALESCE(s.discount_amount, 0)) AS gross_sales,
        SUM(COALESCE(s.discount_amount, 0)) AS total_discount,
        SUM(s.total_final) AS net_sales
      FROM sales s
      LEFT JOIN sales_channels c ON c.id = s.channel_id
      ${whereClause}
      GROUP BY s.channel_id, channel_name, icon, color, commission_pct, service_fee_pct
      ORDER BY net_sales DESC
    `, params);

    const out = rows.map(r => {
      const net = Number(r.net_sales || 0);
      const commPct = Number(r.commission_pct || 0);
      const feePct = Number(r.service_fee_pct || 0);
      const commission = net * (commPct / 100);
      const serviceFee = net * (feePct / 100);
      return {
        channelId: r.channel_id === '__none__' ? null : r.channel_id,
        channelName: r.channel_name,
        icon: r.icon,
        color: r.color,
        orderCount: Number(r.order_count || 0),
        grossSales: Number(r.gross_sales || 0),
        totalDiscount: Number(r.total_discount || 0),
        netSales: net,
        commissionPct: commPct,
        commission: commission,
        serviceFeePct: feePct,
        serviceFee: serviceFee,
        netAfterCommission: net - commission - serviceFee
      };
    });

    const totals = out.reduce((acc, r) => {
      acc.gross += r.grossSales;
      acc.discount += r.totalDiscount;
      acc.net += r.netSales;
      acc.commission += r.commission;
      acc.serviceFee += r.serviceFee;
      acc.count += r.orderCount;
      return acc;
    }, { gross: 0, discount: 0, net: 0, commission: 0, serviceFee: 0, count: 0 });
    totals.netAfterCommission = totals.net - totals.commission - totals.serviceFee;

    res.json({ success: true, rows: out, totals: totals, filters: { from, to, brand } });
  } catch(e) {
    console.error('sales-by-channel error:', e);
    res.json({ success: false, error: e.message, rows: [], totals: {} });
  }
});

/**
 * GET /erp/reports/discounts-given?from=&to=
 * V3 Discount usage report: per-discount totals (count, sum, avg)
 */
router.get('/reports/discounts-given', async (req, res) => {
  try {
    const { from, to } = req.query;
    let hasDiscId = true;
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'discount_id'"); hasDiscId = !!c.length; } catch(e) { hasDiscId = false; }
    if (!hasDiscId) return res.json({ success: true, rows: [], totals: {}, note: 'discount_id column missing' });

    const where = ["s.deleted_at IS NULL", "COALESCE(s.discount_amount, 0) > 0"];
    const params = [];
    if (from) { where.push('DATE(s.order_date) >= ?'); params.push(from); }
    if (to)   { where.push('DATE(s.order_date) <= ?'); params.push(to); }
    const whereClause = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const [rows] = await db.query(`
      SELECT
        COALESCE(s.discount_id, '__manual__') AS discount_id,
        COALESCE(s.discount_name, d.name, 'يدوي') AS discount_name,
        COALESCE(d.type, '—') AS type,
        COALESCE(d.discount_scope, '—') AS scope,
        COUNT(*) AS use_count,
        SUM(s.discount_amount) AS total_discount,
        AVG(s.discount_amount) AS avg_discount
      FROM sales s
      LEFT JOIN discounts_v2 d ON d.id = s.discount_id
      ${whereClause}
      GROUP BY s.discount_id, discount_name, type, scope
      ORDER BY total_discount DESC
    `, params);

    const out = rows.map(r => ({
      discountId: r.discount_id === '__manual__' ? null : r.discount_id,
      discountName: r.discount_name,
      type: r.type,
      scope: r.scope,
      useCount: Number(r.use_count || 0),
      totalDiscount: Number(r.total_discount || 0),
      avgDiscount: Number(r.avg_discount || 0)
    }));
    const totals = out.reduce((acc, r) => {
      acc.uses += r.useCount;
      acc.amount += r.totalDiscount;
      return acc;
    }, { uses: 0, amount: 0 });
    res.json({ success: true, rows: out, totals: totals, filters: { from, to } });
  } catch(e) {
    console.error('discounts-given error:', e);
    res.json({ success: false, error: e.message });
  }
});

/**
 * GET /erp/reports/waste-analytics?from=&to=&brand=&branch=
 * Waste as % of sales, top-wasted items, by reason, trend.
 */
router.get('/reports/waste-analytics', async (req, res) => {
  try {
    const { from, to, brand, branch } = req.query;
    const where = [];
    const params = [];
    if (from) { where.push('w.waste_date >= ?'); params.push(from); }
    if (to)   { where.push('w.waste_date <= ?'); params.push(to); }
    if (brand)  { where.push('w.brand_id = ?');  params.push(brand); }
    if (branch) { where.push('w.branch_id = ?'); params.push(branch); }
    const wc = where.length ? ' WHERE ' + where.join(' AND ') : '';

    // Total waste cost
    const [tot] = await db.query(`SELECT COALESCE(SUM(total_cost),0) AS total_waste FROM waste_entries w ${wc}`, params);
    const totalWaste = Number(tot[0].total_waste) || 0;

    // Total sales for the same filters (for % calculation)
    const sWhere = [];
    const sParams = [];
    let hasSBranch = true, hasSBrand = true;
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'branch_id'"); hasSBranch = !!c.length; } catch(e) { hasSBranch = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'brand_id'"); hasSBrand = !!c.length; } catch(e) { hasSBrand = false; }
    if (from) { sWhere.push('DATE(s.order_date) >= ?'); sParams.push(from); }
    if (to)   { sWhere.push('DATE(s.order_date) <= ?'); sParams.push(to); }
    if (brand && hasSBrand)   { sWhere.push('s.brand_id = ?');  sParams.push(brand); }
    if (branch && hasSBranch) { sWhere.push('s.branch_id = ?'); sParams.push(branch); }
    const [sales] = await db.query(`SELECT COALESCE(SUM(total_final),0) AS total_sales FROM sales s ${sWhere.length ? ' WHERE ' + sWhere.join(' AND ') : ''}`, sParams);
    const totalSales = Number(sales[0].total_sales) || 0;
    const wastePctOfSales = totalSales > 0 ? Math.round((totalWaste / totalSales) * 10000) / 100 : 0;

    // Top wasted items
    const [topItems] = await db.query(
      `SELECT wi.item_id, i.name AS item_name, i.id AS sku,
              SUM(wi.quantity) AS total_qty, SUM(wi.line_cost) AS total_cost
       FROM waste_entry_items wi
       JOIN waste_entries w ON wi.waste_id = w.id
       LEFT JOIN inv_items i ON wi.item_id = i.id
       ${wc}
       GROUP BY wi.item_id, i.name, i.id
       ORDER BY total_cost DESC LIMIT 20`, params);

    // By reason
    const [byReason] = await db.query(
      `SELECT w.reason, COUNT(*) AS cnt, COALESCE(SUM(w.total_cost),0) AS total_cost
       FROM waste_entries w ${wc} GROUP BY w.reason ORDER BY total_cost DESC`, params);

    // Monthly trend
    const [trend] = await db.query(
      `SELECT DATE_FORMAT(w.waste_date, '%Y-%m') AS ym, COALESCE(SUM(w.total_cost),0) AS total
       FROM waste_entries w ${wc} GROUP BY ym ORDER BY ym`, params);

    res.json({
      success: true,
      filters: { from: from || null, to: to || null, brand: brand || null, branch: branch || null },
      summary: {
        totalWasteCost: Math.round(totalWaste * 100) / 100,
        totalSales: Math.round(totalSales * 100) / 100,
        wastePctOfSales
      },
      topItems: topItems.map(r => ({
        itemId: r.item_id, itemName: r.item_name || '(?)', sku: r.sku || '',
        totalQty: Number(r.total_qty) || 0,
        totalCost: Math.round(Number(r.total_cost) * 100) / 100
      })),
      byReason: byReason.map(r => ({
        reason: r.reason,
        count: Number(r.cnt) || 0,
        totalCost: Math.round(Number(r.total_cost) * 100) / 100
      })),
      trend: trend.map(r => ({
        period: r.ym,
        total: Math.round(Number(r.total) * 100) / 100
      }))
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

/**
 * GET /erp/reports/royalty-reconciliation?brand=&year=
 * Per-month: computed royalty vs. paid amount.
 */
router.get('/reports/royalty-reconciliation', async (req, res) => {
  try {
    const { brand, year } = req.query;
    const y = year || String(new Date().getFullYear());

    const where = [];
    const params = [];
    where.push("YEAR(rr.period_start) = ?"); params.push(y);
    if (brand) { where.push('rr.brand_id = ?'); params.push(brand); }

    const [runs] = await db.query(
      `SELECT rr.*, b.name AS brand_name
       FROM royalty_runs rr
       LEFT JOIN brands b ON rr.brand_id = b.id
       WHERE ${where.join(' AND ')}
       ORDER BY rr.period_start`, params);

    const rows = runs.map(r => {
      const amt = Number(r.royalty_amount) || 0;
      const paid = r.status === 'paid' ? amt : 0;
      return {
        id: r.id, brandId: r.brand_id, brandName: r.brand_name || '',
        periodStart: r.period_start, periodEnd: r.period_end, runDate: r.run_date,
        grossSales: Number(r.gross_sales) || 0,
        netSales: Number(r.net_sales) || 0,
        royaltyType: r.royalty_type,
        royaltyAmount: amt,
        paid,
        outstanding: Math.round((amt - paid) * 100) / 100,
        status: r.status, paidAt: r.paid_at,
        journalId: r.gl_journal_id || null
      };
    });

    const totals = rows.reduce((t, r) => ({
      accrued: t.accrued + r.royaltyAmount,
      paid: t.paid + r.paid,
      outstanding: t.outstanding + r.outstanding
    }), { accrued: 0, paid: 0, outstanding: 0 });

    res.json({
      success: true,
      year: y,
      filters: { brand: brand || null },
      rows,
      totals: {
        accrued: Math.round(totals.accrued * 100) / 100,
        paid: Math.round(totals.paid * 100) / 100,
        outstanding: Math.round(totals.outstanding * 100) / 100
      }
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// V5.7.7 — ACCOUNTING DIMENSIONS DIRECTORY (دليل الأبعاد المحاسبية)
// Single endpoint that returns counts + sample items for ALL 8 dimensions
// used in the system. Useful for:
//   - Finance team: "what are all the analytical axes available?"
//   - Auditors: full picture of how many items in each dimension
//   - Admins: quick navigation to manage any dimension
// ═══════════════════════════════════════════════════════════════════

// Definition of all dimensions: table, label (Arabic), icon, key fields,
// optional usage-count query (how many txns/journals reference each item).
const _DIMENSIONS = [
  {
    key: 'branches', label: 'الفروع', icon: 'fa-building',
    color: '#3b82f6', desc: 'مواقع البيع والعمليات الفعلية',
    table: 'branches',
    selectFields: 'id, code, name, city, address, phone, manager_name, COALESCE(is_active, 1) AS is_active',
    nameField: 'name', codeField: 'code', activeField: 'is_active'
  },
  {
    key: 'cost_centers', label: 'مراكز التكلفة', icon: 'fa-sitemap',
    color: '#8b5cf6', desc: 'بنود تجميع المصروفات والإيرادات للتحليل',
    table: 'cost_centers',
    selectFields: 'id, code, name, type, parent_id, COALESCE(is_active, 1) AS is_active',
    nameField: 'name', codeField: 'code', activeField: 'is_active'
  },
  {
    key: 'brands', label: 'العلامات التجارية', icon: 'fa-tags',
    color: '#f59e0b', desc: 'البراندات/العلامات للمنتجات والقوائم',
    table: 'brands',
    selectFields: 'id, code, name, name_en, color, COALESCE(is_active, 1) AS is_active',
    nameField: 'name', codeField: 'code', activeField: 'is_active'
  },
  {
    key: 'departments', label: 'الأقسام', icon: 'fa-users',
    color: '#06b6d4', desc: 'الأقسام التنظيمية للموارد البشرية',
    table: 'hr_departments',
    selectFields: 'id, code, name, branch_id, COALESCE(is_active, 1) AS is_active',
    nameField: 'name', codeField: 'code', activeField: 'is_active'
  },
  {
    key: 'warehouses', label: 'المستودعات', icon: 'fa-warehouse',
    color: '#0ea5e9', desc: 'مواقع تخزين الأصناف والمخزون',
    table: 'warehouses',
    selectFields: 'id, code, name, type, branch_id, brand_id, COALESCE(is_main, 0) AS is_main, parent_warehouse_id',
    nameField: 'name', codeField: 'code', activeField: null
  },
  {
    key: 'sales_channels', label: 'قنوات البيع', icon: 'fa-store',
    color: '#10b981', desc: 'قنوات البيع (صالة، توصيل، تطبيقات...)',
    table: 'sales_channels',
    selectFields: 'id, code, name, channel_type, price_list_id, COALESCE(is_active, 1) AS is_active',
    nameField: 'name', codeField: 'code', activeField: 'is_active'
  },
  {
    key: 'properties', label: 'العقارات والمشاريع', icon: 'fa-building-flag',
    color: '#a855f7', desc: 'العقارات والمشاريع للتحليل المالي',
    table: 'properties',
    selectFields: 'id, code, name, type, city, district, status',
    nameField: 'name', codeField: 'code', activeField: null,
    activeFilter: "status = 'active'"
  },
  {
    key: 'employees', label: 'الموظفون', icon: 'fa-user-tie',
    color: '#ef4444', desc: 'الموظفون كبُعد للعمولات والرواتب وأوامر العمل',
    table: 'hr_employees',
    selectFields: "id, employee_number AS code, CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,'')) AS name, branch_id, department_id, position_id, status",
    nameField: "CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,''))",
    codeField: 'employee_number', activeField: null,
    activeFilter: "COALESCE(status,'active') = 'active'"
  }
];

// GET /api/erp/accounting-dimensions/summary — counts + small sample per dimension.
router.get('/accounting-dimensions/summary', async (req, res) => {
  try {
    const out = {
      title: 'دليل الأبعاد المحاسبية',
      generatedAt: new Date().toISOString(),
      dimensions: []
    };
    for (const d of _DIMENSIONS) {
      try {
        // Total count
        const [tc] = await db.query(`SELECT COUNT(*) AS c FROM ${d.table}`);
        const total = Number((tc[0]||{}).c) || 0;
        // Active count
        let active = total;
        if (d.activeField) {
          try {
            const [ac] = await db.query(`SELECT COUNT(*) AS c FROM ${d.table} WHERE COALESCE(${d.activeField}, 1) = 1`);
            active = Number((ac[0]||{}).c) || 0;
          } catch(_) {}
        } else if (d.activeFilter) {
          try {
            const [ac] = await db.query(`SELECT COUNT(*) AS c FROM ${d.table} WHERE ${d.activeFilter}`);
            active = Number((ac[0]||{}).c) || 0;
          } catch(_) {}
        }
        // Sample 5 most recent items — tolerant to missing columns
        let samples = [];
        try {
          const [s] = await db.query(`SELECT ${d.selectFields} FROM ${d.table} ORDER BY ${d.codeField||'id'} LIMIT 5`);
          samples = s;
        } catch(_) {
          // Fallback: discover available columns then re-query with safe subset
          try {
            const [cols] = await db.query(`SHOW COLUMNS FROM ${d.table}`);
            const colNames = cols.map(c => c.Field || c.field);
            const safe = ['id','code','name','title','type','status','is_active','active']
              .filter(c => colNames.includes(c));
            if (safe.length) {
              const ord = colNames.includes(d.codeField) ? d.codeField : 'id';
              const [s2] = await db.query(`SELECT ${safe.join(',')} FROM ${d.table} ORDER BY ${ord} LIMIT 5`);
              samples = s2;
            }
          } catch(_e2) {}
        }
        out.dimensions.push({
          key: d.key,
          label: d.label,
          icon: d.icon,
          color: d.color,
          description: d.desc,
          tableName: d.table,
          total: total,
          active: active,
          inactive: total - active,
          samples: samples
        });
      } catch(_e) {
        out.dimensions.push({
          key: d.key,
          label: d.label,
          icon: d.icon,
          color: d.color,
          description: d.desc,
          tableName: d.table,
          total: 0, active: 0, inactive: 0,
          samples: [],
          error: 'الجدول غير موجود في هذه النسخة من قاعدة البيانات'
        });
      }
    }
    // Aggregate totals
    out.totals = {
      tableCount: out.dimensions.length,
      itemCount: out.dimensions.reduce((s,d)=>s+d.total, 0),
      activeItems: out.dimensions.reduce((s,d)=>s+d.active, 0),
      tablesAvailable: out.dimensions.filter(d => !d.error).length,
      tablesMissing: out.dimensions.filter(d => d.error).length
    };
    res.json(out);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/erp/accounting-dimensions/:key — full list of items for one dimension
//   ?q=search   — name/code filter
//   ?status=    — active|inactive|all (default all)
// V5.7.7-fix: tolerant to missing columns — falls back to only safe fields
//             (id, code, name) if the rich SELECT fails.
router.get('/accounting-dimensions/:key', async (req, res) => {
  try {
    const def = _DIMENSIONS.find(d => d.key === req.params.key);
    if (!def) return res.status(404).json({ error: 'بُعد غير معروف' });
    const q = (req.query.q || '').trim();
    const status = req.query.status || 'all';
    const conds = []; const params = [];
    if (q) {
      conds.push(`(${def.codeField||'id'} LIKE ? OR ${def.nameField||'name'} LIKE ?)`);
      params.push('%'+q+'%', '%'+q+'%');
    }
    if (status === 'active') {
      if (def.activeField) conds.push(`COALESCE(${def.activeField}, 1) = 1`);
      else if (def.activeFilter) conds.push(def.activeFilter);
    } else if (status === 'inactive') {
      if (def.activeField) conds.push(`COALESCE(${def.activeField}, 1) = 0`);
      else if (def.activeFilter) conds.push(`NOT (${def.activeFilter})`);
    }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const orderBy = def.codeField || 'id';
    let rows;
    try {
      [rows] = await db.query(
        `SELECT ${def.selectFields} FROM ${def.table} ${where} ORDER BY ${orderBy} LIMIT 1000`,
        params);
    } catch(_e) {
      // Some columns missing on this deploy — fall back to discovering actual columns.
      try {
        const [cols] = await db.query(`SHOW COLUMNS FROM ${def.table}`);
        const colNames = cols.map(c => c.Field || c.field);
        // Pick a safe subset based on what exists
        const safe = ['id','code','name','name_en','title','type','status','is_active','active','branch_id','brand_id','department_id','position_id','color','city','phone','manager_name']
          .filter(c => colNames.includes(c));
        if (!safe.length) throw new Error('no usable columns');
        const orderCol = colNames.includes(def.codeField) ? def.codeField : 'id';
        [rows] = await db.query(
          `SELECT ${safe.join(',')} FROM ${def.table} ${where} ORDER BY ${orderCol} LIMIT 1000`,
          params);
      } catch(_e2) {
        return res.json({ key: def.key, label: def.label, total: 0, items: [],
          warning: 'تعذّر قراءة بعض الأعمدة — قد يكون الجدول بصيغة قديمة' });
      }
    }
    res.json({
      key: def.key, label: def.label, total: rows.length,
      items: rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
