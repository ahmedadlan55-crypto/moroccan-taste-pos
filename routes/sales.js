const router = require('express').Router();
const db = require('../db/connection');
const gl = require('../lib/glPosting');
const zatca = require('../lib/zatca');
const { recomputeInvItemStock, recomputeMenuStock } = require('../lib/stockRecompute');

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

// V5.7.18 — same Arabic normalization the shift-close matcher uses.
//   So "مدى" / "مدي" / "Mada" / "MADA" all match the same payment-method
//   regardless of which variant the cashier typed at sale time.
function _normPmName(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
}

// Build a payment-method → GL account code map by joining payment_methods.gl_account_id → gl_accounts.code
// Returns: { 'cash': '1110', 'card': '1120', 'hangerstation': '4150', ... }
// V5.7.18 — keys normalized; both name and name_ar registered so the
//   sale's payment_method string resolves to the configured GL even
//   when the cashier typed an Arabic variant (مدى vs مدي).
async function _buildPmGlMap(db) {
  const map = {};
  try {
    const [rows] = await db.query(`
      SELECT pm.id, pm.name, pm.name_ar, ga.code AS gl_code
        FROM payment_methods pm
        LEFT JOIN gl_accounts ga ON ga.id = pm.gl_account_id
       WHERE pm.is_active = 1 AND pm.gl_account_id IS NOT NULL AND pm.gl_account_id <> ''
    `);
    rows.forEach(r => {
      if (!r.gl_code) return;
      // Index by id, normalized name, and normalized name_ar (each token of name_ar split on '/')
      if (r.id != null)  map[String(r.id)] = r.gl_code;
      const k1 = _normPmName(r.name);
      const k2 = _normPmName(r.name_ar);
      if (k1) map[k1] = r.gl_code;
      if (k2) map[k2] = r.gl_code;
      // Tokenize Arabic name on common separators ("مدى/شبكة" → "مدى" and "شبكة")
      String(r.name_ar || '').split(/[\/،\-,]/).forEach(p => {
        const k = _normPmName(p);
        if (k && !map[k]) map[k] = r.gl_code;
      });
    });
  } catch(e) { /* gl_account_id column may be missing on very old schemas — ignore */ }
  return map;
}

