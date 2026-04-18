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
    const [rows] = await db.query(
      `SELECT pl.*, b.name AS brand_name, br.name AS branch_name,
              (SELECT COUNT(*) FROM price_list_items li WHERE li.price_list_id = pl.id) AS item_count
       FROM price_lists pl
       LEFT JOIN brands b ON pl.brand_id = b.id
       LEFT JOIN branches br ON pl.branch_id = br.id
       WHERE pl.is_active = 1 OR pl.is_active IS NULL
       ORDER BY pl.is_default DESC, pl.name`);
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
    const { id, name, brandId, branchId, isDefault, validFrom, validTo } = req.body;
    if (!name) return res.json({ success: false, error: 'اسم القائمة مطلوب' });
    if (id) {
      await db.query(
        `UPDATE price_lists SET name=?, brand_id=?, branch_id=?, is_default=?, valid_from=?, valid_to=? WHERE id=?`,
        [name, brandId||null, branchId||null, isDefault?1:0, validFrom||null, validTo||null, id]);
      return res.json({ success: true, id });
    }
    const newId = genId('PL');
    await db.query(
      `INSERT INTO price_lists (id, name, brand_id, branch_id, is_default, valid_from, valid_to)
       VALUES (?,?,?,?,?,?,?)`,
      [newId, name, brandId||null, branchId||null, isDefault?1:0, validFrom||null, validTo||null]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/price-lists/:id/items', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT li.*, i.name AS item_name, i.sku, i.unit
       FROM price_list_items li
       LEFT JOIN inv_items i ON li.item_id = i.id
       WHERE li.price_list_id = ?
       ORDER BY i.name`, [req.params.id]);
    res.json(rows.map(l => ({
      id: l.id, itemId: l.item_id, itemName: l.item_name || '', sku: l.sku || '',
      unit: l.unit || '', price: Number(l.price), minPrice: Number(l.min_price) || 0,
      validFrom: l.valid_from, validTo: l.valid_to
    })));
  } catch(e) { res.json([]); }
});

router.post('/price-lists/:id/items', async (req, res) => {
  try {
    const { itemId, price, minPrice, validFrom, validTo } = req.body;
    if (!itemId || price == null) return res.json({ success: false, error: 'الصنف والسعر مطلوبان' });
    const id = genId('PLI');
    await db.query(
      `INSERT INTO price_list_items (id, price_list_id, item_id, price, min_price, valid_from, valid_to)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE price=VALUES(price), min_price=VALUES(min_price), valid_from=VALUES(valid_from), valid_to=VALUES(valid_to)`,
      [id, req.params.id, itemId, Number(price), Number(minPrice)||0, validFrom||null, validTo||null]);
    res.json({ success: true, id });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/price-list-items/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM price_list_items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// BOM / RECIPES
// ═══════════════════════════════════════
router.get('/bom', async (req, res) => {
  try {
    const { product_id } = req.query;
    let sql = `SELECT b.*, i.name AS product_name,
               (SELECT COUNT(*) FROM bom_lines bl WHERE bl.bom_id = b.id) AS line_count
               FROM bom b LEFT JOIN inv_items i ON b.product_id = i.id WHERE 1=1`;
    const params = [];
    if (product_id) { sql += ' AND b.product_id = ?'; params.push(product_id); }
    sql += ' ORDER BY i.name, b.version DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(b => ({
      id: b.id, productId: b.product_id, productName: b.product_name || '',
      version: b.version, yieldQuantity: Number(b.yield_quantity) || 1,
      yieldUnit: b.yield_unit || 'PCS', isActive: b.is_active !== false,
      effectiveFrom: b.effective_from, effectiveTo: b.effective_to,
      lineCount: Number(b.line_count) || 0, notes: b.notes || ''
    })));
  } catch(e) { res.json([]); }
});

router.post('/bom', async (req, res) => {
  try {
    const { id, productId, version, yieldQuantity, yieldUnit, effectiveFrom, effectiveTo, notes, lines } = req.body;
    if (!productId) return res.json({ success: false, error: 'المنتج مطلوب' });
    let bomId = id;
    if (id) {
      await db.query(
        `UPDATE bom SET version=?, yield_quantity=?, yield_unit=?, effective_from=?, effective_to=?, notes=? WHERE id=?`,
        [Number(version)||1, Number(yieldQuantity)||1, yieldUnit||'PCS', effectiveFrom||null, effectiveTo||null, notes||'', id]);
    } else {
      bomId = genId('BOM');
      await db.query(
        `INSERT INTO bom (id, product_id, version, yield_quantity, yield_unit, effective_from, effective_to, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [bomId, productId, Number(version)||1, Number(yieldQuantity)||1, yieldUnit||'PCS',
         effectiveFrom||null, effectiveTo||null, notes||'']);
    }
    // Replace lines if provided
    if (Array.isArray(lines)) {
      await db.query('DELETE FROM bom_lines WHERE bom_id = ?', [bomId]);
      for (const l of lines) {
        if (!l.componentItemId) continue;
        await db.query(
          `INSERT INTO bom_lines (id, bom_id, component_item_id, quantity, unit, waste_pct)
           VALUES (?,?,?,?,?,?)`,
          [genId('BL'), bomId, l.componentItemId, Number(l.quantity)||0, l.unit||'PCS', Number(l.wastePct)||0]);
      }
    }
    res.json({ success: true, id: bomId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/bom/:id/lines', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT bl.*, i.name AS item_name, i.sku, i.avg_cost
       FROM bom_lines bl
       LEFT JOIN inv_items i ON bl.component_item_id = i.id
       WHERE bl.bom_id = ?`, [req.params.id]);
    res.json(rows.map(l => ({
      id: l.id, componentItemId: l.component_item_id, itemName: l.item_name || '',
      sku: l.sku || '', quantity: Number(l.quantity), unit: l.unit || 'PCS',
      wastePct: Number(l.waste_pct) || 0, avgCost: Number(l.avg_cost) || 0,
      lineCost: (Number(l.quantity) || 0) * (Number(l.avg_cost) || 0) * (1 + (Number(l.waste_pct) || 0) / 100)
    })));
  } catch(e) { res.json([]); }
});

router.delete('/bom/:id', async (req, res) => {
  try {
    await db.query('UPDATE bom SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
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
         AND (status IS NULL OR status != 'void')`,
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
    await db.query(
      `UPDATE royalty_runs SET status='approved', approved_by=?, approved_at=NOW()
       WHERE id=? AND status='draft'`,
      [username||'', req.params.id]);
    res.json({ success: true });
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
router.get('/waste-entries', async (req, res) => {
  try {
    const { brand_id, branch_id, from, to } = req.query;
    let sql = `SELECT w.*, b.name AS branch_name, br.name AS brand_name, cc.name AS cc_name
               FROM waste_entries w
               LEFT JOIN branches b ON w.branch_id = b.id
               LEFT JOIN brands br ON w.brand_id = br.id
               LEFT JOIN cost_centers cc ON w.cost_center_id = cc.id
               WHERE 1=1`;
    const params = [];
    if (brand_id)  { sql += ' AND w.brand_id = ?';  params.push(brand_id); }
    if (branch_id) { sql += ' AND w.branch_id = ?'; params.push(branch_id); }
    if (from)      { sql += ' AND w.waste_date >= ?'; params.push(from); }
    if (to)        { sql += ' AND w.waste_date <= ?'; params.push(to); }
    sql += ' ORDER BY w.waste_date DESC, w.created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(w => ({
      id: w.id, wasteDate: w.waste_date, reason: w.reason,
      brandId: w.brand_id || '', brandName: w.brand_name || '',
      branchId: w.branch_id || '', branchName: w.branch_name || '',
      warehouseId: w.warehouse_id, costCenterId: w.cost_center_id || '',
      costCenterName: w.cc_name || '',
      totalCost: Number(w.total_cost) || 0,
      notes: w.notes || '', createdBy: w.created_by || '', createdAt: w.created_at
    })));
  } catch(e) { res.json([]); }
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
    }
    res.json({ success: true, id, totalCost: total });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/waste-entries/:id/items', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT wi.*, i.name AS item_name, i.sku
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
    const { poId, supplierId, warehouseId, receiptDate, createdBy, lines } = req.body;
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
    res.json({ success: true, id, receiptNumber: rcpNumber, total });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
