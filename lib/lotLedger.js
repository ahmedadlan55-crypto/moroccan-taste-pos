/**
 * Lot ledger — Phase 4B (the single chokepoint for lot-aware stock movement).
 *
 * EVERY writer that moves a tracked item's quantity routes its lot side through
 * this module, inside the SAME db.withTransaction as the warehouse_stock move, so
 * the hard invariant holds after every transaction:
 *
 *     Σ(warehouse_lot_balances.qty WHERE warehouse_id=? AND item_id=?)
 *         === warehouse_stock.qty           (for every tracked item + warehouse)
 *
 * FEFO order (outbound): exclude expired / quarantined / recalled / closed, then
 * expiryDate ASC (NULL last for 'lot' mode; forbidden for 'expiry' mode), then
 * receivedAt ASC, then lotId ASC. Reversal restores the EXACT original lots and
 * NEVER re-runs FEFO. Manual allocation is allowed (route gates permission+reason).
 *
 * The FEFO planner (planFefo) + small helpers are PURE and unit-tested
 * (tests/lotLedger.test.js); the allocate/receive/reverse/invariant functions
 * take an explicit transaction `conn`.
 */
'use strict';
const EXP = require('./expiryPolicy');

function _err(code, msg) { const e = new Error(msg); e.code = code; return e; }
function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function _id(p) { return p + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

function lotNorm(s) { return String(s == null ? '' : s).trim().toUpperCase(); }
function isTracked(mode) { return mode === 'lot' || mode === 'expiry'; }
const ISSUABLE = 'active'; // only active lots may be issued (quarantined/recalled/closed cannot)

// ── PURE: plan an outbound FEFO allocation ─────────────────────────────────
// lots: [{ lotId, qty, expiryDate('YYYY-MM-DD'|null), receivedAt(sortable), lifecycleStatus, lotNumber }]
// opts: { mode:'lot'|'expiry', now, allowExpired? }
// Returns { allocations:[{lotId, qty}], shortfall, totalAvailable, skipped:{expired,blocked} }.
// Does NOT throw — the DB wrapper decides (INSUFFICIENT_LOT_QUANTITY) so the planner
// stays testable.
function planFefo(lots, qty, opts) {
  const o = opts || {};
  const want = round3(qty);
  const skipped = { expired: 0, blocked: 0 };
  const eligible = [];
  for (const l of (lots || [])) {
    const bal = round3(l.qty);
    if (bal <= 0) continue;
    if (String(l.lifecycleStatus || 'active') !== ISSUABLE) { skipped.blocked += bal; continue; }
    if (!o.allowExpired && EXP.isExpired(l.expiryDate, o.now)) { skipped.expired += bal; continue; }
    eligible.push(l);
  }
  // FEFO: expiry ASC (null last), then receivedAt ASC, then lotId ASC.
  eligible.sort((a, b) => {
    const ae = a.expiryDate || null, be = b.expiryDate || null;
    if (ae !== be) { if (ae === null) return 1; if (be === null) return -1; return ae < be ? -1 : 1; }
    const ar = String(a.receivedAt || ''), br = String(b.receivedAt || '');
    if (ar !== br) return ar < br ? -1 : 1;
    return String(a.lotId) < String(b.lotId) ? -1 : 1;
  });
  const allocations = [];
  let remaining = want;
  let totalAvailable = 0;
  for (const l of eligible) {
    totalAvailable = round3(totalAvailable + round3(l.qty));
    if (remaining <= 0) continue;
    const take = Math.min(round3(l.qty), remaining);
    if (take > 0) { allocations.push({ lotId: l.lotId, qty: round3(take) }); remaining = round3(remaining - take); }
  }
  return { allocations, shortfall: round3(Math.max(0, remaining)), totalAvailable, skipped };
}

// ── DB: tracking mode for an item ──────────────────────────────────────────
async function getTrackingMode(conn, itemId) {
  const [r] = await conn.query('SELECT tracking_mode FROM inv_items WHERE id=? LIMIT 1', [itemId]);
  return (r.length && r[0].tracking_mode) ? String(r[0].tracking_mode) : 'none';
}

// Load a warehouse+item's lot balances (optionally FOR UPDATE), newest schema shape.
async function loadBalances(conn, warehouseId, itemId, forUpdate) {
  const [rows] = await conn.query(
    'SELECT b.id AS balance_id, b.lot_id, b.qty, l.lot_number, l.lifecycle_status, l.created_at AS received_at, ' +
    "  DATE_FORMAT(l.expiry_date, '%Y-%m-%d') AS expiry_date " +
    'FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id ' +
    'WHERE b.warehouse_id=? AND b.item_id=?' + (forUpdate ? ' FOR UPDATE' : ''),
    [warehouseId, itemId]
  );
  return rows.map((r) => ({
    balanceId: r.balance_id, lotId: r.lot_id, qty: Number(r.qty), lotNumber: r.lot_number,
    lifecycleStatus: r.lifecycle_status, receivedAt: r.received_at, expiryDate: r.expiry_date || null,
  }));
}

async function _insertLotMovement(conn, m) {
  await conn.query(
    'INSERT INTO inventory_lot_movements (id, inventory_movement_seq, movement_id, lot_id, warehouse_id, item_id, signed_qty, reference_type, reference_id, reason, actor, occurred_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [_id('ILM'), m.movementSeq != null ? Number(m.movementSeq) : null, m.movementId || null, m.lotId, m.warehouseId, m.itemId,
      round3(m.signedQty), m.referenceType || null, m.referenceId || null, (m.reason || '').slice(0, 200), m.actor || null, m.occurredAt || new Date()]
  );
}

