'use strict';
/* Integration — settings → receipt/ZATCA plumbing (self-booting real server + DB).
 *
 * Guards four live defects found in the v4 audit:
 *   1. PUT /api/settings wrote the React admin's camelCase keys verbatim, while
 *      routes/sales.js reads PascalCase → editing the tax number never reached a
 *      printed invoice or its ZATCA QR. (ZATCA-facing, silent.)
 *   2. routes/pos-v2.js queried `key`/`value` on a table with
 *      setting_key/setting_value; the error was swallowed and the React POS VAT
 *      rate was pinned at 15 regardless of configuration. (ZATCA-facing.)
 *   3. settings.receiptFooter had zero readers — a write-only field.
 *   4. React wrote "true"/"false"; readers compared === '1' / === '0', so
 *      NewProductsTaxInclusive failed OPEN and RequireManagerApprovalForVoid
 *      failed CLOSED.
 *
 * Run: node tests/integration/settingsReceipt.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3994;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'setrcpt_admin';
const CASHIER = 'setrcpt_cashier';
const PW = 'S3ttings#Test!2026';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }

function req(method, p, token, body) {
  return new Promise((res) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (data) r.write(data); r.end();
  });
}
const login = (u, p) => req('POST', '/api/auth/login', null, { username: u, password: p });
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function settingValue(key) {
  const [r] = await db.query('SELECT setting_value FROM settings WHERE setting_key=? LIMIT 1', [key]);
  return r.length ? r[0].setting_value : null;
}

const TOUCHED = ['CompanyName', 'name', 'TaxNumber', 'taxNumber', 'Currency', 'currency',
  'CompanyPhone', 'companyPhone', 'CompanyEmail', 'companyEmail', 'VATRate',
  'receiptFooter', 'NewProductsTaxInclusive', 'RequireManagerApprovalForVoid'];
const original = new Map();

async function cleanup() {
  for (const u of [ADMIN, CASHIER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
}
async function restoreSettings() {
  for (const [k, v] of original) {
    try {
      if (v === null) await db.query('DELETE FROM settings WHERE setting_key=?', [k]);
      else await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [k, v, v]);
    } catch (_) {}
  }
}

(async () => {
  await cleanup();
  // Snapshot every key we touch so a real install's config survives the run.
  for (const k of TOUCHED) original.set(k, await settingValue(k));

  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ settings → receipt / ZATCA ═══');

    const adminTok = (await login(ADMIN, PW)).body?.token;
    const cashierTok = (await login(CASHIER, PW)).body?.token;
    check('admin + cashier logged in', !!adminTok && !!cashierTok);

    // ── 1 + 4: a React-admin-shaped payload (camelCase + JS booleans) ──
    const saved = await req('PUT', '/api/settings', adminTok, {
      name: 'مطعم الاختبار',
      taxNumber: '311111111111113',
      companyPhone: '0500000000',
      companyEmail: 'test@example.com',
      currency: 'SAR',
      VATRate: '5',
      receiptFooter: 'سياسة الاسترجاع: خلال 14 يومًا',
      NewProductsTaxInclusive: true,
      RequireManagerApprovalForVoid: false,
    });
    check('PUT /api/settings accepted', saved.body && saved.body.success === true, saved.body);

    // The bug: these PascalCase rows were never written, so the receipt never saw the edit.
    check('camelCase name reached CompanyName (the key the receipt reads)',
      (await settingValue('CompanyName')) === 'مطعم الاختبار');
    check('camelCase taxNumber reached TaxNumber (printed + in the ZATCA QR)',
      (await settingValue('TaxNumber')) === '311111111111113');
    check('camelCase companyPhone reached CompanyPhone', (await settingValue('CompanyPhone')) === '0500000000');
    check('camelCase companyEmail reached CompanyEmail', (await settingValue('CompanyEmail')) === 'test@example.com');
    check('camelCase currency reached Currency', (await settingValue('Currency')) === 'SAR');

    // Booleans persist in the form the readers actually compare against.
    check("NewProductsTaxInclusive true → '1' (menu.js compares === '1'; failed OPEN before)",
      (await settingValue('NewProductsTaxInclusive')) === '1');
    check("RequireManagerApprovalForVoid false → '0' (sales.js compares === '0'; failed CLOSED before)",
      (await settingValue('RequireManagerApprovalForVoid')) === '0');

    // Legacy pages read the camelCase rows — the fan-out must keep them in sync.
    check('alias rows still written for legacy readers',
      (await settingValue('name')) === 'مطعم الاختبار' && (await settingValue('taxNumber')) === '311111111111113');

    // ── 2: the React POS catalog VAT rate ──
    const cat = await req('GET', '/api/pos/v2/catalog', cashierTok);
    check('GET /api/pos/v2/catalog reachable', cat.status === 200, { status: cat.status });
    check('catalog vatRate follows settings (was hardcoded 15 via a swallowed SQL error)',
      cat.body && cat.body.data && Number(cat.body.data.vatRate) === 5,
      { vatRate: cat.body && cat.body.data && cat.body.data.vatRate });

    // ── 3: receiptFooter is readable by the invoice path ──
    const pub = await req('GET', '/api/settings', null);
    check('receiptFooter round-trips through the settings API',
      pub.body && pub.body.receiptFooter === 'سياسة الاسترجاع: خلال 14 يومًا');

    console.log(`\n${fail === 0 ? '✅' : '❌'} settingsReceipt: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await restoreSettings();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
