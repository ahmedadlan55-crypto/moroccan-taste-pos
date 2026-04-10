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

module.exports = router;