// V3: parse split payment using the dynamic GL map (falls back to legacy mapping)
// V5.7.18 — lookup uses the SAME normalization as the map build so مدى and
//   مدي resolve to the same GL account.
function _parseSplitPaymentsV3(payStr, total, pmGlMap) {
  const out = [];
  const lookup = (name) => {
    const k = _normPmName(name);
    return (pmGlMap && pmGlMap[k]) || _payToAccountCode(name);
  };
  if (!payStr || payStr.indexOf(':') < 0) {
    out.push({ code: lookup(payStr), amount: Number(total) || 0 });
    return out;
  }
  // Split-payment requires BOTH '/' AND ':' (else a name like "مدى/شبكة"
  //   gets misparsed — same fix pattern as the shift matcher).
  if (payStr.indexOf('/') < 0) {
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
    // V5.9.2 — 4-step fallback chain to resolve which warehouse the
    //   cashier's sale should deduct from:
    //     1. Explicit warehouseId in the request body (POS override)
    //     2. Cashier's user.default_warehouse_id
    //     3. Cashier's branch's warehouse_id (the natural one)
    //     4. null (will skip warehouse-specific deduction; global stock
    //        on inv_items is the only thing that updates).
    let warehouseId = reqWhId || (req.user && req.user.default_warehouse_id) || null;
    if (!warehouseId && username) {
      try {
        const [u] = await db.query(
          'SELECT u.branch_id, b.warehouse_id ' +
          'FROM users u LEFT JOIN branches b ON b.id = u.branch_id ' +
          'WHERE u.username = ? LIMIT 1',
          [username]
        );
        if (u.length && u[0].warehouse_id) {
          warehouseId = u[0].warehouse_id;
        }
      } catch(e) { /* legacy schema — ignore */ }
    }
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

    // 3. v5.12.3 — Channel-specific BOM overrides. If this sale was made
    // through a sales channel that has a custom bom_id on any of its
    // channel_menu_items, that BOM replaces the menu's default for the
    // matching item only. Lets one main menu product expose different
    // recipes per channel (e.g. delivery uses larger packaging).
    if (channelId) {
      try {
        const itemIds = items.map(it => it.id).filter(Boolean);
        if (itemIds.length) {
          const ph = itemIds.map(() => '?').join(',');
          const [overrides] = await db.query(
            `SELECT cmi.menu_item_id, b.yield_quantity,
                    bl.component_item_id, bl.quantity, bl.waste_pct,
                    COALESCE(i.name, '') AS inv_name
             FROM channel_menu_items cmi
             INNER JOIN bom b ON b.id = cmi.bom_id AND b.is_active = 1
             INNER JOIN bom_lines bl ON bl.bom_id = b.id
             LEFT JOIN inv_items i ON i.id = bl.component_item_id
             WHERE cmi.channel_id = ? AND cmi.bom_id IS NOT NULL
               AND cmi.menu_item_id IN (${ph})`,
            [channelId, ...itemIds]
          );
          if (overrides.length) {
            const overrideMap = {};
            overrides.forEach(r => {
              if (!overrideMap[r.menu_item_id]) overrideMap[r.menu_item_id] = [];
              const yieldQ = Math.max(1, Number(r.yield_quantity) || 1);
              const wasteFactor = 1 + (Number(r.waste_pct) || 0) / 100;
              overrideMap[r.menu_item_id].push({
                invId:   r.component_item_id,
                invName: r.inv_name || '',
                qtyUsed: (Number(r.quantity) || 0) * wasteFactor / yieldQ,
                source:  'channel_override'
              });
            });
            // Replace recipeMap entries for items the channel overrides
            Object.keys(overrideMap).forEach(mid => { recipeMap[mid] = overrideMap[mid]; });
            console.log('[sales] channel ' + channelId + ' overrode recipe for ' +
                        Object.keys(overrideMap).length + ' item(s)');
          }
        }
      } catch (e) { console.warn('[sales] channel recipe override failed:', e.message); }
    }

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
        // v5.10.19 — warehouse_stock is the source of truth. menu.stock for
        // semi-finished products becomes a SUM(warehouse_stock.qty) rollup
        // so multi-warehouse balances stay independent.
        if (warehouseId) {
          await db.query(
            'UPDATE warehouse_stock SET qty = GREATEST(0, qty - ?) WHERE warehouse_id = ? AND item_id = ?',
            [consumed, warehouseId, sc.semiId]
          );
          await recomputeMenuStock(db, sc.semiId);
        } else {
          // Legacy fallback: no warehouse — deduct global menu.stock directly.
          await db.query('UPDATE menu SET stock = GREATEST(0, stock - ?) WHERE id = ?', [consumed, sc.semiId]);
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
      // v5.10.19 — warehouse_stock leads, menu.stock is recomputed as the sum.
      const meta = productionMetaMap[item.id];
      if (meta && meta.method === 'imported') {
        try {
          if (warehouseId) {
            await db.query(
              `UPDATE warehouse_stock SET qty = ${meta.allowNegative ? 'qty - ?' : 'GREATEST(0, qty - ?)'} WHERE warehouse_id = ? AND item_id = ?`,
              [item.qty, warehouseId, item.id]);
            await recomputeMenuStock(db, item.id);
          } else {
            // Legacy: no warehouse → write global menu.stock directly.
            await db.query(
              `UPDATE menu SET stock = ${meta.allowNegative ? 'stock - ?' : 'GREATEST(0, stock - ?)'} WHERE id = ?`,
              [item.qty, item.id]);
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

        // v5.10.19 — Deduct from per-warehouse balance first (source of
        // truth), then recompute the global inv_items.stock rollup. This
        // means W1's sale never touches W2's balance, and the global field
        // always equals SUM(warehouse_stock) without drift.
        let affected = 0;
        if (warehouseId) {
          const [whRes] = await db.query(
            'UPDATE warehouse_stock SET qty = GREATEST(0, qty - ?) WHERE warehouse_id = ? AND item_id = ?',
            [deduct, warehouseId, ing.invId]
          );
          affected = whRes.affectedRows;
          await recomputeInvItemStock(db, ing.invId);
        } else {
          // Legacy fallback: no warehouse context — direct global write.
          const [updateResult] = await db.query(
            'UPDATE inv_items SET stock = stock - ? WHERE id = ?',
            [deduct, ing.invId]
          );
          affected = updateResult.affectedRows;
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
// V5.7.9 — also returns cashier full-name, branch name+address, and company
//          contact info (phone/email) so the printed receipt can render the
//          full bilingual layout the user expects (matches printed sample).
router.get('/invoice/:orderId', async (req, res) => {
  try {
    const [sales] = await db.query('SELECT * FROM sales WHERE id = ?', [req.params.orderId]);
    if (!sales.length) return res.json(null);
    const sale = sales[0];
    const [items] = await db.query('SELECT * FROM sales_items WHERE order_id = ?', [req.params.orderId]);

    // ── Lookup cashier display name from settings.user_meta ──
    // The receipt shows "You were served by : <FullName>, <empNo>".
    // empNo is OPTIONAL — only printed when explicitly set in user_meta;
    // falling back to username here would render "John Smith, j.smith" which
    // looks redundant. So default empNo to '' and let the frontend hide it.
    let cashierName = sale.username || '';
    let cashierEmpNo = '';
    try {
      const [metaRows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
      if (metaRows.length && metaRows[0].setting_value) {
        const meta = JSON.parse(metaRows[0].setting_value) || {};
        const me = meta[sale.username] || {};
        if (me.name)  cashierName  = me.name;
        if (me.empNo) cashierEmpNo = me.empNo;
      }
    } catch (_) { /* fall back to username for the name; empNo stays empty */ }

    // ── Lookup the branch: prefer the shift's branch, else the user's primary branch ──
    let branchName = '', branchAddress = '', branchLat = null, branchLng = null;
    let branchCompanyName = '';  // V5.7.14 — operating company per branch
    try {
      let branchId = null;
      if (sale.shift_id) {
        const [shiftRows] = await db.query('SELECT branch_id FROM shifts WHERE id = ?', [sale.shift_id]);
        if (shiftRows.length && shiftRows[0].branch_id) branchId = shiftRows[0].branch_id;
      }
      if (!branchId && sale.username) {
        const [ub] = await db.query('SELECT branch_id FROM user_branches WHERE username = ? LIMIT 1', [sale.username]);
        if (ub.length) branchId = ub[0].branch_id;
      }
      if (branchId) {
        const [br] = await db.query('SELECT name, location, company_name, geo_lat, geo_lng FROM branches WHERE id = ?', [branchId]);
        if (br.length) {
          branchName = br[0].name || '';
          branchAddress = br[0].location || '';
          branchLat = br[0].geo_lat;
          branchLng = br[0].geo_lng;
          // V5.7.14 — operating-company name shown on receipt below the parent brand
          branchCompanyName = br[0].company_name || '';
        }
      }
    } catch (_) { /* shifts.branch_id or user_branches may not exist on legacy schemas — ignore */ }

    // ── Pull company contact + branding from settings ──
    let companyName = 'Moroccan Taste', taxNumber = '', currency = 'SAR';
    let companyPhone = '', companyEmail = '', companyLogo = '';
    try {
      const [setRows] = await db.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyPhone','CompanyEmail','logo')"
      );
      const map = {};
      setRows.forEach(r => { map[r.setting_key] = r.setting_value; });
      companyName  = map.CompanyName  || companyName;
      taxNumber    = map.TaxNumber    || '';
      currency     = map.Currency     || 'SAR';
      companyPhone = map.CompanyPhone || '';
      companyEmail = map.CompanyEmail || '';
      companyLogo  = map.logo         || '';
    } catch (_) { /* settings table missing — ignore, defaults already set */ }

    // V5.7.26 — per-brand logo: if the sale has a brand_id, prefer THAT
    //   brand's logo over the company-wide one. So Burger Wagef sales
    //   print with the Burger Wagef logo, Hangerstation with theirs, etc.
    let brandLogo = '';
    let brandName = '';
    try {
      let brandId = sale.brand_id;
      if (!brandId && sale.username) {
        // Fallback: derive from the user's primary brand
        const [ub] = await db.query('SELECT brand_id FROM user_brands WHERE username = ? LIMIT 1', [sale.username]);
        if (ub.length) brandId = ub[0].brand_id;
      }
      if (brandId) {
        const [br] = await db.query('SELECT name, logo FROM brands WHERE id = ?', [brandId]);
        if (br.length) {
          brandName = br[0].name || '';
          brandLogo = br[0].logo || '';
        }
      }
    } catch (_) { /* brands table or brand_id column may not exist on legacy schemas */ }

    res.json({
      orderId: sale.id, date: sale.order_date, payment: sale.payment_method,
      totalFinal: Number(sale.total_final), username: sale.username,
      discountName: sale.discount_name, discountAmount: Number(sale.discount_amount),
      items: items.map(i => ({ name: i.item_name, qty: i.qty, price: Number(i.price), total: Number(i.total) })),
      // V5.7.9 — receipt enrichment
      cashierName: cashierName,
      cashierEmpNo: cashierEmpNo,
      branchName: branchName,
      branchAddress: branchAddress,
      branchLat: branchLat,
      branchLng: branchLng,
      // V5.7.14 — operating company per branch (printed under parent brand)
      branchCompanyName: branchCompanyName,
      companyName: companyName,
      taxNumber: taxNumber,
      currency: currency,
      companyPhone: companyPhone,
      companyEmail: companyEmail,
      // V5.7.26 — receiptLogo prefers brand logo > company logo
      companyLogo: companyLogo,
      brandName: brandName,
      brandLogo: brandLogo,
      receiptLogo: brandLogo || companyLogo
    });
  } catch (e) { res.json(null); }
});

// v5.10.29 — Reverse a sale's stock + GL effects, then optionally hard-delete.
// This is the proper way to undo a sale: it restores warehouse_stock,
// writes reversing inventory_movements, and reverses the GL journal so
// books stay balanced. Wrapped in a transaction so a partial reversal can
// never leave phantom stock or unbalanced GL.
//
// Returns:
//   { success, restored: [...], reversedGl: bool, deletedSale: bool }
async function _reverseSaleEffects(conn, orderId, username, opts) {
  opts = opts || {};
  const c = conn || db;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const restored = [];

  // 1. Find every "out" movement that came from this sale (sale-creation
  //    code stamps notes with orderId or "orderId / itemName").
  const [movs] = await c.query(
    `SELECT id, item_id, item_name, qty, warehouse_id, reason
       FROM inventory_movements
      WHERE type = 'out'
        AND (notes = ? OR notes LIKE CONCAT(?, ' /%') OR notes LIKE CONCAT(?, ' / %'))
        AND reason IN ('مبيعات', 'مبيعات (نصف مصنع)')`,
    [orderId, orderId, orderId]
  );

  for (const m of movs) {
    // 2a. Restore warehouse_stock if a warehouse was tracked
    if (m.warehouse_id) {
      try {
        await c.query(
          'UPDATE warehouse_stock SET qty = qty + ?, last_updated = ? WHERE warehouse_id = ? AND item_id = ?',
          [Number(m.qty) || 0, now, m.warehouse_id, m.item_id]);
      } catch (_) { /* row may have been deleted; non-fatal */ }
    } else {
      // Legacy path: deduction happened against inv_items.stock directly
      try {
        await c.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?',
          [Number(m.qty) || 0, m.item_id]);
      } catch (_) {}
    }

    // 2b. Write a reversing movement so the warehouse ledger is honest
    const reverseId = 'MOV-VOID-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
    try {
      await c.query(
        `INSERT INTO inventory_movements
          (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [reverseId, now, m.item_id, m.item_name, 'in', Number(m.qty) || 0,
         'عكس بيع', username || 'system',
         'void of ' + orderId + ' (mov ' + m.id + ')',
         m.warehouse_id || null]);
    } catch (_) {}

    restored.push({
      itemId: m.item_id, itemName: m.item_name,
      qty: Number(m.qty) || 0, warehouseId: m.warehouse_id || null
    });
  }

  // 3. Recompute global stock for each affected item once
  const itemIds = Array.from(new Set(movs.map(m => m.item_id))).filter(Boolean);
  for (const id of itemIds) {
    try { await recomputeInvItemStock(c, id); } catch (_) {}
  }

  // 4. Reverse the GL journal for this sale
  let reversedGl = false;
  try {
    const [journals] = await c.query(
      'SELECT id FROM gl_journals WHERE reference_type = ? AND reference_id = ?',
      ['Sale', orderId]);
    for (const j of journals) {
      const [entries] = await c.query('SELECT * FROM gl_entries WHERE journal_id = ?', [j.id]);
      for (const e of entries) {
        if (e.account_id) {
          const reverseAmount = (Number(e.credit) || 0) - (Number(e.debit) || 0);
          await c.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?',
            [reverseAmount, e.account_id]);
        }
      }
      await c.query('DELETE FROM gl_entries WHERE journal_id = ?', [j.id]);
      await c.query('DELETE FROM gl_journals WHERE id = ?', [j.id]);
      reversedGl = true;
    }
  } catch (_) { /* gl tables missing on stale deploy; non-fatal */ }

  // 5. Optionally hard-delete the sale row + lines
  let deletedSale = false;
  if (opts.deleteSale) {
    try { await c.query('DELETE FROM sales_items WHERE order_id = ?', [orderId]); } catch (_) {}
    await c.query('DELETE FROM sales WHERE id = ?', [orderId]);
    deletedSale = true;
  }

  return { restored, reversedGl, deletedSale };
}

// POST /sales/:orderId/void — reverse stock + GL but KEEP the sale row.
// This is the recommended path when you need an audit trail (the sale
// remains visible in reports as voided). Use ?delete=1 to also drop the row.
router.post('/:orderId/void', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const username = (req.user && req.user.username) || (req.body && req.body.username) || 'system';
    const [sale] = await db.query('SELECT id FROM sales WHERE id = ?', [orderId]);
    if (!sale.length) return res.status(404).json({ success: false, error: 'sale-not-found' });

    const wantDelete = req.query.delete === '1';
    const runner = async (conn) => _reverseSaleEffects(conn, orderId, username, { deleteSale: wantDelete });

    let result;
    try {
      result = (typeof db.withTransaction === 'function')
        ? await db.withTransaction(runner)
        : await runner(null);
    } catch (txErr) {
      console.error('[POST /sales/:id/void] tx failed:', txErr.message);
      return res.status(500).json({ success: false, error: txErr.message });
    }

    res.json({ success: true, orderId, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete sale (developer only — frontend checks isDeveloper)
// v5.10.29 — DELETE is no longer a silent destructor. It now:
//   * reverses warehouse_stock + GL journal automatically (so books balance)
//   * deletes the sale row (sales_items cascades via FK)
//   * accepts ?force=1 to skip reversal (legacy emergency mode — leaves
//     phantom stock; do NOT use in normal operation)
router.delete('/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const username = (req.user && req.user.username) || 'system';
    if (req.query.force === '1') {
      await db.query('DELETE FROM sales WHERE id = ?', [orderId]);
      return res.json({ success: true, force: true, warning: 'inventory + GL NOT reversed' });
    }
    const [sale] = await db.query('SELECT id FROM sales WHERE id = ?', [orderId]);
    if (!sale.length) return res.status(404).json({ success: false, error: 'sale-not-found' });

    const runner = async (conn) => _reverseSaleEffects(conn, orderId, username, { deleteSale: true });
    let result;
    try {
      result = (typeof db.withTransaction === 'function')
        ? await db.withTransaction(runner)
        : await runner(null);
    } catch (txErr) {
      return res.status(500).json({ success: false, error: txErr.message });
    }
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Bulk delete sales — same reversal semantics applied to each id.
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids, force } = req.body || {};
    if (!ids || !ids.length) return res.status(400).json({ success: false, error: 'No IDs' });
    const username = (req.user && req.user.username) || 'system';

    if (force) {
      const placeholders = ids.map(() => '?').join(',');
      await db.query('DELETE FROM sales WHERE id IN (' + placeholders + ')', ids);
      return res.json({ success: true, deleted: ids.length, force: true, warning: 'inventory + GL NOT reversed' });
    }

    const reversed = [];
    for (const id of ids) {
      try {
        const runner = async (conn) => _reverseSaleEffects(conn, id, username, { deleteSale: true });
        const r = (typeof db.withTransaction === 'function')
          ? await db.withTransaction(runner)
          : await runner(null);
        reversed.push({ id, ...r });
      } catch (e) {
        reversed.push({ id, error: e.message });
      }
    }
    res.json({ success: true, deleted: reversed.length, results: reversed });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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
