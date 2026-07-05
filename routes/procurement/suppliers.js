/**
 * routes/procurement/suppliers.js — supplier master.
 * List / search (combobox) / create / edit / activate / deactivate, plus
 * derived AP statement, aging and price history. Balance is DERIVED from
 * v_supplier_ap_balance — suppliers.balance is never trusted.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const { err } = require('../../lib/procurement/errors');
const calc = require('../../lib/procurement/calculations');

const SORTABLE = { name: 's.name', createdAt: 's.created_at', balance: 'ap.ap_balance', city: 's.city' };

function genId() { return 'SUP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

// ── GET / — paginated list with derived balance ──────────────────────────────
router.get('/', requireCapability('suppliers.view'), async (req, res) => {
  try {
    const p = H.listParams(req, Object.keys(SORTABLE));
    const where = [], params = [];
    if (req.query.activeOnly !== '0') where.push('s.is_active = 1');
    if (p.q) {
      where.push('(s.name LIKE ? OR s.name_en LIKE ? OR s.vat_number LIKE ? OR s.phone LIKE ?)');
      const like = '%' + p.q + '%';
      params.push(like, like, like, like);
    }
    if (req.query.brandId) { where.push('s.brand_id = ?'); params.push(String(req.query.brandId)); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = H.orderBy(p.sort, p.dir, SORTABLE, 's.name');

    const [rows] = await db.query(
      `SELECT s.id, s.name, s.name_en, s.vat_number, s.phone, s.email, s.city,
              s.payment_terms, s.is_active, s.created_at,
              COALESCE(ap.ap_balance, 0) AS ap_balance
         FROM suppliers s
         LEFT JOIN v_supplier_ap_balance ap ON ap.supplier_id = s.id
         ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM suppliers s ${whereSql}`, params);
    const [tot] = await db.query(
      `SELECT COALESCE(SUM(ap.ap_balance),0) AS ap_total
         FROM suppliers s LEFT JOIN v_supplier_ap_balance ap ON ap.supplier_id = s.id ${whereSql}`, params);

    return H.sendData(res, rows, {
      pagination: { page: p.page, pageSize: p.pageSize, total: Number(cnt[0].total), totalPages: Math.ceil(cnt[0].total / p.pageSize) },
      totals: { apBalance: calc.money(tot[0].ap_total) },
    });
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET /search — combobox (first page on open, then server search) ──────────
router.get('/search', requireCapability('suppliers.view'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const where = ['s.is_active = 1'], params = [];
    if (q) {
      where.push('(s.name LIKE ? OR s.name_en LIKE ? OR s.vat_number LIKE ? OR s.phone LIKE ?)');
      const like = '%' + q + '%'; params.push(like, like, like, like);
    }
    const whereSql = 'WHERE ' + where.join(' AND ');
    const [rows] = await db.query(
      `SELECT s.id, s.name, s.name_en, s.vat_number, s.phone, s.city
         FROM suppliers s ${whereSql} ORDER BY s.name ASC LIMIT ? OFFSET ?`,
      params.concat([pageSize, offset]));
    const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM suppliers s ${whereSql}`, params);
    return H.sendData(res, rows, { pagination: { page, pageSize, total: Number(cnt[0].total), totalPages: Math.ceil(cnt[0].total / pageSize) } });
  } catch (e) { return H.sendErr(res, e); }
});

// ── POST / — create ──────────────────────────────────────────────────────────
router.post('/', requireCapability('suppliers.create'), async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw err('VALIDATION_ERROR', 'اسم المورد مطلوب');
    const id = genId();
    await db.query(
      `INSERT INTO suppliers (id, name, name_en, vat_number, phone, email, address, city, payment_terms, is_active, created_by, brand_id)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
      [id, name, b.nameEn || null, b.vatNumber || null, b.phone || null, b.email || null,
       b.address || null, b.city || null, b.paymentTerms || 'Cash', H.actorOf(req), b.brandId || null]);
    const [row] = await db.query('SELECT * FROM suppliers WHERE id = ?', [id]);
    return H.sendData(res, row[0], {}, 201);
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET /:id ─────────────────────────────────────────────────────────────────
router.get('/:id', requireCapability('suppliers.view'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
    if (!rows.length) throw err('NOT_FOUND', 'المورد غير موجود');
    const [bal] = await db.query('SELECT ap_balance, invoiced_total, paid_total FROM v_supplier_ap_balance WHERE supplier_id = ?', [req.params.id]);
    const [counts] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = ?) AS orders,
         (SELECT COUNT(*) FROM purchase_receipts WHERE supplier_id = ?) AS receipts,
         (SELECT COUNT(*) FROM supplier_invoices WHERE supplier_id = ?) AS invoices`,
      [req.params.id, req.params.id, req.params.id]);
    return H.sendData(res, Object.assign({}, rows[0], {
      apBalance: calc.money((bal[0] && bal[0].ap_balance) || 0),
      invoicedTotal: calc.money((bal[0] && bal[0].invoiced_total) || 0),
      paidTotal: calc.money((bal[0] && bal[0].paid_total) || 0),
      counts: counts[0],
    }));
  } catch (e) { return H.sendErr(res, e); }
});

// ── PATCH /:id — edit (mass-assignment protected, no status/balance) ─────────
const EDITABLE = ['name', 'name_en', 'vat_number', 'phone', 'email', 'address', 'city', 'payment_terms', 'brand_id'];
const BODY_MAP = { name: 'name', nameEn: 'name_en', vatNumber: 'vat_number', phone: 'phone', email: 'email', address: 'address', city: 'city', paymentTerms: 'payment_terms', brandId: 'brand_id' };
router.patch('/:id', requireCapability('suppliers.edit'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id FROM suppliers WHERE id = ?', [req.params.id]);
    if (!rows.length) throw err('NOT_FOUND', 'المورد غير موجود');
    const sets = [], params = [];
    for (const [bodyKey, col] of Object.entries(BODY_MAP)) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, bodyKey) && EDITABLE.includes(col)) {
        sets.push(`${col} = ?`); params.push(req.body[bodyKey]);
      }
    }
    if (!sets.length) throw err('VALIDATION_ERROR', 'لا توجد حقول للتعديل');
    sets.push('updated_by = ?'); params.push(H.actorOf(req));
    params.push(req.params.id);
    await db.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?`, params);
    const [out] = await db.query('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
    return H.sendData(res, out[0]);
  } catch (e) { return H.sendErr(res, e); }
});

// ── activate / deactivate (never hard-delete when there's history) ───────────
router.post('/:id/activate', requireCapability('suppliers.deactivate'), async (req, res) => {
  try {
    await db.query('UPDATE suppliers SET is_active = 1, updated_by = ? WHERE id = ?', [H.actorOf(req), req.params.id]);
    return H.sendData(res, { id: req.params.id, isActive: true });
  } catch (e) { return H.sendErr(res, e); }
});
router.post('/:id/deactivate', requireCapability('suppliers.deactivate'), async (req, res) => {
  try {
    await db.query('UPDATE suppliers SET is_active = 0, updated_by = ? WHERE id = ?', [H.actorOf(req), req.params.id]);
    return H.sendData(res, { id: req.params.id, isActive: false });
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET /:id/statement — running AP balance (invoices + payments) ────────────
router.get('/:id/statement', requireCapability('suppliers.view'), async (req, res) => {
  try {
    const from = req.query.dateFrom ? String(req.query.dateFrom) : null;
    const to = req.query.dateTo ? String(req.query.dateTo) : null;
    const invWhere = ["supplier_id = ?", "status NOT IN ('cancelled','draft')"], invP = [req.params.id];
    if (from) { invWhere.push('issue_date >= ?'); invP.push(from); }
    if (to) { invWhere.push('issue_date <= ?'); invP.push(to); }
    const [invoices] = await db.query(
      `SELECT id, code, invoice_no, issue_date AS date, total_amount FROM supplier_invoices WHERE ${invWhere.join(' AND ')}`, invP);

    const payWhere = ['si.supplier_id = ?', 'pa.reversed = 0'], payP = [req.params.id];
    if (from) { payWhere.push('pa.allocation_date >= ?'); payP.push(from); }
    if (to) { payWhere.push('pa.allocation_date <= ?'); payP.push(to); }
    const [payments] = await db.query(
      `SELECT pa.id, pa.payment_id, pa.allocation_date AS date, pa.allocated_amount
         FROM payment_allocations pa JOIN supplier_invoices si ON si.id = pa.supplier_invoice_id
        WHERE ${payWhere.join(' AND ')}`, payP);

    const lines = [];
    for (const i of invoices) lines.push({ date: i.date, type: 'invoice', ref: i.invoice_no || i.code, debit: calc.money(i.total_amount), credit: 0 });
    for (const pmt of payments) lines.push({ date: pmt.date, type: 'payment', ref: pmt.payment_id, debit: 0, credit: calc.money(pmt.allocated_amount) });
    lines.sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0));
    let running = 0;
    for (const l of lines) { running = calc.money(running + l.debit - l.credit); l.balance = running; }

    if (String(req.query.format).toLowerCase() === 'csv') {
      return H.sendCsv(res, `supplier-statement-${req.params.id}.csv`, lines,
        [{ key: 'date', label: 'التاريخ' }, { key: 'type', label: 'النوع' }, { key: 'ref', label: 'المرجع' },
         { key: 'debit', label: 'مدين' }, { key: 'credit', label: 'دائن' }, { key: 'balance', label: 'الرصيد' }]);
    }
    return H.sendData(res, lines, { closingBalance: running });
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET /:id/aging — buckets by invoice due date ─────────────────────────────
router.get('/:id/aging', requireCapability('suppliers.view'), async (req, res) => {
  try {
    const asOf = req.query.asOfDate ? String(req.query.asOfDate) : new Date().toISOString().slice(0, 10);
    const [rows] = await db.query(
      `SELECT si.id, si.invoice_no, si.code, si.due_date, si.total_amount,
              COALESCE((SELECT SUM(allocated_amount) FROM payment_allocations pa WHERE pa.supplier_invoice_id = si.id AND pa.reversed = 0), 0) AS paid
         FROM supplier_invoices si
        WHERE si.supplier_id = ? AND si.status NOT IN ('cancelled','draft','paid')`, [req.params.id]);
    const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
    let total = 0;
    for (const r of rows) {
      const bal = calc.money(Number(r.total_amount) - Number(r.paid));
      if (bal <= 0) continue;
      total += bal;
      const due = r.due_date ? new Date(r.due_date) : null;
      const age = due ? Math.floor((new Date(asOf) - due) / 86400000) : 0;
      if (age <= 0) buckets.current += bal;
      else if (age <= 30) buckets.d30 += bal;
      else if (age <= 60) buckets.d60 += bal;
      else if (age <= 90) buckets.d90 += bal;
      else buckets.d90plus += bal;
    }
    for (const k of Object.keys(buckets)) buckets[k] = calc.money(buckets[k]);
    return H.sendData(res, { asOf, buckets, total: calc.money(total) });
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET /:id/price-history — item unit-cost trend from receipts ──────────────
router.get('/:id/price-history', requireCapability('suppliers.view'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT prl.item_id, i.name AS item_name, pr.receipt_date, prl.base_unit_cost, prl.unit_cost
         FROM purchase_receipts pr
         JOIN purchase_receipt_lines prl ON prl.receipt_id = pr.id
         LEFT JOIN inv_items i ON i.id = prl.item_id
        WHERE pr.supplier_id = ? AND pr.status = 'posted'
        ORDER BY pr.receipt_date DESC LIMIT 500`, [req.params.id]);
    return H.sendData(res, rows.map((r) => ({
      itemId: r.item_id, itemName: r.item_name, date: r.receipt_date,
      unitCost: calc.rate(r.base_unit_cost != null ? r.base_unit_cost : r.unit_cost),
    })));
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
module.exports._norm = norm;
