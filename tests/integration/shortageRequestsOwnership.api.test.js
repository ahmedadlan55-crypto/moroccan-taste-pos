'use strict';
/*
 * Integration — close2/requisitions-fix: shortage-request (طلب النواقص) hardening
 * on /api/inventory/shortage-requests. Boots server.js on a unique port against
 * the real DB with ITEST- fixtures and proves the five contracts:
 *
 *   Fix 1  warehouse auto-resolution — an empty client warehouseId is resolved
 *          from the requester's profile (users.default_warehouse_id), and an
 *          unresolvable warehouse is a 422 VALIDATION_ERROR, never a NULL row.
 *   Fix 2  ownership — a non-approver (plain cashier) may only GET/PUT/DELETE and
 *          LIST their OWN requests; a holder of purchasing.requisitions.approve
 *          (admin bypass) sees/acts on any request in scope.
 *   Fix 3  safe numbering — N parallel creates yield N distinct request_numbers
 *          (the atomic doc_counters replaces the old MAX+1 race).
 *   Fix 4  transactional create — a mid-creation failure leaves NO orphan header.
 *
 * Self-cleaning; only rows/permission grants THIS run created are removed (a
 * production-seeded DB keeps its grants).
 *
 * Run: node tests/integration/shortageRequestsOwnership.api.test.js
 * (NOT part of `npm test`.)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = Number(process.env.SHR_TEST_PORT || 3994);
const PW = 'ShrOwn#Test!2026';
const WH = 'ITEST-WH-SHR';
const ITEM = 'ITEST-SHR-ITEM';

// Real users.role ENUM members. cashier holds inventory.requisition.create via
// the g-inv seed (applied below) but NOT purchasing.requisitions.approve; admin
// bypasses every capability check → it is our "approver" (holds approve by bypass).
const A = 'itest_shr_cashier_a';       // creator; default warehouse = WH
const B = 'itest_shr_cashier_b';       // different cashier, same scope
const APPROVER = 'itest_shr_admin';    // role=admin → approver
const NOWH = 'itest_shr_cashier_nowh'; // cashier with NO resolvable warehouse
const USERS = [A, B, APPROVER, NOWH];

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 260) : ''); }
}

function call(method, p, token, body) {
  return new Promise((resolve) => {
    const d = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c));
      s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => resolve({ status: 0 }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)));
    if (ok) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}

const LINE = { invItemId: ITEM, invItemName: 'ITEST shr item', unit: 'PCS', currentQty: 1, minQty: 5, requestedQty: 10, unitPrice: 2 };
const whCount = async () => { const [r] = await db.query('SELECT COUNT(*) c FROM shortage_requests WHERE warehouse_id = ?', [WH]); return Number(r[0].c); };

// ── g-inv capability seed (grants cashier inventory.requisition.create), applied
//    exactly as a deploy would; only rows THIS run inserts are removed. ──
const SEED_FILE = path.join(__dirname, '..', '..', 'db', 'migrations', 'capability-seeds', 'g-inv.json');
const SEEDS = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const createdPerms = []; const createdGrants = [];
async function applySeeds() {
  for (const cap of SEEDS) {
    const [ex] = await db.query('SELECT id FROM permissions_v3 WHERE id = ?', [cap.id]);
    if (!ex.length) {
      await db.query('INSERT INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive) VALUES (?,?,?,?,?)',
        [cap.id, 'inventory', cap.label_ar, cap.label_en || '', cap.is_sensitive ? 1 : 0]);
      createdPerms.push(cap.id);
    }
    for (const role of cap.roles) {
      const [g] = await db.query('SELECT 1 FROM role_permissions WHERE role = ? AND permission_id = ?', [role, cap.id]);
      if (!g.length) { await db.query('INSERT INTO role_permissions (role, permission_id) VALUES (?,?)', [role, cap.id]); createdGrants.push([role, cap.id]); }
    }
  }
}
async function removeSeeds() {
  for (const [role, pid] of createdGrants) { try { await db.query('DELETE FROM role_permissions WHERE role = ? AND permission_id = ?', [role, pid]); } catch (_) {} }
  for (const pid of createdPerms) { try { await db.query('DELETE FROM permissions_v3 WHERE id = ?', [pid]); } catch (_) {} }
}

async function cleanup() {
  try {
    const [rows] = await db.query('SELECT id FROM shortage_requests WHERE warehouse_id = ? OR username IN (?)', [WH, USERS]);
    for (const r of rows) { try { await db.query('DELETE FROM shortage_items WHERE request_id = ?', [r.id]); } catch (_) {} }
    await db.query('DELETE FROM shortage_requests WHERE warehouse_id = ? OR username IN (?)', [WH, USERS]);
  } catch (_) {}
  for (const u of USERS) { try { await db.query('DELETE FROM users WHERE username = ?', [u]); } catch (_) {} }
  try { await db.query('DELETE FROM warehouses WHERE id = ?', [WH]); } catch (_) {}
}

async function setup() {
  const hash = await bcrypt.hash(PW, 12);
  // Users created AFTER the server booted so the startup migrations (which add
  // users.default_warehouse_id) have already run — the INSERT can rely on it.
  await db.query('INSERT INTO users (username,password,role,active,default_warehouse_id,branch_id) VALUES (?,?,?,1,?,NULL)', [A, hash, 'cashier', WH]);
  await db.query('INSERT INTO users (username,password,role,active,default_warehouse_id,branch_id) VALUES (?,?,?,1,?,NULL)', [B, hash, 'cashier', WH]);
  await db.query('INSERT INTO users (username,password,role,active,default_warehouse_id,branch_id) VALUES (?,?,?,1,NULL,NULL)', [APPROVER, hash, 'admin']);
  await db.query('INSERT INTO users (username,password,role,active,default_warehouse_id,branch_id) VALUES (?,?,?,1,NULL,NULL)', [NOWH, hash, 'cashier']);
  try { await db.query("INSERT INTO warehouses (id, name, code) VALUES (?, 'ITEST SHR WH', 'ITSHR')", [WH]); } catch (_) {}
  await applySeeds();
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  await cleanup();
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    await setup();
    console.log('\n═══ shortage-requests ownership + hardening ═══');

    const [sqlMode] = await db.query('SELECT @@SESSION.sql_mode AS m');
    console.log('  (info) session sql_mode =', (sqlMode[0] && sqlMode[0].m) || '?');

    const tokA = await login(A);
    const tokB = await login(B);
    const tokAppr = await login(APPROVER);
    const tokNoWh = await login(NOWH);
    check('all four users authenticate', !!tokA && !!tokB && !!tokAppr && !!tokNoWh, { A: !!tokA, B: !!tokB, appr: !!tokAppr, noWh: !!tokNoWh });

    // ── Fix 1(a): empty warehouseId resolves from profile default_warehouse_id ──
    const c1 = await call('POST', '/api/inventory/shortage-requests', tokA, { warehouseId: '', notes: 'ITEST resolve', items: [LINE] });
    check('create with empty warehouseId succeeds (resolved from profile)', c1.status === 200 && c1.body && c1.body.success === true && !!c1.body.id, { s: c1.status, b: c1.body });
    if (c1.body && c1.body.id) {
      const [row] = await db.query('SELECT warehouse_id FROM shortage_requests WHERE id = ?', [c1.body.id]);
      check('…resolved row.warehouse_id === WH (never NULL)', row.length === 1 && row[0].warehouse_id === WH, row[0]);
    }

    // ── Fix 1(b): unresolvable warehouse → 422, no row inserted ──
    const before2 = await whCount();
    const c2 = await call('POST', '/api/inventory/shortage-requests', tokNoWh, { warehouseId: '', notes: 'ITEST no-wh', items: [LINE] });
    check('create with no resolvable warehouse → 422 VALIDATION_ERROR', c2.status === 422 && c2.body && c2.body.code === 'VALIDATION_ERROR', { s: c2.status, b: c2.body });
    check('…and NO shortage_requests row was inserted', (await whCount()) === before2, { before: before2, after: await whCount() });

    // ── Fix 2: ownership on GET/PUT/DELETE/:id ──
    const cA = await call('POST', '/api/inventory/shortage-requests', tokA, { warehouseId: WH, notes: 'ITEST own', items: [LINE] });
    const reqA = cA.body && cA.body.id;
    check('cashier A creates a request (setup for ownership)', cA.status === 200 && !!reqA, cA.body);

    const bGet = await call('GET', '/api/inventory/shortage-requests/' + reqA, tokB);
    check('cashier B GET A’s request → 403 PERMISSION_DENIED', bGet.status === 403 && bGet.body && bGet.body.code === 'PERMISSION_DENIED', { s: bGet.status, b: bGet.body });
    const bPut = await call('PUT', '/api/inventory/shortage-requests/' + reqA, tokB, { notes: 'hijack', items: [LINE] });
    check('cashier B PUT A’s request → 403 PERMISSION_DENIED', bPut.status === 403 && bPut.body && bPut.body.code === 'PERMISSION_DENIED', { s: bPut.status, b: bPut.body });
    const bDel = await call('DELETE', '/api/inventory/shortage-requests/' + reqA, tokB);
    check('cashier B DELETE A’s request → 403 PERMISSION_DENIED', bDel.status === 403 && bDel.body && bDel.body.code === 'PERMISSION_DENIED', { s: bDel.status, b: bDel.body });
    const [stillThere] = await db.query('SELECT id FROM shortage_requests WHERE id = ?', [reqA]);
    check('…A’s request still exists after B’s denied delete', stillThere.length === 1);

    const aGet = await call('GET', '/api/inventory/shortage-requests/' + reqA, tokA);
    check('cashier A GET their OWN request → 200', aGet.status === 200 && aGet.body && aGet.body.id === reqA, { s: aGet.status });
    const aPut = await call('PUT', '/api/inventory/shortage-requests/' + reqA, tokA, { notes: 'ITEST edited', items: [LINE] });
    check('cashier A PUT their OWN pending request → 200', aPut.status === 200 && aPut.body && aPut.body.success === true, { s: aPut.status, b: aPut.body });
    const aDel = await call('DELETE', '/api/inventory/shortage-requests/' + reqA, tokA);
    check('cashier A DELETE their OWN request → 200', aDel.status === 200 && aDel.body && aDel.body.success === true, { s: aDel.status, b: aDel.body });

    // ── Fix 2: approver may GET any request in scope regardless of creator ──
    const cA2 = await call('POST', '/api/inventory/shortage-requests', tokA, { warehouseId: WH, notes: 'ITEST for approver', items: [LINE] });
    const reqA2 = cA2.body && cA2.body.id;
    const apprGet = await call('GET', '/api/inventory/shortage-requests/' + reqA2, tokAppr);
    check('approver GET another user’s request → 200 (no ownership restriction)', apprGet.status === 200 && apprGet.body && apprGet.body.id === reqA2, { s: apprGet.status });

    // ── Fix 2: LIST scoping — cashier sees only own; approver sees full list ──
    const cA3 = await call('POST', '/api/inventory/shortage-requests', tokA, { warehouseId: WH, notes: 'ITEST list a3', items: [LINE] });
    const cA4 = await call('POST', '/api/inventory/shortage-requests', tokA, { warehouseId: WH, notes: 'ITEST list a4', items: [LINE] });
    const cB1 = await call('POST', '/api/inventory/shortage-requests', tokB, { warehouseId: WH, notes: 'ITEST list b1', items: [LINE] });
    const reqA3 = cA3.body && cA3.body.id, reqA4 = cA4.body && cA4.body.id, reqB1 = cB1.body && cB1.body.id;

    const listA = await call('GET', '/api/inventory/shortage-requests', tokA);
    const arrA = Array.isArray(listA.body) ? listA.body : [];
    check('cashier LIST returns ONLY own rows (every username === A)', arrA.length > 0 && arrA.every((x) => x.username === A), { n: arrA.length, sample: arrA.slice(0, 3).map((x) => x.username) });
    check('…cashier LIST includes A’s own requests', arrA.some((x) => x.id === reqA3) && arrA.some((x) => x.id === reqA4), { hasA3: arrA.some((x) => x.id === reqA3), hasA4: arrA.some((x) => x.id === reqA4) });
    check('…cashier LIST does NOT include B’s request', !arrA.some((x) => x.id === reqB1));

    const listAppr = await call('GET', '/api/inventory/shortage-requests', tokAppr);
    const arrAppr = Array.isArray(listAppr.body) ? listAppr.body : [];
    check('approver LIST includes BOTH A’s and B’s requests (full scoped list)',
      arrAppr.some((x) => x.id === reqA3) && arrAppr.some((x) => x.id === reqB1), { hasA3: arrAppr.some((x) => x.id === reqA3), hasB1: arrAppr.some((x) => x.id === reqB1) });

    // ── Fix 3: N parallel creates → N distinct request_numbers ──
    const N = 10;
    const parallel = await Promise.all(Array.from({ length: N }, () =>
      call('POST', '/api/inventory/shortage-requests', tokA, { warehouseId: WH, notes: 'ITEST race', items: [LINE] })));
    const okCreates = parallel.filter((r) => r.status === 200 && r.body && r.body.success === true);
    const nums = okCreates.map((r) => r.body.requestNumber);
    const ids = okCreates.map((r) => r.body.id);
    check('all ' + N + ' parallel creates succeeded', okCreates.length === N, { ok: okCreates.length });
    check('all ' + N + ' request_numbers are distinct (MAX+1 race closed)', new Set(nums).size === N, { distinct: new Set(nums).size, nums });
    if (ids.length) {
      const [dc] = await db.query('SELECT COUNT(DISTINCT request_number) c, COUNT(*) t FROM shortage_requests WHERE id IN (?)', [ids]);
      check('…DB confirms COUNT(DISTINCT request_number) === row count', Number(dc[0].c) === Number(dc[0].t) && Number(dc[0].t) === ids.length, dc[0]);
    }

    // ── Fix 4: forced mid-creation failure leaves NO orphan header ──
    // A null line item throws while inserting the SECOND line (after the header +
    // first line are already written in the txn); the transaction must roll the
    // header back. sql_mode-independent, so the test is deterministic anywhere.
    const beforeFail = await whCount();
    const bad = await call('POST', '/api/inventory/shortage-requests', tokA, { warehouseId: WH, notes: 'ITEST forced-fail', items: [LINE, null] });
    check('create with a broken line → failure (success:false)', bad.body && bad.body.success === false, { s: bad.status, b: bad.body });
    check('…no orphan header row was left behind (count unchanged)', (await whCount()) === beforeFail, { before: beforeFail, after: await whCount() });

    console.log('\n' + (fail === 0 ? '✅' : '❌') + ' shortageRequestsOwnership: ' + pass + ' passed, ' + fail + ' failed');
    if (fail) console.log('   failed:', fails.join(' | '));
  } catch (e) { console.error('ERROR', e); exitCode = 1; }
  finally {
    try { server.kill(); } catch (_) {}
    await cleanup().catch(() => {});
    await removeSeeds().catch(() => {});
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail || exitCode ? 1 : 0);
})();
