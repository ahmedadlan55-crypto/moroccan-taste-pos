'use strict';
/* Integration — the 'auditor' role, end-to-end through the REAL product API
 * (Tier A.2 corrective gate, Section 4).
 *
 * Tier A.1 "proved" this role by inserting a users row directly via SQL,
 * bypassing routes/auth.js's role validation entirely — exactly the kind of
 * proof this gate exists to reject. 'auditor' was deliberately kept in
 * lib/roles.js's GRANT_ONLY_ROLES (rejected by POST/PUT /api/auth/users),
 * even though it already had real capability grants seeded (finance.reports
 * .view / finance.gl.view / finance.bankrec.view — db/migrations/finance/
 * capabilities.js) that no account could ever actually hold through the
 * product's own user-management UI/API.
 *
 * This test creates the auditor account through POST /api/auth/users (the
 * same endpoint UserDialog.tsx's save flow calls), logs it in through the
 * real POST /api/auth/login, then proves both halves of the role's
 * contract: it CAN read financial reports, and it is explicitly DENIED
 * every journal mutation (create, approve, post, delete), each with its
 * own specific code — never a direct SQL insert standing in for any of it.
 *
 * Run: node tests/integration/auditorRole.test.js
 */
require('dotenv').config();
// Tier A.2 — MUST be required and activated before db/connection.js.
const harness = require('../helpers/testHarness');
harness.activate();
const http = require('http');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const ADMIN = 'itest_ar_admin';
const AUDITOR = 'itest_ar_auditor';
const PW = 'AuditorRole#Test!2026';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

function call(port, method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (port, u) => (await call(port, 'POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';

const SCAFFOLD_PARENT_ID = 'ITEST-AR-SCAFFOLD-PARENT';
const SCAFFOLD_CASH_ID = 'ITEST-AR-SCAFFOLD-CASH';
const SCAFFOLD_REV_ID = 'ITEST-AR-SCAFFOLD-REV';
const J_ID = 'ITEST-AR-J1';

async function cleanup() {
  for (const u of [ADMIN, AUDITOR]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [J_ID]); } catch (_) {}
  try { await db.query('DELETE FROM gl_journals WHERE id = ?', [J_ID]); } catch (_) {}
  try { await db.query("DELETE FROM gl_journals WHERE description = 'auditor should not be able to create this'"); } catch (_) {}
  for (const id of [SCAFFOLD_CASH_ID, SCAFFOLD_REV_ID, SCAFFOLD_PARENT_ID]) { try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [id]); } catch (_) {} }
}

