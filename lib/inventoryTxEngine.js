/**
 * Inventory-transaction engine — Phase 3B.
 *
 * Shared costing / stock-movement / GL-spec / state-guard logic for the three
 * independent document types (receipts, issues, adjustments). The WAC + movement
 * helpers are byte-faithful copies of the proven private helpers in
 * routes/warehouse-ops.js — copied (not imported) so the hardened transfers code
 * is never edited and the new docs can never destabilise it.
 *
 * Pure parts (newWAC, guards, GL spec builders, inventoryAccountFor) are
 * unit-tested in tests/inventoryTxEngine.test.js. DB parts take an explicit
 * transaction `conn` (post/reverse always run inside db.withTransaction).
 *
 * Money policy: amounts are rounded with round2 before they reach postJournal
 * (which itself enforces Σdebit=Σcredit within ±0.01); WAC keeps 4 decimals.
 */
'use strict';
const gl = require('./glPosting');
const A = gl.CORE_ACCOUNTS;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

// ── Weighted-average cost (recompute ONLY when adding stock) ────────────────
function newWAC(oldQty, oldCost, addQty, addCost) {
  const totalQty = Number(oldQty) + Number(addQty);
  if (totalQty <= 0) return Number(addCost) || 0;
  const oldVal = Number(oldQty) * Number(oldCost);
  const addVal = Number(addQty) * Number(addCost);
  return Number(((oldVal + addVal) / totalQty).toFixed(4));
}

// Which inventory asset account a warehouse posts to: main → 1200, branch → 1210.
function inventoryAccountFor(wh) {
  const isMain = !!wh && (wh.is_main === 1 || wh.is_main === true || String(wh.type || '').toLowerCase() === 'main');
  return isMain ? A.INVENTORY.code : A.BRANCH_INVENTORY.code;
}

// Expense account for a NEGATIVE adjustment: damage/waste → 5200, else variance 5300.
function adjustmentExpenseCode(reason) {
  return /تالف|هدر|تلف|damage|waste|spoil|expire/i.test(String(reason || '')) ? A.WASTE_EXPENSE.code : A.STOCK_VARIANCE.code;
}

// ── GL spec builders (pure) ────────────────────────────────────────────────
function _dims(o) { return { warehouseId: o.warehouseId || null, brandId: o.brandId || null, branchId: o.branchId || null, costCenterId: o.costCenterId || null }; }
function _base(o) { return { journalDate: o.journalDate, postedBy: o.postedBy, referenceId: o.referenceId, description: o.description }; }

// Receipt (stock IN, not a purchase): Dr inventory / Cr the chosen counter
// account. The counter is supplied + validated by the route (no silent default);
// the STOCK_GAIN fallback here only keeps the pure builder usable in unit tests.
function glReceipt(o) {
  const amt = round2(o.amount);
  const inv = inventoryAccountFor(o.warehouse);
  const counter = o.counterCode || A.STOCK_GAIN.code;
  return Object.assign(_base(o), {
    referenceType: 'inv_receipt',
    entries: [
      Object.assign({ accountCode: inv, debit: amt, credit: 0 }, _dims(o)),
      Object.assign({ accountCode: counter, debit: 0, credit: amt }, _dims(o)),
    ],
  });
}

// Issue (stock OUT to expense/department): Dr expense / Cr inventory.
function glIssue(o) {
  const amt = round2(o.amount);
  const inv = inventoryAccountFor(o.warehouse);
  const exp = o.expenseCode || A.STOCK_VARIANCE.code;
  return Object.assign(_base(o), {
    referenceType: 'inv_issue',
    entries: [
      Object.assign({ accountCode: exp, debit: amt, credit: 0 }, _dims(o)),
      Object.assign({ accountCode: inv, debit: 0, credit: amt }, _dims(o)),
    ],
  });
}

// Adjustment: positive delta → Dr inventory / Cr stock-gain; negative → Dr expense / Cr inventory.
function glAdjustment(o) {
  const amt = round2(Math.abs(o.amount));
  const inv = inventoryAccountFor(o.warehouse);
  const positive = Number(o.delta) >= 0;
  const exp = o.expenseCode || adjustmentExpenseCode(o.reason);
  const entries = positive
    ? [Object.assign({ accountCode: inv, debit: amt, credit: 0 }, _dims(o)), Object.assign({ accountCode: A.STOCK_GAIN.code, debit: 0, credit: amt }, _dims(o))]
    : [Object.assign({ accountCode: exp, debit: amt, credit: 0 }, _dims(o)), Object.assign({ accountCode: inv, debit: 0, credit: amt }, _dims(o))];
  return Object.assign(_base(o), { referenceType: 'inv_adjustment', entries });
}

