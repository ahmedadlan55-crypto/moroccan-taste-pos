'use strict';
/* Integration — Phase U backend, second wave. Proves units-of-measure across the
   document types NOT covered by uomDocs.api.test.js:
     • item-units CRUD (GET/PUT) + validators + factor-lock-after-history
     • production issue-materials (major unit) + record-output (major unit) → base
     • stocktake V2 composite count (major + minor) → base variance
     • pos-v2 cashier expand-to-base (unitFactor) + conflict guard
     • warehouse transfer entered in a major unit → base qty stored
   Base unit = PCS (factor 1), major = CTN (1 carton = 12). Run:
     node tests/integration/uomBackend2.api.test.js */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = 3993;
let pass = 0, fail = 0; const fails = [];
function check(n, c, x) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, x != null ? '→ ' + JSON.stringify(x).slice(0, 240) : ''); } }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;
const tok = () => jwt.sign({ id: 1, username: 'admin', role: 'admin', isDeveloper: true, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '2h' });
function api(method, p, body, extra) {
  return new Promise((res) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json', Authorization: 'Bearer ' + tok(), 'Idempotency-Key': 'u2-' + Math.random().toString(36).slice(2) }, extra || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (data) r.write(data); r.end();
  });
}
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

// ── fixture ids ──────────────────────────────────────────────────────────────
const WH = 'WH-U2', WHO = 'WH-U2O';
const ITEM = 'IT-U2', RAW = 'RAW-U2', FG = 'FG-U2';
const BOMID = 'BOM-U2', MENU = 'MENU-U2';

async function cleanup() {
  const stmts = [
    ["DELETE il FROM inv_stocktake_items il JOIN inv_stocktakes d ON d.id=il.stocktake_id WHERE d.warehouse_id IN (?,?)", [WH, WHO]],
    ["DELETE FROM inv_stocktakes WHERE warehouse_id IN (?,?)", [WH, WHO]],
    ["DELETE l FROM production_issue_lines l JOIN production_orders o ON o.id=l.production_order_id WHERE o.warehouse_id IN (?,?)", [WH, WHO]],
    ["DELETE FROM production_issue_events WHERE production_order_id IN (SELECT id FROM production_orders WHERE warehouse_id IN (?,?))", [WH, WHO]],
    ["DELETE FROM production_output WHERE production_order_id IN (SELECT id FROM production_orders WHERE warehouse_id IN (?,?))", [WH, WHO]],
    ["DELETE FROM production_consumption WHERE production_order_id IN (SELECT id FROM production_orders WHERE warehouse_id IN (?,?))", [WH, WHO]],
    ["DELETE FROM production_orders WHERE warehouse_id IN (?,?)", [WH, WHO]],
    ["DELETE FROM bom_lines WHERE bom_id=?", [BOMID]],
    ["DELETE FROM bom WHERE id=?", [BOMID]],
    ["DELETE FROM warehouse_transfers WHERE from_warehouse_id IN (?,?) OR to_warehouse_id IN (?,?)", [WH, WHO, WH, WHO]],
    ["DELETE FROM pos_order_lines WHERE order_id IN (SELECT id FROM pos_orders WHERE id LIKE 'U2ORD%')", []],
    ["DELETE FROM pos_orders WHERE id LIKE 'U2ORD%'", []],
    ["DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)", [WH, WHO]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)", [WH, WHO]],
    ["DELETE FROM item_units WHERE item_id IN (?,?,?)", [ITEM, RAW, FG]],
    ["DELETE FROM menu WHERE id=?", [MENU]],
    ["DELETE FROM inv_items WHERE id IN (?,?,?)", [ITEM, RAW, FG]],
    ["DELETE FROM warehouses WHERE id IN (?,?)", [WH, WHO]],
  ];
  for (const [s, p] of stmts) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WH, 'U2', 'مستودع U2', 'main']);
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)", [WHO, 'U2O', 'مستودع إخراج U2', 'branch']);
  await db.query("INSERT INTO inv_items (id,name,sku,category,unit,cost,active) VALUES (?,?,?,?,?,5,1)", [ITEM, 'صنف وحدات 2', 'U2-1', 'عام', 'حبة']);
  await db.query("INSERT INTO inv_items (id,name,sku,category,unit,cost,active) VALUES (?,?,?,?,?,4,1)", [RAW, 'مادة خام U2', 'U2-RAW', 'خام', 'حبة']);
  await db.query("INSERT INTO inv_items (id,name,sku,category,unit,cost,active,kind) VALUES (?,?,?,?,?,0,1,'semi')", [FG, 'منتج U2', 'U2-FG', 'إنتاج', 'حبة']);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())", ['WS-U2-1', WH, ITEM, 200, 5]);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())", ['WS-U2-RAW', WH, RAW, 240, 4]);
  // units: base PCS (f1), major CTN (f12) for ITEM, RAW; FG base PCS + major BOX (f6)
  for (const it of [ITEM, RAW]) {
    await db.query("INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base) VALUES (?,?,?,?,1,1),(?,?,?,?,0,12)",
      ['IU-' + it + '-B', it, 'حبة', 'PCS', 'IU-' + it + '-M', it, 'كرتون', 'CTN']);
  }
  await db.query("INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base) VALUES (?,?,?,?,1,1),(?,?,?,?,0,6)",
    ['IU-FG-B', FG, 'حبة', 'PCS', 'IU-FG-M', FG, 'صندوق', 'BOX']);
  // BOM → FG: yield 10, consumes RAW ×24 per batch.
  await db.query("INSERT INTO bom (id,product_id,version,yield_quantity,yield_unit,is_active,product_source) VALUES (?,?,1,10,'PCS',1,'inv')", [BOMID, FG]);
  await db.query("INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct) VALUES ('BL-U2-1',?,?,24,'حبة',0)", [BOMID, RAW]);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'S')", [MENU, 'منتج كاشير U2', 20, 'عام']);
}
async function stock(wh, it) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [wh, it]); return r.length ? Number(r[0].qty) : 0; }

