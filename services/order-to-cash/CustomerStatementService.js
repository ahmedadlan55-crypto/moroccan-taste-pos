/**
 * services/order-to-cash/CustomerStatementService.js — customer statement +
 * Customer 360 (spec §Customer 360). The statement is a running-balance ledger of
 * invoices (+), credit notes (−) and collections (−). Customer 360 is a single
 * aggregated snapshot (a bounded set of grouped queries — never N+1): profile,
 * derived balance, credit exposure, open invoices, collections, recent sales,
 * returns, AR aging BY DUE DATE, top products (net of returns), and data-quality
 * warnings. Riyadh calendar dates throughout (the pool session is +03:00).
 */
'use strict';

const db = require('../../db/connection');
const { err } = require('../../lib/order-to-cash/errors');
const calc = require('../../lib/order-to-cash/calculations');
const CustomerService = require('./CustomerService');
const CreditLimitService = require('./CreditLimitService');

const money = calc.money;

async function _ensureCustomer(conn, customerId) {
  const [c] = await conn.query('SELECT * FROM customers WHERE id = ? LIMIT 1', [customerId]);
  if (!c.length) throw err('NOT_FOUND', 'العميل غير موجود');
  return CustomerService._shape(c[0]);
}

/** Running-balance statement between [from, to]. */
async function statement(customerId, opts = {}, conn = db) {
  await _ensureCustomer(conn, customerId);
  const from = opts.from ? calc.ymd(opts.from) : '2000-01-01';
  const to = opts.to ? calc.ymd(opts.to) : calc.ymd(new Date());

  // opening balance = net docs − allocations strictly before `from`
  const [[ob]] = [await conn.query(
    `SELECT
       (SELECT COALESCE(SUM(CASE WHEN document_type='credit_note' THEN -total_amount ELSE total_amount END),0)
          FROM ar_documents WHERE customer_id = ? AND status NOT IN ('cancelled','draft') AND issue_date < ?)
       -
       (SELECT COALESCE(SUM(pa.allocated_amount),0)
          FROM ar_payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
         WHERE pa.customer_id = ? AND pa.reversed = 0 AND cp.payment_date < ?) AS opening`,
    [customerId, from, customerId, from])];
  const opening = money(ob[0].opening);

  const [docs] = await conn.query(
    `SELECT issue_date AS d, document_number AS ref, document_type AS kind,
            CASE WHEN document_type='credit_note' THEN -total_amount ELSE total_amount END AS amount
       FROM ar_documents
      WHERE customer_id = ? AND status NOT IN ('cancelled','draft') AND issue_date BETWEEN ? AND ?`,
    [customerId, from, to]);
  const [pays] = await conn.query(
    `SELECT cp.payment_date AS d, cp.payment_number AS ref, 'payment' AS kind, -pa.allocated_amount AS amount
       FROM ar_payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
      WHERE pa.customer_id = ? AND pa.reversed = 0 AND cp.payment_date BETWEEN ? AND ?`,
    [customerId, from, to]);

  const rows = docs.concat(pays)
    .map((r) => ({ date: calc.ymd(r.d), ref: r.ref, kind: r.kind, amount: money(r.amount) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let running = opening;
  const lines = rows.map((r) => { running = money(running + r.amount); return Object.assign({}, r, { balance: running }); });
  return { customerId, from, to, opening, closing: running, lines };
}

/** AR aging BY DUE DATE for a single customer. */
async function aging(customerId, asOf, conn = db) {
  const as = asOf ? calc.ymd(asOf) : calc.ymd(new Date());
  const [rows] = await conn.query(
    `SELECT id, document_number, issue_date, due_date, balance_amount
       FROM ar_documents
      WHERE customer_id = ? AND document_type <> 'credit_note'
        AND status IN ('issued','partially_paid') AND balance_amount > 0.01`,
    [customerId]);
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_120: 0, d120_plus: 0 };
  for (const r of rows) {
    const due = r.due_date ? calc.ymd(r.due_date) : calc.ymd(r.issue_date);
    const past = calc.daysBetween(due, as);
    buckets[calc.agingBucket(past)] += Number(r.balance_amount);
  }
  for (const k of Object.keys(buckets)) buckets[k] = money(buckets[k]);
  return { asOf: as, buckets, openCount: rows.length, total: money(Object.values(buckets).reduce((s, v) => s + v, 0)) };
}

/** Customer 360 — one aggregated snapshot. */
async function customer360(customerId, conn = db) {
  const customer = await _ensureCustomer(conn, customerId);
  const derived = await CustomerService.derivedBalance(conn, customerId);
  const exposure = await CreditLimitService.exposure(customerId, conn);

  const [[openInv]] = [await conn.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount),0) AS bal FROM ar_documents
      WHERE customer_id = ? AND document_type<>'credit_note' AND status IN ('issued','partially_paid') AND balance_amount > 0.01`, [customerId])];
  const [[collAgg]] = [await conn.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM customer_payments
      WHERE customer_id = ? AND status='posted'`, [customerId])];
  const [[unalloc]] = [await conn.query(
    `SELECT COALESCE(SUM(unapplied_amount),0) AS total FROM customer_payments WHERE customer_id = ? AND status='posted'`, [customerId])];
  const [recentSales] = await conn.query(
    `SELECT id, document_number, issue_date, total_amount, status FROM ar_documents
      WHERE customer_id = ? AND document_type='invoice' ORDER BY issue_date DESC, id DESC LIMIT 10`, [customerId]);
  const [returns] = await conn.query(
    `SELECT id, return_number, return_date, total_amount, status FROM sales_returns
      WHERE customer_id = ? ORDER BY return_date DESC LIMIT 10`, [customerId]);
  const [[firstLast]] = [await conn.query(
    `SELECT MIN(issue_date) AS firstDeal, MAX(issue_date) AS lastDeal FROM ar_documents WHERE customer_id = ? AND status NOT IN ('cancelled','draft')`, [customerId])];
  const [topProducts] = await conn.query(
    `SELECT l.item_id, l.menu_id, MAX(l.description) AS description,
            SUM(l.base_qty) AS qty, SUM(l.net_amount) AS net
       FROM ar_document_lines l JOIN ar_documents d ON d.id = l.document_id
      WHERE d.customer_id = ? AND d.document_type='invoice' AND d.status NOT IN ('cancelled','draft')
      GROUP BY l.item_id, l.menu_id ORDER BY net DESC LIMIT 10`, [customerId]);
  const agingSnap = await aging(customerId, null, conn);

  // data-quality warnings
  const warnings = [];
  if (customer.customerType !== 'B2C' && !customer.vatNumber) warnings.push('عميل B2B/B2G بدون رقم ضريبي');
  if (Number(customer.creditLimit) > 0 && !customer.phone) warnings.push('عميل ائتماني بدون رقم هاتف');
  if (derived.arBalance > Number(customer.creditLimit) && Number(customer.creditLimit) > 0) warnings.push('الرصيد يتجاوز حد الائتمان');

  return {
    customer,
    balance: derived.arBalance,
    creditExposure: exposure,
    openInvoices: { count: Number(openInv.n), balance: money(openInv.bal) },
    collections: { count: Number(collAgg.n), total: money(collAgg.total) },
    unappliedCredit: money(unalloc.total),
    firstDeal: firstLast.firstDeal ? calc.ymd(firstLast.firstDeal) : null,
    lastDeal: firstLast.lastDeal ? calc.ymd(firstLast.lastDeal) : null,
    recentSales, returns,
    topProducts: topProducts.map((p) => ({ itemId: p.item_id, menuId: p.menu_id, description: p.description, qty: calc.qty(p.qty), net: money(p.net) })),
    aging: agingSnap,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { statement, aging, customer360 };
