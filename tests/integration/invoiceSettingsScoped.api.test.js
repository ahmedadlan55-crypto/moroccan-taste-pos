'use strict';
/* Integration — invoice-settings closure: show-field toggles, print preferences,
 * and SCOPED identity overrides (real server + DB).
 *
 * What this run proves:
 *   (a) ReceiptShowFields round-trips UNMANGLED through PUT /api/settings
 *       (normalizeSettingsWrite must pass JSON strings through verbatim) and
 *       GET /settings/invoice-identity returns the PARSED toggles + the raw.
 *   (b) ReceiptPaperWidth / ReceiptAutoPrint round-trip, and the POS catalog
 *       (GET /api/pos/v2/catalog, as a cashier) carries them as
 *       receiptSettings: { paperWidth: '58'|'80'|'A4', autoPrint: '1'|'0' } —
 *       the contract the React receipt renderer consumes. A garbage width
 *       normalizes to '80', never reaching the printer raw.
 *   (c) PUT /settings/invoice-identity-scope updates ONLY the scope columns
 *       resolveIdentity already reads (branches.location / branches.company_name,
 *       brands.name / brands.logo); the resolved identity FOR THAT SCOPE
 *       reflects it while the GLOBAL identity is untouched.
 *   (d) Gate regression: anonymous PUT /api/settings → 401 (the /settings
 *       prefix is exempt from the global /api guard, so this must hold on the
 *       route itself); cashier writes → 403.
 *
 * Every settings key touched is snapshotted first and restored EXACTLY —
 * including prior absence. Scope rows are private ITEST rows, deleted after.
 *
 * Run: node tests/integration/invoiceSettingsScoped.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3998;
const BASE = 'http://127.0.0.1:' + PORT;
const SFX = String(Date.now()).slice(-6);
const ADMIN = 'invset_admin_' + SFX;
const CASHIER = 'invset_cashier_' + SFX;
const PW = 'InvSet#Test!2026';
const BRANCH = 'ITEST-IS-BR-' + SFX;
const BRAND = 'ITEST-IS-BD-' + SFX;
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
const login = (u) => req('POST', '/api/auth/login', null, { username: u, password: PW });
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

// ── exact save/restore of every settings key this run touches ──
// (pattern: receiptQr.api.test.js — restore VALUE when it existed, restore
// ABSENCE when it did not.)
const TOUCHED_KEYS = ['ReceiptShowFields', 'ReceiptPaperWidth', 'ReceiptAutoPrint'];
const savedSettings = {}; // key → { existed, value }

async function saveSettingsState() {
  for (const k of TOUCHED_KEYS) {
    const [r] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [k]);
    savedSettings[k] = r.length ? { existed: true, value: r[0].setting_value } : { existed: false };
  }
}
async function restoreSettings() {
  for (const [k, s] of Object.entries(savedSettings)) {
    try {
      if (s.existed) await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [k, s.value, s.value]);
      else await db.query('DELETE FROM settings WHERE setting_key = ?', [k]);
    } catch (_) {}
  }
}
async function settingValue(key) {
  const [r] = await db.query('SELECT setting_value FROM settings WHERE setting_key=? LIMIT 1', [key]);
  return r.length ? r[0].setting_value : null;
}

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  for (const u of [ADMIN, CASHIER]) await del('DELETE FROM users WHERE username=?', [u]);
  await del('DELETE FROM branches WHERE id=?', [BRANCH]);
  await del('DELETE FROM brands WHERE id=?', [BRAND]);
}

(async () => {
  await cleanup();
  await saveSettingsState();

  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  // company_id explicitly NULL: the column defaults to 'CO-MAIN', and a real
  // install's CO-MAIN company row would otherwise leak its tax identity into
  // this branch's resolution and blur what the test asserts.
  await db.query('INSERT INTO branches (id, name, location, company_name, company_id) VALUES (?,?,?,?,NULL)',
    [BRANCH, 'ITEST فرع التخصيص', 'الموقع الأصلي', '']);
  await db.query('INSERT INTO brands (id, name, code, logo) VALUES (?,?,?,NULL)', [BRAND, 'ITEST براند أصلي', 'ITB']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ invoice-settings: toggles / print prefs / scoped overrides ═══');

    const adminTok = (await login(ADMIN)).body?.token;
    const cashierTok = (await login(CASHIER)).body?.token;
    check('admin + cashier logged in', !!adminTok && !!cashierTok);

    // ── (d) the write gate, first — everything below depends on it ──────────
    console.log('\n▶ gate: /settings writes are authenticated + role-checked');
    const anonPut = await req('PUT', '/api/settings', null, { ReceiptPaperWidth: '58' });
    check('anonymous PUT /api/settings → 401', anonPut.status === 401, anonPut.status);
    const cashPut = await req('PUT', '/api/settings', cashierTok, { ReceiptPaperWidth: '58' });
    check('cashier PUT /api/settings → 403', cashPut.status === 403, cashPut.status);
    const anonIdn = await req('GET', '/api/settings/invoice-identity', null);
    check('anonymous GET /settings/invoice-identity → 401 (tax identity is not public)', anonIdn.status === 401, anonIdn.status);

    // ── (a) ReceiptShowFields round-trip ─────────────────────────────────────
    console.log('\n▶ (a) ReceiptShowFields round-trips and comes back parsed');
    const SHOW_JSON = '{"qr":false,"phone":false}';
    const putShow = await req('PUT', '/api/settings', adminTok, { ReceiptShowFields: SHOW_JSON });
    check('PUT accepted', putShow.body?.success === true, putShow.body);
    check('the JSON string persisted VERBATIM (normalizeSettingsWrite must not mangle it)',
      (await settingValue('ReceiptShowFields')) === SHOW_JSON, await settingValue('ReceiptShowFields'));
    const idn1 = await req('GET', '/api/settings/invoice-identity', adminTok);
    check('GET returns parsed toggles: qr=false, phone=false', idn1.body?.showFields?.qr === false && idn1.body?.showFields?.phone === false, idn1.body?.showFields);
    check('  …untouched toggles keep their all-true default', idn1.body?.showFields?.logo === true && idn1.body?.showFields?.cashier === true);
    check('  …and the raw string rides along for the editor', idn1.body?.showFieldsRaw === SHOW_JSON, idn1.body?.showFieldsRaw);

    // ── (b) print preferences reach the cashier's catalog ────────────────────
    console.log('\n▶ (b) paper width + auto-print reach /api/pos/v2/catalog');
    const putPrint = await req('PUT', '/api/settings', adminTok, { ReceiptPaperWidth: '58', ReceiptAutoPrint: '0' });
    check('PUT accepted', putPrint.body?.success === true, putPrint.body);
    const idn2 = await req('GET', '/api/settings/invoice-identity', adminTok);
    check('GET /invoice-identity mirrors receiptSettings', idn2.body?.receiptSettings?.paperWidth === '58' && idn2.body?.receiptSettings?.autoPrint === '0', idn2.body?.receiptSettings);
    const cat1 = await req('GET', '/api/pos/v2/catalog', cashierTok);
    check('catalog responds 200', cat1.status === 200, cat1.status);
    check('catalog carries receiptSettings.paperWidth (contract with the receipt renderer)',
      cat1.body?.data?.receiptSettings?.paperWidth === '58', cat1.body?.data?.receiptSettings);
    check('  …and autoPrint as \'0\'', cat1.body?.data?.receiptSettings?.autoPrint === '0');
    await req('PUT', '/api/settings', adminTok, { ReceiptPaperWidth: 'weird-value' });
    const cat2 = await req('GET', '/api/pos/v2/catalog', cashierTok);
    check('a garbage width normalizes to \'80\' — the printer never sees raw junk',
      cat2.body?.data?.receiptSettings?.paperWidth === '80', cat2.body?.data?.receiptSettings);

    // ── (c) scoped overrides: branch/brand columns, global untouched ─────────
    console.log('\n▶ (c) scoped writes hit the scope columns, not the settings table');
    const globalBefore = (await req('GET', '/api/settings/invoice-identity', adminTok)).body;
    const globalAddressBefore = globalBefore?.identity?.address ?? '';
    const globalLogoBefore = globalBefore?.identity?.logo ?? '';

    const NEW_ADDR = 'ITEST شارع التخصيص 12';
    const NEW_CO = 'ITEST الشركة المشغلة';
    const scoped = await req('PUT', '/api/settings/invoice-identity-scope', adminTok,
      { branchId: BRANCH, fields: { address: NEW_ADDR, branchCompanyName: NEW_CO } });
    check('branch-scoped PUT accepted', scoped.status === 200 && scoped.body?.success === true, scoped);

    const [brow] = await db.query('SELECT location, company_name FROM branches WHERE id=?', [BRANCH]);
    check('branches.location updated (the column resolveIdentity reads)', brow[0]?.location === NEW_ADDR, brow[0]);
    check('branches.company_name updated', brow[0]?.company_name === NEW_CO, brow[0]);

    const idnBranch = await req('GET', `/api/settings/invoice-identity?branchId=${encodeURIComponent(BRANCH)}`, adminTok);
    check('resolved identity FOR THE BRANCH shows the override', idnBranch.body?.identity?.address === NEW_ADDR, idnBranch.body?.identity?.address);
    check('  …with the branch as the reported source', idnBranch.body?.sources?.address === 'branches.location', idnBranch.body?.sources?.address);
    check('  …operating company too', idnBranch.body?.identity?.branchCompanyName === NEW_CO);

    const idnGlobal = await req('GET', '/api/settings/invoice-identity', adminTok);
    check('GLOBAL identity is unchanged by the scoped write', (idnGlobal.body?.identity?.address ?? '') === globalAddressBefore,
      { global: idnGlobal.body?.identity?.address, before: globalAddressBefore });

    const NEW_BRAND_NAME = 'ITEST براند معدّل';
    const NEW_BRAND_LOGO = 'data:image/png;base64,SVRFU1Q=';
    const scopedBrand = await req('PUT', '/api/settings/invoice-identity-scope', adminTok,
      { brandId: BRAND, fields: { brandName: NEW_BRAND_NAME, logo: NEW_BRAND_LOGO } });
    check('brand-scoped PUT accepted', scopedBrand.status === 200 && scopedBrand.body?.success === true, scopedBrand);
    const idnBrand = await req('GET', `/api/settings/invoice-identity?brandId=${encodeURIComponent(BRAND)}`, adminTok);
    check('brand name override resolves for the brand scope', idnBrand.body?.identity?.brandName === NEW_BRAND_NAME, idnBrand.body?.identity?.brandName);
    check('brand logo override wins for the brand scope', idnBrand.body?.identity?.logo === NEW_BRAND_LOGO && idnBrand.body?.sources?.logo === 'brands.logo',
      { logo: (idnBrand.body?.identity?.logo || '').slice(0, 40), src: idnBrand.body?.sources?.logo });
    const idnGlobal2 = await req('GET', '/api/settings/invoice-identity', adminTok);
    check('global logo unchanged by the brand write', (idnGlobal2.body?.identity?.logo ?? '') === globalLogoBefore);

    // ── the scoped endpoint's own gate + validation ──────────────────────────
    console.log('\n▶ scoped endpoint: gate + whitelist');
    const anonScope = await req('PUT', '/api/settings/invoice-identity-scope', null, { branchId: BRANCH, fields: { address: 'x' } });
    check('anonymous → 401', anonScope.status === 401, anonScope.status);
    const cashScope = await req('PUT', '/api/settings/invoice-identity-scope', cashierTok, { branchId: BRANCH, fields: { address: 'x' } });
    check('cashier → 403', cashScope.status === 403, cashScope.status);
    const badField = await req('PUT', '/api/settings/invoice-identity-scope', adminTok, { branchId: BRANCH, fields: { taxNumber: '399' } });
    check('a field with NO scoped column (taxNumber) → 400, named in the error', badField.status === 400, badField);
    const noId = await req('PUT', '/api/settings/invoice-identity-scope', adminTok, { fields: { address: 'x' } });
    check('branch field without branchId → 400', noId.status === 400, noId.status);
    const blankBrand = await req('PUT', '/api/settings/invoice-identity-scope', adminTok, { brandId: BRAND, fields: { brandName: '  ' } });
    check('blanking brands.name (NOT NULL, listed by the brands screen) → 400', blankBrand.status === 400, blankBrand.status);
    const ghost = await req('PUT', '/api/settings/invoice-identity-scope', adminTok, { branchId: 'ITEST-NOPE', fields: { address: 'x' } });
    check('unknown branch id → 404', ghost.status === 404, ghost.status);
    const [brow2] = await db.query('SELECT location FROM branches WHERE id=?', [BRANCH]);
    check('rejected writes changed nothing', brow2[0]?.location === NEW_ADDR);

    console.log(`\n${fail === 0 ? '✅' : '❌'} invoiceSettingsScoped: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await restoreSettings();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
