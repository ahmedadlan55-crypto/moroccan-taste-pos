const router = require('express').Router();
const db = require('../db/connection');
const { recomputeInvItemStock } = require('../lib/stockRecompute');
const POLICY = require('../lib/inventoryItemPolicy');
async function _assertLegacyInboundItems(items, resolveFn) {
  // Phase 4B — reject the whole receive UP FRONT if any line is a tracked or
  // inactive item, so the autocommit loop never half-receives.
  for (const it of (items || [])) {
    const inv = await resolveFn(it, db);
    if (!inv) continue;
    const [m] = await db.query('SELECT name, tracking_mode, active, deleted_at FROM inv_items WHERE id=? LIMIT 1', [inv.id]);
    if (m.length) { try { POLICY.assertLegacyInbound(m[0]); } catch (e) { e.status = 422; throw e; } }
  }
}
// v7.5 — purchase receipts finally post GL (Dr Inventory + Input VAT /
// Cr Cash|Bank|AP by payment method). Without it every receipt left the
// balance sheet missing both the asset increase and the liability.
const gl = require('../lib/glPosting');
// v7.4 — RBAC: MGR for managerial actions (PO approve / revert / delete);
// BACKOFFICE for operational receiving (any authenticated role but cashier).
const requireRole = require('./authMiddleware').requireRole;
const MGR = requireRole('admin', 'manager');
const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');

// ─── Purchases ───

