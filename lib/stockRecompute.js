/**
 * Stock Recomputation Helpers — v5.10.19
 *
 * Single source of truth: warehouse_stock(warehouse_id, item_id, qty).
 * The legacy fields inv_items.stock and menu.stock are kept as denormalized
 * rollups equal to SUM(warehouse_stock.qty WHERE item_id = X). Every code
 * path that mutates per-warehouse balances must call recomputeInvItemStock()
 * (or recomputeMenuStock()) afterwards so the rollup stays consistent.
 *
 * Why a denormalized rollup at all? Many legacy reports, the POS cashier
 * cart, and frontend pickers still read inv_items.stock / menu.stock for
 * speed (no JOIN). Killing those reads outright would be a much bigger
 * change. So we keep the rollup, but make it derived rather than primary.
 *
 * Use in any path that touches warehouse_stock:
 *   const { recomputeInvItemStock } = require('../lib/stockRecompute');
 *   await db.query('UPDATE warehouse_stock SET qty = qty - ? WHERE ...', [...]);
 *   await recomputeInvItemStock(db, itemId);
 */

// COALESCE keeps the prior value when no warehouse_stock rows exist yet
// (e.g., very old items pre-V5.9.1 backfill). After backfill ran once,
// every active item has at least one row so SUM is always defined.
async function recomputeInvItemStock(db, itemId) {
  if (!itemId) return;
  try {
    await db.query(
      `UPDATE inv_items i SET i.stock =
         (SELECT COALESCE(SUM(ws.qty), 0) FROM warehouse_stock ws WHERE ws.item_id = i.id)
       WHERE i.id = ?`,
      [itemId]
    );
  } catch (e) {
    // Non-fatal: ancient deploys without warehouse_stock will fall back to
    // the prior direct-write behavior. Log so drift is visible.
    console.warn('[stockRecompute] inv_items recompute skipped for', itemId, '—', e.message);
  }
}

async function recomputeMenuStock(db, menuId) {
  if (!menuId) return;
  try {
    await db.query(
      `UPDATE menu m SET m.stock =
         (SELECT COALESCE(SUM(ws.qty), 0) FROM warehouse_stock ws WHERE ws.item_id = m.id)
       WHERE m.id = ?`,
      [menuId]
    );
  } catch (e) {
    console.warn('[stockRecompute] menu recompute skipped for', menuId, '—', e.message);
  }
}

// v7.1 — ATOMIC per-warehouse deduction that NEVER loses a write.
//
// The plain `UPDATE warehouse_stock SET qty = qty - ? WHERE warehouse_id=? AND
// item_id=?` silently affects ZERO rows when the item has no row yet in that
// warehouse (an empty/unstocked branch warehouse — exactly the owner's case).
// The deduction then vanishes and the balance never goes negative, so a real
// shortage is invisible. This helper uses INSERT … ON DUPLICATE KEY UPDATE on
// the UNIQUE (warehouse_id, item_id) key (server.js:579), mirroring the
// purchase ADD pattern (routes/purchases.js) but in reverse:
//   • no existing row → INSERT a row with qty = -n  (shows the deficit)
//   • existing row    → qty = qty - n               (may go negative)
// Always call recomputeInvItemStock()/recomputeMenuStock() afterwards so the
// rollup stays consistent. Returns true when a deduction was issued.
async function deductWarehouseStock(db, warehouseId, itemId, qty, opts) {
  if (!warehouseId || !itemId) return false;
  const n = Number(qty) || 0;
  const o = opts || {};
  // Phase 4B — a TRACKED item's stock deduction and its FEFO lot allocation must
  // be ATOMIC so Σ(lot balances)=warehouse_stock can never drift. When called with
  // the pool we open our own transaction; when called with an existing conn (the
  // caller already opened one) we run inline. Untracked items keep the old path.
  let mode = 'none';
  try { const [r] = await db.query('SELECT tracking_mode FROM inv_items WHERE id=? LIMIT 1', [itemId]); mode = (r.length && r[0].tracking_mode) ? String(r[0].tracking_mode) : 'none'; } catch (_) {}
  if (mode === 'lot' || mode === 'expiry') {
    const L = require('./lotLedger'); // lazy require (avoids any load-order coupling)
    const runner = async (conn) => {
      const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      await conn.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE qty = qty - ?', [wsId, warehouseId, itemId, -n, n]);
      await L.allocateOutbound(conn, { warehouseId, itemId, qty: n, trackingMode: mode, movementSeq: null, movementId: null, referenceType: o.referenceType || 'sale', referenceId: o.referenceId || null, reason: o.reason || 'صرف', actor: o.actor || '', occurredAt: new Date(), now: new Date(), manualAllocations: o.manualAllocations || null });
      await L.assertInvariant(conn, warehouseId, itemId);
    };
    if (typeof db.withTransaction === 'function') await db.withTransaction(runner);
    else await runner(db);
    return true;
  }
  const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  await db.query(
    'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?) ' +
    'ON DUPLICATE KEY UPDATE qty = qty - ?',
    [wsId, warehouseId, itemId, -n, n]
  );
  return true;
}

// Bulk recompute for ALL inv_items and menu items. Used by the admin
// reconcile-stock endpoint and by deploy-time drift checks. Returns a
// summary { invUpdated, menuUpdated, drift: [{itemId, oldStock, newStock}] }.
async function reconcileAllStock(db, opts) {
  opts = opts || {};
  const reportDrift = !!opts.reportDrift;
  const drift = [];
  let invUpdated = 0, menuUpdated = 0;

  // 1) Capture pre-state for drift detection (only if asked)
  if (reportDrift) {
    try {
      const [rows] = await db.query(`
        SELECT i.id, i.stock AS old_stock,
               COALESCE((SELECT SUM(ws.qty) FROM warehouse_stock ws WHERE ws.item_id = i.id), 0) AS new_stock
        FROM inv_items i
        WHERE i.active = 1
      `);
      rows.forEach(r => {
        const a = Number(r.old_stock) || 0, b = Number(r.new_stock) || 0;
        if (Math.abs(a - b) > 0.0001) drift.push({ itemId: r.id, table: 'inv_items', oldStock: a, newStock: b });
      });
    } catch (_) {}
  }

  // 2) Recompute everything in one shot
  try {
    const [r] = await db.query(`
      UPDATE inv_items i SET i.stock =
        COALESCE((SELECT SUM(ws.qty) FROM warehouse_stock ws WHERE ws.item_id = i.id), 0)
      WHERE i.active = 1
    `);
    invUpdated = r.affectedRows || 0;
  } catch (e) { console.warn('[stockRecompute] bulk inv recompute skipped:', e.message); }

  try {
    const [r] = await db.query(`
      UPDATE menu m SET m.stock =
        COALESCE((SELECT SUM(ws.qty) FROM warehouse_stock ws WHERE ws.item_id = m.id), m.stock)
      WHERE EXISTS(SELECT 1 FROM warehouse_stock ws WHERE ws.item_id = m.id)
    `);
    menuUpdated = r.affectedRows || 0;
  } catch (e) { console.warn('[stockRecompute] bulk menu recompute skipped:', e.message); }

  return { invUpdated, menuUpdated, drift };
}

module.exports = {
  recomputeInvItemStock,
  recomputeMenuStock,
  deductWarehouseStock,
  reconcileAllStock
};
