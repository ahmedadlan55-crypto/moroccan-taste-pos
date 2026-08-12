/**
 * Procurement reporting.
 *
 * Every query is warehouse-scoped at its authoritative fact row. Scoping here
 * is deliberately fail-closed and independent of WAREHOUSE_SCOPE_ENFORCE:
 * procurement values are financial data and must never become global merely
 * because the operational rollout flag is in shadow mode.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const { hasCapability } = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const { err } = require('../../lib/procurement/errors');
const calc = require('../../lib/procurement/calculations');
const S = require('../../lib/procurement/reportScope');
const openOrderValue = require('../../lib/procurement/openOrderValue');

const REPORT_READ_CAPS = Object.freeze(['finance.reports.view', 'procurement.reports']);
const DATA_QUALITY_READ_CAPS = Object.freeze(['finance.reports.view', 'procurement.data_quality']);
// Only a return posted after the supplier invoice debits AP.  A before-invoice
// return clears GRNI instead and must never reduce a supplier AP statement.
const AP_RETURN_PHASE = 'after_invoice';

function requireAnyCapability(capabilities) {
  return async function reportCapabilityGuard(req, res, next) {
    try {
      if (!req.user || !req.user.username) {
        return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
      }
      for (const capability of capabilities) {
        if (await hasCapability(req.user, capability)) return next();
      }
    } catch (_) { /* fail closed below */ }
    return res.status(403).json({
      success: false,
      code: 'PERMISSION_DENIED',
      error: 'الصلاحية غير كافية لعرض تقارير المشتريات والمستودعات',
    });
  };
}

const RPT = requireAnyCapability(REPORT_READ_CAPS);
const DATA_QUALITY_RPT = requireAnyCapability(DATA_QUALITY_READ_CAPS);
const C = 'COLLATE utf8mb4_unicode_ci';
const MATCH_WAREHOUSE = 'COALESCE(prl.warehouse_id COLLATE utf8mb4_unicode_ci, pr.warehouse_id COLLATE utf8mb4_unicode_ci, po.warehouse_id COLLATE utf8mb4_unicode_ci, si.warehouse_id COLLATE utf8mb4_unicode_ci)';
// `pl.total` is the immutable line total (discount + VAT already resolved at
// PO creation).  Both reporting APIs consume this shared expression so their
// commitment figures reconcile exactly.
const OPEN_ORDER_MODEL = openOrderValue.expressions({
  ordered: 'COALESCE(pl.base_qty, pl.qty, 0)',
  received: 'COALESCE(pl.base_received_qty, pl.received_qty, 0)',
  lineTotal: 'pl.total',
});
const OPEN_ORDER_QTY = OPEN_ORDER_MODEL.remaining;
const OPEN_ORDER_VALUE = OPEN_ORDER_MODEL.remainingValue;

function scopedParts(req, warehouseExpression, dateColumn) {
  const filters = S.parseReportFilters(req.query);
  const where = [];
  const params = [];
  if (dateColumn) S.appendPredicate(where, params, S.datePredicate(dateColumn, filters.from, filters.to));
  S.appendPredicate(where, params,
    S.warehousePredicate(req.warehouseScope, warehouseExpression, filters.warehouseId));
  return { filters, where, params };
}

function add(where, params, sql, values) {
  where.push(sql);
  params.push(...(values || []));
}

