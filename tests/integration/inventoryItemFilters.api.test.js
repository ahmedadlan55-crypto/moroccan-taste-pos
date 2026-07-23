'use strict';
/* Integration — B2: the three redesigned inventory-list facets, wired server-side.
 * hasImage / belowReorder / branchId were UI-only no-ops; GET
 * /api/inventory/v2/items now actually filters on them. Hermetic B2F-* fixtures
 * (the RC seed has no item-images/reorder-rules), scoped by a dedicated category
 * so the 2000 RC items don't interfere.
 *
 * Run: node tests/integration/inventoryItemFilters.api.test.js
 */
require('dotenv').config();
const harness = require('../helpers/testHarness');
harness.activate();
const http = require('http');
const db = require('../../db/connection');

const CAT = 'B2FCAT';
const BRA = 'B2F-BR-A', BRB = 'B2F-BR-B';
const WHA = 'B2F-WH-A', WHB = 'B2F-WH-B';
const IMG = 'B2F-IMG', NOIMG = 'B2F-NOIMG', LOW = 'B2F-LOW', OK = 'B2F-OK', INA = 'B2F-INA', INB = 'B2F-INB';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }
function call(port, method, p, token) {
  return new Promise((res) => {
    const headers = { Accept: 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j, raw: b }); }); });
    r.on('error', () => res({ status: 0 })); r.end();
  });
}
async function cleanup() {
  try { await db.query('DELETE FROM warehouse_item_rules WHERE item_id LIKE "B2F-%"'); } catch (_) {}
  try { await db.query('DELETE FROM warehouse_stock WHERE item_id LIKE "B2F-%"'); } catch (_) {}
  try { await db.query('DELETE FROM menu WHERE id LIKE "B2F-%"'); } catch (_) {}
  try { await db.query('DELETE FROM inv_items WHERE id LIKE "B2F-%"'); } catch (_) {}
  try { await db.query('DELETE FROM warehouses WHERE id LIKE "B2F-%"'); } catch (_) {}
}
async function item(id, extra) {
  await db.query("INSERT INTO inv_items (id, name, name_en, category, sku, sku_norm, unit, cost, stock, min_stock, active, kind, version, default_warehouse_id) VALUES (?,?,?,?,?,?, 'قطعة', 5, 0, 0, 1, 'raw', 1, ?)",
    [id, id + ' ع', id + ' en', CAT, id, id, (extra && extra.dw) || null]);
}
async function stock(id, wh, qty) { await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost) VALUES (?,?,?,?,5)', ['B2FWS-' + id + '-' + wh, wh, id, qty]); }

(async () => {
  let server = null;
  try {
    await harness.ensureSchema();
    await cleanup();
    console.log('\n═══ B2 inventory-list facets (isolated test DB) ═══');
    await db.query('INSERT INTO warehouses (id,code,name,type,branch_id,is_active) VALUES (?,?,?,?,?,1),(?,?,?,?,?,1)', [WHA, 'B2FA', 'مستودع أ', 'branch', BRA, WHB, 'B2FB', 'مستودع ب', 'branch', BRB]);
    // has-image: an inv_items row + a menu row (same id) carrying image bytes
    await item(IMG); await db.query("INSERT INTO menu (id, name, price, cost, active, is_deleted, image_data) VALUES (?, 'صنف بصورة', 10, 5, 1, 0, ?)", [IMG, 'data:image/png;base64,AAAABBBB']);
    await item(NOIMG); // no menu row → no image
    await item(LOW, { dw: WHA }); await stock(LOW, WHA, 1); await db.query('INSERT INTO warehouse_item_rules (id, warehouse_id, item_id, reorder_point, is_enabled) VALUES (?,?,?,?,1)', ['B2FR-LOW', WHA, LOW, 10]);
    await item(OK, { dw: WHA }); await stock(OK, WHA, 100); await db.query('INSERT INTO warehouse_item_rules (id, warehouse_id, item_id, reorder_point, is_enabled) VALUES (?,?,?,?,1)', ['B2FR-OK', WHA, OK, 10]);
    await item(INA); await stock(INA, WHA, 50);
    await item(INB); await stock(INB, WHB, 50);

    server = await harness.spawnServer();
    const port = server.port;
    const token = require('jsonwebtoken').sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const ids = async (qs) => { const r = await call(port, 'GET', '/api/inventory/v2/items?pageSize=200&category=' + CAT + qs, token); return { r, set: new Set((r.body && r.body.data || []).map((x) => x.id)) }; };

    const base = await ids('');
    check('baseline: all 6 B2F items returned', [IMG, NOIMG, LOW, OK, INA, INB].every((x) => base.set.has(x)), [...base.set]);
    check('list response carries NO image_data / base64 bytes', !/image_data|base64/i.test(base.r.raw), base.r.raw.slice(0, 120));

    const hi = await ids('&hasImage=has');
    check('hasImage=has → includes the imaged item, excludes the un-imaged', hi.set.has(IMG) && !hi.set.has(NOIMG), [...hi.set]);
    const hn = await ids('&hasImage=none');
    check('hasImage=none → includes the un-imaged item, excludes the imaged', hn.set.has(NOIMG) && !hn.set.has(IMG), [...hn.set]);

    const br = await ids('&belowReorder=1');
    check('belowReorder=1 → includes the low item, excludes the well-stocked', br.set.has(LOW) && !br.set.has(OK), [...br.set]);

    const ba = await ids('&branchId=' + BRA);
    check('branchId=A → includes items in branch A, excludes branch-B-only item', ba.set.has(INA) && !ba.set.has(INB), [...ba.set]);
    const bb = await ids('&branchId=' + BRB);
    check('branchId=B → includes branch-B item, excludes branch-A-only item', bb.set.has(INB) && !bb.set.has(INA), [...bb.set]);

    await cleanup();
    console.log('\nB2 inventory filters: ' + pass + ' passed, ' + fail + ' failed' + (fail ? ' → ' + fails.join('; ') : ''));
    if (server && server.close) await server.close().catch(() => {});
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('FATAL', e); try { await cleanup(); } catch (_) {}
    if (server && server.close) try { await server.close(); } catch (_) {}
    process.exit(1);
  }
})();
