/**
 * Catalog bilingual (AR/EN) contract — integration test (REAL server).
 *
 * Boots server.js and exercises GET /api/pos/v2/catalog end-to-end:
 *   • item.nameEn (set + null-when-untranslated), item.categoryEn (via the
 *     new menu_category_i18n overlay),
 *   • per-unit unitNameEn (resolved via item_units.unit_id → units.name_en;
 *     null when unit_id was never wired — an honest gap, not a bug),
 *   • combo nameEn (combos read from the same `menu` row),
 *   • channel nameEn (sales_channels.name_en, already-live column),
 *   • every EXISTING response key on an item/combo/channel is untouched —
 *     this is an additive-only contract.
 *
 * Fixtures carry no brand_id (global/unscoped) so this file is decoupled
 * from the brand-scope contract, which is covered separately in
 * catalogBrandScope.api.test.js.
 *
 * Run: node tests/integration/catalogBilingual.api.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.BILI_TEST_PORT || 4001);
const BASE = { host: '127.0.0.1', port: PORT };
const API = '/api/pos/v2';

const CAT = 'BILI-TEST-CATEGORY';
const M_EN = 'BILI-M-EN', M_NOEN = 'BILI-M-NOEN', M_COMBO = 'BILI-M-COMBO';
const UNIT_EN = 'BILI-UNIT-EN';
const IU_BASE = 'BILI-IU-BASE', IU_MAJOR = 'BILI-IU-MAJOR';
const CH_ID = 'BILI-CH-1';
const U_CASHIER = 'bili_cashier';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); } }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, headers: resp.headers }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role) { return jwt.sign({ id, username, role }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function cleanup() {
  const sqls = [
    ['DELETE FROM item_units WHERE id IN (?,?)', [IU_BASE, IU_MAJOR]],
    ['DELETE FROM units WHERE id = ?', [UNIT_EN]],
    ['DELETE FROM combo_groups WHERE menu_id = ?', [M_COMBO]],
    ['DELETE FROM menu WHERE id IN (?,?,?)', [M_EN, M_NOEN, M_COMBO]],
    ['DELETE FROM menu_category_i18n WHERE category_ar = ?', [CAT]],
    ['DELETE FROM sales_channels WHERE id = ?', [CH_ID]],
    ['DELETE FROM users WHERE username = ?', [U_CASHIER]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  await db.query(
    "INSERT INTO menu (id, name, name_en, price, category, active, tax_category) VALUES (?,?,?,?,?,1,'S')",
    [M_EN, 'صنف بالعربي', 'ItemEnglishName', 21, CAT]);
  await db.query(
    "INSERT INTO menu (id, name, name_en, price, category, active, tax_category) VALUES (?,?,NULL,?,?,1,'S')",
    [M_NOEN, 'صنف بلا ترجمة', 12, CAT]);
  await db.query(
    "INSERT INTO menu (id, name, name_en, price, category, active, tax_category, is_combo) VALUES (?,?,?,?,?,1,'S',1)",
    [M_COMBO, 'عرض بالعربي', 'ComboEnglishName', 55, CAT]);
  await db.query('INSERT INTO menu_category_i18n (category_ar, category_en) VALUES (?,?)', [CAT, 'TestCategoryEnglish']);
  // Master unit row with name_en, then two item_units — one wired to it
  // (unitNameEn resolves), one NOT wired (unitNameEn stays null — honest gap).
  await db.query("INSERT INTO units (id, name_ar, name_en, type) VALUES (?,?,?,?)", [UNIT_EN, 'وحدة اختبار', 'TestUnitEnglish', 'count']);
  await db.query(
    'INSERT INTO item_units (id, item_id, unit_id, unit_name, unit_code, is_base, conversion_to_base, is_active, allow_sale) VALUES (?,?,?,?,?,1,1,1,1)',
    [IU_BASE, M_EN, UNIT_EN, 'وحدة أساس', 'BILIBASE']);
  await db.query(
    'INSERT INTO item_units (id, item_id, unit_id, unit_name, unit_code, is_base, conversion_to_base, is_active, allow_sale) VALUES (?,?,NULL,?,?,0,12,1,1)',
    [IU_MAJOR, M_EN, 'كرتون', 'BILICTN']);
  await db.query(
    "INSERT INTO sales_channels (id, code, name, name_en, channel_type, is_active, display_order) VALUES (?,?,?,?,?,1,999)",
    [CH_ID, 'BILICH', 'قناة اختبار', 'TestChannelEnglish', 'dine_in']);
  await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [U_CASHIER, 'disabled', 'cashier']);
  const [r] = await db.query('SELECT id FROM users WHERE username=?', [U_CASHIER]);
  return r[0].id;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Catalog bilingual (AR/EN) contract — integration ═══\n');
  const cashierId = await seed();
  const cashier = tok(cashierId, U_CASHIER, 'cashier');

  // NAME_EN_BACKFILL_DISABLE_WORKER=1 — a SEPARATE feature (lib/name-en-backfill-worker.js,
  // db/migrations/0015) auto-transliterates menu.name_en in the background when it's
  // NULL. Left running, it races this test's "nameEn stays null when untranslated"
  // assertion. Disabled here exactly like ZATCA_DISABLE_WORKER=1 elsewhere.
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), NAME_EN_BACKFILL_DISABLE_WORKER: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    const r = await req('GET', API + '/catalog', cashier);
    check('catalog → 200', r.status === 200, r.status);
    const items = (r.body && r.body.data && r.body.data.items) || [];
    const combos = (r.body && r.body.data && r.body.data.combos) || [];
    const channels = (r.body && r.body.data && r.body.data.channels) || [];

    const itemEn = items.find((i) => i.id === M_EN);
    const itemNoEn = items.find((i) => i.id === M_NOEN);
    check('item with name_en → nameEn rides through', !!itemEn && itemEn.nameEn === 'ItemEnglishName', itemEn);
    check('item without name_en → nameEn is null (not undefined, not dropped)', !!itemNoEn && itemNoEn.nameEn === null, itemNoEn);
    check('categoryEn resolves for BOTH items sharing the category', !!itemEn && !!itemNoEn && itemEn.categoryEn === 'TestCategoryEnglish' && itemNoEn.categoryEn === 'TestCategoryEnglish', { itemEn, itemNoEn });

    // Old response keys unchanged — additive-only contract.
    const oldKeys = ['id', 'name', 'price', 'category', 'active', 'taxCategory', 'basePrice', 'warehouseQty', 'priceSource', 'barcode', 'baseUnitName', 'units', 'imageVersion', 'isCombo'];
    const hasAllOldKeys = !!itemEn && oldKeys.every((k) => Object.prototype.hasOwnProperty.call(itemEn, k));
    check('item still carries every pre-existing key', hasAllOldKeys, itemEn && Object.keys(itemEn));
    check('old key types unchanged (price number, active boolean, units array)', !!itemEn && typeof itemEn.price === 'number' && typeof itemEn.active === 'boolean' && Array.isArray(itemEn.units), itemEn);

    // Units — unitNameEn wired vs. honest gap.
    const units = (itemEn && itemEn.units) || [];
    const unitWired = units.find((u) => u.unitCode === 'BILIBASE');
    const unitUnwired = units.find((u) => u.unitCode === 'BILICTN');
    check('unit wired to units master → unitNameEn resolves', !!unitWired && unitWired.unitNameEn === 'TestUnitEnglish', unitWired);
    check('unit with no unit_id → unitNameEn is null (honest gap)', !!unitUnwired && unitUnwired.unitNameEn === null, unitUnwired);

    // Combo nameEn.
    const combo = combos.find((c) => c.id === M_COMBO);
    check('combo carries nameEn from the same menu row', !!combo && combo.nameEn === 'ComboEnglishName', combo);
    check('combo keeps its existing keys (menuId/price/priceSource/fixedComponents/groups)', !!combo
      && combo.menuId === M_COMBO && typeof combo.price === 'number'
      && Array.isArray(combo.fixedComponents) && Array.isArray(combo.groups), combo);

    // Channel nameEn.
    const ch = channels.find((c) => c.id === CH_ID);
    check('channel carries nameEn', !!ch && ch.nameEn === 'TestChannelEnglish', ch);
    check('channel keeps its existing keys (code/useFullMenu)', !!ch && ch.code === 'BILICH' && typeof ch.useFullMenu === 'boolean', ch);
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${_f === 0 ? '✅' : '❌'} catalogBilingual.api: ${_p} passed, ${_f} failed\n`);
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