// Get purchases (with filters)
router.get('/', async (req, res) => {
  try {
    let query = `SELECT p.*, b.name AS brand_name, br.name AS branch_name
                 FROM purchases p
                 LEFT JOIN brands   b  ON b.id  = p.brand_id
                 LEFT JOIN branches br ON br.id = p.branch_id
                 WHERE 1=1`;
    const params = [];

    if (req.query.startDate) { query += ' AND DATE(p.purchase_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate)   { query += ' AND DATE(p.purchase_date) <= ?'; params.push(req.query.endDate); }
    if (req.query.supplierId){ query += ' AND p.supplier_id = ?';          params.push(req.query.supplierId); }
    if (req.query.status)    { query += ' AND p.status = ?';               params.push(req.query.status); }
    if (req.query.brandId)   { query += ' AND p.brand_id = ?';             params.push(req.query.brandId); }
    if (req.query.branchId)  { query += ' AND p.branch_id = ?';            params.push(req.query.branchId); }
    if (req.query.paymentMethod) { query += ' AND p.payment_method = ?';   params.push(req.query.paymentMethod); }

    query += ' ORDER BY p.purchase_date DESC LIMIT 500';

    const [rows] = await db.query(query, params);
    res.json(rows.map(p => ({
      id: p.id, date: p.purchase_date, supplierName: p.supplier_name, supplierId: p.supplier_id,
      itemName: p.item_name, itemId: p.item_id,
      qty: Number(p.qty), unitPrice: Number(p.unit_price), totalPrice: Number(p.total_price),
      paymentMethod: p.payment_method, username: p.username, notes: p.notes,
      status: p.status, items: JSON.parse(p.items_json || '[]'), itemsJson: p.items_json || '[]', poId: p.po_id,
      brandId: p.brand_id || '', brandName: p.brand_name || '',
      branchId: p.branch_id || '', branchName: p.branch_name || ''
    })));
  } catch (e) {
    res.json([]);
  }
});

// Add purchase batch
router.post('/', async (req, res) => {
  try {
    const { supplierName, supplierId, items, paymentMethod, username, notes, poId, brandId, branchId } = req.body;
    const now = new Date();
    const purchaseId = 'PUR-' + Date.now();

    // v7.5 — reject non-positive quantities at the door (a direct API call
    // could otherwise persist negative/zero lines into items_json).
    if (Array.isArray(items)) {
      for (const it of items) {
        if ((Number(it.qty) || 0) <= 0) {
          return res.status(400).json({
            success: false, code: 'qty_must_be_positive',
            error: 'كمية غير صالحة للصنف "' + (it.name || it.itemName || '؟') + '" — يجب أن تكون أكبر من صفر'
          });
        }
      }
    }

    // Resolve brand/branch from supplier if not provided
    let resolvedBrandId = brandId || null;
    let resolvedBranchId = branchId || null;
    if (!resolvedBrandId && supplierId) {
      try {
        const [sRows] = await db.query('SELECT brand_id FROM suppliers WHERE id = ? LIMIT 1', [supplierId]);
        if (sRows.length && sRows[0].brand_id) resolvedBrandId = sRows[0].brand_id;
      } catch(e) { /* no-op */ }
    }

    let totalPrice = 0;
    if (items && items.length) {
      for (const item of items) {
        totalPrice += (Number(item.qty) || 0) * (Number(item.unitPrice) || 0);
      }
    }

    await db.query(
      `INSERT INTO purchases (id, purchase_date, supplier_name, supplier_id, item_name, item_id, qty, unit_price, total_price, payment_method, username, notes, status, items_json, po_id, brand_id, branch_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [purchaseId, now, supplierName || '', supplierId || null,
       items && items.length === 1 ? items[0].name : 'متعدد',
       items && items.length === 1 ? items[0].id : null,
       items && items.length === 1 ? items[0].qty : 0,
       items && items.length === 1 ? items[0].unitPrice : 0,
       totalPrice, paymentMethod || 'آجل', username || '', notes || '',
       'draft', JSON.stringify(items || []), poId || null,
       resolvedBrandId, resolvedBranchId]
    );

    res.json({ success: true, id: purchaseId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Helper — pull (id, name, unit, qty, unitPrice) out of a purchase item
// regardless of whether it was saved by the direct-purchase UI
// ({itemId, itemName, ...}) or by the PO approve endpoint ({id, name, ...}).
// The old code only checked `item.id`, so items from the direct-purchase
// UI (which uses `itemId`) silently skipped every stock update.
function normPurchaseItem(item) {
  return {
    id: item.id || item.itemId || null,
    name: item.name || item.itemName || '',
    unit: item.unit || '',
    unitType: item.unitType || 'small',
    convRate: Number(item.convRate) || 1,
    qty: Number(item.qty) || 0,
    unitPrice: Number(item.unitPrice) || 0
  };
}

// Compute the actual stock quantity in small-units.
// If the user ordered 5 cartons and conv_rate = 28, this returns 140.
function computeStockQty(item, inv) {
  let usedConvRate = 1;
  const invConvRate = Number(inv.conv_rate) || 1;
  const invBigUnit = String(inv.big_unit || '').trim().toLowerCase();
  const itemUnit = String(item.unit || '').trim().toLowerCase()
    .replace(/\s*\(.*\)\s*$/, ''); // Strip "(كبرى)" / "(صغرى)" suffix from old data

  // Priority 1: convRate stored explicitly in the purchase item AND unitType = 'big'
  if (item.unitType === 'big' && item.convRate > 1) {
    usedConvRate = item.convRate;
  }
  // Priority 2: item.unit name matches inv.big_unit (name-based, covers legacy purchases)
  else if (itemUnit && invBigUnit && itemUnit === invBigUnit && invConvRate > 1) {
    usedConvRate = invConvRate;
  }
  // Priority 3: convRate is set in the item (> 1) but unitType wasn't captured
  // (handles PO lines created between the unit-column migration and the unitType migration)
  else if (item.convRate > 1) {
    usedConvRate = item.convRate;
  }
  // Priority 4: item has no conversion info at all, but the inv_items record has
  // a big_unit AND the item's unit is NOT the small unit → assume it's big
  else if (itemUnit && invBigUnit && itemUnit !== String(inv.unit || '').trim().toLowerCase()
           && itemUnit === invBigUnit && invConvRate > 1) {
    usedConvRate = invConvRate;
  }

  const stockQty = usedConvRate > 1 ? item.qty * usedConvRate : item.qty;
  // Production: removed debug log
  return { stockQty, usedConvRate };
}

// Resolve a purchase-item to a real inv_items row. Tries:
//   1. exact match on id
//   2. case-insensitive exact match on name
// Returns the inv_items row or null.
async function resolveInvItem(item, conn) {
  const q = conn || db; // v7.5 — optional conn so lookups join the caller's transaction
  if (item.id) {
    const [byId] = await q.query('SELECT * FROM inv_items WHERE id = ?', [item.id]);
    if (byId.length) return byId[0];
  }
  if (item.name) {
    const [byName] = await q.query('SELECT * FROM inv_items WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1', [item.name]);
    if (byName.length) return byName[0];
  }
  return null;
}

// Receive purchase (update status, add stock)
//
// If the purchase came from an approved PO (po_id is set), this endpoint
// also updates the PO's status to 'received' and marks each PO line's
// received_qty so the PO reflects the real state of the warehouse.
//
// Returns { success, count, skipped, vatAmount, errors } so the frontend
// toast can show how many items were actually received, how many were
// skipped (no matching inv_items), and the input-VAT total when the user
// ticks "includes VAT".
router.post('/receive/:id', BACKOFFICE, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, includesVAT, warehouseId: reqWarehouseId } = req.body;
    const now = new Date();
    // Determine target warehouse (from request, user default, or null)
    const warehouseId = reqWarehouseId || (req.user && req.user.default_warehouse_id) || null;

    // v7.5 — the ENTIRE receive is ONE transaction: stock writes, lots,
    // movements, GL journal and the status flip commit or roll back together.
    // `const db = conn` shadows the pool so every query below joins it.
    // FOR UPDATE on the purchase row closes the double-receive race (two
    // concurrent receives both passing the status check and double-stocking).
    const out = await db.withTransaction(async (conn) => {
      const db = conn;

      const [purchases] = await db.query('SELECT * FROM purchases WHERE id = ? FOR UPDATE', [id]);
      if (!purchases.length) throw new Error('Purchase not found');

      const purchase = purchases[0];
      if (purchase.status === 'received') throw new Error('Already received');

      const rawItems = JSON.parse(purchase.items_json || '[]');
      const items = rawItems.map(normPurchaseItem);
      // Phase 4B — block tracked/inactive items in the legacy PO receive (gate).
      await _assertLegacyInboundItems(items, resolveInvItem);

      let count = 0;
      const skipped = [];
      const updated = [];   // verbose list of what we actually did
      let totalVat = 0;
      let totalNetCost = 0; // v7.5 — VAT-exclusive cost actually received (drives the GL)

      for (const item of items) {
        if (item.qty <= 0) {
          skipped.push({ name: item.name, reason: 'qty=0' });
          continue;
        }

        // Resolve to a real inv_items row (by id first, then by name)
        const inv = await resolveInvItem(item, db);
        if (!inv) {
          skipped.push({ name: item.name, reason: 'not found in inventory' });
          continue;
        }

        // VAT handling — if prices include VAT, net cost = gross / 1.15
        let netUnitPrice = item.unitPrice;
        if (includesVAT && item.unitPrice > 0) {
          netUnitPrice = item.unitPrice / 1.15;
          totalVat += (item.unitPrice - netUnitPrice) * item.qty;
        }

        // ─── UNIT CONVERSION: if ordered in big units, multiply qty × convRate ───
        const { stockQty, usedConvRate } = computeStockQty(item, inv);

        // Cost per small unit (e.g. 50 SAR/carton ÷ 28 = 1.79 SAR/piece)
        const stockBefore = Number(inv.stock) || 0;
        const currentCost = Number(inv.cost) || 0;
        let costPerSmallUnit = netUnitPrice;
        if (usedConvRate > 1 && netUnitPrice > 0) {
          costPerSmallUnit = netUnitPrice / usedConvRate;
        }

        // ─── WEIGHTED AVERAGE COST ───
        // new_cost = (old_stock × old_cost + new_qty × new_unit_cost) / (old_stock + new_qty)
        let newCost;
        if (stockBefore === 0) {
          newCost = costPerSmallUnit;
        } else if (costPerSmallUnit > 0) {
          newCost = ((stockBefore * currentCost) + (stockQty * costPerSmallUnit)) / (stockBefore + stockQty);
        } else {
          newCost = currentCost;
        }

        // v5.10.19 — warehouse_stock is the source of truth. Cost (WAC) is
        // still global on inv_items.cost; quantity becomes a recomputed
        // SUM(warehouse_stock.qty) rollup.
        let affectedRows;
        if (warehouseId) {
          const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
          await db.query(
            'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE qty = qty + ?',
            [wsId, warehouseId, inv.id, stockQty, stockQty]
          );
          // Update WAC + recompute the global stock rollup
          const [costRes] = await db.query(
            'UPDATE inv_items SET cost = ? WHERE id = ?',
            [newCost, inv.id]
          );
          affectedRows = costRes.affectedRows;
          await recomputeInvItemStock(db, inv.id);
        } else {
          // Legacy fallback: no warehouse — direct global write (qty + cost).
          const [result] = await db.query(
            'UPDATE inv_items SET stock = stock + ?, cost = ? WHERE id = ?',
            [stockQty, newCost, inv.id]
          );
          affectedRows = result.affectedRows;
        }

        // ─── PURCHASE LOT (for future FIFO) ───
        // v7.5 — also stamp warehouse_id on the lot (expiry disposal reads it;
        // a NULL there used to skip the stock decrement and break GL dims).
        try {
          await db.query(
            'INSERT INTO purchase_lots (inv_item_id, purchase_id, received_date, qty_received, qty_remaining, unit_cost, warehouse_id) VALUES (?,?,?,?,?,?,?)',
            [inv.id, id, now, stockQty, stockQty, costPerSmallUnit, warehouseId || null]
          );
        } catch (lotErr) {
          if (lotErr && lotErr.code === 'ER_BAD_FIELD_ERROR') {
            try {
              await db.query(
                'INSERT INTO purchase_lots (inv_item_id, purchase_id, received_date, qty_received, qty_remaining, unit_cost) VALUES (?,?,?,?,?,?)',
                [inv.id, id, now, stockQty, stockQty, costPerSmallUnit]
              );
            } catch (lotErr2) { /* lots table absent on very old deploys */ }
          }
        }

        if (affectedRows === 0) {
          // The UPDATE silently affected 0 rows — the WHERE clause didn't
          // match. This shouldn't happen because we just SELECT'd it, but
          // log it loudly so we catch any future drift.
          skipped.push({ name: item.name, reason: 'UPDATE affected 0 rows for id=' + inv.id });
          continue;
        }

        // Record movement — notes links back to purchase so we can roll it
        // back on revert. Use the resolved inv.id + inv.name so the movement
        // points to the real inventory row even if the purchase row had a
        // stale/missing id.
        const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4) + '-' + count;
        await db.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [movId, now, inv.id, inv.name, 'in', stockQty, 'مشتريات', username || '', 'PUR: ' + id, warehouseId || null]
        );

        totalNetCost += stockQty * costPerSmallUnit;

        updated.push({
          invId: inv.id,
          invName: inv.name,
          qtyOrdered: item.qty,
          unitOrdered: item.unit || '',
          convRate: usedConvRate,
          stockQty: stockQty,
          stockBefore: stockBefore,
          stockAfter: stockBefore + stockQty
        });

        count++;
      }

      // If we skipped every item, abort (rollback) so nothing half-applies.
      if (count === 0) {
        let reason = 'لم يتم تحديث المخزون — لا توجد مواد مطابقة في قاعدة بيانات المخزون.\n\n';
        reason += 'الأصناف الموجودة في الفاتورة:\n';
        reason += items.map(function(it) {
          return '• ' + (it.name || '—') + ' (id=' + (it.id || 'null') + ', qty=' + it.qty + ')';
        }).join('\n');
        reason += '\n\nالسبب الأكثر احتمالاً: المواد مكتوبة يدوياً وليست مختارة من قائمة المخزون. تأكد من إنشاء المواد في "إدارة المخزون" أولاً، ثم اختيارها من القائمة عند إنشاء أمر الشراء أو الفاتورة.';
        const zeroErr = new Error(reason);
        zeroErr.debugInfo = { items: items, skipped: skipped };
        throw zeroErr;
      }

      // ─── v7.5 GL: Dr INVENTORY (net) [+ Dr INPUT_VAT] / Cr Cash|Bank|AP ───
      // Credit account routed by payment_method ('آجل' default → AP). FATAL
      // inside the transaction; the single exemption is a deploy whose GL
      // tables don't exist yet (postJournal reports it — never throws).
      const _r2 = v => Math.round((Number(v) || 0) * 100) / 100;
      const glNet = _r2(totalNetCost);
      const glVat = _r2(totalVat);
      if (glNet > 0.005) {
        const pm = String(purchase.payment_method || '').toLowerCase();
        let creditCode = gl.CORE_ACCOUNTS.AP.code;
        if (/cash|نقد|كاش/.test(pm)) creditCode = gl.CORE_ACCOUNTS.CASH.code;
        else if (/transfer|تحويل|بنك|bank/.test(pm)) creditCode = gl.CORE_ACCOUNTS.BANK.code;

        const entries = [{
          accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: glNet, credit: 0,
          description: 'استلام مشتريات — ' + id,
          warehouseId: warehouseId || null,
          brandId: purchase.brand_id || null, branchId: purchase.branch_id || null
        }];
        if (glVat > 0) {
          entries.push({
            accountCode: gl.CORE_ACCOUNTS.INPUT_VAT.code, debit: glVat, credit: 0,
            description: 'ضريبة مدخلات — ' + id,
            brandId: purchase.brand_id || null, branchId: purchase.branch_id || null
          });
        }
        entries.push({
          accountCode: creditCode, debit: 0, credit: _r2(glNet + glVat),
          description: 'مقابل استلام مشتريات — ' + id,
          brandId: purchase.brand_id || null, branchId: purchase.branch_id || null
        });

        const post = await gl.postJournal(db, {
          journalDate: now.toISOString().slice(0, 10),
          description: 'استلام فاتورة شراء ' + id + (purchase.supplier_name ? ' — ' + purchase.supplier_name : ''),
          referenceType: 'PurchaseReceipt',
          referenceId: id,
          entries,
          postedBy: username || ''
        });
        if (!post || !post.success) {
          const perr = (post && post.error) || 'unknown';
          if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(perr)) {
            console.warn('[purchases receive ' + id + '] GL skipped — gl tables absent:', perr);
          } else {
            throw new Error('GL_POSTING_FAILED: ' + perr);
          }
        }
      }

      // Mark the purchase itself as received — v7.5: STAMP the warehouse so
      // revert targets the right warehouse_stock rows (a NULL here used to
      // make the revert fall into the legacy global path and self-erase).
      await db.query('UPDATE purchases SET status = "received", warehouse_id = ? WHERE id = ?',
        [warehouseId || null, id]);

      // Back-propagate to the linked PO (if any)
      if (purchase.po_id) {
        await db.query('UPDATE purchase_orders SET status = "received" WHERE id = ?', [purchase.po_id]);
        for (const item of items) {
          const inv = await resolveInvItem(item, db);
          if (inv && item.qty > 0) {
            // Match by either item_id OR item_name on po_lines (same fallback logic)
            await db.query(
              'UPDATE po_lines SET received_qty = received_qty + ? WHERE po_id = ? AND (item_id = ? OR (item_id IS NULL AND LOWER(TRIM(item_name)) = LOWER(TRIM(?))))',
              [item.qty, purchase.po_id, inv.id, item.name]
            );
          }
        }
      }

      return { count, skipped, updated, totalVat };
    });

    // ─── CASCADE: recompute menu costs for any affected products ───
    // v7.5 — AFTER the commit: the helper reads through the pool (a different
    // connection), so inside the transaction it would see pre-receive costs.
    if (out.updated.length) {
      try {
        // v7.1 — cascade: re-derive semi-finished costs from their BOM first,
        // then finished menu costs, so a raw-material price change flows through.
        const { recomputeSemiThenFinished } = require('./pricing-utils');
        await recomputeSemiThenFinished(out.updated.map(u => u.invId));
      } catch (cascadeErr) { /* Production: removed debug log */ }
    }

    res.json({
      success: true,
      count: out.count,
      skipped: out.skipped.length,
      skippedDetails: out.skipped,
      updated: out.updated,
      vatAmount: Number(out.totalVat.toFixed(2))
    });
  } catch (e) {
    // Phase 4B — surface a real HTTP status + canonical code when set (the lot
    // gate); legacy errors keep the historical 200 {success:false} contract.
    res.status(e.status || 200).json({ success: false, code: e.code || undefined, error: e.message, debug: e.debugInfo || undefined });
  }
});

// Revert a RECEIVED purchase — rolls back stock, deletes the "مشتريات"
// movements we created on receive, and flips the purchase (and any linked
// PO) back to 'draft' / 'approved' respectively.
router.post('/receive/:id/revert', MGR, async (req, res) => {
  try {
    const { id } = req.params;

    // v7.5 — atomic revert: stock rollback, movement/lot cleanup, GL reversal
    // and the status flip commit or roll back together (FOR UPDATE serializes
    // a double-revert).
    const out = await db.withTransaction(async (conn) => {
      const db = conn;

      const [purchases] = await db.query('SELECT * FROM purchases WHERE id = ? FOR UPDATE', [id]);
      if (!purchases.length) throw new Error('Purchase not found');

      const purchase = purchases[0];
      if (purchase.status !== 'received') {
        throw new Error('هذه الفاتورة ليست مستلمة — لا يوجد ما يُلغى');
      }

      const rawItems = JSON.parse(purchase.items_json || '[]');
      const items = rawItems.map(normPurchaseItem);

      // Pre-resolve items to their real inv rows + compute the converted qty
      // (same logic as the receive endpoint — if the purchase was in big units,
      // we need to subtract qty × convRate, not just qty).
      const resolved = [];
      for (const item of items) {
        if (item.qty <= 0) continue;
        const inv = await resolveInvItem(item, db);
        if (!inv) continue;
        const { stockQty } = computeStockQty(item, inv);
        resolved.push({ item, inv, stockQty });
      }

      // Safety check — refuse if rolling back would make any item's stock go negative
      for (const r of resolved) {
        const currentStock = Number(r.inv.stock) || 0;
        if (currentStock < r.stockQty) {
          throw new Error('لا يمكن التراجع: المخزون الحالي للمادة "' + r.inv.name + '" (' + currentStock + ') أقل من الكمية المستلمة (' + r.stockQty + '). ربما استُهلكت بعض الكمية في المبيعات.');
        }
      }

      // v7.5 — resolve the warehouse PER ITEM from the receive movements
      // (they carry warehouse_id). This fixes BOTH legacy purchases whose
      // warehouse_id column was never stamped AND keeps working for new ones.
      // Falling back to the legacy global path while the receive actually
      // wrote warehouse_stock made the revert SELF-ERASE: the next
      // recomputeInvItemStock (rollup = SUM(warehouse_stock)) restored the
      // quantity that was just subtracted from inv_items.stock.
      const movWh = {};
      try {
        const [movRows] = await db.query(
          "SELECT item_id, warehouse_id FROM inventory_movements WHERE notes = ? AND type = 'in' AND reason = 'مشتريات'",
          ['PUR: ' + id]);
        movRows.forEach(m => { if (m.warehouse_id && movWh[m.item_id] == null) movWh[m.item_id] = m.warehouse_id; });
      } catch (_) {}

      // v5.10.19 — Roll back stock at the warehouse level first (the warehouse
      // the purchase landed in), then recompute the global inv_items.stock.
      const purchaseWh = purchase.warehouse_id || null;
      for (const r of resolved) {
        const wh = movWh[r.inv.id] || purchaseWh || null;
        if (wh) {
          await db.query(
            // v7.1 — allow negative: if a received purchase is reverted after some of
            // its stock was already consumed, the balance must reflect the real deficit.
            'UPDATE warehouse_stock SET qty = qty - ? WHERE warehouse_id = ? AND item_id = ?',
            [r.stockQty, wh, r.inv.id]
          );
          await recomputeInvItemStock(db, r.inv.id);
        } else {
          // Truly legacy receive with no warehouse trace anywhere — global.
          await db.query('UPDATE inv_items SET stock = stock - ? WHERE id = ?', [r.stockQty, r.inv.id]);
        }
      }

      // Delete the movements created by the receive
      await db.query(
        'DELETE FROM inventory_movements WHERE notes = ? AND type = ? AND reason = ?',
        ['PUR: ' + id, 'in', 'مشتريات']
      );

      // Delete purchase lots created by this receive
      try { await db.query('DELETE FROM purchase_lots WHERE purchase_id = ?', [id]); } catch(e) {}

      // v7.5 — reverse the receipt GL exactly like the sales void does:
      // restore account balances, then drop the journal (so valuation mirrors
      // what was actually posted, immune to WAC drift since the receipt).
      try {
        const [journals] = await db.query(
          "SELECT id FROM gl_journals WHERE reference_type = 'PurchaseReceipt' AND reference_id = ?", [id]);
        for (const j of journals) {
          const [jEntries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ?', [j.id]);
          for (const e2 of jEntries) {
            if (e2.account_id) {
              const reverseAmount = (Number(e2.credit) || 0) - (Number(e2.debit) || 0);
              await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?',
                [reverseAmount, e2.account_id]);
            }
          }
          await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [j.id]);
          await db.query('DELETE FROM gl_journals WHERE id = ?', [j.id]);
        }
      } catch (glErr) {
        if (!glErr || glErr.code !== 'ER_NO_SUCH_TABLE') throw glErr;
      }

      // Flip the purchase back to draft (clear the warehouse stamp with it)
      await db.query('UPDATE purchases SET status = "draft", warehouse_id = NULL WHERE id = ?', [id]);

      // Back-propagate to linked PO: unset received, return to approved, zero received_qty
      if (purchase.po_id) {
        await db.query('UPDATE purchase_orders SET status = "approved" WHERE id = ?', [purchase.po_id]);
        for (const r of resolved) {
          await db.query(
            'UPDATE po_lines SET received_qty = GREATEST(0, received_qty - ?) WHERE po_id = ? AND (item_id = ? OR (item_id IS NULL AND LOWER(TRIM(item_name)) = LOWER(TRIM(?))))',
            [r.item.qty, purchase.po_id, r.inv.id, r.item.name]
          );
        }
      }

      return { invIds: resolved.map(r => r.inv.id) };
    });

    // Cascade AFTER commit (helper reads through the pool — see receive)
    try {
      const { recomputeSemiThenFinished } = require('./pricing-utils');
      await recomputeSemiThenFinished(out.invIds);
    } catch(e) {}

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete purchase
router.delete('/:id', MGR, async (req, res) => {
  try {
    // If this purchase is linked to a PO, reset the PO status back so it can be re-used
    const [pur] = await db.query('SELECT po_id, status FROM purchases WHERE id = ?', [req.params.id]);
    await db.query('DELETE FROM purchases WHERE id = ?', [req.params.id]);
    // Also clean up purchase_lots
    try { await db.query('DELETE FROM purchase_lots WHERE purchase_id = ?', [req.params.id]); } catch(e) {}
    // Reset the linked PO to 'approved' (if it was 'received') or 'draft'
    if (pur.length && pur[0].po_id) {
      const newStatus = pur[0].status === 'received' ? 'approved' : 'draft';
      await db.query('UPDATE purchase_orders SET status = ? WHERE id = ?', [newStatus, pur[0].po_id]);
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Purchase Orders ───

// Get purchase orders (brand-aware)
router.get('/orders', async (req, res) => {
  try {
    let query = `SELECT po.*, b.name AS brand_name, br.name AS branch_name
                 FROM purchase_orders po
                 LEFT JOIN brands b ON b.id = po.brand_id
                 LEFT JOIN branches br ON br.id = po.branch_id
                 WHERE 1=1`;
    const params = [];

    if (req.query.status)     { query += ' AND po.status = ?';        params.push(req.query.status); }
    if (req.query.supplierId) { query += ' AND po.supplier_id = ?';   params.push(req.query.supplierId); }
    if (req.query.brandId)    { query += ' AND po.brand_id = ?';      params.push(req.query.brandId); }
    if (req.query.branchId)   { query += ' AND po.branch_id = ?';     params.push(req.query.branchId); }
    if (req.query.startDate)  { query += ' AND po.po_date >= ?';      params.push(req.query.startDate); }
    if (req.query.endDate)    { query += ' AND po.po_date <= ?';      params.push(req.query.endDate); }

    query += ' ORDER BY po.created_at DESC LIMIT 200';

    const [orders] = await db.query(query, params);
    const result = [];

    for (const po of orders) {
      const [lines] = await db.query('SELECT * FROM po_lines WHERE po_id = ?', [po.id]);
      result.push({
        id: po.id, poNumber: po.po_number, supplierId: po.supplier_id, supplierName: po.supplier_name,
        poDate: po.po_date, expectedDate: po.expected_date, status: po.status,
        totalBeforeVat: Number(po.total_before_vat), vatAmount: Number(po.vat_amount),
        totalAfterVat: Number(po.total_after_vat), notes: po.notes,
        createdBy: po.created_by, approvedBy: po.approved_by, approvedAt: po.approved_at,
        brandId: po.brand_id || '', brand_id: po.brand_id || '', brandName: po.brand_name || '',
        branchId: po.branch_id || '', branchName: po.branch_name || '',
        lines: lines.map(l => ({
          id: l.id, itemId: l.item_id, itemName: l.item_name,
          unit: l.unit || '',
          unitType: l.unit_type || 'small',
          convRate: Number(l.conv_rate) || 1,
          qty: Number(l.qty), unitPrice: Number(l.unit_price),
          vatRate: Number(l.vat_rate), vatAmount: Number(l.vat_amount),
          total: Number(l.total), receivedQty: Number(l.received_qty)
        }))
      });
    }

    res.json(result);
  } catch (e) {
    res.json([]);
  }
});

// Create purchase order
// Accepts BOTH {lines, poDate} and {items, date} from the frontend to stay
// backward-compatible with the ERP UI which sends {items, date}.
router.post('/orders', async (req, res) => {
  try {
    const { supplierId, supplierName, notes, username, brandId, branchId } = req.body;
    const poDate = req.body.poDate || req.body.date;
    const expectedDate = req.body.expectedDate;
    // Support both `lines` (legacy) and `items` (ERP UI)
    const lines = req.body.lines || req.body.items || [];

    // v7.5 — reject non-positive quantities (they feed purchases via approve)
    for (const line of lines) {
      if ((Number(line.qty) || 0) <= 0) {
        return res.status(400).json({
          success: false, code: 'qty_must_be_positive',
          error: 'كمية غير صالحة للصنف "' + (line.itemName || line.name || '؟') + '" — يجب أن تكون أكبر من صفر'
        });
      }
    }

    const poId = 'PO-' + Date.now();

    // Calculate next PO number
    const [lastPo] = await db.query('SELECT po_number FROM purchase_orders ORDER BY created_at DESC LIMIT 1');
    let nextNum = 1;
    if (lastPo.length && lastPo[0].po_number) {
      const match = lastPo[0].po_number.match(/(\d+)/);
      if (match) nextNum = parseInt(match[1]) + 1;
    }
    const poNumber = 'PO-' + String(nextNum).padStart(5, '0');

    // Calculate totals
    let totalBeforeVat = 0;
    let totalVat = 0;

    if (lines && lines.length) {
      for (const line of lines) {
        const lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
        const lineVat = lineTotal * ((Number(line.vatRate) || 15) / 100);
        totalBeforeVat += lineTotal;
        totalVat += lineVat;
      }
    }

    await db.query(
      `INSERT INTO purchase_orders (id, po_number, supplier_id, supplier_name, po_date, expected_date, status, total_before_vat, vat_amount, total_after_vat, notes, created_by, brand_id, branch_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [poId, poNumber, supplierId || null, supplierName || '', poDate || new Date(), expectedDate || null,
       'draft', totalBeforeVat, totalVat, totalBeforeVat + totalVat, notes || '', username || '',
       brandId || null, branchId || null]
    );

    // Insert lines
    if (lines && lines.length) {
      for (const line of lines) {
        const lineId = 'POL-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        const lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
        const lineVat = lineTotal * ((Number(line.vatRate) || 15) / 100);

        await db.query(
          `INSERT INTO po_lines (id, po_id, item_id, item_name, unit, unit_type, conv_rate, qty, unit_price, vat_rate, vat_amount, total, received_qty)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [lineId, poId, line.itemId || null, line.itemName || '', line.unit || '',
           line.unitType || 'small', line.convRate || 1,
           line.qty || 0, line.unitPrice || 0, line.vatRate || 15, lineVat, lineTotal + lineVat, 0]
        );
      }
    }

    res.json({ success: true, id: poId, poNumber });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Update purchase order
// Accepts both {lines, poDate} and {items, date} for frontend compatibility.
router.put('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { supplierId, supplierName, notes } = req.body;
    const poDate = req.body.poDate || req.body.date;
    const expectedDate = req.body.expectedDate;
    const lines = req.body.lines || req.body.items || [];

    // Only allow editing draft POs
    const [existing] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    if (!existing.length) return res.json({ success: false, error: 'PO not found' });
    if (existing[0].status !== 'draft') return res.json({ success: false, error: 'Only draft POs can be edited' });

    let totalBeforeVat = 0;
    let totalVat = 0;

    if (lines && lines.length) {
      for (const line of lines) {
        const lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
        const lineVat = lineTotal * ((Number(line.vatRate) || 15) / 100);
        totalBeforeVat += lineTotal;
        totalVat += lineVat;
      }
    }

    await db.query(
      `UPDATE purchase_orders SET supplier_id=?, supplier_name=?, po_date=?, expected_date=?,
       total_before_vat=?, vat_amount=?, total_after_vat=?, notes=? WHERE id=?`,
      [supplierId || null, supplierName || '', poDate, expectedDate || null,
       totalBeforeVat, totalVat, totalBeforeVat + totalVat, notes || '', id]
    );

    // Replace lines
    await db.query('DELETE FROM po_lines WHERE po_id = ?', [id]);
    if (lines && lines.length) {
      for (const line of lines) {
        const lineId = 'POL-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        const lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
        const lineVat = lineTotal * ((Number(line.vatRate) || 15) / 100);

        await db.query(
          `INSERT INTO po_lines (id, po_id, item_id, item_name, unit, qty, unit_price, vat_rate, vat_amount, total, received_qty)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [lineId, id, line.itemId || null, line.itemName || '', line.unit || '',
           line.qty || 0, line.unitPrice || 0, line.vatRate || 15, lineVat, lineTotal + lineVat, 0]
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Approve PO
//
// In addition to flipping purchase_orders.status to 'approved', this endpoint
// ALSO creates a matching row in the `purchases` table (status='draft') with
// all the PO lines copied over as items_json. That way the approved PO
// immediately shows up in the "المشتريات" (Purchases) section so the user
// can go there and press "استلام" (Receive) to add stock to inventory.
//
// The link between the PO and its generated purchase is kept via the
// `po_id` column on the purchases table, so we can clean up on revert and
// back-propagate status on receive.
router.post('/orders/:id/approve', MGR, async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    const now = new Date();

    const [existing] = await db.query('SELECT * FROM purchase_orders WHERE id = ?', [id]);
    if (!existing.length) return res.json({ success: false, error: 'PO not found' });
    if (existing[0].status !== 'draft') return res.json({ success: false, error: 'Only draft POs can be approved' });

    const po = existing[0];

    // Load PO lines so we can copy them into the purchase
    const [poLines] = await db.query('SELECT * FROM po_lines WHERE po_id = ?', [id]);

    // Shape lines like the purchase items_json — include unit conversion info
    // so the receive endpoint can multiply by convRate when adding to stock.
    const purchaseItems = poLines.map(l => ({
      id: l.item_id,
      name: l.item_name,
      unit: l.unit || '',
      unitType: l.unit_type || 'small',
      convRate: Number(l.conv_rate) || 1,
      qty: Number(l.qty) || 0,
      unitPrice: Number(l.unit_price) || 0
    }));

    const totalPrice = purchaseItems.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);

    // Guard: don't create a duplicate purchase if one already exists for this PO
    const [existingPurchase] = await db.query('SELECT id FROM purchases WHERE po_id = ?', [id]);
    let purchaseId;
    if (existingPurchase.length) {
      purchaseId = existingPurchase[0].id;
    } else {
      purchaseId = 'PUR-' + Date.now();
      await db.query(
        `INSERT INTO purchases (id, purchase_date, supplier_name, supplier_id, item_name, item_id, qty, unit_price, total_price, payment_method, username, notes, status, items_json, po_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          purchaseId,
          now,
          po.supplier_name || '',
          po.supplier_id || null,
          purchaseItems.length === 1 ? purchaseItems[0].name : 'متعدد',
          purchaseItems.length === 1 ? purchaseItems[0].id : null,
          purchaseItems.length === 1 ? purchaseItems[0].qty : 0,
          purchaseItems.length === 1 ? purchaseItems[0].unitPrice : 0,
          totalPrice,
          'آجل',
          username || '',
          'من أمر الشراء ' + (po.po_number || id),
          'draft',
          JSON.stringify(purchaseItems),
          id
        ]
      );
    }

    // Flip PO status
    await db.query(
      'UPDATE purchase_orders SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?',
      [username || '', now, id]
    );

    res.json({ success: true, purchaseId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Revert PO (back to draft)
//
// Also deletes the linked draft purchase that was auto-created on approve.
// We refuse to revert if the linked purchase was already received (that
// would require stock rollback, which is outside the scope of a simple
// revert and should be handled by deleting the received purchase first).
router.post('/orders/:id/revert', MGR, async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    if (!existing.length) return res.json({ success: false, error: 'PO not found' });

    // If 'received' but the linked purchase is already gone (deleted manually),
    // allow revert since there's nothing to undo on the purchase side.
    const [linkedPurchases] = await db.query('SELECT id, status FROM purchases WHERE po_id = ?', [id]);
    if (existing[0].status === 'received') {
      const hasReceivedPurchase = linkedPurchases.some(lp => lp.status === 'received');
      if (hasReceivedPurchase) {
        return res.json({ success: false, error: 'الفاتورة المرتبطة مستلمة بالفعل — استخدم زر التراجع عن الاستلام في المشتريات أولاً.' });
      }
      // Purchase was deleted or doesn't exist → allow revert
    }

    // Delete any remaining linked draft purchases
    await db.query('DELETE FROM purchases WHERE po_id = ? AND status = "draft"', [id]);

    // Flip the PO back to draft
    await db.query(
      'UPDATE purchase_orders SET status = "draft", approved_by = NULL, approved_at = NULL WHERE id = ?',
      [id]
    );

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete PO
router.delete('/orders/:id', MGR, async (req, res) => {
  try {
    const [existing] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.json({ success: false, error: 'PO not found' });

    // Delete linked purchases first
    await db.query('DELETE FROM purchases WHERE po_id = ?', [req.params.id]);
    // Delete PO lines
    await db.query('DELETE FROM po_lines WHERE po_id = ?', [req.params.id]);
    // Delete the PO
    await db.query('DELETE FROM purchase_orders WHERE id = ?', [req.params.id]);
    // Reset linked shortage request
    await db.query("UPDATE shortage_requests SET status = 'approved', po_id = NULL WHERE po_id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Debug/Diagnose endpoint — shows why a purchase might not be updating stock ───
// Hit GET /api/purchases/diagnose/:id from the browser to see the raw truth.
router.get('/diagnose/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [purchases] = await db.query('SELECT * FROM purchases WHERE id = ?', [id]);
    if (!purchases.length) return res.json({ error: 'Purchase not found', id });
    const purchase = purchases[0];
    const rawItems = JSON.parse(purchase.items_json || '[]');
    const items = rawItems.map(normPurchaseItem);
    const diagnosis = [];
    for (const item of items) {
      const inv = await resolveInvItem(item);
      diagnosis.push({
        fromPurchase: { id: item.id, name: item.name, qty: item.qty, unitPrice: item.unitPrice },
        resolvedInvItem: inv ? { id: inv.id, name: inv.name, currentStock: Number(inv.stock), cost: Number(inv.cost) } : null,
        matchMethod: inv ? (String(inv.id) === String(item.id) ? 'by_id' : 'by_name') : 'NOT_FOUND',
        wouldUpdate: inv ? 'stock ' + Number(inv.stock) + ' → ' + (Number(inv.stock) + item.qty) : 'SKIP'
      });
    }
    res.json({
      purchaseId: id,
      purchaseStatus: purchase.status,
      supplierName: purchase.supplier_name,
      rawItemsJson: rawItems,
      normalizedItems: items,
      diagnosis,
      tip: diagnosis.some(d => !d.resolvedInvItem)
        ? 'بعض الأصناف لم تتطابق مع أي مادة في المخزون. تأكد من أن الأسماء والأكواد متطابقة.'
        : 'كل الأصناف تطابقت — الاستلام يجب أن يعمل.'
    });
  } catch (e) { res.json({ error: e.message }); }
});

module.exports = router;
