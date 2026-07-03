/**
 * Phase W4 — Barcode integration test.
 * Boots server.js and exercises the barcode surface:
 *   • PUT /items/:id/barcodes sets a primary + two secondary codes.
 *   • GET /items/by-barcode finds by primary and by a secondary (with variant).
 *   • collision across items → 409 BARCODE_TAKEN.
 *   • items list q=<barcode> finds the item.
 *   • removing a code → by-barcode 404.
 *   • unknown code → 404.
 * Run: node tests/integration/barcode.api.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.BC_TEST_PORT || 3238);
const BASE = { host: '127.0.0.1', port: PORT };
const ITEM = 'BC-ITEM-1', ITEM2 = 'BC-ITEM-2';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role) { return jwt.sign({ id, username, role, isDeveloper: role === 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM item_barcodes WHERE item_id IN (?,?)', [ITEM, ITEM2]],
    ['DELETE FROM inv_items WHERE id IN (?,?)', [ITEM, ITEM2]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n=== Barcode (W4) - integration ===\n');
  await cleanup();
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,1)", [ITEM, 'كولا 2 لتر', 'مشروبات', 'حبة', 3]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,1)", [ITEM2, 'صنف آخر', 'عام', 'حبة', 1]);
  const admin = tok(0, 'bc_admin', 'admin');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // set primary + 2 secondaries (size variants)
    const put = await req('PUT', `/api/inventory/v2/items/${ITEM}/barcodes`, admin, { primaryBarcode: '6291001112345', barcodes: [{ code: '6291001199999', sizeVariant: '2L' }, { code: 'sku cola pack', sizeVariant: 'PACK' }], expectedVersion: 1 });
    check('PUT barcodes → 200', put.status === 200, { s: put.status, b: put.body });

    const byPrimary = await req('GET', '/api/inventory/v2/items/by-barcode?code=6291001112345', admin);
    check('by-barcode finds by PRIMARY', byPrimary.status === 200 && byPrimary.body.data.item.id === ITEM, { s: byPrimary.status });
    const bySecondary = await req('GET', '/api/inventory/v2/items/by-barcode?code=6291001199999', admin);
    check('by-barcode finds by SECONDARY + variant', bySecondary.status === 200 && bySecondary.body.data.item.id === ITEM && bySecondary.body.data.sizeVariant === '2L', { s: bySecondary.status, v: bySecondary.body && bySecondary.body.data && bySecondary.body.data.sizeVariant });
    const byNormalized = await req('GET', '/api/inventory/v2/items/by-barcode?code=' + encodeURIComponent('  sku COLA pack '), admin);
    check('by-barcode normalizes the query (whitespace/case)', byNormalized.status === 200 && byNormalized.body.data.item.id === ITEM, { s: byNormalized.status });

    // collision: another item tries to claim an existing code → 409
    const collide = await req('PUT', `/api/inventory/v2/items/${ITEM2}/barcodes`, admin, { primaryBarcode: '6291001112345', barcodes: [], expectedVersion: 1 });
    check('collision → 409 BARCODE_TAKEN', collide.status === 409 && collide.body && collide.body.code === 'BARCODE_TAKEN', { s: collide.status, c: collide.body && collide.body.code });

    // items list q=barcode finds it
    const list = await req('GET', '/api/inventory/v2/items?q=6291001199999', admin);
    check('items list q=barcode finds the item', list.status === 200 && (list.body.data || []).some((r) => r.id === ITEM), { s: list.status, n: list.body && list.body.data && list.body.data.length });

    // remove all codes → by-barcode 404
    const clear = await req('PUT', `/api/inventory/v2/items/${ITEM}/barcodes`, admin, { primaryBarcode: null, barcodes: [] });
    check('clear barcodes → 200', clear.status === 200, clear.status);
    const gone = await req('GET', '/api/inventory/v2/items/by-barcode?code=6291001112345', admin);
    check('by-barcode after clear → 404', gone.status === 404, gone.status);

    const unknown = await req('GET', '/api/inventory/v2/items/by-barcode?code=DOESNOTEXIST999', admin);
    check('unknown code → 404', unknown.status === 404, unknown.status);

    // invalid code → 422
    const bad = await req('PUT', `/api/inventory/v2/items/${ITEM}/barcodes`, admin, { barcodes: [{ code: 'x' }] });
    check('invalid short code → 422 VALIDATION_ERROR', bad.status === 422 && bad.body && bad.body.code === 'VALIDATION_ERROR', { s: bad.status, c: bad.body && bad.body.code });
  } catch (e) { console.error('ERROR', e); exitCode = 1; }
  finally { try { server.kill(); } catch (_) {} }
  console.log('\n=== ' + _p + ' passed, ' + _f + ' failed ===\n');
  await cleanup().catch(() => {});
  setTimeout(() => process.exit(_f || exitCode ? 1 : 0), 300);
})();
