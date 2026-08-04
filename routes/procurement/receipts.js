/**
 * routes/procurement/receipts.js — Goods Receipts (GRN), the ONLY procurement
 * stock-writing path. Lifecycle draft → approved → posted → reversed / cancelled.
 * Post = applyReceiptStock (single writer) + GRNI journal (Dr Inventory/Cr GRNI)
 * + PO progress rollup, all in one transaction.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const acctDate = require('../../lib/accountingDate');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const { err } = require('../../lib/procurement/errors');
const calc = require('../../lib/procurement/calculations');
const { nextNumber } = require('../../lib/procurement/numbering');
const { runTransition } = require('../../services/procurement/TransitionExecutor');
const inv = require('../../services/procurement/InventoryPostingService');
const posting = require('../../lib/procurement/posting');
const events = require('../../lib/procurement/events');

const SORTABLE = { receiptDate: 'pr.receipt_date', createdAt: 'pr.created_at', total: 'pr.total', status: 'pr.status', number: 'pr.receipt_number' };
const LIST_STATUSES = ['draft', 'approved', 'posted', 'reversed', 'cancelled'];

function genId() { return 'GRN-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function lineId() { return 'GRL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

// ── POST / — create draft receipt (from a PO or direct) ──────────────────────
/**
 * المستودع المستلِم: القيمة الصريحة تفوز دائمًا، وإلا يُورَّث من أمر الشراء
 * المستلَم عليه (`purchase_orders.warehouse_id`) — فأمر الشراء يحمله أصلًا،
 * وطلبه من جديد كان يرفض كل استلام صادر من الواجهة بـ 422.
 *
 * Returns the id, or null when neither source supplies one. This resolves the
 * value ONLY; the caller still runs req.guardWh on the result — an inherited
 * warehouse must never be a way past the scope check.
 */
async function resolveWarehouseId(body) {
  const explicit = body.warehouseId == null ? '' : String(body.warehouseId).trim();
  if (explicit) return explicit;
  const poId = body.poId == null ? '' : String(body.poId).trim();
  if (!poId) return null;
  const [po] = await db.query('SELECT warehouse_id FROM purchase_orders WHERE id = ?', [poId]);
  const inherited = po.length && po[0].warehouse_id != null ? String(po[0].warehouse_id).trim() : '';
  return inherited || null;
}

// أوامر الشراء التي يجوز الاستلام عليها.
//
// كان الإنشاء لا يفحص حالة أمر الشراء إطلاقًا. المرصود حيًّا: أمر عالق على
// 'submitted' — رُفضت موافقته بحارس الموافقة الذاتية — قَبِل استلامًا، ورُحّل،
// ودحرج الأمر مباشرةً إلى 'fully_received'. أي أن بضاعة تُستلَم وتدخل المخزون
// على أمر لم يوافق عليه أحد، فيلتفّ الاستلام حول الموافقة كلها.
//
// الواجهة كانت تعرض «استلام» على هذه الحالات وحدها أصلًا؛ هذا يجعلها عقدًا
// على الخادم بدل أن تكون أدبًا في العميل.
// قائمة منع لا قائمة سماح، والفرق ليس أسلوبيًّا.
//
// أول صياغة كانت تسمح بـ approved/sent/partially_received وحدها، فاعترضت
// fully_received أيضًا — وطبعت عليه «يجب اعتماده أولًا» وهو أمر *معتمَد*
// ومستلَم بالكامل. جملة كاذبة تُعرض على المستخدم، وتحجب في الوقت نفسه رسالة
// OVER_RECEIPT الأدقّ التي تذكر الكميات الفعلية.
//
// مهمّة هذا الحارس واحدة: منع الاستلام على أمر **لم يُعتمد** أو أُغلق. أما
// «طلبت أكثر من المتبقّي» فقاعدة كمّية يملكها فحص OVER_RECEIPT على صفّ
// po_lines المقفول — وهو الموضع الوحيد الخالي من السباق — فتُترك له.
const NEVER_APPROVED = Object.freeze(['draft', 'submitted', 'rejected']);
const TERMINATED = Object.freeze(['cancelled', 'canceled', 'closed']);

async function assertPoReceivable(poId) {
  if (!poId) return; // استلام مباشر بلا أمر شراء — مسار قائم ومشروع
  const [rows] = await db.query('SELECT status FROM purchase_orders WHERE id = ? LIMIT 1', [poId]);
  if (!rows.length) throw err('NOT_FOUND', 'أمر الشراء غير موجود');
  const status = String(rows[0].status || '').toLowerCase();
  if (NEVER_APPROVED.includes(status)) {
    throw err('VALIDATION_ERROR',
      `لا يمكن الاستلام على أمر شراء حالته «${status}» — يجب اعتماده أولًا`);
  }
  if (TERMINATED.includes(status)) {
    throw err('VALIDATION_ERROR',
      `لا يمكن الاستلام على أمر شراء حالته «${status}»`);
  }
}

