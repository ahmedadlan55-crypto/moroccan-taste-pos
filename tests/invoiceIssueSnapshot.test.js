#!/usr/bin/env node
'use strict';
/**
 * tests/invoiceIssueSnapshot.test.js — a tax invoice carries the seller and the
 * buyer AS THEY WERE when it was issued.
 *
 * WHAT WAS BROKEN
 *   The ERP invoice printed only the seller name + VAT number decoded from the
 *   ZATCA TLV: ar_documents had no identity snapshot, and re-reading settings
 *   at print time is the post-issue drift the O2C side exists to prevent — so
 *   there was no logo, CR, address or footer on the document at all. The BUYER
 *   was never captured: a customer renamed or re-registered afterwards
 *   silently rewrote every invoice ever issued to them.
 *
 * WHAT THIS FILE PINS (real InvoiceService + real routes/order-to-cash, live DB)
 *   1. issue() stamps receipt_identity_id (the same content-addressed snapshot
 *      the POS pins) and copies the buyer's name / VAT / address from the
 *      customer row.
 *   2. Changing the seller settings OR the customer record AFTER issue does not
 *      change what the invoice read returns — the snapshot is the truth.
 *   3. The read side names its sources: identitySource 'snapshot', buyer.source
 *      'snapshot'; an invoice with no buyer snapshot falls back to the live
 *      customer and says 'live'.
 *   4. The A4 options are a print preference: resolved live, never frozen.
 */

const express = require('express');
const db = require('../db/connection');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve().then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const CUST = 'CUST-ISSUESNAP';
const TAG = 'issuesnap-fixture';
const ADMIN = { id: 990501, username: 'issuesnap_admin', role: 'admin' };
let originalCompanyName = null;
// The local DB predates the COA canonical rebuild, so the AR control account
// (112100) is archived here and GL posting refuses it. Activate it for the run
// and put it back exactly as found — a fixture, never a production change.
let archivedAccounts = [];

async function setSetting(key, value) {
  await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, value]);
}
async function getSetting(key) {
  const [r] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [key]);
  return r.length ? r[0].setting_value : null;
}

async function seed() {
  await require('../db/migrations/order-to-cash/schema').apply(db, () => {});
  originalCompanyName = await getSetting('CompanyName');
  // Every inactive account, remembered with its exact prior state.
  const [inactive] = await db.query('SELECT code, is_active, status FROM gl_accounts WHERE is_active=0').catch(() => [[]]);
  archivedAccounts = inactive;
  if (inactive.length) await db.query("UPDATE gl_accounts SET is_active=1, status='active' WHERE code IN (" + inactive.map(() => '?').join(',') + ')', inactive.map((a) => a.code));
  await setSetting('CompanyName', 'مطاعم اللقطة — قبل');
  await db.query('DELETE FROM customers WHERE id=?', [CUST]);
  await db.query(
    'INSERT INTO customers (id, name, vat_number, address, city, phone, email, created_by) VALUES (?,?,?,?,?,?,?,?)',
    [CUST, 'شركة المشتري الأولى', '300000000000003', 'شارع الملك فهد', 'الرياض', '0500000000', 'buyer@example.test', 'test']);
  await db.query('DELETE FROM users WHERE id=? OR username=?', [ADMIN.id, ADMIN.username]);
  await db.query('INSERT INTO users (id, username, password, role, active) VALUES (?,?,?,?,1)', [ADMIN.id, ADMIN.username, 'x', ADMIN.role]);
}
async function cleanup() {
  const [docs] = await db.query('SELECT id, gl_journal_id FROM ar_documents WHERE customer_id=?', [CUST]).catch(() => [[]]);
  for (const d of docs) {
    await db.query('DELETE FROM ar_document_lines WHERE document_id=?', [d.id]).catch(() => {});
    await db.query('DELETE FROM o2c_events WHERE document_id=?', [d.id]).catch(() => {});
    if (d.gl_journal_id) {
      await db.query('DELETE FROM gl_entries WHERE journal_id=?', [d.gl_journal_id]).catch(() => {});
      await db.query('DELETE FROM gl_journals WHERE id=?', [d.gl_journal_id]).catch(() => {});
    }
  }
  await db.query('DELETE FROM ar_documents WHERE customer_id=?', [CUST]).catch(() => {});
  await db.query('DELETE FROM customers WHERE id=?', [CUST]).catch(() => {});
  await db.query('DELETE FROM users WHERE id=?', [ADMIN.id]).catch(() => {});
  if (originalCompanyName != null) await setSetting('CompanyName', originalCompanyName).catch(() => {});
  for (const a of archivedAccounts) await db.query('UPDATE gl_accounts SET is_active=?, status=? WHERE code=?', [a.is_active, a.status, a.code]).catch(() => {});
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role }; req.requestId = 'test'; next(); });
  app.use('/api/order-to-cash', require('../routes/order-to-cash'));
  return app;
}