function sqlWhere(where) {
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

// GET /open-orders — approved/sent POs with unreceived quantity.
router.get('/open-orders', RPT, async (req, res) => {
  try {
    const q = scopedParts(req, 'po.warehouse_id', 'po.po_date');
    add(q.where, q.params, "po.status IN ('approved','sent','partially_received')");
    const [rows] = await db.query(
      `SELECT po.id, po.po_number, po.supplier_name, po.po_date, po.expected_date,
              po.status, po.total_after_vat, po.warehouse_id,
              COALESCE(SUM(${OPEN_ORDER_QTY}),0) AS open_qty,
              COALESCE(SUM(${OPEN_ORDER_VALUE}),0) AS remaining_value
         FROM purchase_orders po
         JOIN po_lines pl ON pl.po_id ${C} = po.id ${C}
         ${sqlWhere(q.where)}
        GROUP BY po.id, po.po_number, po.supplier_name, po.po_date,
                 po.expected_date, po.status, po.total_after_vat, po.warehouse_id
       HAVING COALESCE(SUM(${OPEN_ORDER_QTY}),0) > 0
        ORDER BY po.expected_date ASC, po.po_number ASC`, q.params);
    const data = rows.map((row) => ({
      ...row,
      open_qty: calc.qty(row.open_qty),
      remaining_value: calc.money(row.remaining_value),
    }));
    return H.sendData(res, data, {
      filters: q.filters,
      totals: {
        count: data.length,
        value: calc.money(data.reduce((sum, row) => sum + Number(row.remaining_value), 0)),
      },
    });
  } catch (e) { return H.sendErr(res, e); }
});

// GET /receiving-variance — ordered vs received per PO line.
router.get('/receiving-variance', RPT, async (req, res) => {
  try {
    const q = scopedParts(req, 'po.warehouse_id', 'po.po_date');
    add(q.where, q.params, 'pl.base_qty <> pl.base_received_qty');
    add(q.where, q.params,
      "po.status IN ('partially_received','received','fully_received','sent','approved')");
    const [rows] = await db.query(
      `SELECT po.id AS po_id, po.po_number, po.po_date, po.warehouse_id,
              pl.id AS po_line_id, pl.item_id, pl.item_name,
              pl.base_qty AS ordered, pl.base_received_qty AS received,
              (pl.base_qty - pl.base_received_qty) AS variance
         FROM po_lines pl
         JOIN purchase_orders po ON po.id ${C} = pl.po_id ${C}
         ${sqlWhere(q.where)}
        ORDER BY po.po_number, pl.id
        LIMIT 2000`, q.params);
    return H.sendData(res, rows, { filters: q.filters });
  } catch (e) { return H.sendErr(res, e); }
});

function matchingJoins() {
  return `
    LEFT JOIN supplier_invoice_matches m
      ON m.invoice_id ${C} = si.id ${C}
    LEFT JOIN purchase_receipt_lines prl
      ON prl.id ${C} = m.receipt_line_id ${C}
    LEFT JOIN purchase_receipts pr
      ON pr.id ${C} = COALESCE(prl.receipt_id ${C}, si.grn_id ${C})
    LEFT JOIN po_lines pol
      ON pol.id ${C} = m.po_line_id ${C}
    LEFT JOIN purchase_orders po
      ON po.id ${C} = COALESCE(pol.po_id ${C}, si.purchase_order_id ${C})`;
}

// GET /three-way-match — match variances split by the authoritative warehouse.
// Filtering happens before aggregation, so one allowed match line can never
// pull another warehouse's variance into the same invoice total.
router.get('/three-way-match', RPT, async (req, res) => {
  try {
    const q = scopedParts(req, MATCH_WAREHOUSE, 'si.issue_date');
    add(q.where, q.params, "si.status NOT IN ('cancelled','draft')");
    const [rows] = await db.query(
      `SELECT si.id AS invoice_id, si.code, si.invoice_no, si.supplier_name,
              si.issue_date, si.matching_status,
              ${MATCH_WAREHOUSE} AS warehouse_id,
              COALESCE(SUM(m.price_variance),0) AS price_variance,
              COALESCE(SUM(m.qty_variance),0) AS qty_variance
         FROM supplier_invoices si
         ${matchingJoins()}
         ${sqlWhere(q.where)}
        GROUP BY si.id, si.code, si.invoice_no, si.supplier_name,
                 si.issue_date, si.matching_status, ${MATCH_WAREHOUSE}
        ORDER BY si.issue_date DESC, si.code DESC
        LIMIT 2000`, q.params);
    return H.sendData(res, rows.map((row) => ({
      ...row,
      price_variance: calc.money(row.price_variance),
      qty_variance: calc.qty(row.qty_variance),
    })), { filters: q.filters });
  } catch (e) { return H.sendErr(res, e); }
});

// GET /ap-aging — outstanding supplier invoices as of a date. A future
// allocation is not allowed to reduce an earlier aging snapshot.
router.get('/ap-aging', RPT, async (req, res) => {
  try {
    const q = scopedParts(req, 'si.warehouse_id', null);
    const asOf = q.filters.asOfDate || q.filters.to || new Date().toISOString().slice(0, 10);
    // Paid/closed invoices stay in a historical as-of report: allocations made
    // after the selected date must not erase the liability that existed then.
    add(q.where, q.params, "si.status NOT IN ('cancelled','draft')");
    add(q.where, q.params, 'si.issue_date <= ?', [asOf]);
    if (req.query.supplierId) add(q.where, q.params, 'si.supplier_id = ?', [String(req.query.supplierId)]);
    const [rows] = await db.query(
      `SELECT si.id, si.supplier_id, si.supplier_name, si.due_date,
              DATEDIFF(?, si.due_date) AS age_days,
              si.total_amount, si.warehouse_id,
              COALESCE((
                SELECT SUM(pa.allocated_amount)
                  FROM payment_allocations pa
                 WHERE pa.supplier_invoice_id ${C} = si.id ${C}
                   AND pa.reversed = 0 AND pa.allocation_date <= ?
              ),0) AS paid
         FROM supplier_invoices si
         ${sqlWhere(q.where)}`, [asOf, asOf, ...q.params]);
    const bySupplier = {};
    const grand = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 };
    for (const row of rows) {
      const balance = calc.money(Number(row.total_amount) - Number(row.paid));
      if (balance <= 0) continue;
      const key = row.supplier_id || `UNLINKED:${row.supplier_name || ''}`;
      if (!bySupplier[key]) {
        bySupplier[key] = {
          supplierId: row.supplier_id,
          supplierName: row.supplier_name,
          current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0,
        };
      }
      const supplier = bySupplier[key];
      // MySQL compares calendar dates without applying the Node process/server
      // timezone.  That keeps 30/60/90-day bucket boundaries deterministic.
      const parsedAge = Number(row.age_days);
      const age = Number.isFinite(parsedAge) ? parsedAge : 0;
      let bucket = 'current';
      if (age > 90) bucket = 'd90plus';
      else if (age > 60) bucket = 'd90';
      else if (age > 30) bucket = 'd60';
      else if (age > 0) bucket = 'd30';
      supplier[bucket] += balance;
      supplier.total += balance;
      grand[bucket] += balance;
      grand.total += balance;
    }
    const list = Object.values(bySupplier).map((supplier) => {
      for (const key of ['current', 'd30', 'd60', 'd90', 'd90plus', 'total']) {
        supplier[key] = calc.money(supplier[key]);
      }
      return supplier;
    });
    for (const key of Object.keys(grand)) grand[key] = calc.money(grand[key]);
    if (String(req.query.format).toLowerCase() === 'csv') {
      return H.sendCsv(res, 'ap-aging.csv', list, [
        { key: 'supplierName', label: 'المورد' }, { key: 'current', label: 'جاري' },
        { key: 'd30', label: '1-30' }, { key: 'd60', label: '31-60' },
        { key: 'd90', label: '61-90' }, { key: 'd90plus', label: '90+' },
        { key: 'total', label: 'الإجمالي' },
      ]);
    }
    return H.sendData(res, list, { asOf, filters: q.filters, grandTotal: grand });
  } catch (e) { return H.sendErr(res, e); }
});

