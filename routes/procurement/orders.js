/**
 * routes/procurement/orders.js — Purchase Orders.
 * Create/edit draft, submit → approve (maker-checker) → send, cancel, close,
 * change-orders. Totals + UoM base quantities are computed on the server.
 * PO approval posts NO stock and NO GL (that is receipt/invoice work).
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const { err } = require('../../lib/procurement/errors');
const calc = require('../../lib/procurement/calculations');
const cfg = require('../../lib/procurement/config');
const { nextNumber } = require('../../lib/procurement/numbering');
const { runTransition } = require('../../services/procurement/TransitionExecutor');
const events = require('../../lib/procurement/events');

const SORTABLE = { poDate: 'po.po_date', createdAt: 'po.created_at', total: 'po.total_after_vat', status: 'po.status', number: 'po.po_number' };
const LIST_STATUSES = ['draft', 'submitted', 'approved', 'sent', 'partially_received', 'received', 'fully_received', 'closed', 'cancelled'];

function genId() { return 'PO-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function lineId() { return 'POL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

async function _assertSupplierActive(conn, supplierId) {
  const [s] = await conn.query('SELECT id, name, is_active FROM suppliers WHERE id = ? LIMIT 1', [supplierId]);
  if (!s.length) throw err('VALIDATION_ERROR', 'المورد غير موجود');
  if (!Number(s[0].is_active)) throw err('SUPPLIER_INACTIVE', 'المورد غير نشط ولا يقبل أوامر جديدة');
  return s[0];
}

function _computeLines(rawLines, standardRate) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw err('VALIDATION_ERROR', 'أمر الشراء يتطلب سطرًا واحدًا على الأقل');
  return rawLines.map((l) => {
    const factor = Number(l.factor != null ? l.factor : l.conversionFactor) || 1;
    const c = calc.computeLine({
      enteredQty: l.enteredQty != null ? l.enteredQty : l.qty,
      factor,
      unitPriceEntered: l.unitPriceEntered != null ? l.unitPriceEntered : l.unitPrice,
      discount: l.discount,
      vatRate: l.vatRate,
      taxCode: l.taxCode,
      inclusiveTax: l.inclusiveTax,
    }, standardRate);
    return Object.assign(c, {
      itemId: l.itemId || l.item_id,
      itemName: l.itemName || l.item_name || '',
      enteredUnitId: l.enteredUnitId || l.unitId || null,
      enteredUnitCode: l.enteredUnitCode || l.unit || null,
    });
  });
}

// ── POST / — create draft ────────────────────────────────────────────────────
router.post('/', requireCapability('purchase_orders.create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.supplierId) throw err('VALIDATION_ERROR', 'المورد مطلوب');
    const standardRate = await cfg.standardVatRate(db);
    const lines = _computeLines(b.lines || b.items, standardRate);
    const totals = calc.computeTotals(lines);
    const actor = H.actorOf(req);

    const out = await db.withTransaction(async (conn) => {
      const supplier = await _assertSupplierActive(conn, b.supplierId);
      const id = genId();
      const number = await nextNumber(conn, 'po');
      await conn.query(
        `INSERT INTO purchase_orders
          (id, po_number, supplier_id, supplier_name, supplier_name_snapshot, po_date, expected_date, expected_date_snapshot,
           warehouse_id, brand_id, branch_id, cost_center_id, currency, status, version,
           total_before_vat, discount_amount, vat_amount, total_after_vat, notes, created_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?,?,?,?,?,?)`,
        [id, number, b.supplierId, supplier.name, supplier.name,
         b.orderDate || new Date().toISOString().slice(0, 10), b.expectedDate || null, b.expectedDate || null,
         b.warehouseId || null, b.brandId || null, b.branchId || null, b.costCenterId || null, b.currency || 'SAR',
         totals.subtotal, totals.discountAmount, totals.vatAmount, totals.total, b.notes || null, actor, H.idemOf(req)]);
      for (const l of lines) {
        await conn.query(
          `INSERT INTO po_lines
            (id, po_id, item_id, item_name, qty, unit_price, vat_rate, vat_amount, total, received_qty,
             unit, unit_type, conv_rate, entered_qty, entered_unit_id, entered_unit_code, conversion_factor_snapshot,
             base_qty, base_received_qty, unit_price_entered, base_unit_price, tax_code, inclusive_tax, discount, line_status)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'open')`,
          [lineId(), id, l.itemId, l.itemName, l.enteredQty, l.unitPriceEntered, l.vatRate, l.vatAmount, l.lineTotal,
           l.enteredUnitCode || '', 'entered', l.factor, l.enteredQty, l.enteredUnitId, l.enteredUnitCode, l.factor,
           l.baseQty, l.unitPriceEntered, l.baseUnitPrice, l.taxCode, l.inclusiveTax ? 1 : 0, l.discount]);
      }
      await events.recordEvent(conn, { documentType: 'po', documentId: id, action: 'create', toStatus: 'draft', actor });
      return { id, number };
    });

    return H.sendOk(res, { data: { id: out.id }, documentNumber: out.number, status: 'draft', version: 1 }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET / — list (no N+1: header only; lines fetched on detail) ──────────────
router.get('/', requireCapability('procurement.view'), async (req, res) => {
  try {
    const p = H.listParams(req, Object.keys(SORTABLE), LIST_STATUSES);
    const where = [], params = [];
    if (p.status) { where.push('po.status = ?'); params.push(p.status); }
    if (p.supplierId) { where.push('po.supplier_id = ?'); params.push(p.supplierId); }
    if (p.q) { where.push('(po.po_number LIKE ? OR po.supplier_name LIKE ?)'); params.push('%' + p.q + '%', '%' + p.q + '%'); }
    if (p.dateFrom) { where.push('po.po_date >= ?'); params.push(p.dateFrom); }
    if (p.dateTo) { where.push('po.po_date <= ?'); params.push(p.dateTo); }
    const sc = H.scopeClause(req, 'po.warehouse_id');
    if (sc.sql) { where.push(sc.sql.replace(/^\s*AND\s*/i, '')); params.push(...sc.params); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = H.orderBy(p.sort, p.dir, SORTABLE, 'po.created_at');

    const [rows] = await db.query(
      `SELECT po.id, po.po_number, po.supplier_id, po.supplier_name, po.po_date, po.expected_date,
              po.status, po.version, po.total_after_vat, po.currency, po.created_at
         FROM purchase_orders po ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM purchase_orders po ${whereSql}`, params);
    const [tot] = await db.query(`SELECT COALESCE(SUM(po.total_after_vat),0) AS total FROM purchase_orders po ${whereSql}`, params);
    return H.sendData(res, rows, {
      pagination: { page: p.page, pageSize: p.pageSize, total: Number(cnt[0].total), totalPages: Math.ceil(cnt[0].total / p.pageSize) },
      totals: { value: calc.money(tot[0].total) },
    });
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET /:id — header + lines + receipts progress ────────────────────────────
router.get('/:id', requireCapability('procurement.view'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!rows.length) throw err('NOT_FOUND', 'أمر الشراء غير موجود');
    const [lines] = await db.query('SELECT * FROM po_lines WHERE po_id = ? ORDER BY id', [req.params.id]);
    const [receipts] = await db.query('SELECT id, receipt_number, status, receipt_date, total FROM purchase_receipts WHERE po_id = ? ORDER BY receipt_date', [req.params.id]);
    const [invoices] = await db.query('SELECT id, code, invoice_no, status, total_amount FROM supplier_invoices WHERE purchase_order_id = ?', [req.params.id]);
    return H.sendData(res, Object.assign({}, rows[0], { lines, receipts, invoices }));
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET /:id/timeline ────────────────────────────────────────────────────────
router.get('/:id/timeline', requireCapability('procurement.view'), async (req, res) => {
  try {
    const tl = await events.timeline(db, 'po', req.params.id);
    return H.sendData(res, tl);
  } catch (e) { return H.sendErr(res, e); }
});

// ── PATCH /:id — edit draft only ─────────────────────────────────────────────
router.patch('/:id', requireCapability('purchase_orders.edit_draft'), async (req, res) => {
  try {
    const b = req.body || {};
    const standardRate = await cfg.standardVatRate(db);
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'أمر الشراء غير موجود');
      if (rows[0].status !== 'draft') throw err('INVALID_STATE_TRANSITION', 'لا يمكن تعديل أمر شراء غير مسودة — استخدم أمر تغيير');
      if (b.lines || b.items) {
        const lines = _computeLines(b.lines || b.items, standardRate);
        const totals = calc.computeTotals(lines);
        await conn.query('DELETE FROM po_lines WHERE po_id = ?', [req.params.id]);
        for (const l of lines) {
          await conn.query(
            `INSERT INTO po_lines (id, po_id, item_id, item_name, qty, unit_price, vat_rate, vat_amount, total, received_qty,
               unit, unit_type, conv_rate, entered_qty, entered_unit_id, entered_unit_code, conversion_factor_snapshot,
               base_qty, base_received_qty, unit_price_entered, base_unit_price, tax_code, inclusive_tax, discount, line_status)
             VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'open')`,
            [lineId(), req.params.id, l.itemId, l.itemName, l.enteredQty, l.unitPriceEntered, l.vatRate, l.vatAmount, l.lineTotal,
             l.enteredUnitCode || '', 'entered', l.factor, l.enteredQty, l.enteredUnitId, l.enteredUnitCode, l.factor,
             l.baseQty, l.unitPriceEntered, l.baseUnitPrice, l.taxCode, l.inclusiveTax ? 1 : 0, l.discount]);
        }
        await conn.query('UPDATE purchase_orders SET total_before_vat=?, discount_amount=?, vat_amount=?, total_after_vat=?, version=version+1 WHERE id=?',
          [totals.subtotal, totals.discountAmount, totals.vatAmount, totals.total, req.params.id]);
      }
      const headSets = [], headParams = [];
      for (const [k, col] of [['notes', 'notes'], ['expectedDate', 'expected_date'], ['warehouseId', 'warehouse_id']]) {
        if (Object.prototype.hasOwnProperty.call(b, k)) { headSets.push(`${col} = ?`); headParams.push(b[k]); }
      }
      if (headSets.length) { headParams.push(req.params.id); await conn.query(`UPDATE purchase_orders SET ${headSets.join(', ')} WHERE id = ?`, headParams); }
      const [out2] = await conn.query('SELECT version FROM purchase_orders WHERE id = ?', [req.params.id]);
      return { version: out2[0].version };
    });
    return H.sendOk(res, { data: { id: req.params.id }, status: 'draft', version: out.version });
  } catch (e) { return H.sendErr(res, e); }
});

