/**
 * Sprint 3 D3 — menu.cost_source provenance + recipe-cost lock.
 *
 * Covers:
 *   • a manual create (POST /api/menu) stamps cost_source='manual'.
 *   • saving a BOM recipe (POST /api/menu/:id/recipe-bom) recomputes menu.cost
 *     AND stamps cost_source='recipe'.
 *   • a manual cost edit (PUT /api/menu/:id) on a recipe-locked row is REJECTED
 *     with HTTP 409 + code COST_LOCKED_BY_RECIPE, and the cost NUMBER is left
 *     untouched by the rejected edit.
 *   • the same edit WITH { costOverride:true } succeeds, writes the new cost,
 *     and flips cost_source to 'manual'.
 *   • re-saving OTHER fields with the UNCHANGED recipe cost does NOT trip the
 *     lock and preserves cost_source='recipe'.
 *   • the backfill relabel touches only the LABEL, never the cost VALUE.
 *
 * ISOLATED DB: pinned to moroccan_taste_pos_test BEFORE db/connection loads.
 * Run: npm run test:cost-source   (MySQL must be up)
 */
'use strict';

// ── ISOLATED TEST DB — must be set before db/connection.js is required ────────
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL;
delete process.env.MYSQL_URL;
try { require('dotenv').config(); } catch (_) {}
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;

