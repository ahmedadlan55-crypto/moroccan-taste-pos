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
// Tier A.2 — MUST be required and activated before db/connection.js.
const harness = require('../helpers/testHarness');
harness.activate();
const http = require('http');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const MAKER = 'itest_mc_maker';
const CHECKER = 'itest_mc_checker';
const PW = 'MakerChecker#Test!2026';
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

const J_SELF = 'ITEST-MC-J-SELF';
// Tier A.2 corrective gate — a SECOND fixture for the sequential single-id
// path (/approve then /post), the one frontend/erp's usePostJournal() (and
// therefore the real "ترحيل"/"حفظ وترحيل" buttons) actually calls. The bulk
// scenario above already proved SoD on POST /gl/journals/bulk; this proves
// the SAME rule holds on the route the product UI drives, via the SAME
// lib/glTransitions.js functions — not a second, divergent implementation.
const J_SELF_SINGLE = 'ITEST-MC-J-SELF-SINGLE';
// Tier A.3 Release Gate item 2 — post() never checked self-approval at all:
// once a DIFFERENT user approved the creator's journal, the creator was
// free to POST it themselves. This fixture proves the fix: A creates, B
// (a genuinely different user) approves ONLY (not approve_post), then A
// attempts /post and must be denied — the creator is blocked from BOTH
// halves of the workflow, not just approve.
const J_SELF_POST = 'ITEST-MC-J-SELF-POST';
const J_SELF_POST_BULK = 'ITEST-MC-J-SELF-POST-BULK';
const SCAFFOLD_PARENT_ID = 'ITEST-MC-SCAFFOLD-PARENT';
const SCAFFOLD_CASH_ID = 'ITEST-MC-SCAFFOLD-CASH';
const SCAFFOLD_REV_ID = 'ITEST-MC-SCAFFOLD-REV';

async function cleanup() {
  for (const u of [MAKER, CHECKER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  for (const jid of [J_SELF, J_SELF_SINGLE, J_SELF_POST, J_SELF_POST_BULK]) {
    try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [jid]); } catch (_) {}
    try { await db.query('DELETE FROM gl_journals WHERE id = ?', [jid]); } catch (_) {}
  }
  for (const id of [SCAFFOLD_CASH_ID, SCAFFOLD_REV_ID, SCAFFOLD_PARENT_ID]) {
    try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [id]); } catch (_) {}
  }
}

async function ensureScaffoldAccounts() {
  // Isolated test DB has no pre-existing chart of accounts.
  await db.query(
    'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,NULL,1,1,1)',
    [SCAFFOLD_PARENT_ID, 'ITEST900040', 'مجلّد سقالة (ITEST)', 'asset']
  );
  await db.query(
    'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)',
    [SCAFFOLD_CASH_ID, 'ITEST900041', 'نقدية سقالة (ITEST)', 'asset', SCAFFOLD_PARENT_ID]
  );
  await db.query(
    'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)',
    [SCAFFOLD_REV_ID, 'ITEST900042', 'إيراد سقالة (ITEST)', 'revenue', SCAFFOLD_PARENT_ID]
  );
}

async function makeDraftJournal(id, journalNumber, createdBy) {
  await db.query(
    "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status, created_by) VALUES (?,?,?,?,?, 'draft', ?)",
    [id, journalNumber, '2026-06-10', 20, 20, createdBy]
  );
  await db.query(
    'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
    [id + '-E1', id, SCAFFOLD_CASH_ID, 20, id + '-E2', id, SCAFFOLD_REV_ID, 20]
  );
}

