'use strict';
/*
 * customersAuthz.api.test.js — /api/erp/customers role authorization.
 *
 * Regression guard for a VERIFIED, EXPLOITED hole: routes/erp/customers.js
 * carried no role guard on any route. `/api/erp` only chains audit +
 * warehouse-scope middleware, so ANY authenticated principal could hit
 * DELETE /api/erp/customers/:id. Reproduced against the live dev DB before the
 * fix: a plain cashier's token returned HTTP 200 and set is_active = 0 on a
 * customer it had no business touching. `employee` / `custody` could do the same.
 *
 * The contract this locks in:
 *   • read + create stay open to the till — the cashier legitimately creates a
 *     customer mid-checkout, which is legacy parity (public/pos/app.js) and must
 *     NOT be broken by the fix. A guard that stops the till is a worse bug.
 *   • deletion is master data → admin/manager only.
 *   • employee/custody get nothing.
 *
 * Run: node tests/integration/customersAuthz.api.test.js   (MySQL on 127.0.0.1:3306)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const db = require('../../db/connection');

const ENV = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2];
}
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const PORT = 3272;
const BASE = `http://127.0.0.1:${PORT}`;
const sign = (username, role, id) => jwt.sign({ id, username, role, tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' });
const T = {
  admin:    sign('custauthz_admin', 'admin', 900801),
  manager:  sign('custauthz_mgr', 'manager', 900802),
  cashier:  sign('custauthz_cash', 'cashier', 900803),
  employee: sign('custauthz_emp', 'employee', 900804),
};

const C_DEL = 'CUSTAUTHZ-DEL-1';   // deletion target
const C_KEEP = 'CUSTAUTHZ-KEEP-1'; // must survive the cashier's attempt

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); }
}
async function waitUp(secs) {
  for (let i = 0; i < secs; i++) {
    try { const r = await fetch(BASE + '/api/version'); if (r.ok) return true; } catch (_) {}
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}
async function j(method, pathname, tok, body) {
  const r = await fetch(BASE + '/api/erp' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const isActive = async (id) => {
  const [r] = await db.query('SELECT is_active FROM customers WHERE id = ?', [id]);
  return r.length ? Number(r[0].is_active) : null;
};
async function cleanup() {
  for (const id of [C_DEL, C_KEEP]) {
    try { await db.query('DELETE FROM customers WHERE id = ?', [id]); } catch (_) {}
  }
  try { await db.query("DELETE FROM customers WHERE name = 'عميل من اختبار الصلاحيات'"); } catch (_) {}
}

async function main() {
  console.log('\n═══ /api/erp/customers — role authorization ═══\n');
  await cleanup();
  for (const id of [C_DEL, C_KEEP]) {
    await db.query('INSERT INTO customers (id, name, is_active) VALUES (?,?,1)', [id, 'عميل اختبار ' + id]);
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = ''; child.stdout.on('data', (d) => { childLog += d; }); child.stderr.on('data', (d) => { childLog += d; });

  try {
    check('server up', await waitUp(240));

    // ── 1. THE HOLE: a cashier must not be able to delete a customer ──
    const cashDel = await j('DELETE', '/customers/' + C_KEEP, T.cashier);
    check('cashier DELETE customer → 403', cashDel.status === 403, { status: cashDel.status, data: cashDel.data });
    check('…and the customer is STILL active (no side effect)', (await isActive(C_KEEP)) === 1);

    // ── 2. employee has no business here at all ──
    const empList = await j('GET', '/customers', T.employee);
    check('employee GET customers → 403', empList.status === 403, { status: empList.status });
    const empDel = await j('DELETE', '/customers/' + C_KEEP, T.employee);
    check('employee DELETE customer → 403', empDel.status === 403, { status: empDel.status });

    // ── 3. the till must KEEP WORKING (guard must not over-reach) ──
    const cashSearch = await j('GET', '/customers/search?q=' + encodeURIComponent('عميل'), T.cashier);
    check('cashier SEARCH → 200 (till still works)', cashSearch.status === 200, { status: cashSearch.status });
    const cashList = await j('GET', '/customers', T.cashier);
    check('cashier LIST → 200', cashList.status === 200, { status: cashList.status });
    const cashCreate = await j('POST', '/customers', T.cashier, {
      name: 'عميل من اختبار الصلاحيات', phone: '0501234567',
    });
    check('cashier CREATE → 200 (legacy parity: cashier adds customer at checkout)',
      cashCreate.status === 200, { status: cashCreate.status, data: cashCreate.data });

    // ── 4. privileged roles retain deletion ──
    const mgrDel = await j('DELETE', '/customers/' + C_DEL, T.manager);
    check('manager DELETE → 200', mgrDel.status === 200, { status: mgrDel.status });
    check('…and it actually soft-deleted', (await isActive(C_DEL)) === 0);

    const adminList = await j('GET', '/customers', T.admin);
    check('admin LIST → 200', adminList.status === 200, { status: adminList.status });
  } catch (e) {
    check('no exception', false, String(e && e.message));
    console.log(childLog.slice(-1500));
  } finally {
    try { child.kill(); } catch (_) {}
    await cleanup();
  }

  console.log(`\ncustomersAuthz: ${_p} passed, ${_f} failed\n`);
  process.exit(_f ? 1 : 0);
}

main();
