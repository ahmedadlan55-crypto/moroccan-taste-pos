'use strict';
/* Integration — bilingual-i18n-images (Owner C): POST/PUT/DELETE/GET
 * routes/product-images.js (real DB, hermetic in-process app).
 *
 * routes/product-images.js is deliberately NOT mounted in server.js (see the
 * file header — the global /api gate's naive `startsWith('/menu')` exemption
 * would make it public if mounted under /menu*), so — same pattern as
 * tests/integration/warehouses.api.test.js — this test boots a tiny in-process
 * express app around the router directly instead of spawning server.js. The
 * router self-verifies (verifyToken → MGR → requireCapability('menu.image.manage')
 * are all wired inside routes/product-images.js itself), so the harness app
 * only needs express.json() + the router mounted at the intended path.
 *
 * What this proves:
 *   · imageDataError() reuse — MIME/size validation on PUT and POST /bulk items
 *     rejects the exact same way routes/menu.js does (oversized, unsupported
 *     MIME) — via lib/imageValidation.js, not a re-implemented copy.
 *   · SEED-% menuId is REJECTED (code SEED_ROW_EXCLUDED), never silently skipped.
 *   · POST /bulk partial success: one bad row in a batch does NOT block or
 *     roll back the other good rows (each item is its own transaction).
 *   · dryRun:true validates everything and writes NOTHING (DB image_data
 *     unchanged) but returns the same per-item result shape as a real run.
 *   · every REAL (non-dry-run) write logs an audit_logs row with
 *     entity_type='menu_image' (queried directly, not inferred from the API).
 *   · the capability gate: a MANAGER (passes the MGR role gate) whose
 *     'menu.image.manage' grant is explicitly revoked via
 *     user_permission_overrides is still denied (403) — proving the capability
 *     layer is enforced independently of the role gate, not just redundant
 *     with it.
 *
 * Applies db/migrations/capability-seeds/g-menu-images.json to permissions_v3
 * / role_permissions itself (this test does not spawn server.js, so the
 * boot-time auto-seed in server.js never runs) — tracking + removing only the
 * rows it created, same as tests/integration/inventoryAuthz.api.test.js.
 *
 * Run: node tests/integration/productImagesUpload.api.test.js   (port 4017)
 */
require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');
const productImagesRouter = require('../../routes/product-images');

const PORT = 4017;
const API = '/api/product-images';
const CAT = 'ITEST-PIMG';
const ADMIN = 'itest_pimg_admin';
const MANAGER = 'itest_pimg_manager';
const MANAGER_NOCAP = 'itest_pimg_mgr_nocap';
const ITEM_GOOD = 'ITEST-PIMG-GOOD';
const ITEM_BAD = 'ITEST-PIMG-BAD';
const ITEM_PLAIN = 'ITEST-PIMG-PLAIN';
const SEED_ITEM = 'SEED-ITEST-PIMG-1';

