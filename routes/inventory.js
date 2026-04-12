const router = require('express').Router();
const db = require('../db/connection');

// Get all inventory items
router.get('/items', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM inv_items ORDER BY category, name');
    res.json(rows.map(i => ({
      id: i.id, name: i.name, category: i.category,
      cost: Number(i.cost), stock: Number(i.stock), minStock: Number(i.min_stock),
      unit: i.unit, bigUnit: i.big_unit, convRate: Number(i.conv_rate), active: i.active
    })));
  } catch (e) {
    res.json([]);
  }
});

// Save inventory item (insert or update)
router.post('/items', async (req, res) => {
  try {
    const { id, name, category, cost, stock, minStock, unit, bigUnit, convRate, active } = req.body;

    if (id) {
      // Check if exists
      const [existing] = await db.query('SELECT id FROM inv_items WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE inv_items SET name=?, category=?, cost=?, stock=?, min_stock=?, unit=?, big_unit=?, conv_rate=?, active=? WHERE id=?`,
          [name, category || '', cost || 0, stock || 0, minStock || 0, unit || 'حبة', bigUnit || null, convRate || 1, active !== false, id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'INV-' + Date.now();
    await db.query(
      `INSERT INTO inv_items (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, category || '', cost || 0, stock || 0, minStock || 0, unit || 'حبة', bigUnit || null, convRate || 1, active !== false]
    );

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete inventory item
router.delete('/items/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM inv_items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Bulk import inventory items
router.post('/items/import', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'No items provided' });

    let imported = 0;
    let updated = 0;

    for (const item of items) {
      const id = item.id || 'INV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      const [existing] = await db.query('SELECT id FROM inv_items WHERE id = ? OR name = ?', [id, item.name]);

      if (existing.length) {
        await db.query(
          `UPDATE inv_items SET name=?, category=?, cost=?, stock=?, min_stock=?, unit=?, big_unit=?, conv_rate=? WHERE id=?`,
          [item.name, item.category || '', item.cost || 0, item.stock || 0, item.minStock || 0,
           item.unit || 'حبة', item.bigUnit || null, item.convRate || 1, existing[0].id]
        );
        updated++;
      } else {
        await db.query(
          `INSERT INTO inv_items (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, item.name, item.category || '', item.cost || 0, item.stock || 0, item.minStock || 0,
           item.unit || 'حبة', item.bigUnit || null, item.convRate || 1, true]
        );
        imported++;
      }
    }

    res.json({ success: true, imported, updated, total: items.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get inventory movements
router.get('/movements', async (req, res) => {
  try {
    let query = 'SELECT * FROM inventory_movements WHERE 1=1';
    const params = [];

    if (req.query.startDate) { query += ' AND DATE(movement_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND DATE(movement_date) <= ?'; params.push(req.query.endDate); }
    if (req.query.itemId) { query += ' AND item_id = ?'; params.push(req.query.itemId); }
    if (req.query.type) { query += ' AND type = ?'; params.push(req.query.type); }

    query += ' ORDER BY movement_date DESC LIMIT 500';

    const [rows] = await db.query(query, params);
    res.json(rows.map(m => ({
      id: m.id, date: m.movement_date, itemId: m.item_id, itemName: m.item_name,
      type: m.type, qty: Number(m.qty), reason: m.reason, username: m.username, notes: m.notes
    })));
  } catch (e) {
    res.json([]);
  }
});

// Stock update (in/out movement)
router.post('/stock-update', async (req, res) => {
  try {
    const { itemId, itemName, type, qty, reason, username, notes } = req.body;
    const now = new Date();
    const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);

    // Insert movement record
    await db.query(
      'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
      [movId, now, itemId, itemName || '', type, qty, reason || '', username || '', notes || '']
    );

    // Update stock on inv_items
    if (type === 'in') {
      await db.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?', [qty, itemId]);
    } else {
      await db.query('UPDATE inv_items SET stock = GREATEST(0, stock - ?) WHERE id = ?', [qty, itemId]);
    }

    res.json({ success: true, movementId: movId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get live inventory (current stock with movements summary)
router.get('/live', async (req, res) => {
  try {
    const [items] = await db.query('SELECT * FROM inv_items WHERE active = 1 ORDER BY category, name');

    // Aggregate inventory movements per item: total purchased (in) and total consumed (out)
    const [movRows] = await db.query(
      "SELECT item_id, type, SUM(qty) AS totalQty FROM inventory_movements GROUP BY item_id, type"
    );
    const movMap = {}; // itemId → { in: number, out: number }
    movRows.forEach(r => {
      const id = r.item_id;
      if (!movMap[id]) movMap[id] = { in: 0, out: 0 };
      if (r.type === 'in') movMap[id].in = Number(r.totalQty) || 0;
      else if (r.type === 'out') movMap[id].out = Number(r.totalQty) || 0;
    });

    const result = items.map(i => {
      const m = movMap[i.id] || { in: 0, out: 0 };
      const currentStock = Number(i.stock) || 0;
      // Initial stock = current + consumed - purchased
      // (i.e. what was on hand before any movements were recorded)
      const initialStock = currentStock + m.out - m.in;
      return {
        id: i.id,
        name: i.name,
        category: i.category || '',
        unit: i.unit || 'حبة',
        initialStock: initialStock,
        purchasedQty: m.in,
        consumedQty: m.out,
        currentStock: currentStock,
        minStock: Number(i.min_stock) || 0,
        cost: Number(i.cost) || 0
      };
    });
    res.json(result);
  } catch (e) {
    res.json([]);
  }
});

// ─── Stocktakes ───

// Submit a new stocktake: adjusts stock + records movements + persists the report
router.post('/stocktakes', async (req, res) => {
  try {
    const { items, username, notes } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'No items' });

    const now = new Date();
    const stId = 'ST-' + Date.now();
    let adjustedCount = 0;
    let totalVariance = 0;

    // Insert header FIRST so the FK on stocktake_items doesn't fail
    await db.query(
      'INSERT INTO stocktakes (id, stocktake_date, username, notes, status, items_count, total_variance) VALUES (?,?,?,?,?,?,?)',
      [stId, now, username || '', notes || '', 'completed', 0, 0]
    );

    for (const item of items) {
      const itemId = item.id;
      const sysQty = Number(item.sys || item.systemQty) || 0;
      const actQty = Number(item.actual || item.actualQty) || 0;
      const diff = Number(item.diff) || (actQty - sysQty);
      if (Math.abs(diff) < 0.001) continue;

      // Get item info for the record
      const [inv] = await db.query('SELECT name, unit FROM inv_items WHERE id = ?', [itemId]);
      const invName = inv.length ? inv[0].name : '';
      const invUnit = inv.length ? (inv[0].unit || '') : '';

      // Save stocktake line
      await db.query(
        'INSERT INTO stocktake_items (stocktake_id, inv_item_id, inv_item_name, unit, system_qty, actual_qty, variance) VALUES (?,?,?,?,?,?,?)',
        [stId, itemId, invName, invUnit, sysQty, actQty, diff]
      );

      // Update actual stock
      await db.query('UPDATE inv_items SET stock = ? WHERE id = ?', [actQty, itemId]);

      // Record movement
      const movType = diff > 0 ? 'in' : 'out';
      const movQty = Math.abs(diff);
      const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
        [movId, now, itemId, invName, movType, movQty, 'جرد', username || '', 'ST: ' + stId]
      );

      totalVariance += diff;
      adjustedCount++;
    }

    // Update header with final counts
    await db.query(
      'UPDATE stocktakes SET items_count = ?, total_variance = ? WHERE id = ?',
      [adjustedCount, totalVariance, stId]
    );

    // Recompute menu costs since inventory changed
    try {
      const { recomputeAllMenuCosts } = require('./pricing-utils');
      await recomputeAllMenuCosts();
    } catch (e) {}

    res.json({ success: true, stocktakeId: stId, adjustedCount });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get all stocktakes (list)
router.get('/stocktakes', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM stocktakes ORDER BY stocktake_date DESC LIMIT 200');
    res.json(rows.map(s => ({
      id: s.id, date: s.stocktake_date, username: s.username, notes: s.notes,
      status: s.status, itemsCount: s.items_count, totalVariance: Number(s.total_variance)
    })));
  } catch (e) { res.json([]); }
});

// Get stocktake detail
router.get('/stocktakes/:id', async (req, res) => {
  try {
    const [headers] = await db.query('SELECT * FROM stocktakes WHERE id = ?', [req.params.id]);
    if (!headers.length) return res.json({ error: 'Not found' });
    const st = headers[0];
    const [items] = await db.query('SELECT si.*, COALESCE(inv.cost, 0) AS unit_cost FROM stocktake_items si LEFT JOIN inv_items inv ON si.inv_item_id = inv.id WHERE si.stocktake_id = ? ORDER BY si.id', [req.params.id]);
    var totalVarianceCost = 0;
    var mappedItems = items.map(i => {
      var variance = Number(i.variance);
      var unitCost = Number(i.unit_cost) || 0;
      var varianceCost = variance * unitCost; // negative = deficit
      totalVarianceCost += varianceCost;
      return {
        invItemId: i.inv_item_id, invItemName: i.inv_item_name, unit: i.unit,
        systemQty: Number(i.system_qty), actualQty: Number(i.actual_qty), variance: variance,
        unitCost: unitCost, varianceCost: varianceCost
      };
    });
    res.json({
      id: st.id, date: st.stocktake_date, username: st.username, notes: st.notes,
      status: st.status, itemsCount: st.items_count, totalVariance: Number(st.total_variance),
      totalVarianceCost: totalVarianceCost,
      items: mappedItems
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Delete stocktake (developer only — checked on frontend)
router.delete('/stocktakes/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM stocktakes WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── Stock Adjustments (تعديل كمية) ───

const REASON_LABELS = { damaged: 'تالف', admin: 'إداري', settlement: 'تسويات' };

// Create adjustment (draft — needs approval)
router.post('/adjustments', async (req, res) => {
  try {
    const { items, reason, reasonNotes, username } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'No items' });

    const now = new Date();
    const adjId = 'ADJ-' + Date.now();
    let totalCost = 0;

    // Insert header first (FK)
    await db.query(
      'INSERT INTO stock_adjustments (id, adjustment_date, reason, reason_notes, username, status, items_count, total_cost) VALUES (?,?,?,?,?,?,?,?)',
      [adjId, now, reason || 'damaged', reasonNotes || '', username || '', 'pending', 0, 0]
    );

    for (const item of items) {
      const [inv] = await db.query('SELECT id, name, unit, stock, cost, conv_rate FROM inv_items WHERE id = ?', [item.id]);
      if (!inv.length) continue;
      const r = inv[0];
      const qty = Number(item.qty) || 0;
      if (qty <= 0) continue;
      const unitCost = Number(r.cost) || 0; // per small unit
      const lineCost = qty * unitCost;
      const stockBefore = Number(r.stock) || 0;
      const stockAfter = stockBefore - qty;

      await db.query(
        'INSERT INTO stock_adjustment_items (adjustment_id, inv_item_id, inv_item_name, unit, qty, unit_cost, total_cost, stock_before, stock_after) VALUES (?,?,?,?,?,?,?,?,?)',
        [adjId, r.id, r.name, r.unit || '', qty, unitCost, lineCost, stockBefore, stockAfter < 0 ? 0 : stockAfter]
      );
      totalCost += lineCost;
    }

    await db.query('UPDATE stock_adjustments SET items_count = ?, total_cost = ? WHERE id = ?',
      [items.length, totalCost, adjId]);

    res.json({ success: true, adjustmentId: adjId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Approve adjustment — actually deducts stock
router.post('/adjustments/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    const now = new Date();

    const [adj] = await db.query('SELECT * FROM stock_adjustments WHERE id = ?', [id]);
    if (!adj.length) return res.json({ success: false, error: 'Not found' });
    if (adj[0].status === 'approved') return res.json({ success: false, error: 'Already approved' });

    const [items] = await db.query('SELECT * FROM stock_adjustment_items WHERE adjustment_id = ?', [id]);

    for (const item of items) {
      // Deduct from stock
      await db.query('UPDATE inv_items SET stock = GREATEST(0, stock - ?) WHERE id = ?', [item.qty, item.inv_item_id]);

      // Record movement
      const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
        [movId, now, item.inv_item_id, item.inv_item_name, 'out', item.qty,
         REASON_LABELS[adj[0].reason] || 'تعديل كمية', username || '', 'ADJ: ' + id]
      );
    }

    await db.query(
      'UPDATE stock_adjustments SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?',
      [username || '', now, id]
    );

    // Recompute menu costs
    try { const { recomputeAllMenuCosts } = require('./pricing-utils'); await recomputeAllMenuCosts(); } catch(e) {}

    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// List adjustments
router.get('/adjustments', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM stock_adjustments ORDER BY adjustment_date DESC LIMIT 200');
    res.json(rows.map(a => ({
      id: a.id, date: a.adjustment_date, reason: a.reason,
      reasonLabel: REASON_LABELS[a.reason] || a.reason,
      reasonNotes: a.reason_notes, username: a.username,
      status: a.status, itemsCount: a.items_count,
      totalCost: Number(a.total_cost), approvedBy: a.approved_by, approvedAt: a.approved_at
    })));
  } catch (e) { res.json([]); }
});

// Detail
router.get('/adjustments/:id', async (req, res) => {
  try {
    const [headers] = await db.query('SELECT * FROM stock_adjustments WHERE id = ?', [req.params.id]);
    if (!headers.length) return res.json({ error: 'Not found' });
    const a = headers[0];
    const [items] = await db.query('SELECT * FROM stock_adjustment_items WHERE adjustment_id = ?', [req.params.id]);
    res.json({
      id: a.id, date: a.adjustment_date, reason: a.reason,
      reasonLabel: REASON_LABELS[a.reason] || a.reason,
      reasonNotes: a.reason_notes, username: a.username,
      status: a.status, itemsCount: a.items_count,
      totalCost: Number(a.total_cost), approvedBy: a.approved_by, approvedAt: a.approved_at,
      items: items.map(i => ({
        invItemId: i.inv_item_id, invItemName: i.inv_item_name, unit: i.unit,
        qty: Number(i.qty), unitCost: Number(i.unit_cost), totalCost: Number(i.total_cost),
        stockBefore: Number(i.stock_before), stockAfter: Number(i.stock_after)
      }))
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Delete (only pending)
router.delete('/adjustments/:id', async (req, res) => {
  try {
    const [adj] = await db.query('SELECT status FROM stock_adjustments WHERE id = ?', [req.params.id]);
    // Approved adjustments can be deleted by developer (frontend checks isDeveloper)
    await db.query('DELETE FROM stock_adjustments WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// BRANCH RECEIVE (استلام المواد بالفرع)
// ═══════════════════════════════════════

// Submit receive request (cashier enters actual quantities)
router.post('/receive-request', async (req, res) => {
  try {
    const { purchaseId, items, username, notes } = req.body;
    if (!purchaseId || !items || !items.length) return res.json({ success: false, error: 'بيانات ناقصة' });

    // Save received items to the purchase
    await db.query(
      'UPDATE purchases SET received_items_json = ?, receive_status = "pending", received_by = ? WHERE id = ?',
      [JSON.stringify(items), username || '', purchaseId]
    );
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Get pending receive requests
router.get('/receive-requests', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.id, p.supplier_name, p.total_price, p.items_json, p.received_items_json, p.received_by, p.po_id, p.receive_status,
              po.po_number, po.supplier_name AS po_supplier
       FROM purchases p LEFT JOIN purchase_orders po ON p.po_id = po.id
       WHERE p.receive_status = 'pending'
       ORDER BY p.purchase_date DESC`
    );
    res.json(rows.map(r => ({
      id: r.id, supplierName: r.supplier_name || r.po_supplier || '', totalPrice: Number(r.total_price),
      items: JSON.parse(r.items_json || '[]'), receivedItems: JSON.parse(r.received_items_json || '[]'),
      receivedBy: r.received_by, poId: r.po_id, poNumber: r.po_number || '', receiveStatus: r.receive_status
    })));
  } catch(e) { res.json([]); }
});

// Approve receive — updates stock + creates GL journal
router.post('/receive-approve/:id', async (req, res) => {
  try {
    const { username } = req.body;
    const [purchases] = await db.query('SELECT * FROM purchases WHERE id = ? AND receive_status = "pending"', [req.params.id]);
    if (!purchases.length) return res.json({ success: false, error: 'طلب الاستلام غير موجود أو تم اعتماده بالفعل' });

    const purchase = purchases[0];
    const receivedItems = JSON.parse(purchase.received_items_json || '[]');
    if (!receivedItems.length) return res.json({ success: false, error: 'لا توجد مواد مستلمة' });

    const now = new Date();
    let totalNet = 0, totalVat = 0;

    // Process each received item — update stock
    for (const item of receivedItems) {
      const qty = Number(item.receivedQty) || 0;
      if (qty <= 0) continue;

      const [invRows] = await db.query('SELECT * FROM inv_items WHERE id = ?', [item.invItemId || item.id]);
      if (!invRows.length) continue;
      const inv = invRows[0];

      const unitPrice = Number(item.unitPrice) || Number(inv.cost) || 0;
      const netPrice = unitPrice / 1.15; // remove VAT
      const vatAmount = unitPrice - netPrice;

      // WAC
      const stockBefore = Number(inv.stock) || 0;
      const currentCost = Number(inv.cost) || 0;
      let newCost = stockBefore === 0 ? netPrice : ((stockBefore * currentCost) + (qty * netPrice)) / (stockBefore + qty);

      await db.query('UPDATE inv_items SET stock = stock + ?, cost = ? WHERE id = ?', [qty, newCost, inv.id]);

      // Record movement
      const movId = 'MOV-RCV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
        [movId, now, inv.id, inv.name, 'in', qty, 'استلام نقص', username || '', 'PUR:' + req.params.id]
      );

      totalNet += netPrice * qty;
      totalVat += vatAmount * qty;
    }

    // Update purchase status
    await db.query('UPDATE purchases SET status = "received", receive_status = "approved", receive_approved_by = ? WHERE id = ?', [username || '', req.params.id]);
    if (purchase.po_id) {
      await db.query('UPDATE purchase_orders SET status = "received" WHERE id = ?', [purchase.po_id]);
    }

    // ─── GL Journal Entry ───
    let journalNumber = '';
    const totalGross = totalNet + totalVat;
    if (totalGross > 0) {
      const jrnId = 'JRN-RCV-' + Date.now();
      const [lastJ] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
      let jrnNum = 1;
      if (lastJ.length && lastJ[0].journal_number) { const m = lastJ[0].journal_number.match(/(\d+)/); if (m) jrnNum = parseInt(m[1]) + 1; }
      journalNumber = 'JV-' + String(jrnNum).padStart(6, '0');
      const desc = 'استلام مواد — ' + (purchase.supplier_name || '');

      await db.query(
        `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by, posted_by, posted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [jrnId, journalNumber, now, 'purchase_receive', req.params.id, desc, totalGross, totalGross, 'posted', username||'', username||'', now]
      );

      // Debit: Inventory account (112)
      let invAccId = null;
      const [invAcc] = await db.query("SELECT id FROM gl_accounts WHERE code LIKE '112%' AND type='asset' ORDER BY code LIMIT 1");
      if (invAcc.length) invAccId = invAcc[0].id;
      if (invAccId) {
        await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
          ['GLE-RCV-' + Date.now() + '-D1', jrnId, invAccId, '112', 'المخزون', totalNet, 0, desc]);
        await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [totalNet, invAccId]);
      }

      // Debit: Input VAT (1430)
      if (totalVat > 0) {
        let vatAccId = null;
        const [vatAcc] = await db.query("SELECT id FROM gl_accounts WHERE code = '1430' OR (code LIKE '213%' AND type='liability') ORDER BY code LIMIT 1");
        if (vatAcc.length) vatAccId = vatAcc[0].id;
        if (vatAccId) {
          await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
            ['GLE-RCV-' + Date.now() + '-D2', jrnId, vatAccId, '1430', 'ضريبة المدخلات', totalVat, 0, 'ضريبة — ' + desc]);
          await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [totalVat, vatAccId]);
        }
      }

      // Credit: Suppliers/Payables (211)
      let supAccId = null;
      const [supAcc] = await db.query("SELECT id FROM gl_accounts WHERE code LIKE '211%' AND type='liability' ORDER BY code LIMIT 1");
      if (supAcc.length) supAccId = supAcc[0].id;
      if (supAccId) {
        await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
          ['GLE-RCV-' + Date.now() + '-C', jrnId, supAccId, '211', 'الموردون والدائنون', 0, totalGross, desc]);
        await db.query('UPDATE gl_accounts SET balance = balance - ? WHERE id = ?', [totalGross, supAccId]);
      }
    }

    res.json({ success: true, journalNumber, totalNet, totalVat, totalGross });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// SHORTAGE REQUESTS (طلبات النواقص)
// ═══════════════════════════════════════

// Create shortage request (from cashier)
router.post('/shortage-requests', async (req, res) => {
  try {
    const { items, username, notes } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'أضف مادة واحدة على الأقل' });

    const id = 'SHR-' + Date.now();
    const [last] = await db.query('SELECT request_number FROM shortage_requests ORDER BY created_at DESC LIMIT 1');
    let num = 1;
    if (last.length && last[0].request_number) {
      const m = last[0].request_number.match(/(\d+)/);
      if (m) num = parseInt(m[1]) + 1;
    }
    const requestNumber = 'SHR-' + String(num).padStart(5, '0');

    await db.query(
      'INSERT INTO shortage_requests (id, request_number, request_date, username, notes, total_items) VALUES (?,?,?,?,?,?)',
      [id, requestNumber, new Date(), username || '', notes || '', items.length]
    );

    for (const item of items) {
      const itemId = 'SHRI-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO shortage_items (id, request_id, inv_item_id, inv_item_name, unit, current_qty, min_qty, requested_qty, unit_price) VALUES (?,?,?,?,?,?,?,?,?)',
        [itemId, id, item.invItemId || '', item.invItemName || '', item.unit || '', item.currentQty || 0, item.minQty || 0, item.requestedQty || 0, item.unitPrice || 0]
      );
    }

    res.json({ success: true, id, requestNumber });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get shortage requests
router.get('/shortage-requests', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM shortage_requests ORDER BY created_at DESC LIMIT 200');
    res.json(rows.map(r => ({
      id: r.id, requestNumber: r.request_number, requestDate: r.request_date,
      username: r.username, notes: r.notes, status: r.status,
      supplyMode: r.supply_mode, totalItems: r.total_items,
      approvedBy: r.approved_by, approvedAt: r.approved_at, poId: r.po_id
    })));
  } catch (e) { res.json([]); }
});

// Get single shortage request with items
router.get('/shortage-requests/:id', async (req, res) => {
  try {
    const [reqs] = await db.query('SELECT * FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!reqs.length) return res.json({ error: 'Not found' });
    const r = reqs[0];
    const [items] = await db.query('SELECT * FROM shortage_items WHERE request_id = ?', [req.params.id]);
    res.json({
      id: r.id, requestNumber: r.request_number, requestDate: r.request_date,
      username: r.username, notes: r.notes, status: r.status,
      supplyMode: r.supply_mode, totalItems: r.total_items,
      approvedBy: r.approved_by, poId: r.po_id,
      items: items.map(i => ({
        id: i.id, invItemId: i.inv_item_id, invItemName: i.inv_item_name,
        unit: i.unit, currentQty: Number(i.current_qty), minQty: Number(i.min_qty),
        requestedQty: Number(i.requested_qty), unitPrice: Number(i.unit_price)
      }))
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Approve shortage request
router.post('/shortage-requests/:id/approve', async (req, res) => {
  try {
    const { username, supplyMode } = req.body;
    await db.query('UPDATE shortage_requests SET status = "approved", approved_by = ?, approved_at = ?, supply_mode = ? WHERE id = ?',
      [username || '', new Date(), supplyMode || 'parent_company', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Reject shortage request
router.post('/shortage-requests/:id/reject', async (req, res) => {
  try {
    const { username, reason } = req.body;
    await db.query('UPDATE shortage_requests SET status = "rejected", approved_by = ?, approved_at = ?, notes = CONCAT(COALESCE(notes,""), "\n[رفض: ' + (reason||'') + ']") WHERE id = ?',
      [username || '', new Date(), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Convert shortage to Purchase Order
router.post('/shortage-requests/:id/convert-to-po', async (req, res) => {
  try {
    const { username, supplierId, supplierName } = req.body;
    const [reqs] = await db.query('SELECT * FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!reqs.length) return res.json({ success: false, error: 'الطلب غير موجود' });
    const r = reqs[0];
    if (r.status !== 'approved') return res.json({ success: false, error: 'الطلب يجب أن يكون معتمداً أولاً' });

    const [items] = await db.query('SELECT * FROM shortage_items WHERE request_id = ?', [req.params.id]);

    // Create PO
    const poId = 'PO-' + Date.now();
    const [lastPO] = await db.query('SELECT po_number FROM purchase_orders ORDER BY created_at DESC LIMIT 1');
    let poNum = 1;
    if (lastPO.length && lastPO[0].po_number) {
      const m = lastPO[0].po_number.match(/(\d+)/);
      if (m) poNum = parseInt(m[1]) + 1;
    }
    const poNumber = 'PO-' + String(poNum).padStart(5, '0');

    let totalBeforeVat = 0;
    const poLines = items.map(i => {
      const qty = Number(i.requested_qty) || 0;
      const price = Number(i.unit_price) || 0;
      const lineTotal = qty * price;
      totalBeforeVat += lineTotal;
      return { itemId: i.inv_item_id, itemName: i.inv_item_name, unit: i.unit, qty, unitPrice: price, total: lineTotal };
    });

    const vatAmount = totalBeforeVat * 0.15;
    const totalAfterVat = totalBeforeVat + vatAmount;

    await db.query(
      `INSERT INTO purchase_orders (id, po_number, supplier_id, supplier_name, po_date, expected_date, notes, status, total_before_vat, vat_amount, total_after_vat, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [poId, poNumber, supplierId || '', supplierName || '', new Date(), new Date(Date.now() + 7*86400000),
       'من طلب نقص: ' + r.request_number, 'draft', totalBeforeVat, vatAmount, totalAfterVat, username || '']
    );

    for (const line of poLines) {
      const lineId = 'POL-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO po_lines (id, po_id, item_id, item_name, unit, qty, unit_price, vat_rate, vat_amount, total) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [lineId, poId, line.itemId, line.itemName, line.unit, line.qty, line.unitPrice, 15, line.total * 0.15, line.total * 1.15]
      );
    }

    // Update shortage request
    await db.query('UPDATE shortage_requests SET status = "converted", po_id = ? WHERE id = ?', [poId, req.params.id]);

    res.json({ success: true, poId, poNumber });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
