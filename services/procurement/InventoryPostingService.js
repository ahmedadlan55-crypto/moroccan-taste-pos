/**
 * services/procurement/InventoryPostingService.js
 *
 * THE single code path that mutates stock for procurement (goods receipts and
 * purchase returns). All writes to warehouse_stock / inv_items / purchase_lots
 * / inventory_movements / inventory_cost_history for the P2P module flow
 * through here — this is what makes "zero dual-write" provable.
 *
 * Concurrency: every call runs inside the caller's transaction and takes
 * `FOR UPDATE` row locks on the po_line + inv_item so two concurrent receipts
 * against the same PO cannot exceed the ordered quantity.
 *
 * Costing: weighted-average on inv_items.cost + warehouse_stock.avg_cost, with
 * an inventory_cost_history audit row per receipt line.
 *
 * Lots: one purchase_lots row per received line (linked back onto the receipt
 * line via purchase_lot_id) so reversals/returns can target the exact lot —
 * FEFO is never re-run on a reversal.
 */
'use strict';

const { recomputeInvItemStock } = require('../../lib/stockRecompute');
const calc = require('../../lib/procurement/calculations');
const { err } = require('../../lib/procurement/errors');

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
    'SELECT id, qty, avg_cost FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ? FOR UPDATE',
    [warehouseId, itemId]);
  return rows[0] || null;
}

async function _upsertWarehouseStock(conn, warehouseId, itemId, deltaQty, newAvgCost, lastCost, actor) {
  const existing = await _warehouseQty(conn, warehouseId, itemId);
  if (existing) {
    await conn.query(
      'UPDATE warehouse_stock SET qty = qty + ?, avg_cost = ?, last_cost = ?, last_updated = NOW() WHERE id = ?',
      [deltaQty, newAvgCost, lastCost, existing.id]);
  } else {
    await conn.query(
      `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost, last_updated, added_by)
       VALUES (?,?,?,?,?,?,NOW(),?)`,
      [_genId('WS'), warehouseId, itemId, deltaQty, newAvgCost, lastCost, actor || '']);
  }
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

async function _recordCostHistory(conn, { itemId, before, after, reason, refId, actor }) {
  if (calc.money(before) === calc.money(after)) return;
  await conn.query(
    `INSERT INTO inventory_cost_history (id, item_id, cost_before, cost_after, reason, reference_id, changed_by)
     VALUES (?,?,?,?,?,?,?)`,
    [_genId('ICH'), itemId, calc.rate(before), calc.rate(after), reason, refId, actor || '']);
}

/**
 * Apply a goods receipt's stock effect. `lines` are receipt lines carrying:
 *   { id (receipt_line_id), item_id, item_name, po_line_id, base_qty,
 *     base_unit_cost, warehouse_id, lot_no, expiry_date }
 * Returns { movementIds, lotIds, affectedStock:[{itemId,warehouseId,qtyDelta,newQty}], netValue }.
 */
async function applyReceiptStock(conn, { grn, lines, actor }) {
  const movementIds = [], lotIds = [], affectedStock = [];
  let netValue = 0;
  const valueByWarehouse = {};

  for (const ln of lines) {
    const warehouseId = ln.warehouse_id || grn.warehouse_id;
    const baseQty = calc.qty(ln.base_qty);
    if (baseQty <= 0) throw err('VALIDATION_ERROR', 'كمية سطر الاستلام يجب أن تكون موجبة');
    const baseUnitCost = calc.rate(ln.base_unit_cost);
    if (baseUnitCost < 0) throw err('COST_REQUIRED', 'تكلفة الوحدة مطلوبة');

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

    // 3. WAC on the global item cost + warehouse avg.
    const stockBefore = calc.qty(item.stock);
    const costBefore = calc.rate(item.cost);
    const newCost = calc.newWAC(stockBefore, costBefore, baseQty, baseUnitCost);

    // 4. warehouse_stock upsert + rollup.
    await _upsertWarehouseStock(conn, warehouseId, ln.item_id, baseQty, newCost, baseUnitCost, actor);
    await recomputeInvItemStock(conn, ln.item_id);
    await conn.query('UPDATE inv_items SET cost = ? WHERE id = ?', [newCost, ln.item_id]);
    await _recordCostHistory(conn, { itemId: ln.item_id, before: costBefore, after: newCost, reason: 'purchase', refId: grn.id, actor });

    // 5. lot.
    const [lot] = await conn.query(
      `INSERT INTO purchase_lots
         (inv_item_id, purchase_id, received_date, qty_received, qty_remaining, unit_cost, batch_number, expiry_date, warehouse_id, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
      [ln.item_id, grn.po_id || grn.id, new Date(), baseQty, baseQty, baseUnitCost, ln.lot_no || null, ln.expiry_date || null, warehouseId]);
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

    const wq = await _warehouseQty(conn, warehouseId, ln.item_id);
    affectedStock.push({ itemId: ln.item_id, warehouseId, qtyDelta: baseQty, newQty: wq ? Number(wq.qty) : baseQty });
    const lineValue = calc.money(baseQty * baseUnitCost);
    netValue += lineValue;
    valueByWarehouse[warehouseId] = calc.money((valueByWarehouse[warehouseId] || 0) + lineValue);
  }

  return { movementIds, lotIds, affectedStock, valueByWarehouse, netValue: calc.money(netValue) };
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
    await _upsertWarehouseStock(conn, warehouseId, ln.item_id, -baseQty, calc.rate(item.cost), baseUnitCost, actor);
    await recomputeInvItemStock(conn, ln.item_id);

    const mvId = await _recordMovement(conn, {
      itemId: ln.item_id, itemName: ln.item_name, type: 'out', qty: baseQty,
      reason: 'عكس استلام', actor, notes: refType + ':' + grn.id, warehouseId,
      refType, refId: grn.id,
    });
    movementIds.push(mvId);
    if (ln.po_line_id) {
      await conn.query('UPDATE po_lines SET base_received_qty = GREATEST(0, base_received_qty - ?) WHERE id = ?', [baseQty, ln.po_line_id]);
    }
    const wq = await _warehouseQty(conn, warehouseId, ln.item_id);
    affectedStock.push({ itemId: ln.item_id, warehouseId, qtyDelta: -baseQty, newQty: wq ? Number(wq.qty) : 0 });
    netValue += calc.money(baseQty * baseUnitCost);
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

module.exports = { applyReceiptStock, reverseReceiptStock, applyReturnStock, OVER_RECEIPT_TOLERANCE };
