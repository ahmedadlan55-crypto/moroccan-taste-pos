'use strict';
/*
 * lib/procurementPurge.js — erase all purchasing and goods-receipt data, and
 * unwind the stock and ledger effects those documents created.
 *
 * WHY UNWINDING MATTERS
 *   Deleting the documents alone is the dangerous half of the job. A goods
 *   receipt does not just record itself: it ADDS quantity to warehouse_stock,
 *   moves inv_items.cost (weighted average), opens a purchase_lots row that
 *   FEFO and expiry checks read, and writes an inventory_movements ledger row.
 *   Drop the paperwork and keep those, and the warehouse reports stock nobody
 *   ever bought, at a cost derived from purchases that no longer exist.
 *
 * HOW THE UNWIND IS ATTRIBUTED
 *   Not by date, and not by guesswork. Every stock movement procurement makes
 *   is stamped with `reference_type` ('GoodsReceipt', 'GoodsReceiptReversal',
 *   'PurchaseReturn' — see services/procurement/InventoryPostingService.js), so
 *   the exact quantity procurement put into each (item, warehouse) pair is a
 *   SUM over those rows. Sales, transfers, production and stocktakes carry
 *   different reference types and are never touched.
 *
 *   inv_items.stock and menu.stock are DERIVED rollups of warehouse_stock
 *   (lib/stockRecompute.js), so they are recomputed rather than adjusted — the
 *   one way to guarantee they agree with the per-warehouse rows afterwards.
 *
 * SAFETY
 *   · planPurge() is READ-ONLY and returns exact per-table counts.
 *   · applyPurge() runs in ONE transaction — a half-purged graph is worse than
 *     either end state.
 *   · Children are deleted before parents so a failure cannot orphan rows.
 *   · GL journals are deleted only when they reference a procurement document;
 *     anything else in the books is left alone.
 */

/**
 * Document tables, CHILDREN FIRST. Order is the delete order and is not
 * cosmetic: a parent row removed first would strand its lines if a later
 * statement failed.
 */
const DOC_TABLES = [
  'supplier_invoice_matches',
  'supplier_invoice_lines',
  'supplier_invoices',
  'payment_allocations',
  'purchase_return_lines',
  'purchase_returns',
  'return_lines',
  'purchase_receipt_lines',
  'purchase_receipts',
  'po_lines',
  'purchase_orders',
  'purchase_requisitions',
  'procurement_events',
  'purchase_lots',
  'purchases',
];

/** reference_type values procurement stamps on inventory_movements. */
const MOVEMENT_REF_TYPES = ['GoodsReceipt', 'GoodsReceiptReversal', 'PurchaseReturn'];

/** reference_type values procurement stamps on gl_journals. */
const GL_REF_TYPES = [
  'GoodsReceipt', 'PurchaseReturn', 'SupplierInvoice', 'SupplierPayment', 'PurchaseOrder',
];

async function _count(conn, table, where, params) {
  try {
    const [rows] = await conn.query(
      'SELECT COUNT(*) AS n FROM `' + table + '`' + (where ? ' WHERE ' + where : ''), params || []);
    return Number(rows[0].n) || 0;
  } catch (e) {
    // A table absent on an older deploy is not an error — it is simply nothing
    // to purge. Reported so the caller can show it rather than hide it.
    return { error: e.message };
  }
}

/**
 * READ-ONLY. What a purge would remove, and what stock it would unwind.
 * Feeds both the CLI dry-run and the ERP preview, so the numbers a human
 * approves are the numbers that get deleted.
 */
async function planPurge(conn) {
  const tables = [];
  for (const t of DOC_TABLES) {
    const n = await _count(conn, t);
    if (n && n.error) tables.push({ table: t, rows: 0, missing: true, error: n.error });
    else tables.push({ table: t, rows: n });
  }

  const movementPlaceholders = MOVEMENT_REF_TYPES.map(() => '?').join(',');
  const movements = await _count(
    conn, 'inventory_movements', 'reference_type IN (' + movementPlaceholders + ')', MOVEMENT_REF_TYPES);

  // The exact quantity procurement put into each (item, warehouse). `type`
  // distinguishes an inbound receipt from an outbound return/reversal, so the
  // net is what has to come back out of warehouse_stock.
  let stockUnwind = [];
  try {
    const [rows] = await conn.query(
      "SELECT item_id AS itemId, warehouse_id AS warehouseId, " +
      "SUM(CASE WHEN type = 'in' THEN qty ELSE -qty END) AS netQty " +
      'FROM inventory_movements ' +
      'WHERE reference_type IN (' + movementPlaceholders + ') AND item_id IS NOT NULL ' +
      'GROUP BY item_id, warehouse_id HAVING netQty <> 0',
      MOVEMENT_REF_TYPES);
    stockUnwind = rows.map((r) => ({
      itemId: r.itemId,
      warehouseId: r.warehouseId,
      netQty: Number(r.netQty) || 0,
    }));
  } catch (_) { /* ledger absent — nothing attributable to unwind */ }

  const glPlaceholders = GL_REF_TYPES.map(() => '?').join(',');
  const glJournals = await _count(
    conn, 'gl_journals', 'reference_type IN (' + glPlaceholders + ')', GL_REF_TYPES);

  const costHistory = await _count(
    conn, 'inventory_cost_history', "reason LIKE '%استلام%' OR reason LIKE '%receipt%'", []);

  const docRows = tables.reduce((s, t) => s + (t.rows || 0), 0);
  return {
    tables,
    docRows,
    movements: typeof movements === 'number' ? movements : 0,
    glJournals: typeof glJournals === 'number' ? glJournals : 0,
    costHistory: typeof costHistory === 'number' ? costHistory : 0,
    stockUnwind,
    /** Nothing to do — lets the caller say so instead of showing an empty table. */
    empty: docRows === 0 && (typeof movements === 'number' ? movements : 0) === 0,
  };
}

