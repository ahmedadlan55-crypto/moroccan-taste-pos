/**
 * Cashier V2 — cart lifecycle API. Mounted at /api/pos/v2 (server.js).
 *
 * SCOPE: this layer owns ONLY the order lifecycle (open ⇄ held → submitted →
 * completed, + voided). The FINANCIAL write path stays the battle-tested
 * legacy POST /api/sales (ZATCA chain, GL, stock deduction incl. lots/FEFO,
 * shift totals): /submit freezes the payments and returns the EXACT legacy
 * payload; the client posts it with clientOrderId = pos_orders.id (the legacy
 * route's unique-index idempotency makes retries/offline replays single-shot);
 * /complete links the resulting sale back. Voids/returns AFTER completion go
 * through the legacy credit-note flow — never here.
 *
 * Every mutation is implemented as an internal do*() function used by BOTH the
 * HTTP handlers and POST /sync (offline batch replay) — one logic path.
 * Conventions mirror routes/inventory-transactions.js: actor from JWT,
 * expectedVersion conditional UPDATEs (→ 409 VERSION_CONFLICT), Idempotency-Key
 * on /submit, unified error envelope, db.withTransaction + FOR UPDATE.
 * RBAC: POS roles (admin/manager/cashier); credit sales + above-ceiling
 * discounts are supervisor-gated SERVER-SIDE (never just hidden buttons).
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const M = require('../lib/posOrderMachine');
const C = require('../lib/inventoryTxContract');
const UC = require('../lib/unitConversion');
const IDEM = require('../lib/idempotencyStore');
const requireRole = require('../middleware/auth').requireRole;

const POS = requireRole('admin', 'manager', 'cashier');

// Cashier order-level discount ceiling (percent of subtotal). Above it → manager.
const MAX_CASHIER_DISC_PCT = (() => { const n = Number(process.env.POS_MAX_CASHIER_DISCOUNT_PCT); return Number.isFinite(n) && n >= 0 ? n : 10; })();

function _userName(user) { return (user && (user.username || user.name)) || ''; }
function _userIsSuper(user) { return ['admin', 'manager'].includes(String((user && user.role) || '').toLowerCase()) || !!(user && user.isDeveloper); }
function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function _fail(res, codeOrErr, message) {
  const code = C.isCanonical(codeOrErr) ? codeOrErr : C.mapError(codeOrErr);
  const msg = message || (codeOrErr && codeOrErr.message) || code;
  return res.status(C.httpFor(code)).json(C.errorBody(code, msg));
}
function _catch(res, e) {
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found' });
  if (e && e.code === 'PAYMENT_MISMATCH') return res.status(422).json({ success: false, code: 'PAYMENT_MISMATCH', error: e.message });
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: (e && e.message) || 'error' });
  return _fail(res, e, e && e.message);
}
const ULID_RE = /^[0-9A-Za-z_-]{10,40}$/;

async function _loadOrder(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM pos_orders WHERE id=? LIMIT 1' + (conn ? ' FOR UPDATE' : ''), [id]);
  return rows[0] || null;
}
async function _loadLines(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM pos_order_lines WHERE order_id=? ORDER BY sort, id', [id]);
  return rows;
}
async function _loadPayments(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM pos_payments WHERE order_id=? ORDER BY id', [id]);
  return rows;
}
function _linesForMath(rows) {
  // qty is the stored BASE qty; the entered-unit snapshot is carried through for
  // the legacy sale payload (→ items_json → returns echo the same unit).
  return rows.map((l) => ({
    menuId: l.menu_id, nameSnapshot: l.name_snapshot, qty: Number(l.qty), unitPrice: Number(l.unit_price),
    lineDiscount: Number(l.line_discount), vatCategory: l.vat_category, notes: l.notes,
    enteredUnitId: l.entered_unit_id, enteredUnitCode: l.entered_unit_code,
    enteredQty: l.entered_qty != null ? Number(l.entered_qty) : null,
    conversionFactorSnapshot: l.conversion_factor_snapshot != null ? Number(l.conversion_factor_snapshot) : null,
    baseQty: Number(l.qty),
  }));
}
function _orderForMath(o) {
  return {
    id: o.id, shiftId: o.shift_id, warehouseId: o.warehouse_id, channelId: o.channel_id, channelName: o.channel_name,
    customerId: o.customer_id, discountType: o.discount_type, discountValue: Number(o.discount_value), discountName: o.discount_name,
  };
}
function _publicOrder(o, lines, payments) {
  return {
    id: o.id, status: o.status, orderType: o.order_type, tableNo: o.table_no,
    shiftId: o.shift_id, username: o.username, deviceId: o.device_id,
    warehouseId: o.warehouse_id, customerId: o.customer_id,
    discountType: o.discount_type, discountValue: Number(o.discount_value), discountName: o.discount_name,
    subtotal: Number(o.subtotal), lineDiscountTotal: Number(o.line_discount_total),
    discountTotal: Number(o.discount_total), vatTotal: Number(o.vat_total), total: Number(o.total),
    note: o.note, saleId: o.sale_id, invoiceNumber: o.invoice_number, origin: o.origin,
    version: Number(o.version), heldAt: o.held_at, submittedAt: o.submitted_at,
    completedAt: o.completed_at, voidedAt: o.voided_at, voidReason: o.void_reason,
    createdAt: o.created_at, updatedAt: o.updated_at,
    lines: (lines || []).map((l) => ({ id: l.id, menuId: l.menu_id, name: l.name_snapshot, qty: Number(l.qty), unitPrice: Number(l.unit_price), lineDiscount: Number(l.line_discount), vatCategory: l.vat_category, notes: l.notes, sort: l.sort })),
    payments: (payments || []).map((p) => ({ id: p.id, method: p.method, amount: Number(p.amount), ref: p.ref })),
  };
}

// Validate + normalize the incoming lines against the LIVE menu: existence,
// active flag (inactive items are unsellable), qty/price sanity. vat_category
// comes from the menu — never trusted from the client.
async function _normalizeLines(q, rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw _err('VALIDATION_ERROR', 'السلة فارغة — أضف صنفًا واحدًا على الأقل');
  if (rawLines.length > 200) throw _err('VALIDATION_ERROR', 'السلة كبيرة جدًا');
  const ids = [...new Set(rawLines.map((l) => String(l.menuId || l.menu_id || '')).filter(Boolean))];
  if (!ids.length) throw _err('VALIDATION_ERROR', 'أسطر بلا معرف صنف');
  const [menu] = await q.query('SELECT id, name, price, active, tax_category FROM menu WHERE id IN (?)', [ids]);
  const byId = new Map(menu.map((m) => [String(m.id), m]));
  const out = [];
  let sort = 0;
  for (const l of rawLines) {
    const menuId = String(l.menuId || l.menu_id || '');
    const m = byId.get(menuId);
    if (!m) throw _err('VALIDATION_ERROR', 'صنف غير موجود في القائمة: ' + menuId);
    if (m.active === 0 || m.active === false) throw _err('VALIDATION_ERROR', 'الصنف "' + m.name + '" غير نشط — لا يمكن بيعه');
    const enteredQty = Number(l.qty);
    if (!Number.isFinite(enteredQty) || enteredQty <= 0) throw _err('VALIDATION_ERROR', 'كمية غير صالحة للصنف "' + m.name + '"');
    // Phase U — expand-to-base (owner decision): a line may be entered in a major
    // unit (e.g. scan a carton barcode). qty flowing to stock/sales is ALWAYS base
    // (enteredQty × factor); price is the base price so the line total equals
    // enteredQty × (factor × basePrice) — i.e. price per major unit = factor × base.
    // No unit-price table. Server recomputes base; a client mismatch is rejected.
    let factor = 1, enteredUnitId = null, enteredUnitCode = null;
    if (l.unitFactor != null || l.enteredUnitCode != null || l.enteredUnitId != null) {
      factor = Number(l.unitFactor != null ? l.unitFactor : 1);
      if (!UC.isValidFactor(factor)) throw _err('INVALID_CONVERSION_FACTOR', 'عامل تحويل غير صالح للصنف "' + m.name + '"');
      enteredUnitId = l.enteredUnitId != null ? String(l.enteredUnitId).slice(0, 50) : null;
      enteredUnitCode = l.enteredUnitCode != null ? String(l.enteredUnitCode).slice(0, 30).toUpperCase() : null;
    }
    const qty = UC.round(enteredQty * factor, 6);
    if (l.baseQty != null && UC.round(Number(l.baseQty), 6) !== qty) throw _err('UNIT_CONVERSION_CONFLICT', 'الكمية الأساسية المُرسلة لا تطابق المحسوبة للصنف "' + m.name + '"');
    const unitPrice = Number(l.unitPrice != null ? l.unitPrice : m.price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw _err('VALIDATION_ERROR', 'سعر غير صالح للصنف "' + m.name + '"');
    const lineDiscount = Math.max(0, Number(l.lineDiscount) || 0);
    out.push({
      menuId, nameSnapshot: m.name, qty, unitPrice, lineDiscount,
      vatCategory: ['S', 'Z', 'E', 'O'].includes(m.tax_category) ? m.tax_category : 'S',
      notes: (l.notes || '').toString().slice(0, 300) || null, sort: sort++,
      enteredQty, enteredUnitId, enteredUnitCode, conversionFactorSnapshot: factor,
    });
  }
  return out;
}

async function _replaceLines(conn, orderId, lines) {
  await conn.query('DELETE FROM pos_order_lines WHERE order_id=?', [orderId]);
  for (const l of lines) {
    await conn.query(
      'INSERT INTO pos_order_lines (id, order_id, menu_id, name_snapshot, qty, unit_price, line_discount, vat_category, notes, sort, entered_qty, entered_unit_id, entered_unit_code, conversion_factor_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ['PL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), orderId, l.menuId, l.nameSnapshot, l.qty, l.unitPrice, l.lineDiscount, l.vatCategory, l.notes, l.sort,
       l.enteredQty != null ? l.enteredQty : l.qty, l.enteredUnitId != null ? l.enteredUnitId : null, l.enteredUnitCode != null ? l.enteredUnitCode : null, l.conversionFactorSnapshot != null ? l.conversionFactorSnapshot : 1]);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Internal operations — ONE logic path shared by HTTP handlers and /sync.
// Each returns a JSON-able result or throws a coded error.
// ════════════════════════════════════════════════════════════════════════════

async function doUpsert(user, body) {
  const actor = _userName(user);
  const b = body || {};
  const id = String(b.id || '').trim();
  if (!ULID_RE.test(id)) throw _err('VALIDATION_ERROR', 'معرف الطلب (id) مطلوب — ULID من العميل');
  const lines = await _normalizeLines(db, b.lines);
  const discountType = ['PERCENT', 'FIXED'].includes(b.discountType) ? b.discountType : null;
  const discountValue = discountType ? Math.max(0, Number(b.discountValue) || 0) : 0;
  const totals = M.cartTotals(lines, discountType ? { type: discountType, value: discountValue } : null);
  const orderType = M.normalizeOrderType(b.orderType);
  const shiftId = b.shiftId != null ? (String(b.shiftId).trim().slice(0, 40) || null) : null;
  const expected = b.expectedVersion != null ? (parseInt(b.expectedVersion, 10)) : null;

  const out = await db.withTransaction(async (conn) => {
    const existing = await _loadOrder(id, conn); // FOR UPDATE
    if (!existing) {
      await conn.query(
        `INSERT INTO pos_orders (id, status, order_type, table_no, shift_id, username, device_id, warehouse_id, channel_id, channel_name, customer_id,
           discount_type, discount_value, discount_name, subtotal, line_discount_total, discount_total, vat_total, total, note, origin, version)
         VALUES (?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        [id, orderType, (b.tableNo || '').toString().slice(0, 20) || null, shiftId, actor,
         (b.deviceId || '').toString().slice(0, 60) || null,
         (b.warehouseId || '').toString().slice(0, 50) || null,
         (b.channelId || '').toString().slice(0, 50) || null,
         (b.channelName || '').toString().slice(0, 100) || null,
         (b.customerId || '').toString().slice(0, 50) || null,
         discountType, discountValue, (b.discountName || '').toString().slice(0, 100) || null,
         totals.subtotal, totals.lineDiscountTotal, totals.discountAmount, totals.vatTotal, totals.total,
         (b.note || '').toString().slice(0, 300) || null,
         b.origin === 'offline' ? 'offline' : 'online']);
      await _replaceLines(conn, id, lines);
      return { version: 1, created: true };
    }
    M.assertCanEdit(existing.status);
    if (!_userIsSuper(user) && existing.username && existing.username !== actor) throw _err('PERMISSION_DENIED', 'هذا الطلب يخص كاشيرًا آخر');
    if (!Number.isFinite(expected)) throw _err('VALIDATION_ERROR', 'expectedVersion مطلوب لتعديل طلب موجود');
    const [r] = await conn.query(
      `UPDATE pos_orders SET order_type=?, table_no=?, shift_id=?, warehouse_id=?, channel_id=?, channel_name=?, customer_id=?,
         discount_type=?, discount_value=?, discount_name=?, subtotal=?, line_discount_total=?, discount_total=?, vat_total=?, total=?, note=?, version=version+1
       WHERE id=? AND status='open' AND version=?`,
      [orderType, (b.tableNo || '').toString().slice(0, 20) || null, shiftId,
       (b.warehouseId || '').toString().slice(0, 50) || null,
       (b.channelId || '').toString().slice(0, 50) || null,
       (b.channelName || '').toString().slice(0, 100) || null,
       (b.customerId || '').toString().slice(0, 50) || null,
       discountType, discountValue, (b.discountName || '').toString().slice(0, 100) || null,
       totals.subtotal, totals.lineDiscountTotal, totals.discountAmount, totals.vatTotal, totals.total,
       (b.note || '').toString().slice(0, 300) || null, id, expected]);
    if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّر الطلب منذ آخر تحميل (جهاز آخر؟) — نسخة الخادم هي المعتمدة');
    await _replaceLines(conn, id, lines);
    return { version: expected + 1, created: false };
  });
  return {
    success: true, created: out.created, status: 'open',
    data: { id, version: out.version, totals: { subtotal: totals.subtotal, discountAmount: totals.discountAmount, vatTotal: totals.vatTotal, total: totals.total } },
    version: out.version,
  };
}

async function doTransition(user, id, action, body) {
  const actor = _userName(user);
  const b = body || {};
  const expected = b.expectedVersion != null ? parseInt(b.expectedVersion, 10) : null;
  return db.withTransaction(async (conn) => {
    const o = await _loadOrder(id, conn); // FOR UPDATE
    if (!o) { const e = new Error('الطلب غير موجود'); e.status = 404; throw e; }
    if (!_userIsSuper(user) && o.username && o.username !== actor) throw _err('PERMISSION_DENIED', 'هذا الطلب يخص كاشيرًا آخر');
    if (Number.isFinite(expected) && Number(o.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر الطلب — أعد التحميل');
    let sql, params, to;
    if (action === 'hold') {
      M.assertCanHold(o.status);
      sql = "UPDATE pos_orders SET status='held', held_at=NOW(), version=version+1 WHERE id=? AND status='open'"; params = [id]; to = 'held';
    } else if (action === 'resume') {
      M.assertCanResume(o.status);
      sql = "UPDATE pos_orders SET status='open', held_at=NULL, device_id=?, version=version+1 WHERE id=? AND status='held'";
      params = [(b.deviceId || '').toString().slice(0, 60) || null, id]; to = 'open';
    } else if (action === 'reopen') {
      M.assertCanReopen(o.status);
      sql = "UPDATE pos_orders SET status='open', submitted_at=NULL, version=version+1 WHERE id=? AND status='submitted'"; params = [id]; to = 'open';
    } else if (action === 'void') {
      M.assertCanVoid(o.status);
      const reason = String(b.reason || '').trim();
      if (!reason) throw _err('VALIDATION_ERROR', 'سبب الإلغاء إلزامي');
      sql = "UPDATE pos_orders SET status='voided', voided_at=NOW(), void_reason=?, version=version+1 WHERE id=? AND status IN ('open','held')";
      params = [reason.slice(0, 300), id]; to = 'voided';
    } else {
      throw _err('VALIDATION_ERROR', 'إجراء غير معروف: ' + action);
    }
    const [r] = await conn.query(sql, params);
    if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الطلب — أعد التحميل');
    if (action === 'reopen') await conn.query('DELETE FROM pos_payments WHERE order_id=?', [id]);
    return { success: true, data: { id }, status: to, version: Number(o.version) + 1 };
  });
}

async function doSubmit(user, id, body) {
  const actor = _userName(user);
  const b = body || {};
  const expected = b.expectedVersion != null ? parseInt(b.expectedVersion, 10) : null;
  return db.withTransaction(async (conn) => {
    const o = await _loadOrder(id, conn); // FOR UPDATE
    if (!o) { const e = new Error('الطلب غير موجود'); e.status = 404; throw e; }
    if (!_userIsSuper(user) && o.username && o.username !== actor) throw _err('PERMISSION_DENIED', 'هذا الطلب يخص كاشيرًا آخر');
    M.assertCanSubmit(o.status);
    if (Number.isFinite(expected) && Number(o.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر الطلب — أعد التحميل');
    if (!o.shift_id) throw _err('VALIDATION_ERROR', 'لا يمكن الدفع بلا وردية مفتوحة — افتح وردية أولًا');
    const lineRows = await _loadLines(id, conn);
    if (!lineRows.length) throw _err('VALIDATION_ERROR', 'السلة فارغة');
    const lines = _linesForMath(lineRows);
    const totals = M.cartTotals(lines, o.discount_type ? { type: o.discount_type, value: Number(o.discount_value) } : null);

    // SERVER-SIDE discount ceiling: above the cashier limit needs a manager.
    if (totals.discountAmount > 0 && !_userIsSuper(user)) {
      const pct = totals.subtotal > 0 ? (totals.discountAmount / totals.subtotal) * 100 : 0;
      if (pct > MAX_CASHIER_DISC_PCT + 1e-9) {
        throw _err('PERMISSION_DENIED', 'الخصم (' + M.round2(pct) + '%) يتجاوز حد الكاشير (' + MAX_CASHIER_DISC_PCT + '%) — يتطلب مديرًا');
      }
    }
    const payments = Array.isArray(b.payments) ? b.payments.map((p) => ({ method: String(p.method), amount: Number(p.amount) })) : [];
    M.validatePayments(payments, totals.total);
    // Credit sales are supervisor-gated (AR exposure).
    if (payments.some((p) => p.method === 'credit') && !_userIsSuper(user)) throw _err('PERMISSION_DENIED', 'البيع الآجل يتطلب مشرفًا/مديرًا');

    await conn.query('DELETE FROM pos_payments WHERE order_id=?', [id]);
    for (const p of payments) {
      await conn.query('INSERT INTO pos_payments (id, order_id, method, amount, ref) VALUES (?,?,?,?,?)',
        ['PP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), id, p.method, M.round2(p.amount), (b.ref || '').toString().slice(0, 100) || null]);
    }
    const [r] = await conn.query(
      "UPDATE pos_orders SET status='submitted', submitted_at=NOW(), subtotal=?, line_discount_total=?, discount_total=?, vat_total=?, total=?, version=version+1 WHERE id=? AND status='open' AND version=?",
      [totals.subtotal, totals.lineDiscountTotal, totals.discountAmount, totals.vatTotal, totals.total, id, o.version]);
    if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الطلب أثناء الإرسال');

    const legacyPayload = M.buildLegacySalePayload(_orderForMath(o), lines, payments, {
      cashTendered: Number(b.cashTendered) || 0, changeDue: Number(b.changeDue) || 0,
      paymentNotes: (b.paymentNotes || '').toString().slice(0, 300) || undefined,
    });
    return { success: true, data: { id, legacyPayload, total: totals.total }, status: 'submitted', version: Number(o.version) + 1 };
  });
}

async function doComplete(user, id, body) {
  const saleId = String((body && body.saleId) || '').trim();
  const invoiceNumber = String((body && body.invoiceNumber) || '').trim() || null;
  if (!saleId) throw _err('VALIDATION_ERROR', 'saleId مطلوب');
  return db.withTransaction(async (conn) => {
    const o = await _loadOrder(id, conn); // FOR UPDATE
    if (!o) { const e = new Error('الطلب غير موجود'); e.status = 404; throw e; }
    if (o.status === 'completed') {
      if (o.sale_id === saleId) return { success: true, idempotent: true, data: { id, saleId }, status: 'completed', version: Number(o.version) };
      throw _err('VERSION_CONFLICT', 'الطلب مكتمل ببيع مختلف (' + o.sale_id + ')');
    }
    M.assertCanComplete(o.status);
    // Belt-and-braces: the sale must exist and reference THIS order id.
    const [sale] = await conn.query('SELECT id, client_order_id, invoice_number FROM sales WHERE id=? LIMIT 1', [saleId]);
    if (!sale.length) throw _err('VALIDATION_ERROR', 'البيع غير موجود: ' + saleId);
    if (sale[0].client_order_id && sale[0].client_order_id !== id) throw _err('VALIDATION_ERROR', 'البيع مرتبط بطلب آخر');
    const [r] = await conn.query(
      "UPDATE pos_orders SET status='completed', completed_at=NOW(), sale_id=?, invoice_number=?, version=version+1 WHERE id=? AND status='submitted'",
      [saleId, invoiceNumber || sale[0].invoice_number || null, id]);
    if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الطلب أثناء الإكمال');
    return { success: true, idempotent: false, data: { id, saleId }, status: 'completed', version: Number(o.version) + 1 };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CATALOG — menu + categories, ETag-cached for the offline-first client.
// ════════════════════════════════════════════════════════════════════════════
router.get('/catalog', POS, async (req, res) => {
  try {
    const [items] = await db.query("SELECT id, name, price, category, active, tax_category, stock FROM menu WHERE COALESCE(is_deleted,0)=0 ORDER BY category, name");
    let vatRate = 15;
    try {
      const [vr] = await db.query("SELECT `value` FROM settings WHERE `key`='VATRate' LIMIT 1");
      if (vr.length) vatRate = Number(vr[0].value) || 15;
    } catch (_) { /* settings table variants */ }

    // Phase U — attach the sellable units (base + majors like carton) per catalog
    // item, keyed by the catalog id (= the stock item id for imported goods), plus
    // the per-unit barcode (item_units.barcode_id → item_barcodes.code) and the
    // primary barcode. Resolved offline so the cashier can scan a carton barcode
    // with no round-trip. Fails soft: a missing units/barcode row → base-only item.
    const ids = items.map((m) => String(m.id));
    const unitsByItem = {}; const primaryBc = {};
    if (ids.length) {
      try {
        const [us] = await db.query(
          'SELECT iu.item_id, iu.id AS unit_id, iu.unit_code, iu.unit_name, iu.is_base, iu.conversion_to_base, ib.code AS barcode ' +
          'FROM item_units iu LEFT JOIN item_barcodes ib ON ib.id=iu.barcode_id ' +
          'WHERE iu.item_id IN (?) AND iu.is_active=1 AND iu.allow_sale=1 ORDER BY iu.is_base DESC, iu.conversion_to_base ASC', [ids]);
        for (const u of us) {
          (unitsByItem[u.item_id] = unitsByItem[u.item_id] || []).push({
            unitId: u.unit_id, unitCode: u.unit_code, unitName: u.unit_name,
            isBase: u.is_base === 1 || u.is_base === true, factor: Number(u.conversion_to_base), barcode: u.barcode || null,
          });
        }
      } catch (_) { /* item_units not present → base-only */ }
      try {
        const [pb] = await db.query("SELECT item_id, code FROM item_barcodes WHERE item_id IN (?) AND is_primary=1", [ids]);
        for (const b of pb) primaryBc[b.item_id] = b.code;
      } catch (_) { /* item_barcodes not present */ }
    }

    const data = {
      items: items.map((m) => {
        const units = unitsByItem[m.id] || [];
        const base = units.find((u) => u.isBase);
        return {
          id: String(m.id), name: m.name, price: Number(m.price), category: m.category || 'عام',
          active: !(m.active === 0 || m.active === false),
          taxCategory: ['S', 'Z', 'E', 'O'].includes(m.tax_category) ? m.tax_category : 'S',
          basePrice: Number(m.price), warehouseQty: m.stock == null ? null : Number(m.stock),
          barcode: primaryBc[m.id] || null,
          baseUnitName: base ? base.unitName : null,
          units, // [] when no multi-unit config → cashier treats it as single-unit
        };
      }),
      categories: [...new Set(items.map((m) => m.category || 'عام'))],
      vatRate,
      maxCashierDiscountPct: MAX_CASHIER_DISC_PCT,
      serverTime: new Date().toISOString(),
    };
    const etag = '"' + crypto.createHash('sha1').update(JSON.stringify({ i: data.items, v: data.vatRate })).digest('hex') + '"';
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.json({ success: true, data });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// LIST + DETAIL (held-orders board, shift review)
// ════════════════════════════════════════════════════════════════════════════
router.get('/orders', POS, async (req, res) => {
  try {
    const where = []; const params = [];
    const status = String(req.query.status || '');
    if (M.STATUSES.includes(status)) { where.push('status=?'); params.push(status); }
    else { where.push("status IN ('open','held','submitted')"); }
    if (req.query.shiftId) { where.push('shift_id=?'); params.push(String(req.query.shiftId).slice(0, 40)); }
    // Cashiers see their own orders; supervisors see everything.
    if (!_userIsSuper(req.user)) { where.push('username=?'); params.push(_userName(req.user)); }
    const [rows] = await db.query('SELECT * FROM pos_orders WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT 200', params);
    const ids = rows.map((r) => r.id);
    let lines = [];
    if (ids.length) { const [lr] = await db.query('SELECT * FROM pos_order_lines WHERE order_id IN (?) ORDER BY sort, id', [ids]); lines = lr; }
    res.json({ success: true, data: rows.map((o) => _publicOrder(o, lines.filter((l) => l.order_id === o.id), [])) });
  } catch (e) { _catch(res, e); }
});