(async () => {
  await seed();
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0', INV_MAKER_CHECKER: '0', POS_V2_ENABLED: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('no server'); process.exit(2); }

    // ═══ 1) item-units CRUD ═══
    console.log('\n═══ item-units CRUD ═══');
    const g0 = await api('GET', `/api/inventory/v2/items/${ITEM}/units`);
    check('GET units returns base + major (seeded)', g0.status === 200 && g0.body.data.units.length === 2 && g0.body.data.hasMovements === false, g0.body && g0.body.data);
    const v0 = g0.body.data.item.version;
    // PUT rename major + add a third unit (PAL f144), keep base
    const putOk = await api('PUT', `/api/inventory/v2/items/${ITEM}/units`, {
      expectedVersion: v0,
      units: [
        { unitCode: 'PCS', unitName: 'حبة', isBase: true, conversionToBase: 1 },
        { unitCode: 'CTN', unitName: 'كرتون', isBase: false, conversionToBase: 12 },
        { unitCode: 'PAL', unitName: 'بالة', isBase: false, conversionToBase: 144, allowSale: true },
      ],
    });
    check('PUT valid unit set → 200 (3 units)', putOk.status === 200 && putOk.body.data.units.length === 3, putOk.body);
    // two bases → DUPLICATE_BASE_UNIT
    const dup = await api('PUT', `/api/inventory/v2/items/${ITEM}/units`, { units: [{ unitCode: 'PCS', isBase: true, conversionToBase: 1 }, { unitCode: 'CTN', isBase: true, conversionToBase: 12 }] });
    check('two base units → DUPLICATE_BASE_UNIT (422)', dup.status === 422 && dup.body.code === 'DUPLICATE_BASE_UNIT', dup.body && dup.body.code);
    // base factor ≠ 1 → VALIDATION_ERROR
    const bf = await api('PUT', `/api/inventory/v2/items/${ITEM}/units`, { units: [{ unitCode: 'PCS', isBase: true, conversionToBase: 2 }] });
    check('base factor ≠ 1 → rejected', bf.status === 422, bf.body && bf.body.code);
    // negative factor → INVALID_CONVERSION_FACTOR
    const nf = await api('PUT', `/api/inventory/v2/items/${ITEM}/units`, { units: [{ unitCode: 'PCS', isBase: true, conversionToBase: 1 }, { unitCode: 'CTN', isBase: false, conversionToBase: -3 }] });
    check('negative factor → INVALID_CONVERSION_FACTOR', nf.status === 422 && nf.body.code === 'INVALID_CONVERSION_FACTOR', nf.body && nf.body.code);

    // create a movement for ITEM → factor becomes locked
    await db.query("INSERT INTO inventory_movements (id, warehouse_id, item_id, item_name, type, qty, reason, username, movement_date, seq) VALUES (?,?,?,?,?,?,?,?,NOW(),0)",
      ['MV-U2LOCK', WH, ITEM, 'صنف وحدات 2', 'in', 1, 'seed-lock', 'test']);
    const gLock = await api('GET', `/api/inventory/v2/items/${ITEM}/units`);
    check('GET reports hasMovements=true after a movement', gLock.body.data.hasMovements === true, gLock.body && gLock.body.data.hasMovements);
    const vLock = gLock.body.data.item.version;
    // change CTN factor after history → UNIT_LOCKED_BY_HISTORY
    const lock1 = await api('PUT', `/api/inventory/v2/items/${ITEM}/units`, {
      expectedVersion: vLock,
      units: [{ unitCode: 'PCS', isBase: true, conversionToBase: 1 }, { unitCode: 'CTN', isBase: false, conversionToBase: 6 }, { unitCode: 'PAL', isBase: false, conversionToBase: 144 }],
    });
    check('change factor after history → UNIT_LOCKED_BY_HISTORY (409)', lock1.status === 409 && lock1.body.code === 'UNIT_LOCKED_BY_HISTORY', lock1.body && lock1.body.code);
    // delete CTN after history → UNIT_LOCKED_BY_HISTORY
    const lock2 = await api('PUT', `/api/inventory/v2/items/${ITEM}/units`, {
      expectedVersion: vLock, units: [{ unitCode: 'PCS', isBase: true, conversionToBase: 1 }, { unitCode: 'PAL', isBase: false, conversionToBase: 144 }],
    });
    check('delete existing unit after history → UNIT_LOCKED_BY_HISTORY', lock2.status === 409 && lock2.body.code === 'UNIT_LOCKED_BY_HISTORY', lock2.body && lock2.body.code);
    // deactivate CTN (same factor) after history → allowed
    const lock3 = await api('PUT', `/api/inventory/v2/items/${ITEM}/units`, {
      expectedVersion: vLock,
      units: [{ unitCode: 'PCS', isBase: true, conversionToBase: 1 }, { unitCode: 'CTN', isBase: false, conversionToBase: 12, isActive: false }, { unitCode: 'PAL', isBase: false, conversionToBase: 144 }],
    });
    check('deactivate unit (factor unchanged) after history → 200', lock3.status === 200, lock3.body && lock3.body.code);
    // clean the lock movement so later stock reads are unaffected
    await db.query("DELETE FROM inventory_movements WHERE id='MV-U2LOCK'");

    // ═══ 2) production issue (CTN) + output (BOX) → base ═══
    console.log('\n═══ production UoM ═══');
    const pc = await api('POST', '/api/inventory/v2/production-orders', { bomId: BOMID, warehouseId: WH, outputWarehouseId: WHO, qtyPlanned: 10 });
    const poId = pc.body && pc.body.data && pc.body.data.id;
    check('create production order (plan RAW=24 base)', (pc.status === 201 || pc.status === 200) && !!poId, pc.body);
    const pv = (pc.body.data && pc.body.data.version) || 1;
    const pa = await api('POST', `/api/inventory/v2/production-orders/${poId}/approve`, { expectedVersion: pv });
    check('approve order', pa.status === 200, pa.body);
    const av = (pa.body.data && pa.body.data.version) || 2;
    // issue 2 CARTONS of RAW = 24 base → stock 240 → 216
    const iss = await api('POST', `/api/inventory/v2/production-orders/${poId}/issue-materials`, { expectedVersion: av, lines: [{ itemId: RAW, enteredUnitCode: 'CTN', enteredQty: 2 }] });
    check('issue 2 CTN of RAW posts', iss.status === 200, iss.body);
    check('RAW stock = 216 base (240 − 24)', near(await stock(WH, RAW), 216), await stock(WH, RAW));
    const [pil] = await db.query('SELECT base_qty, entered_qty, entered_unit_code, conversion_factor_snapshot, qty FROM production_issue_lines WHERE production_order_id=? ORDER BY id DESC LIMIT 1', [poId]);
    check('issue line snapshot (base 24, entered 2 CTN, factor 12, qty=base)', pil.length && near(pil[0].base_qty, 24) && near(pil[0].entered_qty, 2) && pil[0].entered_unit_code === 'CTN' && near(pil[0].conversion_factor_snapshot, 12) && near(pil[0].qty, 24), pil[0]);
    const iv = (iss.body.version) || (av + 1);
    // record output 1 BOX of FG = 6 base → +6 at WHO
    const rec = await api('POST', `/api/inventory/v2/production-orders/${poId}/record-output`, { expectedVersion: iv, outputUnitCode: 'BOX', goodQty: 1 });
    check('record-output 1 BOX posts', rec.status === 200, rec.body);
    check('FG stock = 6 base (1 BOX × 6) at output wh', near(await stock(WHO, FG), 6), await stock(WHO, FG));
    const [pout] = await db.query('SELECT base_qty, entered_qty, entered_unit_code, conversion_factor_snapshot, qty FROM production_output WHERE production_order_id=? ORDER BY id DESC LIMIT 1', [poId]);
    check('output snapshot (base 6, entered 1 BOX, factor 6)', pout.length && near(pout[0].base_qty, 6) && near(pout[0].entered_qty, 1) && pout[0].entered_unit_code === 'BOX' && near(pout[0].conversion_factor_snapshot, 6) && near(pout[0].qty, 6), pout[0]);

    // ═══ 3) stocktake composite (5 CTN + 3 PCS = 63) ═══
    console.log('\n═══ stocktake composite ═══');
    // the CRUD section above deactivated ITEM's CTN — reactivate for the count.
    await db.query("UPDATE item_units SET is_active=1 WHERE item_id=? AND unit_code='CTN'", [ITEM]);
    const sc = await api('POST', '/api/inventory/v2/stocktakes', { warehouseId: WH, scopeType: 'items', itemIds: [ITEM] });
    const stId = sc.body && sc.body.data && sc.body.data.id;
    check('create stocktake', (sc.status === 201 || sc.status === 200) && !!stId, sc.body);
    const stv = (sc.body.data && sc.body.data.version) || 1;
    const ss = await api('POST', `/api/inventory/v2/stocktakes/${stId}/start`, { expectedVersion: stv });
    check('start stocktake (snapshot 200)', ss.status === 200, ss.body);
    const cc = await api('PUT', `/api/inventory/v2/stocktakes/${stId}/counts`, { counts: [{ itemId: ITEM, enteredUnitCode: 'CTN', majorQty: 5, minorQty: 3 }] });
    check('composite count saved', cc.status === 200 && cc.body.applied === 1, cc.body);
    const [sti] = await db.query('SELECT counted_qty, base_qty, entered_qty, entered_unit_code, conversion_factor_snapshot, variance FROM inv_stocktake_items WHERE stocktake_id=? AND item_id=? LIMIT 1', [stId, ITEM]);
    check('counted = 63 base (5×12+3), snapshot factor 12, variance −137 (63−200)', sti.length && near(sti[0].counted_qty, 63) && near(sti[0].base_qty, 63) && sti[0].entered_unit_code === 'CTN' && near(sti[0].conversion_factor_snapshot, 12) && near(sti[0].variance, -137), sti[0]);
    // NULL semantics: a count with neither entered nor major/minor stays uncounted
    const ccNull = await api('PUT', `/api/inventory/v2/stocktakes/${stId}/counts`, { counts: [{ itemId: ITEM, countedQty: null }] });
    const [sti2] = await db.query('SELECT counted_qty FROM inv_stocktake_items WHERE stocktake_id=? AND item_id=? LIMIT 1', [stId, ITEM]);
    check('countedQty=null → uncounted (NULL, not zero)', ccNull.status === 200 && sti2[0].counted_qty === null, sti2[0]);

    // ═══ 4) pos-v2 cashier expand-to-base ═══
    console.log('\n═══ pos-v2 cashier UoM ═══');
    const ordId = 'U2ORD' + Date.now();
    const up = await api('POST', '/api/pos/v2/orders', { id: ordId, orderType: 'takeaway', lines: [{ menuId: MENU, qty: 2, unitFactor: 12, enteredUnitCode: 'CTN' }] });
    check('cashier upsert with unitFactor=12 → ok', (up.status === 200 || up.status === 201) && up.body.success, { status: up.status });
    const [pl] = await db.query('SELECT qty, entered_qty, entered_unit_code, conversion_factor_snapshot, unit_price FROM pos_order_lines WHERE order_id=? LIMIT 1', [ordId]);
    check('line qty = 24 base (2 CTN × 12), entered 2 CTN factor 12, base price', pl.length && near(pl[0].qty, 24) && near(pl[0].entered_qty, 2) && pl[0].entered_unit_code === 'CTN' && near(pl[0].conversion_factor_snapshot, 12) && near(pl[0].unit_price, 20), pl[0]);
    check('order total = 24 × 20 = 480 (price = factor × base)', near(up.body.data.totals.subtotal, 480), up.body.data && up.body.data.totals);
    // client baseQty mismatch → UNIT_CONVERSION_CONFLICT
    const conf = await api('POST', '/api/pos/v2/orders', { id: ordId + 'X', lines: [{ menuId: MENU, qty: 2, unitFactor: 12, baseQty: 99 }] });
    check('cashier client baseQty mismatch → UNIT_CONVERSION_CONFLICT', conf.status === 409 && conf.body.code === 'UNIT_CONVERSION_CONFLICT', conf.body && conf.body.code);

    // ═══ 5) warehouse transfer entered in CTN → base stored ═══
    console.log('\n═══ transfer UoM ═══');
    const tr = await api('POST', '/api/erp/warehouse-transfers', { fromWarehouseId: WH, toWarehouseId: WHO, items: [{ itemId: RAW, enteredUnitCode: 'CTN', qty: 1 }] });
    check('create transfer with 1 CTN → 201', tr.status === 201, tr.body);
    const [wt] = await db.query('SELECT items_json FROM warehouse_transfers WHERE id=? LIMIT 1', [tr.body && tr.body.id]);
    let tItems = null; try { tItems = JSON.parse(wt[0].items_json); } catch (_) {}
    check('transfer line stored as 12 base (1 CTN × 12) + snapshot', tItems && near(tItems[0].qty, 12) && near(tItems[0].baseQty, 12) && near(tItems[0].conversionFactorSnapshot, 12) && tItems[0].enteredUnitCode === 'CTN', tItems && tItems[0]);
  } catch (e) { fail++; fails.push('FATAL ' + e.message); console.error(e); } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} uomBackend2: ${pass} passed, ${fail} failed`);
  if (fails.length) console.log(fails.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
