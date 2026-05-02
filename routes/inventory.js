const router = require('express').Router();
const db = require('../db/connection');

// Get all inventory items. Optional ?brandId= filter.
router.get('/items', async (req, res) => {
  try {
    const { brandId } = req.query;
    let sql = 'SELECT i.*, b.name AS brand_name FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id';
    const params = [];
    if (brandId) { sql += ' WHERE i.brand_id = ?'; params.push(brandId); }
    sql += ' ORDER BY i.category, i.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(i => ({
      id: i.id, name: i.name, category: i.category,
      cost: Number(i.cost), stock: Number(i.stock), minStock: Number(i.min_stock),
      unit: i.unit, bigUnit: i.big_unit, convRate: Number(i.conv_rate), active: i.active,
      brandId: i.brand_id || '', brand_id: i.brand_id || '', brandName: i.brand_name || ''
    })));
  } catch (e) {
    res.json([]);
  }
});

// Save inventory item (insert or update)
router.post('/items', async (req, res) => {
  try {
    const { id, name, category, cost, stock, minStock, unit, bigUnit, convRate, active, brandId } = req.body;
    const brandIdVal = brandId || null;

    if (id) {
      // Check if exists
      const [existing] = await db.query('SELECT id FROM inv_items WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE inv_items SET name=?, category=?, cost=?, stock=?, min_stock=?, unit=?, big_unit=?, conv_rate=?, active=?, brand_id=? WHERE id=?`,
          [name, category || '', cost || 0, stock || 0, minStock || 0, unit || 'حبة', bigUnit || null, convRate || 1, active !== false, brandIdVal, id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'INV-' + Date.now();
    await db.query(
      `INSERT INTO inv_items (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active, brand_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, category || '', cost || 0, stock || 0, minStock || 0, unit || 'حبة', bigUnit || null, convRate || 1, active !== false, brandIdVal]
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
    let { warehouseId, branchId } = req.body;

    // V3 spec rule: stock movements MUST have warehouse_id + branch_id
    // (يمنع: إنشاء حركات مخزون بدون مستودع وفرع محددين)
    // Try to auto-fill from the requesting user's defaults before rejecting.
    if ((!warehouseId || !branchId) && req.user) {
      try {
        const [u] = await db.query('SELECT branch_id, default_warehouse_id FROM users WHERE username = ? LIMIT 1', [req.user.username || username]);
        if (u.length) {
          branchId = branchId || u[0].branch_id;
          warehouseId = warehouseId || u[0].default_warehouse_id;
        }
      } catch(e) {}
    }
    if (!warehouseId) {
      return res.json({ success: false, error: 'لا يمكن إنشاء حركة مخزون بدون تحديد المستودع. حدّد مستودعاً افتراضياً للمستخدم أو أرسل warehouseId صراحةً.' });
    }

    const now = new Date();
    const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);

    // Insert movement record (with warehouse_id — column already exists)
    try {
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [movId, now, itemId, itemName || '', type, qty, reason || '', username || '', notes || '', warehouseId]
      );
    } catch(e) {
      // Fallback for very old schema without warehouse_id column
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
        [movId, now, itemId, itemName || '', type, qty, reason || '', username || '', notes || '']
      );
    }

    // Update stock on inv_items (central total)
    if (type === 'in') {
      await db.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?', [qty, itemId]);
    } else {
      await db.query('UPDATE inv_items SET stock = GREATEST(0, stock - ?) WHERE id = ?', [qty, itemId]);
    }

    // Also update warehouse_stock so per-warehouse totals stay accurate
    try {
      const wsId = 'WS-' + warehouseId + '-' + itemId;
      const delta = (type === 'in') ? Number(qty) : -Number(qty);
      await db.query(
        `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE qty = GREATEST(0, qty + VALUES(qty))`,
        [wsId, warehouseId, itemId, delta]
      );
    } catch(e) { /* tolerate if warehouse_stock missing on old deploy */ }

    res.json({ success: true, movementId: movId, warehouseId: warehouseId, branchId: branchId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get live inventory (current stock with movements summary). Optional ?brandId= filter.
router.get('/live', async (req, res) => {
  try {
    const { brandId } = req.query;
    let sql = 'SELECT i.*, b.name AS brand_name FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.active = 1';
    const params = [];
    if (brandId) { sql += ' AND i.brand_id = ?'; params.push(brandId); }
    sql += ' ORDER BY i.category, i.name';
    const [items] = await db.query(sql, params);

    // Aggregate inventory movements per item: total purchased (in) and total consumed (out)
    const [movRows] = await db.query(
      "SELECT item_id, type, SUM(qty) AS totalQty FROM inventory_movements GROUP BY item_id, type"
    );
    const movMap = {};
    movRows.forEach(r => {
      const id = r.item_id;
      if (!movMap[id]) movMap[id] = { in: 0, out: 0 };
      if (r.type === 'in') movMap[id].in = Number(r.totalQty) || 0;
      else if (r.type === 'out') movMap[id].out = Number(r.totalQty) || 0;
    });

    const result = items.map(i => {
      const m = movMap[i.id] || { in: 0, out: 0 };
      const currentStock = Number(i.stock) || 0;
      const initialStock = currentStock + m.out - m.in;
      // Determine status for UI convenience
      let status = 'جيد';
      if (currentStock <= 0) status = 'نفد';
      else if (currentStock <= (Number(i.min_stock) || 0)) status = 'منخفض';
      return {
        id: i.id,
        name: i.name,
        category: i.category || '',
        unit: i.unit || 'حبة',
        bigUnit: i.big_unit || '',
        convRate: Number(i.conv_rate) || 1,
        initialStock: initialStock,
        purchasedQty: m.in,
        consumedQty: m.out,
        currentStock: currentStock,
        minStock: Number(i.min_stock) || 0,
        cost: Number(i.cost) || 0,
        status: status,
        brandId: i.brand_id || '',
        brand_id: i.brand_id || '',
        brandName: i.brand_name || ''
      };
    });
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// V5.8.1 — Period-aware live inventory report.
// Returns each item with full breakdown for a date range:
//   • openingStock  — stock as of startDate
//   • purchasedQty  — sum of 'in' movements where reason ~ purchase/receive in period
//   • consumedQty   — sum of 'out' movements where reason ~ sales/production
//   • adjustedQty   — net adjustments in period (negative if shortages)
//   • transferIn    — sum of 'in' transfer movements
//   • transferOut   — sum of 'out' transfer movements
//   • closingStock  — stock as of endDate (= opening + net movements)
//   • value         — closingStock × unit cost
// Query params: brandId?, warehouseId?, category?, startDate, endDate, q?(search)
router.get('/live-report', async (req, res) => {
  try {
    const { brandId, warehouseId, category, startDate, endDate, q } = req.query;
    // Default period: last 30 days
    const endD   = endDate   ? new Date(endDate)   : new Date();
    const startD = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    // Normalize endD to end-of-day so movements on endDate are included
    endD.setHours(23, 59, 59, 999);

    let sql = 'SELECT i.*, b.name AS brand_name FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.active = 1';
    const params = [];
    if (brandId)   { sql += ' AND i.brand_id = ?'; params.push(brandId); }
    if (category)  { sql += ' AND i.category = ?'; params.push(category); }
    if (q)         { sql += ' AND (i.name LIKE ? OR i.id LIKE ?)'; params.push('%'+q+'%', '%'+q+'%'); }
    sql += ' ORDER BY i.category, i.name';
    const [items] = await db.query(sql, params);

    if (!items.length) return res.json({ items: [], totals: _zeroTotals(), period: { startDate: startD, endDate: endD } });

    const itemIds = items.map(r => r.id);
    const placeholders = itemIds.map(() => '?').join(',');
    const whClause = warehouseId ? ' AND warehouse_id = ?' : '';
    const whParam  = warehouseId ? [warehouseId] : [];

    // 1) All movements for these items AFTER startD (regardless of endD).
    //    Purpose: opening = current_stock − sum(net) of all movements after startD.
    //    closing = current_stock − sum(net) of all movements after endD.
    const [allRows] = await db.query(
      'SELECT item_id, type, SUM(qty) AS q FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') AND movement_date > ? ' + whClause +
      ' GROUP BY item_id, type',
      [...itemIds, startD, ...whParam]
    );
    const [postEndRows] = await db.query(
      'SELECT item_id, type, SUM(qty) AS q FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') AND movement_date > ? ' + whClause +
      ' GROUP BY item_id, type',
      [...itemIds, endD, ...whParam]
    );
    const [periodRows] = await db.query(
      'SELECT item_id, type, reason, SUM(qty) AS q FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') AND movement_date >= ? AND movement_date <= ? ' + whClause +
      ' GROUP BY item_id, type, reason',
      [...itemIds, startD, endD, ...whParam]
    );

    // V5.8.2 — PRO ANALYTICS: last movement date per item (any type) and
    //   daily in/out totals for the period (for the trend chart).
    const [lastMovRows] = await db.query(
      'SELECT item_id, MAX(movement_date) AS last_dt FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') ' + whClause +
      ' GROUP BY item_id',
      [...itemIds, ...whParam]
    );
    const [dailyTrend] = await db.query(
      'SELECT DATE(movement_date) AS day, type, SUM(qty) AS q FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') AND movement_date >= ? AND movement_date <= ? ' + whClause +
      ' GROUP BY DATE(movement_date), type ORDER BY day',
      [...itemIds, startD, endD, ...whParam]
    );

    // Index helpers
    const netSinceStart = {}; // item_id → net (in - out) since startD
    allRows.forEach(r => {
      const sign = r.type === 'in' ? 1 : -1;
      netSinceStart[r.item_id] = (netSinceStart[r.item_id] || 0) + sign * Number(r.q || 0);
    });
    const netSinceEnd = {};   // item_id → net (in - out) after endD (used to compute closing)
    postEndRows.forEach(r => {
      const sign = r.type === 'in' ? 1 : -1;
      netSinceEnd[r.item_id] = (netSinceEnd[r.item_id] || 0) + sign * Number(r.q || 0);
    });

    // V5.8.9 — Cost-accountant bucketing.  Each movement reason maps to a
    //   distinct GL/management category so the report mirrors how a real
    //   cost accountant would analyze stock movement:
    //     purchases    → 1200 Inventory (debit)
    //     production   → 1300 WIP / charge to recipe cost (consumption)
    //     sales        → 5300 Cost of Goods Sold (direct sale)
    //     damaged      → 5310 Abnormal Loss / Spoilage
    //     adjustments  → 5320 Inventory Variance (admin/settlement)
    //     stocktake    → variance from physical count (also 5320)
    //     transferIn   → in from another warehouse (no GL impact at company level)
    //     transferOut  → out to another warehouse
    //   `consumed` (legacy) is kept as a SUM of production+sales+damage so
    //   existing UI that reads `consumedQty` keeps working.
    const byItem = {};
    function bucket(reason, type) {
      // CHECK MOST-SPECIFIC FIRST so e.g. "تالف" doesn't fall into "تسويات"
      if (/تالف|spoil|damage|broken/i.test(reason))                return 'damaged';
      if (/مشتريات|استلام|purchase|receive/i.test(reason))         return 'purchases';
      if (/إنتاج|انتاج|production|نصف مصنع|semi/i.test(reason))    return 'production';
      if (/مبيعات|sale/i.test(reason))                             return 'sales';
      if (/إداري|اداري|admin/i.test(reason))                       return 'adjustments';
      if (/تسويات|settlement|adjust/i.test(reason))                return 'adjustments';
      if (/تحويل|transfer/i.test(reason))                          return type === 'in' ? 'transferIn' : 'transferOut';
      if (/جرد|stocktake|variance/i.test(reason))                  return 'stocktake';
      // Unknown reason: treat by type
      return type === 'in' ? 'purchases' : 'sales';
    }
    periodRows.forEach(r => {
      if (!byItem[r.item_id]) byItem[r.item_id] = {
        purchases: 0, production: 0, sales: 0, damaged: 0,
        adjustments: 0, transferIn: 0, transferOut: 0, stocktake: 0
      };
      const b = bucket(r.reason, r.type);
      byItem[r.item_id][b] = (byItem[r.item_id][b] || 0) + Number(r.q || 0);
    });

    // V5.8.2 — Pro analytics: index last-movement + period length for aging.
    const lastMovMap = {};
    lastMovRows.forEach(r => { lastMovMap[r.item_id] = r.last_dt ? new Date(r.last_dt) : null; });
    const periodDays = Math.max(1, Math.ceil((endD - startD) / (24 * 3600 * 1000)));
    const SLOW_DAYS = 60;  // Items with no movement in 60+ days are "slow-moving"

    // Compute the per-item summary
    const totals = _zeroTotals();
    const result = items.map(i => {
      const cur = Number(i.stock) || 0;
      const opening = cur - (netSinceStart[i.id] || 0);
      const closing = cur - (netSinceEnd[i.id]   || 0);
      const b = byItem[i.id] || {
        purchases: 0, production: 0, sales: 0, damaged: 0,
        adjustments: 0, transferIn: 0, transferOut: 0, stocktake: 0
      };
      // V5.8.9 — legacy `consumed` = production + sales (everything that hits COGS/WIP)
      const consumed = b.production + b.sales;
      const cost = Number(i.cost) || 0;
      const value = closing * cost;
      let status = 'جيد';
      if (closing <= 0) status = 'نفد';
      else if (closing <= (Number(i.min_stock) || 0)) status = 'منخفض';

      // V5.8.2 — pro fields
      const lastMov = lastMovMap[i.id] || null;
      const daysSinceLastMov = lastMov ? Math.floor((Date.now() - lastMov.getTime()) / (24 * 3600 * 1000)) : null;
      const isSlowMoving = (daysSinceLastMov === null) || (daysSinceLastMov >= SLOW_DAYS);
      const isNegative   = closing < 0;
      // Reorder suggestion based on sales+production rate (true demand)
      const dailyConsumption = consumed / periodDays;
      const suggestedReorder = Math.max(0,
        Math.ceil(dailyConsumption * 14) - Math.max(0, closing)
      );
      const avgInventory = (opening + closing) / 2;
      const turnover = avgInventory > 0 ? (consumed / avgInventory) : 0;

      totals.openingValue     += opening * cost;
      totals.purchasesValue   += b.purchases * cost;
      totals.consumedValue    += consumed * cost;          // legacy total
      totals.productionValue  += b.production * cost;       // V5.8.9
      totals.salesValue       += b.sales * cost;            // V5.8.9
      totals.damagedValue     += b.damaged * cost;          // V5.8.9
      totals.adjustValue      += b.adjustments * cost;
      totals.closingValue     += value;
      totals.itemCount++;
      if (status === 'منخفض') totals.lowCount++;
      if (status === 'نفد')   totals.outCount++;
      if (isNegative)         totals.negativeCount++;
      if (isSlowMoving && closing > 0) totals.slowMovingCount++;
      if (suggestedReorder > 0)        totals.reorderCount++;
      if (b.damaged > 0)               totals.damagedCount++;

      return {
        id: i.id,
        name: i.name,
        category: i.category || '',
        unit: i.unit || 'حبة',
        bigUnit: i.big_unit || '',
        convRate: Number(i.conv_rate) || 1,
        cost: cost,
        minStock: Number(i.min_stock) || 0,
        brandId: i.brand_id || '',
        brandName: i.brand_name || '',
        openingStock: opening,
        purchasedQty: b.purchases,
        consumedQty:  consumed,         // legacy field (= production + sales)
        productionQty: b.production,    // V5.8.9 — separate
        salesQty:     b.sales,          // V5.8.9 — separate
        damagedQty:   b.damaged,        // V5.8.9 — separate
        adjustedQty:  b.adjustments,
        transferIn:   b.transferIn,
        transferOut:  b.transferOut,
        stocktakeQty: b.stocktake,
        closingStock: closing,
        value: value,
        status: status,
        lastMovementDate: lastMov,
        daysSinceLastMov: daysSinceLastMov,
        isSlowMoving: isSlowMoving && closing > 0,
        isNegative: isNegative,
        suggestedReorder: suggestedReorder,
        turnover: Math.round(turnover * 100) / 100,
        abcClass: ''
      };
    });

    // V5.8.2 — ABC classification (Pareto). Sort by value desc, mark first
    //   80% of cumulative value as A, next 15% as B, last 5% as C.
    const sortedByValue = result.slice().sort((a, b) => b.value - a.value);
    const totalValue = sortedByValue.reduce((s, x) => s + (x.value || 0), 0);
    let cumulative = 0;
    sortedByValue.forEach(x => {
      cumulative += x.value || 0;
      const pct = totalValue > 0 ? (cumulative / totalValue) : 0;
      x.abcClass = pct <= 0.80 ? 'A' : pct <= 0.95 ? 'B' : 'C';
    });
    // Aggregate ABC totals
    totals.abcA = sortedByValue.filter(x => x.abcClass === 'A').length;
    totals.abcB = sortedByValue.filter(x => x.abcClass === 'B').length;
    totals.abcC = sortedByValue.filter(x => x.abcClass === 'C').length;
    totals.abcAValue = sortedByValue.filter(x => x.abcClass === 'A').reduce((s, x) => s + (x.value || 0), 0);
    totals.abcBValue = sortedByValue.filter(x => x.abcClass === 'B').reduce((s, x) => s + (x.value || 0), 0);
    totals.abcCValue = sortedByValue.filter(x => x.abcClass === 'C').reduce((s, x) => s + (x.value || 0), 0);

    // V5.8.2 — Stock turnover (overall): consumption value / avg inventory value.
    totals.turnover = totals.openingValue > 0
      ? Math.round((totals.consumedValue / ((totals.openingValue + totals.closingValue) / 2 || 1)) * 100) / 100
      : 0;

    // V5.8.2 — Build a daily trend series for the period (in vs out).
    //   Returns an array of { day: 'YYYY-MM-DD', inQty, outQty, inValue, outValue }
    //   Quantities are summed; values use a weighted-average cost across all items.
    const avgCost = items.reduce((s, x) => s + (Number(x.cost) || 0), 0) / Math.max(1, items.length);
    const trendByDay = {};
    dailyTrend.forEach(r => {
      const day = r.day instanceof Date
        ? r.day.toISOString().slice(0, 10)
        : String(r.day).slice(0, 10);
      if (!trendByDay[day]) trendByDay[day] = { day, inQty: 0, outQty: 0, inValue: 0, outValue: 0 };
      const q = Number(r.q) || 0;
      if (r.type === 'in') {
        trendByDay[day].inQty += q;
        trendByDay[day].inValue += q * avgCost;
      } else {
        trendByDay[day].outQty += q;
        trendByDay[day].outValue += q * avgCost;
      }
    });
    // Fill missing days with zero (so the chart x-axis is continuous)
    const trend = [];
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      trend.push(trendByDay[key] || { day: key, inQty: 0, outQty: 0, inValue: 0, outValue: 0 });
    }

    res.json({
      items: result,
      totals: totals,
      trend: trend,
      period: { startDate: startD, endDate: endD, days: periodDays }
    });
  } catch (e) {
    res.json({ error: e.message, items: [], totals: _zeroTotals(), trend: [] });
  }
});

function _zeroTotals() {
  return {
    itemCount: 0,
    lowCount: 0,
    outCount: 0,
    negativeCount:    0,
    slowMovingCount:  0,
    reorderCount:     0,
    damagedCount:     0,        // V5.8.9 — items with any damage in period
    openingValue:   0,
    purchasesValue: 0,
    consumedValue:  0,           // legacy: production + sales
    productionValue: 0,          // V5.8.9
    salesValue:     0,           // V5.8.9
    damagedValue:   0,           // V5.8.9 — abnormal loss expense
    adjustValue:    0,           // admin + settlement only
    closingValue:   0,
    abcA: 0, abcB: 0, abcC: 0,
    abcAValue: 0, abcBValue: 0, abcCValue: 0,
    turnover: 0
  };
}

// V5.8.1 — Per-item movement detail for the drill-down popup.
//   GET /api/inventory/live-report/:itemId/movements?startDate&endDate
router.get('/live-report/:itemId/movements', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { startDate, endDate } = req.query;
    const endD   = endDate   ? new Date(endDate)   : new Date();
    const startD = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    endD.setHours(23, 59, 59, 999);
    const [rows] = await db.query(
      'SELECT id, movement_date, type, qty, reason, username, notes, warehouse_id FROM inventory_movements ' +
      'WHERE item_id = ? AND movement_date BETWEEN ? AND ? ORDER BY movement_date DESC LIMIT 200',
      [itemId, startD, endD]
    );
    res.json(rows.map(r => ({
      id: r.id,
      date: r.movement_date,
      type: r.type,
      qty:  Number(r.qty) || 0,
      reason: r.reason || '',
      username: r.username || '',
      notes: r.notes || '',
      warehouseId: r.warehouse_id || ''
    })));
  } catch (e) { res.json([]); }
});

// ─── Stocktakes ───

// Submit a new stocktake: adjusts stock + records movements + persists the report
router.post('/stocktakes', async (req, res) => {
  try {
    const { items, username, notes, warehouseId, branchId, brandId } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'No items' });

    const now = new Date();
    const stId = 'ST-' + Date.now();
    let adjustedCount = 0;
    let totalVariance = 0;
    let totalGainCost = 0;    // surplus (diff > 0) at avg cost
    let totalLossCost = 0;    // shortage (diff < 0) at avg cost

    // Insert header with warehouse + branch reference
    await db.query(
      'INSERT INTO stocktakes (id, stocktake_date, username, notes, status, items_count, total_variance, warehouse_id, branch_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [stId, now, username || '', notes || '', 'completed', 0, 0, warehouseId || null, branchId || null]
    );

    // V5.8.5 — counted-but-matched items are RECORDED in stocktake_items
    //   for the audit trail (so a "no-variance" stocktake still writes a
    //   complete report) but skip the stock/movement/GL side-effects.
    let countedCount = 0;
    for (const item of items) {
      const itemId = item.id;
      const sysQty = Number(item.sys || item.systemQty) || 0;
      const actQty = Number(item.actual || item.actualQty) || 0;
      const diff = Number(item.diff) || (actQty - sysQty);

      // Get item info (needed for the audit row regardless of variance)
      const [inv] = await db.query('SELECT name, unit, COALESCE(cost,0) AS avg_cost FROM inv_items WHERE id = ?', [itemId]);
      const invName = inv.length ? inv[0].name : '';
      const invUnit = inv.length ? (inv[0].unit || '') : '';
      const invCost = inv.length ? (Number(inv[0].avg_cost) || 0) : 0;

      // Always record the line — proof that this item was reviewed.
      await db.query(
        'INSERT INTO stocktake_items (stocktake_id, inv_item_id, inv_item_name, unit, system_qty, actual_qty, variance) VALUES (?,?,?,?,?,?,?)',
        [stId, itemId, invName, invUnit, sysQty, actQty, diff]
      );
      countedCount++;

      // Skip the side-effects for items with no variance
      if (Math.abs(diff) < 0.001) continue;

      const varianceCost = Math.abs(diff) * invCost;
      if (diff > 0) totalGainCost += varianceCost;
      else          totalLossCost += varianceCost;

      // Update central stock
      await db.query('UPDATE inv_items SET stock = ? WHERE id = ?', [actQty, itemId]);

      // Update warehouse stock if warehouse specified
      if (warehouseId) {
        const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE qty = ?',
          [wsId, warehouseId, itemId, actQty, actQty]
        );
      }

      // Record movement with warehouse reference
      const movType = diff > 0 ? 'in' : 'out';
      const movQty = Math.abs(diff);
      const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [movId, now, itemId, invName, movType, movQty, 'جرد', username || '', 'ST: ' + stId, warehouseId || null]
      );

      totalVariance += diff;
      adjustedCount++;
    }

    // V5.8.5 — items_count = total counted (incl. matched), total_variance = sum of diffs.
    //   That way the audit list shows "12 صنف، 0 تباين" for a clean monthly check.
    await db.query(
      'UPDATE stocktakes SET items_count = ?, total_variance = ? WHERE id = ?',
      [countedCount, totalVariance, stId]
    );

    // Recompute menu costs since inventory changed
    try {
      const { recomputeAllMenuCosts } = require('./pricing-utils');
      await recomputeAllMenuCosts();
    } catch (e) {}

    // ═══ AUTO GL POSTING — Stock Count Variance ═══
    // Surplus: Dr Inventory / Cr Stock Gain (revenue)
    // Shortage: Dr Stock Variance Expense / Cr Inventory
    // We post ONE consolidated journal with both legs if both directions exist.
    let postingWarning = null;
    if (totalGainCost > 0 || totalLossCost > 0) {
      try {
        const gl = require('../lib/glPosting');
        const entries = [];
        if (totalGainCost > 0) {
          const g = Math.round(totalGainCost * 100) / 100;
          entries.push({ accountCode: '1200', debit: g, credit: 0,
            description: 'Inventory surplus (stocktake)',
            branchId: branchId || null, brandId: brandId || null, warehouseId: warehouseId || null });
          entries.push({ accountCode: '4910', debit: 0, credit: g,
            description: 'Stock count gain',
            branchId: branchId || null, brandId: brandId || null });
        }
        if (totalLossCost > 0) {
          const l = Math.round(totalLossCost * 100) / 100;
          entries.push({ accountCode: '5300', debit: l, credit: 0,
            description: 'Inventory shortage (stocktake)',
            branchId: branchId || null, brandId: brandId || null });
          entries.push({ accountCode: '1200', debit: 0, credit: l,
            description: 'Inventory reduction (stocktake)',
            branchId: branchId || null, brandId: brandId || null, warehouseId: warehouseId || null });
        }
        const post = await gl.postJournal(db, {
          journalDate: now.toISOString().slice(0, 10),
          description: 'Stock count variance — ' + stId,
          referenceType: 'Stocktake',
          referenceId: stId,
          entries,
          postedBy: username || ''
        });
        if (!post.success) postingWarning = post.error;
      } catch(e) { postingWarning = e.message; }
    }

    res.json({
      success: true, stocktakeId: stId, adjustedCount,
      totalGainCost: Math.round(totalGainCost * 100) / 100,
      totalLossCost: Math.round(totalLossCost * 100) / 100,
      postingWarning
    });
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

    // Record differences in PO notes
    const originalItems = JSON.parse(purchase.items_json || '[]');
    let diffNotes = '';
    receivedItems.forEach(function(ri) {
      const orig = originalItems.find(function(o) { return (o.id||o.itemId) === (ri.invItemId||ri.id); });
      const ordered = orig ? (Number(orig.qty)||0) : 0;
      const received = Number(ri.receivedQty) || 0;
      const diff = received - ordered;
      if (diff !== 0) {
        diffNotes += (ri.invItemName||ri.name||'') + ' — Ordered ' + ordered + ' — Received ' + received + ' — Diff ' + (diff>0?'+':'') + diff + '\n';
      }
    });

    // Check if partial or full receive
    const allReceived = receivedItems.every(function(ri) {
      const orig = originalItems.find(function(o) { return (o.id||o.itemId) === (ri.invItemId||ri.id); });
      return (Number(ri.receivedQty)||0) >= (orig ? Number(orig.qty)||0 : 0);
    });

    // Update purchase status
    await db.query('UPDATE purchases SET status = "received", receive_status = "approved", receive_approved_by = ? WHERE id = ?', [username || '', req.params.id]);
    if (purchase.po_id) {
      const poStatus = allReceived ? 'received' : 'partially_received';
      await db.query('UPDATE purchase_orders SET status = ? WHERE id = ?', [poStatus, purchase.po_id]);
      // Save differences in PO notes
      if (diffNotes) {
        await db.query('UPDATE purchase_orders SET notes = CONCAT(COALESCE(notes,""), ?) WHERE id = ?', ['\n--- فروقات الاستلام ---\n' + diffNotes, purchase.po_id]);
      }
    }

    // Update linked shortage request status
    if (purchase.po_id) {
      const shrStatus = allReceived ? 'fully_received' : 'partially_received';
      await db.query("UPDATE shortage_requests SET status = ? WHERE po_id = ?", [shrStatus, purchase.po_id]);
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
    const { items, username, notes, warehouseId, branchId, brandId } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'أضف مادة واحدة على الأقل' });

    // Auto-resolve brand from user's HR profile if not supplied
    let resolvedBrandId = brandId || null;
    let resolvedBranchId = branchId || null;
    if (!resolvedBrandId && username) {
      try {
        const [u] = await db.query(
          'SELECT brand_id, branch_id FROM users WHERE username = ? LIMIT 1',
          [username]);
        if (u.length) {
          resolvedBrandId = resolvedBrandId || u[0].brand_id;
          resolvedBranchId = resolvedBranchId || u[0].branch_id;
        }
      } catch(e) {}
    }

    const id = 'SHR-' + Date.now();
    const [last] = await db.query('SELECT request_number FROM shortage_requests ORDER BY created_at DESC LIMIT 1');
    let num = 1;
    if (last.length && last[0].request_number) {
      const m = last[0].request_number.match(/(\d+)/);
      if (m) num = parseInt(m[1]) + 1;
    }
    const requestNumber = 'SHR-' + String(num).padStart(5, '0');

    await db.query(
      'INSERT INTO shortage_requests (id, request_number, request_date, username, notes, total_items, branch_id, warehouse_id, brand_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, requestNumber, new Date(), username || '', notes || '', items.length, resolvedBranchId, warehouseId || null, resolvedBrandId]
    );

    for (const item of items) {
      const itemId = 'SHRI-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO shortage_items (id, request_id, inv_item_id, inv_item_name, unit, current_qty, min_qty, requested_qty, unit_price) VALUES (?,?,?,?,?,?,?,?,?)',
        [itemId, id, item.invItemId || '', item.invItemName || '', item.unit || '', item.currentQty || 0, item.minQty || 0, item.requestedQty || 0, item.unitPrice || 0]
      );
    }

    res.json({ success: true, id, requestNumber, brandId: resolvedBrandId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get shortage requests (brand-aware)
router.get('/shortage-requests', async (req, res) => {
  try {
    const { brandId, status, branchId } = req.query;
    let sql = `SELECT r.*, b.name AS brand_name, br.name AS branch_name
               FROM shortage_requests r
               LEFT JOIN brands b ON b.id = r.brand_id
               LEFT JOIN branches br ON br.id = r.branch_id
               WHERE 1=1`;
    const params = [];
    if (brandId)  { sql += ' AND r.brand_id = ?';  params.push(brandId); }
    if (status)   { sql += ' AND r.status = ?';    params.push(status); }
    if (branchId) { sql += ' AND r.branch_id = ?'; params.push(branchId); }
    sql += ' ORDER BY r.created_at DESC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, requestNumber: r.request_number, requestDate: r.request_date,
      username: r.username, notes: r.notes, status: r.status,
      supplyMode: r.supply_mode, totalItems: r.total_items,
      approvedBy: r.approved_by, approvedAt: r.approved_at, poId: r.po_id,
      brandId: r.brand_id || '', brand_id: r.brand_id || '', brandName: r.brand_name || '',
      branchId: r.branch_id || '', branchName: r.branch_name || ''
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
    const rejectNote = '\n[رفض: ' + (reason || 'بدون سبب') + ']';
    await db.query('UPDATE shortage_requests SET status = "rejected", approved_by = ?, approved_at = ?, notes = CONCAT(COALESCE(notes,""), ?) WHERE id = ?',
      [username || '', new Date(), rejectNote, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update pending shortage request (branch manager can edit before approval)
router.put('/shortage-requests/:id', async (req, res) => {
  try {
    const { items, notes } = req.body;
    const [reqs] = await db.query('SELECT status FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!reqs.length) return res.json({ success: false, error: 'الطلب غير موجود' });
    if (reqs[0].status !== 'pending') return res.json({ success: false, error: 'فقط الطلبات المعلقة يمكن تعديلها' });
    if (!items || !items.length) return res.json({ success: false, error: 'أضف مادة واحدة على الأقل' });

    // Delete old items and insert new ones
    await db.query('DELETE FROM shortage_items WHERE request_id = ?', [req.params.id]);
    for (const item of items) {
      const itemId = 'SHRI-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO shortage_items (id, request_id, inv_item_id, inv_item_name, unit, current_qty, min_qty, requested_qty, unit_price) VALUES (?,?,?,?,?,?,?,?,?)',
        [itemId, req.params.id, item.invItemId||'', item.invItemName||'', item.unit||'', item.currentQty||0, item.minQty||0, item.requestedQty||0, item.unitPrice||0]
      );
    }
    await db.query('UPDATE shortage_requests SET notes = ?, total_items = ? WHERE id = ?', [notes||'', items.length, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Delete shortage request (developer only)
router.delete('/shortage-requests/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM shortage_items WHERE request_id = ?', [req.params.id]);
    await db.query('DELETE FROM shortage_requests WHERE id = ?', [req.params.id]);
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

    // ─── V3 spec: auto-fill brand/branch/warehouse from the shortage request ───
    // Allow override via req.body if admin wants to redirect to a different warehouse
    const targetBrandId  = req.body.brandId  || r.brand_id  || null;
    const targetBranchId = req.body.branchId || r.branch_id || null;
    let targetWarehouseId = req.body.warehouseId || null;
    // If no explicit warehouse given, derive from the requesting branch
    if (!targetWarehouseId && targetBranchId) {
      try {
        const [br] = await db.query('SELECT warehouse_id FROM branches WHERE id = ?', [targetBranchId]);
        if (br.length && br[0].warehouse_id) targetWarehouseId = br[0].warehouse_id;
      } catch(e) {}
    }

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

    // Try inserting with brand_id/branch_id (V3); fall back to legacy columns if those
    // columns don't exist on a very old deploy.
    try {
      await db.query(
        `INSERT INTO purchase_orders (id, po_number, supplier_id, supplier_name, po_date, expected_date, notes, status, total_before_vat, vat_amount, total_after_vat, created_by, brand_id, branch_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [poId, poNumber, supplierId || '', supplierName || '', new Date(), new Date(Date.now() + 7*86400000),
         'من طلب نقص: ' + r.request_number, 'draft', totalBeforeVat, vatAmount, totalAfterVat, username || '',
         targetBrandId, targetBranchId]
      );
    } catch (e) {
      await db.query(
        `INSERT INTO purchase_orders (id, po_number, supplier_id, supplier_name, po_date, expected_date, notes, status, total_before_vat, vat_amount, total_after_vat, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [poId, poNumber, supplierId || '', supplierName || '', new Date(), new Date(Date.now() + 7*86400000),
         'من طلب نقص: ' + r.request_number, 'draft', totalBeforeVat, vatAmount, totalAfterVat, username || '']
      );
    }

    for (const line of poLines) {
      const lineId = 'POL-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO po_lines (id, po_id, item_id, item_name, unit, qty, unit_price, vat_rate, vat_amount, total) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [lineId, poId, line.itemId, line.itemName, line.unit, line.qty, line.unitPrice, 15, line.total * 0.15, line.total * 1.15]
      );
    }

    // Update shortage request
    await db.query('UPDATE shortage_requests SET status = "converted", po_id = ? WHERE id = ?', [poId, req.params.id]);

    res.json({
      success: true, poId, poNumber,
      brandId: targetBrandId, branchId: targetBranchId, warehouseId: targetWarehouseId
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