// ── generic transition endpoint factory ──────────────────────────────────────
function transition(action, capability, opts = {}) {
  return [requireCapability(capability), async (req, res) => {
    try {
      const r = await runTransition({
        docType: 'po', table: 'purchase_orders', id: req.params.id, action,
        actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
        actorColumns: opts.actorColumns,
        perform: async (conn, row) => {
          if (opts.check) await opts.check(conn, row, req);
          return opts.perform ? opts.perform(conn, row, req) : {};
        },
      });
      return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.po_number, status: r.toStatus, version: r.newVersion });
    } catch (e) { return H.sendErr(res, e); }
  }];
}

router.post('/:id/submit', ...transition('submit', 'purchase_orders.submit', { actorColumns: { by: 'submitted_by', at: 'submitted_at' } }));

/**
 * فصل المهام عند الاعتماد — السياسة يتحكم بها المالك من «الإدارة › الأمان»
 * (settings.ProcurementSelfApprovalPolicy عبر PUT /api/security-policies).
 * الفرض هنا في الخادم داخل معاملة الاعتماد نفسها بعد قفل الصف، فلا يمكن
 * تجاوزه بإرسال الطلب مباشرة من أي عميل.
 *
 * القاعدة: يُمنع الاعتماد إذا كان المعتمِد ضمن «سلسلة إنشاء» الأمر
 * (created_by أو submitted_by) وكان الإجمالي شامل الضريبة ≥ الحد المضبوط.
 * لا استثناء لمدير النظام: المالك نفسه هو من يريد ضبط هذه القاعدة، فاستثناؤه
 * يُفرغها من معناها (يختلف هنا عن قيود اليومية في lib/glTransitions.js).
 *
 * الغموض يُغلق لا يُفتح: أمر شراء بلا مُنشئ معروف لا يُعتمد ما دامت السياسة
 * مُفعّلة — الفتح الصامت هو ما كان يسمح باعتماد ذاتي غير مرئي.
 */