router.get('/orders/:id', POS, async (req, res) => {
  try {
    const o = await _loadOrder(req.params.id);
    if (!o) { const e = new Error('الطلب غير موجود'); e.status = 404; throw e; }
    if (!_userIsSuper(req.user) && o.username && o.username !== _userName(req.user)) return _fail(res, 'PERMISSION_DENIED', 'هذا الطلب يخص كاشيرًا آخر');
    res.json({ success: true, data: _publicOrder(o, await _loadLines(o.id), await _loadPayments(o.id)) });
  } catch (e) { _catch(res, e); }
});

// ── HTTP handlers → internal ops ─────────────────────────────────────────────
router.post('/orders', POS, async (req, res) => {
  try {
    const body = Object.assign({}, req.body);
    if (body.expectedVersion == null && req.get('If-Match')) body.expectedVersion = req.get('If-Match');
    const out = await doUpsert(req.user, body);
    res.status(out.created ? 201 : 200).json(out);
  } catch (e) { _catch(res, e); }
});
for (const action of ['hold', 'resume', 'reopen', 'void']) {
  router.post(`/orders/:id/${action}`, POS, async (req, res) => {
    try { res.json(await doTransition(req.user, req.params.id, action, req.body)); }
    catch (e) { _catch(res, e); }
  });
}
router.post('/orders/:id/submit', POS, async (req, res) => {
  let idemId = null;
  try {
    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'pos:submit', req.params.id, key, _userName(req.user), req.body || {});
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب إرسال مكرر');
    if (idem.mode === 'proceed') idemId = idem.idemId;
    const out = await doSubmit(req.user, req.params.id, req.body);
    if (idemId) await IDEM.complete(db, idemId, 200, out);
    res.json(out);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(res, e);
  }
});
router.post('/orders/:id/complete', POS, async (req, res) => {
  try { res.json(await doComplete(req.user, req.params.id, req.body)); }
  catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// SYNC — batch replay of OFFLINE V2 ops. The financial checkout itself replays
// against legacy /api/sales directly from the client (clientOrderId dedupe) —
// sync never posts money. Per-op idempotency via idempotency_keys (opId).
// ════════════════════════════════════════════════════════════════════════════
const SYNC_OPS = new Set(['upsert', 'hold', 'resume', 'reopen', 'void', 'complete']);
router.post('/sync', POS, async (req, res) => {
  const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops : [];
  if (!ops.length) return _fail(res, 'VALIDATION_ERROR', 'ops مطلوبة');
  if (ops.length > 100) return _fail(res, 'VALIDATION_ERROR', 'حد المزامنة 100 عملية لكل دفعة');
  const results = [];
  for (const op of ops) {
    const opId = String(op.opId || '').slice(0, 80);
    const type = String(op.type || '');
    const orderId = String(op.orderId || (op.payload && op.payload.id) || '');
    try {
      if (!opId) throw _err('VALIDATION_ERROR', 'opId مطلوب');
      if (!SYNC_OPS.has(type)) throw _err('VALIDATION_ERROR', 'نوع عملية غير مدعوم في المزامنة: ' + type);
      const idem = await IDEM.begin(db, 'pos:sync:' + type, orderId, opId, _userName(req.user), op.payload || {});
      if (idem.mode === 'replay') { results.push({ opId, ok: true, replay: true, result: idem.body }); continue; }
      if (idem.mode === 'conflict') { results.push({ opId, ok: false, code: 'IDEMPOTENCY_CONFLICT', error: 'عملية قيد التنفيذ أو بمحتوى مختلف' }); continue; }
      let result;
      const payload = Object.assign({}, op.payload, type === 'upsert' ? { origin: 'offline' } : null);
      if (type === 'upsert') result = await doUpsert(req.user, payload);
      else if (type === 'complete') result = await doComplete(req.user, orderId, payload);
      else result = await doTransition(req.user, orderId, type, payload);
      if (idem.mode === 'proceed') await IDEM.complete(db, idem.idemId, 200, result);
      results.push({ opId, ok: result.success !== false, result });
    } catch (e) {
      results.push({ opId, ok: false, code: e.code || 'SERVER_ERROR', error: e.message });
    }
  }
  res.json({ success: results.every((r) => r.ok), results });
});

// ════════════════════════════════════════════════════════════════════════════
// SHIFT SUMMARY — V2 orders per shift (held board + completion reconciliation)
// ════════════════════════════════════════════════════════════════════════════
router.get('/shift-summary/:shiftId', POS, async (req, res) => {
  try {
    const shiftId = String(req.params.shiftId || '').slice(0, 40);
    const [agg] = await db.query(
      'SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM pos_orders WHERE shift_id=? GROUP BY status', [shiftId]);
    const [pay] = await db.query(
      "SELECT p.method, COALESCE(SUM(p.amount),0) AS amount FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.shift_id=? AND o.status='completed' GROUP BY p.method", [shiftId]);
    res.json({
      success: true,
      data: {
        byStatus: Object.fromEntries(agg.map((r) => [r.status, { count: Number(r.n), amount: Number(r.amount) }])),
        completedByMethod: Object.fromEntries(pay.map((r) => [r.method, Number(r.amount)])),
      },
    });
  } catch (e) { _catch(res, e); }
});

module.exports = router;