// A real 1×1 PNG (89 50 4E 47 magic) — tiny but genuinely decodable.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_B64;
const sha1 = (s) => (s ? crypto.createHash('sha1').update(s).digest('hex') : null);

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function req(method, p, token, body) {
  return new Promise((resolve) => {
    const d = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: s.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code })); if (d) r.write(d); r.end();
  });
}
function tok(id, username, role) { return jwt.sign({ id, username, role }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

function buildApp() {
  const app = express();
  // Matches server.js's real body-size limit (server.js:108) — the default
  // express.json() 100kb cap would reject the 301KB oversized-image fixture
  // below the app layer, before routes/product-images.js's own 300KB
  // imageDataError() check ever runs.
  app.use(express.json({ limit: '25mb' }));
  app.use(API, productImagesRouter);
  return app;
}

// ── capability seed fixtures (the g-menu-images.json proposal, applied as
// server.js's boot-time applyCapabilitySeeds would — but this test never
// spawns server.js, so it applies + tracks the rows itself) ──
const SEED_FILE = path.join(__dirname, '..', '..', 'db', 'migrations', 'capability-seeds', 'g-menu-images.json');
const SEEDS = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const createdPerms = []; const createdGrants = [];
async function applySeeds() {
  for (const cap of SEEDS) {
    const [ex] = await db.query('SELECT id FROM permissions_v3 WHERE id = ?', [cap.id]);
    if (!ex.length) {
      await db.query(
        'INSERT INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive) VALUES (?,?,?,?,?)',
        [cap.id, 'closure', cap.label_ar, cap.label_en || '', cap.is_sensitive ? 1 : 0]);
      createdPerms.push(cap.id);
    }
    for (const role of cap.roles) {
      const [g] = await db.query('SELECT 1 FROM role_permissions WHERE role = ? AND permission_id = ?', [role, cap.id]);
      if (!g.length) {
        await db.query('INSERT INTO role_permissions (role, permission_id) VALUES (?,?)', [role, cap.id]);
        createdGrants.push([role, cap.id]);
      }
    }
  }
}
async function removeSeeds() {
  for (const [role, pid] of createdGrants) { try { await db.query('DELETE FROM role_permissions WHERE role = ? AND permission_id = ?', [role, pid]); } catch (_) {} }
  for (const pid of createdPerms) { try { await db.query('DELETE FROM permissions_v3 WHERE id = ?', [pid]); } catch (_) {} }
}

const storedImage = async (id) => { const [r] = await db.query('SELECT image_data FROM menu WHERE id=?', [id]); return r.length ? r[0].image_data : undefined; };
const auditRowsFor = async (menuId) => {
  const [r] = await db.query(
    "SELECT action, entity_type, entity_id, details FROM audit_logs WHERE entity_type='menu_image' AND entity_id=? ORDER BY id",
    [menuId]);
  return r;
};

async function cleanup() {
  for (const u of [ADMIN, MANAGER, MANAGER_NOCAP]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try { await db.query('DELETE FROM user_permission_overrides WHERE username=?', [MANAGER_NOCAP]); } catch (_) {}
  try { await db.query("DELETE FROM audit_logs WHERE entity_type='menu_image' AND entity_id IN (?,?,?,?)", [ITEM_GOOD, ITEM_BAD, ITEM_PLAIN, SEED_ITEM]); } catch (_) {}
  try { await db.query('DELETE FROM menu WHERE category=? OR id IN (?,?,?,?)', [CAT, ITEM_GOOD, ITEM_BAD, ITEM_PLAIN, SEED_ITEM]); } catch (_) {}
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  await cleanup();
  await applySeeds();

  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, 'disabled', 'admin']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, 'disabled', 'manager']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER_NOCAP, 'disabled', 'manager']);
  const [adminRows] = await db.query('SELECT id FROM users WHERE username=?', [ADMIN]);
  const [mgrRows] = await db.query('SELECT id FROM users WHERE username=?', [MANAGER]);
  const [mgrNoCapRows] = await db.query('SELECT id FROM users WHERE username=?', [MANAGER_NOCAP]);
  const adminRow = adminRows[0], mgrRow = mgrRows[0], mgrNoCapRow = mgrNoCapRows[0];

  // The capability layer, isolated from the role gate: this manager has the
  // MGR role (so the role gate passes) but 'menu.image.manage' is explicitly
  // revoked for them via user_permission_overrides.
  await db.query(
    "INSERT INTO user_permission_overrides (username, permission_id, grant_type, granted_by) VALUES (?,?,'revoke',?)",
    [MANAGER_NOCAP, 'menu.image.manage', 'test-harness']);

  await db.query('INSERT INTO menu (id, name, price, category, active, image_data) VALUES (?,?,?,?,1,NULL)', [ITEM_GOOD, 'ITEST صنف صورة جيد', 5, CAT]);
  await db.query('INSERT INTO menu (id, name, price, category, active, image_data) VALUES (?,?,?,?,1,NULL)', [ITEM_BAD, 'ITEST صنف صورة سيئ', 5, CAT]);
  await db.query('INSERT INTO menu (id, name, price, category, active, image_data) VALUES (?,?,?,?,1,?)', [ITEM_PLAIN, 'ITEST صنف صورة عادي', 5, CAT, PNG_DATA_URL]);
  await db.query('INSERT INTO menu (id, name, price, category, active, image_data) VALUES (?,?,?,?,1,NULL)', [SEED_ITEM, 'ITEST صنف SEED', 5, CAT]);

  const admin = tok(adminRow.id, ADMIN, 'admin');
  const manager = tok(mgrRow.id, MANAGER, 'manager');
  const mgrNoCap = tok(mgrNoCapRow.id, MANAGER_NOCAP, 'manager');

  const server = buildApp().listen(PORT);
  try {
    console.log('\n═══ product-images bulk API ═══');

    // ── capability gate: role passes, capability explicitly revoked → 403 ──
    const denied = await req('GET', API + '/', mgrNoCap);
    check('manager with menu.image.manage REVOKED → 403 PERMISSION_DENIED', denied.status === 403 && denied.body && denied.body.code === 'PERMISSION_DENIED', denied.body);
    const deniedPut = await req('PUT', API + '/' + ITEM_GOOD, mgrNoCap, { imageData: PNG_DATA_URL });
    check('…also denied on PUT (not just GET)', deniedPut.status === 403, deniedPut.status);
    check('…and nothing was written', (await storedImage(ITEM_GOOD)) === null);

    // A manager WITH the capability (freshly seeded role_permissions grant,
    // no override) is allowed through.
    const list0 = await req('GET', API + '/', manager);
    check('manager WITH menu.image.manage → GET / succeeds', list0.status === 200 && list0.body && list0.body.success === true, list0.body);
    check('list excludes SEED-% rows always', !(list0.body.items || []).some((i) => i.id === SEED_ITEM));
    check('list never carries image_data (only imageVer/imageBytes)', !list0.raw.includes('base64'));

    // ── MIME/size validation reuses imageDataError() — single PUT ──
    const bigB64 = Buffer.alloc(301 * 1024, 7).toString('base64'); // 301KB decoded > 300KB cap
    const oversized = await req('PUT', API + '/' + ITEM_GOOD, admin, { imageData: 'data:image/png;base64,' + bigB64 });
    check('PUT oversized image (301KB decoded) → 400 + Arabic message', oversized.status === 400 && /كبير/.test(oversized.body?.error || ''), oversized.body);
    const badMime = await req('PUT', API + '/' + ITEM_GOOD, admin, { imageData: 'data:image/gif;base64,' + PNG_B64 });
    check('PUT unsupported MIME (gif) → 400 + Arabic message', badMime.status === 400 && /غير مدعومة/.test(badMime.body?.error || ''), badMime.body);
    check('…stored image still untouched after invalid PUTs', (await storedImage(ITEM_GOOD)) === null);

    // ── SEED-row exclusion (rejected, not silently skipped) ──
    const seedPut = await req('PUT', API + '/' + SEED_ITEM, admin, { imageData: PNG_DATA_URL });
    check('PUT on a SEED-% menuId → 400 SEED_ROW_EXCLUDED', seedPut.status === 400 && seedPut.body?.code === 'SEED_ROW_EXCLUDED', seedPut.body);
    const seedDel = await req('DELETE', API + '/' + SEED_ITEM, admin);
    check('DELETE on a SEED-% menuId → 400 SEED_ROW_EXCLUDED', seedDel.status === 400 && seedDel.body?.code === 'SEED_ROW_EXCLUDED', seedDel.body);

    // ── POST /bulk: cap at 100 items ──
    const tooMany = { items: Array.from({ length: 101 }, (_, i) => ({ menuId: 'ITEST-CAP-' + i, imageData: PNG_DATA_URL })) };
    const capResp = await req('POST', API + '/bulk', admin, tooMany);
    check('POST /bulk with 101 items → 400 BULK_LIMIT_EXCEEDED', capResp.status === 400 && capResp.body?.code === 'BULK_LIMIT_EXCEEDED', capResp.body);

    // ── POST /bulk: partial success — one bad row must not block the good ones ──
    const mixed = await req('POST', API + '/bulk', admin, {
      items: [
        { menuId: ITEM_GOOD, imageData: PNG_DATA_URL },                    // valid
        { menuId: ITEM_BAD, imageData: 'data:image/gif;base64,' + PNG_B64 }, // bad MIME
        { menuId: SEED_ITEM, imageData: PNG_DATA_URL },                    // SEED-excluded
      ],
    });
    check('POST /bulk mixed batch → 200 (batch itself does not fail)', mixed.status === 200 && mixed.body?.success === true, mixed.body);
    check('…succeeded=1, failed=2', mixed.body?.succeeded === 1 && mixed.body?.failed === 2, mixed.body);
    const rGood = (mixed.body.results || []).find((r) => r.menuId === ITEM_GOOD);
    const rBad = (mixed.body.results || []).find((r) => r.menuId === ITEM_BAD);
    const rSeed = (mixed.body.results || []).find((r) => r.menuId === SEED_ITEM);
    check('…good row: ok=true', rGood && rGood.ok === true, rGood);
    check('…bad row: ok=false, code=INVALID_IMAGE', rBad && rBad.ok === false && rBad.code === 'INVALID_IMAGE', rBad);
    check('…SEED row: ok=false, code=SEED_ROW_EXCLUDED', rSeed && rSeed.ok === false && rSeed.code === 'SEED_ROW_EXCLUDED', rSeed);
    check('…the good row WAS actually written to the DB', (await storedImage(ITEM_GOOD)) === PNG_DATA_URL);
    check('…the bad row was NOT written (still NULL)', (await storedImage(ITEM_BAD)) === null);

    // ── audit rows land in audit_logs with entity_type='menu_image' ──
    const auditGood = await auditRowsFor(ITEM_GOOD);
    check("real bulk write → audit_logs row with entity_type='menu_image'", auditGood.length >= 1 && auditGood[auditGood.length - 1].action === 'bulk_image_upload', auditGood);
    const auditBad = await auditRowsFor(ITEM_BAD);
    check('the failed/invalid bulk item did NOT write an audit row', auditBad.length === 0, auditBad);

    // ── dryRun: validates, writes nothing, same result shape as a real run ──
    const beforeDry = await storedImage(ITEM_PLAIN);
    const dry = await req('POST', API + '/bulk', admin, {
      dryRun: true,
      items: [{ menuId: ITEM_PLAIN, imageData: 'data:image/webp;base64,' + PNG_B64 }],
    });
    check('dryRun batch → 200, dryRun echoed true', dry.status === 200 && dry.body?.dryRun === true, dry.body);
    const rDry = (dry.body.results || [])[0];
    check('…per-item result has the SAME shape as a real write (menuId/ok/before/after)', rDry && rDry.menuId === ITEM_PLAIN && rDry.ok === true && 'before' in rDry && 'after' in rDry, rDry);
    check('…dryRun computed the correct prospective after-hash', rDry.after === sha1('data:image/webp;base64,' + PNG_B64));
    check('…DB image_data is UNCHANGED after a dry run', (await storedImage(ITEM_PLAIN)) === beforeDry);
    const auditPlain = await auditRowsFor(ITEM_PLAIN);
    check('…dryRun wrote NO audit_logs row', auditPlain.length === 0, auditPlain);

    // ── real single PUT + audit, then DELETE clears it ──
    const putGood = await req('PUT', API + '/' + ITEM_PLAIN, manager, { imageData: 'data:image/webp;base64,' + PNG_B64 });
    check('PUT single valid image (as capable manager) → 200', putGood.status === 200 && putGood.body?.success === true, putGood.body);
    check('…stored correctly', (await storedImage(ITEM_PLAIN)) === 'data:image/webp;base64,' + PNG_B64);
    const auditPut = await auditRowsFor(ITEM_PLAIN);
    check("PUT write → audit_logs row with entity_type='menu_image' (product_image_replace)", auditPut.some((r) => r.action === 'product_image_replace'), auditPut);

    const del = await req('DELETE', API + '/' + ITEM_PLAIN, manager);
    check('DELETE clears the image → 200', del.status === 200 && del.body?.success === true, del.body);
    check('…DB column is NULL after delete', (await storedImage(ITEM_PLAIN)) === null);
    const auditDel = await auditRowsFor(ITEM_PLAIN);
    check("DELETE write → audit_logs row (product_image_delete)", auditDel.some((r) => r.action === 'product_image_delete'), auditDel);

    console.log(`\n${fail === 0 ? '✅' : '❌'} productImagesUpload: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.close();
    await removeSeeds();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
