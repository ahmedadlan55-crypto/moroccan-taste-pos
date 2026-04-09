const router = require('express').Router();
const db = require('../db/connection');

// ─── Purchases ───

// Get purchases (with filters)
router.get('/', async (req, res) => {
  try {
    let query = 'SELECT * FROM purchases WHERE 1=1';
    const params = [];

    if (req.query.startDate) { query += ' AND DATE(purchase_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND DATE(purchase_date) <= ?'; params.push(req.query.endDate); }
    if (req.query.supplierId) { query += ' AND supplier_id = ?'; params.push(req.query.supplierId); }
    if (req.query.status) { query += ' AND status = ?'; params.push(req.query.status); }

    query += ' ORDER BY purchase_date DESC LIMIT 500';

    const [rows] = await db.query(query, params);
    res.json(rows.map(p => ({
      id: p.id, date: p.purchase_date, supplierName: p.supplier_name, supplierId: p.supplier_id,
      itemName: p.item_name, itemId: p.item_id,
      qty: Number(p.qty), unitPrice: Number(p.unit_price), totalPrice: Number(p.total_price),
      paymentMethod: p.payment_method, username: p.username, notes: p.notes,
      status: p.status, items: JSON.parse(p.items_json || '[]'), poId: p.po_id
    })));
  } catch (e) {
    res.json([]);
  }
});

