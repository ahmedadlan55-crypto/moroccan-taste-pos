/**
 * Reusable inventory-transaction posters — Phase 3C.
 *
 * `createAndPostAdjustment` reuses the SAFE 3B Adjustment Engine
 * (lib/inventoryTxEngine) to create a REAL, POSTED inv_adjustments document and
 * apply each line's signed `variance` to the CURRENT (locked) balance. The
 * stocktake post is the only caller: it has already locked the stock rows and
 * computed each line's variance (counted − theoretical-at-count), so here
 * delta = variance and system_qty_snapshot = the current locked qty — the engine
 * applies the variance on top of any movements that happened after the count.
 *
 * This is THE single inventory-writing path for the stocktake: the stocktake
 * route never touches warehouse_stock / inventory_movements / GL itself. The
 * produced adjustment (its journal + movements with reference_type='inv_adjustment')
 * is the auditable proof that the Adjustment Engine did the posting; the stocktake
 * stores its adjustment_id + gl_journal_id.
 *
 * Runs INSIDE the caller's db.withTransaction(conn) — any throw rolls everything
 * back. No DB pool, no I/O of its own beyond the passed `conn`.
 */
'use strict';
const crypto = require('crypto');
const gl = require('./glPosting');
const E = require('./inventoryTxEngine');
let recomputeInvItemStock;
try { recomputeInvItemStock = require('./stockRecompute').recomputeInvItemStock; } catch (_) { recomputeInvItemStock = async () => {}; }

function _ymd(d) { d = d || new Date(); return d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function _today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function _round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

// Atomic per-(doc_type, day) number on the txn conn (LAST_INSERT_ID is
// connection-scoped). Shared by the stocktake (STK-) and its adjustment (ADV-).
async function nextDocNumber(conn, docType, prefix) {
  const ymd = _ymd();
  await conn.query('INSERT INTO inv_tx_counter (doc_type, ymd, last_serial) VALUES (?,?,LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_serial = LAST_INSERT_ID(last_serial + 1)', [docType, ymd]);
  const [r] = await conn.query('SELECT LAST_INSERT_ID() AS s');
  const serial = Number(r[0] && r[0].s) || 1;
  return prefix + '-' + ymd + '-' + String(serial).padStart(4, '0');
}

async function _audit(conn, docType, docId, action, fromStatus, toStatus, actor, note, payload) {
  try {
    await conn.query(
      'INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
      ['EV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), docType, docId, action, fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500), payload ? JSON.stringify(payload).slice(0, 8000) : null]
    );
  } catch (_) { /* audit best-effort */ }
}

// p = { warehouse, reason, referenceEvidence?, notes?, costCenterId?, dateStr?,
//       lines: [{ itemId, itemName, unit, currentQty, variance, notes? }] }
// currentQty must already be the FOR-UPDATE-locked balance (the caller holds the lock).
async function createAndPostAdjustment(conn, p, actor) {
  const wh = p.warehouse;
  const adjId = 'ADV-' + crypto.randomBytes(6).toString('hex');
  const number = await nextDocNumber(conn, 'adjustment', 'ADV');
  const dateStr = p.dateStr || _today();
  const affectedStock = [], movementIds = [];
  let posValue = 0, negValue = 0, netValue = 0, lineCount = 0;

  await conn.query(
    'INSERT INTO inv_adjustments (id, adjustment_number, warehouse_id, brand_id, branch_id, cost_center_id, adjustment_date, status, reason, reference_evidence, total_delta_value, total_cost, total_value, notes, created_by, posted_by, posted_at, version) ' +
    "VALUES (?,?,?,?,?,?,?, 'posted', ?,?, 0,0,0, ?, ?, ?, NOW(), 1)",
    [adjId, number, wh.id, wh.brand_id || null, wh.branch_id || null, p.costCenterId || null, dateStr, String(p.reason || 'تسوية جرد').slice(0, 200), p.referenceEvidence || null, String(p.notes || '').slice(0, 2000) || null, actor, actor]
  );

  for (const ln of p.lines) {
    const variance = Number(ln.variance);
    if (!Number.isFinite(variance) || Math.abs(variance) < 1e-9) continue;
    lineCount++;
    const itemId = ln.itemId;
    const cost = await E.getEffectiveCost(conn, itemId, wh.id);
    const cur = Number(ln.currentQty);
    const mv = await E.applyStockMovement(conn, wh.id, itemId, variance, cost, 'inv_adjustment', adjId, actor);
    const mid = await E.recordMovement(conn, { warehouseId: wh.id, itemId, itemName: ln.itemName, type: variance > 0 ? 'in' : 'out', qty: Math.abs(variance), reason: 'تسوية جرد: ' + (p.reason || ''), username: actor, notes: number, referenceType: 'inv_adjustment', referenceId: adjId });
    movementIds.push(mid);
    affectedStock.push({ warehouseId: wh.id, itemId, delta: variance, newQty: mv.newQty });
    const dval = E.round2(Math.abs(variance) * cost);
    if (variance > 0) posValue += dval; else negValue += dval;
    netValue += variance * cost;
    const lid = 'LN-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    await conn.query(
      'INSERT INTO inv_adjustment_items (id, adjustment_id, item_id, item_name, unit, system_qty_snapshot, counted_qty, delta, unit_cost, delta_value, posted_unit_cost, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [lid, adjId, itemId, ln.itemName || '', ln.unit || '', cur, _round3(cur + variance), variance, cost, E.round2(variance * cost), cost, (ln.notes || '').toString().slice(0, 400)]
    );
    try { await recomputeInvItemStock(conn, itemId); } catch (_) {}
  }

  posValue = E.round2(posValue); negValue = E.round2(negValue);
  let journalId = null;
  if (posValue > 0 || negValue > 0) {
    const spec = E.glAdjustmentNet({ posValue, negValue, warehouse: wh, warehouseId: wh.id, brandId: wh.brand_id, branchId: wh.branch_id, costCenterId: p.costCenterId, expenseCode: E.adjustmentExpenseCode(p.reason), journalDate: dateStr, postedBy: actor, referenceId: adjId, description: 'تسوية جرد ' + number });
    const j = await gl.postJournal(conn, spec);
    if (!j || !j.success) { const e = new Error((j && j.error) || 'فشل ترحيل قيد التسوية المخزنية'); e.code = 'GL_POSTING_FAILED'; throw e; }
    journalId = j.journalId;
  }
  await conn.query('UPDATE inv_adjustments SET gl_journal_id=?, total_delta_value=?, total_value=? WHERE id=?', [journalId, E.round2(netValue), E.round2(netValue), adjId]);
  await _audit(conn, 'adjustment', adjId, 'create', null, 'draft', actor, 'تسوية ناتجة عن محضر جرد', { lineCount });
  await _audit(conn, 'adjustment', adjId, 'post', 'approved', 'posted', actor, 'ترحيل تسوية الجرد', { journalId });

  return { adjustmentId: adjId, adjustmentNumber: number, journalId, affectedStock, movementIds, netValue: E.round2(netValue), posValue, negValue, lineCount };
}

module.exports = { nextDocNumber, createAndPostAdjustment };
