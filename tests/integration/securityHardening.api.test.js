/**
 * Phase 5A (RC) — security hardening integration test (real server).
 *
 * Boots server.js with a TINY v2 mutation rate limit (max=2/window) and asserts:
 *   1. /warehouse-v2 responses carry a strict Content-Security-Policy (SPA scope).
 *   2. A 3rd v2 mutation by the same user is throttled → 429 RATE_LIMITED.
 *   3. Reads (GET) on /v2 are NEVER throttled.
 *   4. Unauthenticated /v2 mutation is blocked by the global auth gate (401).
 *
 * No DB seeding: the mutations intentionally fail validation (empty body) — the
 * rate limiter runs at the /v2 mount BEFORE the router, so it still counts them.
 *
 * Run: node tests/integration/securityHardening.api.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.SEC_TEST_PORT || 3198);
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
  for (let i = 0; i < 80; i++) {
    const r = await req('GET', '/api/version');
    if (r.status) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing (.env) — cannot run'); process.exit(2); }
  console.log('\n═══ RC security hardening — integration ═══\n');

  const token = jwt.sign({ id: 0, username: 'rcsec_admin', role: 'admin', isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), WAREHOUSE_V2_MUTATION_RATE_MAX: '2', WAREHOUSE_V2_MUTATION_RATE_WINDOW_MS: '60000', WAREHOUSE_SCOPE_ENFORCE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // 1) Scoped CSP on /warehouse-v2 (present regardless of whether the bundle is built)
    const csp = await req('GET', '/warehouse-v2/inventory');
    const cspHeader = csp.headers && csp.headers['content-security-policy'];
    check('/warehouse-v2 carries a Content-Security-Policy header', !!cspHeader, cspHeader);
    check('CSP restricts default-src + script-src to self', !!cspHeader && cspHeader.indexOf("default-src 'self'") !== -1 && cspHeader.indexOf("script-src 'self'") !== -1, cspHeader);
    check('CSP sets object-src none + frame-ancestors none', !!cspHeader && cspHeader.indexOf("object-src 'none'") !== -1 && cspHeader.indexOf("frame-ancestors 'none'") !== -1, cspHeader);
    // The legacy API surface must NOT inherit the SPA CSP.
    const apiCsp = await req('GET', '/api/version');
    check('/api responses do NOT carry the SPA CSP (legacy unaffected)', !(apiCsp.headers && apiCsp.headers['content-security-policy']), apiCsp.headers && apiCsp.headers['content-security-policy']);

    // 2) Unauthenticated v2 mutation → blocked by the global auth gate (before the limiter)
    const noAuth = await req('POST', '/api/inventory/v2/lots', null, {});
    check('unauthenticated v2 mutation → 401', noAuth.status === 401, noAuth.status);

    // 3) v2 mutation rate limit: max=2 → 3rd POST is 429 RATE_LIMITED
    const m1 = await req('POST', '/api/inventory/v2/lots', token, {});
    const m2 = await req('POST', '/api/inventory/v2/lots', token, {});
    const m3 = await req('POST', '/api/inventory/v2/lots', token, {});
    check('first two v2 mutations are NOT rate-limited', m1.status !== 429 && m2.status !== 429, { m1: m1.status, m2: m2.status });
    check('3rd v2 mutation → 429 RATE_LIMITED', m3.status === 429 && m3.body && m3.body.code === 'RATE_LIMITED', { status: m3.status, body: m3.body });
    check('429 carries Retry-After header', m3.headers && m3.headers['retry-after'] != null, m3.headers && m3.headers['retry-after']);

    // 4) Reads are never throttled (even after the mutation budget is spent)
    const readAfter = await req('GET', '/api/inventory/v2/lots?pageSize=1', token);
    check('GET /v2/lots after limit is NOT 429 (reads pass through)', readAfter.status !== 429, readAfter.status);
  } finally {
    try { server.kill(); } catch (_) {}
  }

  console.log('\n═══ ' + _pass + ' passed, ' + _fail + ' failed ═══\n');
  setTimeout(() => process.exit(_fail ? 1 : 0), 200);
})();
