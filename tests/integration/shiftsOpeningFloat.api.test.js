/**
 * Opening-float — integration test (REAL server on port 3995).
 *
 * Proves the opening-float financial fix in routes/shifts.js:
 *
 *   (1) POST /api/shifts/open with a float persists it (response + stored row).
 *   (2) A SECOND /open for the same cashier returns the ALREADY-STORED value,
 *       unchanged — an idempotent open never overwrites an open shift's float.
 *   (3) SECURITY PROOF: close-v3 sent a DIFFERENT client `openingFloat` than the
 *       stored one STILL uses/persists the DB value. Asserted on the stored row
 *       and the computed variance, not just a 200 — the whole point of the fix
 *       is that the server never trusts the client's float over its own state.
 *   (4) GET /:id/full-report reflects the float: financials.openingFloat AND the
 *       cash method's `expected` (float folded into cash expected).
 *   (5) Invalid floats on open (negative / non-numeric / over-cap) → 400 and NO
 *       shift is created.
 *
 * The shift carries ZERO sales, so the whole expected side is the float itself —
 * which makes the double-count bug (if it regressed) impossible to miss: the old
 * code would have produced a +5000 variance from the spoofed client float.
 *
 * Fixtures are ITEST- prefixed; cleanup runs before AND in finally.
 * Run: node tests/integration/shiftsOpeningFloat.api.test.js  (shared MySQL)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.OPENFLOAT_TEST_PORT || 3995);
const BASE = { host: '127.0.0.1', port: PORT };

const U_CASH = 'ITEST-openfloat-cash';

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, text: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    const r = await req('GET', '/api/version');
    if (r.status) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}
function tok(id, username, role) {
  return jwt.sign({ id, username, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function cleanup() {
  try {
    const [rows] = await db.query('SELECT id FROM shifts WHERE username = ?', [U_CASH]);
    for (const s of rows) {
      try { await db.query('DELETE FROM shift_close_denominations WHERE shift_id = ?', [s.id]); } catch (_) {}
    }
  } catch (_) {}
  const sqls = [
    ['DELETE FROM shifts WHERE username = ?', [U_CASH]],
    ['DELETE FROM users WHERE username = ?', [U_CASH]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [U_CASH, 'disabled', 'cashier']);
  const [r] = await db.query('SELECT id FROM users WHERE username=?', [U_CASH]);
  return r[0].id;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Opening-float — persistence, idempotency, DB-authoritative close ═══\n');
  const cashId = await seed();
  const cash = tok(cashId, U_CASH, 'cashier');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── (5) invalid floats → 400, NO shift created ──
    console.log('▸ open validation — invalid floats rejected');
    let r = await req('POST', '/api/shifts/open', cash, { openingFloat: -5, device: { ua: 'openfloat-itest' } });
    check('negative openingFloat → 400', r.status === 400, { status: r.status, body: r.body });
    r = await req('POST', '/api/shifts/open', cash, { openingFloat: 'abc', device: { ua: 'openfloat-itest' } });
    check('non-numeric openingFloat → 400', r.status === 400, { status: r.status, body: r.body });
    r = await req('POST', '/api/shifts/open', cash, { openingFloat: 999999, device: { ua: 'openfloat-itest' } });
    check('over-cap openingFloat → 400', r.status === 400, { status: r.status, body: r.body });
    let [none] = await db.query('SELECT id FROM shifts WHERE username = ?', [U_CASH]);
    check('no shift was created by the rejected opens', none.length === 0, none);

    // ── (1) open with a real float persists it ──
    console.log('▸ open persists the float');
    r = await req('POST', '/api/shifts/open', cash, { openingFloat: 100, device: { ua: 'openfloat-itest' } });
    const shiftId = r.body && r.body.shiftId;
    check('open → success + shiftId + openingFloat echoed = 100',
      r.status === 200 && r.body && r.body.success === true && !!shiftId && near(r.body.openingFloat, 100),
      { status: r.status, body: r.body });
    let [srow] = await db.query('SELECT opening_float FROM shifts WHERE id = ?', [shiftId || '']);
    check('stored shifts.opening_float = 100', srow.length === 1 && near(srow[0].opening_float, 100), srow[0]);

    // ── (2) idempotent second open returns the UNCHANGED stored float ──
    console.log('▸ idempotent second open does NOT overwrite the float');
    r = await req('POST', '/api/shifts/open', cash, { openingFloat: 999, device: { ua: 'openfloat-itest' } });
    check('second open → same shiftId, openingFloat still 100 (not 999)',
      r.status === 200 && r.body && r.body.shiftId === shiftId && near(r.body.openingFloat, 100),
      { status: r.status, body: r.body });
    [srow] = await db.query('SELECT opening_float FROM shifts WHERE id = ?', [shiftId]);
    check('stored float unchanged after second open (still 100)', near(srow[0].opening_float, 100), srow[0]);

    // ── closing-data-v3 surfaces the stored float ──
    console.log('▸ closing-data-v3 surfaces the stored float');
    r = await req('GET', `/api/shifts/closing-data-v3/${shiftId}`, cash);
    check('closing-data-v3 → 200 with openingFloat = 100',
      r.status === 200 && r.body && near(r.body.openingFloat, 100), { status: r.status, openingFloat: r.body && r.body.openingFloat });

    // ── (3) SECURITY PROOF — close-v3 ignores a spoofed client float ──
    // The drawer has 100 counted (one 100 note). The client LIES that the float
    // was 5000. The server must fold the STORED 100 into cash expected and count
    // the physical 100 → variance 0. The old bug would have added the client
    // 5000 to the counted side and folded NOTHING into expected → +5000 variance.
    console.log('▸ close-v3 uses the DB float, not the spoofed client float');
    r = await req('POST', '/api/shifts/close-v3', cash, {
      shiftId,
      openingFloat: 5000,                                   // spoofed — must be ignored
      denominations: [{ value: 100, count: 1, kind: 'note' }],
      paymentTotals: {},
      notes: 'itest opening float',
    });
    check('close-v3 → 200 success', r.status === 200 && r.body && r.body.success === true, { status: r.status, body: r.body });
    check('expectedTotal = 100 (float folded into cash expected)', r.body && near(r.body.expectedTotal, 100), r.body && r.body.expectedTotal);
    check('actualTotal = 100 (physical count only — client 5000 NOT added)', r.body && near(r.body.actualTotal, 100), r.body && r.body.actualTotal);
    check('variance = 0 (balanced despite the spoofed 5000)', r.body && near(r.body.variance, 0), r.body && r.body.variance);

    const [closed] = await db.query(
      'SELECT status, opening_float, expected_total, actual_total, variance_total FROM shifts WHERE id = ?', [shiftId]);
    check('shift row is closed', closed.length === 1 && String(closed[0].status).toLowerCase() === 'closed', closed[0]);
    check('stored opening_float = 100 (DB value persisted, NOT the client 5000)', near(closed[0].opening_float, 100), closed[0]);
    check('stored expected_total = 100', near(closed[0].expected_total, 100), closed[0]);
    check('stored actual_total = 100', near(closed[0].actual_total, 100), closed[0]);
    check('stored variance_total = 0', near(closed[0].variance_total, 0), closed[0]);

    // ── (4) full-report reflects the float ──
    console.log('▸ full-report reflects the float (owner read)');
    r = await req('GET', `/api/shifts/${shiftId}/full-report`, cash);
    const fin = r.body && r.body.financials;
    check('full-report → 200 with financials.openingFloat = 100',
      r.status === 200 && fin && near(fin.openingFloat, 100), { status: r.status, financials: fin });
    check('financials.expectedTotal = 100', fin && near(fin.expectedTotal, 100), fin);
    const cashMethod = (r.body && Array.isArray(r.body.methods) ? r.body.methods : [])
      .find((m) => String(m.groupType || '').toLowerCase() === 'cash');
    check('cash method expected = 100 (float folded)', cashMethod && near(cashMethod.expected, 100), cashMethod);
    check('cash method variance = 0 (100 counted vs 100 expected)', cashMethod && near(cashMethod.variance, 0), cashMethod);
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${_f === 0 ? '✅' : '❌'} shiftsOpeningFloat.api: ${_p} passed, ${_f} failed\n`);
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