async function _assertSelfApprovalAllowed(conn, row, req) {
  const policy = await cfg.selfApprovalPolicy(conn);
  if (!policy.enabled) return; // المالك سمح بالاعتماد الذاتي صراحةً
  const amount = Number(row.total_after_vat) || 0;
  if (amount < policy.thresholdAmount) return; // دون حد فصل المهام
  const actor = H.actorOf(req);
  const makers = [row.created_by, row.submitted_by].map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
  if (!makers.length) {
    throw err('PERMISSION_DENIED', 'لا يمكن اعتماد أمر شراء مجهول المُنشئ ما دام فصل المهام مُفعّلًا — أعد إنشاء الأمر أو عطّل السياسة من الإدارة › الأمان');
  }
  // makers خالية من الفراغات، فالمعتمِد المجهول لا يطابق أحدًا منها
  if (makers.includes(actor)) {
    throw err('PERMISSION_DENIED', 'لا يمكن للمُنشئ اعتماد أمر الشراء الخاص به (فصل المهام)');
  }
}

router.post('/:id/approve', ...transition('approve', 'purchase_orders.approve', {
  actorColumns: { by: 'approved_by', at: 'approved_at' },
  check: _assertSelfApprovalAllowed,
}));

router.post('/:id/send', ...transition('send', 'purchase_orders.approve', { actorColumns: { by: 'sent_by', at: 'sent_at' } }));

