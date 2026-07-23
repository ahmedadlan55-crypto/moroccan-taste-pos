/**
 * Sprint 3 (A2) — per-user saved DataTable views (routes/saved-views.js).
 *
 * Covers:
 *   • CRUD scoped to the owner (create / list / update / delete as user A).
 *   • module query param is required (400 without it).
 *   • filtersJson / columnsJson / sortJson round-trip as JSON values.
 *   • A shared view (isShared=1) is VISIBLE to user B via GET, but B cannot
 *     edit it (403) or delete it (403); A's PRIVATE view is invisible to B.
 *   • PUT/DELETE of a non-existent id → 404.
 *   • No token → 401.
 *
 * Hermetic bootstrap (same style as tests/integration/cashierReadiness.api.test.js):
 * an in-process express app mounting ONLY routes/saved-views.js, which verifies
 * its own JWT. Identities are two JWTs with different `username` claims (no users
 * row required — verifyToken defaults a missing user to token version 1).
 *
 * ISOLATED DB: pinned to moroccan_taste_pos_test BEFORE db/connection is loaded;
 * the run aborts unless the live connection is that database.
 *
 * Run: npm run test:saved-views   (MySQL must be up)
 */
'use strict';

// ── ISOLATED TEST DB — must be set before db/connection.js is required ────────
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL;
delete process.env.MYSQL_URL;
try { require('dotenv').config(); } catch (_) {}

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const savedViewsRouter = require('../../routes/saved-views');

const PORT = Number(process.env.CWB_TEST_PORT || 4022);
const BASE = { host: '127.0.0.1', port: PORT };

const U_A = 'itest_sv_user_a';
const U_B = 'itest_sv_user_b';
const MODULE = 'itest_sv_inventory';

