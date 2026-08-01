/**
 * lib/productionAllocation.js — attributing consumed material to the output
 * event that actually consumed it.
 *
 * THE BUG THIS REPLACES
 *
 * routes/inventory-production.js record-output did, once per output event:
 *
 *     SELECT lot_id, qty FROM work_order_lot_consumption WHERE work_order_id=?
 *     -> INSERT INTO production_output_lots (output_lot_id, component_lot_id, qty)
 *
 * It read the WHOLE order's consumption, unfiltered by event, and stamped ALL
 * of it against THIS output's lot. Two partial outputs of 50 units each against
 * 100 kg of a component lot recorded BOTH output lots as having consumed 100 kg
 * — 200 kg of genealogy against 100 kg issued, with every output lot claiming
 * 100% of every component lot. A recall on one component lot then implicates
 * every output lot, and production_output_lots cannot be reconciled with
 * work_order_lot_consumption at all.
 *
 * It was unfixable in place: work_order_lot_consumption has no issue_event_id
 * and production_output_lots has only work_order_id — neither can express
 * "this output consumed this much of this lot". Migration 0027 adds
 * `production_material_allocations` for exactly that, with
 * UNIQUE (output_event_id, issue_line_id, component_lot_id) so a replayed
 * request cannot double-allocate.
 *
 * THE RULE
 *
 *   share = eventQty / remainingExpected          (recipeEngine.outputAllocationShare)
 *   allocᵢ = remainingUnallocatedᵢ × share
 *
 * `remainingExpected` is deliberately the SAME denominator productionEngine
 * .priceOutputEvent uses to price the event, so genealogy and money can never
 * tell different stories about the same output. The FINAL event of an order
 * sweeps the whole remainder, so no consumed unit is left unattributed.
 *
 * The invariant, asserted before every insert:
 *   Σ allocated(issue_line, lot) ≤ consumed(issue_line, lot)
 */
'use strict';

const crypto = require('crypto');
const R = require('./recipeEngine');

