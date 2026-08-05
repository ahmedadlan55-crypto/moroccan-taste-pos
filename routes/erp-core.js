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
const acctDate = require('../lib/accountingDate');
const db = require('../db/connection');
const gl = require('../lib/glPosting');
// v7.1 — waste must actually deduct warehouse stock + carry a document number.
const { deductWarehouseStock } = require('../lib/stockRecompute');
const { nextDocNumber } = require('../lib/docNumber');
// v4 SECURITY — this router is mounted at /api/erp (server.js) and had ZERO
// capability or role guards, while it contains THREE gl.postJournal call sites
// (royalty approve, waste create, purchase receipt). Any authenticated user —
// a cashier's token included — could post journal entries to the general ledger
// and deduct warehouse stock. Sibling modules right next to the mount are gated
// with requireRole('admin','manager').
const requireCapability = require('../middleware/requireCapability');
const coaTree = require('../lib/coa/tree');
const trialBalanceEngine = require('../lib/reports/trialBalance');
const warehouseScopeLib = require('../lib/warehouseScope');

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

// v4 — was a byte-identical copy of lib/glPosting.js's helper, and it had drifted
// with the SAME two bugs: it compared status to the single literal 'closed' (the
// enum has five values — 'locked'/'soft_close'/'soft_closed' all posted), and it
// answered `false` on any DB error, so the swallow turned the period lock OFF
// exactly when the DB was unhealthy. One implementation now, and it fails closed.
const isPeriodClosed = (date) => gl.isPeriodClosed(db, date);

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundCost(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

// The shared legacy helper intentionally swallows failures for ancient schemas.
// These routes move stock and money together, so their roll-up is part of the
// transaction contract and must fail closed instead.
async function recomputeInvItemStockStrict(conn, itemId) {
  await conn.query(
    `UPDATE inv_items i SET i.stock =
       (SELECT COALESCE(SUM(ws.qty), 0) FROM warehouse_stock ws WHERE ws.item_id = i.id)
     WHERE i.id = ?`,
    [itemId]
  );
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

// v7.5 SECURITY — every write in this file outside royalty/waste/purchase-
// receipts (guarded in v4) was still bare: any authenticated token could
// rewrite companies, item categories, price lists, recipes, POS terminals and
// accounting periods. Each write now carries the narrowest EXISTING
// permissions_v3 capability (all verified present with role grants):
//   org.companies.edit / org.brands.edit / org.branches.edit  (admin+manager)
//   inventory.edit          (admin/manager/inventory — categories, units, BOM)
//   channels.manage         (admin+manager — price lists ARE channel pricing)
//   finance.periods.manage  (finance+manager — period create/close/reopen)
router.post('/companies', requireCapability('org.companies.edit'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/companies] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
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

router.post('/item-categories', requireCapability('inventory.edit'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/item-categories] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/item-categories/:id', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const [c] = await db.query('SELECT COUNT(*) AS n FROM inv_items WHERE category_id = ?', [req.params.id]);
    if (c[0].n > 0) return res.json({ success: false, error: 'توجد أصناف تحت هذه الفئة' });
    await db.query('UPDATE item_categories SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/item-categories:delete] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
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

router.post('/unit-conversions', requireCapability('inventory.edit'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/unit-conversions] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
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

router.post('/price-lists', requireCapability('channels.manage'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/price-lists] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.16.1 — Bulk-add the brand's entire admin menu into a price list.
// Skips items already in the list (dedup via INSERT IGNORE on the
// composite unique key if present, falls back to a SELECT exists check
// otherwise). Returns counts so the UI can show a toast.
router.post('/price-lists/:plId/import-brand-menu', requireCapability('channels.manage'), async (req, res) => {
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

router.post('/price-lists/:id/items', requireCapability('channels.manage'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/price-lists/items] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/price-list-items/:id', requireCapability('channels.manage'), async (req, res) => {
  try {
    await db.query('DELETE FROM price_list_items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/price-list-items:delete] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
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
router.post('/price-lists/:id/categories/bulk-price', requireCapability('channels.manage'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/price-lists/bulk-price] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

// Inline-edit save: bulk update specific line items by id.
// Body: { items: [{ id, price, minPrice?, category? }] }
router.post('/price-lists/:id/items/bulk-update', requireCapability('channels.manage'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/price-lists/bulk-update] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

// Move every item in one category to another. Useful for renaming
// categories without touching menu.category.
router.post('/price-lists/:id/categories/rename', requireCapability('channels.manage'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/price-lists/categories-rename] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

// V5.7 — DELETE the entire price list (with cascade across all dependent tables)
//   1. price_list_items   — line items in this list
//   2. sales_channels     — UNSET price_list_id pointers (don't break channels)
//   3. channel_menu_items — UNSET override_price refs that came from this list (if any)
//   4. price_lists        — the list itself (last)
//   ?force=1 query param required if list is the default one (extra safety).
router.delete('/price-lists/:id', requireCapability('channels.manage'), async (req, res) => {
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
router.post('/price-lists/:id/items/bulk', requireCapability('channels.manage'), async (req, res) => {
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
router.post('/price-lists/:id/import', requireCapability('channels.manage'), async (req, res) => {
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
  } catch(e) {
    // NEVER res.json([]) — a DB fault dressed as "no data" is the defect the
    // unified recipe domain exists to remove. Answer with a real status, a
    // code, and the requestId the server already mints.
    console.error('[erp/bom]', req.requestId || '-', e && e.message);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'تعذّر قراءة الوصفات', requestId: req.requestId || null });
  }
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
    // NEVER res.json([]) — the BOM picker showing "no products" because a
    // query broke is the same false-empty defect as the list above.
    console.error('[bom/product-pool]', req.requestId || '-', e && e.message);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'تعذّر قراءة قائمة المنتجات', requestId: req.requestId || null });
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

// COMPATIBILITY LAYER. Kept mounted because a caller may still exist outside
// this repo, but it no longer owns any rules — it delegates to
// routes/recipes.js `saveRecipe`, the ONE write path.
//
// What delegating fixes here specifically:
//   • it STOPPED trusting `req.body.recomputedCost`. The old code read the cost
//     straight from the browser ("Frontend may send recomputedCost … we trust
//     it") and wrote it onto menu.cost. The cost is now computed server-side
//     from the component costs read inside the save transaction, and the field
//     is ignored if sent.
//   • it computed the batch cost WITHOUT dividing by yield, while
//     routes/menu.js's twin DID divide — so the same recipe had two different
//     unit costs depending on which screen saved it last. There is now one
//     formula (lib/recipeEngine.computeRecipeCost).
//   • one transaction instead of DELETE-then-N-INSERTs on the pool.
//   • yield/waste validation, duplicate folding, cycle detection, fail-closed
//     audit — all inherited.
router.post('/bom', requireCapability('inventory.edit'), async (req, res) => {
  const { saveRecipe, HTTP_FOR } = require('./recipes');
  try {
    const b = req.body || {};
    if (!b.productId) return res.status(422).json({ success: false, code: 'VALIDATION_ERROR', error: 'المنتج مطلوب' });
    const src = (b.productSource === 'menu') ? 'menu' : 'inv';
    const actor = (req.user && (req.user.username || req.user.name)) || '';

    // No optimistic lock in the legacy contract — read the current row_version
    // so a concurrent edit is still caught rather than refused outright.
    const [cur] = await db.query(
      "SELECT row_version FROM bom WHERE product_id=? AND COALESCE(product_source,'inv')=? AND status IN ('active','draft') ORDER BY FIELD(status,'active','draft'), version DESC LIMIT 1",
      [b.productId, src]);

    const out = await saveRecipe({
      source: src,
      productId: b.productId,
      actor,
      ip: req.ip,
      body: {
        bomId: b.id || undefined,
        yieldQuantity: b.yieldQuantity != null ? b.yieldQuantity : 1,
        yieldUnit: b.yieldUnit || 'PCS',
        effectiveFrom: b.effectiveFrom || null,
        effectiveTo: b.effectiveTo || null,
        notes: b.notes,
        consumptionWarehouseId: b.consumptionWarehouseId || null,
        activate: true,
        expectedVersion: cur.length ? Number(cur[0].row_version) : undefined,
        // `recomputedCost` is DELIBERATELY not forwarded.
        lines: (Array.isArray(b.lines) ? b.lines : []).map((l) => ({
          componentItemId: l.componentItemId || l.itemId,
          quantity: l.quantity,
          enteredUnitId: l.enteredUnitId || null,
          enteredUnitCode: l.enteredUnitCode || null,
          wastePct: l.wastePct,
          notes: l.notes,
        })),
      },
    });

    res.json({ success: true, id: out.bomId, productSource: src, version: out.version, rowVersion: out.rowVersion, computedCost: out.cost.unitCost });
  } catch (e) {
    const code = (e && e.code) || 'SERVER_ERROR';
    const status = (HTTP_FOR && HTTP_FOR[code]) || 500;
    console.error('[erp/bom] failed:', code, e && e.message);
    res.status(status).json({
      success: false, code,
      error: status >= 500 ? 'خطأ داخلي في الخادم' : e.message,
      detail: e && e.detail, requestId: req.requestId || null,
    });
  }
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
  } catch(e) {
    // NEVER res.json([]) — a DB fault dressed as "no data" is the defect the
    // unified recipe domain exists to remove. Answer with a real status, a
    // code, and the requestId the server already mints.
    console.error('[erp/bom/:id/lines]', req.requestId || '-', e && e.message);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'تعذّر قراءة الوصفات', requestId: req.requestId || null });
  }
});

// V5.7 — Hard-delete BOM with full cascade.
// FIXES: previously this was a soft-delete (is_active=0) but menu.bom_id still
// pointed to the now-inactive BOM, leaving the menu item in a broken state where
// the recipe button wouldn't work. The new logic:
// V5.9.1 — Delete ALL Recipes (BOMs) at once
router.delete('/bom-all/clear', requireCapability('inventory.edit'), async (req, res) => {
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
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    res.status(500).json({ success: false, error: 'حدث خطأ أثناء حذف الوصفات: ' + err.message });
  }
});

//   1. Read product_source + product_id BEFORE deletion
//   2. Cascade-delete bom_lines (the recipe ingredients)
//   3. Delete the BOM row itself
//   4. If product_source='menu', clear menu.bom_id so the menu item knows
//      it no longer has a recipe
router.delete('/bom/:id', requireCapability('inventory.edit'), async (req, res) => {
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
router.post('/brands/assign-default', requireCapability('org.brands.edit'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/brands/assign-default] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

// Clone a BOM to a new product (optionally a different brand)
// Accepts: itemId OR componentItemId in line objects — tolerates either naming.
router.post('/bom/:id/clone', requireCapability('inventory.edit'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/bom/clone] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
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

// POS terminals are branch equipment — org.branches.edit (admin+manager).
router.post('/pos-terminals', requireCapability('org.branches.edit'), async (req, res) => {
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
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/pos-terminals] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/pos-terminals/:id', requireCapability('org.branches.edit'), async (req, res) => {
  try {
    await db.query('UPDATE pos_terminals SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/pos-terminals:delete] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════
// ACCOUNTING PERIODS (period lock)
// ═══════════════════════════════════════
router.get('/accounting-periods', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM accounting_periods ORDER BY start_date DESC');
    res.json(rows.map(p => ({
      id: p.id,
      // period_name is nullable and was added later; period_label is the older
      // NOT NULL column. Prefer the friendly name, fall back to the label.
      periodName: p.period_name || p.period_label || '',
      startDate: p.start_date, endDate: p.end_date,
      // Normalise the duplicate soft_close/soft_closed enum spellings, as
      // /erp/periods does — one spelling for the client.
      status: p.status === 'soft_close' ? 'soft_closed' : p.status,
      closedBy: p.closed_by || '', closedAt: p.closed_at,
      // v4 — was `p.notes`, a PHANTOM column: accounting_periods has
      // closing_notes, not notes. Because the query is `SELECT *`, MySQL never
      // threw — the property was simply undefined, so this endpoint reported
      // every period as having no notes. Silent-undefined, not silent-empty.
      notes: p.closing_notes || ''
    })));
  } catch (e) {
    // Was `res.json([])` — a DB fault rendered as "no periods".
    console.error('[erp/accounting-periods] list failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل الفترات المحاسبية' });
  }
});

// Period create/close/reopen decides what the period lock enforces on every
// GL-writing endpoint — finance.periods.manage, same as /erp/periods.
router.post('/accounting-periods', requireCapability('finance.periods.manage'), async (req, res) => {
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
      // period_label is NOT NULL with no default on the live schema — omitting it
      // made this endpoint unable to create a period AT ALL (every insert threw,
      // and the old 200-with-{success:false} catch dressed that as a business
      // reply). Same value as period_name: the repaired /erp/periods sibling
      // treats label as the display name.
      `INSERT INTO accounting_periods (id, period_name, period_label, start_date, end_date, status) VALUES (?,?,?,?,?,'open')`,
      [newId, periodName, periodName, startDate, endDate]);
    res.json({ success: true, id: newId });
  } catch(e) {
    // v7.5 — was a 200 with {success:false}: a DB fault dressed as a business reply.
    console.error('[erp/accounting-periods] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/accounting-periods/:id/close', requireCapability('finance.periods.manage'), async (req, res) => {
  try {
    // v7.5 — closed_by comes from the authenticated JWT, never the body (the
    // body's `username` was a spoofable actor on an audit column).
    const actor = (req.user && (req.user.username || req.user.name)) || '';
    await db.query(
      `UPDATE accounting_periods SET status='closed', closed_by=?, closed_at=NOW() WHERE id=?`,
      [actor, req.params.id]);
    res.json({ success: true });
  } catch(e) {
    console.error('[erp/accounting-periods/close] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/accounting-periods/:id/reopen', requireCapability('finance.periods.manage'), async (req, res) => {
  try {
    await db.query(`UPDATE accounting_periods SET status='open', closed_by=NULL, closed_at=NULL WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    console.error('[erp/accounting-periods/reopen] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
});

// Helper endpoint — check if a date falls in a closed period.
// The catch used to answer `{closed:false}` — telling the caller the period is
// OPEN when we had in fact failed to determine anything. isPeriodClosed already
// fails closed internally; this now surfaces a real fault instead of a
// reassuring lie.
router.get('/period-status', async (req, res) => {
  try {
    const d = req.query.date;
    const closed = await isPeriodClosed(d);
    res.json({ date: d, closed });
  } catch (e) {
    console.error('[erp/period-status] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر التحقق من حالة الفترة' });
  }
});

// ═══════════════════════════════════════
// ROYALTY RUNS (franchise accrual)
// ═══════════════════════════════════════
router.get('/royalty-runs', requireCapability('royalty.view'), async (req, res) => {
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
  } catch(e) {
    // was `res.json([])` — a DB fault rendered as "no royalty runs".
    console.error('[erp/royalty-runs] list failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل احتسابات الامتياز' });
  }
});

/**
 * The royalty base, computed from what the sales table ACTUALLY records.
 *
 * The previous version selected sales.total_amount and sales.vat_amount —
 * columns this table has never had (they belong to sales_returns). Every
 * compute since the feature shipped threw ER_BAD_FIELD_ERROR and the catch
 * reported it as a friendly failure: royalty_runs is empty because the feature
 * was BROKEN, not unused. It also filtered on deleted_at, which is written by
 * nothing (0 rows live), and dated by created_at instead of the business date.
 *
 *  · gross  = SUM(total_final)              — post-discount, VAT-inclusive
 *  · net    = Σ tax_subtotals_json[*].net   — the RECORDED ex-VAT amounts per
 *    category (S/Z/E/O). Never gross/1.15: that taxes zero-rated and exempt
 *    lines at 15% and hardcodes a rate that lives in settings.
 *  · voided sales are excluded by zatca_type — the only cancellation marker
 *    that is actually written.
 *  · returns reduce the month the CREDIT NOTE was issued in (per the business
 *    decision: an approved period is never recomputed). Credit notes live in
 *    ar_documents (document_type='credit_note') — the legacy credit_notes
 *    table has 0 rows and is not the O2C source of truth.
 *
 * Rows whose tax_subtotals_json is missing or unparseable make the NET
 * indeterminable. They are counted and surfaced; a net_sales-based royalty
 * REFUSES to compute over them rather than guessing.
 */
async function _royaltyBase(brandId, periodStart, periodEnd) {
  const [rows] = await db.query(
    `SELECT total_final, tax_subtotals_json FROM sales
      WHERE brand_id = ? AND DATE(order_date) BETWEEN ? AND ?
        AND (zatca_type IS NULL OR zatca_type NOT IN ('cancellation','credit_note'))`,
    [brandId, periodStart, periodEnd]);
  let gross = 0, net = 0, netUnknownCount = 0;
  for (const r of rows) {
    gross += Number(r.total_final) || 0;
    let parsed = null;
    try { parsed = r.tax_subtotals_json ? JSON.parse(r.tax_subtotals_json) : null; } catch (_) { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      for (const b of Object.values(parsed)) net += Number(b && b.net) || 0;
    } else {
      netUnknownCount++;
    }
  }
  // Credit notes issued INSIDE the period reduce it, whatever month the
  // original sale was in. Drafts and cancelled CNs are not money.
  const [cn] = await db.query(
    `SELECT COALESCE(SUM(total_amount),0) AS g, COALESCE(SUM(subtotal),0) AS n, COUNT(*) AS c
       FROM ar_documents
      WHERE document_type = 'credit_note' AND brand_id = ?
        AND DATE(issue_date) BETWEEN ? AND ?
        AND status NOT IN ('cancelled','draft')`,
    [brandId, periodStart, periodEnd]);
  const round2 = (v) => Math.round(v * 100) / 100;
  return {
    saleCount: rows.length,
    gross: round2(gross - Number(cn[0].g)),
    net: round2(net - Number(cn[0].n)),
    creditNotes: { count: Number(cn[0].c), gross: round2(Number(cn[0].g)), net: round2(Number(cn[0].n)) },
    netUnknownCount,
  };
}

function _royaltyAmount(brand, base) {
  const rtype = brand.royalty_type || 'none';
  const rvalue = Number(brand.royalty_value) || 0;
  const rbase = brand.royalty_base || 'gross_sales';
  const fixedComponent = Number(brand.royalty_fixed_component) || 0;
  const baseAmount = rbase === 'net_sales' ? base.net : base.gross;
  let amount = 0;
  if (rtype === 'percentage') amount = baseAmount * rvalue / 100;
  else if (rtype === 'fixed') amount = rvalue;
  else if (rtype === 'mixed') amount = fixedComponent + (baseAmount * rvalue / 100);
  return { rtype, rvalue, rbase, fixedComponent, amount: Math.round(amount * 100) / 100 };
}

// Compute royalty for a brand + period. `preview:true` answers the numbers
// WITHOUT writing anything — the screen shows the operator what a run would
// contain before a draft exists to clean up.
router.post('/royalty-runs/compute', requireCapability('royalty.manage'), async (req, res) => {
  try {
    const { brandId, periodStart, periodEnd, preview } = req.body || {};
    if (!brandId || !periodStart || !periodEnd) return res.json({ success: false, error: 'الحقول مطلوبة' });
    if (String(periodEnd) < String(periodStart)) return res.json({ success: false, error: 'نهاية الفترة قبل بدايتها' });

    const [br] = await db.query('SELECT * FROM brands WHERE id = ?', [brandId]);
    if (!br.length) return res.json({ success: false, error: 'البراند غير موجود' });
    const b = br[0];

    const base = await _royaltyBase(brandId, periodStart, periodEnd);
    const calc = _royaltyAmount(b, base);

    // A net-based royalty over sales whose recorded VAT breakdown is missing
    // would be a guess wearing a decimal point. Refuse, name the count.
    if (calc.rbase === 'net_sales' && base.netUnknownCount > 0) {
      return res.json({
        success: false,
        error: `تعذّر الاحتساب على صافي المبيعات: ${base.netUnknownCount} فاتورة بلا تفصيل ضريبي مسجّل — الصافي غير قابل للتحديد`,
        netUnknownCount: base.netUnknownCount,
      });
    }

    const body = {
      brandId, periodStart, periodEnd,
      grossSales: base.gross, netSales: base.net,
      saleCount: base.saleCount, creditNotes: base.creditNotes,
      netUnknownCount: base.netUnknownCount,
      royaltyType: calc.rtype, royaltyValue: calc.rvalue, royaltyBase: calc.rbase,
      fixedComponent: calc.fixedComponent, royaltyAmount: calc.amount,
    };
    if (preview) return res.json({ success: true, preview: true, ...body });

    // One run per brand+period. Overlap (not just equality) is refused: two
    // runs sharing even a day would bill the same sales twice.
    const [dup] = await db.query(
      `SELECT id, period_start, period_end, status FROM royalty_runs
        WHERE brand_id = ? AND NOT (period_end < ? OR period_start > ?) LIMIT 1`,
      [brandId, periodStart, periodEnd]);
    if (dup.length) {
      return res.json({
        success: false,
        error: `الفترة تتداخل مع احتساب قائم (${dup[0].id} — ${String(dup[0].period_start).slice(0, 10)} إلى ${String(dup[0].period_end).slice(0, 10)}، حالة ${dup[0].status})`,
      });
    }

    const id = genId('RR');
    await db.query(
      `INSERT INTO royalty_runs (
         id, brand_id, run_date, period_start, period_end,
         gross_sales, net_sales, royalty_type, royalty_value, fixed_component, royalty_amount, status
       ) VALUES (?,?,CURDATE(),?,?, ?,?,?,?,?,?,'draft')`,
      [id, brandId, periodStart, periodEnd, base.gross, base.net, calc.rtype, calc.rvalue, calc.fixedComponent, calc.amount]);
    res.json({ success: true, id, ...body });
  } catch(e) {
    console.error('[erp/royalty-runs/compute] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر احتساب الامتياز' });
  }
});

router.post('/royalty-runs/:id/approve', requireCapability('royalty.manage'), async (req, res) => {
  try {
    // v4 SECURITY — the approver is whoever the TOKEN says, never the body.
    const actor = (req.user && req.user.username) || '';

    // One transaction: the status flip and the accrual journal commit together
    // or not at all. The old flow flipped to 'approved' FIRST and posted after —
    // a posting failure left an approved run with no journal, reported as
    // success with a "postingWarning" nobody reads. An approval that did not
    // reach the ledger is not an approval.
    const out = await db.withTransaction(async (conn) => {
      const [rr] = await conn.query('SELECT * FROM royalty_runs WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rr.length) return { status: 404, body: { success: false, error: 'الاحتساب غير موجود' } };
      if (rr[0].status !== 'draft') return { status: 409, body: { success: false, error: 'لا يمكن الاعتماد — الحالة ليست مسودة' } };
      const run = rr[0];
      const amt = Number(run.royalty_amount) || 0;

      await conn.query(
        `UPDATE royalty_runs SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?`,
        [actor, req.params.id]);

      // Dr Franchise Fee Expense (brand dimension) / Cr Royalty Payable.
      // A zero-amount run (brand configured royalty_type='none') approves with
      // no journal — there is genuinely nothing to accrue.
      let journalId = null, journalNumber = null;
      if (amt > 0) {
        // mysql2 returns DATE columns as Date objects at LOCAL midnight;
        // postJournal wants 'YYYY-MM-DD'. Format locally — toISOString() would
        // shift the day back across the +03:00 offset and post yesterday.
        const ymd = (d) => (d instanceof Date
          ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          : String(d || '').slice(0, 10));
        const post = await gl.postJournal(conn, {
          journalDate: ymd(run.run_date) || acctDate.journalDate(),
          description: 'Royalty accrual — ' + (run.period_start || '') + ' to ' + (run.period_end || ''),
          referenceType: 'RoyaltyRun',
          referenceId: req.params.id,
          entries: [
            { accountCode: gl.CORE_ACCOUNTS.FRANCHISE_FEE.code, debit: amt, credit: 0, description: 'Franchise royalty expense', brandId: run.brand_id },
            { accountCode: gl.CORE_ACCOUNTS.ROYALTY_PAYABLE.code, debit: 0, credit: amt, description: 'Royalty liability to brand owner', brandId: run.brand_id },
          ],
          postedBy: actor,
        });
        // In connection mode a validation failure returns {success:false} —
        // throwing rolls the status flip back with it (closed period included).
        if (!post || !post.success) throw new Error(post && post.error ? post.error : 'فشل ترحيل قيد الامتياز');
        journalId = post.journalId; journalNumber = post.journalNumber || null;
        await conn.query('UPDATE royalty_runs SET gl_journal_id = ? WHERE id = ?', [journalId, req.params.id]);
      }
      return { status: 200, body: { success: true, journalId, journalNumber } };
    });
    res.status(out.status).json(out.body);
  } catch(e) {
    console.error('[erp/royalty-runs/approve] rolled back:', e && (e.code || e.message));
    res.status(422).json({ success: false, error: e.message || 'تعذّر اعتماد الاحتساب' });
  }
});

router.post('/royalty-runs/:id/mark-paid', requireCapability('royalty.manage'), async (req, res) => {
  try {
    const [r] = await db.query(
      `UPDATE royalty_runs SET status='paid', paid_at=NOW() WHERE id=? AND status IN ('approved','invoiced')`,
      [req.params.id]);
    // was unconditional success:true — marking a draft (or nothing) "paid"
    // answered exactly like marking an approved run paid.
    if (!r.affectedRows) return res.status(409).json({ success: false, error: 'لا يمكن التأشير بالسداد — الاحتساب غير معتمد أو غير موجود' });
    res.json({ success: true });
  } catch(e) {
    console.error('[erp/royalty-runs/mark-paid] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر التأشير بالسداد' });
  }
});

router.delete('/royalty-runs/:id', requireCapability('royalty.manage'), async (req, res) => {
  try {
    const [r] = await db.query(`DELETE FROM royalty_runs WHERE id=? AND status='draft'`, [req.params.id]);
    if (!r.affectedRows) return res.status(409).json({ success: false, error: 'لا يُحذف إلا احتساب بحالة مسودة' });
    res.json({ success: true });
  } catch(e) {
    console.error('[erp/royalty-runs/delete] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر الحذف' });
  }
});

// ═══════════════════════════════════════
// WASTE ENTRIES
// ═══════════════════════════════════════
// v5.10.34 — Enhanced: pagination + search + reason/warehouse filters + summary.
// Back-compat: still returns array shape when ?paginated is not set.
router.get('/waste-entries', requireCapability('inventory.view'), async (req, res) => {
  try {
    const { brand_id, branch_id, warehouse_id, reason, q } = req.query;
    const fromDate = req.query.fromDate || req.query.from;
    const toDate   = req.query.toDate   || req.query.to;

    // Reversed documents remain append-only evidence, but the legacy list is an
    // active-work list. Hide rows carrying the committed reversal marker so the
    // old UI keeps its former "removed after delete" behaviour.
    const where = [
      "NOT EXISTS (SELECT 1 FROM inventory_movements wr WHERE wr.reference_type='waste_reversal' AND wr.reference_id=w.id)",
    ];
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
      id: w.id,
      // v4 — the sequential document number (WST-YYYYMMDD-NNNN) was generated and
      // stored but never returned, so the UI showed the raw internal id instead.
      wasteNumber: w.waste_number || '',
      wasteDate: w.waste_date, reason: w.reason,
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

// A posted waste document is financial evidence: never delete it. This legacy
// DELETE endpoint is retained for UI compatibility, but now performs one
// append-only compensating transaction (stock + lot ledger + GL linkage).
router.delete('/waste-entries/:id', requireCapability('waste.create'), async (req, res) => {
  try {
    const id = req.params.id;
    const actor = (req.user && req.user.username) || 'system';
    const result = await db.withTransaction(async (conn) => {
      const [hdr] = await conn.query('SELECT * FROM waste_entries WHERE id = ? FOR UPDATE', [id]);
      if (!hdr.length) return { status: 404, body: { success: false, error: 'not-found' } };
      const w = hdr[0];

      // This movement is the idempotency marker for zero-value waste too (which
      // legitimately has no journal). It is committed with every other effect.
      const [priorReverse] = await conn.query(
        "SELECT id FROM inventory_movements WHERE reference_type='waste_reversal' AND reference_id=? LIMIT 1 FOR UPDATE",
        [id]
      );
      if (priorReverse.length) {
        const [rj] = await conn.query(
          "SELECT id, journal_number FROM gl_journals WHERE reference_type='WasteEntryReversal' AND reference_id=? ORDER BY created_at DESC LIMIT 1",
          [id]
        );
        return { status: 200, body: {
          success: true, id, reversed: true, replayed: true,
          reversalJournalId: rj[0] ? rj[0].id : null,
          reversalJournalNumber: rj[0] ? rj[0].journal_number : null,
        } };
      }

      const [lines] = await conn.query(
        `SELECT wi.*, i.name AS item_name, COALESCE(i.tracking_mode,'none') AS tracking_mode
           FROM waste_entry_items wi
           LEFT JOIN inv_items i ON i.id=wi.item_id
          WHERE wi.waste_id=? FOR UPDATE`,
        [id]
      );
      if (!lines.length) throw Object.assign(new Error('Waste document has no lines'), { code: 'WASTE_LINES_MISSING' });

      const [originalJournals] = await conn.query(
        "SELECT * FROM gl_journals WHERE reference_type='WasteEntry' AND reference_id=? ORDER BY created_at FOR UPDATE",
        [id]
      );
      if (roundMoney(w.total_cost) > 0 && !originalJournals.length) {
        throw Object.assign(new Error('Waste GL journal is missing; stock was not reversed'), { code: 'WASTE_GL_MISSING' });
      }
      if (originalJournals.some((j) => j.reversed_by_journal_id)) {
        throw Object.assign(new Error('Waste GL is already reversed without its stock marker'), { code: 'WASTE_REVERSAL_CONFLICT' });
      }

      // Tracked items must return to the exact lots consumed by the original
      // waste document. Old malformed documents with no allocation fail closed.
      const tracked = lines.filter((l) => l.tracking_mode === 'lot' || l.tracking_mode === 'expiry');
      if (tracked.length) {
        const expected = new Map();
        for (const l of tracked) expected.set(l.item_id, roundCost((expected.get(l.item_id) || 0) + Number(l.quantity)));
        const [allocRows] = await conn.query(
          `SELECT item_id, SUM(-signed_qty) AS qty
             FROM inventory_lot_movements
            WHERE reference_type='waste' AND reference_id=?
            GROUP BY item_id`,
          [id]
        );
        const actual = new Map(allocRows.map((r) => [r.item_id, roundCost(r.qty)]));
        for (const [itemId, qty] of expected) {
          if (Math.abs((actual.get(itemId) || 0) - qty) > 0.001) {
            throw Object.assign(new Error('Exact lot allocation is missing for tracked waste item ' + itemId), { code: 'WASTE_LOT_HISTORY_MISSING' });
          }
        }
        const lotLedger = require('../lib/lotLedger');
        await lotLedger.reverseAllocation(conn, {
          referenceType: 'waste', referenceId: id, movementSeq: null, movementId: null,
          actor, occurredAt: new Date(),
        });
      }

      for (const l of lines) {
        const qty = Number(l.quantity);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid stored waste quantity');
        const snapshotCost = Math.max(0, Number(l.unit_cost) || 0);
        await conn.query(
          `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost, last_updated)
           VALUES (?,?,?,?,?,?,NOW())
           ON DUPLICATE KEY UPDATE qty=qty+VALUES(qty), last_updated=NOW()`,
          [genId('WS'), w.warehouse_id, l.item_id, qty, snapshotCost, snapshotCost]
        );
        await recomputeInvItemStockStrict(conn, l.item_id);
        await conn.query(
          `INSERT INTO inventory_movements
             (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id)
           VALUES (?,NOW(),?,?,?,?,?,?,?,?,?,?)`,
          [genId('IM'), l.item_id, l.item_name || '', 'in', qty, 'Waste reversal', actor,
           'Reversal of ' + (w.waste_number || id), w.warehouse_id, 'waste_reversal', id]
        );
      }

      if (tracked.length) {
        const lotLedger = require('../lib/lotLedger');
        for (const l of tracked) await lotLedger.assertInvariant(conn, w.warehouse_id, l.item_id);
      }

      const reversalJournals = [];
      for (const original of originalJournals) {
        const [entries] = await conn.query('SELECT * FROM gl_entries WHERE journal_id=? ORDER BY id', [original.id]);
        if (!entries.length) throw new Error('Original waste journal has no entries');
        const post = await gl.postJournal(conn, {
          journalDate: acctDate.journalDate(),
          description: 'Reversal of waste ' + (w.waste_number || id),
          referenceType: 'WasteEntryReversal',
          referenceId: id,
          postedBy: actor,
          entries: entries.map((e) => ({
            accountCode: e.account_code,
            debit: roundMoney(e.credit), credit: roundMoney(e.debit),
            description: 'Reversal: ' + (e.description || ''),
            branchId: e.branch_id || null, brandId: e.brand_id || null,
            costCenterId: e.cost_center_id || null, warehouseId: e.warehouse_id || null,
          })),
        });
        if (!post || !post.success) throw new Error((post && post.error) || 'Waste reversal GL posting failed');
        await conn.query(
          'UPDATE gl_journals SET reversed_by_journal_id=?, reversed_at=NOW(), reversed_by=? WHERE id=?',
          [post.journalId, actor, original.id]
        );
        await conn.query('UPDATE gl_journals SET reverses_journal_id=? WHERE id=?', [original.id, post.journalId]);
        reversalJournals.push({ id: post.journalId, number: post.journalNumber || null });
      }

      return { status: 200, body: {
        success: true, id, reversed: true, reversedLines: lines.length,
        reversalJournalId: reversalJournals[0] ? reversalJournals[0].id : null,
        reversalJournalNumber: reversalJournals[0] ? reversalJournals[0].number : null,
      } };
    });

    res.status(result.status).json(result.body);
  } catch (e) { res.status(500).json({ success:false, error: e.message }); }
});

/**
 * Create a waste entry: deducts warehouse stock, writes an inventory movement,
 * and posts Dr <waste sub-account by reason> / Cr Inventory.
 *
 * v4 HARDENING. This route moves stock AND money and had none of the protections
 * its own DELETE sibling already had:
 *   · NO transaction — a mid-loop failure left a half-written entry with partial
 *     stock deducted and no GL. (The DELETE at :1591 wraps in withTransaction.)
 *   · NO idempotency — genId('WE') is random, so a double-POST created two
 *     entries and deducted stock TWICE.
 *   · NO server-side qty validation — `Number(it.quantity) || 0` on a signed
 *     DECIMAL, so a negative qty INCREMENTED stock and posted a reversed GL
 *     entry. Only the browser enforced min="0".
 *   · created_by came from req.body — a spoofable actor on an audit column.
 *   · NO period-lock check — waste could post into a closed period.
 */
router.post('/waste-entries', requireCapability('waste.create'), async (req, res) => {
  try {
    const { brandId, branchId, warehouseId, costCenterId, wasteDate, reason, notes, items } = req.body || {};
    // v4 SECURITY — actor from the verified token, never from the body.
    const actor = (req.user && req.user.username) || '';
    if (!warehouseId) return res.json({ success: false, error: 'المستودع مطلوب' });
    if (!Array.isArray(items) || !items.length) return res.json({ success: false, error: 'أصناف الهدر مطلوبة' });
    // v7.5 — whitelist the reason: keeps the ENUM honest on non-strict MySQL
    // and guarantees the frontend chip-map fallback never renders raw input.
    const VALID_WASTE_REASONS = ['expired', 'damaged', 'spill', 'prep_loss', 'customer_return', 'other'];
    if (reason && VALID_WASTE_REASONS.indexOf(String(reason)) < 0) {
      return res.json({ success: false, error: 'سبب هدر غير صالح — القيم المسموحة: ' + VALID_WASTE_REASONS.join(', ') });
    }

    // v4 — validate every line BEFORE touching stock. A non-positive or
    // non-numeric qty is a client bug, not a zero.
    for (const it of items) {
      if (!it || !it.itemId) return res.json({ success: false, error: 'كل سطر يحتاج صنفًا' });
      const q = Number(it.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        return res.json({ success: false, error: 'الكمية يجب أن تكون رقمًا أكبر من صفر' });
      }
      // unitCost is deliberately not trusted here. Waste valuation is the
      // warehouse WAC snapshot (falling back to the item master cost), derived
      // under a DB row lock inside the transaction.
    }

    const effectiveDate = wasteDate || new Date().toISOString().slice(0, 10);

    // v4 — waste posts to the GL, so it must respect the period lock like every
    // other posting path. isPeriodClosed fails CLOSED on a DB fault (da47ca5).
    if (await isPeriodClosed(effectiveDate)) {
      return res.json({ success: false, error: 'الفترة المحاسبية مُقفلة لهذا التاريخ — لا يمكن تسجيل هدر فيها' });
    }

    // v4 — idempotency. Without this a retried/double-clicked POST deducted stock
    // twice and posted the GL twice. Callers send X-Idempotency-Key (the same
    // header the POS sync already uses); we return the ORIGINAL result on replay.
    const idemKey = req.get('X-Idempotency-Key') || (req.body && req.body.idempotencyKey) || '';
    if (idemKey) {
      const [prior] = await db.query(
        'SELECT id, total_cost FROM waste_entries WHERE idempotency_key = ? LIMIT 1', [idemKey]);
      if (prior.length) {
        return res.json({ success: true, id: prior[0].id, totalCost: Number(prior[0].total_cost) || 0, replayed: true });
      }
    }

    const id = genId('WE');
    // v7.1 — sequential document number (WST-YYYYMMDD-NNNN)
    let wasteNumber = '';
    try { wasteNumber = await nextDocNumber(db, 'WST'); } catch(_) { wasteNumber = ''; }
    const wasteAccountCode = gl.CORE_ACCOUNTS.WASTE_EXPENSE.code;

    // Header + derived valuation + stock + movements + GL are one transaction.
    // A posting failure is fatal and rolls every preceding stock write back.
    const writeAll = async (conn) => {
      const ids = [...new Set(items.map((it) => String(it.itemId)))];
      // Materialise missing warehouse rows first. The unique-key upsert acquires
      // a row lock, so the WAC used below cannot race an inbound receipt.
      for (const itemId of ids) {
        await conn.query(
          `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty)
           VALUES (?,?,?,0) ON DUPLICATE KEY UPDATE item_id=VALUES(item_id)`,
          [genId('WS'), warehouseId, itemId]
        );
      }
      const [catalog] = await conn.query(
        `SELECT i.id, i.name, i.unit, i.cost, COALESCE(i.tracking_mode,'none') AS tracking_mode,
                ws.avg_cost
           FROM inv_items i
           JOIN warehouse_stock ws ON ws.item_id=i.id AND ws.warehouse_id=?
          WHERE i.id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
        [warehouseId].concat(ids)
      );
      if (catalog.length !== ids.length) {
        const found = new Set(catalog.map((r) => String(r.id)));
        const missing = ids.filter((itemId) => !found.has(itemId));
        throw Object.assign(new Error('Unknown inventory item: ' + missing.join(', ')), { code: 'ITEM_NOT_FOUND' });
      }
      const byId = new Map(catalog.map((r) => [String(r.id), r]));
      const normalized = items.map((it) => {
        const master = byId.get(String(it.itemId));
        const qty = Number(it.quantity);
        const whCost = Number(master.avg_cost);
        const masterCost = Number(master.cost);
        const unitCost = roundCost(whCost > 0 ? whCost : (masterCost > 0 ? masterCost : 0));
        return {
          itemId: String(it.itemId), itemName: master.name || '',
          unit: master.unit || it.unit || 'PCS', quantity: qty, unitCost,
          lineCost: roundMoney(qty * unitCost), trackingMode: master.tracking_mode || 'none',
        };
      });
      const total = roundMoney(normalized.reduce((sum, line) => sum + line.lineCost, 0));

      await conn.query(
        `INSERT INTO waste_entries (id, waste_number, brand_id, branch_id, warehouse_id, cost_center_id, waste_date, reason, total_cost, notes, created_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, wasteNumber || null, brandId||null, branchId||null, warehouseId, costCenterId||null,
         effectiveDate, reason || 'other', total, notes || '', actor, idemKey || null]);

      for (const line of normalized) {
        await conn.query(
          `INSERT INTO waste_entry_items (id, waste_id, item_id, quantity, unit, unit_cost, line_cost)
           VALUES (?,?,?,?,?,?,?)`,
          [genId('WEI'), id, line.itemId, line.quantity, line.unit, line.unitCost, line.lineCost]);

        await deductWarehouseStock(conn, warehouseId, line.itemId, line.quantity, {
          referenceType: 'waste', referenceId: id, reason: 'Waste', actor,
        });
        await recomputeInvItemStockStrict(conn, line.itemId);

        await conn.query(
          `INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [genId('IM'), new Date(), line.itemId, line.itemName, 'out', line.quantity, 'هدر',
           actor, wasteNumber || id, warehouseId, 'waste', id]);
      }

      const trackedIds = [...new Set(normalized.filter((l) => l.trackingMode === 'lot' || l.trackingMode === 'expiry').map((l) => l.itemId))];
      if (trackedIds.length) {
        const lotLedger = require('../lib/lotLedger');
        for (const itemId of trackedIds) await lotLedger.assertInvariant(conn, warehouseId, itemId);
      }

      let post = null;
      if (total > 0) {
        post = await gl.postJournal(conn, {
          journalDate: acctDate.toAccountingDate(effectiveDate),
          description: 'Waste — ' + (reason || 'other'),
          referenceType: 'WasteEntry', referenceId: id, postedBy: actor,
          entries: [
            {
              accountCode: wasteAccountCode, debit: total, credit: 0,
              description: 'Waste cost — ' + (reason || 'other'),
              branchId: branchId || null, brandId: brandId || null,
              costCenterId: costCenterId || null,
            },
            {
              accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: 0, credit: total,
              description: 'Inventory reduction (waste)',
              branchId: branchId || null, brandId: brandId || null,
              warehouseId,
            },
          ],
        });
        if (!post || !post.success) throw new Error((post && post.error) || 'Waste GL posting failed');
      }
      return {
        total, journalId: post ? post.journalId : null,
        journalNumber: post ? post.journalNumber : null,
      };
    };

    try {
      const written = await db.withTransaction(writeAll);
      return res.json({
        success: true, id, totalCost: written.total, wasteNumber: wasteNumber || null,
        journalId: written.journalId, journalNumber: written.journalNumber,
        wasteAccountCode,
      });
    } catch (txErr) {
      // ER_DUP_ENTRY on idempotency_key = a concurrent double-POST lost the race.
      // The winner's entry stands; return it rather than a scary error.
      if (txErr && txErr.code === 'ER_DUP_ENTRY' && idemKey) {
        const [won] = await db.query('SELECT id, total_cost FROM waste_entries WHERE idempotency_key = ? LIMIT 1', [idemKey]);
        if (won.length) return res.json({ success: true, id: won[0].id, totalCost: Number(won[0].total_cost) || 0, replayed: true });
      }
      console.error('[erp/waste-entries] create rolled back:', txErr && (txErr.code || txErr.message));
      return res.status(500).json({ success: false, error: 'تعذّر تسجيل الهدر — لم يُحفظ شيء' });
    }
  } catch (e) {
    console.error('[erp/waste-entries] create failed:', e && (e.code || e.message));
    res.json({ success: false, error: 'تعذّر تسجيل الهدر' });
  }
});

router.get('/waste-entries/:id/items', requireCapability('inventory.view'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT wi.*, i.name AS item_name, i.id AS sku
       FROM waste_entry_items wi LEFT JOIN inv_items i ON wi.item_id = i.id
       WHERE wi.waste_id = ?`, [req.params.id]);
    // (catch below no longer answers [] — see the end of this handler.)
    res.json(rows.map(l => ({
      id: l.id, itemId: l.item_id, itemName: l.item_name || '', sku: l.sku || '',
      quantity: Number(l.quantity), unit: l.unit, unitCost: Number(l.unit_cost),
      lineCost: Number(l.line_cost)
    })));
  } catch (e) {
    // v4 — was `res.json([])`: a DB fault rendered as "this waste entry has no
    // lines", which is indistinguishable from a real (impossible) empty entry.
    console.error('[erp/waste-entries/:id/items] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل أصناف الهدر' });
  }
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

router.post('/purchase-receipts', requireCapability('purchases.create'), async (req, res) => {
  try {
    const body = req.body || {};
    const { poId, supplierId, warehouseId, receiptDate, lines, brandId, branchId, costCenterId } = body;
    const actor = (req.user && req.user.username) || '';
    if (!warehouseId || !Array.isArray(lines) || !lines.length)
      return res.json({ success: false, error: 'المستودع والأسطر مطلوبة' });
    if (typeof req.guardWh === 'function' && !req.guardWh(res, warehouseId)) return;
    for (const line of lines) {
      const qty = Number(line && line.quantity);
      const unitCost = Number(line && line.unitCost);
      const vatRate = line && line.vatRate != null && line.vatRate !== '' ? Number(line.vatRate) : 0;
      if (!line || !line.itemId) return res.json({ success: false, error: 'كل سطر يحتاج صنفًا' });
      if (!Number.isFinite(qty) || qty <= 0) return res.json({ success: false, error: 'كمية الاستلام يجب أن تكون أكبر من صفر' });
      if (!Number.isFinite(unitCost) || unitCost < 0) return res.json({ success: false, error: 'تكلفة الاستلام غير صالحة' });
      if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) return res.json({ success: false, error: 'نسبة الضريبة غير صالحة' });
    }
    const effectiveDate = receiptDate || new Date().toISOString().slice(0, 10);
    if (await isPeriodClosed(effectiveDate)) {
      return res.status(409).json({ success: false, error: 'الفترة المحاسبية مقفلة لهذا التاريخ' });
    }
    const idemKey = req.get('X-Idempotency-Key') || req.get('Idempotency-Key') || body.idempotencyKey || '';
    if (idemKey) {
      const [prior] = await db.query('SELECT id, receipt_number, total, gl_journal_id FROM purchase_receipts WHERE idempotency_key=? LIMIT 1', [idemKey]);
      if (prior.length) return res.json({
        success: true, id: prior[0].id, receiptNumber: prior[0].receipt_number,
        total: Number(prior[0].total) || 0, journalId: prior[0].gl_journal_id || null, replayed: true,
      });
    }
    const id = genId('PR');
    let rcpNumber = '';
    try { rcpNumber = await nextDocNumber(db, 'GRN'); } catch (_) { rcpNumber = genId('GRN'); }

    try {
      const written = await db.withTransaction(async (conn) => {
        const normalized = [];
        let subtotal = 0;
        let vat = 0;
        for (const raw of lines) {
          const qty = roundCost(raw.quantity);
          const unitCost = roundCost(raw.unitCost);
          const vatRate = raw.vatRate != null && raw.vatRate !== '' ? roundCost(raw.vatRate) : 0;
          const [itemsFound] = await conn.query(
            "SELECT id, name, unit, stock, cost, COALESCE(tracking_mode,'none') AS tracking_mode FROM inv_items WHERE id=? FOR UPDATE",
            [raw.itemId]
          );
          if (!itemsFound.length) throw Object.assign(new Error('Unknown inventory item: ' + raw.itemId), { code: 'ITEM_NOT_FOUND' });
          const item = itemsFound[0];

          let poLine = null;
          if (raw.poLineId) {
            const [poLines] = await conn.query(
              'SELECT id, po_id, item_id, qty, received_qty, base_qty, base_received_qty FROM po_lines WHERE id=? FOR UPDATE',
              [raw.poLineId]
            );
            if (!poLines.length) throw Object.assign(new Error('Purchase-order line not found'), { code: 'PO_LINE_NOT_FOUND' });
            poLine = poLines[0];
            if (poId && String(poLine.po_id) !== String(poId)) throw new Error('Receipt line belongs to another purchase order');
            if (poLine.item_id && String(poLine.item_id) !== String(raw.itemId)) throw new Error('Receipt item does not match purchase-order line');
            const hasBase = poLine.base_qty != null && Number(poLine.base_qty) > 0;
            const ordered = Number(hasBase ? poLine.base_qty : poLine.qty) || 0;
            const received = Number(hasBase ? poLine.base_received_qty : poLine.received_qty) || 0;
            if (ordered > 0 && received + qty - ordered > 0.000001) {
              throw Object.assign(new Error('Received quantity exceeds the open purchase-order quantity'), { code: 'OVER_RECEIPT' });
            }
          }

          const lineNet = roundMoney(qty * unitCost);
          const lineVat = roundMoney(lineNet * vatRate / 100);
          subtotal = roundMoney(subtotal + lineNet);
          vat = roundMoney(vat + lineVat);
          normalized.push({
            raw, item, poLine, qty, unitCost, vatRate, lineNet, lineVat,
            lineId: genId('PRL'), itemName: item.name || '', unit: item.unit || raw.unit || 'PCS',
          });
        }
        const total = roundMoney(subtotal + vat);

        await conn.query(
          `INSERT INTO purchase_receipts
             (id, po_id, supplier_id, receipt_number, receipt_date, warehouse_id,
              brand_id, branch_id, cost_center_id, subtotal, vat_amount, total,
              status, version, created_by, posted_by, posted_at, idempotency_key)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'posted',1,?,?,NOW(),?)`,
          [id, poId || null, supplierId || null, rcpNumber, effectiveDate, warehouseId,
           brandId || null, branchId || null, costCenterId || null,
           subtotal, vat, total, actor, actor, idemKey || null]
        );

        const affectedItems = [];
        for (const line of normalized) {
          await conn.query(
            `INSERT INTO purchase_receipt_lines
               (id, receipt_id, po_line_id, item_id, item_name, quantity, unit, unit_cost,
                vat_rate, line_total, entered_qty, entered_unit_code,
                conversion_factor_snapshot, base_qty, base_unit_cost, warehouse_id,
                lot_no, expiry_date)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
            [line.lineId, id, line.raw.poLineId || null, line.raw.itemId, line.itemName,
             line.qty, line.unit, line.unitCost, line.vatRate, line.lineNet,
             line.qty, line.unit, line.qty, line.unitCost, warehouseId,
             line.raw.lotNo || line.raw.lot_no || null,
             line.raw.expiryDate || line.raw.expiry_date || null]
          );

          await conn.query(
            `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost, last_updated)
             VALUES (?,?,?,0,0,0,NOW()) ON DUPLICATE KEY UPDATE item_id=VALUES(item_id)`,
            [genId('WS'), warehouseId, line.raw.itemId]
          );
          const [stockRows] = await conn.query(
            'SELECT id, qty, avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=? FOR UPDATE',
            [warehouseId, line.raw.itemId]
          );
          // A receipt can contain the same item more than once. Re-read its
          // current locked roll-up so each line builds on the prior line's WAC.
          const [currentItems] = await conn.query(
            "SELECT stock, cost, COALESCE(tracking_mode,'none') AS tracking_mode FROM inv_items WHERE id=? FOR UPDATE",
            [line.raw.itemId]
          );
          const currentItem = currentItems[0];
          const stock = stockRows[0];
          const oldWhQty = Number(stock.qty) || 0;
          const oldWhCost = Number(stock.avg_cost) > 0 ? Number(stock.avg_cost) : (Number(currentItem.cost) || line.unitCost);
          const whValue = Math.max(0, oldWhQty) * oldWhCost;
          const newWhQty = roundCost(oldWhQty + line.qty);
          const newWhCost = roundCost((whValue + line.qty * line.unitCost) / (Math.max(0, oldWhQty) + line.qty));

          const oldGlobalQty = Number(currentItem.stock) || 0;
          const oldGlobalCost = Number(currentItem.cost) || line.unitCost;
          const globalValue = Math.max(0, oldGlobalQty) * oldGlobalCost;
          const newGlobalCost = roundCost((globalValue + line.qty * line.unitCost) / (Math.max(0, oldGlobalQty) + line.qty));
          await conn.query(
            'UPDATE warehouse_stock SET qty=?, avg_cost=?, last_cost=?, last_updated=NOW() WHERE id=?',
            [newWhQty, newWhCost, line.unitCost, stock.id]
          );

          const mode = String(currentItem.tracking_mode || 'none');
          if (mode === 'lot' || mode === 'expiry') {
            const lotLedger = require('../lib/lotLedger');
            await lotLedger.receiveInbound(conn, {
              warehouseId, itemId: line.raw.itemId, qty: line.qty, trackingMode: mode,
              movementSeq: null, movementId: null, referenceType: 'PurchaseReceipt', referenceId: id,
              reason: 'Purchase receipt', actor, occurredAt: new Date(), now: new Date(),
              lot: {
                lotNumber: line.raw.lotNo || line.raw.lot_no || null,
                expiryDate: line.raw.expiryDate || line.raw.expiry_date || null,
                manufactureDate: line.raw.manufactureDate || line.raw.manufacture_date || null,
                unitCost: line.unitCost, sourceType: 'PurchaseReceipt', sourceId: id,
              },
            });
            await lotLedger.assertInvariant(conn, warehouseId, line.raw.itemId);
          }

          await recomputeInvItemStockStrict(conn, line.raw.itemId);
          await conn.query('UPDATE inv_items SET cost=? WHERE id=?', [newGlobalCost, line.raw.itemId]);
          await conn.query(
            `INSERT INTO inventory_movements
               (id, movement_date, item_id, item_name, type, qty, reason, username,
                notes, warehouse_id, reference_type, reference_id)
             VALUES (?,NOW(),?,?,?,?,?,?,?,?,?,?)`,
            [genId('IM'), line.raw.itemId, line.itemName, 'in', line.qty, 'Purchase receipt',
             actor, rcpNumber, warehouseId, 'PurchaseReceipt', id]
          );

          const [lot] = await conn.query(
            `INSERT INTO purchase_lots
               (inv_item_id, purchase_id, received_date, qty_received, qty_remaining,
                unit_cost, batch_number, expiry_date, warehouse_id, received_at)
             VALUES (?,?,NOW(),?,?,?,?,?,?,NOW())`,
            [line.raw.itemId, poId || id, line.qty, line.qty, line.unitCost,
             line.raw.lotNo || line.raw.lot_no || null,
             line.raw.expiryDate || line.raw.expiry_date || null, warehouseId]
          );
          await conn.query('UPDATE purchase_receipt_lines SET purchase_lot_id=? WHERE id=?', [lot.insertId, line.lineId]);

          if (line.poLine) {
            await conn.query(
              `UPDATE po_lines
                  SET received_qty=COALESCE(received_qty,0)+?,
                      base_received_qty=COALESCE(base_received_qty,0)+?,
                      line_status=CASE WHEN COALESCE(base_received_qty,0)+? >= COALESCE(base_qty,qty)
                                       THEN 'received' ELSE 'partially_received' END
                WHERE id=?`,
              [line.qty, line.qty, line.qty, line.poLine.id]
            );
          }
          affectedItems.push({ itemId: line.raw.itemId, qty: line.qty, unitCost: line.unitCost, newQty: newWhQty, avgCost: newWhCost });
        }

        if (poId) {
          const [remaining] = await conn.query(
            'SELECT COUNT(*) AS c FROM po_lines WHERE po_id=? AND COALESCE(base_received_qty,received_qty,0) < COALESCE(base_qty,qty,0)',
            [poId]
          );
          await conn.query(
            "UPDATE purchase_orders SET status=? WHERE id=? AND status NOT IN ('closed','cancelled')",
            [Number(remaining[0].c) === 0 ? 'fully_received' : 'partially_received', poId]
          );
        }

        let post = null;
        if (total > 0) {
          const entries = [{
            accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: subtotal, credit: 0,
            description: 'Goods received — ' + rcpNumber,
            branchId: branchId || null, brandId: brandId || null,
            costCenterId: costCenterId || null, warehouseId,
          }];
          if (vat > 0) entries.push({
            accountCode: gl.CORE_ACCOUNTS.INPUT_VAT.code, debit: vat, credit: 0,
            description: 'Input VAT — ' + rcpNumber,
            branchId: branchId || null, brandId: brandId || null,
            costCenterId: costCenterId || null,
          });
          entries.push({
            accountCode: gl.CORE_ACCOUNTS.AP.code, debit: 0, credit: total,
            description: 'Supplier liability — ' + rcpNumber,
            branchId: branchId || null, brandId: brandId || null,
            costCenterId: costCenterId || null,
            partyType: supplierId ? 'supplier' : null, partyId: supplierId || null,
          });
          post = await gl.postJournal(conn, {
            journalDate: acctDate.toAccountingDate(effectiveDate),
            description: 'Purchase receipt ' + rcpNumber,
            referenceType: 'PurchaseReceipt', referenceId: id, entries, postedBy: actor,
          });
          if (!post || !post.success) throw new Error((post && post.error) || 'Purchase receipt GL posting failed');
          await conn.query('UPDATE purchase_receipts SET gl_journal_id=? WHERE id=?', [post.journalId, id]);
        }
        return {
          subtotal, vat, total, affectedItems,
          journalId: post ? post.journalId : null,
          journalNumber: post ? post.journalNumber : null,
        };
      });

      return res.json({
        success: true, id, receiptNumber: rcpNumber, total: written.total,
        subtotal: written.subtotal, vatAmount: written.vat,
        affectedItems: written.affectedItems,
        journalId: written.journalId, journalNumber: written.journalNumber,
      });
    } catch (txErr) {
      if (txErr && txErr.code === 'ER_DUP_ENTRY' && idemKey) {
        const [won] = await db.query('SELECT id, receipt_number, total, gl_journal_id FROM purchase_receipts WHERE idempotency_key=? LIMIT 1', [idemKey]);
        if (won.length) return res.json({
          success: true, id: won[0].id, receiptNumber: won[0].receipt_number,
          total: Number(won[0].total) || 0, journalId: won[0].gl_journal_id || null, replayed: true,
        });
      }
      console.error('[erp/purchase-receipts] create rolled back:', txErr && (txErr.code || txErr.message));
      return res.status(422).json({ success: false, error: txErr.message || 'تعذّر تسجيل الاستلام — لم يُحفظ شيء', code: txErr.code || undefined });
    }
  } catch(e) {
    console.error('[erp/purchase-receipts] create failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: e.message });
  }
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
 * GET /erp/reports/trial-balance?from=&to=&branch=&brand=&costCenter=&warehouse=&includeZero=
 *   Returns every account with opening balance, period movement (debit/credit),
 *   and closing balance. Filters by dimensions if provided.
 *   Ledger ownership is fixed to CO-MAIN. companyId is accepted only so an
 *   explicit non-CO-MAIN attempt can fail visibly; it is not a selector.
 *
 * Tier A (COA/Trial Balance overhaul) — delegates to the canonical engine in
 * lib/reports/trialBalance.js instead of the inline logic that used to live
 * here. See docs/adr/0002-chart-of-accounts-trial-balance.md section 6 for
 * why this file (not routes/erp/reports/trial-balance.js) stays the single
 * live endpoint. Response shape is additive-only versus the old inline
 * version — every field the frontend (frontend/erp/src/modules/accounting/
 * api.ts) already reads is still present with the same meaning; new fields
 * (openDebit/openCredit/closeDebit/closeCredit/abnormalSign/diagnostics/...)
 * are new additions, not renames.
 */
router.get('/reports/trial-balance', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { from, to, branch, brand, costCenter, warehouse, includeZero, companyId } = req.query;
    // Tier A.3 Release Gate item 7 — req.guardWh() shadow-logs instead of
    // blocking when WAREHOUSE_SCOPE_ENFORCE is off, a deliberate rollout
    // mechanism for the BROADER warehouse-ops routes (stock movements,
    // transfers, ...) that is the wrong default for a FINANCIAL REPORT:
    // a caller with no access to warehouse X should never be able to read
    // X's trial balance just because the ops-rollout flag hasn't been
    // flipped yet. Checked directly against req.warehouseScope (populated
    // by middleware/warehouseScope.js regardless of ENFORCE) using the
    // same lib/warehouseScope.js#hasWarehouseAccess every other guard
    // ultimately calls — always enforced here, no shadow mode, whatever
    // the global flag says.
    if (warehouse && req.warehouseScope && !warehouseScopeLib.hasWarehouseAccess(req.warehouseScope, warehouse)) {
      return res.status(403).json({ success: false, code: 'WAREHOUSE_ACCESS_DENIED', error: warehouseScopeLib.ACCESS_DENIED_MSG });
    }
    const result = await trialBalanceEngine.computeTrialBalance(db, {
      from, to, branch, brand, costCenter, warehouse, companyId,
      includeZero: includeZero === '1' || includeZero === 'true',
    });
    res.json(result);
  } catch (e) {
    if (e instanceof trialBalanceEngine.TrialBalanceError) {
      // Tier A.1 corrective fix — status carried on the error itself (400 for
      // bad input, 409 SCHEMA_NOT_READY for an unsupported dimension filter).
      return res.status(e.status || 400).json({ success: false, code: e.code, error: e.message, rows: [], totals: {} });
    }
    // Tier A.1 corrective fix — an unexpected/DB error used to return HTTP 200
    // with success:false, which every naive `res.ok`/`status < 400` caller
    // (including this endpoint's own frontend consumer) would treat as a
    // successful-but-empty report instead of a failure. Never do that for a
    // financial report: unified {success:false, code, error} envelope, 500.
    // Tier A.2 — the real error (e.message) never reaches the client on a
    // 500; only a fixed, generic message does. console.error still carries
    // the full error for the server-side log.
    console.error('[trial-balance] unexpected error', e);
    res.status(500).json({ success: false, code: 'TB_INTERNAL_ERROR', error: 'تعذّر إنشاء ميزان المراجعة — خطأ داخلي في الخادم', rows: [], totals: {} });
  }
});

/**
 * GET /erp/reports/pnl?from=&to=&branch=&brand=&costCenter=&groupBy=
 *   Revenue − Expenses = Net Profit. Accounts hierarchy is respected
 *   (shows detail + group totals).
 *   groupBy: 'account' (default) | 'type' | 'brand' | 'branch' | 'cost_center'
 */
router.get('/reports/pnl', requireCapability('finance.reports.view'), async (req, res) => {
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
        `SELECT id, code, name_ar, type FROM gl_accounts a
          WHERE is_active = 1 AND type IN ('revenue','expense')
          ORDER BY ${coaTree.ORDER_BY('a')}`
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
router.get('/reports/balance-sheet', requireCapability('finance.reports.view'), async (req, res) => {
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
router.get('/reports/profitability', requireCapability('finance.reports.view'), async (req, res) => {
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
  } catch(e) {
    // was `res.json({success:false, rows:[]})` with 200 — a DB fault
    // rendered as an empty profitability report. Honest now.
    console.error('[erp/reports/profitability] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر توليد تقرير الربحية' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// EXTENDED REPORTS — Aging / Inventory / Sales / Waste / Royalty
// ═══════════════════════════════════════════════════════════════════════

// Statement of Changes in Equity (IAS 1) — first real backend for this
// report (the legacy screen synthesized it client-side from stale code
// prefixes). Sub-router; reconciles against /reports/balance-sheet-ifrs
// (routes/erp/reports/balance-sheet.js) and requires finance.reports.view.
router.use(require('./erp/reports/equity-changes'));

//
// v5.11.13 — The legacy GET /reports/cash-flow endpoint was removed.
// It hardcoded cash/bank account codes ('1110','1120') that don't exist
// in the v5.11.8 IFRS template (real cash codes start with 111x). The
// IAS 7 indirect-method endpoint /reports/cash-flow-ias7 in routes/erp.js
// is what the frontend calls — that one reads dynamically from
// gl_accounts and is fully aligned with the current chart.

// ── RETIRED (rationalization doc §2.2, inverted decision executed) ─────────
// The legacy GET /reports/ar-aging + /reports/ap-aging handlers that lived here
// (GL-account 1150/2100 buckets, asOf param, {asOf,totals,items} shape) were
// DELETED so the modular routers routes/erp/reports/{ar,ap}-aging.js — mounted
// in server.js AFTER this router and previously UNREACHABLE (shadowed by these
// handlers) — now answer. Their contract ({asOfDate, customers/suppliers,
// grandTotal, grandBuckets 0-30..120+}) is what the live /accounting/{ar,ap}-aging
// pages were built against (frontend AgingResponse). Proven by
// tests/integration/retiredSurfaces.api.test.js.

/**
 * GET /erp/reports/inventory-valuation?warehouse=&brand=
 * Shows current stock × avg_cost per item, grouped by warehouse.
 */
router.get('/reports/inventory-valuation', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { warehouse, brand } = req.query;
    // Schema probe (documented): warehouse_stock only exists on installs
    // that ran the per-warehouse migration — older deploys value
    // inv_items.stock directly. SHOW TABLES throws only when the DB itself
    // is broken; that now surfaces as a 500 from the outer catch instead
    // of silently degrading to the legacy path.
    const [t] = await db.query("SHOW TABLES LIKE 'warehouse_stock'");
    const hasWS = !!t.length;

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
      // The valuation basis is the item-master cost (inv_items.cost /
      // menu.cost) — a static card figure, NOT a moving/weighted average
      // recomputed from receipts. Named explicitly so nobody reads the
      // `avgCost` field as WAC.
      costBasis: 'item_cost',
      note: 'القيمة محسوبة على تكلفة الصنف في بطاقة الصنف (وليست متوسطاً متحركاً مرجّحاً بحركات الاستلام)',
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
  } catch(e) {
    // was `res.json({success:false, items:[]})` with 200 — a DB fault
    // rendered as an empty warehouse. Honest now.
    console.error('[erp/reports/inventory-valuation] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر توليد تقرير تقييم المخزون' });
  }
});

// ── RETIRED (Unified Sales Analytics Hub — retirement commit) ───────────────
// Six report endpoints were DELETED here per docs/status/SALES_REPORTS_RATIONALIZATION_AR.md:
// (paths spelled here as /reports/<name> without their literal strings — the
//  retired-surfaces audit greps this tree for the exact retired paths):
//   · sales‑analytics         → POST /api/analytics/query (the hub engine;
//     equations re-asserted in tests/integration/reportsEquations.api.test.js)
//   · sales‑by‑channel        → hub channels page (orphan: zero consumers)
//   · channel‑settlements     → hub channels page (orphan)
//   · discounts‑given         → hub discounts page (orphan)
//   · waste‑analytics         → deferred to a future inventory reports hub (orphan)
//   · royalty‑reconciliation  → live /accounting/royalties screen (orphan).
//     NOTE: _royaltyBase (defined ~line 1465) was NEVER part of that handler — it is
//     the heart of the LIVE royalty compute (POST /erp/royalty-runs/compute) and stays.
// Every deleted path now 404s — asserted in tests/integration/retiredSurfaces.api.test.js;
// residual references are policed by scripts/audit/retired-surfaces-report.js (gate step).

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
