#!/usr/bin/env node
'use strict';
/**
 * tests/menuApiHardening.test.js — the menu list reads never ship image bytes,
 * and a broken list read fails CLOSED. Against the live DB, through the REAL
 * routes/menu router.
 *
 * WHAT WAS BROKEN
 *   · GET /api/menu and GET /api/menu/all did `SELECT m.*` — every product's
 *     base64 image (~66 MB across the prod table) left MySQL and rode the wire
 *     on EVERY catalog load, while the paginated GET /list never shipped a byte.
 *   · Both handlers answered `[]` with 200 on ANY error, so a broken query was
 *     indistinguishable from a restaurant with no menu.
 *   · There was no single-item read; the product page pulled the whole /all
 *     list — every image in the catalog — to find one row.
 *
 * WHAT THIS FILE PINS
 *   1. GET / and GET /all rows carry NO imageData key at all (absent, not
 *      null), plus hasImage + an 8-char SHA-256 imageVer that equals what
 *      node computes over the same bytes — so the version really is a content
 *      hash of the stored image, not a counter.
 *   2. The bytes never leave MySQL: the SQL the handlers execute selects
 *      neither `m.*` nor a bare `image_data` column (the CASE/SHA2 expressions
 *      that compute presence + hash INSIDE MySQL are the only references).
 *   3. GET /:id is the ONE read that still returns imageData; a soft-deleted
 *      row is 404 with a code; an inactive row still resolves; its imageVer is
 *      the same 8 chars the list reads carry.
 *   4. A failing list query answers 500 { success:false, code:'MENU_LIST_FAILED' }
 *      and never echoes the driver's message (it names tables/columns).
 *
 * Cleanup runs before AND after; every row carries the MENUHARD- prefix.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db/connection');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve().then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── fixtures ────────────────────────────────────────────────────────────────
const P = 'MENUHARD-';
const ITEM_IMG = P + 'IMG';           // active, with image
const ITEM_NOIMG = P + 'NOIMG';       // active, no image
const ITEM_INACTIVE = P + 'INACTIVE'; // inactive, with image — /all and /:id only
const ITEM_DELETED = P + 'DELETED';   // soft-deleted — nowhere
const BRAND = 'BR-MENUHARD';
const BRAND_NAME = 'MENUHARD Brand';
// A real 1×1 PNG so the fixture passes the same shape the upload path stores.
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// The bytes are ASCII, so MySQL's SHA2(str,256) over the column equals node's
// sha256 over the same JS string — the imageVer contract, computed independently.
const IMG_VER = crypto.createHash('sha256').update(IMG, 'utf8').digest('hex').slice(0, 8);
const MARKER = IMG.slice(22, 60); // a slice of the base64 payload — must appear in no list body

const ADMIN = { id: 990401, username: 'menuhard_admin', role: 'admin' };

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // The global /api JWT gate (server.js) is what sets req.user in production;
  // the router's list reads rely on it rather than re-verifying inline, so the
  // stub here stands in for a gate that already admitted an admin token.
  app.use((req, _res, next) => { req.user = { ...ADMIN }; next(); });
  app.use('/api/menu', require('../routes/menu'));
  return app;
}

async function seed() {
  await db.query('INSERT INTO brands (id, name, is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)', [BRAND, BRAND_NAME]);
  const ins = (id, o) => db.query(
    'INSERT INTO menu (id, name, name_en, category, brand_id, price, cost, tax_category, is_tax_inclusive, active, image_data, is_semi_finished, is_deleted) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)',
    [id, o.name, o.nameEn, 'MENUHARD-CAT', BRAND, o.price, o.cost, 'S', 0, o.active ? 1 : 0, o.image || null, o.deleted ? 1 : 0]);
  await ins(ITEM_IMG, { name: 'صنف بصورة (اختبار)', nameEn: 'With image', price: 21.7391, cost: 5, active: true, image: IMG });
  await ins(ITEM_NOIMG, { name: 'صنف بلا صورة (اختبار)', nameEn: 'No image', price: 10, cost: 2, active: true });
  await ins(ITEM_INACTIVE, { name: 'صنف موقوف (اختبار)', nameEn: 'Inactive', price: 12, cost: 3, active: false, image: IMG });
  await ins(ITEM_DELETED, { name: 'صنف محذوف (اختبار)', nameEn: 'Deleted', price: 9, cost: 1, active: true, image: IMG, deleted: true });
}

async function cleanup() {
  await db.query('DELETE FROM menu WHERE id LIKE ?', [P + '%']).catch(() => {});
  await db.query('DELETE FROM brands WHERE id=?', [BRAND]).catch(() => {});
}

async function main() {
  await cleanup();
  await seed();
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Every SQL statement the router executes is recorded here (the router holds
  // the same module object, so wrapping db.query on it is enough).
  const executed = [];
  const realQuery = db.query.bind(db);
  db.query = (sql, params) => { executed.push(String(sql)); return realQuery(sql, params); };

  const call = async (p) => {
    const res = await fetch(base + p, { headers: { accept: 'application/json' } });
    const raw = await res.text();
    let json = null; try { json = JSON.parse(raw); } catch (_) { /* non-JSON body */ }
    return { status: res.status, json, raw };
  };
  const mine = (rows) => (Array.isArray(rows) ? rows.filter((r) => String(r.id).startsWith(P)) : []);
  const byId = (rows, id) => mine(rows).find((r) => r.id === id) || null;

  // The list's select-list, with the two IMAGE_META_SQL expressions removed:
  // whatever `image_data` reference survives is a bare column leaving MySQL.
  const selectListWithoutMeta = (sql) => sql.split(/\bFROM\b/i)[0]
    .replace(/CASE WHEN m\.image_data IS NULL OR m\.image_data='' THEN[\s\S]*?END/gi, '');
  const lastListSql = () => executed.filter((s) => /FROM menu m/i.test(s)).pop() || '';

  try {
    console.log('\n1. GET /api/menu — the cashier catalog carries no image bytes');
    let listRows = null, listRaw = '';
    await test('answers 200 with an array', async () => {
      executed.length = 0;
      const r = await call('/api/menu');
      eq(r.status, 200, 'status');
      ok(Array.isArray(r.json), 'array body');
      listRows = r.json; listRaw = r.raw;
    });
    await test('the row WITH an image: no imageData key, hasImage=true, imageVer = 8-char sha256 prefix', async () => {
      const row = byId(listRows, ITEM_IMG);
      ok(row, 'seeded row present');
      eq(Object.prototype.hasOwnProperty.call(row, 'imageData'), false, 'imageData key must be ABSENT');
      eq(row.hasImage, true, 'hasImage');
      eq(typeof row.imageVer, 'string', 'imageVer type');
      ok(/^[0-9a-f]{8}$/.test(row.imageVer), 'imageVer is 8 hex chars: ' + row.imageVer);
      eq(row.imageVer, IMG_VER, 'imageVer is the content hash node computes');
      eq(row.brandName, BRAND_NAME, 'brand join still populated by the explicit column list');
    });
    await test('the row WITHOUT an image: hasImage=false, imageVer=null, still no imageData key', async () => {
      const row = byId(listRows, ITEM_NOIMG);
      ok(row, 'seeded row present');
      eq(Object.prototype.hasOwnProperty.call(row, 'imageData'), false, 'imageData key must be ABSENT');
      eq(row.hasImage, false, 'hasImage');
      eq(row.imageVer, null, 'imageVer');
    });
    await test('not one byte of the base64 payload appears anywhere in the response', async () => {
      ok(!listRaw.includes(MARKER), 'base64 marker found in GET / body');
    });
    await test('the SQL selects neither m.* nor a bare image_data column (bytes stay in MySQL)', async () => {
      const sql = lastListSql();
      ok(sql, 'a menu query was executed');
      ok(!/SELECT\s+m\.\*/i.test(sql), 'SELECT m.* is back: ' + sql.slice(0, 120));
      const rest = selectListWithoutMeta(sql);
      ok(!/image_data/i.test(rest), 'image_data selected as a column: ' + rest.slice(0, 200));
    });
    await test('inactive and soft-deleted rows stay out of the cashier catalog (unchanged semantics)', async () => {
      eq(byId(listRows, ITEM_INACTIVE), null, 'inactive');
      eq(byId(listRows, ITEM_DELETED), null, 'deleted');
    });

    console.log('\n2. GET /api/menu/all — the admin catalog follows the same rule');
    let allRows = null, allRaw = '';
    await test('answers 200; includes the inactive row, hides the soft-deleted one', async () => {
      executed.length = 0;
      const r = await call('/api/menu/all?type=all');
      eq(r.status, 200, 'status');
      ok(Array.isArray(r.json), 'array body');
      allRows = r.json; allRaw = r.raw;
      ok(byId(allRows, ITEM_INACTIVE), 'inactive row listed');
      eq(byId(allRows, ITEM_DELETED), null, 'deleted row hidden');
    });
    await test('every seeded row: no imageData key; hasImage/imageVer match the stored bytes', async () => {
      for (const id of [ITEM_IMG, ITEM_NOIMG, ITEM_INACTIVE]) {
        const row = byId(allRows, id);
        ok(row, id + ' present');
        eq(Object.prototype.hasOwnProperty.call(row, 'imageData'), false, id + ' imageData key must be ABSENT');
      }
      eq(byId(allRows, ITEM_IMG).hasImage, true); eq(byId(allRows, ITEM_IMG).imageVer, IMG_VER);
      eq(byId(allRows, ITEM_INACTIVE).hasImage, true); eq(byId(allRows, ITEM_INACTIVE).imageVer, IMG_VER);
      eq(byId(allRows, ITEM_NOIMG).hasImage, false); eq(byId(allRows, ITEM_NOIMG).imageVer, null);
    });
    await test('not one byte of the base64 payload appears in the /all response', async () => {
      ok(!allRaw.includes(MARKER), 'base64 marker found in GET /all body');
    });
    await test('the /all SQL selects neither m.* nor a bare image_data column', async () => {
      const sql = lastListSql();
      ok(sql, 'a menu query was executed');
      ok(!/SELECT\s+m\.\*/i.test(sql), 'SELECT m.* is back');
      ok(!/image_data/i.test(selectListWithoutMeta(sql)), 'image_data selected as a column');
    });

    console.log('\n3. GET /api/menu/:id — the one read that carries the bytes');
    await test('returns the full item INCLUDING imageData, with the same imageVer as the lists', async () => {
      const r = await call('/api/menu/' + ITEM_IMG);
      eq(r.status, 200, 'status');
      eq(r.json.id, ITEM_IMG, 'id');
      eq(r.json.imageData, IMG, 'imageData carries the stored data URL');
      eq(r.json.hasImage, true, 'hasImage');
      eq(r.json.imageVer, IMG_VER, 'imageVer parity with the list reads');
      eq(r.json.brandName, BRAND_NAME, 'brand join');
      eq(r.json.isTaxInclusive, false, 'tax flag surfaced');
      eq(r.json.price, 21.7391, 'price at 4 decimals');
    });
    await test('an image-less item: imageData=null (key present), hasImage=false', async () => {
      const r = await call('/api/menu/' + ITEM_NOIMG);
      eq(r.status, 200, 'status');
      eq(Object.prototype.hasOwnProperty.call(r.json, 'imageData'), true, 'key present on the single read');
      eq(r.json.imageData, null, 'null, not a fabricated value');
      eq(r.json.hasImage, false, 'hasImage');
      eq(r.json.imageVer, null, 'imageVer');
    });
    await test('an inactive item still resolves (the editor must open it)', async () => {
      const r = await call('/api/menu/' + ITEM_INACTIVE);
      eq(r.status, 200, 'status');
      eq(r.json.active, 0, 'active flag carried as stored');
    });
    await test('a soft-deleted item is 404 with a code, not a 200 with a corpse', async () => {
      const r = await call('/api/menu/' + ITEM_DELETED);
      eq(r.status, 404, 'status');
      eq(r.json && r.json.code, 'MENU_ITEM_NOT_FOUND', 'code');
      eq(r.json && r.json.success, false, 'success');
    });
    await test('fixed sibling routes are not shadowed by the /:id catch-all', async () => {
      const r = await call('/api/menu/categories');
      eq(r.status, 200, '/categories status');
      ok(Array.isArray(r.json), '/categories still answers its own array, not a 404 item lookup');
    });

    console.log('\n4. a broken list read fails CLOSED');
    await test('GET / on a DB failure → 500 { success:false, code:MENU_LIST_FAILED }, driver message withheld', async () => {
      const failing = (sql, params) => {
        if (/FROM menu m/i.test(String(sql))) return Promise.reject(new Error('SIMULATED_DB_FAILURE column x.y'));
        return realQuery(sql, params);
      };
      const prev = db.query; db.query = failing;
      try {
        const r = await call('/api/menu');
        eq(r.status, 500, 'status');
        eq(r.json && r.json.success, false, 'success');
        eq(r.json && r.json.code, 'MENU_LIST_FAILED', 'code');
        ok(!r.raw.includes('SIMULATED_DB_FAILURE'), 'the driver message leaked to the client');
        ok(!Array.isArray(r.json), 'must NOT be the old silent []');
      } finally { db.query = prev; }
    });
    await test('GET /all on a DB failure → the same closed contract', async () => {
      const failing = (sql, params) => {
        if (/FROM menu m/i.test(String(sql))) return Promise.reject(new Error('SIMULATED_DB_FAILURE'));
        return realQuery(sql, params);
      };
      const prev = db.query; db.query = failing;
      try {
        const r = await call('/api/menu/all');
        eq(r.status, 500, 'status');
        eq(r.json && r.json.code, 'MENU_LIST_FAILED', 'code');
        ok(!r.raw.includes('SIMULATED_DB_FAILURE'), 'the driver message leaked to the client');
      } finally { db.query = prev; }
    });
  } finally {
    db.query = realQuery;
    server.close();
    await cleanup();
    await db.end?.().catch?.(() => {});
  }

  console.log(`\n${_passed}/${_total} passed${_failed ? `, ${_failed} failed` : ''}`);
  if (_failed) process.exit(1);
  console.log('  ✅ list reads ship hasImage + imageVer only; /:id carries the bytes; list errors fail closed');
  // routes/menu.js pulls in lib modules that may keep timers alive; results are printed.
  process.exit(0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
