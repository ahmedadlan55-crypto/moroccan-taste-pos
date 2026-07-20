const router = require('express').Router();
const db = require('../db/connection');
const { isTruthy } = require('../lib/settingsKeys');
// v7.1 SECURITY — the global /api guard (server.js) blanket-exempts /menu so the
// POS can READ the menu without a token. That left every menu WRITE (create/edit/
// delete/price/import/recipes) fully public. Re-verify the JWT on writes only;
// GET routes stay public so the cashier/login flow is unaffected.
const verifyToken = require('./authMiddleware');
// v7.4 — menu writes are pricing/tax-sensitive → managers/admins only (chained
// AFTER verifyToken, which sets req.user since the global /api gate skips /menu).
const MGR = verifyToken.requireRole('admin', 'manager');

// close/d-images — product image write validation. Storage stays a base64
// data-URL in menu.image_data (legacy-compatible, no new infra), but the write
// is no longer free-form: the ERP client downscales to ≤512px JPEG q0.8 before
// saving, so a decoded payload over 300KB — or anything that is not a
// JPEG/PNG/WebP data-URL — is a bug or abuse, never a legitimate save.
// '' (and null) still clear the image; absent leaves it untouched (PUT).
// bilingual-i18n-images (Owner C) — extracted into lib/imageValidation.js so
// routes/product-images.js (bulk image API) can reuse the exact same contract
// instead of a second, potentially-drifting copy. Pure move, zero behavior change.
const { IMAGE_MAX_BYTES, IMAGE_DATA_URL_RE, imageDataError } = require('../lib/imageValidation');

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
    minStockAlert: Number(m.min_stock_alert) || 0,
    // v5.10.16 — units + batch yield
    unit: m.unit || null,
    bigUnit: m.big_unit || null,
    convRate: Number(m.conv_rate) || 1,
    yieldQuantity: Number(m.yield_quantity) || 1,
    yieldUnit: m.yield_unit || null,
    // v5.12.7 — optional product image (base64 data URL)
    imageData: m.image_data || null,
    // v6.20.0 — is the stored `price` already tax-inclusive (legacy/default)
    // or net of tax (new owner preference)?  The frontend uses this to
    // decide whether to display the price as-is or multiply by (1+VAT).
    // Legacy rows default to true (preserves pre-v6.20.0 behavior).
    isTaxInclusive: m.is_tax_inclusive === null || typeof m.is_tax_inclusive === 'undefined'
      ? true
      : !!Number(m.is_tax_inclusive),
    // Combos (العروض) — this menu row is a combo/offer with a variable choice.
    // The POS opens a chooser modal on tap and expands it into its component
    // recipes at sale time. Definition lives in combo_groups/combo_group_items.
    isCombo: !!m.is_combo
  };
}

// v5.14.6 — "Incomplete product" = is_semi_finished = 1.
// Semi-finished items are intermediate products (output of production
// orders, consumed by finished items). They are NOT sellable from the
// cashier — they belong to the kitchen / production flow only. Hide
// them from the default /api/menu and /init responses. Admin still
// sees them via /menu/all and the dedicated /menu/semi-finished
// endpoint. Items WITHOUT a recipe are NOT touched — those are simply
// finished items the owner hasn't priced ingredients for yet.
const HIDE_INCOMPLETE_FRAGMENT = ' AND (m.is_semi_finished IS NULL OR m.is_semi_finished = 0)';

// Get all menu items (active only). Optional ?brandId= and ?type= filter (finished|semi|all).
// v5.10.28 — Restore the v5.14.6 default of HIDING semi-finished items.
// The intermediate v5.16.4 revert was a band-aid for a one-off data
// hygiene incident (every item accidentally flagged). With correct data,
// semi-finished items belong to the production flow only and must NOT
// appear in the cashier menu. The owner spotted them leaking through.
// Override with ?type=all or ?includeSemi=1 if you genuinely need both.
router.get('/', async (req, res) => {
  try {
    const { brandId, type, includeSemi } = req.query;
    let sql = 'SELECT m.*, b.name AS brand_name FROM menu m LEFT JOIN brands b ON b.id = m.brand_id WHERE m.active = 1 AND COALESCE(m.is_deleted,0) = 0';
    const params = [];
    if (brandId) { sql += ' AND m.brand_id = ?'; params.push(brandId); }
    if (type === 'semi') {
      sql += ' AND m.is_semi_finished = 1';
    } else if (type === 'all' || includeSemi === '1') {
      // Explicit "give me everything" — leave the filter off.
    } else {
      // Default + ?type=finished both hide semi-finished items.
      sql += HIDE_INCOMPLETE_FRAGMENT;
    }
    sql += ' ORDER BY m.category, m.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapMenu));
  } catch (e) { res.json([]); }
});
router.HIDE_INCOMPLETE_FRAGMENT = HIDE_INCOMPLETE_FRAGMENT;

