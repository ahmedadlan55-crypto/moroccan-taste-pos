/**
 * G-SALES authz — integration test (REAL server on port 3994).
 *
 * Verifies the close/g-sales hardening of routes/sales.js, routes/shifts.js,
 * routes/sales-channels.js, routes/channel-menu.js, routes/expenses.js:
 *
 *   (a) GET /api/shifts/:id/full-report-print with NO token → 401
 *       (the route verifies the Authorization header itself — the legacy
 *        server.js exemption no longer makes it anonymous), owner → 200,
 *        non-owner without capability → 403, manager → 200.
 *   (b) cashier CAN still run the daily flow: open a shift (pos.use) and
 *       close it (pos.shift_close) — the real flow, cleaned up after.
 *   (c) non-manager gets 403 on channel writes and the DB state is unchanged
 *       (create refused → no row; toggle refused → is_active untouched).
 *   (d) spoofed req.body.username is IGNORED: the shift is opened under the
 *       token identity, never the body identity.
 *   (+) checkout guard: employee (no pos.use) → 403 on POST /api/sales;
 *       cashier passes the guard (reaches validation → 400 empty_cart, no
 *       state written). Wipe guard: cashier DELETE shift → 403 (row kept),
 *       admin (guard bypass) → deleted. Expense writes → 403 for cashier.
 *
 * Fixtures are all ITEST- prefixed; cleanup runs before AND in finally.
 * Run: node tests/integration/salesShiftsAuthz.api.test.js  (shared MySQL)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.GSALES_TEST_PORT || 3994);
const BASE = { host: '127.0.0.1', port: PORT };

const U_CASH  = 'ITEST-gsales-cash1';
const U_MGR   = 'ITEST-gsales-mgr';
const U_EMP   = 'ITEST-gsales-emp';
const U_ADMIN = 'ITEST-gsales-admin';
const U_SPOOF = 'ITEST-gsales-victim'; // never created — only spoofed in bodies
const CH_ID   = 'ITEST-CH-GSALES';
const CH_NAME = 'ITEST-قناة-اختبار';

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

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
function tok(id, username, role, dev) {
  return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function cleanup() {
  const sqls = [
    ['DELETE FROM shifts WHERE username IN (?,?,?,?,?)', [U_CASH, U_MGR, U_EMP, U_ADMIN, U_SPOOF]],
    ['DELETE FROM channel_menu_items WHERE channel_id = ?', [CH_ID]],
    ['DELETE FROM sales_channels WHERE id = ? OR name = ?', [CH_ID, CH_NAME]],
    ['DELETE FROM expenses WHERE username IN (?,?,?,?)', [U_CASH, U_MGR, U_EMP, U_ADMIN]],
    ['DELETE FROM sales WHERE username IN (?,?,?,?)', [U_CASH, U_MGR, U_EMP, U_ADMIN]],
    ['DELETE FROM users WHERE username IN (?,?,?,?)', [U_CASH, U_MGR, U_EMP, U_ADMIN]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) { /* table variants — best effort */ } }
}

