'use strict';
/* Integration — maker/checker segregation of duties on GL journal approval
 * (POST /api/erp/gl/journals/bulk, action=approve_post). Real server + DB.
 *
 * Tier A.1 Corrective Gate, item 7. Before this fix, any single user with
 * finance.gl.post could create AND approve/post their own journal — a
 * textbook SoD violation. Now the creator is blocked from approving their
 * own journal (admin/developer exempt), and the denial is audit-logged.
 *
 * Run: node tests/integration/journalMakerChecker.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3989;
const MAKER = 'itest_mc_maker';
const CHECKER = 'itest_mc_checker';
const PW = 'MakerChecker#Test!2026';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

function assertTestEnvironment() {
  const looksProd = !!(process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQLHOST);
  const dbName = process.env.DB_NAME || process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || '';
  if (looksProd || (dbName && dbName !== 'moroccan_taste_pos')) { console.error('REFUSING TO RUN: non-local database detected.'); process.exit(2); }
}

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

const J_SELF = 'ITEST-MC-J-SELF';

async function cleanup() {
  for (const u of [MAKER, CHECKER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  for (const jid of [J_SELF]) {
    try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [jid]); } catch (_) {}
    try { await db.query('DELETE FROM gl_journals WHERE id = ?', [jid]); } catch (_) {}
  }
}

async function makeDraftJournal(id, journalNumber, createdBy) {
  const [[cashAcc]] = await db.query("SELECT id FROM gl_accounts WHERE code = '1110' LIMIT 1");
  const [[revAcc]] = await db.query("SELECT id FROM gl_accounts WHERE code = '4100' LIMIT 1");
  await db.query(
    "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status, created_by) VALUES (?,?,?,?,?, 'draft', ?)",
    [id, journalNumber, '2026-06-10', 20, 20, createdBy]
  );
  await db.query(
    'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
    [id + '-E1', id, cashAcc.id, 20, id + '-E2', id, revAcc.id, 20]
  );
}

(async () => {
  assertTestEnvironment();
  await cleanup();
  let server = null;
  try {
    console.log('\n═══ Journal maker/checker (segregation of duties) ═══');
    const hash = await bcrypt.hash(PW, 12);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MAKER, hash, 'finance']);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CHECKER, hash, 'finance']);

    server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }

    await makeDraftJournal(J_SELF, 'ITEST-MC-SELF', MAKER);

    const maker = await login(MAKER);
    const checker = await login(CHECKER);
    check('maker and checker authenticate', !!maker && !!checker);

    // ── self-approval blocked ──
    const selfResp = await call('POST', '/api/erp/gl/journals/bulk', maker, { ids: [J_SELF], action: 'approve_post' });
    check('bulk approve_post call succeeds at the HTTP level (per-id outcome reported inside)', selfResp.status === 200 && selfResp.body && selfResp.body.success, selfResp.body);
    const selfResult = selfResp.body && selfResp.body.results && selfResp.body.results[0];
    check('the creator approving their OWN journal is denied (reason=sod-self-approval-denied)', selfResult && selfResult.ok === false && selfResult.reason === 'sod-self-approval-denied', selfResult);
    const [[stillDraftSelf]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF]);
    check('the self-approval attempt did NOT change the journal\'s status', stillDraftSelf.status === 'draft', stillDraftSelf);

    // ── different user (checker) approving the SAME journal succeeds ──
    const otherResp = await call('POST', '/api/erp/gl/journals/bulk', checker, { ids: [J_SELF], action: 'approve_post' });
    const otherResult = otherResp.body && otherResp.body.results && otherResp.body.results[0];
    check('a DIFFERENT user (checker) approving the maker\'s journal succeeds', otherResult && otherResult.ok === true, otherResult);
    const [[postedNow]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF]);
    check('journal is now posted once approved by someone other than its creator', postedNow.status === 'posted', postedNow);

    // ── denial is audit-logged ──
    const [sodAudit] = await db.query(
      "SELECT action, entity_id FROM audit_logs WHERE entity_id = ? AND action = 'approve_journal_denied_sod' ORDER BY created_at DESC LIMIT 3",
      [J_SELF]
    );
    check('the self-approval denial was audit-logged as approve_journal_denied_sod', sodAudit.length >= 1, sodAudit);

    console.log(`\n${fail === 0 ? '✅' : '❌'} journalMakerChecker: ${pass} passed, ${fail} failed`);
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
