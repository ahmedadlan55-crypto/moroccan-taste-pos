/**
 * services/order-to-cash/O2CReportingService.js — Order-to-Cash reports (spec §9).
 * ALL SQL is ONLY_FULL_GROUP_BY-safe: every selected column is either an aggregate
 * or appears in GROUP BY (or is derived via a grouped subquery then joined — the
 * same shape as the procurement purchase-analysis fix). Totals are computed over
 * the WHOLE filtered set (pagination never changes them). Riyadh calendar dates.
 *
 * Reports: sales-summary, sales-by-customer, sales-by-product, sales-by-channel,
 * sales-by-cashier, ar-aging (BY DUE DATE), open-invoices, collections,
 * unallocated-payments, credit-exposure, returns, zatca-status, data-quality,
 * customer-statement (delegated).
 */
'use strict';

const db = require('../../db/connection');
const { err } = require('../../lib/order-to-cash/errors');
const calc = require('../../lib/order-to-cash/calculations');
const Statement = require('./CustomerStatementService');

const money = calc.money;
const C = 'COLLATE utf8mb4_unicode_ci';

function _range(params) {
  return {
    from: params.from ? calc.ymd(params.from) : '2000-01-01',
    to: params.to ? calc.ymd(params.to) : calc.ymd(new Date()),
  };
}
const INVOICE_LIVE = "document_type='invoice' AND status NOT IN ('cancelled','draft')";

