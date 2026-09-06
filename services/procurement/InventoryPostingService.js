/**
 * services/procurement/InventoryPostingService.js
 *
 * THE single code path that mutates stock for procurement (goods receipts and
 * purchase returns). All writes to warehouse_stock / inv_items / purchase_lots
 * / inventory_movements / item_cost_history / inventory_cost_history for the
 * P2P module flow
 * through here — this is what makes "zero dual-write" provable.
 *
 * Concurrency: every call runs inside the caller's transaction and takes
 * `FOR UPDATE` row locks on the po_line + inv_item so two concurrent receipts
 * against the same PO cannot exceed the ordered quantity.
 *
 * Costing: warehouse_stock is the valuation source of truth. Each
 * (item,warehouse) has its own moving weighted-average; inv_items.cost is only
 * a derived, quantity-weighted roll-up across warehouses. Every stock line is
 * recorded in item_cost_history inside the caller's transaction. The legacy
 * inventory_cost_history row records changes to the derived global roll-up.
 *
 * Lots: one purchase_lots row per received line (linked back onto the receipt
 * line via purchase_lot_id) so reversals/returns can target the exact lot —
 * FEFO is never re-run on a reversal.
 */
'use strict';

const calc = require('../../lib/procurement/calculations');
const { err } = require('../../lib/procurement/errors');
const landedCost = require('../../lib/procurement/landedCost');

/**
 * Landed cost: the unit cost that enters the warehouse WAC, the lot and the
 * item roll-up is the LANDED one when the receipt allocated import charges to
 * the line, else the supplier's base unit cost. A NULL landed cost means "no
 * charges on this receipt", so the goods price IS the landed price — it is
 * never a 0 to be averaged in.
 */
function _stockUnitCost(ln, baseUnitCost) {
  return ln.landed_unit_cost != null && ln.landed_unit_cost !== '' ? calc.rate(ln.landed_unit_cost) : baseUnitCost;
}
function _lineChargeValue(ln) {
  return ln.landed_charge_amount != null && ln.landed_charge_amount !== '' ? calc.round(ln.landed_charge_amount, landedCost.ALLOC_DP) : 0;
}

function _genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

