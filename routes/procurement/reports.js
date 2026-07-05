/**
 * routes/procurement/reports.js — procurement reporting.
 * open-orders · receiving-variance · three-way-match · ap-aging ·
 * supplier-statement · purchase-analysis · price-variance · tax · data-quality
 * plus CSV export. Totals are computed over the whole result set (not the page).
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const { err } = require('../../lib/procurement/errors');
const calc = require('../../lib/procurement/calculations');

const RPT = requireCapability('procurement.reports');

// GET /open-orders — approved/sent POs with unreceived quantity
router.get('/open-orders', RPT, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT po.id, po.po_number, po.supplier_name, po.po_date, po.expected_date, po.status, po.total_after_vat,
              COALESCE(SUM(pl.base_qty - pl.base_received_qty),0) AS open_qty
         FROM purchase_orders po JOIN po_lines pl ON pl.po_id = po.id
        WHERE po.status IN ('approved','sent','partially_received')
        GROUP BY po.id HAVING open_qty > 0 ORDER BY po.expected_date ASC`);
    return H.sendData(res, rows, { totals: { count: rows.length, value: calc.money(rows.reduce((s, r) => s + Number(r.total_after_vat), 0)) } });
  } catch (e) { return H.sendErr(res, e); }
});

// GET /receiving-variance — ordered vs received per PO line
router.get('/receiving-variance', RPT, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT po.po_number, pl.item_name, pl.base_qty AS ordered, pl.base_received_qty AS received,
              (pl.base_qty - pl.base_received_qty) AS variance
         FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
        WHERE pl.base_qty <> pl.base_received_qty AND po.status IN ('partially_received','received','fully_received','sent','approved')
        ORDER BY po.po_number LIMIT 2000`);
    return H.sendData(res, rows);
  } catch (e) { return H.sendErr(res, e); }
});

// GET /three-way-match — invoice matches with variances
router.get('/three-way-match', RPT, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT si.code, si.invoice_no, si.supplier_name, si.matching_status,
              COALESCE(SUM(m.price_variance),0) AS price_variance, COALESCE(SUM(m.qty_variance),0) AS qty_variance
         FROM supplier_invoices si LEFT JOIN supplier_invoice_matches m ON m.invoice_id = si.id
        WHERE si.status NOT IN ('cancelled','draft')
        GROUP BY si.id ORDER BY si.issue_date DESC LIMIT 2000`);
    return H.sendData(res, rows.map((r) => ({ ...r, price_variance: calc.money(r.price_variance), qty_variance: calc.qty(r.qty_variance) })));
  } catch (e) { return H.sendErr(res, e); }
});

// GET /ap-aging — all suppliers, bucketed by invoice due date
router.get('/ap-aging', RPT, async (req, res) => {
  try {
    const asOf = req.query.asOfDate ? String(req.query.asOfDate) : new Date().toISOString().slice(0, 10);
    const [rows] = await db.query(
      `SELECT si.supplier_id, si.supplier_name, si.due_date, si.total_amount,
              COALESCE((SELECT SUM(allocated_amount) FROM payment_allocations pa WHERE pa.supplier_invoice_id = si.id AND pa.reversed = 0),0) AS paid
         FROM supplier_invoices si WHERE si.status NOT IN ('cancelled','draft','paid','closed')`);
    const bySupplier = {};
    let grand = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 };
    for (const r of rows) {
      const bal = calc.money(Number(r.total_amount) - Number(r.paid));
      if (bal <= 0) continue;
      const key = r.supplier_id;
      if (!bySupplier[key]) bySupplier[key] = { supplierId: r.supplier_id, supplierName: r.supplier_name, current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 };
      const s = bySupplier[key];
      const age = r.due_date ? Math.floor((new Date(asOf) - new Date(r.due_date)) / 86400000) : 0;
      let bucket = 'current';
      if (age > 90) bucket = 'd90plus'; else if (age > 60) bucket = 'd90'; else if (age > 30) bucket = 'd60'; else if (age > 0) bucket = 'd30';
      s[bucket] += bal; s.total += bal; grand[bucket] += bal; grand.total += bal;
    }
    const list = Object.values(bySupplier).map((s) => { for (const k of ['current', 'd30', 'd60', 'd90', 'd90plus', 'total']) s[k] = calc.money(s[k]); return s; });
    for (const k of Object.keys(grand)) grand[k] = calc.money(grand[k]);
    if (String(req.query.format).toLowerCase() === 'csv') {
      return H.sendCsv(res, 'ap-aging.csv', list, [
        { key: 'supplierName', label: 'المورد' }, { key: 'current', label: 'جاري' }, { key: 'd30', label: '1-30' },
        { key: 'd60', label: '31-60' }, { key: 'd90', label: '61-90' }, { key: 'd90plus', label: '90+' }, { key: 'total', label: 'الإجمالي' }]);
    }
    return H.sendData(res, list, { asOf, grandTotal: grand });
  } catch (e) { return H.sendErr(res, e); }
});

// GET /supplier-statement?supplierId=..
router.get('/supplier-statement', RPT, async (req, res) => {
  try {
    if (!req.query.supplierId) throw err('VALIDATION_ERROR', 'supplierId مطلوب');
    // delegate to the supplier statement logic
    req.params.id = String(req.query.supplierId);
    return require('./suppliers').handle
      ? require('./suppliers').handle(req, res)
      : res.redirect(307, `/api/procurement/suppliers/${req.query.supplierId}/statement`);
  } catch (e) { return H.sendErr(res, e); }
});

// GET /purchase-analysis — spend by supplier
router.get('/purchase-analysis', RPT, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT supplier_id, supplier_name, COUNT(*) AS invoices, COALESCE(SUM(total_amount),0) AS spend
         FROM supplier_invoices WHERE status NOT IN ('cancelled','draft')
         GROUP BY supplier_id ORDER BY spend DESC LIMIT 500`);
    return H.sendData(res, rows.map((r) => ({ ...r, spend: calc.money(r.spend) })), { totals: { spend: calc.money(rows.reduce((s, r) => s + Number(r.spend), 0)) } });
  } catch (e) { return H.sendErr(res, e); }
});

// GET /price-variance — PPV per invoice line vs receipt
router.get('/price-variance', RPT, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT si.code, si.supplier_name, m.matched_qty, m.matched_amount, m.price_variance
         FROM supplier_invoice_matches m JOIN supplier_invoices si ON si.id = m.invoice_id
        WHERE ABS(m.price_variance) > 0 ORDER BY ABS(m.price_variance) DESC LIMIT 1000`);
    return H.sendData(res, rows.map((r) => ({ ...r, matched_amount: calc.money(r.matched_amount), price_variance: calc.money(r.price_variance) })));
  } catch (e) { return H.sendErr(res, e); }
});

// GET /tax — input VAT summary
router.get('/tax', RPT, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT DATE_FORMAT(issue_date,'%Y-%m') AS period, COALESCE(SUM(subtotal),0) AS net, COALESCE(SUM(vat_amount),0) AS input_vat
         FROM supplier_invoices WHERE status NOT IN ('cancelled','draft')
         GROUP BY period ORDER BY period DESC LIMIT 36`);
    return H.sendData(res, rows.map((r) => ({ period: r.period, net: calc.money(r.net), inputVat: calc.money(r.input_vat) })));
  } catch (e) { return H.sendErr(res, e); }
});

// GET /data-quality — orphans / anomalies
router.get('/data-quality', requireCapability('procurement.data_quality'), async (req, res) => {
  try {
    const checks = {};
    const [freeName] = await db.query("SELECT COUNT(*) c FROM supplier_invoices WHERE (supplier_id IS NULL OR supplier_id='') AND status<>'cancelled'");
    checks.invoicesWithoutSupplier = Number(freeName[0].c);
    const [negBal] = await db.query('SELECT COUNT(*) c FROM v_supplier_ap_balance WHERE ap_balance < -0.01');
    checks.suppliersNegativeBalance = Number(negBal[0].c);
    const [dupInv] = await db.query("SELECT COUNT(*) c FROM (SELECT supplier_id, invoice_no FROM supplier_invoices WHERE invoice_no IS NOT NULL AND status<>'cancelled' GROUP BY supplier_id, invoice_no HAVING COUNT(*)>1) t");
    checks.duplicateInvoiceNumbers = Number(dupInv[0].c);
    const [unbal] = await db.query('SELECT COUNT(*) c FROM gl_journals WHERE ABS(total_debit - total_credit) > 0.01');
    checks.unbalancedJournals = Number(unbal[0].c);
    return H.sendData(res, checks);
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