// Adjustment with MIXED-sign lines in one journal: total increase value posts
// Dr inventory / Cr stock-gain; total decrease value posts Dr expense / Cr
// inventory. Both pairs balance, so the journal balances. Used by the route
// (a single adjustment can raise some items and lower others).
function glAdjustmentNet(o) {
  const pos = round2(o.posValue || 0);
  const neg = round2(o.negValue || 0);
  const inv = inventoryAccountFor(o.warehouse);
  const exp = o.expenseCode || A.STOCK_VARIANCE.code;
  const entries = [];
  if (pos > 0) {
    entries.push(Object.assign({ accountCode: inv, debit: pos, credit: 0 }, _dims(o)));
    entries.push(Object.assign({ accountCode: A.STOCK_GAIN.code, debit: 0, credit: pos }, _dims(o)));
  }
  if (neg > 0) {
    entries.push(Object.assign({ accountCode: exp, debit: neg, credit: 0 }, _dims(o)));
    entries.push(Object.assign({ accountCode: inv, debit: 0, credit: neg }, _dims(o)));
  }
  return Object.assign(_base(o), { referenceType: 'inv_adjustment', entries });
}

// Reversing journal: swap debit/credit on every entry; tag referenceType *_reverse.
function reverseSpec(spec, opts) {
  const o = opts || {};
  return Object.assign({}, spec, {
    referenceType: String(spec.referenceType || 'inv').replace(/_reverse$/, '') + '_reverse',
    description: o.description || ('عكس: ' + (spec.description || '')),
    postedBy: o.postedBy || spec.postedBy,
    journalDate: o.journalDate || spec.journalDate,
    referenceId: o.referenceId || spec.referenceId,
    entries: (spec.entries || []).map((e) => Object.assign({}, e, { debit: e.credit, credit: e.debit })),
  });
}

// ── State machine guards (pure) ─────────────────────────────────────────────
const STATUSES = ['draft', 'approved', 'posted', 'cancelled', 'reversed'];
const TERMINAL = ['cancelled', 'reversed'];
function _g(msg) { const e = new Error(msg); e.code = 'INVALID_STATE_TRANSITION'; return e; }
function canEdit(s) { return s === 'draft'; }
function canApprove(s) { return s === 'draft'; }
function canPost(s) { return s === 'approved'; }
function canCancel(s) { return s === 'draft' || s === 'approved'; }
function canReverse(s) { return s === 'posted'; }
function canDelete(s) { return s === 'draft'; }
function assertCanEdit(s) { if (!canEdit(s)) throw _g('لا يمكن تعديل مستند حالته "' + s + '" — المسودة فقط قابلة للتعديل'); }
function assertCanApprove(s) { if (!canApprove(s)) throw _g('لا يمكن اعتماد مستند حالته "' + s + '"'); }
function assertCanPost(s) { if (!canPost(s)) throw _g('لا يمكن ترحيل مستند حالته "' + s + '" — يجب اعتماده أولًا'); }
function assertCanCancel(s) { if (!canCancel(s)) throw _g('لا يمكن إلغاء مستند حالته "' + s + '" — الإلغاء قبل الترحيل فقط'); }
function assertCanReverse(s) { if (!canReverse(s)) throw _g('لا يمكن عكس مستند حالته "' + s + '" — المرحّل فقط قابل للعكس'); }
function assertCanDelete(s) { if (!canDelete(s)) throw _g('لا يمكن حذف مستند حالته "' + s + '" — المسودة فقط؛ استخدم العكس بعد الترحيل'); }

// ── GL account validation (no arbitrary/silent accounts) ───────────────────
// A posting counter-account must EXIST, be ACTIVE, be a POSTABLE LEAF (no child
// accounts — i.e. a detail account, not a header/folder) and, when an allow-list
// is given, be of an allowed type. Throws { code:'VALIDATION_ERROR' }; returns
// the account row. Used by receipts/issues at draft-build AND again at post time
// (so an account deactivated between draft and post is caught before it posts).
function _v(msg) { const e = new Error(msg); e.code = 'VALIDATION_ERROR'; return e; }
async function validateAccount(conn, code, allowedTypes) {
  const c = String(code == null ? '' : code).trim();
  if (!c) throw _v('الحساب المقابل مطلوب');
  const [rows] = await conn.query('SELECT id, code, type, is_active FROM gl_accounts WHERE code=? LIMIT 1', [c]);
  if (!rows.length) throw _v('الحساب المحاسبي ' + c + ' غير موجود في شجرة الحسابات');
  const acc = rows[0];
  if (!(acc.is_active === 1 || acc.is_active === true)) throw _v('الحساب ' + c + ' غير نشط — اختر حسابًا نشطًا');
  const [kids] = await conn.query('SELECT 1 FROM gl_accounts WHERE parent_id=? LIMIT 1', [acc.id]);
  if (kids.length) throw _v('الحساب ' + c + ' حساب رئيسي غير قابل للترحيل — اختر حسابًا تفصيليًا');
  if (Array.isArray(allowedTypes) && allowedTypes.length && allowedTypes.indexOf(String(acc.type || '').toLowerCase()) === -1) {
    throw _v('الحساب ' + c + ' من نوع "' + acc.type + '" غير مسموح في هذا السياق');
  }
  return acc;
}

