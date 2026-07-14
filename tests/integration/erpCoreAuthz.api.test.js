'use strict';
/* Integration — /api/erp (routes/erp-core.js) authorization (real server + DB).
 *
 * THE DEFECT: routes/erp-core.js had ZERO capability or role guards (grep -c = 0)
 * while mounted at /api/erp (server.js:666), and it contains THREE gl.postJournal
 * call sites — royalty approve (:1385), waste create (:1674) and purchase receipt
 * (:1835). So ANY authenticated user, a cashier included, could post journal
 * entries to the general ledger and deduct warehouse stock. Sibling modules at
 * the same mount point are gated with requireRole('admin','manager').
 *
 * Note `waste.create` already EXISTED in the seeded catalog and was granted to
 * admin/inventory/manager — the capability was defined and simply never enforced
 * on the route.
 *
 * Run: node tests/integration/erpCoreAuthz.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3987;
const CASHIER = 'itest_erpc_cashier';
const MANAGER = 'itest_erpc_manager';
const PW = 'ErpCore#Test!2026';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }

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
const cleanup = async () => { for (const u of [CASHIER, MANAGER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} } };

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ /api/erp (erp-core) — authorization ═══');

    const [ry] = await db.query("SELECT id FROM permissions_v3 WHERE id IN ('royalty.view','royalty.manage') ORDER BY id");
    check('late-seed added royalty.view + royalty.manage', ry.length === 2, ry.map((r) => r.id));
    const [wc] = await db.query("SELECT id FROM permissions_v3 WHERE id='waste.create'");
    check('waste.create was ALREADY in the catalog (defined but never enforced)', wc.length === 1);

    const cashier = await login(CASHIER);
    const manager = await login(MANAGER);
    check('both users authenticate', !!cashier && !!manager);

    // ── baseline: how many journals exist right now ──
    const jCount = async () => { const [r] = await db.query('SELECT COUNT(*) c FROM gl_journals'); return Number(r[0].c); };
    const before = await jCount();

    // ── a cashier must not post GL via waste ──
    const wastePayload = {
      warehouseId: 'ITEST-WH-NOPE', wasteDate: '2029-06-15', reason: 'expired',
      items: [{ itemId: 'ITEST-ITEM', quantity: 1, unit: 'PCS', unitCost: 5 }],
    };
    const cWaste = await call('POST', '/api/erp/waste-entries', cashier, wastePayload);
    check('cashier is DENIED creating a waste entry (posts GL + deducts stock)', cWaste.status === 403, { status: cWaste.status });

    const cWasteRead = await call('GET', '/api/erp/waste-entries', cashier);
    check('cashier is DENIED reading waste entries', cWasteRead.status === 403, { status: cWasteRead.status });

    const cWasteDel = await call('DELETE', '/api/erp/waste-entries/ITEST-NOPE', cashier);
    check('cashier is DENIED deleting a waste entry (reverses stock + GL)', cWasteDel.status === 403, { status: cWasteDel.status });

    // ── a cashier must not touch royalty accrual ──
    const cRoyRead = await call('GET', '/api/erp/royalty-runs', cashier);
    check('cashier is DENIED reading royalty runs', cRoyRead.status === 403, { status: cRoyRead.status });

    const cRoyCompute = await call('POST', '/api/erp/royalty-runs/compute', cashier, { brandId: 'X', periodStart: '2029-01-01', periodEnd: '2029-01-31' });
    check('cashier is DENIED computing a royalty run', cRoyCompute.status === 403, { status: cRoyCompute.status });

    const cRoyApprove = await call('POST', '/api/erp/royalty-runs/ITEST-NOPE/approve', cashier, {});
    check('cashier is DENIED approving a royalty accrual (posts Dr 6100 / Cr 2310)', cRoyApprove.status === 403, { status: cRoyApprove.status });

    const cRoyPaid = await call('POST', '/api/erp/royalty-runs/ITEST-NOPE/mark-paid', cashier, {});
    check('cashier is DENIED marking a royalty run paid', cRoyPaid.status === 403, { status: cRoyPaid.status });

    const cRoyDel = await call('DELETE', '/api/erp/royalty-runs/ITEST-NOPE', cashier);
    check('cashier is DENIED deleting a royalty run', cRoyDel.status === 403, { status: cRoyDel.status });

    // ── the third GL site ──
    const cRecv = await call('POST', '/api/erp/purchase-receipts', cashier, { items: [] });
    check('cashier is DENIED creating a purchase receipt (third GL posting site)', cRecv.status === 403, { status: cRecv.status });

    // ── THE POINT: nothing reached the ledger ──
    check('NO journal was posted by any denied attempt', (await jCount()) === before, { before, after: await jCount() });

    // ── the guards harden without removing the function ──
    const mWasteRead = await call('GET', '/api/erp/waste-entries', manager);
    check('manager CAN read waste entries', mWasteRead.status === 200, { status: mWasteRead.status });

    const mRoyRead = await call('GET', '/api/erp/royalty-runs', manager);
    check('manager CAN read royalty runs', mRoyRead.status === 200, { status: mRoyRead.status });

    // A manager's waste create should get past the GUARD and fail on business
    // validation instead (the warehouse doesn't exist) — proving the 403s above
    // are authorization, not a broken route.
    const mWaste = await call('POST', '/api/erp/waste-entries', manager, wastePayload);
    check('manager gets PAST the guard (fails on data, not on permission)', mWaste.status !== 403, { status: mWaste.status, body: mWaste.body });

    console.log(`\n${fail === 0 ? '✅' : '❌'} erpCoreAuthz: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