(async () => {
  await harness.ensureSchema();
  await cleanup();
  let server = null;
  try {
    console.log('\n═══ Auditor role, end-to-end via the real product API, isolated test DB ═══');

    // ADMIN here is only a fixture actor performing routine user-management —
    // NOT the subject under test. The one thing this whole file exists to
    // prove without direct SQL is the AUDITOR account below.
    const hash = await bcrypt.hash(PW, 12);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);

    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,NULL,1,1,1)',
      [SCAFFOLD_PARENT_ID, 'ITEST900060', 'مجلّد سقالة (ITEST)', 'asset']
    );
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)',
      [SCAFFOLD_CASH_ID, 'ITEST900061', 'نقدية سقالة (ITEST)', 'asset', SCAFFOLD_PARENT_ID]
    );
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)',
      [SCAFFOLD_REV_ID, 'ITEST900062', 'إيراد سقالة (ITEST)', 'revenue', SCAFFOLD_PARENT_ID]
    );

    server = await harness.spawnServer();
    const port = server.port;

    const admin = await login(port, ADMIN);
    check('admin (fixture actor, not the subject under test) authenticates', !!admin, admin);

    // ── 1. Auditor created via the REAL product API — never direct SQL ──
    const createResp = await call(port, 'POST', '/api/auth/users', admin, {
      username: AUDITOR, password: PW, role: 'auditor', displayName: 'Auditor ITEST',
    });
    check(
      "POST /api/auth/users accepts role='auditor' (lib/roles.js#ASSIGNABLE_ROLES now includes it) — creation succeeds, not a 400 'الدور غير صالح'",
      createResp.status === 200 && createResp.body && createResp.body.success === true,
      createResp.body
    );
    const [[storedUser]] = await db.query('SELECT role FROM users WHERE username = ?', [AUDITOR]);
    check("the stored users.role is genuinely 'auditor', not silently downgraded to cashier", !!storedUser && storedUser.role === 'auditor', storedUser);

    // ── 2. Auditor logs in through the real login endpoint and gets a real JWT ──
    const auditorToken = await login(port, AUDITOR);
    check('the newly-created auditor account authenticates via the real /api/auth/login', !!auditorToken, auditorToken);

    // ── 3. READ — auditor CAN view financial reports ──
    const tbResp = await call(port, 'GET', '/api/erp/reports/trial-balance?from=2026-06-01&to=2026-06-30', auditorToken);
    check(
      'auditor CAN read the Trial Balance (200) — the finance.reports.view grant is now reachable by a real account, not just present in code',
      tbResp.status === 200 && tbResp.body && tbResp.body.success === true,
      { status: tbResp.status, body: tbResp.body }
    );

    // ── 4. WRITE — auditor is explicitly DENIED every journal mutation ──
    const createJournalResp = await call(port, 'POST', '/api/erp/gl/journals', auditorToken, {
      journalDate: '2026-06-10', description: 'auditor should not be able to create this',
      entries: [
        { accountId: SCAFFOLD_CASH_ID, accountCode: 'ITEST900061', debit: 10, credit: 0 },
        { accountId: SCAFFOLD_REV_ID, accountCode: 'ITEST900062', debit: 0, credit: 10 },
      ],
    });
    check(
      'auditor is DENIED creating a journal (403, PERMISSION_DENIED — lacks finance.gl.create)',
      createJournalResp.status === 403 && createJournalResp.body && createJournalResp.body.code === 'PERMISSION_DENIED',
      { status: createJournalResp.status, body: createJournalResp.body }
    );
    const [journalsAfterCreateAttempt] = await db.query("SELECT id FROM gl_journals WHERE description = 'auditor should not be able to create this'");
    check('no journal was actually created by the denied attempt', journalsAfterCreateAttempt.length === 0, journalsAfterCreateAttempt);

    // A real draft journal (created by admin) to attempt approve/post/delete
    // against — proves denial on TRANSITIONS, not just creation.
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status, created_by) VALUES (?,?,?,?,?, 'draft', ?)",
      [J_ID, 'ITEST-AR-J1', '2026-06-10', 10, 10, ADMIN]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      [J_ID + '-E1', J_ID, SCAFFOLD_CASH_ID, 10, J_ID + '-E2', J_ID, SCAFFOLD_REV_ID, 10]
    );

    const approveResp = await call(port, 'POST', '/api/erp/gl/journals/' + J_ID + '/approve', auditorToken, {});
    check(
      'auditor is DENIED approving a journal (403, PERMISSION_DENIED — lacks finance.gl.approve)',
      approveResp.status === 403 && approveResp.body && approveResp.body.code === 'PERMISSION_DENIED',
      { status: approveResp.status, body: approveResp.body }
    );

    const postResp = await call(port, 'POST', '/api/erp/gl/journals/' + J_ID + '/post', auditorToken, {});
    check(
      'auditor is DENIED posting a journal (403, PERMISSION_DENIED — lacks finance.gl.post)',
      postResp.status === 403 && postResp.body && postResp.body.code === 'PERMISSION_DENIED',
      { status: postResp.status, body: postResp.body }
    );

    const deleteResp = await call(port, 'DELETE', '/api/erp/gl/journals/' + J_ID, auditorToken, null);
    check(
      'auditor is DENIED deleting a journal (403 — guardDeveloper, developer/admin only)',
      deleteResp.status === 403 && deleteResp.body && deleteResp.body.success === false,
      { status: deleteResp.status, body: deleteResp.body }
    );

    const [[journalStillDraft]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_ID]);
    check('the fixture journal was untouched by every denied attempt — still draft', journalStillDraft.status === 'draft', journalStillDraft);

    console.log(`\n${fail === 0 ? '✅' : '❌'} auditorRole: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    if (server) server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