function _id(prefix) { return prefix + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'); }

/**
 * What is still unattributed, per (issue line, lot).
 *
 * Consumption is read from production_issue_lines (every issue, tracked or
 * not) and split across the lots that line actually drew from, so untracked
 * components — which have no lot rows at all — are still attributable. Without
 * that, genealogy would silently cover only the lot-tracked half of a recipe.
 */
async function loadRemaining(conn, productionOrderId) {
  const [lines] = await conn.query(
    `SELECT pil.id AS issue_line_id, pil.issue_event_id, pil.item_id, pil.warehouse_id,
            pil.qty, pil.unit_cost
       FROM production_issue_lines pil
      WHERE pil.production_order_id=? ORDER BY pil.id`, [productionOrderId]);
  if (!lines.length) return [];

  // Lot draw-down per (item, lot) for the whole order.
  const [lots] = await conn.query(
    `SELECT component_item_id AS item_id, lot_id, SUM(qty) AS qty
       FROM work_order_lot_consumption WHERE work_order_id=?
      GROUP BY component_item_id, lot_id`, [productionOrderId]);
  const lotsByItem = new Map();
  for (const l of lots) {
    if (!lotsByItem.has(l.item_id)) lotsByItem.set(l.item_id, []);
    lotsByItem.get(l.item_id).push({ lotId: l.lot_id, qty: Number(l.qty) || 0 });
  }

  const [alloc] = await conn.query(
    `SELECT issue_line_id, component_lot_id, SUM(qty) AS qty
       FROM production_material_allocations WHERE production_order_id=?
      GROUP BY issue_line_id, component_lot_id`, [productionOrderId]);
  const allocated = new Map();
  for (const a of alloc) allocated.set(a.issue_line_id + '|' + (a.component_lot_id || ''), Number(a.qty) || 0);

  // Lot balances are consumed greedily, in order, across the issue lines of the
  // same item — mirroring how L.allocateOutbound drew them down.
  const lotCursor = new Map();
  const out = [];
  for (const ln of lines) {
    const lineQty = Number(ln.qty) || 0;
    const itemLots = lotsByItem.get(ln.item_id);
    const pieces = [];
    if (itemLots && itemLots.length) {
      let need = lineQty;
      for (const lot of itemLots) {
        if (need <= 0) break;
        const used = lotCursor.get(ln.item_id + '|' + lot.lotId) || 0;
        const free = R.round6(lot.qty - used);
        if (free <= 0) continue;
        const take = R.round6(Math.min(free, need));
        lotCursor.set(ln.item_id + '|' + lot.lotId, R.round6(used + take));
        pieces.push({ lotId: lot.lotId, qty: take });
        need = R.round6(need - take);
      }
      // Anything the lot rows do not cover stays attributable with a null lot
      // rather than vanishing from the genealogy.
      if (need > 0) pieces.push({ lotId: null, qty: need });
    } else {
      pieces.push({ lotId: null, qty: lineQty });
    }
    for (const p of pieces) {
      const key = ln.issue_line_id + '|' + (p.lotId || '');
      const already = allocated.get(key) || 0;
      const remainingQty = R.round6(p.qty - already);
      if (remainingQty <= 0) continue;
      out.push({
        issueLineId: ln.issue_line_id,
        issueEventId: ln.issue_event_id,
        componentItemId: ln.item_id,
        componentLotId: p.lotId,
        warehouseId: ln.warehouse_id,
        unitCost: Number(ln.unit_cost) || 0,
        consumedQty: p.qty,
        allocatedQty: already,
        remainingQty,
      });
    }
  }
  return out;
}

/**
 * Attribute this output event's share and persist it. Also writes the
 * production_output_lots genealogy rows FROM the allocation — the ONLY place
 * they are written now, and always at the allocated quantity rather than the
 * order-wide total.
 *
 * @param o.isFinal  true for the event that completes/closes the order; sweeps
 *                   the entire remainder so nothing is left unattributed.
 */
async function allocateForOutput(conn, o) {
  const remaining = await loadRemaining(conn, o.productionOrderId);
  const share = R.outputAllocationShare({
    plannedQty: o.plannedQty,
    producedSoFar: o.producedSoFar,
    wasteSoFar: o.wasteSoFar,
    goodQty: o.goodQty,
    wasteQty: o.wasteQty,
    isFinal: !!o.isFinal,
  });
  const plan = R.planMaterialAllocation(remaining, share);

  const rows = [];
  for (const p of plan) {
    const src = remaining.find((r) => r.issueLineId === p.issueLineId
      && (r.componentLotId || null) === (p.componentLotId || null));
    // Belt and braces: the ledger's UNIQUE key stops a duplicate row, this stops
    // a legal-looking row that would over-attribute an existing one.
    R.assertAllocationWithinConsumption(src.consumedQty, src.allocatedQty, p.qty);
    await conn.query(
      `INSERT INTO production_material_allocations
         (id, production_order_id, output_event_id, issue_event_id, issue_line_id,
          component_item_id, component_lot_id, output_lot_id, warehouse_id, qty, unit_cost)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [_id('PMA'), o.productionOrderId, o.outputEventId, p.issueEventId, p.issueLineId,
       p.componentItemId, p.componentLotId, o.outputLotId || null, p.warehouseId, p.qty, p.unitCost]);
    rows.push(p);

    // Backward-compatible genealogy for the detail screen — at the ALLOCATED
    // quantity, and only when both ends carry a real lot.
    if (o.outputLotId && p.componentLotId) {
      await conn.query(
        'INSERT INTO production_output_lots (id, work_order_id, output_lot_id, component_lot_id, qty) VALUES (?,?,?,?,?)',
        [_id('POL'), o.productionOrderId, o.outputLotId, p.componentLotId, p.qty]);
    }
  }
  return { share, allocations: rows, allocatedQty: R.round6(rows.reduce((s, r) => s + r.qty, 0)) };
}

/**
 * Reverse-safe teardown. A reversed order must not keep a backward-traceability
 * graph pointing at lots whose balances have been restored — a recall query
 * against production_output_lots would otherwise still return the reversed
 * order as a consumer.
 */
async function clearAllocations(conn, productionOrderId) {
  await conn.query('DELETE FROM production_material_allocations WHERE production_order_id=?', [productionOrderId]);
  await conn.query('DELETE FROM production_output_lots WHERE work_order_id=?', [productionOrderId]);
}

/** Genealogy for the detail screen, resolved to lot numbers. */
async function loadGenealogy(conn, productionOrderId) {
  const [rows] = await conn.query(
    `SELECT pma.*, i.name AS component_name, lc.lot_number AS component_lot_number,
            lo.lot_number AS output_lot_number, po.batch_number AS output_batch_number,
            po.produced_at
       FROM production_material_allocations pma
       LEFT JOIN inv_items i ON i.id = pma.component_item_id
       LEFT JOIN inventory_lots lc ON lc.id = pma.component_lot_id
       LEFT JOIN inventory_lots lo ON lo.id = pma.output_lot_id
       LEFT JOIN production_output po ON po.id = pma.output_event_id
      WHERE pma.production_order_id=?
      ORDER BY po.produced_at, pma.output_event_id, pma.id`, [productionOrderId]);
  return rows.map((r) => ({
    outputEventId: r.output_event_id,
    outputLotId: r.output_lot_id,
    outputLotNumber: r.output_lot_number || r.output_batch_number || null,
    producedAt: r.produced_at,
    componentItemId: r.component_item_id,
    componentName: r.component_name || r.component_item_id,
    componentLotId: r.component_lot_id,
    componentLotNumber: r.component_lot_number || null,
    issueEventId: r.issue_event_id,
    issueLineId: r.issue_line_id,
    warehouseId: r.warehouse_id,
    qty: Number(r.qty),
    unitCost: Number(r.unit_cost),
    value: R.round4(Number(r.qty) * Number(r.unit_cost)),
  }));
}

/**
 * The reconciliation the integration test asserts across several partial
 * outputs: total attributed can never exceed total consumed, per (line, lot).
 */
async function verifyIntegrity(conn, productionOrderId) {
  const [rows] = await conn.query(
    `SELECT pil.id AS issue_line_id, pil.item_id, pil.qty AS consumed,
            COALESCE((SELECT SUM(a.qty) FROM production_material_allocations a
                       WHERE a.issue_line_id = pil.id), 0) AS allocated
       FROM production_issue_lines pil WHERE pil.production_order_id=?`, [productionOrderId]);
  const violations = rows
    .filter((r) => R.round6(Number(r.allocated)) > R.round6(Number(r.consumed)) + 1e-6)
    .map((r) => ({ issueLineId: r.issue_line_id, itemId: r.item_id, consumed: Number(r.consumed), allocated: Number(r.allocated) }));
  return {
    ok: violations.length === 0,
    violations,
    lines: rows.map((r) => ({
      issueLineId: r.issue_line_id, itemId: r.item_id,
      consumed: Number(r.consumed), allocated: Number(r.allocated),
      unallocated: R.round6(Number(r.consumed) - Number(r.allocated)),
    })),
  };
}

module.exports = { loadRemaining, allocateForOutput, clearAllocations, loadGenealogy, verifyIntegrity };