// Find an existing lot by (item, normalized number) or create it. Returns { lotId, created }.
async function _findOrCreateLot(conn, itemId, lot, actor) {
  const norm = lotNorm(lot.lotNumber);
  if (!norm) throw _err('LOT_REQUIRED', 'رقم الدفعة مطلوب لصنف يخضع لتتبع الدفعات');
  const [ex] = await conn.query("SELECT id, DATE_FORMAT(expiry_date,'%Y-%m-%d') AS expiry_date FROM inventory_lots WHERE item_id=? AND lot_norm=? LIMIT 1", [itemId, norm]);
  if (ex.length) {
    const existingExpiry = ex[0].expiry_date || null;
    const incoming = EXP.ymd(lot.expiryDate);
    if (incoming && existingExpiry && incoming !== existingExpiry) {
      throw _err('VALIDATION_ERROR', 'الدفعة "' + lot.lotNumber + '" موجودة بتاريخ صلاحية مختلف — لا يمكن تغيير صلاحية دفعة قائمة');
    }
    return { lotId: ex[0].id, created: false };
  }
  const id = _id('LOT');
  await conn.query(
    'INSERT INTO inventory_lots (id, item_id, lot_number, lot_norm, manufacture_date, expiry_date, lifecycle_status, source_type, source_id, unit_cost, is_imported, version, created_by) ' +
    "VALUES (?,?,?,?,?,?, 'active', ?,?,?,?,1,?)",
    [id, itemId, String(lot.lotNumber).slice(0, 120), norm, EXP.ymd(lot.manufactureDate), EXP.ymd(lot.expiryDate),
      lot.sourceType || null, lot.sourceId || null, round3(lot.unitCost || 0), lot.isImported ? 1 : 0, actor || null]
  );
  return { lotId: id, created: true };
}

async function _adjustBalance(conn, warehouseId, itemId, lotId, delta) {
  if (delta < 0) {
    // decrement with a no-negative guard (also covers concurrent races)
    const [r] = await conn.query('UPDATE warehouse_lot_balances SET qty = qty + ? WHERE warehouse_id=? AND lot_id=? AND qty >= ?', [round3(delta), warehouseId, lotId, round3(-delta)]);
    if (!r.affectedRows) throw _err('INSUFFICIENT_LOT_QUANTITY', 'رصيد الدفعة غير كافٍ للصرف');
    return;
  }
  const [up] = await conn.query('UPDATE warehouse_lot_balances SET qty = qty + ? WHERE warehouse_id=? AND lot_id=?', [round3(delta), warehouseId, lotId]);
  if (!up.affectedRows) {
    await conn.query('INSERT INTO warehouse_lot_balances (id, warehouse_id, lot_id, item_id, qty) VALUES (?,?,?,?,?)', [_id('WLB'), warehouseId, lotId, itemId, round3(delta)]);
  }
}