async function salesSummary(params, conn) {
  const { from, to } = _range(params);
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS invoices, COALESCE(SUM(subtotal),0) AS net,
            COALESCE(SUM(vat_amount),0) AS vat, COALESCE(SUM(total_amount),0) AS total,
            COALESCE(SUM(paid_amount),0) AS collected, COALESCE(SUM(balance_amount),0) AS outstanding
       FROM ar_documents WHERE ${INVOICE_LIVE} AND issue_date BETWEEN ? AND ?`, [from, to]);
  const [[ret]] = [await conn.query(
    `SELECT COALESCE(SUM(total_amount),0) AS returns FROM sales_returns WHERE status='posted' AND return_date BETWEEN ? AND ?`, [from, to])];
  const r = rows[0];
  const net = money(r.net), returns = money(ret.returns);
  return {
    columns: [{ key: 'metric', label: 'المؤشر' }, { key: 'value', label: 'القيمة' }],
    rows: [
      { metric: 'عدد الفواتير', value: Number(r.invoices) },
      { metric: 'صافي المبيعات', value: net },
      { metric: 'الضريبة', value: money(r.vat) },
      { metric: 'الإجمالي', value: money(r.total) },
      { metric: 'المرتجعات', value: returns },
      { metric: 'صافي المبيعات بعد المرتجعات', value: money(net - returns) },
      { metric: 'المُحصّل', value: money(r.collected) },
      { metric: 'المتبقّي (ذمم)', value: money(r.outstanding) },
    ],
    totals: { net, returns, netAfterReturns: money(net - returns), total: money(r.total), outstanding: money(r.outstanding) },
  };
}

async function salesByCustomer(params, conn) {
  const { from, to } = _range(params);
  const [rows] = await conn.query(
    `SELECT agg.customer_id, COALESCE(c.name, agg.customer_name, '—') AS customer_name,
            agg.invoices, agg.net, agg.vat, agg.total
       FROM (
         SELECT customer_id, MAX(customer_name) AS customer_name, COUNT(*) AS invoices,
                SUM(subtotal) AS net, SUM(vat_amount) AS vat, SUM(total_amount) AS total
           FROM ar_documents WHERE ${INVOICE_LIVE} AND issue_date BETWEEN ? AND ?
          GROUP BY customer_id
       ) agg
       LEFT JOIN customers c ON c.id ${C} = agg.customer_id ${C}
       ORDER BY agg.total DESC`, [from, to]);
  return {
    columns: [{ key: 'customer_name', label: 'العميل' }, { key: 'invoices', label: 'الفواتير' }, { key: 'net', label: 'الصافي' }, { key: 'vat', label: 'الضريبة' }, { key: 'total', label: 'الإجمالي' }],
    rows: rows.map((r) => ({ customerId: r.customer_id, customer_name: r.customer_name, invoices: Number(r.invoices), net: money(r.net), vat: money(r.vat), total: money(r.total) })),
    totals: { total: money(rows.reduce((s, r) => s + Number(r.total), 0)), net: money(rows.reduce((s, r) => s + Number(r.net), 0)) },
  };
}

async function salesByProduct(params, conn) {
  const { from, to } = _range(params);
  const [rows] = await conn.query(
    `SELECT l.item_id, l.menu_id, MAX(l.description) AS description,
            SUM(l.base_qty) AS qty, SUM(l.net_amount) AS net, SUM(l.vat_amount) AS vat
       FROM ar_document_lines l JOIN ar_documents d ON d.id = l.document_id
      WHERE d.document_type='invoice' AND d.status NOT IN ('cancelled','draft') AND d.issue_date BETWEEN ? AND ?
      GROUP BY l.item_id, l.menu_id ORDER BY net DESC`, [from, to]);
  return {
    columns: [{ key: 'description', label: 'الصنف' }, { key: 'qty', label: 'الكمية' }, { key: 'net', label: 'الصافي' }, { key: 'vat', label: 'الضريبة' }],
    rows: rows.map((r) => ({ itemId: r.item_id, menuId: r.menu_id, description: r.description, qty: calc.qty(r.qty), net: money(r.net), vat: money(r.vat) })),
    totals: { net: money(rows.reduce((s, r) => s + Number(r.net), 0)) },
  };
}

async function salesByChannel(params, conn) {
  const { from, to } = _range(params);
  const [rows] = await conn.query(
    `SELECT COALESCE(channel_id,'—') AS channel_id, COUNT(*) AS invoices, SUM(subtotal) AS net, SUM(total_amount) AS total
       FROM ar_documents WHERE ${INVOICE_LIVE} AND issue_date BETWEEN ? AND ?
      GROUP BY channel_id ORDER BY total DESC`, [from, to]);
  return {
    columns: [{ key: 'channel_id', label: 'القناة' }, { key: 'invoices', label: 'الفواتير' }, { key: 'net', label: 'الصافي' }, { key: 'total', label: 'الإجمالي' }],
    rows: rows.map((r) => ({ channel_id: r.channel_id, invoices: Number(r.invoices), net: money(r.net), total: money(r.total) })),
    totals: { total: money(rows.reduce((s, r) => s + Number(r.total), 0)) },
  };
}

async function salesByCashier(params, conn) {
  const { from, to } = _range(params);
  // cashier = POS sale username where linked, else the AR doc creator
  const [rows] = await conn.query(
    `SELECT cashier, COUNT(*) AS invoices, SUM(total) AS total FROM (
        SELECT COALESCE(s.username, d.created_by, '—') AS cashier, d.total_amount AS total
          FROM ar_documents d LEFT JOIN sales s ON d.source_type='pos' AND s.id ${C} = d.source_id ${C}
         WHERE d.document_type='invoice' AND d.status NOT IN ('cancelled','draft') AND d.issue_date BETWEEN ? AND ?
     ) t GROUP BY cashier ORDER BY total DESC`, [from, to]);
  return {
    columns: [{ key: 'cashier', label: 'الكاشير' }, { key: 'invoices', label: 'الفواتير' }, { key: 'total', label: 'الإجمالي' }],
    rows: rows.map((r) => ({ cashier: r.cashier, invoices: Number(r.invoices), total: money(r.total) })),
    totals: { total: money(rows.reduce((s, r) => s + Number(r.total), 0)) },
  };
}

async function arAging(params, conn) {
  const asOf = params.asOf ? calc.ymd(params.asOf) : calc.ymd(new Date());
  const [rows] = await conn.query(
    `SELECT d.customer_id, COALESCE(c.name, d.customer_name, '—') AS customer_name, d.document_number,
            d.issue_date, d.due_date, d.balance_amount
       FROM ar_documents d LEFT JOIN customers c ON c.id ${C} = d.customer_id ${C}
      WHERE d.document_type='invoice' AND d.status IN ('issued','partially_paid') AND d.balance_amount > 0.01`);
  const byCustomer = {};
  const totals = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_120: 0, d120_plus: 0, total: 0 };
  for (const r of rows) {
    const due = r.due_date ? calc.ymd(r.due_date) : calc.ymd(r.issue_date);
    const bucket = calc.agingBucket(calc.daysBetween(due, asOf));
    const key = r.customer_id || '—';
    if (!byCustomer[key]) byCustomer[key] = { customerId: r.customer_id, customer_name: r.customer_name, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_120: 0, d120_plus: 0, total: 0 };
    const bal = Number(r.balance_amount);
    byCustomer[key][bucket] += bal; byCustomer[key].total += bal;
    totals[bucket] += bal; totals.total += bal;
  }
  const rowsOut = Object.values(byCustomer).map((r) => {
    for (const k of ['current', 'd1_30', 'd31_60', 'd61_90', 'd91_120', 'd120_plus', 'total']) r[k] = money(r[k]);
    return r;
  }).sort((a, b) => b.total - a.total);
  for (const k of Object.keys(totals)) totals[k] = money(totals[k]);
  return {
    columns: [{ key: 'customer_name', label: 'العميل' }, { key: 'current', label: 'جاري' }, { key: 'd1_30', label: '1-30' }, { key: 'd31_60', label: '31-60' }, { key: 'd61_90', label: '61-90' }, { key: 'd91_120', label: '91-120' }, { key: 'd120_plus', label: '+120' }, { key: 'total', label: 'الإجمالي' }],
    rows: rowsOut, totals, asOf,
  };
}

async function openInvoices(params, conn) {
  const [rows] = await conn.query(
    `SELECT d.id, d.document_number, COALESCE(c.name, d.customer_name,'—') AS customer_name, d.issue_date, d.due_date,
            d.total_amount, d.paid_amount, d.balance_amount
       FROM ar_documents d LEFT JOIN customers c ON c.id ${C} = d.customer_id ${C}
      WHERE d.document_type='invoice' AND d.status IN ('issued','partially_paid') AND d.balance_amount > 0.01
      ORDER BY d.due_date ASC`);
  return {
    columns: [{ key: 'document_number', label: 'الفاتورة' }, { key: 'customer_name', label: 'العميل' }, { key: 'due_date', label: 'الاستحقاق' }, { key: 'total_amount', label: 'الإجمالي' }, { key: 'balance_amount', label: 'المتبقّي' }],
    rows: rows.map((r) => ({ id: r.id, document_number: r.document_number, customer_name: r.customer_name, issue_date: calc.ymd(r.issue_date), due_date: r.due_date ? calc.ymd(r.due_date) : null, total_amount: money(r.total_amount), paid_amount: money(r.paid_amount), balance_amount: money(r.balance_amount) })),
    totals: { balance: money(rows.reduce((s, r) => s + Number(r.balance_amount), 0)) },
  };
}

async function collections(params, conn) {
  const { from, to } = _range(params);
  const [rows] = await conn.query(
    `SELECT cp.id, cp.payment_number, COALESCE(c.name, cp.customer_name,'—') AS customer_name, cp.payment_date,
            cp.payment_method, cp.destination_type, cp.amount, cp.allocated_amount, cp.unapplied_amount, cp.status
       FROM customer_payments cp LEFT JOIN customers c ON c.id ${C} = cp.customer_id ${C}
      WHERE cp.status='posted' AND cp.payment_date BETWEEN ? AND ? ORDER BY cp.payment_date DESC`, [from, to]);
  return {
    columns: [{ key: 'payment_number', label: 'السند' }, { key: 'customer_name', label: 'العميل' }, { key: 'payment_date', label: 'التاريخ' }, { key: 'amount', label: 'المبلغ' }, { key: 'allocated_amount', label: 'المخصّص' }],
    rows: rows.map((r) => ({ id: r.id, payment_number: r.payment_number, customer_name: r.customer_name, payment_date: calc.ymd(r.payment_date), amount: money(r.amount), allocated_amount: money(r.allocated_amount), unapplied_amount: money(r.unapplied_amount), method: r.payment_method })),
    totals: { total: money(rows.reduce((s, r) => s + Number(r.amount), 0)) },
  };
}

async function unallocatedPayments(params, conn) {
  const [rows] = await conn.query(
    `SELECT cp.id, cp.payment_number, COALESCE(c.name, cp.customer_name,'—') AS customer_name, cp.payment_date, cp.unapplied_amount
       FROM customer_payments cp LEFT JOIN customers c ON c.id ${C} = cp.customer_id ${C}
      WHERE cp.status='posted' AND cp.unapplied_amount > 0.01 ORDER BY cp.unapplied_amount DESC`);
  return {
    columns: [{ key: 'payment_number', label: 'السند' }, { key: 'customer_name', label: 'العميل' }, { key: 'unapplied_amount', label: 'غير مخصّص' }],
    rows: rows.map((r) => ({ id: r.id, payment_number: r.payment_number, customer_name: r.customer_name, payment_date: calc.ymd(r.payment_date), unapplied_amount: money(r.unapplied_amount) })),
    totals: { total: money(rows.reduce((s, r) => s + Number(r.unapplied_amount), 0)) },
  };
}

async function creditExposure(params, conn) {
  const [rows] = await conn.query(
    `SELECT c.id, c.name, c.credit_limit, COALESCE(b.ar_balance,0) AS exposure
       FROM customers c LEFT JOIN v_customer_ar_balance b ON b.customer_id ${C} = c.id ${C}
      WHERE c.credit_limit > 0 OR COALESCE(b.ar_balance,0) > 0
      ORDER BY exposure DESC`);
  return {
    columns: [{ key: 'name', label: 'العميل' }, { key: 'credit_limit', label: 'الحد' }, { key: 'exposure', label: 'التعرّض' }, { key: 'available', label: 'المتاح' }],
    rows: rows.map((r) => ({ id: r.id, name: r.name, credit_limit: money(r.credit_limit), exposure: money(r.exposure), available: money(Number(r.credit_limit) - Number(r.exposure)), over: Number(r.exposure) > Number(r.credit_limit) && Number(r.credit_limit) > 0 })),
    totals: { exposure: money(rows.reduce((s, r) => s + Number(r.exposure), 0)) },
  };
}

async function returnsReport(params, conn) {
  const { from, to } = _range(params);
  const [rows] = await conn.query(
    `SELECT sr.id, sr.return_number, COALESCE(c.name, sr.customer_name,'—') AS customer_name, sr.return_date,
            sr.subtotal, sr.vat_amount, sr.total_amount, sr.refund_method, sr.status
       FROM sales_returns sr LEFT JOIN customers c ON c.id ${C} = sr.customer_id ${C}
      WHERE sr.status='posted' AND sr.return_date BETWEEN ? AND ? ORDER BY sr.return_date DESC`, [from, to]);
  return {
    columns: [{ key: 'return_number', label: 'المرتجع' }, { key: 'customer_name', label: 'العميل' }, { key: 'return_date', label: 'التاريخ' }, { key: 'total_amount', label: 'الإجمالي' }, { key: 'refund_method', label: 'طريقة الرد' }],
    rows: rows.map((r) => ({ id: r.id, return_number: r.return_number, customer_name: r.customer_name, return_date: calc.ymd(r.return_date), subtotal: money(r.subtotal), vat_amount: money(r.vat_amount), total_amount: money(r.total_amount), refund_method: r.refund_method })),
    totals: { total: money(rows.reduce((s, r) => s + Number(r.total_amount), 0)) },
  };
}

async function zatcaStatus(params, conn) {
  const [rows] = await conn.query(
    `SELECT zatca_status, COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS total
       FROM ar_documents WHERE document_type IN ('invoice','credit_note') AND status NOT IN ('cancelled','draft')
      GROUP BY zatca_status ORDER BY n DESC`);
  return {
    columns: [{ key: 'zatca_status', label: 'حالة زاتكا' }, { key: 'n', label: 'العدد' }, { key: 'total', label: 'الإجمالي' }],
    rows: rows.map((r) => ({ zatca_status: r.zatca_status, n: Number(r.n), total: money(r.total) })),
    totals: { count: rows.reduce((s, r) => s + Number(r.n), 0) },
  };
}

async function dataQuality(params, conn) {
  const issues = [];
  const [[a]] = [await conn.query(`SELECT COUNT(*) AS n FROM customers WHERE customer_type<>'B2C' AND (vat_number IS NULL OR vat_number='') AND deleted_at IS NULL`)];
  issues.push({ issue: 'عملاء B2B/B2G بدون رقم ضريبي', count: Number(a[0].n) });
  const [[b]] = [await conn.query(`SELECT COUNT(*) AS n FROM ar_documents WHERE document_type='invoice' AND status IN ('issued','partially_paid') AND (due_date IS NULL)`)];
  issues.push({ issue: 'فواتير مفتوحة بلا تاريخ استحقاق', count: Number(b[0].n) });
  const [[c]] = [await conn.query(`SELECT COUNT(*) AS n FROM ar_documents WHERE balance_amount < -0.01`)];
  issues.push({ issue: 'فواتير برصيد سالب', count: Number(c[0].n) });
  const [[d]] = [await conn.query(`SELECT COUNT(*) AS n FROM customer_payments WHERE status='posted' AND unapplied_amount > 0.01`)];
  issues.push({ issue: 'دفعات مُرحّلة غير مخصّصة', count: Number(d[0].n) });
  const [[e]] = [await conn.query(`SELECT COUNT(*) AS n FROM ar_documents WHERE document_type='invoice' AND status IN ('issued','partially_paid') AND (zatca_status='pending')`)];
  issues.push({ issue: 'فواتير بانتظار زاتكا', count: Number(e[0].n) });
  return {
    columns: [{ key: 'issue', label: 'الملاحظة' }, { key: 'count', label: 'العدد' }],
    rows: issues,
    totals: { totalIssues: issues.reduce((s, r) => s + r.count, 0) },
  };
}

const REPORTS = {
  'sales-summary': salesSummary,
  'sales-by-customer': salesByCustomer,
  'sales-by-product': salesByProduct,
  'sales-by-channel': salesByChannel,
  'sales-by-cashier': salesByCashier,
  'ar-aging': arAging,
  'open-invoices': openInvoices,
  collections,
  'unallocated-payments': unallocatedPayments,
  'credit-exposure': creditExposure,
  returns: returnsReport,
  'zatca-status': zatcaStatus,
  'data-quality': dataQuality,
};

async function run(type, params = {}, conn = db) {
  if (type === 'customer-statement') {
    if (!params.customerId) throw err('VALIDATION_ERROR', 'العميل مطلوب لكشف الحساب');
    const s = await Statement.statement(params.customerId, params, conn);
    return {
      columns: [{ key: 'date', label: 'التاريخ' }, { key: 'ref', label: 'المرجع' }, { key: 'kind', label: 'النوع' }, { key: 'amount', label: 'الحركة' }, { key: 'balance', label: 'الرصيد' }],
      rows: s.lines, totals: { opening: s.opening, closing: s.closing },
    };
  }
  const fn = REPORTS[type];
  if (!fn) throw err('VALIDATION_ERROR', 'نوع تقرير غير معروف: ' + type);
  return fn(params, conn);
}

module.exports = { run, REPORTS: Object.keys(REPORTS).concat(['customer-statement']) };