// Add purchase batch
router.post('/', async (req, res) => {
  try {
    const { supplierName, supplierId, items, paymentMethod, username, notes, poId } = req.body;
    const now = new Date();
    const purchaseId = 'PUR-' + Date.now();

    let totalPrice = 0;
    if (items && items.length) {
      for (const item of items) {
        totalPrice += (Number(item.qty) || 0) * (Number(item.unitPrice) || 0);
      }
    }

    await db.query(
      `INSERT INTO purchases (id, purchase_date, supplier_name, supplier_id, item_name, item_id, qty, unit_price, total_price, payment_method, username, notes, status, items_json, po_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [purchaseId, now, supplierName || '', supplierId || null,
       items && items.length === 1 ? items[0].name : 'متعدد',
       items && items.length === 1 ? items[0].id : null,
       items && items.length === 1 ? items[0].qty : 0,
       items && items.length === 1 ? items[0].unitPrice : 0,
       totalPrice, paymentMethod || 'آجل', username || '', notes || '',
       'draft', JSON.stringify(items || []), poId || null]
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
  // Priority 1: convRate stored explicitly in the purchase item (from PO pipeline)
  if (item.unitType === 'big' && item.convRate > 1) {
    usedConvRate = item.convRate;
  }
  // Priority 2: the item.unit name matches the inv's big_unit → look up conv_rate from inv
  else if (item.unit && inv.big_unit &&
           item.unit.trim().toLowerCase() === String(inv.big_unit).trim().toLowerCase() &&
           Number(inv.conv_rate) > 1) {
    usedConvRate = Number(inv.conv_rate);
  }
  const stockQty = usedConvRate > 1 ? item.qty * usedConvRate : item.qty;
  return { stockQty, usedConvRate };
}

// Resolve a purchase-item to a real inv_items row. Tries:
//   1. exact match on id
//   2. case-insensitive exact match on name
// Returns the inv_items row or null.
async function resolveInvItem(item) {
  if (item.id) {
    const [byId] = await db.query('SELECT * FROM inv_items WHERE id = ?', [item.id]);
    if (byId.length) return byId[0];
  }
  if (item.name) {
    const [byName] = await db.query('SELECT * FROM inv_items WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1', [item.name]);
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
router.post('/receive/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, includesVAT } = req.body;
    const now = new Date();

    const [purchases] = await db.query('SELECT * FROM purchases WHERE id = ?', [id]);
    if (!purchases.length) return res.json({ success: false, error: 'Purchase not found' });

    const purchase = purchases[0];
    if (purchase.status === 'received') return res.json({ success: false, error: 'Already received' });

    const rawItems = JSON.parse(purchase.items_json || '[]');
    const items = rawItems.map(normPurchaseItem);

    console.log('[RECEIVE] Purchase', id, '— processing', items.length, 'items');

    let count = 0;
    const skipped = [];
    const updated = [];   // verbose list of what we actually did
    let totalVat = 0;

    for (const item of items) {
      if (item.qty <= 0) {
        skipped.push({ name: item.name, reason: 'qty=0' });
        console.log('[RECEIVE]   skip', item.name, 'qty=0');
        continue;
      }

      // Resolve to a real inv_items row (by id first, then by name)
      const inv = await resolveInvItem(item);
      if (!inv) {
        skipped.push({ name: item.name, reason: 'not found in inventory' });
        console.log('[RECEIVE]   skip', item.name, '— not found in inventory (tried id=' + item.id + ', name=' + item.name + ')');
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

      // Update stock with the CONVERTED quantity (in small units).
      const stockBefore = Number(inv.stock) || 0;
      const currentCost = Number(inv.cost) || 0;
      // For cost, if the user bought 5 cartons @ 50 SAR/carton and conv_rate=28,
      // the per-piece cost is 50/28 = 1.79 SAR. Store cost per small-unit.
      let costPerSmallUnit = netUnitPrice;
      if (usedConvRate > 1 && netUnitPrice > 0) {
        costPerSmallUnit = netUnitPrice / usedConvRate;
      }

      let affectedRows = 0;
      if (currentCost === 0 && costPerSmallUnit > 0) {
        const [result] = await db.query('UPDATE inv_items SET stock = stock + ?, cost = ? WHERE id = ?',
          [stockQty, costPerSmallUnit, inv.id]);
        affectedRows = result.affectedRows;
      } else {
        const [result] = await db.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?',
          [stockQty, inv.id]);
        affectedRows = result.affectedRows;
      }

      var convNote = usedConvRate > 1
        ? item.qty + ' ' + (item.unit || 'big') + ' × ' + usedConvRate + ' = ' + stockQty + ' ' + (inv.unit || 'unit')
        : '';
      console.log('[RECEIVE]   ' + (affectedRows > 0 ? 'OK' : 'FAIL'),
        inv.name, '(' + inv.id + ')',
        'ordered=' + item.qty + (usedConvRate > 1 ? ' ' + (item.unit || 'big') : ''),
        'stockQty=' + stockQty,
        'stock: ' + stockBefore + ' → ' + (stockBefore + stockQty),
        'affected=' + affectedRows,
        convNote ? '(' + convNote + ')' : '');

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
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
        [movId, now, inv.id, inv.name, 'in', stockQty, 'مشتريات', username || '', 'PUR: ' + id]
      );

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

    // Mark the purchase itself as received
    await db.query('UPDATE purchases SET status = "received" WHERE id = ?', [id]);

    // Back-propagate to the linked PO (if any)
    if (purchase.po_id) {
      await db.query('UPDATE purchase_orders SET status = "received" WHERE id = ?', [purchase.po_id]);
      for (const item of items) {
        const inv = await resolveInvItem(item);
        if (inv && item.qty > 0) {
          // Match by either item_id OR item_name on po_lines (same fallback logic)
          await db.query(
            'UPDATE po_lines SET received_qty = received_qty + ? WHERE po_id = ? AND (item_id = ? OR (item_id IS NULL AND LOWER(TRIM(item_name)) = LOWER(TRIM(?))))',
            [item.qty, purchase.po_id, inv.id, item.name]
          );
        }
      }
    }

    console.log('[RECEIVE] Done — updated', count, 'items, skipped', skipped.length);

    // If we skipped every item, return an error so the frontend shows it.
    if (count === 0) {
      let reason = 'لم يتم تحديث المخزون — لا توجد مواد مطابقة في قاعدة بيانات المخزون.\n\n';
      reason += 'الأصناف الموجودة في الفاتورة:\n';
      reason += items.map(function(it) {
        return '• ' + (it.name || '—') + ' (id=' + (it.id || 'null') + ', qty=' + it.qty + ')';
      }).join('\n');
      reason += '\n\nالسبب الأكثر احتمالاً: المواد مكتوبة يدوياً وليست مختارة من قائمة المخزون. تأكد من إنشاء المواد في "إدارة المخزون" أولاً، ثم اختيارها من القائمة عند إنشاء أمر الشراء أو الفاتورة.';
      return res.json({
        success: false,
        error: reason,
        debug: { items: items, skipped: skipped }
      });
    }

    res.json({
      success: true,
      count,
      skipped: skipped.length,
      skippedDetails: skipped,
      updated: updated,
      vatAmount: Number(totalVat.toFixed(2))
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Revert a RECEIVED purchase — rolls back stock, deletes the "مشتريات"
// movements we created on receive, and flips the purchase (and any linked
// PO) back to 'draft' / 'approved' respectively.
router.post('/receive/:id/revert', async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;

    const [purchases] = await db.query('SELECT * FROM purchases WHERE id = ?', [id]);
    if (!purchases.length) return res.json({ success: false, error: 'Purchase not found' });

    const purchase = purchases[0];
    if (purchase.status !== 'received') {
      return res.json({ success: false, error: 'هذه الفاتورة ليست مستلمة — لا يوجد ما يُلغى' });
    }

    const rawItems = JSON.parse(purchase.items_json || '[]');
    const items = rawItems.map(normPurchaseItem);

    // Pre-resolve items to their real inv rows + compute the converted qty
    // (same logic as the receive endpoint — if the purchase was in big units,
    // we need to subtract qty × convRate, not just qty).
    const resolved = [];
    for (const item of items) {
      if (item.qty <= 0) continue;
      const inv = await resolveInvItem(item);
      if (!inv) continue;
      const { stockQty } = computeStockQty(item, inv);
      resolved.push({ item, inv, stockQty });
    }

    // Safety check — refuse if rolling back would make any item's stock go negative
    for (const r of resolved) {
      const currentStock = Number(r.inv.stock) || 0;
      if (currentStock < r.stockQty) {
        return res.json({
          success: false,
          error: 'لا يمكن التراجع: المخزون الحالي للمادة "' + r.inv.name + '" (' + currentStock + ') أقل من الكمية المستلمة (' + r.stockQty + '). ربما استُهلكت بعض الكمية في المبيعات.'
        });
      }
    }

    // Roll back stock (using the converted quantity, not the raw ordered qty)
    for (const r of resolved) {
      await db.query('UPDATE inv_items SET stock = stock - ? WHERE id = ?', [r.stockQty, r.inv.id]);
    }

    // Delete the movements created by the receive (matched by notes = 'PUR: <id>' and type = 'in')
    await db.query(
      'DELETE FROM inventory_movements WHERE notes = ? AND type = ? AND reason = ?',
      ['PUR: ' + id, 'in', 'مشتريات']
    );

    // Flip the purchase back to draft
    await db.query('UPDATE purchases SET status = "draft" WHERE id = ?', [id]);

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

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete purchase
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM purchases WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Purchase Orders ───

// Get purchase orders
router.get('/orders', async (req, res) => {
  try {
    let query = 'SELECT * FROM purchase_orders WHERE 1=1';
    const params = [];

    if (req.query.status) { query += ' AND status = ?'; params.push(req.query.status); }
    if (req.query.supplierId) { query += ' AND supplier_id = ?'; params.push(req.query.supplierId); }
    if (req.query.startDate) { query += ' AND po_date >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND po_date <= ?'; params.push(req.query.endDate); }

    query += ' ORDER BY created_at DESC LIMIT 200';

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
    const { supplierId, supplierName, notes, username } = req.body;
    const poDate = req.body.poDate || req.body.date;
    const expectedDate = req.body.expectedDate;
    // Support both `lines` (legacy) and `items` (ERP UI)
    const lines = req.body.lines || req.body.items || [];

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
      `INSERT INTO purchase_orders (id, po_number, supplier_id, supplier_name, po_date, expected_date, status, total_before_vat, vat_amount, total_after_vat, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [poId, poNumber, supplierId || null, supplierName || '', poDate || new Date(), expectedDate || null,
       'draft', totalBeforeVat, totalVat, totalBeforeVat + totalVat, notes || '', username || '']
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
router.post('/orders/:id/approve', async (req, res) => {
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
router.post('/orders/:id/revert', async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    if (!existing.length) return res.json({ success: false, error: 'PO not found' });
    if (existing[0].status === 'received') return res.json({ success: false, error: 'Cannot revert a received PO' });

    // If there's a linked purchase, only allow revert if it's still draft
    const [linkedPurchases] = await db.query('SELECT id, status FROM purchases WHERE po_id = ?', [id]);
    for (const lp of linkedPurchases) {
      if (lp.status === 'received') {
        return res.json({ success: false, error: 'الفاتورة المرتبطة مستلمة بالفعل — لا يمكن التراجع' });
      }
    }

    // Delete the linked draft purchase(s)
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
router.delete('/orders/:id', async (req, res) => {
  try {
    const [existing] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.json({ success: false, error: 'PO not found' });
    if (existing[0].status === 'received') return res.json({ success: false, error: 'Cannot delete a received PO' });

    await db.query('DELETE FROM purchase_orders WHERE id = ?', [req.params.id]);
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