/**
 * يملأ اسم الصنف على سطور الاستلام، بالأولوية: سطر أمر الشراء (لقطة وقت
 * الشراء) ← سجلّ الأصناف ← الكود.
 *
 * سطر أمر الشراء يسبق سجلّ الأصناف عمدًا: إن أُعيدت تسمية صنف بين الشراء
 * والاستلام، فالمستند يجب أن يحمل الاسم الذي اشتُري به، لا اسم اليوم.
 */
async function _fillReceiptItemNames(conn, lines) {
  const poLineIds = [...new Set(lines.map((l) => l.po_line_id).filter(Boolean))];
  const fromPo = {};
  if (poLineIds.length) {
    try {
      const [rows] = await conn.query(
        `SELECT id, item_name FROM po_lines WHERE id IN (${poLineIds.map(() => '?').join(',')})`, poLineIds);
      for (const r of rows) if (r.item_name) fromPo[r.id] = String(r.item_name);
    } catch (_) {}
  }
  const need = lines.filter((l) => !fromPo[l.po_line_id]).map((l) => l.item_id).filter(Boolean);
  const fromMaster = {};
  if (need.length) {
    const ids = [...new Set(need)];
    try {
      const [rows] = await conn.query(
        `SELECT id, name FROM inv_items WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      for (const r of rows) if (r.name) fromMaster[r.id] = String(r.name);
    } catch (_) {}
  }
  for (const l of lines) {
    l.item_name = fromPo[l.po_line_id] || fromMaster[l.item_id] || l.item_name || String(l.item_id || '');
  }
  return lines;
}

router.post('/', requireCapability('receipts.create'), async (req, res) => {
  try {
    const b = req.body || {};
    await assertPoReceivable(b.poId == null ? '' : String(b.poId).trim());
    const warehouseId = await resolveWarehouseId(b);
    if (!warehouseId) throw err('VALIDATION_ERROR', 'المستودع مطلوب');
    // النطاق يسري على المستودع النهائي أيًّا كان مصدره — الصريح أو الموروث.
    if (typeof req.guardWh === 'function' && !req.guardWh(res, warehouseId)) return;
    const rawLines = b.lines || b.items;
    if (!Array.isArray(rawLines) || !rawLines.length) throw err('VALIDATION_ERROR', 'الاستلام يتطلب سطرًا واحدًا على الأقل');
    // A per-line warehouse overrides the header one all the way into
    // applyReceiptStock (`ln.warehouse_id || grn.warehouse_id`), so it has to
    // clear the same guard — otherwise the header check is decorative.
    if (typeof req.guardWh === 'function') {
      for (const l of rawLines) {
        const lw = l && l.warehouseId != null ? String(l.warehouseId).trim() : '';
        if (lw && lw !== warehouseId && !req.guardWh(res, lw)) return;
      }
    }
    const actor = H.actorOf(req);

    const out = await db.withTransaction(async (conn) => {
      let supplier = null;
      if (b.supplierId) {
        const [s] = await conn.query('SELECT id, name FROM suppliers WHERE id = ?', [b.supplierId]);
        supplier = s[0] || null;
      }
      const id = genId();
      const number = await nextNumber(conn, 'grn');
      let subtotal = 0, vatTotal = 0;
      const linesToInsert = [];
      for (const l of rawLines) {
        const factor = Number(l.factor != null ? l.factor : l.conversionFactor) || 1;
        const enteredQty = Number(l.enteredQty != null ? l.enteredQty : l.quantity);
        if (!(enteredQty > 0)) throw err('VALIDATION_ERROR', 'كمية الاستلام يجب أن تكون موجبة');
        const unitCost = Number(l.unitCost != null ? l.unitCost : l.unit_cost) || 0;
        const baseQty = calc.toBaseQty(enteredQty, factor);
        const baseUnitCost = calc.toBaseUnitPrice(unitCost, factor);
        const net = calc.money(enteredQty * unitCost);
        subtotal += net;
        linesToInsert.push({
          id: lineId(), item_id: l.itemId || l.item_id, item_name: l.itemName || l.item_name || '',
          po_line_id: l.poLineId || l.po_line_id || null, quantity: baseQty, unit: l.enteredUnitCode || l.unit || 'PCS',
          unit_cost: baseUnitCost, entered_qty: enteredQty, entered_unit_code: l.enteredUnitCode || l.unit || null,
          conversion_factor_snapshot: factor, base_qty: baseQty, base_unit_cost: baseUnitCost, line_total: net,
          warehouse_id: l.warehouseId || warehouseId, lot_no: l.lotNo || l.lot_no || null, expiry_date: l.expiryDate || l.expiry_date || null,
        });
      }
      // اسم الصنف يُقرأ من الخادم لا يُستقبل من العميل — سطر أمر الشراء أولًا
      // (فهو لقطة وقت الشراء)، ثم سجلّ الأصناف، والكود آخر ملاذ. بدون هذا كانت
      // شاشة الاستلام لا تملك إلا الكود.
      await _fillReceiptItemNames(conn, linesToInsert);
      subtotal = calc.money(subtotal);
      await conn.query(
        `INSERT INTO purchase_receipts
          (id, po_id, supplier_id, supplier_name_snapshot, receipt_number, receipt_date, warehouse_id, brand_id, branch_id, cost_center_id,
           subtotal, vat_amount, total, status, version, created_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?)`,
        [id, b.poId || null, b.supplierId || null, supplier ? supplier.name : null, number,
         b.receiptDate || new Date().toISOString().slice(0, 10), warehouseId, b.brandId || null, b.branchId || null, b.costCenterId || null,
         subtotal, vatTotal, calc.money(subtotal + vatTotal), actor, H.idemOf(req)]);
      for (const l of linesToInsert) {
        await conn.query(
          `INSERT INTO purchase_receipt_lines
            (id, receipt_id, po_line_id, item_id, item_name, quantity, unit, unit_cost, line_total,
             entered_qty, entered_unit_code, conversion_factor_snapshot, base_qty, base_unit_cost, warehouse_id, lot_no, expiry_date)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [l.id, id, l.po_line_id, l.item_id, l.item_name || null, l.quantity, l.unit, l.unit_cost, l.line_total,
           l.entered_qty, l.entered_unit_code, l.conversion_factor_snapshot, l.base_qty, l.base_unit_cost, l.warehouse_id, l.lot_no, l.expiry_date]);
      }
      await events.recordEvent(conn, { documentType: 'grn', documentId: id, action: 'create', toStatus: 'draft', actor });
      return { id, number };
    });
    return H.sendOk(res, { data: { id: out.id }, documentNumber: out.number, status: 'draft', version: 1 }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET / list ───────────────────────────────────────────────────────────────
router.get('/', requireCapability('procurement.view'), async (req, res) => {
  try {
    const p = H.listParams(req, Object.keys(SORTABLE), LIST_STATUSES);
    const where = [], params = [];
    if (p.status) { where.push('pr.status = ?'); params.push(p.status); }
    if (p.supplierId) { where.push('pr.supplier_id = ?'); params.push(p.supplierId); }
    if (req.query.poId) { where.push('pr.po_id = ?'); params.push(String(req.query.poId)); }
    if (p.q) { where.push('pr.receipt_number LIKE ?'); params.push('%' + p.q + '%'); }
    if (p.dateFrom) { where.push('pr.receipt_date >= ?'); params.push(p.dateFrom); }
    if (p.dateTo) { where.push('pr.receipt_date <= ?'); params.push(p.dateTo); }
    const sc = H.scopeClause(req, 'pr.warehouse_id');
    if (sc.sql) { where.push(sc.sql.replace(/^\s*AND\s*/i, '')); params.push(...sc.params); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = H.orderBy(p.sort, p.dir, SORTABLE, 'pr.receipt_date');
    const [rows] = await db.query(
      `SELECT pr.id, pr.receipt_number, pr.po_id, pr.supplier_id, pr.supplier_name_snapshot, pr.receipt_date,
              pr.warehouse_id, pr.status, pr.version, pr.total, pr.gl_journal_id
         FROM purchase_receipts pr ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM purchase_receipts pr ${whereSql}`, params);
    return H.sendData(res, rows, { pagination: { page: p.page, pageSize: p.pageSize, total: Number(cnt[0].total), totalPages: Math.ceil(cnt[0].total / p.pageSize) } });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('procurement.view'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM purchase_receipts WHERE id = ?', [req.params.id]);
    if (!rows.length) throw err('NOT_FOUND', 'الاستلام غير موجود');
    const [lines] = await db.query('SELECT * FROM purchase_receipt_lines WHERE receipt_id = ? ORDER BY id', [req.params.id]);
    return H.sendData(res, Object.assign({}, rows[0], { lines }));
  } catch (e) { return H.sendErr(res, e); }
});

// ── approve (draft → approved) ───────────────────────────────────────────────
router.post('/:id/approve', requireCapability('receipts.approve'), async (req, res) => {
  try {
    const r = await runTransition({
      docType: 'grn', table: 'purchase_receipts', id: req.params.id, action: 'approve',
      actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'approved_by', at: 'approved_at' },
      perform: async () => ({}),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.receipt_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

// ── post (approved → posted): stock + GRNI GL + PO rollup ────────────────────
async function _rollupPO(conn, poId, actor) {
  if (!poId) return;
  const [openCnt] = await conn.query('SELECT COUNT(*) AS c FROM po_lines WHERE po_id = ? AND base_received_qty < base_qty', [poId]);
  const [anyCnt] = await conn.query('SELECT COUNT(*) AS c FROM po_lines WHERE po_id = ? AND base_received_qty > 0', [poId]);
  let newStatus = null;
  if (Number(openCnt[0].c) === 0) newStatus = 'fully_received';
  else if (Number(anyCnt[0].c) > 0) newStatus = 'partially_received';
  if (newStatus) {
    const [po] = await conn.query('SELECT status FROM purchase_orders WHERE id = ? FOR UPDATE', [poId]);
    if (po.length && !['closed', 'cancelled'].includes(po[0].status) && po[0].status !== newStatus) {
      await conn.query('UPDATE purchase_orders SET status = ?, version = version + 1 WHERE id = ?', [newStatus, poId]);
      await events.recordEvent(conn, { documentType: 'po', documentId: poId, action: 'receive', fromStatus: po[0].status, toStatus: newStatus, actor });
    }
  }
}

router.post('/:id/post', requireCapability('receipts.post'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const r = await runTransition({
      docType: 'grn', table: 'purchase_receipts', id: req.params.id, action: 'post',
      actor, expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'posted_by', at: 'posted_at' },
      perform: async (conn, row) => {
        const [lines] = await conn.query('SELECT * FROM purchase_receipt_lines WHERE receipt_id = ?', [req.params.id]);
        if (!lines.length) throw err('VALIDATION_ERROR', 'لا توجد سطور للاستلام');
        const stock = await inv.applyReceiptStock(conn, { grn: Object.assign({}, row, { posted_by: actor }), lines, actor });
        const journalId = await posting.postReceipt(conn, { grn: Object.assign({}, row, { posted_by: actor }), net: stock.netValue, warehouseId: row.warehouse_id });
        await _rollupPO(conn, row.po_id, actor);
        return {
          extraSets: { gl_journal_id: journalId, subtotal: stock.netValue, total: stock.netValue },
          journalIds: [journalId], affectedStock: stock.affectedStock, affectedValue: stock.netValue,
          payload: { movementIds: stock.movementIds, lotIds: stock.lotIds },
        };
      },
    });
    return H.sendOk(res, {
      data: { id: req.params.id }, documentNumber: r.row.receipt_number, status: r.toStatus, version: r.newVersion,
      journalIds: r.result.journalIds, affectedStock: r.result.affectedStock, affectedValue: r.result.affectedValue,
    });
  } catch (e) { return H.sendErr(res, e); }
});

// ── reverse (posted → reversed): exact-lot reversal + reversing journal ──────
router.post('/:id/reverse', requireCapability('receipts.reverse'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const r = await runTransition({
      docType: 'grn', table: 'purchase_receipts', id: req.params.id, action: 'reverse',
      actor, expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'reversed_by', at: 'reversed_at' },
      perform: async (conn, row) => {
        // block reverse if any line has been invoiced
        const [inv2] = await conn.query('SELECT COALESCE(SUM(base_invoiced_qty),0) AS q FROM purchase_receipt_lines WHERE receipt_id = ?', [req.params.id]);
        if (Number(inv2[0].q) > 0) throw err('DOCUMENT_HAS_HISTORY', 'تعذّر العكس: الاستلام مرتبط بفاتورة');
        const [lines] = await conn.query('SELECT * FROM purchase_receipt_lines WHERE receipt_id = ?', [req.params.id]);
        const stock = await inv.reverseReceiptStock(conn, { grn: row, lines, actor });
        let journalId = null;
        if (row.gl_journal_id) {
          journalId = await posting.postReversal(conn, { originalJournalId: row.gl_journal_id, referenceType: 'GoodsReceipt', referenceId: row.id, actor, dateYMD: acctDate.journalDate() });
        }
        return { journalIds: journalId ? [journalId] : [], affectedStock: stock.affectedStock, affectedValue: -stock.netValue };
      },
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.receipt_number, status: r.toStatus, version: r.newVersion, journalIds: r.result.journalIds, affectedStock: r.result.affectedStock });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/cancel', requireCapability('receipts.approve'), async (req, res) => {
  try {
    const r = await runTransition({
      docType: 'grn', table: 'purchase_receipts', id: req.params.id, action: 'cancel',
      actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'cancelled_by', at: 'cancelled_at' },
      perform: async () => ({}),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.receipt_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});


router.get('/:id/timeline', requireCapability('procurement.view'), async (req, res) => {
  try { return H.sendData(res, await events.timeline(db, 'grn', req.params.id)); }
  catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