async function sumOne(sql, params, key) {
  const [rows] = await db.query(sql, params);
  return calc.money(rows[0] && rows[0][key]);
}

// GET /supplier-statement?supplierId=...
// Implemented here instead of redirecting to the older unscoped supplier
// endpoint. Invoice/payment rows use the invoice warehouse; returns use their
// own warehouse. NULL warehouse facts are hidden from a scoped caller.
router.get('/supplier-statement', RPT, async (req, res) => {
  try {
    if (!req.query.supplierId) throw err('VALIDATION_ERROR', 'supplierId مطلوب');
    const supplierId = String(req.query.supplierId);
    const f = S.parseReportFilters(req.query);
    const invScope = S.warehousePredicate(req.warehouseScope, 'si.warehouse_id', f.warehouseId);
    const retScope = S.warehousePredicate(req.warehouseScope, 'pret.warehouse_id', f.warehouseId);

    let opening = 0;
    if (f.from) {
      const invoiceOpening = await sumOne(
        `SELECT COALESCE(SUM(si.total_amount),0) value
           FROM supplier_invoices si
          WHERE si.supplier_id = ? AND si.status NOT IN ('cancelled','draft')
            AND si.issue_date < ?${invScope.sql}`,
        [supplierId, f.from, ...invScope.params], 'value');
      const paymentOpening = await sumOne(
        `SELECT COALESCE(SUM(pa.allocated_amount),0) value
           FROM payment_allocations pa
           JOIN supplier_invoices si
             ON si.id ${C} = pa.supplier_invoice_id ${C}
          WHERE si.supplier_id = ? AND pa.reversed = 0
            AND pa.allocation_date < ?${invScope.sql}`,
        [supplierId, f.from, ...invScope.params], 'value');
      const returnOpening = await sumOne(
        `SELECT COALESCE(SUM(pret.total),0) value
           FROM purchase_returns pret
          WHERE pret.supplier_id = ? AND pret.status IN ('posted','settled')
            AND pret.phase = ? AND pret.return_date < ?${retScope.sql}`,
        [supplierId, AP_RETURN_PHASE, f.from, ...retScope.params], 'value');
      opening = calc.money(invoiceOpening - paymentOpening - returnOpening);
    }

    const invWhere = ['si.supplier_id = ?', "si.status NOT IN ('cancelled','draft')"];
    const invParams = [supplierId];
    S.appendPredicate(invWhere, invParams, S.datePredicate('si.issue_date', f.from, f.to));
    S.appendPredicate(invWhere, invParams, invScope);
    const [invoices] = await db.query(
      `SELECT si.id, si.code, si.invoice_no, si.issue_date AS date, si.total_amount
         FROM supplier_invoices si WHERE ${invWhere.join(' AND ')}`, invParams);

    const payWhere = ['si.supplier_id = ?', 'pa.reversed = 0'];
    const payParams = [supplierId];
    if (f.from) add(payWhere, payParams, 'pa.allocation_date >= ?', [f.from]);
    if (f.to) add(payWhere, payParams, 'pa.allocation_date <= ?', [f.to]);
    S.appendPredicate(payWhere, payParams, invScope);
    const [payments] = await db.query(
      `SELECT pa.id, pa.payment_id, pa.allocation_date AS date,
              pa.allocated_amount, payment.payment_number
         FROM payment_allocations pa
         JOIN supplier_invoices si
           ON si.id ${C} = pa.supplier_invoice_id ${C}
         LEFT JOIN payment_records payment
           ON payment.id ${C} = pa.payment_id ${C}
        WHERE ${payWhere.join(' AND ')}`, payParams);

    const returnWhere = ['pret.supplier_id = ?', "pret.status IN ('posted','settled')"];
    const returnParams = [supplierId];
    add(returnWhere, returnParams, 'pret.phase = ?', [AP_RETURN_PHASE]);
    S.appendPredicate(returnWhere, returnParams, S.datePredicate('pret.return_date', f.from, f.to));
    S.appendPredicate(returnWhere, returnParams, retScope);
    const [returns] = await db.query(
      `SELECT pret.id, pret.return_number, pret.credit_note_no,
              pret.return_date AS date, pret.total
         FROM purchase_returns pret WHERE ${returnWhere.join(' AND ')}`, returnParams);

    const lines = [];
    for (const row of invoices) lines.push({
      id: row.id, date: row.date, type: 'invoice', ref: row.invoice_no || row.code,
      debit: calc.money(row.total_amount), credit: 0,
    });
    for (const row of returns) lines.push({
      id: row.id, date: row.date, type: 'return',
      ref: row.credit_note_no || row.return_number || row.id,
      debit: 0, credit: calc.money(row.total),
    });
    for (const row of payments) lines.push({
      id: row.id, date: row.date, type: 'payment',
      ref: row.payment_number || row.payment_id,
      debit: 0, credit: calc.money(row.allocated_amount),
    });
    const order = { invoice: 0, return: 1, payment: 2 };
    lines.sort((a, b) => String(a.date).localeCompare(String(b.date))
      || order[a.type] - order[b.type] || String(a.id).localeCompare(String(b.id)));
    let running = opening;
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of lines) {
      totalDebit += line.debit;
      totalCredit += line.credit;
      running = calc.money(running + line.debit - line.credit);
      line.balance = running;
    }
    if (String(req.query.format).toLowerCase() === 'csv') {
      const rows = f.from
        ? [{ date: f.from, type: 'opening', ref: 'رصيد افتتاحي', debit: 0, credit: 0, balance: opening }, ...lines]
        : lines;
      return H.sendCsv(res, `supplier-statement-${supplierId}.csv`, rows, [
        { key: 'date', label: 'التاريخ' }, { key: 'type', label: 'النوع' },
        { key: 'ref', label: 'المرجع' }, { key: 'debit', label: 'مدين' },
        { key: 'credit', label: 'دائن' }, { key: 'balance', label: 'الرصيد' },
      ]);
    }
    return H.sendData(res, lines, {
      from: f.from || null, to: f.to || null, opening, closingBalance: running,
      filters: f,
      totals: { debit: calc.money(totalDebit), credit: calc.money(totalCredit) },
    });
  } catch (e) { return H.sendErr(res, e); }
});

