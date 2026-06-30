/**
 * Phase 5A (RC) — monitoring / ops integration test (real server).
 *
 * Asserts:
 *   1. GET /api/inventory/v2/ready → 200 with db + schema + timezone checks (public).
 *   2. Correlation ID: an inbound X-Request-Id is echoed; absent → one is generated.
 *   3. /api/metrics/json exposes a warehouse_v2 counter block; a v2 4xx increments it.
 *   4. /api/metrics (Prometheus) emits warehouse_v2_* lines.
 *
 * Run: node tests/integration/ops.api.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.OPS_TEST_PORT || 3197);
const BASE = { host: '127.0.0.1', port: PORT };

let _pass = 0, _fail = 0;
function check(name, cond, extra) {
  if (cond) { _pass++; console.log('  ✅', name); }
  else { _fail++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

function req(method, path, token, body, extraHeaders) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({ Accept: 'application/json' }, extraHeaders || {});
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
  console.log('\n═══ RC monitoring / ops — integration ═══\n');
  const token = jwt.sign({ id: 0, username: 'rcops_admin', role: 'admin', isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // 1) Readiness (public, schema-aware)
    const ready = await req('GET', '/api/inventory/v2/ready');
    check('readiness → 200 (DB + schema migrated)', ready.status === 200 && ready.body && ready.body.ready === true, { status: ready.status, missing: ready.body && ready.body.missing });
    check('readiness reports db + schema checks true', ready.body && ready.body.checks && ready.body.checks.db === true && ready.body.checks.schema === true, ready.body && ready.body.checks);
    check('readiness reports DB session timezone', ready.body && ready.body.checks && ready.body.checks.timezone != null, ready.body && ready.body.checks);

    // 2) Correlation ID
    const withId = await req('GET', '/api/version', null, null, { 'X-Request-Id': 'rc-trace-123' });
    check('inbound X-Request-Id is echoed', withId.headers && withId.headers['x-request-id'] === 'rc-trace-123', withId.headers && withId.headers['x-request-id']);
    const noId = await req('GET', '/api/version');
    check('absent X-Request-Id → server generates one', noId.headers && typeof noId.headers['x-request-id'] === 'string' && noId.headers['x-request-id'].length >= 8, noId.headers && noId.headers['x-request-id']);

    // 3) Metrics JSON exposes v2 counters + increments on a v2 4xx
    const m0 = await req('GET', '/api/metrics/json', token);
    check('/api/metrics/json exposes warehouse_v2 counters', m0.body && m0.body.warehouse_v2 && typeof m0.body.warehouse_v2.v2_requests_total === 'number', m0.body && m0.body.warehouse_v2);
    const before = (m0.body && m0.body.warehouse_v2 && m0.body.warehouse_v2.v2_responses_4xx) || 0;
    await req('POST', '/api/inventory/v2/lots', token, {}); // invalid body → 4xx, counted by v2Metrics.track
    const m1 = await req('GET', '/api/metrics/json', token);
    const after = (m1.body && m1.body.warehouse_v2 && m1.body.warehouse_v2.v2_responses_4xx) || 0;
    check('v2 4xx response increments warehouse_v2.v2_responses_4xx', after > before, { before, after });
    check('warehouse_v2 exposes integrity-alert counters', m1.body && m1.body.warehouse_v2 && 'lot_invariant_violation_total' in m1.body.warehouse_v2 && 'gl_imbalance_total' in m1.body.warehouse_v2, m1.body && m1.body.warehouse_v2);

    // 4) Prometheus text
    const prom = await req('GET', '/api/metrics', token);
    check('/api/metrics (Prometheus) emits warehouse_v2_* lines', typeof prom.raw === 'string' && prom.raw.indexOf('warehouse_v2_requests_total') !== -1, prom.raw && prom.raw.slice(0, 80));
  } finally {
    try { server.kill(); } catch (_) {}
  }

  console.log('\n═══ ' + _pass + ' passed, ' + _fail + ' failed ═══\n');
  setTimeout(() => process.exit(_fail ? 1 : 0), 200);
})();
