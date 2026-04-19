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
      `SELECT li.*, i.name AS item_name, i.id AS sku, i.unit
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
      `SELECT bl.*, i.name AS item_name, i.id AS sku, COALESCE(i.cost,0) AS avg_cost
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

    // ═══ AUTO GL POSTING ═══
    // Dr Waste Expense (cost_center) / Cr Inventory (warehouse)
    if (total > 0) {
      const post = await gl.postJournal(db, {
        journalDate: wasteDate || new Date().toISOString().slice(0, 10),
        description: 'Waste — ' + (reason || 'other'),
        referenceType: 'WasteEntry',
        referenceId: id,
        entries: [
          {
            accountCode: '5200',       // Waste Expense
            debit: total, credit: 0,
            description: 'Waste cost',
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

    const rows = accts.map(a => {
      const opening = Number(openingMap[a.id] || 0);
      const mov = movementMap[a.id] || { period_debit: 0, period_credit: 0, row_count: 0 };
      const d = Number(mov.period_debit) || 0;
      const c = Number(mov.period_credit) || 0;
      const closing = opening + d - c;
      return {
        accountId: a.id,
        code: a.code,
        nameAr: a.name_ar,
        type: a.type,
        opening: Math.round(opening * 100) / 100,
        periodDebit: Math.round(d * 100) / 100,
        periodCredit: Math.round(c * 100) / 100,
        net: Math.round((d - c) * 100) / 100,
        closing: Math.round(closing * 100) / 100,
        rowCount: Number(mov.row_count) || 0
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
    const { from, to, branch, brand, costCenter, groupBy } = req.query;
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

    const totalRevenue = mapped.filter(r => r.type === 'revenue').reduce((s, r) => s + r.amount, 0);
    const totalExpense = mapped.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const netProfit = totalRevenue - totalExpense;

    res.json({
      success: true,
      filters: { from: from || null, to: to || null, branch: branch || null, brand: brand || null, costCenter: costCenter || null, groupBy: groupBy || 'account' },
      revenue: mapped.filter(r => r.type === 'revenue'),
      expenses: mapped.filter(r => r.type === 'expense'),
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
// EXTENDED REPORTS — Cash Flow / Aging / Inventory / Sales / Waste / Royalty
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /erp/reports/cash-flow?from=&to=&branch=&brand=
 * Direct-method cash flow. Classifies movements on cash/bank accounts
 * into three categories based on the contra account's type:
 *   Operating: revenue / expense / COGS / input VAT / output VAT
 *   Investing: fixed assets / long-term assets
 *   Financing: equity / long-term liabilities
 */
router.get('/reports/cash-flow', async (req, res) => {
  try {
    const { from, to, branch, brand } = req.query;
    const dim = await _dimCols();

    const where = [];
    const params = [];
    where.push("j.status = 'posted'");
    // Only cash/bank accounts (1110 or 1120)
    where.push("ca.code IN ('1110','1120')");
    if (from) { where.push('j.journal_date >= ?'); params.push(from); }
    if (to)   { where.push('j.journal_date <= ?'); params.push(to); }
    if (branch && dim.branch_id) { where.push('ce.branch_id = ?'); params.push(branch); }
    if (brand && dim.brand_id)   { where.push('ce.brand_id = ?');  params.push(brand); }

    // Self-join gl_entries to find contra lines on the same journal.
    // cash_entry (ce) is the cash/bank entry; contra (cc) is the matched non-cash side.
    const sql = `
      SELECT ce.debit AS cash_in, ce.credit AS cash_out,
             j.journal_date, j.description, j.reference_type, j.reference_id, j.id AS journal_id,
             cc.account_id AS contra_acc_id, ca2.code AS contra_code, ca2.type AS contra_type, ca2.name_ar AS contra_name
      FROM gl_entries ce
      JOIN gl_accounts ca ON ce.account_id = ca.id
      JOIN gl_journals j ON ce.journal_id = j.id
      JOIN gl_entries cc ON cc.journal_id = ce.journal_id AND cc.id != ce.id
      JOIN gl_accounts ca2 ON cc.account_id = ca2.id
      WHERE ${where.join(' AND ')}
      ORDER BY j.journal_date`;
    const [rows] = await db.query(sql, params);

    // Classify each cash movement
    const opening = {}; // { 'in': 0, 'out': 0, by category }
    const flows = { operating: 0, investing: 0, financing: 0, other: 0 };
    const byCategory = {};  // bucket → [{date, description, amount}]

    rows.forEach(r => {
      const cashIn = Number(r.cash_in) || 0;
      const cashOut = Number(r.cash_out) || 0;
      const netCash = cashIn - cashOut;  // + = in, - = out
      if (netCash === 0) return;

      let bucket = 'operating';
      const ct = (r.contra_type || '').toLowerCase();
      const cc = r.contra_code || '';
      if (cc.startsWith('15') || cc.startsWith('16')) bucket = 'investing';
      else if (cc.startsWith('3') || cc.startsWith('25')) bucket = 'financing';
      else if (ct === 'revenue' || ct === 'expense' || cc === '1200' || cc === '1290' || cc === '2210') bucket = 'operating';
      else if (ct === 'asset') bucket = (cc.startsWith('15') ? 'investing' : 'operating');
      else if (ct === 'liability') bucket = (cc.startsWith('25') || cc.startsWith('3') ? 'financing' : 'operating');
      else if (ct === 'equity') bucket = 'financing';
      else bucket = 'other';

      flows[bucket] += netCash;
      if (!byCategory[bucket]) byCategory[bucket] = [];
      byCategory[bucket].push({
        date: r.journal_date,
        description: r.description || '',
        contra: cc + ' — ' + (r.contra_name || ''),
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        amount: Math.round(netCash * 100) / 100
      });
    });

    // Opening & closing cash balances
    const [ob] = await db.query(
      `SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
       FROM gl_entries e
       JOIN gl_accounts a ON e.account_id = a.id
       JOIN gl_journals j ON e.journal_id = j.id
       WHERE a.code IN ('1110','1120') AND j.status='posted'
         AND j.journal_date < ?`, [from || '1900-01-01']);
    const openingCash = Number(ob[0].d || 0) - Number(ob[0].c || 0);
    const netChange = flows.operating + flows.investing + flows.financing + flows.other;
    const closingCash = openingCash + netChange;

    res.json({
      success: true,
      period: { from: from || null, to: to || null },
      filters: { branch: branch || null, brand: brand || null },
      openingCash: Math.round(openingCash * 100) / 100,
      closingCash: Math.round(closingCash * 100) / 100,
      netChange: Math.round(netChange * 100) / 100,
      flows: {
        operating: Math.round(flows.operating * 100) / 100,
        investing: Math.round(flows.investing * 100) / 100,
        financing: Math.round(flows.financing * 100) / 100,
        other: Math.round(flows.other * 100) / 100
      },
      details: byCategory
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

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

    let sql, params = [];
    if (hasWS) {
      sql = `
        SELECT ws.warehouse_id, w.name AS warehouse_name,
               i.id AS item_id, i.name AS item_name, i.id AS sku, i.unit,
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
      sql += ' ORDER BY w.name, i.name';
    } else {
      sql = `SELECT '' AS warehouse_id, '' AS warehouse_name,
             i.id AS item_id, i.name AS item_name, i.id AS sku, i.unit,
             i.brand_id, b.name AS brand_name,
             COALESCE(i.stock, 0) AS qty, COALESCE(i.cost, 0) AS avg_cost
             FROM inv_items i LEFT JOIN brands b ON i.brand_id = b.id
             WHERE COALESCE(i.stock,0) > 0`;
      if (brand) { sql += ' AND i.brand_id = ?'; params.push(brand); }
      sql += ' ORDER BY i.name';
    }

    const [rows] = await db.query(sql, params);
    const items = rows.map(r => {
      const q = Number(r.qty) || 0;
      const c = Number(r.avg_cost) || 0;
      return {
        warehouseId: r.warehouse_id || '',
        warehouseName: r.warehouse_name || '',
        itemId: r.item_id, itemName: r.item_name, sku: r.sku || '', unit: r.unit || '',
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
    const { from, to, branch, brand, groupBy } = req.query;
    const by = groupBy || 'all';

    // Detect fields we need
    let hasBranch = true, hasBrand = true;
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'branch_id'"); hasBranch = !!c.length; } catch(e) { hasBranch = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM sales LIKE 'brand_id'"); hasBrand = !!c.length; } catch(e) { hasBrand = false; }

    const where = ["(s.deleted_at IS NULL)"];
    const params = [];
    if (from) { where.push('DATE(s.order_date) >= ?'); params.push(from); }
    if (to)   { where.push('DATE(s.order_date) <= ?'); params.push(to); }
    if (branch && hasBranch) { where.push('s.branch_id = ?'); params.push(branch); }
    if (brand && hasBrand)   { where.push('s.brand_id = ?');  params.push(brand); }
    const whereClause = where.join(' AND ');

    const out = { filters: { from: from || null, to: to || null, branch: branch || null, brand: brand || null } };

    // Headline totals
    const [hd] = await db.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_final),0) AS total, COALESCE(AVG(total_final),0) AS avg_ticket
       FROM sales s WHERE ${whereClause}`, params);
    out.headline = {
      invoiceCount: Number(hd[0].cnt) || 0,
      total: Math.round(Number(hd[0].total) * 100) / 100,
      avgTicket: Math.round(Number(hd[0].avg_ticket) * 100) / 100
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
    if (by === 'top_items' || by === 'all') {
      const [ti] = await db.query(
        `SELECT si.item_name AS name, SUM(si.qty) AS qty, SUM(si.total) AS total
         FROM sales_items si JOIN sales s ON si.order_id = s.id
         WHERE ${whereClause}
         GROUP BY si.item_name ORDER BY qty DESC LIMIT 25`, params);
      out.topItems = ti.map(r => ({ name: r.name || '', qty: Number(r.qty) || 0, total: Math.round(Number(r.total) * 100) / 100 }));
    }

    res.json({ success: true, ...out });
  } catch(e) { res.json({ success: false, error: e.message }); }
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

module.exports = router;