// ONLY_FULL_GROUP_BY-safe purchase-analysis query builder. The exported global
// constant stays available for the existing strict-mode integration test; the
// route itself always uses the scoped builder below.
const PA_COLLATE = 'COLLATE utf8mb4_unicode_ci';
function purchaseAnalysisSql(extraWhere) {
  return `SELECT agg.supplier_id,
          COALESCE(s.name ${PA_COLLATE}, agg.snapshot_name ${PA_COLLATE}) AS supplier_name,
          agg.invoices,
          agg.spend
     FROM (
       SELECT si.supplier_id,
              COUNT(*) AS invoices,
              COALESCE(SUM(si.total_amount),0) AS spend,
              MAX(si.supplier_name) AS snapshot_name
         FROM supplier_invoices si
        WHERE si.status NOT IN ('cancelled','draft')${extraWhere || ''}
        GROUP BY si.supplier_id
     ) agg
     LEFT JOIN suppliers s
       ON s.id ${PA_COLLATE} = agg.supplier_id ${PA_COLLATE}
    ORDER BY agg.spend DESC
    LIMIT 500`;
}
const PURCHASE_ANALYSIS_SQL = purchaseAnalysisSql('');

function buildPurchaseAnalysisQuery(req) {
  const f = S.parseReportFilters(req.query);
  const date = S.datePredicate('si.issue_date', f.from, f.to);
  const scope = S.warehousePredicate(req.warehouseScope, 'si.warehouse_id', f.warehouseId);
  return {
    sql: purchaseAnalysisSql(`${date.sql}${scope.sql}`),
    params: [...date.params, ...scope.params],
    filters: f,
  };
}

