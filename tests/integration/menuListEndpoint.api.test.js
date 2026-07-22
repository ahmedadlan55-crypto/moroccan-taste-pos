/**
 * Sprint 3 D3 — GET /api/menu/list (paginated menu list, NO image bytes).
 *
 * Covers:
 *   • auth: no token → 401 (the route re-verifies inline despite the public
 *     /menu exemption).
 *   • pagination: pageSize/page slice the result; pagination.total counts all.
 *   • image bytes are NEVER shipped — only hasImage(bool) + an 8-char SHA1
 *     imageVer; the base64 blob appears nowhere in the response.
 *   • branchCount / channelCount are DERIVED from channel_menu_items
 *     (COUNT DISTINCT branch_id / channel_id where is_available=1).
 *   • margin math: pre-tax price − cost, VAT stripped from tax-INCLUSIVE
 *     standard-rated prices using a SEEDED settings.VATRate (proves it is read,
 *     not hardcoded 15); tax-EXCLUSIVE prices are used as-is.
 *   • filters: missingNameEn, negativeMargin, channel.
 *
 * ISOLATED DB: pinned to moroccan_taste_pos_test BEFORE db/connection loads; the
 * run aborts unless the live connection is that database. A full server.js is
 * spawned (also pinned to the test DB) so the additive migrations run and the
 * real route stack is exercised.
 *
 * Run: npm run test:menu-list   (MySQL must be up)
 */
'use strict';

// ── ISOLATED TEST DB — must be set before db/connection.js is required ────────
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL;
delete process.env.MYSQL_URL;
try { require('dotenv').config(); } catch (_) {}
// dotenv must not re-point us at the dev DB.
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;

