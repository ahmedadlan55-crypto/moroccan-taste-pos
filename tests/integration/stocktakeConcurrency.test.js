/**
 * Phase 3C — stocktake post concurrency (ENFORCE=0).
 *
 * Two concurrent posts of one approved stocktake → exactly one 200 / one 409,
 * and the variance is applied to stock EXACTLY ONCE (the doc-row FOR UPDATE lock
 * + conditional version UPDATE serialize them; the loser rolls back fully).
 *
 * Run: node tests/integration/stocktakeConcurrency.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.STK_CONC_PORT || 3233);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-STKC2', IT = 'STKC-IT';
const S = '/api/inventory/v2/stocktakes';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, u, role, dev) { return jwt.sign({ id, username: u, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
async function qty() { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, IT]); return r.length ? Number(r[0].qty) : 0; }

async function cleanup() {
  const sqls = [
    ["DELETE e FROM inv_tx_events e JOIN inv_stocktakes d ON d.id=e.doc_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE i FROM inv_stocktake_items i JOIN inv_stocktakes d ON d.id=i.stocktake_id WHERE d.warehouse_id=?", [WH]],
    ['DELETE FROM inv_stocktakes WHERE warehouse_id=?', [WH]],
    ['DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE FROM inv_adjustments WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inventory_movements WHERE warehouse_id=?', [WH]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inv_items WHERE id=?', [IT]],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
    ['DELETE FROM idempotency_keys WHERE username=?', ['stkc_admin']],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Stocktake post concurrency ═══\n');
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, 'STKC', 'مستودع تزامن', 'main']);
  await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [IT, 'صنف تزامن', 'خام', 'كجم', 5, 0]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WSC', WH, IT, 100, 5]);
  const admin = tok(0, 'stkc_admin', 'admin', true);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    const c = await req('POST', S, admin, { warehouseId: WH, scopeType: 'items', itemIds: [IT], reason: 'تزامن' });
    const id = c.body.id;
    await req('POST', `${S}/${id}/start`, admin, {});
    await req('PUT', `${S}/${id}/counts`, admin, { counts: [{ itemId: IT, countedQty: 90 }] }); // variance −10
    await req('POST', `${S}/${id}/submit`, admin, {});
    await req('POST', `${S}/${id}/approve`, admin, {}); // admin bypasses maker-checker
    const before = await qty();
    const [p1, p2] = await Promise.all([
      req('POST', `${S}/${id}/post`, admin, { expectedVersion: 4 }),
      req('POST', `${S}/${id}/post`, admin, { expectedVersion: 4 }),
    ]);
    const wins = [p1, p2].filter((x) => x.status === 200).length;
    const conflicts = [p1, p2].filter((x) => x.status === 409).length;
    check('concurrent post → exactly one 200 / one 409', wins === 1 && conflicts === 1, { s1: p1.status, s2: p2.status });
    check('variance applied EXACTLY ONCE (100 − 10 = 90)', (await qty()) === before - 10, { before, after: await qty() });
    const [posted] = await db.query('SELECT status, adjustment_id FROM inv_stocktakes WHERE id=?', [id]);
    check('stocktake posted with a single linked adjustment', posted[0].status === 'posted' && !!posted[0].adjustment_id, posted[0]);
    const [adjCount] = await db.query('SELECT COUNT(*) n FROM inv_adjustments WHERE warehouse_id=?', [WH]);
    check('exactly one adjustment created (loser rolled back)', Number(adjCount[0].n) === 1, adjCount[0]);
  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