// Get all menu items (including inactive)
// v5.10.28 — Same hide-by-default policy as GET /. Admin menu/management
// pages that genuinely need both finished + semi-finished pass ?type=all.
router.get('/all', async (req, res) => {
  try {
    const { brandId, type, includeSemi, includeDeleted } = req.query;
    let sql = 'SELECT m.*, b.name AS brand_name FROM menu m LEFT JOIN brands b ON b.id = m.brand_id WHERE 1=1';
    const params = [];
    // v7.4 — soft-deleted rows (is_deleted=1) must NOT resurface in the admin
    // list. Without this, deleting a product showed "تم الحذف" but the row came
    // straight back on the next reload (delete looked broken). Opt out with
    // ?includeDeleted=1 if a tool ever needs the tombstones.
    if (includeDeleted !== '1') sql += ' AND COALESCE(m.is_deleted,0) = 0';
    if (brandId) { sql += ' AND m.brand_id = ?'; params.push(brandId); }
    if (type === 'semi') {
      sql += ' AND m.is_semi_finished = 1';
    } else if (type === 'all' || includeSemi === '1') {
      // No filter.
    } else {
      sql += ' AND (m.is_semi_finished IS NULL OR m.is_semi_finished = 0)';
    }
    sql += ' ORDER BY m.category, m.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapMenu));
  } catch (e) { res.json([]); }
});

// Get only semi-finished products (helper endpoint for production/sales pages)
// v6.5.0 — Semi-finished items now live exclusively in inv_items
// (kind='semi'). This endpoint becomes a thin proxy to the unified source
// so legacy callers keep working against the new source of truth. The
// recipeCount + consumerCount fields are computed against the recipe
// table (which is the only consumer-link surface after v6.5.0).
router.get('/semi-finished', async (req, res) => {
  try {
    const { brandId } = req.query;
    let sql = `
      SELECT i.id, i.name, i.category, i.cost, i.stock, i.min_stock,
             i.unit, i.big_unit, i.conv_rate, i.brand_id,
             b.name AS brand_name,
             (SELECT COUNT(*) FROM recipe r WHERE r.inv_item_id = i.id) AS consumer_count
        FROM inv_items i
        LEFT JOIN brands b ON b.id = i.brand_id
       WHERE i.kind = 'semi' AND COALESCE(i.active, 1) = 1`;
    const params = [];
    if (brandId) { sql += ' AND i.brand_id = ?'; params.push(brandId); }
    sql += ' ORDER BY i.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      nameEn: null,
      category: r.category,
      cost: Number(r.cost) || 0,
      stock: Number(r.stock) || 0,
      minStock: Number(r.min_stock) || 0,
      unit: r.unit,
      bigUnit: r.big_unit,
      convRate: Number(r.conv_rate) || 1,
      brandId: r.brand_id,
      brandName: r.brand_name,
      // Back-compat keys that callers expect
      isSemiFinished: true,
      productionUnit: r.unit || 'pcs',
      consumerCount: Number(r.consumer_count || 0),
      recipeCount: 0,
      hasBom: false
    })));
  } catch (e) {
    // Fallback if inv_items.kind column is missing (very old schema):
    // return empty array rather than crashing the production page.
    res.json([]);
  }
});