router.post('/:id/cancel', ...transition('cancel', 'purchase_orders.cancel', {
  actorColumns: { by: 'cancelled_by', at: 'cancelled_at' },
  perform: async (conn, row, req) => ({ extraSets: { cancel_reason: (req.body && req.body.reason) || null } }),
}));

router.post('/:id/close', ...transition('close', 'purchase_orders.close', {
  actorColumns: { by: 'closed_by', at: 'closed_at' },
  check: async (conn, row) => {
    // block close if any line has unreceived qty and there are open invoices? Block on unreceived qty.
    const [open] = await conn.query('SELECT COUNT(*) AS c FROM po_lines WHERE po_id = ? AND base_received_qty < base_qty', [row.id]);
    if (Number(open[0].c) > 0 && !process.env.PROCUREMENT_ALLOW_SHORT_CLOSE) {
      throw err('DOCUMENT_HAS_HISTORY', 'لا يمكن الإغلاق: توجد كميات لم تُستلم بعد');
    }
  },
}));

// ── POST /:id/change-orders — bump change_order_seq (revise an approved PO) ───
router.post('/:id/change-orders', requireCapability('purchase_orders.edit_draft'), async (req, res) => {
  try {
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'أمر الشراء غير موجود');
      if (!['approved', 'sent', 'partially_received'].includes(rows[0].status)) {
        throw err('INVALID_STATE_TRANSITION', 'أمر التغيير متاح فقط لأمر شراء معتمد');
      }
      await conn.query('UPDATE purchase_orders SET change_order_seq = change_order_seq + 1, version = version + 1 WHERE id = ?', [req.params.id]);
      await events.recordEvent(conn, { documentType: 'po', documentId: req.params.id, action: 'change_order', fromStatus: rows[0].status, toStatus: rows[0].status, actor: H.actorOf(req), payload: { reason: (req.body && req.body.reason) || null } });
      const [o] = await conn.query('SELECT version, change_order_seq FROM purchase_orders WHERE id = ?', [req.params.id]);
      return o[0];
    });
    return H.sendOk(res, { data: { id: req.params.id, changeOrderSeq: out.change_order_seq }, version: out.version });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