// ── DB helpers (require a transaction `conn`) ───────────────────────────────
// Effective unit cost for an item in a warehouse: WAC → fallback inv_items.cost.
async function getEffectiveCost(conn, itemId, warehouseId) {
  if (warehouseId) {
    const [rows] = await conn.query('SELECT avg_cost, qty FROM warehouse_stock WHERE item_id=? AND warehouse_id=? LIMIT 1', [itemId, warehouseId]);
    if (rows.length && Number(rows[0].avg_cost) > 0) return Number(rows[0].avg_cost);
  }
  const [fb] = await conn.query('SELECT cost FROM inv_items WHERE id=? LIMIT 1', [itemId]);
  return fb.length ? Number(fb[0].cost || 0) : 0;
}

// Read current qty + WAC for a warehouse/item, optionally FOR UPDATE.
async function readStock(conn, warehouseId, itemId, forUpdate) {
  const [rows] = await conn.query(
    'SELECT qty, avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1' + (forUpdate ? ' FOR UPDATE' : ''),
    [warehouseId, itemId]
  );
  return rows.length ? { qty: Number(rows[0].qty), avgCost: Number(rows[0].avg_cost) } : { qty: 0, avgCost: 0 };
}

async function recordCostHistory(conn, itemId, warehouseId, oldCost, newCost, oldQty, newQty, triggerType, refId, changedBy) {
  try {
    await conn.query(
      'INSERT INTO item_cost_history (id, item_id, warehouse_id, method, old_cost, new_cost, old_qty, new_qty, trigger_type, reference_id, changed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ['CH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), itemId, warehouseId || null, 'WAC', oldCost || 0, newCost || 0, oldQty || 0, newQty || 0, triggerType, refId || null, changedBy || '']
    );
  } catch (_) { /* best effort */ }
}