const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.ML_TEST_PORT || 3271);
const BASE = { host: '127.0.0.1', port: PORT };
const IMG_MARKER = 'D3IMGMARKER';
const IMG = 'data:image/png;base64,' + IMG_MARKER + 'A'.repeat(2000);

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(12000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function waitForSchema() {
  for (let i = 0; i < 120; i++) {
    try {
      const [c] = await db.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='menu' AND COLUMN_NAME='cost_source'");
      if (Number(c[0].n) > 0) return true;
    } catch (_) {}
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}
function tok(id, u, role) { return jwt.sign({ id, username: u, role, isDeveloper: false, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

const M = (id) => 'D3L-' + id;
async function cleanup() {
  for (const [s, p] of [
    ["DELETE FROM channel_menu_items WHERE menu_item_id LIKE 'D3L-%'", []],
    ["DELETE FROM menu WHERE id LIKE 'D3L-%'", []],
    ["DELETE FROM brands WHERE id = 'BR-D3LIST'", []],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function insMenu(id, o) {
  await db.query(
    'INSERT INTO menu (id, name, name_en, category, brand_id, price, cost, cost_source, computed_cost, tax_category, is_tax_inclusive, active, bom_id, image_data, is_semi_finished, is_deleted) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)',
    [id, o.name, o.nameEn == null ? null : o.nameEn, o.category || 'D3CAT', o.brandId || null,
     o.price, o.cost, o.costSource || null, o.computedCost || 0, o.taxCategory || 'S',
     o.incl ? 1 : 0, o.active === false ? 0 : 1, o.bomId || null, o.image || null]);
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  const [[{ db: liveDb }]] = await db.query('SELECT DATABASE() AS db');
  if (liveDb !== 'moroccan_taste_pos_test') {
    console.error('REFUSING TO RUN — connected DB is "' + liveDb + '", expected moroccan_taste_pos_test');
    process.exit(2);
  }
  console.log('\n═══ D3 — GET /api/menu/list (DB: ' + liveDb + ') ═══\n');

  const mgr = tok(9930001, 'd3l_mgr', 'manager');
  let origVat = null; let exitCode = 0;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DB_NAME: 'moroccan_taste_pos_test', MYSQL_DATABASE: 'moroccan_taste_pos_test', DATABASE_URL: '', MYSQL_URL: '' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    if (!(await waitForSchema())) { console.error('menu.cost_source migration did not appear'); process.exit(2); }

    await cleanup();
    // Seed a KNOWN VATRate (20, not 15) to prove the endpoint reads settings.
    const [ov] = await db.query("SELECT setting_value FROM settings WHERE setting_key='VATRate' LIMIT 1");
    origVat = ov.length ? ov[0].setting_value : null;
    await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('VATRate','20') ON DUPLICATE KEY UPDATE setting_value='20'");

    await db.query('INSERT INTO brands (id, name, is_active) VALUES (?,?,1)', ['BR-D3LIST', 'D3LIST Brand']);
    // Tax-INCLUSIVE standard: price 120 @ VAT 20% → pre-tax 100, cost 50 → margin 50 / 50%.
    await insMenu(M('INCL'), { name: 'D3LIST inclusive', nameEn: 'Inclusive', brandId: 'BR-D3LIST', price: 120, cost: 50, costSource: 'manual', taxCategory: 'S', incl: true, image: IMG });
    // Tax-EXCLUSIVE: price 100 as-is, cost 40 → margin 60 / 60%.
    await insMenu(M('EXCL'), { name: 'D3LIST exclusive', nameEn: 'Exclusive', price: 100, cost: 40, taxCategory: 'S', incl: false });
    // Missing name_en.
    await insMenu(M('NOEN'), { name: 'D3LIST بدون إنجليزي', nameEn: '', price: 50, cost: 10, taxCategory: 'S', incl: false });
    // Negative margin: pre-tax 100, cost 150 → margin -50.
    await insMenu(M('NEG'), { name: 'D3LIST negative', nameEn: 'Neg', price: 100, cost: 150, taxCategory: 'S', incl: false });
    // Two extra rows for pagination (total ≥ 6 with the D3LIST prefix).
    await insMenu(M('P1'), { name: 'D3LIST p1', nameEn: 'P1', price: 10, cost: 1, incl: false });
    await insMenu(M('P2'), { name: 'D3LIST p2', nameEn: 'P2', price: 10, cost: 1, incl: false });

    // channel_menu_items → channelCount 2 (CH-A, CH-B) / branchCount 2 (BR-1, BR-2).
    let cmi = 0;
    for (const [ch, br, av] of [['CH-A', 'BR-1', 1], ['CH-A', 'BR-2', 1], ['CH-B', 'BR-1', 1], ['CH-A', 'BR-3', 0]]) {
      await db.query('INSERT INTO channel_menu_items (id, channel_id, branch_id, menu_item_id, is_available) VALUES (?,?,?,?,?)',
        ['CMI-D3L-' + (cmi++), ch, br, M('INCL'), av]);
    }

    // ── auth ──────────────────────────────────────────────────────────────────
    const anon = await req('GET', '/api/menu/list', null);
    check('no token → 401', anon.status === 401, anon.status);

    // ── full list ───────────────────────────────────────────────────────────
    const all = await req('GET', '/api/menu/list?q=D3LIST&pageSize=100', mgr);
    check('list → 200 + data[] + pagination', all.status === 200 && Array.isArray(all.body.data) && all.body.pagination && typeof all.body.pagination.total === 'number', { st: all.status });
    check('response reads the SEEDED VATRate (20, not hardcoded 15)', all.body && Number(all.body.vatRate) === 20, all.body && all.body.vatRate);
    const rows = (all.body && all.body.data) || [];
    const byId = {}; rows.forEach((r) => { byId[r.id] = r; });
    const incl = byId[M('INCL')], excl = byId[M('EXCL')];

    // ── image bytes NOT shipped ───────────────────────────────────────────────
    check('INCL row present with hasImage=true', !!incl && incl.hasImage === true, incl && { hasImage: incl.hasImage });
    check('imageVer is an 8-char SHA1 prefix (not the bytes)', !!incl && typeof incl.imageVer === 'string' && incl.imageVer.length === 8, incl && incl.imageVer);
    check('image base64 bytes appear NOWHERE in the response', all.raw.indexOf(IMG_MARKER) === -1, all.raw.indexOf(IMG_MARKER));
    check('row carries no imageData/image_data field', !!incl && incl.imageData === undefined && incl.image_data === undefined, incl && Object.keys(incl));

    // ── derived counts ────────────────────────────────────────────────────────
    check('channelCount derived = 2 (distinct channels, available only)', !!incl && incl.channelCount === 2, incl && incl.channelCount);
    check('branchCount derived = 2 (distinct branches, available only)', !!incl && incl.branchCount === 2, incl && incl.branchCount);

    // ── margin math (tax-inclusive vs exclusive) ─────────────────────────────
    check('INCL pre-tax price = 100 (120 / 1.20)', !!incl && Math.abs(incl.preTaxPrice - 100) < 0.001, incl && incl.preTaxPrice);
    check('INCL marginValue = 50, marginPct = 50', !!incl && Math.abs(incl.marginValue - 50) < 0.001 && Math.abs(incl.marginPct - 50) < 0.001, incl && { v: incl.marginValue, p: incl.marginPct });
    check('EXCL pre-tax price = 100 (used as-is), marginValue = 60, marginPct = 60', !!excl && Math.abs(excl.preTaxPrice - 100) < 0.001 && Math.abs(excl.marginValue - 60) < 0.001 && Math.abs(excl.marginPct - 60) < 0.001, excl && { pt: excl.preTaxPrice, v: excl.marginValue, p: excl.marginPct });
    check('costSource + taxCategory surfaced on the row', !!incl && incl.costSource === 'manual' && incl.taxCategory === 'S', incl && { cs: incl.costSource, tc: incl.taxCategory });
    check('brandName resolved via LEFT JOIN brands', !!incl && incl.brandName === 'D3LIST Brand', incl && incl.brandName);

    // ── pagination ────────────────────────────────────────────────────────────
    const pg1 = await req('GET', '/api/menu/list?q=D3LIST&pageSize=2&page=1&sort=name&dir=asc', mgr);
    const pg2 = await req('GET', '/api/menu/list?q=D3LIST&pageSize=2&page=2&sort=name&dir=asc', mgr);
    check('pageSize=2 returns exactly 2 rows', pg1.body && pg1.body.data.length === 2, pg1.body && pg1.body.data.length);
    check('pagination.total counts all matches (≥ 6)', pg1.body && pg1.body.pagination.total >= 6, pg1.body && pg1.body.pagination.total);
    const ids1 = new Set((pg1.body.data || []).map((r) => r.id));
    const ids2 = (pg2.body.data || []).map((r) => r.id);
    check('page 2 rows differ from page 1 (real offset paging)', ids2.length > 0 && ids2.every((id) => !ids1.has(id)), { p1: [...ids1], p2: ids2 });

    // ── filters ───────────────────────────────────────────────────────────────
    const me = await req('GET', '/api/menu/list?q=D3LIST&missingNameEn=1', mgr);
    const meIds = new Set((me.body.data || []).map((r) => r.id));
    check('missingNameEn=1 includes the blank-name_en row, excludes the translated one', meIds.has(M('NOEN')) && !meIds.has(M('INCL')), [...meIds]);

    const nm = await req('GET', '/api/menu/list?q=D3LIST&negativeMargin=1', mgr);
    const nmIds = new Set((nm.body.data || []).map((r) => r.id));
    check('negativeMargin=1 includes the loss item, excludes the profitable one', nmIds.has(M('NEG')) && !nmIds.has(M('INCL')), [...nmIds]);

    const chf = await req('GET', '/api/menu/list?q=D3LIST&channel=CH-A', mgr);
    const chIds = new Set((chf.body.data || []).map((r) => r.id));
    check('channel=CH-A includes the item wired to CH-A, excludes one with no channel row', chIds.has(M('INCL')) && !chIds.has(M('EXCL')), [...chIds]);
  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', (e && e.stack) || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
    // restore VATRate to whatever it was (or 15 if it was unset).
    try {
      if (origVat != null) await db.query("UPDATE settings SET setting_value=? WHERE setting_key='VATRate'", [origVat]);
      else await db.query("UPDATE settings SET setting_value='15' WHERE setting_key='VATRate'");
    } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