async function seed() {
  await cleanup();
  const ids = {};
  for (const [u, role] of [[U_CASH, 'cashier'], [U_MGR, 'manager'], [U_EMP, 'employee'], [U_ADMIN, 'admin']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  // A channel the non-manager will try (and fail) to mutate.
  await db.query(
    'INSERT INTO sales_channels (id, code, name, channel_type, is_active, display_order) VALUES (?,?,?,?,1,999)',
    [CH_ID, 'ITESTGS', CH_NAME, 'dine_in']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ G-SALES authz — capability guards / print auth / identity ═══\n');
  const ids = await seed();
  const cash = tok(ids[U_CASH], U_CASH, 'cashier');
  const mgr = tok(ids[U_MGR], U_MGR, 'manager');
  const emp = tok(ids[U_EMP], U_EMP, 'employee');
  const admin = tok(ids[U_ADMIN], U_ADMIN, 'admin');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── (d) + (b) cashier opens a shift; spoofed body.username is ignored ──
    console.log('▸ shift open — identity from token only');
    let r = await req('POST', '/api/shifts/open', cash, { username: U_SPOOF, device: { ua: 'gsales-itest' } });
    const shiftId = r.body && r.body.shiftId;
    check('cashier opens shift → success + shiftId', r.status === 200 && r.body && r.body.success === true && !!shiftId, { status: r.status, body: r.body });
    const [owned] = await db.query('SELECT username FROM shifts WHERE id = ?', [shiftId || '']);
    check('shift belongs to the TOKEN user (spoofed body.username ignored)', owned.length === 1 && owned[0].username === U_CASH, owned[0]);
    const [spoofRows] = await db.query('SELECT id FROM shifts WHERE username = ?', [U_SPOOF]);
    check('no shift exists for the spoofed username', spoofRows.length === 0, spoofRows);

    // ── (a) full-report-print auth ──
    console.log('▸ full-report-print — JWT required at the route');
    r = await req('GET', `/api/shifts/${shiftId}/full-report-print`);
    check('anonymous → 401', r.status === 401, { status: r.status, text: (r.text || '').slice(0, 80) });
    r = await req('GET', `/api/shifts/${shiftId}/full-report-print`, cash);
    check('shift owner (cashier) → 200 HTML', r.status === 200 && /SHIFT CLOSING REPORT|تقرير/.test(r.text || ''), r.status);
    r = await req('GET', `/api/shifts/${shiftId}/full-report-print`, emp);
    check('non-owner without capability (employee) → 403', r.status === 403, r.status);
    r = await req('GET', `/api/shifts/${shiftId}/full-report-print`, mgr);
    check('manager (sales.reports.view) → 200', r.status === 200, r.status);
    r = await req('GET', `/api/shifts/${shiftId}/full-report`, emp);
    check('JSON twin /full-report: employee → 403', r.status === 403, r.status);

    // ── checkout guard — cashier flow intact, employee blocked ──
    console.log('▸ checkout guard (pos.use)');
    r = await req('POST', '/api/sales', emp, { items: [], total: 0 });
    check('employee (no pos.use) POST /api/sales → 403 PERMISSION_DENIED', r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED', { status: r.status, body: r.body });
    r = await req('POST', '/api/sales', cash, { items: [], total: 0 });
    check('cashier passes the guard → 400 empty_cart (validation, no state)', r.status === 400 && r.body && r.body.code === 'empty_cart', { status: r.status, body: r.body });

    // ── (c) channel writes — non-manager 403, state unchanged ──
    console.log('▸ channel writes (channels.manage)');
    const chName = 'ITEST-CH-NEW-' + Date.now();
    r = await req('POST', '/api/sales-channels', cash, { name: chName, channelType: 'delivery' });
    check('cashier creating a channel → 403', r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED', { status: r.status, body: r.body });
    const [chNew] = await db.query('SELECT id FROM sales_channels WHERE name = ?', [chName]);
    check('no channel row was created (state unchanged)', chNew.length === 0, chNew);
    r = await req('PATCH', `/api/sales-channels/${CH_ID}/toggle`, emp);
    check('employee toggling a channel → 403', r.status === 403, r.status);
    const [chTog] = await db.query('SELECT is_active FROM sales_channels WHERE id = ?', [CH_ID]);
    check('toggle refused → is_active unchanged (still 1)', chTog.length === 1 && Number(chTog[0].is_active) === 1, chTog[0]);
    r = await req('POST', `/api/channel-menus/${CH_ID}/items`, cash, { itemIds: ['ITEST-NOPE'] });
    check('cashier adding channel-menu items → 403', r.status === 403, r.status);
    const [cmi] = await db.query('SELECT id FROM channel_menu_items WHERE channel_id = ?', [CH_ID]);
    check('no channel_menu_items row was created', cmi.length === 0, cmi);

    // ── expense writes — finance capability family ──
    console.log('▸ expense writes (finance.expenses.*)');
    r = await req('POST', '/api/expenses', cash, { category: 'ITEST', amount: 1, username: U_SPOOF });
    check('cashier creating an expense → 403', r.status === 403, { status: r.status, body: r.body });
    const [expRows] = await db.query('SELECT id FROM expenses WHERE username IN (?,?)', [U_CASH, U_SPOOF]);
    check('no expense row was created', expRows.length === 0, expRows);
    r = await req('DELETE', '/api/expenses/EXP-ITEST-NOPE', cash);
    check('cashier deleting an expense → 403', r.status === 403, r.status);

    // ── (b) cashier CLOSES the shift (real flow) ──
    console.log('▸ shift close — cashier daily flow intact');
    r = await req('GET', `/api/shifts/closing-data-v3/${shiftId}`, cash);
    check('closing-data-v3 reachable by cashier → 200', r.status === 200 && r.body && typeof r.body.expectedTotal !== 'undefined', { status: r.status });
    r = await req('POST', '/api/shifts/close', cash, { shiftId, actualCash: 0, actualCard: 0, actualKita: 0 });
    check('cashier closes own shift → success', r.status === 200 && r.body && r.body.success === true, { status: r.status, body: r.body });
    const [closed] = await db.query('SELECT status FROM shifts WHERE id = ?', [shiftId]);
    check('shift row is closed', closed.length === 1 && String(closed[0].status).toLowerCase() === 'closed', closed[0]);
    r = await req('POST', '/api/shifts/close', emp, { shiftId });
    check('employee (no pos.shift_close) → 403 on close', r.status === 403, r.status);

    // ── shift wipe — shifts.delete (cashier blocked; admin bypass works) ──
    console.log('▸ shift delete (shifts.delete)');
    r = await req('DELETE', `/api/shifts/${shiftId}`, cash);
    check('cashier deleting a shift → 403', r.status === 403, r.status);
    const [still] = await db.query('SELECT id FROM shifts WHERE id = ?', [shiftId]);
    check('shift row survived the refused delete', still.length === 1, still);
    r = await req('DELETE', `/api/shifts/${shiftId}`, admin);
    check('admin (capability bypass) deletes the shift → success', r.status === 200 && r.body && r.body.success === true, { status: r.status, body: r.body });
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${_f === 0 ? '✅' : '❌'} salesShiftsAuthz.api: ${_p} passed, ${_f} failed\n`);
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
