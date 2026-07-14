'use strict';
/* Integration — accounting periods capability guard (real server + DB).
 *
 * The defect: routes/erp.js exposed GET/POST /periods and POST /periods/:id/lock
 * with NO capability guard, while their /gl/* neighbours had one. Closing — or
 * FORCE-REOPENING — an accounting period generates and reverses closing journal
 * entries, and any valid token (a cashier's included) could do it. The actor
 * stamped on closed_by was also read from req.body.username, so a caller could
 * attribute the close to someone else.
 *
 * Run: node tests/integration/periodsSecurity.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3994;
const BASE = 'http://127.0.0.1:' + PORT;
const CASHIER = 'itest_per_cashier';
const ADMIN = 'itest_per_admin';
const PW = 'Period#Test!2026';
const PERIOD_ID = 'ITEST-PER-1';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }

function req(method, p, token, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (data) r.write(data); r.end();
  });
}
const login = async (u) => (await req('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function cleanup() {
  for (const u of [CASHIER, ADMIN]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try { await db.query('DELETE FROM accounting_periods WHERE id=?', [PERIOD_ID]); } catch (_) {}
  // This test hard-closes the period (which GENERATES a CLOSE-<id> journal) and
  // then force-reopens it (which posts a REOPEN-CLOSE-<id> reversal). Deleting
  // only the period left both journals behind, polluting gl_journals for every
  // later reader — the equity report reads exactly these rows. Ids are
  // deterministic: routes/erp.js builds them as 'CLOSE-'+period.id and
  // 'REOPEN-CLOSE-'+period.id.
  for (const jid of [`CLOSE-${PERIOD_ID}`, `REOPEN-CLOSE-${PERIOD_ID}`]) {
    try { await db.query('DELETE FROM gl_entries WHERE journal_id=?', [jid]); } catch (_) {}
    try { await db.query('DELETE FROM gl_journals WHERE id=?', [jid]); } catch (_) {}
  }
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ accounting periods — capability guard ═══');

    // The late-seed must have landed, or the guard would deny everyone.
    const [perm] = await db.query("SELECT id, is_sensitive FROM permissions_v3 WHERE id='finance.periods.manage'");
    check('late-seed added finance.periods.manage to the catalog', perm.length === 1, perm);
    check('it is marked sensitive', perm.length === 1 && perm[0].is_sensitive === 1);
    const [grants] = await db.query("SELECT role FROM role_permissions WHERE permission_id='finance.periods.manage' ORDER BY role");
    check('granted to the roles that already held neighbouring finance rights',
      grants.map((g) => g.role).join(',') === 'finance,manager', grants.map((g) => g.role));

    const cashier = await login(CASHIER);
    const admin = await login(ADMIN);
    check('both test users authenticate', !!cashier && !!admin);

    await db.query(
      "INSERT INTO accounting_periods (id, period_name, period_label, start_date, end_date, status) VALUES (?,'ITEST Period','ITEST Period','2026-01-01','2026-01-31','open')",
      [PERIOD_ID]);

    // ── a cashier must not be able to touch the period register ──
    const cRead = await req('GET', '/api/erp/periods', cashier);
    check('cashier is DENIED reading periods', cRead.status === 403, { status: cRead.status });

    const cCreate = await req('POST', '/api/erp/periods', cashier, { periodName: 'x', startDate: '2026-02-01', endDate: '2026-02-28' });
    check('cashier is DENIED creating a period', cCreate.status === 403, { status: cCreate.status });

    const cLock = await req('POST', `/api/erp/periods/${PERIOD_ID}/lock`, cashier, { status: 'closed' });
    check('cashier is DENIED closing a period', cLock.status === 403, { status: cLock.status });

    const [afterCashier] = await db.query('SELECT status FROM accounting_periods WHERE id=?', [PERIOD_ID]);
    check('the period really is still open after the denied attempt', afterCashier[0].status === 'open', afterCashier[0]);

    // ── admin still works: the guard hardens without removing the function ──
    const aRead = await req('GET', '/api/erp/periods', admin);
    check('admin can read periods', aRead.status === 200 && Array.isArray(aRead.body), { status: aRead.status });
    // The list used to answer [] on a populated table: the SELECT named
    // company_id/notes (neither exists) and the bare catch swallowed the throw.
    const [dbCount] = await db.query('SELECT COUNT(*) c FROM accounting_periods');
    check('the list returns the rows that are ACTUALLY in the table (was always [] before)',
      Array.isArray(aRead.body) && aRead.body.length === Math.min(dbCount[0].c, 200),
      { api: Array.isArray(aRead.body) ? aRead.body.length : null, db: dbCount[0].c });
    const mine = (aRead.body || []).find((p) => p.id === PERIOD_ID);
    check('the seeded period is present and named', !!mine && mine.periodName === 'ITEST Period', mine);
    check('status is normalised to one spelling', !!mine && mine.status === 'open', mine && mine.status);

    // Creating a period was impossible — the INSERT hit the same missing columns.
    const created = await req('POST', '/api/erp/periods', admin,
      { periodName: 'ITEST New', startDate: '2026-03-01', endDate: '2026-03-31' });
    check('admin can CREATE a period (was impossible before)', created.body && created.body.success === true, created.body);
    if (created.body && created.body.id) {
      const [chk] = await db.query('SELECT period_name, period_label, status FROM accounting_periods WHERE id=?', [created.body.id]);
      check('the created row populates the NOT NULL period_label', chk.length === 1 && chk[0].period_label === 'ITEST New', chk[0]);
      await db.query('DELETE FROM accounting_periods WHERE id=?', [created.body.id]);
    }
    const tooLong = await req('POST', '/api/erp/periods', admin,
      { periodName: 'x'.repeat(25), startDate: '2026-04-01', endDate: '2026-04-30' });
    check('a name over the VARCHAR(20) limit is refused, not silently truncated',
      tooLong.body && tooLong.body.success === false, tooLong.body);
    const backwards = await req('POST', '/api/erp/periods', admin,
      { periodName: 'ITEST Bad', startDate: '2026-05-31', endDate: '2026-05-01' });
    check('an end date before the start date is refused', backwards.body && backwards.body.success === false, backwards.body);

    const aSoft = await req('POST', `/api/erp/periods/${PERIOD_ID}/lock`, admin, { status: 'soft_closed' });
    check('admin can soft-close', aSoft.status === 200 && aSoft.body && aSoft.body.success === true, aSoft.body);

    // ── the actor comes from the token, not the body ──
    const [row] = await db.query('SELECT closed_by FROM accounting_periods WHERE id=?', [PERIOD_ID]);
    check('closed_by is the authenticated admin', row[0].closed_by === ADMIN, row[0]);

    const spoof = await req('POST', `/api/erp/periods/${PERIOD_ID}/lock`, admin, { status: 'closed', username: 'someone_else' });
    check('a hard close with a spoofed username still succeeds', spoof.status === 200 && spoof.body && spoof.body.success === true, spoof.body);
    const [row2] = await db.query('SELECT closed_by, status FROM accounting_periods WHERE id=?', [PERIOD_ID]);
    check('…but closed_by IGNORES the body and records the real token user',
      row2[0].closed_by === ADMIN, row2[0]);
    check('the period is now hard-closed', row2[0].status === 'closed', row2[0]);

    // ── reopening a hard-closed period needs force ──
    const noForce = await req('POST', `/api/erp/periods/${PERIOD_ID}/lock`, admin, { status: 'open' });
    check('reopening a hard-closed period WITHOUT force is refused',
      noForce.body && noForce.body.success === false, noForce.body);
    const withForce = await req('POST', `/api/erp/periods/${PERIOD_ID}/lock`, admin, { status: 'open', force: true });
    check('reopening WITH force succeeds', withForce.body && withForce.body.success === true, withForce.body);

    console.log(`\n${fail === 0 ? '✅' : '❌'} periodsSecurity: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
