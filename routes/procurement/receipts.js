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
router.post('/', requireCapability('receipts.create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.warehouseId) throw err('VALIDATION_ERROR', 'المستودع مطلوب');
    if (typeof req.guardWh === 'function' && !req.guardWh(res, b.warehouseId)) return;
    const rawLines = b.lines || b.items;
    if (!Array.isArray(rawLines) || !rawLines.length) throw err('VALIDATION_ERROR', 'الاستلام يتطلب سطرًا واحدًا على الأقل');
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
          warehouse_id: l.warehouseId || b.warehouseId, lot_no: l.lotNo || l.lot_no || null, expiry_date: l.expiryDate || l.expiry_date || null,
        });
      }
      subtotal = calc.money(subtotal);
      await conn.query(
        `INSERT INTO purchase_receipts
          (id, po_id, supplier_id, supplier_name_snapshot, receipt_number, receipt_date, warehouse_id, brand_id, branch_id, cost_center_id,
           subtotal, vat_amount, total, status, version, created_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?)`,
        [id, b.poId || null, b.supplierId || null, supplier ? supplier.name : null, number,
         b.receiptDate || new Date().toISOString().slice(0, 10), b.warehouseId, b.brandId || null, b.branchId || null, b.costCenterId || null,
         subtotal, vatTotal, calc.money(subtotal + vatTotal), actor, H.idemOf(req)]);
      for (const l of linesToInsert) {
        await conn.query(
          `INSERT INTO purchase_receipt_lines
            (id, receipt_id, po_line_id, item_id, quantity, unit, unit_cost, line_total,
             entered_qty, entered_unit_code, conversion_factor_snapshot, base_qty, base_unit_cost, warehouse_id, lot_no, expiry_date)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [l.id, id, l.po_line_id, l.item_id, l.quantity, l.unit, l.unit_cost, l.line_total,
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
          journalId = await posting.postReversal(conn, { originalJournalId: row.gl_journal_id, referenceType: 'GoodsReceipt', referenceId: row.id, actor, dateYMD: new Date().toISOString().slice(0, 10) });
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