router.get('/purchase-analysis', RPT, async (req, res) => {
  try {
    const q = buildPurchaseAnalysisQuery(req);
    const [rows] = await db.query(q.sql, q.params);
    return H.sendData(res, rows.map((row) => ({ ...row, spend: calc.money(row.spend) })), {
      filters: q.filters,
      totals: { spend: calc.money(rows.reduce((sum, row) => sum + Number(row.spend), 0)) },
    });
  } catch (e) { return H.sendErr(res, e); }
});

// GET /price-variance — PPV per matched line, scoped using the same resolved
// warehouse chain as three-way match.
router.get('/price-variance', RPT, async (req, res) => {
  try {
    const q = scopedParts(req, MATCH_WAREHOUSE, 'si.issue_date');
    add(q.where, q.params, 'ABS(m.price_variance) > 0');
    add(q.where, q.params, "si.status NOT IN ('cancelled','draft')");
    const [rows] = await db.query(
      `SELECT si.id AS invoice_id, si.code, si.invoice_no, si.supplier_name,
              si.issue_date, m.id AS match_id, m.matched_qty,
              m.matched_amount, m.price_variance,
              ${MATCH_WAREHOUSE} AS warehouse_id
         FROM supplier_invoices si
         JOIN supplier_invoice_matches m
           ON m.invoice_id ${C} = si.id ${C}
         LEFT JOIN purchase_receipt_lines prl
           ON prl.id ${C} = m.receipt_line_id ${C}
         LEFT JOIN purchase_receipts pr
           ON pr.id ${C} = COALESCE(prl.receipt_id ${C}, si.grn_id ${C})
         LEFT JOIN po_lines pol
           ON pol.id ${C} = m.po_line_id ${C}
         LEFT JOIN purchase_orders po
           ON po.id ${C} = COALESCE(pol.po_id ${C}, si.purchase_order_id ${C})
         ${sqlWhere(q.where)}
        ORDER BY ABS(m.price_variance) DESC, si.code DESC
        LIMIT 1000`, q.params);
    return H.sendData(res, rows.map((row) => ({
      ...row,
      matched_amount: calc.money(row.matched_amount),
      price_variance: calc.money(row.price_variance),
    })), { filters: q.filters });
  } catch (e) { return H.sendErr(res, e); }
});

