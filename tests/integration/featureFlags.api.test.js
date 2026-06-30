/**
 * Phase 5A (RC) — feature-flag / cutover integration test.
 *
 * Boots server.js with WAREHOUSE_V2_ENABLED=0 and asserts the safe-disable
 * contract:
 *   1. v2 WRITE endpoints → 503 V2_DISABLED (legacy becomes the sole writer → no
 *      dual-write, no data loss).
 *   2. v2 READ endpoints stay available (dashboards keep working read-only).
 *   3. The /warehouse-v2 SPA serves a maintenance notice (503), legacy UI/API
 *      unaffected (/api/version still 200).
 *
 * Run: node tests/integration/featureFlags.api.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.FLAGS_TEST_PORT || 3196);
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
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b, headers: resp.headers }); });
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

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing (.env) — cannot run'); process.exit(2); }
  console.log('\n═══ RC feature flag (WAREHOUSE_V2_ENABLED=0) — integration ═══\n');
  const token = jwt.sign({ id: 0, username: 'rcflag_admin', role: 'admin', isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), WAREHOUSE_V2_ENABLED: '0', WAREHOUSE_SCOPE_ENFORCE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // 1) v2 WRITE → 503 V2_DISABLED
    const write = await req('POST', '/api/inventory/v2/lots', token, { itemId: 'X', lotNumber: 'L1', qty: 1 });
    check('v2 mutation → 503 V2_DISABLED', write.status === 503 && write.body && write.body.code === 'V2_DISABLED', { status: write.status, body: write.body });

    // 2) v2 READ stays available (NOT disabled)
    const read = await req('GET', '/api/inventory/v2/lots?pageSize=1', token);
    check('v2 read stays available (not V2_DISABLED)', read.status !== 503 && !(read.body && read.body.code === 'V2_DISABLED'), { status: read.status, code: read.body && read.body.code });

    // 3) SPA → maintenance notice (503), legacy core unaffected
    const spa = await req('GET', '/warehouse-v2/inventory', null);
    check('SPA → 503 maintenance notice', spa.status === 503 && /صيانة|متوقف/.test(spa.raw || ''), { status: spa.status });
    const ver = await req('GET', '/api/version', null);
    check('legacy core unaffected (/api/version → 200)', ver.status === 200, ver.status);
  } finally {
    try { server.kill(); } catch (_) {}
  }

  console.log('\n═══ ' + _pass + ' passed, ' + _fail + ' failed ═══\n');
  setTimeout(() => process.exit(_fail ? 1 : 0), 200);
})();