async function main() {
  await cleanup();
  await seed();
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  try {
    console.log('\n1. issue freezes the parties');
    let id;
    await test('a draft invoice for a registered buyer is created', async () => {
      const r = await call('POST', '/api/order-to-cash/invoices', {
        customerId: CUST, customerName: 'شركة المشتري الأولى', issueDate: new Date().toISOString().slice(0, 10),
        notes: TAG,
        lines: [{ description: 'خدمة', qty: 2, unitPrice: 100, vatCategory: 'S' }],
      });
      ok(r.status === 201 || r.status === 200, 'create: ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      id = (r.json.data && r.json.data.id) || r.json.id;
      ok(id, 'has id');
    });
    await test('issuing stamps the seller snapshot and the buyer columns', async () => {
      const r = await call('POST', `/api/order-to-cash/invoices/${id}/issue`, {});
      ok(r.status === 200, 'issue: ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      const [[row]] = await db.query('SELECT receipt_identity_id, buyer_name, buyer_vat_number, buyer_address FROM ar_documents WHERE id=?', [id]);
      ok(row.receipt_identity_id && row.receipt_identity_id.length >= 20, 'receipt_identity_id stamped: ' + row.receipt_identity_id);
      eq(row.buyer_name, 'شركة المشتري الأولى');
      eq(row.buyer_vat_number, '300000000000003');
      ok(/شارع الملك فهد/.test(row.buyer_address) && /الرياض/.test(row.buyer_address), 'address + city: ' + row.buyer_address);
    });

    console.log('\n2. the snapshot outlives later edits');
    await test('renaming the seller AFTER issue does not change the invoice', async () => {
      await setSetting('CompanyName', 'مطاعم اللقطة — بعد');
      const r = await call('GET', `/api/order-to-cash/invoices/${id}`);
      eq(r.status, 200);
      eq(r.json.data.identitySource, 'snapshot');
      eq(r.json.data.identity.sellerName, 'مطاعم اللقطة — قبل', 'the name at issue, not today\'s');
    });
    await test('re-registering the customer AFTER issue does not change the invoice', async () => {
      await db.query('UPDATE customers SET name=?, vat_number=? WHERE id=?', ['شركة المشتري بعد التغيير', '399999999999993', CUST]);
      const r = await call('GET', `/api/order-to-cash/invoices/${id}`);
      eq(r.json.data.buyer.source, 'snapshot');
      eq(r.json.data.buyer.name, 'شركة المشتري الأولى');
      eq(r.json.data.buyer.vatNumber, '300000000000003');
    });

    console.log('\n3. an invoice with no snapshot says so');
    await test('a pre-feature invoice falls back to the LIVE customer and names the source', async () => {
      // Simulate an invoice issued before the columns existed.
      await db.query('UPDATE ar_documents SET receipt_identity_id=NULL, buyer_name=NULL, buyer_vat_number=NULL, buyer_address=NULL WHERE id=?', [id]);
      const r = await call('GET', `/api/order-to-cash/invoices/${id}`);
      eq(r.json.data.identitySource, 'tlv', 'no snapshot → the thin TLV seller, nothing re-read live');
      eq(r.json.data.identity, null);
      eq(r.json.data.buyer.source, 'live');
      eq(r.json.data.buyer.name, 'شركة المشتري بعد التغيير', 'the CURRENT record, and labelled as such');
    });

    console.log('\n4. layout choices are a preference, not part of the document');
    await test('A4 options come from settings at read time', async () => {
      await setSetting('InvoiceA4Options', JSON.stringify({ showBuyer: true, showSignature: false, showBank: true, bankDetails: 'IBAN SA00', terms: 'الدفع خلال 30 يومًا' }));
      const r = await call('GET', `/api/order-to-cash/invoices/${id}`);
      eq(r.json.data.a4Options.showSignature, false);
      eq(r.json.data.a4Options.showBank, true);
      eq(r.json.data.a4Options.bankDetails, 'IBAN SA00');
      await db.query("DELETE FROM settings WHERE setting_key='InvoiceA4Options'");
    });
  } finally {
    server.close();
    await cleanup();
    await db.end?.().catch?.(() => {});
  }

  console.log(`\n${_passed}/${_total} passed${_failed ? `, ${_failed} failed` : ''}`);
  if (_failed) process.exit(1);
  console.log('  ✅ seller + buyer frozen at issue; later edits do not rewrite the invoice; sources named');
  // The O2C router starts a background worker (ZATCA) whose interval keeps
  // the event loop alive; the test's own work is done, so leave explicitly.
  process.exit(0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