// GET /tax — input VAT by invoice period and warehouse scope.
router.get('/tax', RPT, async (req, res) => {
  try {
    const q = scopedParts(req, 'si.warehouse_id', 'si.issue_date');
    add(q.where, q.params, "si.status NOT IN ('cancelled','draft')");
    const [rows] = await db.query(
      `SELECT DATE_FORMAT(si.issue_date,'%Y-%m') AS period,
              COALESCE(SUM(si.subtotal),0) AS net,
              COALESCE(SUM(si.vat_amount),0) AS input_vat
         FROM supplier_invoices si
         ${sqlWhere(q.where)}
        GROUP BY DATE_FORMAT(si.issue_date,'%Y-%m')
        ORDER BY period DESC
        LIMIT 36`, q.params);
    return H.sendData(res, rows.map((row) => ({
      period: row.period,
      net: calc.money(row.net),
      inputVat: calc.money(row.input_vat),
    })), { filters: q.filters });
  } catch (e) { return H.sendErr(res, e); }
});

// GET /data-quality — procurement anomalies only. The old implementation read
// the global AP view and every GL journal, which disclosed company-wide counts
// to a warehouse-scoped user. All four checks now start from scoped invoices.
router.get('/data-quality', DATA_QUALITY_RPT, async (req, res) => {
  try {
    const q = scopedParts(req, 'si.warehouse_id', 'si.issue_date');
    const base = q.where.slice();
    const baseParams = q.params.slice();
    const checks = {};

    const freeWhere = base.concat(["(si.supplier_id IS NULL OR si.supplier_id='')", "si.status <> 'cancelled'"]);
    const [freeName] = await db.query(
      `SELECT COUNT(*) c FROM supplier_invoices si WHERE ${freeWhere.join(' AND ')}`,
      baseParams);
    checks.invoicesWithoutSupplier = Number(freeName[0].c);

    const negativeWhere = base.concat(["si.status NOT IN ('cancelled','draft')"]);
    const [negative] = await db.query(
      `SELECT COUNT(*) c FROM (
         SELECT si.supplier_id,
                COALESCE(SUM(si.total_amount),0) - COALESCE(SUM(pa.paid),0) AS ap_balance
           FROM supplier_invoices si
           LEFT JOIN (
             SELECT supplier_invoice_id, SUM(allocated_amount) AS paid
               FROM payment_allocations
              WHERE reversed = 0
              GROUP BY supplier_invoice_id
           ) pa ON pa.supplier_invoice_id ${C} = si.id ${C}
          WHERE ${negativeWhere.join(' AND ')}
          GROUP BY si.supplier_id
         HAVING COALESCE(SUM(si.total_amount),0) - COALESCE(SUM(pa.paid),0) < -0.01
       ) scoped_negative`, baseParams);
    checks.suppliersNegativeBalance = Number(negative[0].c);

    const duplicateWhere = base.concat(["si.invoice_no IS NOT NULL", "si.status <> 'cancelled'"]);
    const [duplicates] = await db.query(
      `SELECT COUNT(*) c FROM (
         SELECT si.supplier_id, si.invoice_no
           FROM supplier_invoices si
          WHERE ${duplicateWhere.join(' AND ')}
          GROUP BY si.supplier_id, si.invoice_no
         HAVING COUNT(*) > 1
       ) scoped_duplicates`, baseParams);
    checks.duplicateInvoiceNumbers = Number(duplicates[0].c);

    const journalWhere = base.concat(['si.gl_journal_id IS NOT NULL', 'ABS(gj.total_debit - gj.total_credit) > 0.01']);
    const [unbalanced] = await db.query(
      `SELECT COUNT(DISTINCT gj.id) c
         FROM supplier_invoices si
         JOIN gl_journals gj ON gj.id ${C} = si.gl_journal_id ${C}
        WHERE ${journalWhere.join(' AND ')}`, baseParams);
    checks.unbalancedJournals = Number(unbalanced[0].c);

    return H.sendData(res, checks, { filters: q.filters });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
module.exports.PURCHASE_ANALYSIS_SQL = PURCHASE_ANALYSIS_SQL;
module.exports.buildPurchaseAnalysisQuery = buildPurchaseAnalysisQuery;
module.exports.MATCH_WAREHOUSE = MATCH_WAREHOUSE;
module.exports.REPORT_READ_CAPS = REPORT_READ_CAPS;
module.exports.DATA_QUALITY_READ_CAPS = DATA_QUALITY_READ_CAPS;
module.exports.AP_RETURN_PHASE = AP_RETURN_PHASE;
module.exports.OPEN_ORDER_QTY = OPEN_ORDER_QTY;
module.exports.OPEN_ORDER_VALUE = OPEN_ORDER_VALUE;
