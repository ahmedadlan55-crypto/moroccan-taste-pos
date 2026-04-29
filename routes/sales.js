const router = require('express').Router();
const db = require('../db/connection');
const gl = require('../lib/glPosting');
const zatca = require('../lib/zatca');

const VAT_RATE = Number(process.env.VAT_RATE) || 15;
const SELLER_NAME_FALLBACK = process.env.COMPANY_NAME || 'Moroccan Taste';
const SELLER_VAT_FALLBACK = process.env.TAX_NUMBER || '';

// Map payment method keys → GL account codes.
// cash → 1110 (Cash), card/mada/stc/online → 1120 (Bank), kita/credit → 1150 (AR)
function _payToAccountCode(method) {
  const m = (method || '').toLowerCase();
  if (m === 'cash' || m.startsWith('cash')) return '1110';
  if (m === 'kita' || m === 'credit' || m === 'ar' || m.indexOf('ذمم') >= 0) return '1150';
  // default card/bank
  return '1120';
}

// Build a payment-method → GL account code map by joining payment_methods.gl_account_id → gl_accounts.code
// Returns: { 'cash': '1110', 'card': '1120', 'hunger station': '4150', ... }
async function _buildPmGlMap(db) {
  const map = {};
  try {
    const [rows] = await db.query(`
      SELECT pm.name, pm.name_ar, ga.code AS gl_code
        FROM payment_methods pm
        LEFT JOIN gl_accounts ga ON ga.id = pm.gl_account_id
       WHERE pm.is_active = 1 AND pm.gl_account_id IS NOT NULL AND pm.gl_account_id <> ''
    `);
    rows.forEach(r => {
      if (r.gl_code) {
        if (r.name) map[String(r.name).toLowerCase()] = r.gl_code;
        if (r.name_ar) map[String(r.name_ar).toLowerCase()] = r.gl_code;
      }
    });
  } catch(e) { /* gl_account_id column may be missing on very old schemas — ignore */ }
  return map;
}

// V3: parse split payment using the dynamic GL map (falls back to legacy mapping)
function _parseSplitPaymentsV3(payStr, total, pmGlMap) {
  const out = [];
  const lookup = (name) => {
    const k = String(name || '').toLowerCase();
    return (pmGlMap && pmGlMap[k]) || _payToAccountCode(name);
  };
  if (!payStr || payStr.indexOf(':') < 0) {
    out.push({ code: lookup(payStr), amount: Number(total) || 0 });
    return out;
  }
  const parts = payStr.split('/');
  parts.forEach(p => {
    const [k, v] = p.split(':');
    const amt = Number(v) || 0;
    if (amt > 0) out.push({ code: lookup(k), amount: amt });
  });
  if (!out.length) out.push({ code: lookup(payStr), amount: Number(total) || 0 });
  return out;
}

// V3: resolve discount GL account id → code (with fallback to 4901 'Sales Discounts')
async function _resolveDiscountGlCode(db, glAccountId) {
  if (!glAccountId) return '4901'; // default Sales Discount account
  try {
    const [rows] = await db.query('SELECT code FROM gl_accounts WHERE id = ? LIMIT 1', [glAccountId]);
    if (rows.length && rows[0].code) return rows[0].code;
  } catch(e) {}
  return '4901';
}

// Back-compat shim — old code still calls _parseSplitPayments
function _parseSplitPayments(payStr, total) {
  return _parseSplitPaymentsV3(payStr, total, null);
}