// Atomic stock move (FOR UPDATE + UPSERT), recompute WAC only when adding.
// Byte-faithful to routes/warehouse-ops.js _applyStockMovement. Allows negatives —
// the route enforces the no-negative policy BEFORE calling this for issues.
//
// Phase W2 — Optional negative-stock guard. Passing `opts` opts-in to the new
// policy check (see lib/negativeStockPolicy). When NEGATIVE_STOCK_POLICY_ENABLED
// is not set, the guard runs but with the seeded `global/block` row it behaves
// identically to legacy INSUFFICIENT_STOCK — no observable change. Existing
// callers that don't pass opts remain fully backward-compatible.
async function applyStockMovement(conn, warehouseId, itemId, qtyDelta, unitCost, triggerType, refId, changedBy, opts) {
  const [rows] = await conn.query('SELECT qty, avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1 FOR UPDATE', [warehouseId, itemId]);
  const oldQty = rows.length ? Number(rows[0].qty) : 0;
  const oldCost = rows.length ? Number(rows[0].avg_cost) : 0;
  const newQtyProbe = oldQty + Number(qtyDelta);

  // ── negative-stock guard (opt-in via opts.negativeGuard) ────────────────
  let deficitInfo = null;
  if (opts && opts.negativeGuard && Number(qtyDelta) < 0 && newQtyProbe < 0) {
    const NSP = require('./negativeStockPolicy');
    if (NSP.POLICY_ENABLED() || opts.negativeGuard.strict) {
      const g = opts.negativeGuard;
      const [ig] = await conn.query("SELECT id, policy, max_negative_qty, is_enabled FROM negative_stock_policy WHERE scope='global' AND warehouse_id IS NULL AND item_id IS NULL AND is_enabled=1 LIMIT 1").catch(() => [[]]);
      const [wh] = await conn.query("SELECT id, policy, max_negative_qty, is_enabled FROM negative_stock_policy WHERE scope='warehouse' AND warehouse_id=? AND item_id IS NULL AND is_enabled=1 LIMIT 1", [warehouseId]).catch(() => [[]]);
      const [it] = await conn.query("SELECT id, policy, max_negative_qty, is_enabled FROM negative_stock_policy WHERE scope='item' AND warehouse_id=? AND item_id=? AND is_enabled=1 LIMIT 1", [warehouseId, itemId]).catch(() => [[]]);
      const [item] = await conn.query('SELECT tracking_mode FROM inv_items WHERE id=? LIMIT 1', [itemId]).catch(() => [[]]);
      const decision = NSP.decide({
        item: { tracking_mode: (item[0] && item[0].tracking_mode) || 'none' },
        globalCfg: ig[0] || null, whCfg: wh[0] || null, itemCfg: it[0] || null,
        request: { oldQty, qtyDelta: Number(qtyDelta), newQty: newQtyProbe,
                   user: g.user || {}, reason: g.reason, acknowledgeNegative: !!g.acknowledgeNegative,
                   makerChecker: g.makerChecker || null },
      });
      if (decision.outcome.verdict === 'deny') {
        const err = new Error(decision.outcome.code);
        err.code = decision.outcome.code;
        err.effectivePolicy = decision.resolved.effectivePolicy;
        throw err;
      }
      if (decision.outcome.verdict === 'deficit') {
        deficitInfo = {
          deficitQty: Math.abs(newQtyProbe),
          effectivePolicy: decision.resolved.effectivePolicy,
          reason: g.reason,
        };
      }
    }
  }

  let newCost = oldCost;
  if (Number(qtyDelta) > 0 && Number(unitCost) > 0) newCost = newWAC(oldQty, oldCost || unitCost, qtyDelta, unitCost);
  const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  await conn.query(
    'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost, last_updated) VALUES (?,?,?,?,?,?,NOW()) ' +
    'ON DUPLICATE KEY UPDATE qty = qty + ?, avg_cost = ?, last_cost = ?, last_updated = NOW()',
    [wsId, warehouseId, itemId, Number(qtyDelta), newCost, unitCost || oldCost, Number(qtyDelta), newCost, unitCost || oldCost]
  );
  const newQty = oldQty + Number(qtyDelta);
  await recordCostHistory(conn, itemId, warehouseId, oldCost, newCost, oldQty, newQty, triggerType, refId, changedBy);

  // Record the deficit row if the guard authorized a controlled negative.
  if (deficitInfo) {
    const g = opts.negativeGuard;
    const defId = 'DEF-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    await conn.query(
      "INSERT INTO stock_deficits (id, warehouse_id, item_id, origin_doc_type, origin_doc_id, deficit_qty, remaining_qty, unit_cost_at_issue, reason, status, created_by) " +
      "VALUES (?,?,?,?,?,?,?,?,?, 'open', ?)",
      [defId, warehouseId, itemId, g.docType || triggerType || 'unknown', g.docId || refId || '', deficitInfo.deficitQty, deficitInfo.deficitQty, oldCost || 0, deficitInfo.reason || '', (g.user && g.user.username) || changedBy || '']
    );
  } else if (Number(qtyDelta) > 0) {
    // Positive inbound: reduce any open deficits for this (warehouse,item).
    const [open] = await conn.query("SELECT id, remaining_qty FROM stock_deficits WHERE warehouse_id=? AND item_id=? AND status IN ('open','partial') ORDER BY id", [warehouseId, itemId]);
    let inbound = Number(qtyDelta);
    for (const d of open) {
      if (inbound <= 0) break;
      const cover = Math.min(inbound, Number(d.remaining_qty));
      const remaining = Number(d.remaining_qty) - cover;
      const newStatus = remaining <= 0.001 ? 'covered' : 'partial';
      await conn.query('UPDATE stock_deficits SET remaining_qty=?, status=?, closed_at=CASE WHEN ?=? THEN NOW() ELSE closed_at END, version=version+1 WHERE id=?',
        [remaining, newStatus, newStatus, 'covered', d.id]);
      inbound -= cover;
    }
  }

  return { oldQty, oldCost, newQty, newCost, deficit: deficitInfo };
}

// Insert one inventory_movements ledger row with a doc-type-specific reference_type.
async function recordMovement(conn, m) {
  const id = 'MV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  await conn.query(
    'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, m.movementDate || new Date(), m.itemId, m.itemName || '', m.type, Number(m.qty), m.reason || '', m.username || '', String(m.notes || '').slice(0, 400), m.warehouseId || null, m.referenceType || null, m.referenceId || null]
  );
  return id;
}

module.exports = {
  CORE_ACCOUNTS: A,
  round2, round4, newWAC, inventoryAccountFor, adjustmentExpenseCode,
  glReceipt, glIssue, glAdjustment, glAdjustmentNet, reverseSpec,
  STATUSES, TERMINAL,
  canEdit, canApprove, canPost, canCancel, canReverse, canDelete,
  assertCanEdit, assertCanApprove, assertCanPost, assertCanCancel, assertCanReverse, assertCanDelete,
  validateAccount,
  getEffectiveCost, readStock, recordCostHistory, applyStockMovement, recordMovement,
};
