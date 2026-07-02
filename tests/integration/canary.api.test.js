/**
 * Phase 5C — canary allow-list integration test.
 *
 * Boot 1: server.js with WAREHOUSE_V2_CANARY_USERS=canary_ok and
 * WAREHOUSE_V2_CANARY_ROLES=supervisor, asserting the pilot contract:
 *   1. Unlisted user → 403 V2_CANARY_DENIED on v2 reads AND writes, and on
 *      the v2-only namespaces /analytics, /reports, /transfers.
 *   2. NO implicit bypass: an admin-role user NOT on the list is denied too.
 *   3. Listed username OR listed role → passes the gate (never 403 canary).
 *   4. Public /ready probe + legacy endpoints unaffected.
 * Boot 2: canary unset → gate is pass-through (no 403 canary anywhere).
 *
 * Run: node tests/integration/canary.api.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.CANARY_TEST_PORT || 3197);
const BASE = { host: '127.0.0.1', port: PORT };

let _pass = 0, _fail = 0;
function check(name, cond, extra) {
  if (cond) { _pass++; console.log('  ✅', name); }
  else { _fail++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); }
  return false;
}

function boot(extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), WAREHOUSE_V2_ENABLED: '1', WAREHOUSE_SCOPE_ENFORCE: '0', WAREHOUSE_V2_CANARY_USERS: '', WAREHOUSE_V2_CANARY_ROLES: '', ...extraEnv },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const isCanary403 = (r) => r.status === 403 && r.body && r.body.code === 'V2_CANARY_DENIED';
const notCanary = (r) => !(r.body && r.body.code === 'V2_CANARY_DENIED');

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing (.env) — cannot run'); process.exit(2); }
  console.log('\n═══ 5C canary allow-list — integration ═══\n');
  const t = (username, role) => jwt.sign({ id: 0, username, role, isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const tokListedUser = t('canary_ok', 'cashier');   // allowed by USERNAME
  const tokListedRole = t('someone', 'supervisor');  // allowed by ROLE
  const tokDenied = t('outsider', 'cashier');        // not listed
  const tokAdminUnlisted = t('bigboss', 'admin');    // admin role, NOT listed

  // ── Boot 1: canary ACTIVE ────────────────────────────────────────────────
  let server = boot({ WAREHOUSE_V2_CANARY_USERS: ' Canary_OK , ', WAREHOUSE_V2_CANARY_ROLES: 'supervisor' });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    console.log('─── canary ACTIVE (users=canary_ok, roles=supervisor) ───');

    const dRead = await req('GET', '/api/inventory/v2/lots?pageSize=1', tokDenied);
    check('unlisted user: v2 read → 403 V2_CANARY_DENIED', isCanary403(dRead), { status: dRead.status, code: dRead.body && dRead.body.code });
    const dWrite = await req('POST', '/api/inventory/v2/receipts', tokDenied, { warehouseId: 'X', items: [] });
    check('unlisted user: v2 write → 403 V2_CANARY_DENIED', isCanary403(dWrite), { status: dWrite.status, code: dWrite.body && dWrite.body.code });
    const dAna = await req('GET', '/api/inventory/analytics/summary', tokDenied);
    check('unlisted user: /analytics → 403 V2_CANARY_DENIED', isCanary403(dAna), { status: dAna.status, code: dAna.body && dAna.body.code });
    const dRep = await req('GET', '/api/inventory/reports/catalog', tokDenied);
    check('unlisted user: /reports → 403 V2_CANARY_DENIED', isCanary403(dRep), { status: dRep.status, code: dRep.body && dRep.body.code });
    const dTr = await req('GET', '/api/inventory/transfers?pageSize=1', tokDenied);
    check('unlisted user: /transfers → 403 V2_CANARY_DENIED', isCanary403(dTr), { status: dTr.status, code: dTr.body && dTr.body.code });

    const dAdmin = await req('GET', '/api/inventory/v2/lots?pageSize=1', tokAdminUnlisted);
    check('NO implicit bypass: unlisted admin → 403 V2_CANARY_DENIED', isCanary403(dAdmin), { status: dAdmin.status, code: dAdmin.body && dAdmin.body.code });

    const aUser = await req('GET', '/api/inventory/v2/lots?pageSize=1', tokListedUser);
    check('listed USERNAME passes the gate (200)', aUser.status === 200, { status: aUser.status, code: aUser.body && aUser.body.code });
    const aRole = await req('GET', '/api/inventory/v2/lots?pageSize=1', tokListedRole);
    check('listed ROLE passes the gate (200)', aRole.status === 200, { status: aRole.status, code: aRole.body && aRole.body.code });
    // Layering proof: a listed-but-weak-role user passes CANARY and is then
    // stopped by the route's own role check (forbidden_role ≠ V2_CANARY_DENIED).
    const aWrite = await req('POST', '/api/inventory/v2/receipts', tokListedUser, { warehouseId: 'X', items: [] });
    check('listed weak-role write passes canary into role check', notCanary(aWrite) && aWrite.body && aWrite.body.code === 'forbidden_role', { status: aWrite.status, code: aWrite.body && aWrite.body.code });
    const aWrite2 = await req('POST', '/api/inventory/v2/receipts', t('canary_ok', 'admin'), { warehouseId: 'X', items: [] });
    check('listed admin write reaches validation (no 403 at all)', aWrite2.status !== 403 && notCanary(aWrite2), { status: aWrite2.status, code: aWrite2.body && aWrite2.body.code });

    const ready = await req('GET', '/api/inventory/v2/ready');
    check('/ready stays public (not 403)', ready.status !== 403 && ready.body && typeof ready.body.ready === 'boolean', { status: ready.status });
    const legacy = await req('GET', '/api/inventory/warehouses-summary', tokDenied);
    check('legacy endpoint unaffected for unlisted user (not canary 403)', notCanary(legacy) && legacy.status !== 403, { status: legacy.status, code: legacy.body && legacy.body.code });
    const ver = await req('GET', '/api/version');
    check('legacy core unaffected (/api/version → 200)', ver.status === 200, ver.status);
  } finally {
    try { server.kill(); } catch (_) {}
  }
  await new Promise((z) => setTimeout(z, 800));

  // ── Boot 2: canary UNSET → open to all ───────────────────────────────────
  server = boot({});
  try {
    if (!(await waitForServer())) { console.error('server (boot 2) did not start'); process.exit(2); }
    console.log('\n─── canary UNSET (default open) ───');
    const oRead = await req('GET', '/api/inventory/v2/lots?pageSize=1', tokDenied);
    check('v2 read open (200, no canary 403)', oRead.status === 200 && notCanary(oRead), { status: oRead.status, code: oRead.body && oRead.body.code });
    const oAna = await req('GET', '/api/inventory/analytics/summary', tokDenied);
    check('/analytics open (200, no canary 403)', oAna.status === 200 && notCanary(oAna), { status: oAna.status, code: oAna.body && oAna.body.code });
    const oRep = await req('GET', '/api/inventory/reports/catalog', tokDenied);
    check('/reports open (200, no canary 403)', oRep.status === 200 && notCanary(oRep), { status: oRep.status, code: oRep.body && oRep.body.code });
  } finally {
    try { server.kill(); } catch (_) {}
  }

  console.log('\n═══ ' + _pass + ' passed, ' + _fail + ' failed ═══\n');
  setTimeout(() => process.exit(_fail ? 1 : 0), 200);
})();