// Save order
router.post('/', async (req, res) => {
  try {
    const { items, total, totalFinal, paymentMethod, discountName, discountAmount, kitaServiceFee, splitDetails } = req.body;
    const { username, shiftId, warehouseId: reqWhId } = req.body;
    // ─── V3: optional channel + discount metadata from POS ───
    const { channelId, channelName, discountId, discountGlAccountId, lineDiscounts: lineDiscPayload } = req.body;
    const warehouseId = reqWhId || (req.user && req.user.default_warehouse_id) || null;
    const orderId = shiftId + '-' + Date.now();
    const now = new Date();

    // ─── V3: Resolve channel name from DB if id provided ───
    let resolvedChannelName = channelName || null;
    if (channelId && !resolvedChannelName) {
      try {
        const [chRow] = await db.query('SELECT name FROM sales_channels WHERE id = ?', [channelId]);
        if (chRow.length) resolvedChannelName = chRow[0].name;
      } catch(e) {}
    }

    // Determine payment method string
    let payStr = paymentMethod;
    if (paymentMethod === 'Split' && splitDetails) {
      payStr = Object.entries(splitDetails).filter(([k,v]) => v > 0).map(([k,v]) => k+':'+Math.round(v)).join('/');
    }

    // Compute net + VAT for ZATCA + accounting (invTotal = VAT-inclusive gross)
    const invTotal = Number(totalFinal) || 0;
    const net = Math.round((invTotal / (1 + VAT_RATE / 100)) * 100) / 100;
    const vat = Math.round((invTotal - net) * 100) / 100;

    // ═══ ZATCA Phase 2 stamp (UUID + hash chain + QR) ═══
    // Load seller details — company + branch names if available
    let sellerName = SELLER_NAME_FALLBACK, sellerVat = SELLER_VAT_FALLBACK;
    try {
      const [cRow] = await db.query("SELECT name, tax_number FROM companies WHERE id='CO-MAIN' LIMIT 1");
      if (cRow.length) {
        if (cRow[0].name) sellerName = cRow[0].name;
        if (cRow[0].tax_number) sellerVat = cRow[0].tax_number;
      }
    } catch(e) {}

    let zatcaStamp = {};
    try {
      zatcaStamp = await zatca.stampSale(db, {
        orderId,
        createdAt: now,
        total: invTotal,
        vatAmount: vat,
        lines: items.map(it => ({ name: it.name, qty: it.qty, unitPrice: it.price, lineTotal: it.qty * it.price }))
      }, { name: sellerName, vatNumber: sellerVat });
    } catch(e) {
      zatcaStamp = { uuid: null, invoiceHash: null, previousInvoiceHash: null, qrBase64: null };
    }

    // Insert sale (legacy columns)
    await db.query('INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, discount_name, discount_amount, kita_service_fee) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [orderId, now, JSON.stringify(items), totalFinal, payStr, username, shiftId, discountName || '', discountAmount || 0, kitaServiceFee || 0]);

    // ─── V3: Persist channel + discount metadata (post-insert update so it works on older deploys) ───
    try {
      await db.query(
        `UPDATE sales SET channel_id=?, channel_name=?, discount_id=?, discount_gl_id=?, line_discounts_json=? WHERE id=?`,
        [channelId || null, resolvedChannelName || null, discountId || null, discountGlAccountId || null,
         lineDiscPayload ? JSON.stringify(lineDiscPayload) : null, orderId]
      );
    } catch(e) { /* columns may be missing on very old deploys — ignore */ }

    // Stamp ZATCA fields back (tolerate schemas without these columns)
    if (zatcaStamp.uuid) {
      try {
        await db.query(
          `UPDATE sales SET invoice_uuid=?, invoice_hash=?, previous_invoice_hash=?, zatca_type=? WHERE id=?`,
          [zatcaStamp.uuid, zatcaStamp.invoiceHash, zatcaStamp.previousInvoiceHash || null, 'simplified', orderId]);
      } catch(e) { /* older schema — ignore */ }
    }

    // Build recipe map: menu_id → [{ invId, invName, qtyUsed, wastePct }]
    // V5.6: now includes BOTH legacy `recipe` table AND modern `bom`/`bom_lines`.
    // Per menu item, BOM takes priority (it's the new system); recipe is the fallback.
    const recipeMap = {};

    // 1. Modern BOMs linked to menu items via menu.bom_id
    try {
      const [bomRows] = await db.query(`
        SELECT m.id AS menu_id, b.id AS bom_id, b.yield_quantity,
               bl.component_item_id, bl.quantity, bl.waste_pct,
               COALESCE(i.name, '') AS inv_name
        FROM menu m
        INNER JOIN bom b ON b.id = m.bom_id AND b.is_active = 1
        INNER JOIN bom_lines bl ON bl.bom_id = b.id
        LEFT JOIN inv_items i ON i.id = bl.component_item_id
        WHERE m.bom_id IS NOT NULL`);
      bomRows.forEach(r => {
        if (!recipeMap[r.menu_id]) recipeMap[r.menu_id] = [];
        const yieldQ = Math.max(1, Number(r.yield_quantity)||1);
        const wasteFactor = 1 + (Number(r.waste_pct)||0)/100;
        recipeMap[r.menu_id].push({
          invId: r.component_item_id,
          invName: r.inv_name || '',
          qtyUsed: (Number(r.quantity)||0) * wasteFactor / yieldQ,
          source: 'bom'
        });
      });
    } catch(_) {}

    // 2. Legacy recipe table — only used for menu items that DON'T have a BOM yet
    const [recipes] = await db.query('SELECT * FROM recipe');
    recipes.forEach(r => {
      if (recipeMap[r.menu_id]) return;  // BOM already covers this — skip legacy
      if (!recipeMap[r.menu_id]) recipeMap[r.menu_id] = [];
      recipeMap[r.menu_id].push({
        invId: r.inv_item_id,
        invName: r.inv_item_name || '',
        qtyUsed: Number(r.qty_used),
        source: 'legacy_recipe'
      });
    });

    // V5.7 — Build production-method map so we know how to handle each item:
    //   - made_at_branch  → made-to-order: do NOT touch menu.stock; only deduct ingredients
    //   - made_at_kitchen → same as branch but flagged for kitchen production logging
    //   - prepared        → batch-made (uses semi-finished or BOM); deduct ingredients
    //   - imported        → physical stocked goods; deduct from menu.stock + warehouse_stock
    const [productionMetaRows] = await db.query(
      `SELECT id, COALESCE(production_method, 'made_at_branch') AS production_method,
              COALESCE(deduct_strategy, 'on_sale') AS deduct_strategy,
              COALESCE(allow_negative_stock, 1) AS allow_negative_stock,
              stock
       FROM menu`);
    const productionMetaMap = {};
    productionMetaRows.forEach(r => {
      productionMetaMap[r.id] = {
        method: r.production_method,
        strategy: r.deduct_strategy,
        allowNegative: !!r.allow_negative_stock,
        currentStock: Number(r.stock) || 0
      };
    });

    // ─── NEW: Build semi-finished consumption map ───
    // For finished products that consume from a semi-finished (e.g. كوب شاي مغربي → براد شاي مغربي)
    const [menuRows] = await db.query(
      'SELECT id, name, consumes_semi_id, consumes_semi_qty FROM menu WHERE consumes_semi_id IS NOT NULL AND consumes_semi_id <> ""'
    );
    const semiConsumeMap = {};
    for (const m of menuRows) {
      semiConsumeMap[m.id] = { semiId: m.consumes_semi_id, semiQty: Number(m.consumes_semi_qty || 0) };
    }
    // Lookup semi-finished names for movement logs
    const semiNameMap = {};
    if (Object.keys(semiConsumeMap).length) {
      const semiIds = [...new Set(Object.values(semiConsumeMap).map(x => x.semiId))];
      const [semiRows] = await db.query(
        `SELECT id, name FROM menu WHERE id IN (${semiIds.map(()=>'?').join(',')})`,
        semiIds
      );
      semiRows.forEach(r => { semiNameMap[r.id] = r.name; });
    }

    // Production: removed debug log

    // Diagnostic info to return to the frontend so we can verify deductions worked
    const recipesApplied = []; // [{ menuId, menuName, deductions: [{invId, invName, deducted, affected}] }]
    const itemsWithoutRecipe = []; // menu items that have no recipe attached
    const semiDeductions = []; // [{ menuId, menuName, semiId, semiName, qty }]

    for (const item of items) {
      // sales_items log row
      await db.query('INSERT INTO sales_items (order_id, order_date, item_name, qty, price, total, payment_method, username, shift_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [orderId, now, item.name, item.qty, item.price, item.qty * item.price, payStr, username, shiftId]);

      // Stock deduction
      if (!item.id) {
        itemsWithoutRecipe.push({ name: item.name, reason: 'no item id' });
        continue;
      }

      // ─── NEW PATH: semi-finished consumption ───
      // If this finished product consumes from a semi-finished, deduct from the semi
      // (in warehouse_stock keyed by the semi's menu.id) instead of raw recipe.
      if (semiConsumeMap[item.id]) {
        const sc = semiConsumeMap[item.id];
        const consumed = sc.semiQty * item.qty;
        // Update menu.stock for the semi-finished (central total)
        await db.query('UPDATE menu SET stock = GREATEST(0, stock - ?) WHERE id = ?', [consumed, sc.semiId]);
        // Update warehouse_stock for the branch's warehouse
        if (warehouseId) {
          await db.query(
            'UPDATE warehouse_stock SET qty = GREATEST(0, qty - ?) WHERE warehouse_id = ? AND item_id = ?',
            [consumed, warehouseId, sc.semiId]
          );
        }
        // Movement log
        const movId = 'MOV-SEMI-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [movId, now, sc.semiId, semiNameMap[sc.semiId] || sc.semiId, 'out', consumed,
           'مبيعات (نصف مصنع)', username, orderId + ' / ' + item.name, warehouseId || null]
        );
        semiDeductions.push({
          menuId: item.id, menuName: item.name,
          semiId: sc.semiId, semiName: semiNameMap[sc.semiId] || sc.semiId,
          qty: consumed
        });
        // Skip the raw recipe deduction — semi covers it
        continue;
      }

      // V5.7 — For "imported" items (physically stocked goods like canned drinks),
      // ALSO deduct from menu.stock + warehouse_stock so the cashier sees the right
      // remaining count. For made-to-order (made_at_branch/kitchen/prepared) items,
      // skip menu.stock entirely — the only truth is the ingredients.
      const meta = productionMetaMap[item.id];
      if (meta && meta.method === 'imported') {
        try {
          await db.query(
            `UPDATE menu SET stock = ${meta.allowNegative ? 'stock - ?' : 'GREATEST(0, stock - ?)'} WHERE id = ?`,
            [item.qty, item.id]);
          if (warehouseId) {
            await db.query(
              `UPDATE warehouse_stock SET qty = ${meta.allowNegative ? 'qty - ?' : 'GREATEST(0, qty - ?)'} WHERE warehouse_id = ? AND item_id = ?`,
              [item.qty, warehouseId, item.id]);
          }
        } catch(_) {}
      }

      // ─── LEGACY PATH: raw recipe deduction (unchanged) ───
      if (!recipeMap[item.id]) {
        itemsWithoutRecipe.push({ id: item.id, name: item.name, reason: 'no recipe defined' });
        continue;
      }

      const deductions = [];
      for (const ing of recipeMap[item.id]) {
        const deduct = ing.qtyUsed * item.qty;

        // CRITICAL: deduct from central inventory
        const [updateResult] = await db.query(
          'UPDATE inv_items SET stock = stock - ? WHERE id = ?',
          [deduct, ing.invId]
        );
        const affected = updateResult.affectedRows;

        // Deduct from warehouse stock (branch-specific)
        if (warehouseId) {
          await db.query(
            'UPDATE warehouse_stock SET qty = GREATEST(0, qty - ?) WHERE warehouse_id = ? AND item_id = ?',
            [deduct, warehouseId, ing.invId]
          );
        }

        // Record movement with warehouse reference
        const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4) + '-' + deductions.length;
        await db.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [movId, now, ing.invId, ing.invName, 'out', deduct, 'مبيعات', username, orderId, warehouseId || null]
        );

        deductions.push({
          invId: ing.invId,
          invName: ing.invName,
          deducted: deduct,
          affected: affected
        });
      }

      recipesApplied.push({
        menuId: item.id,
        menuName: item.name,
        deductions: deductions
      });
    }

    // Production: removed debug log

    // ═══════════════════════════════════════════════════════════════
    // AUTO GL POSTING — Revenue + VAT + COGS
    // Two journals are conceptually one transaction (A + B), we combine
    // them into a single balanced journal:
    //   Dr Cash/Card/AR    totalFinal (split by payment)
    //   Cr Sales Revenue   net (totalFinal / (1 + VAT_RATE/100))
    //   Cr Output VAT      totalFinal - net
    //   Dr COGS            totalCogs
    //   Cr Inventory       totalCogs
    // All lines carry brand_id + branch_id; COGS/Inventory also carry warehouse_id.
    // ═══════════════════════════════════════════════════════════════
    let postingWarning = null;
    try {
      if (invTotal > 0) {
        // Compute total COGS from deductions × avg_cost
        const invIds = [...new Set(recipesApplied.flatMap(r => r.deductions.map(d => d.invId)))];
        let costMap = {};
        if (invIds.length) {
          const placeholders = invIds.map(() => '?').join(',');
          const [rows] = await db.query(
            `SELECT id, COALESCE(cost, 0) AS avg_cost FROM inv_items WHERE id IN (${placeholders})`,
            invIds);
          rows.forEach(r => { costMap[r.id] = Number(r.avg_cost) || 0; });
        }
        let totalCogs = 0;
        recipesApplied.forEach(r => {
          r.deductions.forEach(d => {
            totalCogs += (Number(d.deducted) || 0) * (costMap[d.invId] || 0);
          });
        });
        totalCogs = Math.round(totalCogs * 100) / 100;

        // Pull brand + branch from the user context (best-effort)
        let brandId = req.body.brandId || (req.user && req.user.brand_id) || null;
        let branchId = req.body.branchId || (req.user && req.user.branch_id) || null;
        if (!brandId || !branchId) {
          try {
            const [u] = await db.query('SELECT brand_id, branch_id FROM users WHERE username = ? LIMIT 1', [username]);
            if (u.length) {
              brandId = brandId || u[0].brand_id;
              branchId = branchId || u[0].branch_id;
            }
          } catch(e) {}
        }

        // V3: Build dynamic payment method → GL code map
        const pmGlMap = await _buildPmGlMap(db);
        const paymentDebits = _parseSplitPaymentsV3(payStr, invTotal, pmGlMap);

        const entries = [];
        // Debit(s) — by payment method (one per split, GL routed dynamically)
        paymentDebits.forEach(pd => {
          entries.push({
            accountCode: pd.code,
            debit: Math.round(pd.amount * 100) / 100, credit: 0,
            description: 'Sale receipt — ' + orderId + (resolvedChannelName ? ' (' + resolvedChannelName + ')' : ''),
            branchId: branchId || null, brandId: brandId || null
          });
        });
        // Credit Sales Revenue (net) — GROSS revenue (post-discount net) at minimum
        entries.push({
          accountCode: '4100',
          debit: 0, credit: net,
          description: 'Sales revenue — ' + orderId + (resolvedChannelName ? ' (' + resolvedChannelName + ')' : ''),
          branchId: branchId || null, brandId: brandId || null
        });
        // Credit Output VAT (if any)
        if (vat > 0) {
          entries.push({
            accountCode: '2210',
            debit: 0, credit: vat,
            description: 'Output VAT — ' + orderId,
            branchId: branchId || null, brandId: brandId || null
          });
        }

        // ─── V3: Discount entry (Dr Discount Allowed / Cr Sales Revenue add-back) ───
        // This makes the discount visible in GL while keeping net revenue == post-discount
        // (the add-back to 4100 cancels by adding gross-revenue contribution that the
        // discount took away). The net effect: Discount account shows the discount amount.
        const discAmt = Number(discountAmount) || 0;
        if (discAmt > 0) {
          const discCode = await _resolveDiscountGlCode(db, discountGlAccountId);
          entries.push({
            accountCode: discCode,
            debit: discAmt, credit: 0,
            description: 'Sales discount — ' + orderId + (discountName ? ' (' + discountName + ')' : ''),
            branchId: branchId || null, brandId: brandId || null
          });
          entries.push({
            accountCode: '4100',
            debit: 0, credit: discAmt,
            description: 'Sales discount add-back (gross revenue) — ' + orderId,
            branchId: branchId || null, brandId: brandId || null
          });
        }

        // COGS leg (if any cost)
        if (totalCogs > 0) {
          entries.push({
            accountCode: '5100',
            debit: totalCogs, credit: 0,
            description: 'COGS — ' + orderId,
            branchId: branchId || null, brandId: brandId || null,
            warehouseId: warehouseId || null
          });
          entries.push({
            accountCode: '1200',
            debit: 0, credit: totalCogs,
            description: 'Inventory reduction (sale) — ' + orderId,
            branchId: branchId || null, brandId: brandId || null,
            warehouseId: warehouseId || null
          });
        }

        const post = await gl.postJournal(db, {
          journalDate: now.toISOString().slice(0, 10),
          description: 'Sale ' + orderId + ' (' + (payStr || '—') + ')',
          referenceType: 'Sale',
          referenceId: orderId,
          entries,
          postedBy: username || ''
        });
        if (!post.success) postingWarning = post.error;
      }
    } catch (e) {
      postingWarning = e.message;
    }

    res.json({
      success: true,
      orderId,
      recipesApplied: recipesApplied,
      itemsWithoutRecipe: itemsWithoutRecipe,
      semiDeductions: semiDeductions,
      postingWarning: postingWarning,
      zatca: {
        uuid: zatcaStamp.uuid || null,
        invoiceHash: zatcaStamp.invoiceHash || null,
        previousInvoiceHash: zatcaStamp.previousInvoiceHash || null,
        qrBase64: zatcaStamp.qrBase64 || null
      },
      totals: { total: invTotal, net, vat }
    });
  } catch (e) {
    // Production: removed debug log
    res.json({ success: false, error: e.message });
  }
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