// Add menu item
router.post('/', verifyToken, MGR, async (req, res) => {
  try {
    const {
      name, nameEn, price, category, cost, stock, minStock, active, pricingMode, markupPct, brandId,
      isSemiFinished, productionUnit, consumesSemiId, consumesSemiQty,
      productionWarehouseId, salesWarehouseId,
      // v5.10.16 — units + batch yield
      unit, bigUnit, convRate, yieldQuantity, yieldUnit,
      // v5.12.7 — optional product image (base64 data URL)
      imageData
    } = req.body;
    // v6.5.0 — Semi-finished items live in inv_items now (kind='semi').
    // Reject new writes that try to flag a menu row as semi; redirect the
    // caller to the unified inventory editor. Existing menu rows that are
    // still flagged are migrated at startup (see server.js runMigrations
    // → unifySemiFinishedInventory block).
    if (isSemiFinished) {
      return res.status(410).json({
        success: false,
        error: 'semi-finished-moved-to-inv-items',
        message: 'المُكوِّنات النِّصف مَصنوعة لم تَعُد تُنشَأ في المنيو. أنشئها كمادَّة من المَواد الخام مع kind=semi.',
        hint: 'POST /api/inventory/items with { kind: "semi", ... }',
        redirectTo: '/erp#inv-items?kind=semi'
      });
    }
    const id = 'MENU-' + Date.now();
    // v6.20.0 — taxInclusive flag.  Frontend sends true/false; if absent,
    // fall back to the new-products default in settings.NewProductsTaxInclusive.
    let taxInclusive = req.body.taxInclusive;
    if (typeof taxInclusive === 'undefined') {
      try {
        const [rows] = await db.query(
          "SELECT setting_value FROM settings WHERE setting_key = 'NewProductsTaxInclusive' LIMIT 1"
        );
        // Tolerant read: a === '1' comparison silently ignored the "true" the
        // React admin wrote, so this failed OPEN — new products were priced
        // tax-exclusive while the owner had asked for inclusive.
        taxInclusive = rows.length ? isTruthy(rows[0].setting_value) : false;
      } catch (_) { taxInclusive = false; }
    }
    // v7.1 — ZATCA tax category (S=standard 15%, Z=zero, E=exempt, O=out-of-scope)
    let taxCategory = String(req.body.taxCategory || 'S').toUpperCase();
    if (['S','Z','E','O'].indexOf(taxCategory) < 0) taxCategory = 'S';
    // v7.1 — reject negative price/cost (0 allowed: free item / not-yet-costed).
    if (Number(price) < 0 || Number(cost) < 0) {
      return res.status(400).json({ success: false, error: 'السعر والتكلفة لا يمكن أن يكونا بالسالب' });
    }
    // close/d-images — malformed/oversized product images are refused, not stored.
    const _imgErr = imageDataError(imageData);
    if (_imgErr) return res.status(400).json({ success: false, error: _imgErr });
    await db.query(
      `INSERT INTO menu (id, name, name_en, price, is_tax_inclusive, tax_category, category, cost, stock, min_stock, active, pricing_mode, markup_pct, brand_id,
                         is_semi_finished, production_unit, consumes_semi_id, consumes_semi_qty,
                         production_warehouse_id, sales_warehouse_id,
                         unit, big_unit, conv_rate, yield_quantity, yield_unit, image_data)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, nameEn || null, price || 0, taxInclusive ? 1 : 0, taxCategory,
       category || 'عام', cost || 0, stock || 0, minStock || 0, active !== false,
       pricingMode || 'fixed', markupPct || 30, brandId || null,
       isSemiFinished ? 1 : 0, productionUnit || 'pcs', consumesSemiId || null, consumesSemiQty || 0,
       productionWarehouseId || null, salesWarehouseId || null,
       unit || null, bigUnit || null, Number(convRate) || 1,
       Number(yieldQuantity) || 1, yieldUnit || null,
       imageData || null]
    );
    res.json({ success: true, id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update menu item
router.put('/:id', verifyToken, MGR, async (req, res) => {
  try {
    const {
      name, nameEn, price, category, cost, stock, minStock, active, pricingMode, markupPct, brandId,
      isSemiFinished, productionUnit, consumesSemiId, consumesSemiQty,
      productionWarehouseId, salesWarehouseId,
      // v5.10.16 — units + batch yield
      unit, bigUnit, convRate, yieldQuantity, yieldUnit,
      // v5.12.7 — optional product image (base64 data URL); '' clears it
      imageData
    } = req.body;
    // v6.5.0 — Reject attempts to flag an existing menu row as semi.
    // Operators editing a previously-semi item should manage it from the
    // inv_items editor instead (the migration created an INV-SEMI-* row
    // for every legacy semi at first boot of v6.5.0).
    if (isSemiFinished) {
      return res.status(410).json({
        success: false,
        error: 'semi-finished-moved-to-inv-items',
        message: 'هذا الصَّنف من نَوع نِصف مَصنوع — يُدار من قِسم المَواد الخام (kind=semi)، لا من المنيو.',
        redirectTo: '/erp#inv-items?kind=semi'
      });
    }
    // v7.1 — reject negative price/cost (0 allowed). Mirrors the POST guard.
    if (Number(price) < 0 || Number(cost) < 0) {
      return res.status(400).json({ success: false, error: 'السعر والتكلفة لا يمكن أن يكونا بالسالب' });
    }
    // close/d-images — malformed/oversized product images are refused, not stored.
    // Runs BEFORE any write; '' still clears and absent still leaves untouched.
    const _imgErr = imageDataError(imageData);
    if (_imgErr) return res.status(400).json({ success: false, error: _imgErr });
    // Price is ALWAYS manual (user sets it). pricing_mode only controls
    // whether the COST comes from recipes (variable) or manual input (fixed).
    // v5.12.7 — image_data is left untouched when undefined; explicit '' clears.
    // v6.20.0 — taxInclusive is left untouched when undefined (preserves
    // legacy rows); explicit true/false overrides.
    const setImage = (typeof imageData !== 'undefined');
    const setTaxIncl = (typeof req.body.taxInclusive !== 'undefined');
    // v7.1 — tax_category, only updated when explicitly provided
    const setTaxCat = (typeof req.body.taxCategory !== 'undefined');
    let _taxCat = String(req.body.taxCategory || 'S').toUpperCase();
    if (['S','Z','E','O'].indexOf(_taxCat) < 0) _taxCat = 'S';
    const sql =
      `UPDATE menu SET name=?, name_en=?, price=?, category=?, cost=?, stock=?, min_stock=?, active=?,
                       pricing_mode=COALESCE(?, pricing_mode), markup_pct=?, brand_id=?,
                       is_semi_finished=?, production_unit=?, consumes_semi_id=?, consumes_semi_qty=?,
                       production_warehouse_id=?, sales_warehouse_id=?,
                       unit=?, big_unit=?, conv_rate=?, yield_quantity=?, yield_unit=?` +
      (setImage ? ', image_data=?' : '') +
      (setTaxIncl ? ', is_tax_inclusive=?' : '') +
      (setTaxCat ? ', tax_category=?' : '') +
      ` WHERE id=?`;
    const params = [name, nameEn || null, price || 0, category, cost || 0, stock, minStock, active, pricingMode || null, markupPct || 0,
       brandId || null,
       isSemiFinished ? 1 : 0, productionUnit || 'pcs', consumesSemiId || null, consumesSemiQty || 0,
       productionWarehouseId || null, salesWarehouseId || null,
       unit || null, bigUnit || null, Number(convRate) || 1,
       Number(yieldQuantity) || 1, yieldUnit || null];
    if (setImage) params.push(imageData || null);
    if (setTaxIncl) params.push(req.body.taxInclusive ? 1 : 0);
    if (setTaxCat) params.push(_taxCat);
    params.push(req.params.id);
    const [result] = await db.query(sql, params);
    if (result.affectedRows === 0) {
      await db.query(
        `INSERT INTO menu (id, name, name_en, price, category, cost, stock, min_stock, active, pricing_mode, markup_pct, brand_id,
                           is_semi_finished, production_unit, consumes_semi_id, consumes_semi_qty,
                           production_warehouse_id, sales_warehouse_id,
                           unit, big_unit, conv_rate, yield_quantity, yield_unit, image_data)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, name, nameEn || null, price || 0, category || 'عام', cost || 0, stock || 0, minStock || 0, active !== false,
         pricingMode || 'fixed', markupPct || 30, brandId || null,
         isSemiFinished ? 1 : 0, productionUnit || 'pcs', consumesSemiId || null, consumesSemiQty || 0,
         productionWarehouseId || null, salesWarehouseId || null,
         unit || null, bigUnit || null, Number(convRate) || 1,
         Number(yieldQuantity) || 1, yieldUnit || null,
         imageData || null]
      );
    }
    // v5.10.16 — when this is a semi-finished product, mirror the unit/
    // conversion fields into inv_items so warehouse views, valuations, and
    // recipes that consume it see consistent metadata.
    if (isSemiFinished) {
      try {
        await db.query(
          `UPDATE inv_items SET name=?, category=?, brand_id=?, unit=?, big_unit=?, conv_rate=?, min_stock=?
           WHERE id=?`,
          [name, category, brandId || null,
           unit || productionUnit || 'pcs', bigUnit || null, Number(convRate) || 1,
           Number(minStock) || 0, req.params.id]
        );
      } catch(_) { /* inv_items row may not exist on first save — non-fatal */ }
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update price only
// V5.7.4: now records price history for traceability + returns the new price + cost margin.
router.patch('/:id/price', verifyToken, MGR, async (req, res) => {
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
router.post('/bulk-price-update', verifyToken, MGR, async (req, res) => {
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

// Delete menu item — v7.4 SOFT delete. A hard DELETE FROM menu orphaned sales
// history / BOM lines / channel_menu refs and let stale POS caches sell a
// "ghost" item. We now flag is_deleted=1 + active=0 so the row (and every FK
// pointing at it) survives, while it disappears from POS + admin lists and the
// checkout ghost-guard (active=0) refuses to invoice it.
router.delete('/:id', verifyToken, MGR, async (req, res) => {
  try {
    const [r] = await db.query('UPDATE menu SET is_deleted = 1, active = 0 WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, error: 'الصنف غير موجود' });
    res.json({ success: true, softDeleted: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// bilingual-i18n-images (Owner C) — category EN labels + name_en coverage.
// menu_category_i18n is created by Owner A's migration
// (db/migrations/0013_bilingual_catalog.sql): category_ar (PK) + category_en.
// ═══════════════════════════════════════════════════════════════════

// GET /api/menu/categories — every distinct category in use, its English
// label (if translated), and how many (non-deleted) items sit in it. Public
// read, same as the rest of the catalog-shaped GETs in this file.
router.get('/categories', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT m.category AS categoryAr,
              mci.category_en AS categoryEn,
              COUNT(*) AS itemCount
         FROM menu m
         LEFT JOIN menu_category_i18n mci ON mci.category_ar = m.category
        WHERE COALESCE(m.is_deleted,0) = 0
        GROUP BY m.category, mci.category_en
        ORDER BY m.category`);
    res.json(rows.map(r => ({
      categoryAr: r.categoryAr,
      categoryEn: r.categoryEn || '',
      itemCount: Number(r.itemCount) || 0
    })));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PUT /api/menu/categories/:categoryAr — set/replace the English label for an
// Arabic category name. MGR-gated (mirrors every other admin write below).
router.put('/categories/:categoryAr', verifyToken, MGR, async (req, res) => {
  try {
    const categoryAr = req.params.categoryAr;
    const categoryEn = ((req.body && req.body.categoryEn) || '').toString().trim();
    if (!categoryEn) return res.status(400).json({ success: false, error: 'الاسم الإنجليزي للفئة مطلوب' });
    await db.query(
      `INSERT INTO menu_category_i18n (category_ar, category_en) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE category_en = VALUES(category_en)`,
      [categoryAr, categoryEn]);
    res.json({ success: true, categoryAr, categoryEn });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/menu/name-en-coverage — MGR-gated dashboard stat: how much of the
// sellable catalog has an English name, and where that name came from.
// name_en_source / name_en_needs_review are added by Owner D's migration
// (db/migrations/0015_name_en_backfill.sql):
//   name_en_source ENUM('owner','machine_translation','transliteration') NULL
//   name_en_needs_review TINYINT(1) DEFAULT 0
// "Sellable" mirrors the rest of this file's convention: not soft-deleted and
// not a synthetic SEED-% fixture row.
router.get('/name-en-coverage', verifyToken, MGR, async (req, res) => {
  try {
    const [[cov]] = await db.query(
      `SELECT COUNT(*) AS total_sellable,
              SUM(CASE WHEN name_en IS NOT NULL AND name_en <> '' THEN 1 ELSE 0 END) AS translated,
              SUM(CASE WHEN name_en_source = 'owner' THEN 1 ELSE 0 END) AS owner_authored,
              SUM(CASE WHEN name_en_source = 'machine_translation' THEN 1 ELSE 0 END) AS machine_translated,
              SUM(CASE WHEN name_en_source = 'transliteration' THEN 1 ELSE 0 END) AS transliterated,
              SUM(CASE WHEN COALESCE(name_en_needs_review,0) = 1 THEN 1 ELSE 0 END) AS needs_review
         FROM menu
        WHERE COALESCE(is_deleted,0) = 0 AND id NOT LIKE 'SEED-%'`);
    // Lightweight image-storage stat, sharing this dashboard endpoint rather
    // than adding a whole sibling route for two numbers.
    const [[img]] = await db.query(
      `SELECT SUM(LENGTH(image_data)) AS total_image_bytes,
              COUNT(image_data) AS items_with_image
         FROM menu`);
    res.json({
      success: true,
      totalSellable: Number(cov.total_sellable) || 0,
      translated: Number(cov.translated) || 0,
      ownerAuthored: Number(cov.owner_authored) || 0,
      machineTranslated: Number(cov.machine_translated) || 0,
      transliterated: Number(cov.transliterated) || 0,
      needsReview: Number(cov.needs_review) || 0,
      imageStorage: {
        totalImageBytes: Number(img.total_image_bytes) || 0,
        itemsWithImage: Number(img.items_with_image) || 0
      }
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Bulk import menu items
router.post('/import', verifyToken, MGR, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'No items provided' });

    let imported = 0;
    let updated = 0;
    const invalid = [];

    for (const item of items) {
      // v7.1 — skip rows with negative price/cost rather than importing bad data.
      if (Number(item.price) < 0 || Number(item.cost) < 0) { invalid.push(item.name || item.id || '?'); continue; }
      const id = item.id || 'MENU-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      const [existing] = await db.query('SELECT id FROM menu WHERE id = ? OR name = ?', [id, item.name]);
      // v7.1 — tax columns from the Excel sheet
      const _incl = item.taxInclusive ? 1 : 0;
      let _cat = String(item.taxCategory || 'S').toUpperCase();
      if (['S','Z','E','O'].indexOf(_cat) < 0) _cat = 'S';

      if (existing.length) {
        await db.query(
          `UPDATE menu SET name=?, price=?, category=?, cost=?, stock=?, min_stock=?, active=?, is_tax_inclusive=?, tax_category=? WHERE id=?`,
          [item.name, item.price || 0, item.category || 'عام', item.cost || 0, item.stock || 999, item.minStock || 5, item.active !== false, _incl, _cat, existing[0].id]
        );
        updated++;
      } else {
        await db.query(
          `INSERT INTO menu (id, name, price, category, cost, stock, min_stock, active, is_tax_inclusive, tax_category) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, item.name, item.price || 0, item.category || 'عام', item.cost || 0, item.stock || 999, item.minStock || 5, item.active !== false, _incl, _cat]
        );
        imported++;
      }
    }

    res.json({ success: true, imported, updated, skipped: invalid.length, invalid, total: items.length });
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

router.post('/recipes/:menuId', verifyToken, MGR, async (req, res) => {
  try {
    const { menuId } = req.params;
    const { menuName, ingredients } = req.body;
    // v7.1 — validate BEFORE deleting the old recipe: every ingredient must have
    // qty > 0 and reference an existing inv_item (prevents orphan rows / zero-deduction).
    if (Array.isArray(ingredients) && ingredients.length) {
      const badQty = ingredients.filter(ing => !(Number(ing.qtyUsed) > 0));
      if (badQty.length) return res.status(400).json({ success: false, error: 'كمية كل مكوّن يجب أن تكون أكبر من صفر', items: badQty.map(b => b.invItemName || b.invItemId || '?') });
      const ids = [...new Set(ingredients.map(i => i.invItemId).filter(Boolean))];
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const [exist] = await db.query('SELECT id FROM inv_items WHERE id IN (' + ph + ')', ids);
        const have = new Set(exist.map(r => r.id));
        const missing = ids.filter(id => !have.has(id));
        if (missing.length) return res.status(400).json({ success: false, error: 'مكوّنات غير موجودة في المخزون', items: missing });
      }
    }
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
router.post('/:id/recipe-bom', verifyToken, MGR, async (req, res) => {
  try {
    const menuId = req.params.id;
    const b = req.body || {};
    const [menuRows] = await db.query('SELECT id, name, bom_id FROM menu WHERE id = ?', [menuId]);
    if (!menuRows.length) return res.status(404).json({ success: false, error: 'منتج غير موجود' });
    const menu = menuRows[0];

    // v7.1 — validate lines before writing anything: qty > 0 and existing inv_item.
    if (Array.isArray(b.lines) && b.lines.length) {
      const badQ = b.lines.filter(ln => !(Number(ln.quantity) > 0));
      if (badQ.length) return res.status(400).json({ success: false, error: 'كمية كل سطر يجب أن تكون أكبر من صفر' });
      const cids = [...new Set(b.lines.map(ln => ln.componentItemId || ln.itemId).filter(Boolean))];
      if (cids.length) {
        const ph = cids.map(() => '?').join(',');
        const [ex] = await db.query('SELECT id FROM inv_items WHERE id IN (' + ph + ')', cids);
        const have = new Set(ex.map(r => r.id));
        const missing = cids.filter(id => !have.has(id));
        if (missing.length) return res.status(400).json({ success: false, error: 'مكوّنات غير موجودة في المخزون', items: missing });
      }
    }

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

// ═══════════════════════════════════════════════════════════════════
// COMBOS / OFFERS (العروض) — e.g. "أي سندوتش مع عصير"
// A combo is a menu row (is_combo=1) whose makeup REFERENCES other menu
// rows (no recipe duplication):
//   • combo_groups       — fixed components + choice groups
//   • combo_group_items  — each referenced menu item (+ qty)
// The cashier opens a chooser on tap; at sale time the combo line is
// expanded into its components and the EXISTING recipe-deduction engine
// runs per component (see routes/sales.js). Combo price is FIXED.
// ═══════════════════════════════════════════════════════════════════

// Load full combo definitions. filter: { brandId?, menuId? }
async function _loadCombos(filter) {
  let sql = `SELECT m.id, m.name, m.name_en, m.price, m.cost, m.category, m.brand_id, m.active
             FROM menu m WHERE m.is_combo = 1 AND COALESCE(m.is_deleted,0) = 0`;
  const params = [];
  if (filter && filter.brandId) { sql += ' AND m.brand_id = ?'; params.push(filter.brandId); }
  if (filter && filter.menuId)  { sql += ' AND m.id = ?'; params.push(filter.menuId); }
  sql += ' ORDER BY m.category, m.name';
  const [combos] = await db.query(sql, params);
  if (!combos.length) return [];
  const ids = combos.map(c => c.id);
  const ph = ids.map(() => '?').join(',');
  const [groups] = await db.query(
    `SELECT * FROM combo_groups WHERE menu_id IN (${ph}) ORDER BY sort_order, id`, ids);
  let items = [];
  if (groups.length) {
    const gids = groups.map(g => g.id);
    const gph = gids.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT cgi.*, mi.name AS item_name, mi.name_en AS item_name_en, mi.price AS item_price,
              mi.active AS item_active, COALESCE(mi.bom_id,'') AS item_bom_id
       FROM combo_group_items cgi
       LEFT JOIN menu mi ON mi.id = cgi.menu_item_id
       WHERE cgi.group_id IN (${gph}) ORDER BY cgi.sort_order, cgi.id`, gids);
    items = rows;
  }
  const itemsByGroup = {};
  items.forEach(it => { (itemsByGroup[it.group_id] = itemsByGroup[it.group_id] || []).push(it); });
  const groupsByMenu = {};
  groups.forEach(g => {
    (groupsByMenu[g.menu_id] = groupsByMenu[g.menu_id] || []).push({
      id: g.id,
      type: g.group_type,
      name: g.name,
      minSelect: Number(g.min_select) || 0,
      maxSelect: Number(g.max_select) || 1,
      options: (itemsByGroup[g.id] || []).map(it => ({
        menuItemId: it.menu_item_id,
        name: it.item_name || it.menu_item_id,
        nameEn: it.item_name_en || '',
        price: Number(it.item_price) || 0,
        qty: Number(it.qty) || 1,
        hasRecipe: !!it.item_bom_id,
        active: it.item_active == null ? true : !!it.item_active
      }))
    });
  });
  return combos.map(c => ({
    id: c.id,
    name: c.name,
    nameEn: c.name_en || '',
    price: Number(c.price) || 0,
    cost: Number(c.cost) || 0,
    category: c.category || 'عروض',
    brandId: c.brand_id || '',
    active: !!c.active,
    isCombo: true,
    groups: groupsByMenu[c.id] || []
  }));
}

// Validate a combo write body. Returns { ok, error?, items? }.
async function _validateCombo(b) {
  if (!b || !b.name || !String(b.name).trim()) return { ok: false, error: 'اسم العرض مطلوب' };
  if (isNaN(Number(b.price)) || Number(b.price) < 0) return { ok: false, error: 'سعر العرض يجب أن يكون صفراً أو أكثر' };
  const groups = Array.isArray(b.groups) ? b.groups : [];
  if (!groups.length) return { ok: false, error: 'أضف مكوّناً ثابتاً أو مجموعة اختيار واحدة على الأقل' };
  const allItemIds = [];
  for (const g of groups) {
    const its = Array.isArray(g.items) ? g.items.filter(it => it && it.menuItemId) : [];
    if (!its.length) return { ok: false, error: 'كل مجموعة يجب أن تحتوي عنصراً واحداً على الأقل: ' + (g.name || '') };
    if (g.type === 'choice') {
      const mn = Number(g.minSelect), mx = Number(g.maxSelect);
      if (isNaN(mn) || isNaN(mx) || mn < 0 || mx < 1 || mn > mx) return { ok: false, error: 'حدود الاختيار غير صحيحة في: ' + (g.name || '') };
      if (mx > its.length) return { ok: false, error: 'الحد الأقصى للاختيار أكبر من عدد الخيارات في: ' + (g.name || '') };
    }
    its.forEach(it => allItemIds.push(it.menuItemId));
  }
  const uniq = [...new Set(allItemIds)];
  if (uniq.length) {
    const ph = uniq.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT id, COALESCE(is_combo,0) AS is_combo, COALESCE(is_deleted,0) AS is_deleted FROM menu WHERE id IN (${ph})`, uniq);
    const map = {}; rows.forEach(r => { map[r.id] = r; });
    const missing = uniq.filter(id => !map[id] || Number(map[id].is_deleted) === 1);
    if (missing.length) return { ok: false, error: 'منتجات غير موجودة (أو محذوفة)', items: missing };
    const nested = uniq.filter(id => map[id] && Number(map[id].is_combo) === 1);
    if (nested.length) return { ok: false, error: 'لا يمكن إدراج عرض داخل عرض', items: nested };
  }
  return { ok: true };
}

// Replace all groups + items for a combo (DELETE then INSERT, like recipe-bom).
async function _writeComboGroups(menuId, groups) {
  const [old] = await db.query('SELECT id FROM combo_groups WHERE menu_id = ?', [menuId]);
  if (old.length) {
    const gids = old.map(g => g.id);
    const ph = gids.map(() => '?').join(',');
    await db.query(`DELETE FROM combo_group_items WHERE group_id IN (${ph})`, gids);
    await db.query('DELETE FROM combo_groups WHERE menu_id = ?', [menuId]);
  }
  const list = Array.isArray(groups) ? groups : [];
  for (let gi = 0; gi < list.length; gi++) {
    const g = list[gi];
    const type = g.type === 'fixed' ? 'fixed' : 'choice';
    const gid = 'CG-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + gi;
    const minS = type === 'fixed' ? 0 : (Number(g.minSelect) || 0);
    const maxS = type === 'fixed' ? 0 : (Number(g.maxSelect) || 1);
    await db.query(
      `INSERT INTO combo_groups (id, menu_id, group_type, name, min_select, max_select, sort_order) VALUES (?,?,?,?,?,?,?)`,
      [gid, menuId, type, g.name || (type === 'fixed' ? 'مكوّن ثابت' : 'اختيار'), minS, maxS, gi]);
    const its = Array.isArray(g.items) ? g.items.filter(it => it && it.menuItemId) : [];
    for (let ii = 0; ii < its.length; ii++) {
      await db.query(
        `INSERT INTO combo_group_items (id, group_id, menu_item_id, qty, sort_order) VALUES (?,?,?,?,?)`,
        ['CGI-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + gi + '-' + ii,
         gid, its[ii].menuItemId, Number(its[ii].qty) || 1, ii]);
    }
  }
}

// Representative cost for margin display. Actual COGS at sale = real chosen
// components (routes/sales.js). Fixed comps at full cost; choice groups at the
// AVERAGE option cost × minSelect (≥1) — a realistic mid estimate.
async function _computeComboCost(groups) {
  const list = Array.isArray(groups) ? groups : [];
  const ids = [];
  list.forEach(g => (g.items || []).forEach(it => { if (it && it.menuItemId) ids.push(it.menuItemId); }));
  const uniq = [...new Set(ids)];
  if (!uniq.length) return 0;
  const costMap = {};
  try {
    const ph = uniq.map(() => '?').join(',');
    const [rows] = await db.query(`SELECT id, COALESCE(cost,0) AS cost FROM menu WHERE id IN (${ph})`, uniq);
    rows.forEach(r => { costMap[r.id] = Number(r.cost) || 0; });
  } catch (_) {}
  let total = 0;
  list.forEach(g => {
    const its = (g.items || []).filter(it => it && it.menuItemId);
    if (!its.length) return;
    if (g.type === 'fixed') {
      its.forEach(it => { total += (costMap[it.menuItemId] || 0) * (Number(it.qty) || 1); });
    } else {
      const avg = its.reduce((s, it) => s + (costMap[it.menuItemId] || 0) * (Number(it.qty) || 1), 0) / its.length;
      total += avg * Math.max(1, Number(g.minSelect) || 1);
    }
  });
  return Math.round(total * 100) / 100;
}

// GET /api/menu/combos?brandId= — list combos (public: cashier reads it)
router.get('/combos', async (req, res) => {
  try {
    res.json(await _loadCombos({ brandId: req.query.brandId || null }));
  } catch (e) { res.json([]); }
});

// GET /api/menu/combos/:id — one combo (full definition)
router.get('/combos/:id', async (req, res) => {
  try {
    const out = await _loadCombos({ menuId: req.params.id });
    if (!out.length) return res.status(404).json({ error: 'العرض غير موجود' });
    res.json(out[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/menu/combos — create a combo (+ its menu row)
router.post('/combos', verifyToken, MGR, async (req, res) => {
  try {
    const b = req.body || {};
    const v = await _validateCombo(b);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, items: v.items });
    let taxInclusive = b.taxInclusive;
    if (typeof taxInclusive === 'undefined') {
      try {
        const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'NewProductsTaxInclusive' LIMIT 1");
        taxInclusive = rows.length ? isTruthy(rows[0].setting_value) : false;
      } catch (_) { taxInclusive = false; }
    }
    const cost = await _computeComboCost(b.groups);
    const id = 'COMBO-' + Date.now();
    await db.query(
      `INSERT INTO menu (id, name, name_en, price, is_tax_inclusive, tax_category, category, cost,
                         stock, min_stock, active, pricing_mode, markup_pct, brand_id,
                         is_combo, production_method, deduct_strategy)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name, b.nameEn || null, Number(b.price) || 0, taxInclusive ? 1 : 0, 'S',
       b.category || 'عروض', cost, 0, 0, b.active !== false, 'fixed', 30, b.brandId || null,
       1, 'made_at_branch', 'on_sale']);
    await _writeComboGroups(id, b.groups);
    res.json({ success: true, id, cost });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// PUT /api/menu/combos/:id — update a combo
router.put('/combos/:id', verifyToken, MGR, async (req, res) => {
  try {
    const b = req.body || {};
    const [exist] = await db.query('SELECT id FROM menu WHERE id = ? AND is_combo = 1', [req.params.id]);
    if (!exist.length) return res.status(404).json({ success: false, error: 'العرض غير موجود' });
    const v = await _validateCombo(b);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, items: v.items });
    const cost = await _computeComboCost(b.groups);
    let sql = 'UPDATE menu SET name=?, name_en=?, price=?, category=?, cost=?, active=?, brand_id=?';
    const params = [b.name, b.nameEn || null, Number(b.price) || 0, b.category || 'عروض', cost, b.active !== false, b.brandId || null];
    if (typeof b.taxInclusive !== 'undefined') { sql += ', is_tax_inclusive=?'; params.push(b.taxInclusive ? 1 : 0); }
    sql += ' WHERE id=?'; params.push(req.params.id);
    await db.query(sql, params);
    await _writeComboGroups(req.params.id, b.groups);
    res.json({ success: true, cost });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// DELETE /api/menu/combos/:id — soft-delete (mirrors DELETE /:id)
router.delete('/combos/:id', verifyToken, MGR, async (req, res) => {
  try {
    const [r] = await db.query('UPDATE menu SET is_deleted = 1, active = 0 WHERE id = ? AND is_combo = 1', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, error: 'العرض غير موجود' });
    res.json({ success: true, softDeleted: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// POST /api/menu/combos/convert/:id — turn an EXISTING normal product into a
// combo (is_combo=1) in place, then write its groups. The is_combo flag flips
// only here (atomically with the groups), so there is never a "flagged but
// empty" combo that would sell with zero deduction. Reuses the same validation
// + write helpers as POST/PUT /combos.
router.post('/combos/convert/:id', verifyToken, MGR, async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const [rows] = await db.query(
      'SELECT id, COALESCE(is_combo,0) AS is_combo, COALESCE(is_semi_finished,0) AS is_semi_finished, COALESCE(is_deleted,0) AS is_deleted FROM menu WHERE id = ?',
      [id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    const row = rows[0];
    if (Number(row.is_combo) === 1) return res.status(400).json({ success: false, error: 'هذا المنتج عرض بالفعل — استخدم تعديل العرض' });
    if (Number(row.is_semi_finished) === 1) return res.status(400).json({ success: false, error: 'لا يمكن تحويل منتج نصف-مصنّع إلى عرض' });
    if (Number(row.is_deleted) === 1) return res.status(400).json({ success: false, error: 'المنتج محذوف' });
    // Nesting guard: a product that is itself a choice/fixed item inside ANOTHER
    // combo must not become a combo (would create a combo-inside-combo at sale).
    const [used] = await db.query('SELECT 1 FROM combo_group_items WHERE menu_item_id = ? LIMIT 1', [id]);
    if (used.length) return res.status(400).json({ success: false, error: 'هذا المنتج مستخدَم كخيار في عرض آخر؛ أزِله منه أولاً ثم حوّله' });

    const v = await _validateCombo(b);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, items: v.items });
    // A combo must not contain itself.
    const refsSelf = (b.groups || []).some(g => (g.items || []).some(it => it && String(it.menuItemId) === String(id)));
    if (refsSelf) return res.status(400).json({ success: false, error: 'لا يمكن أن يحتوي العرض على نفسه' });

    const cost = await _computeComboCost(b.groups);
    let sql = 'UPDATE menu SET is_combo=1, name=?, name_en=?, price=?, category=?, cost=?, active=?';
    const params = [b.name, b.nameEn || null, Number(b.price) || 0, b.category || 'عروض', cost, b.active !== false];
    if (typeof b.taxInclusive !== 'undefined') { sql += ', is_tax_inclusive=?'; params.push(b.taxInclusive ? 1 : 0); }
    sql += ' WHERE id=?'; params.push(id);
    await db.query(sql, params);
    await _writeComboGroups(id, b.groups);
    res.json({ success: true, id, cost, converted: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
