/**
 * routes/procurement/returns.js — Purchase Returns (debit memo / credit note).
 * draft → approved → posted → settled. Post removes stock from the exact lots
 * and posts the phase-appropriate journal (before invoice: Dr GRNI/Cr Inventory;
 * after invoice: Dr AP/Cr Inventory+Input VAT).
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
const inv = require('../../services/procurement/InventoryPostingService');
const posting = require('../../lib/procurement/posting');
const events = require('../../lib/procurement/events');

const SORTABLE = { returnDate: 'r.return_date', createdAt: 'r.created_at', total: 'r.total', status: 'r.status', number: 'r.return_number' };
const LIST_STATUSES = ['draft', 'approved', 'posted', 'settled', 'cancelled'];

function genId() { return 'PRET-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function lineId() { return 'PRL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

router.post('/', requireCapability('purchase_returns.create'), async (req, res) => {
  try {
    const b = req.body || {};
    const phase = b.phase === 'after_invoice' ? 'after_invoice' : 'before_invoice';
    const rawLines = b.lines || b.items || [];
    if (!rawLines.length) throw err('VALIDATION_ERROR', 'المرتجع يتطلب سطرًا واحدًا على الأقل');
    const standardRate = await cfg.standardVatRate(db);
    const actor = H.actorOf(req);
    const out = await db.withTransaction(async (conn) => {
      let supplier = null;
      if (b.supplierId) { const [s] = await conn.query('SELECT id, name FROM suppliers WHERE id = ?', [b.supplierId]); supplier = s[0] || null; }
      const id = genId();
      const number = await nextNumber(conn, 'return');
      let subtotal = 0, vatTotal = 0;
      const linesToInsert = [];
      for (const l of rawLines) {
        const baseQty = calc.qty(l.baseQty != null ? l.baseQty : l.qty);
        if (!(baseQty > 0)) throw err('VALIDATION_ERROR', 'كمية المرتجع يجب أن تكون موجبة');
        const baseUnitCost = calc.rate(l.baseUnitCost != null ? l.baseUnitCost : l.unitCost);
        const vr = calc.resolveVatRate({ vatRate: l.vatRate, taxCode: l.taxCode, standardRate });
        const net = calc.money(baseQty * baseUnitCost);
        const vat = calc.money(net * vr.rate / 100);
        subtotal += net; vatTotal += vat;
        linesToInsert.push({
          id: lineId(), receipt_line_id: l.receiptLineId || l.receipt_line_id || null, invoice_line_id: l.invoiceLineId || null,
          item_id: l.itemId || l.item_id, item_name: l.itemName || '', purchase_lot_id: l.purchaseLotId || l.purchase_lot_id || null,
          base_qty: baseQty, base_unit_cost: baseUnitCost, vat_rate: vr.rate, tax_code: vr.code, line_total: calc.money(net + vat),
          warehouse_id: l.warehouseId || b.warehouseId,
        });
      }
      subtotal = calc.money(subtotal); vatTotal = calc.money(vatTotal);
      await conn.query(
        `INSERT INTO purchase_returns
          (id, return_number, supplier_id, supplier_name_snapshot, receipt_id, invoice_id, return_date, warehouse_id,
           brand_id, branch_id, cost_center_id, phase, reason, subtotal, vat_amount, total, status, version, created_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?)`,
        [id, number, b.supplierId || null, supplier ? supplier.name : null, b.receiptId || null, b.invoiceId || null,
         b.returnDate || new Date().toISOString().slice(0, 10), b.warehouseId || null, b.brandId || null, b.branchId || null, b.costCenterId || null,
         phase, b.reason || null, subtotal, vatTotal, calc.money(subtotal + vatTotal), actor, H.idemOf(req)]);
      for (const l of linesToInsert) {
        await conn.query(
          `INSERT INTO purchase_return_lines (id, return_id, receipt_line_id, invoice_line_id, item_id, item_name_snapshot, purchase_lot_id, base_qty, base_unit_cost, vat_rate, tax_code, line_total)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [l.id, id, l.receipt_line_id, l.invoice_line_id, l.item_id, l.item_name, l.purchase_lot_id, l.base_qty, l.base_unit_cost, l.vat_rate, l.tax_code, l.line_total]);
      }
      await events.recordEvent(conn, { documentType: 'return', documentId: id, action: 'create', toStatus: 'draft', actor });
      return { id, number };
    });
    return H.sendOk(res, { data: { id: out.id }, documentNumber: out.number, status: 'draft', version: 1 }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/', requireCapability('procurement.view'), async (req, res) => {
  try {
    const p = H.listParams(req, Object.keys(SORTABLE), LIST_STATUSES);
    const where = [], params = [];
    if (p.status) { where.push('r.status = ?'); params.push(p.status); }
    if (p.supplierId) { where.push('r.supplier_id = ?'); params.push(p.supplierId); }
    if (p.q) { where.push('r.return_number LIKE ?'); params.push('%' + p.q + '%'); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = H.orderBy(p.sort, p.dir, SORTABLE, 'r.return_date');
    const [rows] = await db.query(
      `SELECT r.id, r.return_number, r.supplier_id, r.receipt_id, r.invoice_id, r.return_date, r.phase, r.status, r.version, r.total, r.gl_journal_id
         FROM purchase_returns r ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM purchase_returns r ${whereSql}`, params);
    return H.sendData(res, rows, { pagination: { page: p.page, pageSize: p.pageSize, total: Number(cnt[0].total), totalPages: Math.ceil(cnt[0].total / p.pageSize) } });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('procurement.view'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM purchase_returns WHERE id = ?', [req.params.id]);
    if (!rows.length) throw err('NOT_FOUND', 'المرتجع غير موجود');
    const [lines] = await db.query('SELECT * FROM purchase_return_lines WHERE return_id = ? ORDER BY id', [req.params.id]);
    return H.sendData(res, Object.assign({}, rows[0], { lines }));
  } catch (e) { return H.sendErr(res, e); }
});

router.patch('/:id', requireCapability('purchase_returns.create'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT status FROM purchase_returns WHERE id = ?', [req.params.id]);
    if (!rows.length) throw err('NOT_FOUND', 'المرتجع غير موجود');
    if (rows[0].status !== 'draft') throw err('INVALID_STATE_TRANSITION', 'لا يمكن تعديل مرتجع غير مسودة');
    const sets = [], params = [];
    for (const [k, col] of [['reason', 'reason'], ['returnDate', 'return_date']]) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) { sets.push(`${col} = ?`); params.push(req.body[k]); }
    }
    if (sets.length) { params.push(req.params.id); await db.query(`UPDATE purchase_returns SET ${sets.join(', ')} WHERE id = ?`, params); }
    return H.sendOk(res, { data: { id: req.params.id }, status: 'draft' });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/approve', requireCapability('purchase_returns.approve'), async (req, res) => {
  try {
    const r = await runTransition({
      docType: 'return', table: 'purchase_returns', id: req.params.id, action: 'approve',
      actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'approved_by', at: 'approved_at' }, perform: async () => ({}),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.return_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/post', requireCapability('purchase_returns.post'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const r = await runTransition({
      docType: 'return', table: 'purchase_returns', id: req.params.id, action: 'post',
      actor, expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'posted_by', at: 'posted_at' },
      perform: async (conn, row) => {
        const [lines] = await conn.query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [req.params.id]);
        if (!lines.length) throw err('VALIDATION_ERROR', 'لا توجد سطور للمرتجع');
        const stock = await inv.applyReturnStock(conn, { ret: row, lines, actor });
        const net = calc.money(row.subtotal);
        const vat = calc.money(row.vat_amount);
        const journalId = row.phase === 'after_invoice'
          ? await posting.postReturnAfterInvoice(conn, { ret: Object.assign({}, row, { posted_by: actor }), net, vat, warehouseId: row.warehouse_id })
          : await posting.postReturnBeforeInvoice(conn, { ret: Object.assign({}, row, { posted_by: actor }), net, warehouseId: row.warehouse_id });
        return { extraSets: { gl_journal_id: journalId }, journalIds: [journalId], affectedStock: stock.affectedStock, affectedValue: -net };
      },
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.return_number, status: r.toStatus, version: r.newVersion, journalIds: r.result.journalIds, affectedStock: r.result.affectedStock });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/reverse', requireCapability('purchase_returns.post'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM purchase_returns WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'المرتجع غير موجود');
      const row = rows[0];
      if (row.status !== 'posted') throw err('INVALID_STATE_TRANSITION', 'العكس يتطلب مرتجعًا مرحّلًا');
      const [lines] = await conn.query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [req.params.id]);
      // put stock back
      await inv.applyReceiptStock(conn, { grn: { id: row.id, warehouse_id: row.warehouse_id, po_id: null }, lines: lines.map((l) => ({ item_id: l.item_id, item_name: l.item_name_snapshot, base_qty: l.base_qty, base_unit_cost: l.base_unit_cost, warehouse_id: row.warehouse_id, po_line_id: null })), actor });
      let journalId = null;
      if (row.gl_journal_id) journalId = await posting.postReversal(conn, { originalJournalId: row.gl_journal_id, referenceType: 'PurchaseReturn', referenceId: row.id, actor, dateYMD: new Date().toISOString().slice(0, 10) });
      await conn.query('UPDATE purchase_returns SET status = "draft", version = version + 1 WHERE id = ?', [req.params.id]);
      await events.recordEvent(conn, { documentType: 'return', documentId: req.params.id, action: 'reverse', fromStatus: 'posted', toStatus: 'draft', actor, glJournalId: journalId });
      return { journalId };
    });
    return H.sendOk(res, { data: { id: req.params.id }, status: 'draft', journalIds: out.journalId ? [out.journalId] : [] });
  } catch (e) { return H.sendErr(res, e); }
});


router.get('/:id/timeline', requireCapability('procurement.view'), async (req, res) => {
  try { return H.sendData(res, await events.timeline(db, 'return', req.params.id)); }
  catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