// Delete sale (developer only — frontend checks isDeveloper)
router.delete('/:orderId', async (req, res) => {
  try {
    await db.query('DELETE FROM sales WHERE id = ?', [req.params.orderId]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Bulk delete sales
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ success: false, error: 'No IDs' });
    const placeholders = ids.map(() => '?').join(',');
    await db.query('DELETE FROM sales WHERE id IN (' + placeholders + ')', ids);
    res.json({ success: true, deleted: ids.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// ADVANCED FULL REPORT (التقارير المتطورة)
// ═══════════════════════════════════════

router.get('/report/advanced', async (req, res) => {
  try {
    const { startDate, endDate, username, paymentMethod } = req.query;

    // Build WHERE clause for sales
    let salesWhere = '1=1';
    const salesParams = [];
    if (startDate) { salesWhere += ' AND DATE(order_date) >= ?'; salesParams.push(startDate); }
    if (endDate)   { salesWhere += ' AND DATE(order_date) <= ?'; salesParams.push(endDate); }
    if (username)  { salesWhere += ' AND username = ?'; salesParams.push(username); }
    if (paymentMethod) { salesWhere += ' AND LOWER(payment_method) LIKE ?'; salesParams.push('%' + paymentMethod.toLowerCase() + '%'); }

    // 1) Fetch all sales in range (we need rows for payment parsing + product detail)
    const [allSales] = await db.query(
      `SELECT id, order_date, items_json, total_final, payment_method, username,
              discount_name, discount_amount, kita_service_fee
       FROM sales WHERE ${salesWhere} ORDER BY order_date`, salesParams
    );

    // ── Aggregate stats ──
    let totalSales = 0, totalDiscount = 0, totalKitaFees = 0;
    const orderCount = allSales.length;
    allSales.forEach(s => {
      totalSales += Number(s.total_final) || 0;
      totalDiscount += Number(s.discount_amount) || 0;
      totalKitaFees += Number(s.kita_service_fee) || 0;
    });

    // ── Payment method breakdown (supports split: "cash:100/card:50") ──
    const pay = { cash: { total: 0, count: 0 }, card: { total: 0, count: 0 }, kita: { total: 0, count: 0 } };

    function addPayment(method, amount) {
      const m = method.toLowerCase().trim();
      if (m.includes('kita'))      { pay.kita.total += amount; pay.kita.count++; }
      else if (m.includes('card') || m.includes('mada') || m.includes('شبكة') || m.includes('مدى'))
                                   { pay.card.total += amount; pay.card.count++; }
      else                         { pay.cash.total += amount; pay.cash.count++; }
    }

    allSales.forEach(s => {
      const pm = (s.payment_method || 'cash').trim();
      const total = Number(s.total_final) || 0;
      // Check for split payment format: "cash:100/card:50"
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, amt] = part.split(':');
          if (method && amt) addPayment(method, Number(amt) || 0);
        });
      } else {
        addPayment(pm, total);
      }
    });

    // ── Charts data ──

    // Sales by day
    const dayMap = {};
    allSales.forEach(s => {
      const d = new Date(s.order_date);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      dayMap[key] = (dayMap[key] || 0) + (Number(s.total_final) || 0);
    });
    const salesByDay = Object.entries(dayMap).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, value]) => ({ label, value }));

    // Sales by hour
    const hourMap = {};
    for (let i = 0; i < 24; i++) hourMap[i] = 0;
    allSales.forEach(s => {
      const h = new Date(s.order_date).getHours();
      hourMap[h] += Number(s.total_final) || 0;
    });
    const salesByHour = Object.entries(hourMap).map(([h, value]) => ({ label: h + ':00', value }));

    // Sales by cashier
    const cashierMap = {};
    allSales.forEach(s => {
      const u = s.username || 'unknown';
      if (!cashierMap[u]) cashierMap[u] = { total: 0, count: 0, cash: 0, card: 0, kita: 0 };
      cashierMap[u].total += Number(s.total_final) || 0;
      cashierMap[u].count++;
      // Payment breakdown per cashier
      const pm = (s.payment_method || 'cash').trim();
      const amt = Number(s.total_final) || 0;
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, a] = part.split(':');
          const val = Number(a) || 0;
          const ml = (method || '').toLowerCase();
          if (ml.includes('kita')) cashierMap[u].kita += val;
          else if (ml.includes('card') || ml.includes('mada')) cashierMap[u].card += val;
          else cashierMap[u].cash += val;
        });
      } else {
        const ml = pm.toLowerCase();
        if (ml.includes('kita')) cashierMap[u].kita += amt;
        else if (ml.includes('card') || ml.includes('mada') || ml.includes('شبكة') || ml.includes('مدى')) cashierMap[u].card += amt;
        else cashierMap[u].cash += amt;
      }
    });
    const salesByCashier = Object.entries(cashierMap)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([label, v]) => ({ label, value: v.total }));

    // Top products (from items_json)
    const prodMap = {}; // name → {qty, revenue, orders}
    allSales.forEach(s => {
      try {
        const items = JSON.parse(s.items_json || '[]');
        const orderProducts = new Set();
        items.forEach(item => {
          const name = item.name || 'Unknown';
          if (!prodMap[name]) prodMap[name] = { qty: 0, revenue: 0, orders: 0 };
          prodMap[name].qty += Number(item.qty) || 0;
          prodMap[name].revenue += (Number(item.qty) || 0) * (Number(item.price) || 0);
          orderProducts.add(name);
        });
        orderProducts.forEach(n => { prodMap[n].orders++; });
      } catch (e) { /* ignore parse errors */ }
    });
    const topProducts = Object.entries(prodMap)
      .sort((a, b) => b[1].qty - a[1].qty)
      .slice(0, 5)
      .map(([label, v]) => ({ label, value: v.qty }));

    // ── Tables data ──

    // Daily detail
    const dailyMap = {};
    allSales.forEach(s => {
      const d = new Date(s.order_date);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (!dailyMap[key]) dailyMap[key] = { date: key, cash: 0, card: 0, kita: 0, total: 0, orders: 0, discount: 0 };
      dailyMap[key].total += Number(s.total_final) || 0;
      dailyMap[key].orders++;
      dailyMap[key].discount += Number(s.discount_amount) || 0;
      // Payment breakdown per day
      const pm = (s.payment_method || 'cash').trim();
      const amt = Number(s.total_final) || 0;
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, a] = part.split(':');
          const val = Number(a) || 0;
          const ml = (method || '').toLowerCase();
          if (ml.includes('kita')) dailyMap[key].kita += val;
          else if (ml.includes('card') || ml.includes('mada')) dailyMap[key].card += val;
          else dailyMap[key].cash += val;
        });
      } else {
        const ml = pm.toLowerCase();
        if (ml.includes('kita')) dailyMap[key].kita += amt;
        else if (ml.includes('card') || ml.includes('mada') || ml.includes('شبكة') || ml.includes('مدى')) dailyMap[key].card += amt;
        else dailyMap[key].cash += amt;
      }
    });
    const dailyDetail = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // Cashier detail
    const cashierDetail = Object.entries(cashierMap)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, v]) => ({ name, cash: v.cash, card: v.card, kita: v.kita, total: v.total, orders: v.count }));

    // Product detail (all products, sorted by qty)
    const productDetail = Object.entries(prodMap)
      .sort((a, b) => b[1].qty - a[1].qty)
      .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue, orders: v.orders }));

    // ── Expenses by category (date filters only) ──
    let expWhere = '1=1';
    const expParams = [];
    if (startDate) { expWhere += ' AND DATE(expense_date) >= ?'; expParams.push(startDate); }
    if (endDate)   { expWhere += ' AND DATE(expense_date) <= ?'; expParams.push(endDate); }

    const [expRows] = await db.query(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS cnt FROM expenses
       WHERE ${expWhere} GROUP BY category ORDER BY total DESC`, expParams
    );
    const expensesByCategory = expRows.map(r => ({ category: r.category || 'أخرى', total: Number(r.total), count: r.cnt }));
    const totalExp = expensesByCategory.reduce((sum, e) => sum + e.total, 0);

    // ── Purchases by supplier (date filters only, received only) ──
    let purWhere = "status = 'received'";
    const purParams = [];
    if (startDate) { purWhere += ' AND DATE(purchase_date) >= ?'; purParams.push(startDate); }
    if (endDate)   { purWhere += ' AND DATE(purchase_date) <= ?'; purParams.push(endDate); }

    const [purRows] = await db.query(
      `SELECT supplier_name, SUM(total_price) AS total, COUNT(*) AS cnt FROM purchases
       WHERE ${purWhere} GROUP BY supplier_name ORDER BY total DESC`, purParams
    );
    const purchasesBySupplier = purRows.map(r => ({ supplier: r.supplier_name || 'غير محدد', total: Number(r.total), count: r.cnt }));
    const totalPur = purchasesBySupplier.reduce((sum, p) => sum + p.total, 0);

    // ── Computed stats ──
    const activeDays = salesByDay.length || 1;
    const avgOrderValue = orderCount > 0 ? totalSales / orderCount : 0;
    const avgDailyRevenue = totalSales / activeDays;
    const netProfit = totalSales - totalExp - totalPur;
    const profitMargin = totalSales > 0 ? ((netProfit / totalSales) * 100).toFixed(1) : '0.0';

    // ── Sales list for Excel export ──
    const salesList = allSales.map(s => ({
      orderId: s.id,
      date: s.order_date,
      username: s.username,
      paymentMethod: s.payment_method,
      discountName: s.discount_name || '',
      discountAmount: Number(s.discount_amount) || 0,
      total: Number(s.total_final) || 0
    }));

    res.json({
      success: true,
      stats: {
        totalSales, totalExp, totalPur, totalDiscount, totalKitaFees,
        orderCount, activeDays, avgOrderValue, avgDailyRevenue,
        netProfit, profitMargin
      },
      payments: pay,
      charts: { salesByDay, salesByHour, salesByCashier, topProducts },
      tables: { dailyDetail, cashierDetail, productDetail, expensesByCategory, purchasesBySupplier },
      salesList
    });

  } catch (e) {
    // Production: removed debug log
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