const OVER_RECEIPT_TOLERANCE = (() => {
  const n = Number(process.env.PROCUREMENT_OVER_RECEIPT_TOLERANCE);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

async function _lockItem(conn, itemId) {
  const [rows] = await conn.query(
    'SELECT id, stock, cost, tracking_mode FROM inv_items WHERE id = ? FOR UPDATE', [itemId]);
  if (!rows.length) throw err('VALIDATION_ERROR', `المادة غير موجودة: ${itemId}`);
  return rows[0];
}

async function _warehouseQty(conn, warehouseId, itemId) {
  const [rows] = await conn.query(
    'SELECT id, qty, avg_cost, last_cost FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ? FOR UPDATE',
    [warehouseId, itemId]);
  return rows[0] || null;
}

async function _writeWarehouseStock(conn, { existing, warehouseId, itemId, newQty, newAvgCost, lastCost, actor }) {
  if (existing) {
    await conn.query(
      'UPDATE warehouse_stock SET qty = ?, avg_cost = ?, last_cost = ?, last_updated = NOW() WHERE id = ?',
      [calc.qty(newQty), _warehouseRate(newAvgCost), _warehouseRate(lastCost), existing.id]);
  } else {
    await conn.query(
      `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost, last_updated, added_by)
       VALUES (?,?,?,?,?,?,NOW(),?)`,
      [_genId('WS'), warehouseId, itemId, calc.qty(newQty), _warehouseRate(newAvgCost), _warehouseRate(lastCost), actor || '']);
  }
}

// warehouse_stock.avg_cost and inv_items.cost are DECIMAL(...,4). Perform the
// same rounding before subsequent roll-up math so the derived item cost exactly
// reconciles to the values that MySQL persists.
function _warehouseRate(value) {
  return calc.round(value, 4);
}

/**
 * Remove stock at its document-frozen cost from a moving-average balance.
 * This is deliberately not "leave WAC unchanged": purchase returns and exact
 * receipt reversals credit inventory at the original receipt cost, so the
 * remaining warehouse value must be oldValue - returnedValue.
 */
function costAfterRemoval(oldQty, oldCost, removeQty, removeUnitCost) {
  const oq = calc.qty(oldQty);
  const rq = calc.qty(removeQty);
  const oc = _warehouseRate(oldCost);
  const rc = _warehouseRate(removeUnitCost);
  if (rq < 0) throw new RangeError('removeQty must not be negative');
  if (rq - oq > 1e-6) {
    const e = new RangeError('removeQty exceeds warehouse quantity');
    e.code = 'INSUFFICIENT_STOCK';
    throw e;
  }
  const newQty = calc.qty(oq - rq);
  if (newQty <= 1e-6) return 0;
  const remainingValue = (oq * oc) - (rq * rc);
  // A negative residual would create a negative unit cost. It means later
  // consumption/valuation history makes an exact-cost reversal impossible.
  if (remainingValue < -0.005) {
    const e = new RangeError('removal would leave negative inventory value');
    e.code = 'INVENTORY_VALUATION_CONFLICT';
    throw e;
  }
  return _warehouseRate(Math.max(0, remainingValue) / newQty);
}

/**
 * Derived item-master cost for cross-warehouse/search screens. Only positive
 * on-hand participates (negative/zero positions must not distort the usable
 * stock cost). A warehouse with missing WAC is excluded from the derivation:
 * feeding the prior master cost back into the next roll-up would recursively
 * drift the master on every receipt. If no positive position is valued, the
 * prior master is retained as an explicit estimate only.
 */
function weightedWarehouseRollup(rows, fallbackCost) {
  const fallback = _warehouseRate(fallbackCost);
  let totalQty = 0;
  let totalValue = 0;
  for (const row of rows || []) {
    const q = calc.qty(row && row.qty);
    if (q <= 0) continue;
    const warehouseCost = _warehouseRate(row && row.avg_cost);
    if (warehouseCost <= 0) continue;
    totalQty += q;
    totalValue += q * warehouseCost;
  }
  return totalQty > 0 ? _warehouseRate(totalValue / totalQty) : fallback;
}

async function _deriveAndWriteItemCost(conn, itemId, priorItemCost) {
  // The inv_items row is locked before this query. Locking the component rows
  // too makes the read/derive/write set explicit within this transaction.
  const [rows] = await conn.query(
    'SELECT warehouse_id, qty, avg_cost FROM warehouse_stock WHERE item_id = ? ORDER BY warehouse_id FOR UPDATE',
    [itemId]);
  const rollup = weightedWarehouseRollup(rows, priorItemCost);
  await conn.query('UPDATE inv_items SET cost = ? WHERE id = ?', [rollup, itemId]);
  return rollup;
}

async function _deriveAndWriteItemStock(conn, itemId) {
  // Procurement posting is financial and must fail closed: unlike the generic
  // legacy compatibility helper, this write is never swallowed. A failure
  // rolls the entire receipt/return transaction back.
  await conn.query(
    `UPDATE inv_items i SET i.stock =
       (SELECT COALESCE(SUM(ws.qty), 0) FROM warehouse_stock ws WHERE ws.item_id = i.id)
     WHERE i.id = ?`,
    [itemId]);
}

async function _recordMovement(conn, { itemId, itemName, type, qty, reason, actor, notes, warehouseId, refType, refId }) {
  const id = _genId('MV');
  await conn.query(
    `INSERT INTO inventory_movements
       (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id)
     VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, itemId, itemName || '', type, qty, reason || '', actor || '', notes || '', warehouseId || null, refType, refId]);
  return id;
}

async function _recordGlobalCostHistory(conn, { itemId, before, after, reason, refId, actor }) {
  if (calc.money(before) === calc.money(after)) return;
  await conn.query(
    `INSERT INTO inventory_cost_history (id, item_id, cost_before, cost_after, reason, reference_id, changed_by)
     VALUES (?,?,?,?,?,?,?)`,
    [_genId('ICH'), itemId, calc.rate(before), calc.rate(after), reason, refId, actor || '']);
}

async function _recordWarehouseCostHistory(conn, {
  itemId, warehouseId, before, after, qtyBefore, qtyAfter, triggerType, refId, actor,
}) {
  // Fail closed. item_cost_history is part of the supported schema; swallowing
  // this INSERT would commit stock without its valuation audit trail.
  await conn.query(
    `INSERT INTO item_cost_history
       (id, item_id, warehouse_id, method, old_cost, new_cost, old_qty, new_qty, trigger_type, reference_id, changed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [_genId('CH'), itemId, warehouseId || null, 'WAC', _warehouseRate(before), _warehouseRate(after),
     calc.qty(qtyBefore), calc.qty(qtyAfter), String(triggerType || 'procurement').slice(0, 40), refId || null, actor || '']);
}

/**
 * Apply a goods receipt's stock effect. `lines` are receipt lines carrying:
 *   { id (receipt_line_id), item_id, item_name, po_line_id, base_qty,
 *     base_unit_cost, warehouse_id, lot_no, expiry_date,
 *     landed_charge_amount?, landed_unit_cost? }   (landed cost — NULL without charges)
 * Returns { movementIds, lotIds, affectedStock:[{itemId,warehouseId,qtyDelta,newQty}],
 *           netValue (goods net), chargesValue, landedValue (= net + charges),
 *           valueByWarehouse (LANDED, sums exactly to landedValue) }.
 */
async function applyReceiptStock(conn, { grn, lines, actor, triggerType = 'goods_receipt' }) {
  const movementIds = [], lotIds = [], affectedStock = [];
  let netValue = 0;
  let chargesValue = 0;
  // Raw (4-dp) landed value per warehouse; rounded to money ONCE at the end,
  // with the residual forced onto the largest warehouse so the GL inventory
  // debits sum to the landed total to the cent (see landedCost.roundExactTo).
  const landedRawByWarehouse = {};

  for (const ln of lines) {
    const warehouseId = ln.warehouse_id || grn.warehouse_id;
    const baseQty = calc.qty(ln.base_qty);
    if (baseQty <= 0) throw err('VALIDATION_ERROR', 'كمية سطر الاستلام يجب أن تكون موجبة');
    const baseUnitCost = calc.rate(ln.base_unit_cost);
    if (baseUnitCost < 0) throw err('COST_REQUIRED', 'تكلفة الوحدة مطلوبة');
    const stockUnitCost = _stockUnitCost(ln, baseUnitCost);

    // 1. Over-receipt guard against the PO line (locked).
    if (ln.po_line_id) {
      const [pl] = await conn.query(
        'SELECT id, base_qty, base_received_qty FROM po_lines WHERE id = ? FOR UPDATE', [ln.po_line_id]);
      if (pl.length) {
        const ordered = calc.qty(pl[0].base_qty);
        const already = calc.qty(pl[0].base_received_qty);
        const remaining = calc.qty(ordered - already);
        const allowed = calc.qty(remaining * (1 + OVER_RECEIPT_TOLERANCE));
        if (baseQty - allowed > 1e-6) {
          throw err('OVER_RECEIPT', `الكمية المستلمة (${baseQty}) تتجاوز المتبقي من أمر الشراء (${remaining})`);
        }
      }
    }

    // 2. Tracking-mode enforcement.
    const item = await _lockItem(conn, ln.item_id);
    const mode = String(item.tracking_mode || 'none');
    if ((mode === 'lot' || mode === 'expiry') && !ln.lot_no) {
      throw err('VALIDATION_ERROR', `المادة ${ln.item_id} تتطلب رقم دفعة (lot)`);
    }
    if (mode === 'expiry' && !ln.expiry_date) {
      throw err('VALIDATION_ERROR', `المادة ${ln.item_id} تتطلب تاريخ انتهاء`);
    }

    // 3. Warehouse-local WAC. The locked item-master cost is a fallback only
    // for an unvalued existing warehouse row; quantities always come from the
    // locked (item,warehouse) row, never inv_items.stock.
    const warehouse = await _warehouseQty(conn, warehouseId, ln.item_id);
    const warehouseQtyBefore = warehouse ? calc.qty(warehouse.qty) : 0;
    const storedWarehouseCostBefore = warehouse ? _warehouseRate(warehouse.avg_cost) : 0;
    const effectiveWarehouseCostBefore = storedWarehouseCostBefore > 0
      ? storedWarehouseCostBefore
      : _warehouseRate(item.cost || stockUnitCost);
    const warehouseQtyAfter = calc.qty(warehouseQtyBefore + baseQty);
    // The landed unit cost (when the receipt carries charges) is what the
    // goods actually cost to put on the shelf — that, not the bare supplier
    // price, is the observation the moving average absorbs.
    const warehouseCostAfter = _warehouseRate(calc.newWAC(
      warehouseQtyBefore, effectiveWarehouseCostBefore || stockUnitCost, baseQty, stockUnitCost));
    const globalCostBefore = _warehouseRate(item.cost);

    // 4. Persist the local balance, recompute the quantity roll-up, then derive
    // the item-master COST roll-up from every warehouse without writing that
    // roll-up back into any warehouse WAC.
    await _writeWarehouseStock(conn, {
      existing: warehouse, warehouseId, itemId: ln.item_id,
      newQty: warehouseQtyAfter, newAvgCost: warehouseCostAfter,
      lastCost: stockUnitCost, actor,
    });
    await _deriveAndWriteItemStock(conn, ln.item_id);
    const globalCostAfter = await _deriveAndWriteItemCost(conn, ln.item_id, globalCostBefore);
    await _recordWarehouseCostHistory(conn, {
      itemId: ln.item_id, warehouseId,
      before: storedWarehouseCostBefore, after: warehouseCostAfter,
      qtyBefore: warehouseQtyBefore, qtyAfter: warehouseQtyAfter,
      triggerType, refId: grn.id, actor,
    });
    await _recordGlobalCostHistory(conn, {
      itemId: ln.item_id, before: globalCostBefore, after: globalCostAfter,
      reason: 'purchase', refId: grn.id, actor,
    });

    // 5. lot.
    const [lot] = await conn.query(
      `INSERT INTO purchase_lots
         (inv_item_id, purchase_id, received_date, qty_received, qty_remaining, unit_cost, batch_number, expiry_date, warehouse_id, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
      [ln.item_id, grn.po_id || grn.id, new Date(), baseQty, baseQty, stockUnitCost, ln.lot_no || null, ln.expiry_date || null, warehouseId]);
    const lotId = lot.insertId;
    lotIds.push(lotId);
    if (ln.id) await conn.query('UPDATE purchase_receipt_lines SET purchase_lot_id = ? WHERE id = ?', [lotId, ln.id]);

    // 6. movement.
    const mvId = await _recordMovement(conn, {
      itemId: ln.item_id, itemName: ln.item_name, type: 'in', qty: baseQty,
      reason: 'استلام مشتريات', actor, notes: 'GRN:' + grn.id, warehouseId,
      refType: 'GoodsReceipt', refId: grn.id,
    });
    movementIds.push(mvId);

    // 7. bump PO line received qty.
    if (ln.po_line_id) {
      await conn.query(
        `UPDATE po_lines SET base_received_qty = base_received_qty + ?,
           line_status = CASE WHEN base_received_qty + ? >= base_qty THEN 'received' ELSE 'partially_received' END
         WHERE id = ?`,
        [baseQty, baseQty, ln.po_line_id]);
    }

    affectedStock.push({ itemId: ln.item_id, warehouseId, qtyDelta: baseQty, newQty: warehouseQtyAfter });
    // Goods value stays the supplier's (it is what the goods GRNI credit and
    // the supplier invoice clear); the allocated charge rides on top at 4 dp
    // so that Σ charges reproduces the charge total exactly.
    const lineValue = calc.money(baseQty * baseUnitCost);
    const chargeValue = _lineChargeValue(ln);
    netValue += lineValue;
    chargesValue += chargeValue;
    landedRawByWarehouse[warehouseId] = (landedRawByWarehouse[warehouseId] || 0) + lineValue + chargeValue;
  }

  netValue = calc.money(netValue);
  chargesValue = calc.money(chargesValue);
  const landedValue = calc.money(netValue + chargesValue);
  const warehouseIds = Object.keys(landedRawByWarehouse);
  const rounded = landedCost.roundExactTo(warehouseIds.map((w) => landedRawByWarehouse[w]), landedValue, 2);
  const valueByWarehouse = {};
  warehouseIds.forEach((w, i) => { valueByWarehouse[w] = rounded[i]; });

  return { movementIds, lotIds, affectedStock, valueByWarehouse, netValue, chargesValue, landedValue };
}

/**
 * Reverse a posted receipt's stock effect (exact-lot). `lines` carry the
 * receipt lines including purchase_lot_id; the same lots are decremented — no
 * FEFO re-run. Refuses if the lot has since been consumed below the reversal
 * quantity (PROC_STOCK_CONSUMED).
 */
async function reverseReceiptStock(conn, { grn, lines, actor, refType = 'GoodsReceiptReversal' }) {
  const movementIds = [], affectedStock = [];
  let netValue = 0;
  for (const ln of lines) {
    const warehouseId = ln.warehouse_id || grn.warehouse_id;
    const baseQty = calc.qty(ln.base_qty);
    if (baseQty <= 0) continue;
    const baseUnitCost = calc.rate(ln.base_unit_cost);
    // Mirror of the receipt: what went in at the landed cost comes out at the
    // landed cost, or the reversal leaves the charges' value stranded in stock.
    const removalUnitCost = _stockUnitCost(ln, baseUnitCost);

    // exact-lot decrement
    if (ln.purchase_lot_id) {
      const [lotRows] = await conn.query('SELECT id, qty_remaining FROM purchase_lots WHERE id = ? FOR UPDATE', [ln.purchase_lot_id]);
      if (lotRows.length) {
        const remaining = calc.qty(lotRows[0].qty_remaining);
        if (remaining + 1e-6 < baseQty) {
          throw err('DOCUMENT_HAS_HISTORY', 'تعذّر العكس: الدفعة استُهلكت جزئيًا أو كليًا');
        }
        await conn.query('UPDATE purchase_lots SET qty_remaining = qty_remaining - ? WHERE id = ?', [baseQty, ln.purchase_lot_id]);
      }
    }

    const item = await _lockItem(conn, ln.item_id);
    const warehouse = await _warehouseQty(conn, warehouseId, ln.item_id);
    const warehouseQtyBefore = warehouse ? calc.qty(warehouse.qty) : 0;
    if (!warehouse || baseQty - warehouseQtyBefore > 1e-6) {
      throw err('DOCUMENT_HAS_HISTORY',
        `تعذّر إخراج ${baseQty} من الصنف ${ln.item_id}: رصيد المستودع المتاح ${warehouseQtyBefore}`);
    }
    const storedWarehouseCostBefore = _warehouseRate(warehouse.avg_cost);
    const effectiveWarehouseCostBefore = storedWarehouseCostBefore > 0
      ? storedWarehouseCostBefore
      : _warehouseRate(item.cost || removalUnitCost);
    let warehouseCostAfter;
    try {
      warehouseCostAfter = costAfterRemoval(
        warehouseQtyBefore, effectiveWarehouseCostBefore, baseQty, removalUnitCost || effectiveWarehouseCostBefore);
    } catch (e) {
      if (e && (e.code === 'INSUFFICIENT_STOCK' || e.code === 'INVENTORY_VALUATION_CONFLICT')) {
        throw err('DOCUMENT_HAS_HISTORY',
          'تعذّر العكس/المرتجع لأن الحركات اللاحقة لا تسمح بإزالة الكمية بتكلفتها الأصلية');
      }
      throw e;
    }
    const warehouseQtyAfter = calc.qty(warehouseQtyBefore - baseQty);
    const globalCostBefore = _warehouseRate(item.cost);
    await _writeWarehouseStock(conn, {
      existing: warehouse, warehouseId, itemId: ln.item_id,
      newQty: warehouseQtyAfter, newAvgCost: warehouseCostAfter,
      // An outbound return is not a new supplier price observation.
      lastCost: warehouse.last_cost || effectiveWarehouseCostBefore, actor,
    });
    await _deriveAndWriteItemStock(conn, ln.item_id);
    const globalCostAfter = await _deriveAndWriteItemCost(conn, ln.item_id, globalCostBefore);
    const triggerType = refType === 'PurchaseReturn' ? 'purchase_return' : 'goods_receipt_reverse';
    await _recordWarehouseCostHistory(conn, {
      itemId: ln.item_id, warehouseId,
      before: storedWarehouseCostBefore, after: warehouseCostAfter,
      qtyBefore: warehouseQtyBefore, qtyAfter: warehouseQtyAfter,
      triggerType, refId: grn.id, actor,
    });
    await _recordGlobalCostHistory(conn, {
      itemId: ln.item_id, before: globalCostBefore, after: globalCostAfter,
      reason: 'purchase', refId: grn.id, actor,
    });

    const mvId = await _recordMovement(conn, {
      itemId: ln.item_id, itemName: ln.item_name, type: 'out', qty: baseQty,
      reason: 'عكس استلام', actor, notes: refType + ':' + grn.id, warehouseId,
      refType, refId: grn.id,
    });
    movementIds.push(mvId);
    if (ln.po_line_id) {
      await conn.query('UPDATE po_lines SET base_received_qty = GREATEST(0, base_received_qty - ?) WHERE id = ?', [baseQty, ln.po_line_id]);
    }
    affectedStock.push({ itemId: ln.item_id, warehouseId, qtyDelta: -baseQty, newQty: warehouseQtyAfter });
    netValue += calc.money(baseQty * baseUnitCost) + _lineChargeValue(ln);
  }
  return { movementIds, affectedStock, netValue: calc.money(netValue) };
}

/**
 * Apply a purchase return's stock effect (goods physically leave). `lines`
 * carry { item_id, item_name, purchase_lot_id, base_qty, base_unit_cost,
 * warehouse_id }.
 */
async function applyReturnStock(conn, { ret, lines, actor }) {
  return reverseReceiptStock(conn, {
    grn: { id: ret.id, warehouse_id: ret.warehouse_id },
    lines, actor, refType: 'PurchaseReturn',
  });
}

module.exports = {
  applyReceiptStock, reverseReceiptStock, applyReturnStock, OVER_RECEIPT_TOLERANCE,
  // Exported pure costing primitives keep the accounting contract directly
  // testable without a database.
  costAfterRemoval, weightedWarehouseRollup,
};