(async () => {
  let server = null;
  try {
    await harness.ensureSchema();
    await cleanup();
    console.log('\n═══ Journal maker/checker (segregation of duties), isolated test DB ═══');
    const hash = await bcrypt.hash(PW, 12);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MAKER, hash, 'finance']);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CHECKER, hash, 'finance']);
    await ensureScaffoldAccounts();

    server = await harness.spawnServer();
    const port = server.port;

    await makeDraftJournal(J_SELF, 'ITEST-MC-SELF', MAKER);

    const maker = await login(port, MAKER);
    const checker = await login(port, CHECKER);
    check('maker and checker authenticate', !!maker && !!checker);

    // ── self-approval blocked ──
    const selfResp = await call(port, 'POST', '/api/erp/gl/journals/bulk', maker, { ids: [J_SELF], action: 'approve_post' });
    check('bulk approve_post call succeeds at the HTTP level (per-id outcome reported inside)', selfResp.status === 200 && selfResp.body && selfResp.body.success, selfResp.body);
    const selfResult = selfResp.body && selfResp.body.results && selfResp.body.results[0];
    check('the creator approving their OWN journal is denied (reason=sod-self-approval-denied)', selfResult && selfResult.ok === false && selfResult.reason === 'sod-self-approval-denied', selfResult);
    const [[stillDraftSelf]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF]);
    check('the self-approval attempt did NOT change the journal\'s status', stillDraftSelf.status === 'draft', stillDraftSelf);

    // ── different user (checker) approving the SAME journal succeeds ──
    const otherResp = await call(port, 'POST', '/api/erp/gl/journals/bulk', checker, { ids: [J_SELF], action: 'approve_post' });
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

    // ── SAME scenario via the single-id sequential path (/approve then
    // /post) — the REAL UI flow (usePostJournal() calls /approve then
    // /post, never /bulk). Proves single-id/bulk parity: same denial code,
    // same audit action name, same eventual state, both funneling through
    // lib/glTransitions.js. ──
    await makeDraftJournal(J_SELF_SINGLE, 'ITEST-MC-SELF-SINGLE', MAKER);

    const selfApproveSingle = await call(port, 'POST', '/api/erp/gl/journals/' + J_SELF_SINGLE + '/approve', maker, {});
    check(
      'single-id /approve: creator self-approving is denied (200, success:false, code=sod-self-approval-denied)',
      selfApproveSingle.status === 200 && selfApproveSingle.body && selfApproveSingle.body.success === false && selfApproveSingle.body.code === 'sod-self-approval-denied',
      selfApproveSingle.body
    );
    const [[stillDraftSingle]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF_SINGLE]);
    check("single-id self-approval attempt did NOT change status", stillDraftSingle.status === 'draft', stillDraftSingle);

    const checkerApproveSingle = await call(port, 'POST', '/api/erp/gl/journals/' + J_SELF_SINGLE + '/approve', checker, {});
    check('single-id /approve: a DIFFERENT user (checker) approving succeeds', checkerApproveSingle.body && checkerApproveSingle.body.success === true, checkerApproveSingle.body);
    const [[approvedSingle]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF_SINGLE]);
    check("journal is approved after checker's single-id /approve", approvedSingle.status === 'approved', approvedSingle);

    const checkerPostSingle = await call(port, 'POST', '/api/erp/gl/journals/' + J_SELF_SINGLE + '/post', checker, {});
    check('single-id /post: checker posts → ok', checkerPostSingle.body && checkerPostSingle.body.success === true, checkerPostSingle.body);
    const [[postedSingle]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF_SINGLE]);
    check('journal is posted after sequential /approve then /post (matches usePostJournal())', postedSingle.status === 'posted', postedSingle);

    const [sodAuditSingle] = await db.query(
      "SELECT action, entity_id FROM audit_logs WHERE entity_id = ? AND action = 'approve_journal_denied_sod' ORDER BY created_at DESC LIMIT 3",
      [J_SELF_SINGLE]
    );
    check('single-id denial audit-logged under the SAME action name as bulk (approve_journal_denied_sod)', sodAuditSingle.length >= 1, sodAuditSingle);

    // ── Tier A.3 Release Gate item 2 — creator blocked from POSTING too,
    // even once a DIFFERENT user has already approved. A creates, B
    // approves (stops there — does NOT post), then A attempts /post and
    // must be denied; B (or any other authorized user) then posts
    // successfully. ──
    await makeDraftJournal(J_SELF_POST, 'ITEST-MC-SELF-POST', MAKER);

    const checkerApprovePost = await call(port, 'POST', '/api/erp/gl/journals/' + J_SELF_POST + '/approve', checker, {});
    check('setup: checker (different user) approves the maker\'s journal', checkerApprovePost.body && checkerApprovePost.body.success === true, checkerApprovePost.body);
    const [[approvedPost]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF_POST]);
    check('setup: journal is approved, not yet posted', approvedPost.status === 'approved', approvedPost);

    const makerPostAttempt = await call(port, 'POST', '/api/erp/gl/journals/' + J_SELF_POST + '/post', maker, {});
    check(
      'the ORIGINAL CREATOR attempting to /post their own (already-approved-by-someone-else) journal is denied with a real HTTP 403',
      makerPostAttempt.status === 403 && makerPostAttempt.body && makerPostAttempt.body.success === false && makerPostAttempt.body.code === 'sod-self-post-denied',
      makerPostAttempt.body
    );
    const [[stillApprovedPost]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF_POST]);
    check('the denied self-post attempt did NOT change the journal\'s status', stillApprovedPost.status === 'approved', stillApprovedPost);

    const checkerPostFinal = await call(port, 'POST', '/api/erp/gl/journals/' + J_SELF_POST + '/post', checker, {});
    check('the SAME different user (checker) who approved can also post — maker/checker policy satisfied, not a blanket lockout', checkerPostFinal.status === 200 && checkerPostFinal.body && checkerPostFinal.body.success === true, checkerPostFinal.body);
    const [[postedFinal]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF_POST]);
    check('journal is posted once a non-creator posts it', postedFinal.status === 'posted', postedFinal);

    const [sodAuditPost] = await db.query(
      "SELECT action, entity_id FROM audit_logs WHERE entity_id = ? AND action = 'post_journal_denied_sod' ORDER BY created_at DESC LIMIT 3",
      [J_SELF_POST]
    );
    check('the self-post denial was audit-logged as post_journal_denied_sod', sodAuditPost.length >= 1, sodAuditPost);

    // ── SAME scenario via POST /gl/journals/bulk, action='post' — proves
    // the fix holds "via Single or Bulk" (both paths funnel through the
    // SAME glTransitions.post(), not a second, divergent implementation). ──
    await makeDraftJournal(J_SELF_POST_BULK, 'ITEST-MC-SPOST-BLK', MAKER);
    const checkerApproveBulk = await call(port, 'POST', '/api/erp/gl/journals/' + J_SELF_POST_BULK + '/approve', checker, {});
    check('bulk setup: checker approves the maker\'s journal', checkerApproveBulk.body && checkerApproveBulk.body.success === true, checkerApproveBulk.body);

    const makerPostBulk = await call(port, 'POST', '/api/erp/gl/journals/bulk', maker, { ids: [J_SELF_POST_BULK], action: 'post' });
    const makerPostBulkResult = makerPostBulk.body && makerPostBulk.body.results && makerPostBulk.body.results[0];
    check(
      'bulk action=post: the ORIGINAL CREATOR posting their own (approved-by-someone-else) journal is denied (reason=sod-self-post-denied)',
      makerPostBulkResult && makerPostBulkResult.ok === false && makerPostBulkResult.reason === 'sod-self-post-denied',
      makerPostBulkResult
    );
    const [[stillApprovedBulk]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF_POST_BULK]);
    check('bulk denial did NOT change the journal\'s status', stillApprovedBulk.status === 'approved', stillApprovedBulk);

    const checkerPostBulk = await call(port, 'POST', '/api/erp/gl/journals/bulk', checker, { ids: [J_SELF_POST_BULK], action: 'post' });
    const checkerPostBulkResult = checkerPostBulk.body && checkerPostBulk.body.results && checkerPostBulk.body.results[0];
    check('bulk action=post: the same different user (checker) posts successfully', checkerPostBulkResult && checkerPostBulkResult.ok === true, checkerPostBulkResult);
    const [[postedBulk]] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [J_SELF_POST_BULK]);
    check('journal posted via bulk once a non-creator posts it', postedBulk.status === 'posted', postedBulk);

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
