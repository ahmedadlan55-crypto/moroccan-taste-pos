/**
 * routes/procurement/payments.js — Supplier Payments + allocations.
 * requested → authorized → paid (posts Dr AP / Cr Cash|Bank + writes allocations)
 * → closed; reverse after close. Over-allocation is blocked per payment and per
 * invoice. Invoice paid/balance/status are the ONLY places those cached fields
 * are written.
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
const posting = require('../../lib/procurement/posting');
const events = require('../../lib/procurement/events');

const SORTABLE = { requestedAt: 'p.requested_at', amount: 'p.amount', status: 'p.status', number: 'p.payment_number' };
const LIST_STATUSES = ['requested', 'authorized', 'paid', 'closed', 'cancelled', 'reversed'];

function genId() { return 'PAY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function allocId() { return 'ALC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

async function _recomputeInvoice(conn, invoiceId) {
  const [inv] = await conn.query('SELECT total_amount FROM supplier_invoices WHERE id = ? FOR UPDATE', [invoiceId]);
  if (!inv.length) throw err('VALIDATION_ERROR', 'الفاتورة غير موجودة');
  const [al] = await conn.query('SELECT COALESCE(SUM(allocated_amount),0) AS a FROM payment_allocations WHERE supplier_invoice_id = ? AND reversed = 0', [invoiceId]);
  const total = calc.money(inv[0].total_amount);
  const paid = calc.money(al[0].a);
  const balance = calc.money(total - paid);
  const status = balance <= 0.01 ? 'paid' : (paid > 0.01 ? 'partially_paid' : 'approved');
  await conn.query('UPDATE supplier_invoices SET paid_amount = ?, balance_amount = ?, status = CASE WHEN status IN ("cancelled","closed") THEN status ELSE ? END, version = version + 1 WHERE id = ?',
    [paid, Math.max(0, balance), status, invoiceId]);
  return { total, paid, balance };
}

async function _applyAllocations(conn, payment, allocations, actor) {
  let allocatedTotal = 0;
  for (const a of allocations) {
    const invoiceId = a.invoiceId || a.supplier_invoice_id;
    const amount = calc.money(a.amount);
    if (!(amount > 0)) throw err('VALIDATION_ERROR', 'مبلغ التخصيص يجب أن يكون موجبًا');
    const [inv] = await conn.query('SELECT id, total_amount FROM supplier_invoices WHERE id = ? FOR UPDATE', [invoiceId]);
    if (!inv.length) throw err('VALIDATION_ERROR', 'الفاتورة غير موجودة: ' + invoiceId);
    const [al] = await conn.query('SELECT COALESCE(SUM(allocated_amount),0) AS a FROM payment_allocations WHERE supplier_invoice_id = ? AND reversed = 0', [invoiceId]);
    const outstanding = calc.money(Number(inv[0].total_amount) - Number(al[0].a));
    if (amount - outstanding > 0.01) throw err('PAYMENT_OVER_ALLOCATION', `التخصيص (${amount}) يتجاوز المتبقي على الفاتورة (${outstanding})`);
    await conn.query(
      `INSERT INTO payment_allocations (id, payment_id, supplier_invoice_id, allocated_amount, allocation_date, actor)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE allocated_amount = allocated_amount + VALUES(allocated_amount), reversed = 0`,
      [allocId(), payment.id, invoiceId, amount, payment.receipt_date || new Date().toISOString().slice(0, 10), actor]);
    await _recomputeInvoice(conn, invoiceId);
    allocatedTotal += amount;
  }
  allocatedTotal = calc.money(allocatedTotal);
  const [tot] = await conn.query('SELECT COALESCE(SUM(allocated_amount),0) AS a FROM payment_allocations WHERE payment_id = ? AND reversed = 0', [payment.id]);
  if (Number(tot[0].a) - Number(payment.amount) > 0.01) throw err('PAYMENT_OVER_ALLOCATION', 'مجموع التخصيصات يتجاوز مبلغ الدفعة');
  return { allocatedTotal, totalAllocated: calc.money(tot[0].a) };
}

// ── POST / — create (requested) ──────────────────────────────────────────────
router.post('/', requireCapability('payments.request'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.supplierId) throw err('VALIDATION_ERROR', 'المورد مطلوب');
    const allocations = Array.isArray(b.allocations) ? b.allocations : [];
    let amount = calc.money(b.amount);
    if (!(amount > 0) && allocations.length) amount = calc.money(allocations.reduce((s, a) => s + Number(a.amount || 0), 0));
    if (!(amount > 0)) throw err('VALIDATION_ERROR', 'مبلغ السداد يجب أن يكون موجبًا');
    const actor = H.actorOf(req);
    const out = await db.withTransaction(async (conn) => {
      const id = genId();
      const number = await nextNumber(conn, 'payment');
      await conn.query(
        `INSERT INTO payment_records
          (id, payment_number, reference_type, reference_id, direction, amount, currency, payment_method,
           bank_account_id, cash_box_id, supplier_id, brand_id, branch_id, cost_center_id, status, version, requested_by, idempotency_key, receipt_date, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'requested',1,?,?,?,?)`,
        [id, number, 'SupplierPayment', b.supplierId, 'out', amount, b.currency || 'SAR', b.paymentMethod || 'bank',
         b.bankAccountId || null, b.cashBoxId || null, b.supplierId, b.brandId || null, b.branchId || null, b.costCenterId || null,
         actor, H.idemOf(req), b.paymentDate || new Date().toISOString().slice(0, 10), b.notes || null]);
      // store intended allocations in payload for pay-time application
      await events.recordEvent(conn, { documentType: 'payment', documentId: id, action: 'create', toStatus: 'requested', actor, payload: { allocations } });
      return { id, number };
    });
    return H.sendOk(res, { data: { id: out.id }, documentNumber: out.number, status: 'requested', version: 1 }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/', requireCapability('procurement.view'), async (req, res) => {
  try {
    const p = H.listParams(req, Object.keys(SORTABLE), LIST_STATUSES);
    const where = ["p.reference_type = 'SupplierPayment'"], params = [];
    if (p.status) { where.push('p.status = ?'); params.push(p.status); }
    if (p.supplierId) { where.push('p.supplier_id = ?'); params.push(p.supplierId); }
    if (p.q) { where.push('p.payment_number LIKE ?'); params.push('%' + p.q + '%'); }
    const whereSql = 'WHERE ' + where.join(' AND ');
    const order = H.orderBy(p.sort, p.dir, SORTABLE, 'p.requested_at');
    const [rows] = await db.query(
      `SELECT p.id, p.payment_number, p.supplier_id, p.amount, p.allocated_amount, p.payment_method, p.status, p.version, p.requested_at, p.gl_journal_id
         FROM payment_records p ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM payment_records p ${whereSql}`, params);
    return H.sendData(res, rows, { pagination: { page: p.page, pageSize: p.pageSize, total: Number(cnt[0].total), totalPages: Math.ceil(cnt[0].total / p.pageSize) } });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('procurement.view'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM payment_records WHERE id = ?', [req.params.id]);
    if (!rows.length) throw err('NOT_FOUND', 'الدفعة غير موجودة');
    const [alloc] = await db.query('SELECT * FROM payment_allocations WHERE payment_id = ?', [req.params.id]);
    return H.sendData(res, Object.assign({}, rows[0], { allocations: alloc }));
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/authorize', requireCapability('payments.authorize'), async (req, res) => {
  try {
    const r = await runTransition({
      docType: 'payment', table: 'payment_records', id: req.params.id, action: 'authorize',
      actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'authorized_by', at: 'authorized_at' }, perform: async () => ({}),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.payment_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

// ── pay (authorized → paid): allocations + GL ────────────────────────────────
router.post('/:id/pay', requireCapability('payments.execute'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const r = await runTransition({
      docType: 'payment', table: 'payment_records', id: req.params.id, action: 'pay',
      actor, expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'paid_by', at: 'paid_at' },
      perform: async (conn, row) => {
        // allocations: body wins, else the ones captured at create
        let allocations = Array.isArray(req.body && req.body.allocations) ? req.body.allocations : null;
        if (!allocations) {
          const [ev] = await conn.query("SELECT payload FROM procurement_events WHERE document_type='payment' AND document_id=? AND action='create' LIMIT 1", [row.id]);
          const pl = ev.length && ev[0].payload ? (typeof ev[0].payload === 'string' ? JSON.parse(ev[0].payload) : ev[0].payload) : {};
          allocations = (pl && pl.allocations) || [];
        }
        if (!allocations.length) throw err('VALIDATION_ERROR', 'يجب تخصيص الدفعة على فاتورة واحدة على الأقل');
        const applied = await _applyAllocations(conn, row, allocations, actor);
        const journalId = await posting.postPayment(conn, { payment: Object.assign({}, row, { paid_by: actor }), amount: applied.totalAllocated });
        return {
          extraSets: { gl_journal_id: journalId, allocated_amount: applied.totalAllocated, receipt_number: (req.body && req.body.receiptNumber) || null },
          journalIds: [journalId], affectedValue: applied.totalAllocated,
        };
      },
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.payment_number, status: r.toStatus, version: r.newVersion, journalIds: r.result.journalIds, affectedValue: r.result.affectedValue });
  } catch (e) { return H.sendErr(res, e); }
});

// ── add allocation to an existing payment ────────────────────────────────────
router.post('/:id/allocations', requireCapability('payments.execute'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM payment_records WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'الدفعة غير موجودة');
      const allocations = Array.isArray(req.body && req.body.allocations) ? req.body.allocations : [req.body];
      const applied = await _applyAllocations(conn, rows[0], allocations, actor);
      await conn.query('UPDATE payment_records SET allocated_amount = ? WHERE id = ?', [applied.totalAllocated, req.params.id]);
      await events.recordEvent(conn, { documentType: 'payment', documentId: req.params.id, action: 'allocate', actor, payload: { allocations } });
      return applied;
    });
    return H.sendOk(res, { data: out });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/close', requireCapability('payments.close'), async (req, res) => {
  try {
    const r = await runTransition({
      docType: 'payment', table: 'payment_records', id: req.params.id, action: 'close',
      actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'paid_by', at: 'closed_at' }, perform: async () => ({}),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.payment_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

// ── reverse (paid/closed → reversed): reverse GL + allocations ───────────────
router.post('/:id/reverse', requireCapability('payments.reverse'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const r = await runTransition({
      docType: 'payment', table: 'payment_records', id: req.params.id, action: 'reverse',
      actor, expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      perform: async (conn, row) => {
        const [alloc] = await conn.query('SELECT supplier_invoice_id FROM payment_allocations WHERE payment_id = ? AND reversed = 0', [row.id]);
        await conn.query('UPDATE payment_allocations SET reversed = 1 WHERE payment_id = ?', [row.id]);
        for (const a of alloc) await _recomputeInvoice(conn, a.supplier_invoice_id);
        let journalId = null;
        if (row.gl_journal_id) journalId = await posting.postReversal(conn, { originalJournalId: row.gl_journal_id, referenceType: 'SupplierPayment', referenceId: row.id, actor, dateYMD: new Date().toISOString().slice(0, 10) });
        return { journalIds: journalId ? [journalId] : [] };
      },
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.payment_number, status: r.toStatus, version: r.newVersion, journalIds: r.result.journalIds });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/cancel', requireCapability('payments.request'), async (req, res) => {
  try {
    const r = await runTransition({
      docType: 'payment', table: 'payment_records', id: req.params.id, action: 'cancel',
      actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req), perform: async () => ({}),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.payment_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
