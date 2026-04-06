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

// Receive purchase (update status, add stock)
router.post('/receive/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    const now = new Date();

    const [purchases] = await db.query('SELECT * FROM purchases WHERE id = ?', [id]);
    if (!purchases.length) return res.json({ success: false, error: 'Purchase not found' });

    const purchase = purchases[0];
    if (purchase.status === 'received') return res.json({ success: false, error: 'Already received' });

    const items = JSON.parse(purchase.items_json || '[]');

    // Update stock for each item
    for (const item of items) {
      if (item.id) {
        await db.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?', [item.qty || 0, item.id]);

        // Record movement
        const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
          [movId, now, item.id, item.name || '', 'in', item.qty || 0, 'مشتريات', username || '', 'PUR: ' + id]
        );
      }
    }

    await db.query('UPDATE purchases SET status = "received" WHERE id = ?', [id]);

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
router.post('/orders', async (req, res) => {
  try {
    const { supplierId, supplierName, poDate, expectedDate, lines, notes, username } = req.body;
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
router.put('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { supplierId, supplierName, poDate, expectedDate, lines, notes } = req.body;

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
router.post('/orders/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    const now = new Date();

    const [existing] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    if (!existing.length) return res.json({ success: false, error: 'PO not found' });
    if (existing[0].status !== 'draft') return res.json({ success: false, error: 'Only draft POs can be approved' });

    await db.query(
      'UPDATE purchase_orders SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?',
      [username || '', now, id]
    );

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Revert PO (back to draft)
router.post('/orders/:id/revert', async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    if (!existing.length) return res.json({ success: false, error: 'PO not found' });
    if (existing[0].status === 'received') return res.json({ success: false, error: 'Cannot revert a received PO' });

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