// ── OUTBOUND: allocate qty out of a warehouse+item via FEFO (or a manual list) ──
// ctx: { warehouseId, itemId, qty, trackingMode?, movementSeq, movementId, referenceType,
//        referenceId, reason, actor, occurredAt, manualAllocations?, now, allowExpired? }
// Returns { allocations:[{lotId, lotNumber, qty, expiryDate}] }.
async function allocateOutbound(conn, ctx) {
  const balances = await loadBalances(conn, ctx.warehouseId, ctx.itemId, true);
  const byId = new Map(balances.map((b) => [b.lotId, b]));
  let plan;
  if (Array.isArray(ctx.manualAllocations) && ctx.manualAllocations.length) {
    // Manual override (route already checked permission + reason). Validate feasibility.
    let sum = 0;
    for (const a of ctx.manualAllocations) {
      const b = byId.get(a.lotId);
      const q = round3(a.qty);
      if (!b) throw _err('VALIDATION_ERROR', 'الدفعة المحددة غير موجودة في هذا المستودع');
      if (b.lifecycleStatus !== ISSUABLE) throw _err(b.lifecycleStatus === 'quarantined' ? 'QUARANTINED_LOT' : b.lifecycleStatus === 'recalled' ? 'RECALLED_LOT' : 'VALIDATION_ERROR', 'الدفعة "' + b.lotNumber + '" غير قابلة للصرف (' + b.lifecycleStatus + ')');
      if (!ctx.allowExpired && EXP.isExpired(b.expiryDate, ctx.now)) throw _err('EXPIRED_LOT', 'الدفعة "' + b.lotNumber + '" منتهية الصلاحية — لا يمكن صرفها');
      if (q <= 0 || q > round3(b.qty)) throw _err('INSUFFICIENT_LOT_QUANTITY', 'كمية غير صالحة للدفعة "' + b.lotNumber + '"');
      sum = round3(sum + q);
    }
    if (sum !== round3(ctx.qty)) throw _err('VALIDATION_ERROR', 'مجموع التخصيص اليدوي لا يساوي الكمية المطلوبة');
    plan = { allocations: ctx.manualAllocations.map((a) => ({ lotId: a.lotId, qty: round3(a.qty) })), shortfall: 0 };
  } else {
    plan = planFefo(balances, ctx.qty, { mode: ctx.trackingMode || 'lot', now: ctx.now, allowExpired: ctx.allowExpired });
    if (plan.shortfall > 0) throw _err('INSUFFICIENT_LOT_QUANTITY', 'رصيد الدفعات غير كافٍ — نقص ' + plan.shortfall);
  }
  const out = [];
  for (const a of plan.allocations) {
    await _adjustBalance(conn, ctx.warehouseId, ctx.itemId, a.lotId, -a.qty);
    await _insertLotMovement(conn, { movementSeq: ctx.movementSeq, movementId: ctx.movementId, lotId: a.lotId, warehouseId: ctx.warehouseId, itemId: ctx.itemId, signedQty: -a.qty, referenceType: ctx.referenceType, referenceId: ctx.referenceId, reason: ctx.reason, actor: ctx.actor, occurredAt: ctx.occurredAt });
    const b = byId.get(a.lotId);
    out.push({ lotId: a.lotId, lotNumber: b ? b.lotNumber : null, qty: a.qty, expiryDate: b ? b.expiryDate : null });
  }
  return { allocations: out };
}

// ── INBOUND: receive qty into a warehouse+item as a lot ────────────────────
// ctx: { warehouseId, itemId, qty, lot:{lotNumber, expiryDate?, manufactureDate?, unitCost?, sourceType?, sourceId?, isImported?},
//        trackingMode, movementSeq, movementId, referenceType, referenceId, reason, actor, occurredAt, now, allowNearExpiry? }
// Returns { lotId, lotNumber, created, expiryWarning? }.
async function receiveInbound(conn, ctx) {
  const lot = ctx.lot || {};
  if (!lotNorm(lot.lotNumber)) throw _err('LOT_REQUIRED', 'رقم الدفعة مطلوب لصنف يخضع لتتبع الدفعات');
  if (ctx.trackingMode === 'expiry' && !EXP.ymd(lot.expiryDate)) throw _err('VALIDATION_ERROR', 'تاريخ الصلاحية مطلوب لصنف يخضع لتتبع الصلاحية');
  let expiryWarning = null;
  if (EXP.ymd(lot.expiryDate)) {
    const rc = EXP.receiptCheck(lot.expiryDate, ctx.now);
    if (!rc.ok) throw _err('EXPIRED_LOT', 'لا يمكن استلام دفعة منتهية الصلاحية'); // already expired → always blocked
    if (rc.level === 'near') {
      // Near-expiry receipt: WARN by default (policy), BLOCK only when configured.
      if (/^(1|true|yes|on)$/i.test(String(process.env.EXPIRY_BLOCK_NEAR_RECEIPT || ''))) {
        throw _err('VALIDATION_ERROR', 'الدفعة قريبة الانتهاء (' + rc.daysUntil + ' يومًا) — الاستلام ممنوع وفق السياسة');
      }
      expiryWarning = { level: 'near', daysUntil: rc.daysUntil };
    }
  }
  const { lotId, created } = await _findOrCreateLot(conn, ctx.itemId, lot, ctx.actor);
  await _adjustBalance(conn, ctx.warehouseId, ctx.itemId, lotId, round3(ctx.qty));
  await _insertLotMovement(conn, { movementSeq: ctx.movementSeq, movementId: ctx.movementId, lotId, warehouseId: ctx.warehouseId, itemId: ctx.itemId, signedQty: round3(ctx.qty), referenceType: ctx.referenceType, referenceId: ctx.referenceId, reason: ctx.reason, actor: ctx.actor, occurredAt: ctx.occurredAt });
  return { lotId, lotNumber: lot.lotNumber, created, expiryWarning };
}

