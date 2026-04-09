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

// Helper — pull (id, name, qty, unitPrice) out of a purchase item regardless
// of whether it was saved by the direct-purchase UI (itemId/itemName) or by
// the PO approve endpoint (id/name). This was the root cause of the
// "received 0 items" bug: the old code only checked `item.id`, so items
// coming from the direct-purchase UI (which uses `itemId`) silently skipped
// every stock update.
function normPurchaseItem(item) {
  return {
    id: item.id || item.itemId || null,
    name: item.name || item.itemName || '',
    qty: Number(item.qty) || 0,
    unitPrice: Number(item.unitPrice) || 0
  };
}

// Receive purchase (update status, add stock)
//
// If the purchase came from an approved PO (po_id is set), this endpoint
// also updates the PO's status to 'received' and marks each PO line's
// received_qty so the PO reflects the real state of the warehouse.
//
// Returns { success, count, vatAmount } so the frontend toast can show
// how many items were actually received and the input-VAT total when
// the user ticks "includes VAT".
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

    let count = 0;
    let totalVat = 0;

    for (const item of items) {
      if (!item.id || item.qty <= 0) continue;

      // VAT handling — if prices include VAT, net cost = gross / 1.15
      let netUnitPrice = item.unitPrice;
      if (includesVAT && item.unitPrice > 0) {
        netUnitPrice = item.unitPrice / 1.15;
        totalVat += (item.unitPrice - netUnitPrice) * item.qty;
      }

      // Update stock. Only overwrite cost if it's not already set (first receive),
      // so subsequent receives at different prices don't clobber prior cost data.
      const [existingItem] = await db.query('SELECT cost FROM inv_items WHERE id = ?', [item.id]);
      if (existingItem.length) {
        const currentCost = Number(existingItem[0].cost) || 0;
        if (currentCost === 0 && netUnitPrice > 0) {
          await db.query('UPDATE inv_items SET stock = stock + ?, cost = ? WHERE id = ?',
            [item.qty, netUnitPrice, item.id]);
        } else {
          await db.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?',
            [item.qty, item.id]);
        }
      }

      // Record movement — notes links back to purchase so we can roll it
      // back on revert.
      const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
        [movId, now, item.id, item.name, 'in', item.qty, 'مشتريات', username || '', 'PUR: ' + id]
      );

      count++;
    }

    // Mark the purchase itself as received
    await db.query('UPDATE purchases SET status = "received" WHERE id = ?', [id]);

    // Back-propagate to the linked PO (if any)
    if (purchase.po_id) {
      await db.query('UPDATE purchase_orders SET status = "received" WHERE id = ?', [purchase.po_id]);
      for (const item of items) {
        if (item.id && item.qty > 0) {
          await db.query(
            'UPDATE po_lines SET received_qty = received_qty + ? WHERE po_id = ? AND item_id = ?',
            [item.qty, purchase.po_id, item.id]
          );
        }
      }
    }

    res.json({ success: true, count, vatAmount: Number(totalVat.toFixed(2)) });
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

    // Safety check — refuse if rolling back would make any item's stock go negative
    for (const item of items) {
      if (!item.id || item.qty <= 0) continue;
      const [existing] = await db.query('SELECT stock, name FROM inv_items WHERE id = ?', [item.id]);
      if (existing.length) {
        const currentStock = Number(existing[0].stock) || 0;
        if (currentStock < item.qty) {
          return res.json({
            success: false,
            error: 'لا يمكن التراجع: المخزون الحالي للمادة "' + existing[0].name + '" (' + currentStock + ') أقل من الكمية المستلمة (' + item.qty + '). ربما استُهلكت بعض الكمية في المبيعات.'
          });
        }
      }
    }

    // Roll back stock
    for (const item of items) {
      if (!item.id || item.qty <= 0) continue;
      await db.query('UPDATE inv_items SET stock = stock - ? WHERE id = ?', [item.qty, item.id]);
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
      for (const item of items) {
        if (item.id && item.qty > 0) {
          await db.query(
            'UPDATE po_lines SET received_qty = GREATEST(0, received_qty - ?) WHERE po_id = ? AND item_id = ?',
            [item.qty, purchase.po_id, item.id]
          );
        }
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
          `INSERT INTO po_lines (id, po_id, item_id, item_name, qty, unit_price, vat_rate, vat_amount, total, received_qty)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [lineId, poId, line.itemId || null, line.itemName || '', line.qty || 0,
           line.unitPrice || 0, line.vatRate || 15, lineVat, lineTotal + lineVat, 0]
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
          `INSERT INTO po_lines (id, po_id, item_id, item_name, qty, unit_price, vat_rate, vat_amount, total, received_qty)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [lineId, id, line.itemId || null, line.itemName || '', line.qty || 0,
           line.unitPrice || 0, line.vatRate || 15, lineVat, lineTotal + lineVat, 0]
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

    // Shape lines like the purchase items_json: [{ id, name, qty, unitPrice }]
    const purchaseItems = poLines.map(l => ({
      id: l.item_id,
      name: l.item_name,
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

module.exports = router;
