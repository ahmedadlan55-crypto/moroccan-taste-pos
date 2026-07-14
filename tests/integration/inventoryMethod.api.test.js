'use strict';
/* Integration — inventory valuation method guard (real server + DB).
 *
 * Before: POST /erp/inventory-method had NO capability guard and NO protection.
 * The setting decides how COGS is computed and posted to the GL, and anyone with
 * any valid token could flip it at any time — including mid-period, leaving one
 * period's cost computed two different ways (IAS 2 consistency).
 *
 * Run: node tests/integration/inventoryMethod.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3992;
const CASHIER = 'itest_im_cashier';
const ADMIN = 'itest_im_admin';
const PW = 'InvMethod#Test!2026';
const MOVE_ID = '999777001';
const CLOSED_PERIOD_ID = 'ITEST-IM-CLOSED';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

let originalMethod = null;
async function cleanup() {
  for (const u of [CASHIER, ADMIN]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try { await db.query('DELETE FROM inventory_movements WHERE id=?', [MOVE_ID]); } catch (_) {}
  try { await db.query('DELETE FROM accounting_periods WHERE id=?', [CLOSED_PERIOD_ID]); } catch (_) {}
}

(async () => {
  await cleanup();
  const [om] = await db.query("SELECT setting_value v FROM settings WHERE setting_key='inventory_method'");
  originalMethod = om.length ? om[0].v : null;

  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ inventory valuation method ═══');

    const [perm] = await db.query("SELECT is_sensitive FROM permissions_v3 WHERE id='inventory.method.manage'");
    check('late-seed added inventory.method.manage', perm.length === 1 && perm[0].is_sensitive === 1, perm);

    const cashier = await login(CASHIER);
    const admin = await login(ADMIN);
    check('users authenticate', !!cashier && !!admin);

    // ── a cashier must not be able to change how COGS is posted ──
    const cWrite = await call('POST', '/api/erp/inventory-method', cashier, { method: 'periodic' });
    check('cashier is DENIED changing the method', cWrite.status === 403, { status: cWrite.status });

    const [afterC] = await db.query("SELECT setting_value v FROM settings WHERE setting_key='inventory_method'");
    check('the method really is unchanged after the denied attempt',
      (afterC.length ? afterC[0].v : null) === originalMethod, { now: afterC[0] && afterC[0].v, was: originalMethod });

    // ── admin reads: the response explains whether a change is safe ──
    const read = await call('GET', '/api/erp/inventory-method', admin);
    check('admin can read the method', read.status === 200 && !!read.body && !!read.body.method, read.body);
    check('read reports movement count + canChange (so the UI can explain a block)',
      read.body && typeof read.body.movementsSinceLastClose === 'number' && typeof read.body.canChange === 'boolean', read.body);

    // ── with no movements, the switch is allowed ──
    const startMethod = read.body.method;
    const other = startMethod === 'perpetual' ? 'periodic' : 'perpetual';
    if (read.body.movementsSinceLastClose === 0) {
      const ok = await call('POST', '/api/erp/inventory-method', admin, { method: other });
      check('with zero movements, admin CAN switch', ok.body && ok.body.success === true, ok.body);
      const [now] = await db.query("SELECT setting_value v FROM settings WHERE setting_key='inventory_method'");
      check('the switch persisted', now[0].v === other, now[0]);
      // put it back
      await call('POST', '/api/erp/inventory-method', admin, { method: startMethod });
    } else {
      check('SKIPPED zero-movement switch (env already has movements)', true);
    }

    // ── with movements in an unclosed period, the switch is BLOCKED ──
    // A hard-closed period ending yesterday forces the guard down its FILTERED
    // branch (movement_date > lastClose). That branch named a `created_at` column
    // this table does not have, so it threw and only the fail-closed default hid
    // it — the guard would have blocked every switch for the wrong reason.
    await db.query(
      "INSERT INTO accounting_periods (id, period_name, period_label, start_date, end_date, status) VALUES (?,'ITEST Closed','ITEST Closed', DATE_SUB(CURDATE(), INTERVAL 40 DAY), DATE_SUB(CURDATE(), INTERVAL 1 DAY),'closed') ON DUPLICATE KEY UPDATE status='closed'",
      [CLOSED_PERIOD_ID]);

    // item_id is FK→inv_items and nullable; leave it NULL rather than inventing a
    // catalog row. The guard counts movements, it does not join the item.
    await db.query(
      "INSERT INTO inventory_movements (id, movement_date, item_name, type, qty, reason, username) VALUES (?, NOW(), 'ITEST item', 'out', 1, 'itest', 'itest')",
      [MOVE_ID]);

    const read2 = await call('GET', '/api/erp/inventory-method', admin);
    check('the guard resolves the last close date (filtered branch is live)',
      read2.body && !!read2.body.lastCloseDate, read2.body);
    check('read now reports the movement', read2.body && read2.body.movementsSinceLastClose > 0, read2.body);
    check('the count is a REAL number, not the -1 fail-closed sentinel (the query works)',
      read2.body && read2.body.movementsSinceLastClose === 1, read2.body);
    check('read now reports canChange=false', read2.body && read2.body.canChange === false, read2.body);

    const blocked = await call('POST', '/api/erp/inventory-method', admin, { method: other });
    check('the switch is BLOCKED while movements sit in an unclosed period',
      blocked.body && blocked.body.success === false && blocked.body.blocked === true, blocked.body);
    check('the block says HOW MANY movements (not a bare refusal)',
      blocked.body && blocked.body.movementsSinceLastClose > 0, blocked.body);

    const [stillOld] = await db.query("SELECT setting_value v FROM settings WHERE setting_key='inventory_method'");
    check('the method is genuinely unchanged after the block', stillOld[0].v === startMethod, stillOld[0]);

    // ── force is an explicit, separate act ──
    const forced = await call('POST', '/api/erp/inventory-method', admin, { method: other, force: true });
    check('force:true overrides the block', forced.body && forced.body.success === true && forced.body.forced === true, forced.body);
    const [nowF] = await db.query("SELECT setting_value v FROM settings WHERE setting_key='inventory_method'");
    check('the forced switch persisted', nowF[0].v === other, nowF[0]);

    // ── a no-op switch is not treated as a change ──
    const same = await call('POST', '/api/erp/inventory-method', admin, { method: other });
    check('re-selecting the ACTIVE method is a no-op, not a blocked change',
      same.body && same.body.success === true && same.body.unchanged === true, same.body);

    const bad = await call('POST', '/api/erp/inventory-method', admin, { method: 'lifo' });
    check('an invalid method is refused', bad.body && bad.body.success === false, bad.body);

    // restore
    await call('POST', '/api/erp/inventory-method', admin, { method: startMethod, force: true });

    console.log(`\n${fail === 0 ? '✅' : '❌'} inventoryMethod: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    if (originalMethod !== null) {
      await db.query("INSERT INTO settings (setting_key,setting_value) VALUES ('inventory_method',?) ON DUPLICATE KEY UPDATE setting_value=?", [originalMethod, originalMethod]).catch(() => {});
    }
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