// ── REVERSAL: restore the EXACT lots a posted doc moved (never re-run FEFO) ──
// ctx: { referenceType, referenceId, movementSeq, movementId, actor, occurredAt }
// Reads the original lot movements for (referenceType, referenceId) and applies the
// opposite sign. Returns the list of reversed lot movements.
async function reverseAllocation(conn, ctx) {
  const [orig] = await conn.query(
    'SELECT lot_id, warehouse_id, item_id, signed_qty FROM inventory_lot_movements WHERE reference_type=? AND reference_id=?',
    [ctx.referenceType, ctx.referenceId]
  );
  const reversed = [];
  for (const r of orig) {
    const back = -Number(r.signed_qty);
    await _adjustBalance(conn, r.warehouse_id, r.item_id, r.lot_id, round3(back));
    await _insertLotMovement(conn, { movementSeq: ctx.movementSeq, movementId: ctx.movementId, lotId: r.lot_id, warehouseId: r.warehouse_id, itemId: r.item_id, signedQty: round3(back), referenceType: String(ctx.referenceType).replace(/_reverse$/, '') + '_reverse', referenceId: ctx.referenceId, reason: 'عكس', actor: ctx.actor, occurredAt: ctx.occurredAt });
    reversed.push({ lotId: r.lot_id, warehouseId: r.warehouse_id, qty: round3(back) });
  }
  return { reversed };
}

// ── OPENING: when tracking is enabled on an item that already has stock, create
// one OPENING lot per warehouse = current warehouse_stock.qty (keeps the invariant
// true from t0). Does NOT touch warehouse_stock (the stock already exists).
async function openingLot(conn, ctx) {
  const qty = round3(ctx.qty);
  if (qty <= 0) return { lotId: null, created: false };
  const lotNumber = ctx.lotNumber || ('OPENING-' + EXP.todayYmd(ctx.now));
  const { lotId } = await _findOrCreateLot(conn, ctx.itemId, { lotNumber, expiryDate: ctx.expiryDate || null, unitCost: ctx.unitCost || 0, sourceType: 'opening', sourceId: ctx.warehouseId, isImported: ctx.isImported ? 1 : 0 }, ctx.actor);
  await _adjustBalance(conn, ctx.warehouseId, ctx.itemId, lotId, qty);
  await _insertLotMovement(conn, { movementSeq: ctx.movementSeq || null, movementId: ctx.movementId || null, lotId, warehouseId: ctx.warehouseId, itemId: ctx.itemId, signedQty: qty, referenceType: 'opening', referenceId: ctx.warehouseId, reason: 'رصيد افتتاحي للتتبع', actor: ctx.actor, occurredAt: ctx.occurredAt });
  return { lotId, created: true };
}

// ── INVARIANT: Σ(lot balances) === warehouse_stock.qty for a tracked item+wh ──
async function assertInvariant(conn, warehouseId, itemId) {
  const [[ls]] = await conn.query('SELECT COALESCE(SUM(qty),0) AS s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?', [warehouseId, itemId]);
  const [[ws]] = await conn.query('SELECT COALESCE(qty,0) AS q FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1', [warehouseId, itemId]);
  const lotSum = round3(ls ? ls.s : 0);
  const stockQty = round3(ws ? ws.q : 0);
  if (Math.abs(lotSum - stockQty) > 0.001) {
    throw _err('LOT_INVARIANT_VIOLATION', 'اختلال ثبات الدفعات: مجموع الدفعات ' + lotSum + ' ≠ رصيد المستودع ' + stockQty + ' (صنف ' + itemId + ')');
  }
  return { lotSum, stockQty, ok: true };
}

module.exports = {
  // pure
  lotNorm, isTracked, planFefo, round3,
  // db
  getTrackingMode, loadBalances, allocateOutbound, receiveInbound, reverseAllocation, openingLot, assertInvariant,
};
