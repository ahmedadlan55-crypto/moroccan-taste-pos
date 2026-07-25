#!/usr/bin/env node
/**
 * scripts/order-to-cash/backfill.js — one-way, idempotent backfill of the legacy
 * AR world into ar_documents (the single AR source of truth). It NEVER posts new
 * GL and NEVER duplicates Revenue/VAT/AR — POS sales LINK their existing 'Sale'
 * journal; legacy customer_invoices / credit_notes carry their own gl_journal_id
 * (or none → flagged as data-quality). Customer balances are DERIVED, so no manual
 * balance is trusted. Duplicate customers are REPORTED, never auto-merged.
 *
 *   node scripts/order-to-cash/backfill.js --dry-run   # classify + counts, no writes
 *   node scripts/order-to-cash/backfill.js --apply      # apply inside a transaction
 *
 * Re-runnable: UNIQUE(source_type, source_id) + NOT-EXISTS guards make a second
 * apply a no-op.
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));
const calc = require('../../lib/order-to-cash/calculations');
const InvoiceService = require('../../services/order-to-cash/InvoiceService');
const CustomerService = require('../../services/order-to-cash/CustomerService');
const money = calc.money;

function genId(p) { return p + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function isCredit(pm) { const m = String(pm || '').toLowerCase(); return /^(credit|kita|ar)$/.test(m) || m.indexOf('ذمم') >= 0 || m.indexOf('آجل') >= 0; }
function mapStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'paid') return 'paid';
  if (v === 'partial' || v === 'partially_paid') return 'partially_paid';
  if (v === 'cancelled' || v === 'canceled' || v === 'void') return 'cancelled';
  if (v === 'credited') return 'credited';
  if (v === 'draft') return 'draft';
  return 'issued';
}

async function tableExists(conn, t) {
  const [r] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?', [t]);
  return Number(r[0].n) > 0;
}

async function classify(conn) {
  const out = {};
  const [[s]] = [await conn.query(
    `SELECT COUNT(*) AS total,
            SUM(customer_id IS NOT NULL) AS with_customer,
            SUM(CASE WHEN LOWER(COALESCE(payment_method,'')) REGEXP '(credit|kita|ar)' THEN 1 ELSE 0 END) AS credit
       FROM sales WHERE deleted_at IS NULL`)];
  out.sales = { total: Number(s[0].total), withCustomer: Number(s[0].with_customer || 0), credit: Number(s[0].credit || 0) };
  out.sales.alreadyLinked = Number((await conn.query("SELECT COUNT(*) AS n FROM ar_documents WHERE source_type='pos'"))[0][0].n);

  if (await tableExists(conn, 'customer_invoices')) {
    const [ci] = await conn.query('SELECT COUNT(*) AS n, SUM(gl_journal_id IS NULL) AS no_gl FROM customer_invoices');
    out.customerInvoices = { total: Number(ci[0].n), noGl: Number(ci[0].no_gl || 0) };
  }
  if (await tableExists(conn, 'credit_notes')) {
    const [cn] = await conn.query('SELECT COUNT(*) AS n FROM credit_notes');
    out.creditNotes = { total: Number(cn[0].n) };
  }
  // duplicate customers by normalized phone / VAT (report only)
  // `groups` is a reserved word from MySQL 8.0 on (window-frame GROUPS), so the
  // alias must be quoted — unquoted it is a syntax error on the production
  // server (9.6) and the whole backfill aborts before classifying anything.
  const [dupPhone] = await conn.query(
    `SELECT COUNT(*) AS \`groups\` FROM (
        SELECT REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+','') AS p, COUNT(*) c
          FROM customers WHERE phone IS NOT NULL AND phone<>'' AND deleted_at IS NULL
         GROUP BY p HAVING c > 1) t`);
  const [dupVat] = await conn.query(
    `SELECT COUNT(*) AS \`groups\` FROM (
        SELECT vat_number, COUNT(*) c FROM customers WHERE vat_number IS NOT NULL AND vat_number<>'' AND deleted_at IS NULL
         GROUP BY vat_number HAVING c > 1) t`);
  out.duplicateCustomers = { byPhone: Number(dupPhone[0].groups), byVat: Number(dupVat[0].groups) };
  return out;
}

async function apply(conn, log) {
  let posLinked = 0, invImported = 0, cnImported = 0;

  // 1) POS sales → ar_documents (link existing 'Sale' journal; no new GL)
  const [sales] = await conn.query('SELECT * FROM sales WHERE deleted_at IS NULL');
  for (const sale of sales) {
    const total = money(sale.total_final);
    let vat = 0;
    try { if (sale.tax_subtotals_json) { const t = JSON.parse(sale.tax_subtotals_json); vat = money(Array.isArray(t) ? t.reduce((a, x) => a + Number(x.vat || x.tax || 0), 0) : (t.vat || 0)); } } catch (_) { vat = 0; }
    const credit = isCredit(sale.payment_method) && sale.customer_id;
    const r = await InvoiceService.linkPosSale(conn, Object.assign({}, sale, { vat_amount: vat }), {
      actor: 'o2c-backfill',
      status: credit ? 'issued' : 'paid',
      paid: credit ? 0 : total,
      balance: credit ? total : 0,
    });
    if (r && !r.replayed) posLinked++;
  }

  // 2) legacy customer_invoices → ar_documents source_type='imported' (link own journal)
  if (await tableExists(conn, 'customer_invoices')) {
    const [invs] = await conn.query('SELECT * FROM customer_invoices');
    for (const inv of invs) {
      const [exist] = await conn.query("SELECT id FROM ar_documents WHERE source_type='imported' AND source_id = ? LIMIT 1", [inv.id]);
      if (exist.length) continue;
      const total = money(inv.total_amount), paid = money(inv.paid_amount || 0);
      await conn.query(
        `INSERT INTO ar_documents
           (id, document_number, document_type, source_type, source_id, customer_id, customer_name,
            brand_id, branch_id, issue_date, due_date, currency, subtotal, discount_amount, vat_amount,
            total_amount, paid_amount, balance_amount, status, zatca_status, zatca_uuid, gl_journal_id,
            version, created_by, issued_by, issued_at)
         VALUES (?,?,'invoice','imported',?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,1,'o2c-backfill','o2c-backfill',NOW())`,
        [genId('AR'), inv.code || inv.id, inv.id, inv.customer_id, inv.customer_name, inv.brand_id, inv.branch_id,
         calc.ymd(inv.issue_date), inv.due_date ? calc.ymd(inv.due_date) : null, inv.currency || 'SAR',
         money(inv.subtotal), money(inv.vat_amount), total, paid, money(total - paid),
         mapStatus(inv.status), inv.zatca_status || 'pending', inv.zatca_uuid || null, inv.gl_journal_id || null]);
      invImported++;
    }
  }

  // 3) legacy credit_notes → ar_documents document_type='credit_note' source_type='imported'
  if (await tableExists(conn, 'credit_notes')) {
    const [cns] = await conn.query('SELECT * FROM credit_notes');
    for (const cn of cns) {
      const [exist] = await conn.query("SELECT id FROM ar_documents WHERE source_type='imported' AND source_id = ? AND document_type='credit_note' LIMIT 1", [cn.id]);
      if (exist.length) continue;
      const total = money(cn.total_final);
      await conn.query(
        `INSERT INTO ar_documents
           (id, document_number, document_type, source_type, source_id, customer_id, brand_id, branch_id,
            issue_date, currency, subtotal, discount_amount, vat_amount, total_amount, paid_amount, balance_amount,
            status, zatca_status, zatca_uuid, version, created_by, issued_by, issued_at)
         VALUES (?,?,'credit_note','imported',?,?,?,?,?,'SAR',?,0,?,?,0,0,'issued',?,?,1,'o2c-backfill','o2c-backfill',NOW())`,
        [genId('CN'), cn.id, cn.id, cn.customer_id || null, cn.brand_id || null, cn.branch_id || null,
         calc.ymd(cn.issue_date), money(cn.net_amount || (total - Number(cn.vat_amount || 0))), money(cn.vat_amount || 0), total,
         cn.zatca_status || 'pending', cn.invoice_uuid || null]);
      cnImported++;
    }
  }

  log(`  + POS sales linked: ${posLinked}`);
  log(`  + customer_invoices imported: ${invImported}`);
  log(`  + credit_notes imported: ${cnImported}`);
  return { posLinked, invImported, cnImported };
}

async function run({ dryRun }) {
  const log = (m) => console.log(m);
  const cls = await classify(db);
  console.log('=== O2C backfill classification ===');
  console.log(JSON.stringify(cls, null, 2));
  if (cls.duplicateCustomers.byPhone || cls.duplicateCustomers.byVat) {
    console.log(`  ! duplicate customers detected (phone groups=${cls.duplicateCustomers.byPhone}, vat groups=${cls.duplicateCustomers.byVat}) — REPORT ONLY, no auto-merge`);
  }
  if (dryRun) { console.log('=== DRY-RUN (no writes) ==='); await db.end(); return; }

  const res = await db.withTransaction((conn) => apply(conn, log));
  console.log('=== APPLIED ===');
  console.log(JSON.stringify(res));
  await db.end();
}

if (require.main === module) {
  run({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((e) => { console.error('O2C-BACKFILL ERROR:', e.message, '\n', e.stack); process.exit(1); });
}

module.exports = { run, classify, apply };