const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.CS_TEST_PORT || 3272);
const BASE = { host: '127.0.0.1', port: PORT };

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
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
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
function tok(id, u, role) { return jwt.sign({ id, username: u, role, isDeveloper: role === 'admin', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
async function costRow(id) { const [r] = await db.query('SELECT cost, cost_source FROM menu WHERE id=?', [id]); return r[0] || null; }

const ING = 'D3CS-ING1';
async function cleanup() {
  for (const [s, p] of [
    ["DELETE bl FROM bom_lines bl JOIN bom b ON b.id=bl.bom_id WHERE b.product_id LIKE 'D3CS-%'", []],
    ["DELETE FROM bom WHERE product_id LIKE 'D3CS-%'", []],
    ["DELETE FROM recipe WHERE menu_id LIKE 'D3CS-%'", []],
    ["DELETE FROM menu WHERE id LIKE 'D3CS-%'", []],
    ["DELETE FROM inv_items WHERE id LIKE 'D3CS-ING%'", []],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
// A full PUT body (the handler destructures many fields; mysql2 rejects undefined
// bind params, so name/category/stock/minStock/active must be present).
function putBody(over) {
  return Object.assign({
    name: 'D3CS منتج', nameEn: 'D3CS product', price: 20, category: 'D3CS',
    cost: 6, stock: 0, minStock: 0, active: true,
  }, over || {});
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  const [[{ db: liveDb }]] = await db.query('SELECT DATABASE() AS db');
  if (liveDb !== 'moroccan_taste_pos_test') {
    console.error('REFUSING TO RUN — connected DB is "' + liveDb + '", expected moroccan_taste_pos_test');
    process.exit(2);
  }
  console.log('\n═══ D3 — menu.cost_source + recipe lock (DB: ' + liveDb + ') ═══\n');

  const admin = tok(9930002, 'd3cs_admin', 'admin');
  let exitCode = 0;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DB_NAME: 'moroccan_taste_pos_test', MYSQL_DATABASE: 'moroccan_taste_pos_test', DATABASE_URL: '', MYSQL_URL: '' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    if (!(await waitForSchema())) { console.error('menu.cost_source migration did not appear'); process.exit(2); }

    await cleanup();
    // Ingredient (cost 3) for the recipe.
    await db.query("INSERT INTO inv_items (id, name, sku, sku_norm, unit, cost, stock, min_stock, active, kind, version) VALUES (?,?,?,?,?,?,0,0,1,'raw',1)",
      [ING, 'D3CS مكوّن', 'D3CS-ING1', 'D3CS-ING1', 'كجم', 3]);

    // ── manual create → cost_source='manual' ──────────────────────────────────
    const created = await req('POST', '/api/menu', admin, { name: 'D3CS منتج', nameEn: 'D3CS product', price: 20, category: 'D3CS', cost: 4, active: true });
    check('POST /api/menu → 200 + id', created.status === 200 && created.body && created.body.id, created.body);
    const id = created.body && created.body.id;
    // Rename the id into the D3CS- namespace for deterministic cleanup.
    const menuId = 'D3CS-' + String(id).replace(/[^A-Za-z0-9]/g, '');
    await db.query('UPDATE menu SET id=? WHERE id=?', [menuId, id]);
    let cr = await costRow(menuId);
    check('manual create stamped cost_source=manual', cr && cr.cost_source === 'manual', cr);

    // ── recipe-bom save → cost recomputed + cost_source='recipe' ──────────────
    const bom = await req('POST', '/api/menu/' + menuId + '/recipe-bom', admin, {
      lines: [{ componentItemId: ING, quantity: 2, wastePct: 0 }], yieldQuantity: 1, yieldUnit: 'PCS',
    });
    check('recipe-bom save → 200 + computedCost=6', bom.status === 200 && bom.body && Math.abs(Number(bom.body.computedCost) - 6) < 0.001, bom.body);
    cr = await costRow(menuId);
    check('recipe save set cost=6 AND cost_source=recipe', cr && Math.abs(Number(cr.cost) - 6) < 0.001 && cr.cost_source === 'recipe', cr);

    // ── manual cost edit is LOCKED ────────────────────────────────────────────
    const locked = await req('PUT', '/api/menu/' + menuId, admin, putBody({ cost: 99 }));
    check('manual cost edit on a recipe row → 409 COST_LOCKED_BY_RECIPE', locked.status === 409 && locked.body && locked.body.code === 'COST_LOCKED_BY_RECIPE', { st: locked.status, code: locked.body && locked.body.code });
    cr = await costRow(menuId);
    check('the rejected edit did NOT change the cost NUMBER (still 6, still recipe)', cr && Math.abs(Number(cr.cost) - 6) < 0.001 && cr.cost_source === 'recipe', cr);

    // ── re-saving other fields with the UNCHANGED cost keeps the recipe label ──
    const keep = await req('PUT', '/api/menu/' + menuId, admin, putBody({ name: 'D3CS منتج محدث', cost: 6 }));
    check('re-save with unchanged cost → 200 (no lock trip)', keep.status === 200, keep.body);
    cr = await costRow(menuId);
    check('unchanged-cost re-save preserved cost_source=recipe + cost=6', cr && cr.cost_source === 'recipe' && Math.abs(Number(cr.cost) - 6) < 0.001, cr);

    // ── override unlocks + flips to manual ────────────────────────────────────
    const over = await req('PUT', '/api/menu/' + menuId, admin, putBody({ cost: 99, costOverride: true }));
    check('cost edit WITH costOverride:true → 200', over.status === 200, over.body);
    cr = await costRow(menuId);
    check('override wrote cost=99 AND flipped cost_source=manual', cr && Math.abs(Number(cr.cost) - 99) < 0.001 && cr.cost_source === 'manual', cr);

    // ── relabel-only guarantee: labeling never touches the cost NUMBER ────────
    const relId = 'D3CS-RELABEL';
    await db.query("INSERT INTO menu (id, name, price, cost, cost_source, bom_id, active, is_deleted) VALUES (?,?,?,?,?,?,1,0)",
      [relId, 'D3CS relabel', 10, 42.5, null, 'BOM-D3CS-X']);
    // exactly the backfill UPDATE (label only, guarded by bom_id).
    await db.query("UPDATE menu SET cost_source='recipe' WHERE cost_source IS NULL AND bom_id IS NOT NULL AND id=?", [relId]);
    const rel = await costRow(relId);
    check('backfill relabel set cost_source=recipe WITHOUT changing cost (still 42.5)', rel && rel.cost_source === 'recipe' && Math.abs(Number(rel.cost) - 42.5) < 0.001, rel);
  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', (e && e.stack) || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