let pass = 0, fail = 0; const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; fails.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

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
    r.setTimeout(10000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function tok(id, username) {
  return jwt.sign({ id, username, role: 'cashier', isDeveloper: false, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/saved-views', savedViewsRouter);
  return app;
}

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS saved_views (
      id VARCHAR(40) PRIMARY KEY,
      username VARCHAR(80) NOT NULL,
      module VARCHAR(60) NOT NULL,
      name VARCHAR(120) NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      is_shared BOOLEAN DEFAULT FALSE,
      filters_json LONGTEXT,
      columns_json LONGTEXT,
      sort_json VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_mod (username, module)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
async function cleanup() {
  await db.query('DELETE FROM saved_views WHERE username IN (?)', [[U_A, U_B]]).catch(() => {});
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }

  const [[{ db: liveDb }]] = await db.query('SELECT DATABASE() AS db');
  if (liveDb !== 'moroccan_taste_pos_test') {
    console.error('REFUSING TO RUN — connected DB is "' + liveDb + '", expected moroccan_taste_pos_test');
    process.exit(2);
  }
  console.log('\n═══ Sprint 3 A2 — saved-views (hermetic) — DB: ' + liveDb + ' ═══\n');

  await ensureSchema();
  await cleanup();

  const tokenA = tok(9920001, U_A);
  const tokenB = tok(9920002, U_B);

  const server = buildApp().listen(PORT);
  try {
    // ── auth + module validation ─────────────────────────────────────────────
    console.log('▸ auth + validation');
    let r = await req('GET', '/api/saved-views?module=' + MODULE, null);
    check('GET without token → 401', r.status === 401, r.status);
    r = await req('GET', '/api/saved-views', tokenA);
    check('GET without module → 400', r.status === 400, { status: r.status, body: r.body });

    // ── create (owner A) with JSON payload round-trip ────────────────────────
    console.log('▸ create + JSON round-trip');
    const filters = { status: 'open', qtyMin: 5 };
    const columns = ['name', 'qty', 'status'];
    const sort = { by: 'qty', dir: 'desc' };
    r = await req('POST', '/api/saved-views', tokenA, {
      module: MODULE, name: 'Low stock', isDefault: true, isShared: false,
      filtersJson: filters, columnsJson: columns, sortJson: sort
    });
    check('A POST private view → 201 + success', r.status === 201 && r.body && r.body.success === true, r.body);
    const privId = r.body && r.body.data && r.body.data.id;
    check('  …returns id + exact row shape',
      !!privId && r.body.data.name === 'Low stock' && r.body.data.module === MODULE &&
      r.body.data.isDefault === true && r.body.data.isShared === false, r.body && r.body.data);
    check('  …filtersJson/columnsJson/sortJson round-trip as JSON values',
      r.body.data && deepEq(r.body.data.filtersJson, filters) &&
      deepEq(r.body.data.columnsJson, columns) && deepEq(r.body.data.sortJson, sort), r.body && r.body.data);

    // ── create a SHARED view (owner A) ───────────────────────────────────────
    r = await req('POST', '/api/saved-views', tokenA, {
      module: MODULE, name: 'Team view', isShared: true, filtersJson: { flag: 1 }
    });
    check('A POST shared view → 201', r.status === 201 && r.body && r.body.success === true, r.body);
    const sharedId = r.body && r.body.data && r.body.data.id;
    check('  …isShared=true', r.body && r.body.data && r.body.data.isShared === true, r.body && r.body.data);

    // ── list (owner A sees both its rows) ────────────────────────────────────
    console.log('▸ list scoping');
    r = await req('GET', '/api/saved-views?module=' + MODULE, tokenA);
    let ids = (r.body && r.body.data || []).map((v) => v.id);
    check('A GET lists both own views (private + shared)',
      r.status === 200 && ids.indexOf(privId) !== -1 && ids.indexOf(sharedId) !== -1, ids);

    // ── list scoping for B: sees A's shared, NOT A's private ─────────────────
    r = await req('GET', '/api/saved-views?module=' + MODULE, tokenB);
    ids = (r.body && r.body.data || []).map((v) => v.id);
    check('B GET sees A\'s SHARED view', r.status === 200 && ids.indexOf(sharedId) !== -1, ids);
    check('B GET does NOT see A\'s PRIVATE view', ids.indexOf(privId) === -1, ids);

    // ── B cannot edit or delete A's shared view ──────────────────────────────
    console.log('▸ shared view is read-only to non-owner');
    r = await req('PUT', '/api/saved-views/' + sharedId, tokenB, { name: 'hijacked' });
    check('B PUT A\'s shared view → 403', r.status === 403, { status: r.status, body: r.body });
    r = await req('DELETE', '/api/saved-views/' + sharedId, tokenB);
    check('B DELETE A\'s shared view → 403', r.status === 403, { status: r.status, body: r.body });
    // …and it is genuinely unchanged (A still sees "Team view").
    r = await req('GET', '/api/saved-views?module=' + MODULE, tokenA);
    const stillThere = (r.body && r.body.data || []).find((v) => v.id === sharedId);
    check('  …shared view survived, name unchanged', !!stillThere && stillThere.name === 'Team view', stillThere);

    // ── B cannot edit A's private view either (exists but not owned) ──────────
    r = await req('PUT', '/api/saved-views/' + privId, tokenB, { name: 'nope' });
    check('B PUT A\'s private view → 403 (owned by A)', r.status === 403, { status: r.status, body: r.body });

    // ── owner A updates own view (partial: name + filters, others kept) ──────
    console.log('▸ owner update (partial)');
    r = await req('PUT', '/api/saved-views/' + privId, tokenA, { name: 'Very low stock', filtersJson: { status: 'critical' } });
    check('A PUT own view → 200 + updated name/filters',
      r.status === 200 && r.body && r.body.data && r.body.data.name === 'Very low stock' &&
      deepEq(r.body.data.filtersJson, { status: 'critical' }), r.body && r.body.data);
    check('  …untouched columnsJson/sortJson kept from before',
      r.body.data && deepEq(r.body.data.columnsJson, columns) && deepEq(r.body.data.sortJson, sort), r.body && r.body.data);

    // ── 404 for non-existent id ──────────────────────────────────────────────
    console.log('▸ not found');
    r = await req('PUT', '/api/saved-views/SV-does-not-exist', tokenA, { name: 'x' });
    check('PUT missing id → 404', r.status === 404, r.status);
    r = await req('DELETE', '/api/saved-views/SV-does-not-exist', tokenA);
    check('DELETE missing id → 404', r.status === 404, r.status);

    // ── owner A deletes own view ─────────────────────────────────────────────
    console.log('▸ owner delete');
    r = await req('DELETE', '/api/saved-views/' + privId, tokenA);
    check('A DELETE own view → 200 success', r.status === 200 && r.body && r.body.success === true, r.body);
    r = await req('GET', '/api/saved-views?module=' + MODULE, tokenA);
    ids = (r.body && r.body.data || []).map((v) => v.id);
    check('  …deleted view no longer listed for A', ids.indexOf(privId) === -1, ids);

    // ── B's own view is invisible to A ───────────────────────────────────────
    console.log('▸ B private isolation');
    r = await req('POST', '/api/saved-views', tokenB, { module: MODULE, name: 'B only' });
    const bId = r.body && r.body.data && r.body.data.id;
    check('B POST own view → 201', r.status === 201 && !!bId, r.body);
    r = await req('GET', '/api/saved-views?module=' + MODULE, tokenA);
    ids = (r.body && r.body.data || []).map((v) => v.id);
    check('A does NOT see B\'s private view', ids.indexOf(bId) === -1, ids);
  } finally {
    server.close();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }

  console.log('\n══════════════════');
  console.log(fail === 0 ? `✅ ALL ${pass} CHECKS PASSED` : `❌ ${fail} FAILED / ${pass} passed`);
  if (fail) console.log(fails.map((f) => '  - ' + f).join('\n'));
  console.log('══════════════════\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