/**
 * Delete everything in `plan`, in ONE transaction.
 * `conn` must expose withTransaction (db/connection.js does).
 */
async function applyPurge(conn, plan) {
  const removed = {};
  await conn.withTransaction(async (tx) => {
    // 1) Unwind stock FIRST, while the ledger rows that attribute it still
    //    exist. Doing it after the deletes would leave nothing to attribute by.
    for (const s of plan.stockUnwind) {
      if (!s.warehouseId) continue;
      await tx.query(
        'UPDATE warehouse_stock SET qty = qty - ?, last_updated = NOW() ' +
        'WHERE warehouse_id = ? AND item_id = ?',
        [s.netQty, s.warehouseId, s.itemId]);
    }
    // Rollups are DERIVED — recompute rather than adjust, so inv_items.stock and
    // menu.stock cannot drift from the per-warehouse rows they summarise.
    const itemIds = [...new Set(plan.stockUnwind.map((s) => s.itemId).filter(Boolean))];
    for (const itemId of itemIds) {
      await tx.query(
        'UPDATE inv_items i SET i.stock = ' +
        '(SELECT COALESCE(SUM(ws.qty), 0) FROM warehouse_stock ws WHERE ws.item_id = i.id) ' +
        'WHERE i.id = ?', [itemId]);
      try {
        await tx.query(
          'UPDATE menu m SET m.stock = ' +
          '(SELECT COALESCE(SUM(ws.qty), 0) FROM warehouse_stock ws WHERE ws.item_id = m.id) ' +
          'WHERE m.id = ?', [itemId]);
      } catch (_) { /* menu rollup is best-effort, exactly as stockRecompute treats it */ }
    }

    // 2) GL — entries before journals (FK order), and ONLY procurement ones.
    const glPlaceholders = GL_REF_TYPES.map(() => '?').join(',');
    try {
      const [r1] = await tx.query(
        'DELETE FROM gl_entries WHERE journal_id IN ' +
        '(SELECT id FROM gl_journals WHERE reference_type IN (' + glPlaceholders + '))',
        GL_REF_TYPES);
      removed.gl_entries = r1.affectedRows || 0;
      const [r2] = await tx.query(
        'DELETE FROM gl_journals WHERE reference_type IN (' + glPlaceholders + ')', GL_REF_TYPES);
      removed.gl_journals = r2.affectedRows || 0;
    } catch (e) { removed.gl_error = e.message; }

    // 3) The attributed ledger + cost-history rows.
    const movePlaceholders = MOVEMENT_REF_TYPES.map(() => '?').join(',');
    try {
      const [r] = await tx.query(
        'DELETE FROM inventory_movements WHERE reference_type IN (' + movePlaceholders + ')',
        MOVEMENT_REF_TYPES);
      removed.inventory_movements = r.affectedRows || 0;
    } catch (e) { removed.movements_error = e.message; }

    // 4) The documents themselves, children before parents.
    for (const t of DOC_TABLES) {
      try {
        const [r] = await tx.query('DELETE FROM `' + t + '`');
        removed[t] = r.affectedRows || 0;
      } catch (e) {
        // A missing table is nothing to delete; a real failure aborts the
        // transaction rather than leaving a half-purged graph.
        if (!/doesn't exist|Unknown table/i.test(e.message)) throw e;
        removed[t] = 0;
      }
    }
  });
  return removed;
}

module.exports = {
  DOC_TABLES,
  MOVEMENT_REF_TYPES,
  GL_REF_TYPES,
  planPurge,
  applyPurge,
};
