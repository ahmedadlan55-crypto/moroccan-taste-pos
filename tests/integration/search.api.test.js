'use strict';
/* Integration — search endpoints (item-search / accounts-search / suppliers-search).
   Boots a real server, seeds fixtures (item + units + barcode, gl accounts, supplier),
   and asserts search-by-name/sku/barcode/category, pagination, warehouse balance +
   warning, unit payload, exactBarcodeId, postingOnly leaf-only + context allow-list.
   Run: node tests/integration/search.api.test.js  (MariaDB on 3307) */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = 3994;
const WH = 'WH-SRCH', ITEM = 'IT-SRCH-OIL', BC = '2777000123';
const ACC_HDR = 'SRCH-HDR', ACC_LEAF = 'SRCH-EXP', SUP = 'SUP-SRCH';
let pass = 0, fail = 0; const fails = [];
function check(n, c, x) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, x != null ? '→ ' + JSON.stringify(x).slice(0, 220) : ''); } }
const tok = () => jwt.sign({ id: 0, username: 'admin', role: 'admin', isDeveloper: true, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '2h' });
function get(p, token) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: p, headers: { Accept: 'application/json', Authorization: 'Bearer ' + (token || tok()) } }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); r.end();
  });
}
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM item_units WHERE item_id=?', [ITEM]], ['DELETE FROM item_barcodes WHERE item_id=?', [ITEM]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]], ['DELETE FROM inv_items WHERE id=?', [ITEM]],
    ['DELETE FROM warehouses WHERE id=?', [WH]], ['DELETE FROM gl_accounts WHERE id IN (?,?)', [ACC_HDR, ACC_LEAF]],
    ['DELETE FROM suppliers WHERE id=?', [SUP]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WH, 'SRCH', 'مستودع البحث', 'main']);
  await db.query("INSERT INTO inv_items (id,name,name_en,sku,category,unit,big_unit,conv_rate,cost,min_stock,active,tracking_mode,barcode,barcode_norm) VALUES (?,?,?,?,?,?,?,?,?,?,1,'expiry',?,?)",
    [ITEM, 'زيت بحث', 'search oil', 'SRCH-OIL', 'زيوت', 'لتر', 'كرتون', 12, 10, 5, BC, BC]);
  await db.query("INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base) VALUES ('IU-SB',?,'لتر','لتر',1,1),('IU-SM',?,'كرتون','كرتون',0,12)", [ITEM, ITEM]);
  await db.query("INSERT INTO item_barcodes (id,item_id,code,code_norm,is_primary) VALUES ('IB-SRCH',?,?,?,1)", [ITEM, BC, BC]);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES ('WS-SRCH',?,?,3,10)", [WH, ITEM]); // 3 <= min 5 → low
  await db.query("INSERT INTO gl_accounts (id,code,name_ar,name_en,type,parent_id,is_active) VALUES (?,?,?,?,?,NULL,1)", [ACC_HDR, '5000-H', 'مصروفات رئيسي', 'exp header', 'expense']);
  await db.query("INSERT INTO gl_accounts (id,code,name_ar,name_en,type,parent_id,is_active) VALUES (?,?,?,?,?,?,1)", [ACC_LEAF, '5001-L', 'هدر بحث', 'waste', 'expense', ACC_HDR]);
  await db.query("INSERT INTO suppliers (id,name,name_en,phone,vat_number,is_active) VALUES (?,?,?,?,?,1)", [SUP, 'مورد البحث', 'search supplier', '0555000111', '300000000003']);
}

(async () => {
  await seed();
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('no server'); process.exit(2); }
    console.log('\n═══ search endpoints ═══');
    // item-search: by name
    let r = await get('/api/inventory/v2/item-search?q=' + encodeURIComponent('زيت بحث') + '&warehouseId=' + WH);
    const hit = r.body && r.body.data && r.body.data.find((x) => x.id === ITEM);
    check('item-search by Arabic name finds item', r.status === 200 && !!hit, r.body && r.body.data);
    check('item-search returns base + major unit', hit && hit.baseUnit.code === 'لتر' && hit.majorUnits.length === 1 && hit.majorUnits[0].factor === 12, hit && hit.majorUnits);
    check('item-search returns warehouse qty + low warning', hit && hit.warehouseQty === 3 && hit.warning === 'low', hit && { q: hit.warehouseQty, w: hit.warning });
    check('item-search returns primary barcode + trackingMode', hit && hit.primaryBarcode === BC && hit.trackingMode === 'expiry', hit);
    // by SKU
    r = await get('/api/inventory/v2/item-search?q=SRCH-OIL');
    check('item-search by SKU finds item', r.body && r.body.data.some((x) => x.id === ITEM), r.body && r.body.data.length);
    // by barcode → exactBarcodeId
    r = await get('/api/inventory/v2/item-search?q=' + BC);
    check('item-search by barcode → exactBarcodeId set', r.body && r.body.exactBarcodeId === ITEM, r.body && r.body.exactBarcodeId);
    // by category
    r = await get('/api/inventory/v2/item-search?q=' + encodeURIComponent('زيوت'));
    check('item-search by category finds item', r.body && r.body.data.some((x) => x.id === ITEM), null);
    // pagination shape
    r = await get('/api/inventory/v2/item-search?pageSize=1&page=1');
    check('item-search paginates (pageSize honored)', r.body && r.body.data.length <= 1 && r.body.pagination.pageSize === 1, r.body && r.body.pagination);
    // SQL-injection attempt is parameterized (no error, no dump)
    r = await get('/api/inventory/v2/item-search?q=' + encodeURIComponent("' OR '1'='1"));
    check('item-search resists SQL injection (200, filtered)', r.status === 200 && Array.isArray(r.body.data), r.status);

    // accounts-search: postingOnly leaf only + context allow-list
    r = await get('/api/accounting/accounts/search?q=500&context=issue&postingOnly=1');
    const codes = (r.body && r.body.data || []).map((a) => a.code);
    check('accounts-search postingOnly excludes header (parent) account', r.status === 200 && codes.includes('5001-L') && !codes.includes('5000-H'), codes);
    check('accounts-search context=issue returns only expense accounts', (r.body.data || []).every((a) => a.type === 'expense'), r.body && r.body.data);
    // receipt context should NOT return the expense leaf
    r = await get('/api/accounting/accounts/search?q=500&context=receipt');
    check('accounts-search context=receipt excludes expense accounts', !(r.body.data || []).some((a) => a.code === '5001-L'), r.body && r.body.data);

    // suppliers-search
    r = await get('/api/erp/suppliers/search?q=' + encodeURIComponent('مورد البحث'));
    check('suppliers-search by name', r.status === 200 && r.body.data.some((s) => s.id === SUP), r.body && r.body.data);
    r = await get('/api/erp/suppliers/search?q=0555000111');
    check('suppliers-search by phone', r.body && r.body.data.some((s) => s.id === SUP), null);
  } catch (e) { fail++; fails.push('FATAL ' + e.message); console.error(e); } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} search: ${pass} passed, ${fail} failed`);
  if (fails.length) console.log(fails.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
