'use strict';
/* Integration — invoice identity snapshot (self-booting real server + DB).
 *
 * The defect: GET /api/sales/invoice/:id resolved the seller block (company
 * name, tax number, logo) LIVE at reprint time. Changing the tax number
 * reprinted EVERY historical invoice with the new one and rebuilt its ZATCA QR
 * from it — a tax document silently mutating after issue.
 *
 * Guards: the additive migration lands, an issued sale pins its identity, later
 * settings edits do NOT reach it, and sales predating the migration (no
 * snapshot) still print via the live resolve.
 *
 * Run: node tests/integration/invoiceSnapshot.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const invoiceIdentity = require('../../lib/invoiceIdentity');

const USER = 'itest_snap_user';
const PW = 'Snap#Test!2026xy';

const PORT = 3995;
const BASE = 'http://127.0.0.1:' + PORT;
const SALE_NEW = 'ITEST-SNAP-NEW';
const SALE_OLD = 'ITEST-SNAP-OLD';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }

// /api/sales is NOT in server.js's public list — every read needs a Bearer token.
let TOKEN = '';
function get(p) {
  return new Promise((res) => {
    const headers = { Accept: 'application/json' };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    }).on('error', () => res({ status: 0 }));
  });
}
function post(p, body) {
  return new Promise((res) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: p, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); r.write(data); r.end();
  });
}
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function setSetting(k, v) { await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [k, v, v]); }
async function getSetting(k) { const [r] = await db.query('SELECT setting_value FROM settings WHERE setting_key=? LIMIT 1', [k]); return r.length ? r[0].setting_value : null; }

const TOUCHED = ['CompanyName', 'name', 'TaxNumber', 'taxNumber', 'logo', 'CompanyLogo'];
const original = new Map();
async function cleanup() {
  try { await db.query('DELETE FROM users WHERE username=?', [USER]); } catch (_) {}
  for (const id of [SALE_NEW, SALE_OLD]) {
    try { await db.query('DELETE FROM sales_items WHERE order_id=?', [id]); } catch (_) {}
    try { await db.query('DELETE FROM sales WHERE id=?', [id]); } catch (_) {}
  }
}
async function restore() {
  for (const [k, v] of original) {
    try {
      if (v === null) await db.query('DELETE FROM settings WHERE setting_key=?', [k]);
      else await setSetting(k, v);
    } catch (_) {}
  }
}

(async () => {
  await cleanup();
  for (const k of TOUCHED) original.set(k, await getSetting(k));
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)',
    [USER, await bcrypt.hash(PW, 12), 'admin']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ invoice identity snapshot ═══');

    const lg = await post('/api/auth/login', { username: USER, password: PW });
    TOKEN = (lg.body && lg.body.token) || '';
    check('authenticated (invoice reads are token-gated)', !!TOKEN, { status: lg.status });

    // ── migration is additive + idempotent (the boot above ran it) ──
    const [tbl] = await db.query("SHOW TABLES LIKE 'receipt_identities'");
    check('migration created receipt_identities', tbl.length === 1);
    const [col] = await db.query("SELECT COLUMN_NAME, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales' AND COLUMN_NAME='receipt_identity_id'");
    check('migration added sales.receipt_identity_id', col.length === 1);
    check('new column is NULLABLE (additive — existing rows untouched)', col.length === 1 && col[0].IS_NULLABLE === 'YES', col[0]);

    // ── an invoice issued under identity A ──
    await setSetting('CompanyName', 'شركة وقت الإصدار');
    await setSetting('TaxNumber', '311111111111113');
    await setSetting('logo', 'logo-at-issue-time');

    const { identity } = await invoiceIdentity.resolveIdentity(db, {});
    check('resolver picked up the issue-time settings', identity.taxNumber === '311111111111113', identity.taxNumber);
    const snapId = await invoiceIdentity.snapshotIdentity(db, identity);
    check('identity snapshotted', !!snapId);

    await db.query(
      'INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, receipt_identity_id) VALUES (?,NOW(),?,?,?,?,?)',
      [SALE_NEW, JSON.stringify([{ name: 'Test', qty: 1, price: 10, total: 10 }]), 10, 'Cash', 'itest', snapId]
    );
    // A sale issued BEFORE the feature: no snapshot at all.
    await db.query(
      'INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, receipt_identity_id) VALUES (?,NOW(),?,?,?,?,NULL)',
      [SALE_OLD, JSON.stringify([{ name: 'Test', qty: 1, price: 10, total: 10 }]), 10, 'Cash', 'itest']
    );

    const before = await get('/api/sales/invoice/' + SALE_NEW);
    check('reprint before any edit shows the issue-time company', before.body && before.body.companyName === 'شركة وقت الإصدار', before.body && before.body.companyName);
    check('reprint reports it came from the snapshot', before.body && before.body.identitySource === 'snapshot', before.body && before.body.identitySource);

    // ── THE guarantee: the owner now edits the company identity ──
    await setSetting('CompanyName', 'اسم جديد تمامًا');
    await setSetting('TaxNumber', '399999999999993');
    await setSetting('logo', 'brand-new-logo');

    const after = await get('/api/sales/invoice/' + SALE_NEW);
    check('ISSUED invoice keeps its company name after the edit',
      after.body && after.body.companyName === 'شركة وقت الإصدار', after.body && after.body.companyName);
    check('ISSUED invoice keeps its tax number (the ZATCA QR is built from this)',
      after.body && after.body.taxNumber === '311111111111113', after.body && after.body.taxNumber);
    check('ISSUED invoice keeps the logo it was printed with',
      after.body && after.body.companyLogo === 'logo-at-issue-time', after.body && after.body.companyLogo);

    // ── backward compatibility: pre-migration sales still print ──
    const old = await get('/api/sales/invoice/' + SALE_OLD);
    check('pre-migration sale (no snapshot) still returns an invoice', old.status === 200 && old.body && old.body.orderId === SALE_OLD);
    check('pre-migration sale resolves live', old.body && old.body.identitySource === 'live', old.body && old.body.identitySource);
    check('pre-migration sale shows the CURRENT company (unchanged behaviour)',
      old.body && old.body.companyName === 'اسم جديد تمامًا', old.body && old.body.companyName);

    // ── new invoices DO follow the edit ──
    const { identity: id2 } = await invoiceIdentity.resolveIdentity(db, {});
    check('a NEW sale issued now picks up the new tax number', id2.taxNumber === '399999999999993', id2.taxNumber);
    check('the new identity is a different row (old one preserved)',
      invoiceIdentity.identityHash(id2) !== snapId);

    console.log(`\n${fail === 0 ? '✅' : '❌'} invoiceSnapshot: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await restore();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
