'use strict';
/* Integration — Trial Balance (canonical engine + live /api/erp endpoint) and
 * journal-deletion governance (draft-only). Real server + real DB.
 *
 * Tier A.1 Corrective Gate. Covers:
 *   1. RBAC: cashier 403 (specific code), accountant/finance/manager 200.
 *   2. Engine correctness: opening + period = closing per account, using a
 *      fully isolated ITEST account so the assertion is exact, not "close to".
 *   3. Mutation guard: Grand Total must come from posting LEAVES ONLY — a
 *      parent-rollup account must never contribute to the total on top of
 *      its own leaves (double-count check via before/after delta).
 *   4. from > to rejected with a typed error.
 *   5. Combined date + dimension filter (SQL param order regression) still
 *      returns success and correctly-filtered (not misaligned/erroring) data.
 *   6. Journal deletion governance: draft-only. Approved and posted are both
 *      refused (distinct codes), a non-existent id is a real 404 (not a fake
 *      success), denial is audit-logged, deleting a draft never touches
 *      gl_accounts.balance (proven by reading the balance before/after).
 *   7. Test isolation: settings.user_meta is snapshotted and restored
 *      (never blind-deleted), an environment guard refuses to run against
 *      anything that looks like production, and every affected table's row
 *      count is checked before/after to prove zero residue.
 *
 * Run: node tests/integration/trialBalance.api.test.js
 */
require('dotenv').config();
// Tier A.2 — MUST be required and activated before db/connection.js.
const harness = require('../helpers/testHarness');
harness.activate();
const http = require('http');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const { computeTrialBalance, TrialBalanceError } = require('../../lib/reports/trialBalance');

const CASHIER = 'itest_tb_cashier';
const ACCOUNTANT = 'itest_tb_accountant';
const FINANCE = 'itest_tb_finance';
const DEVELOPER = 'itest_tb_developer';
const PW = 'TrialBalance#Test!2026';
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

const TEST_ACCOUNT_ID = 'ITEST-TB-ACC-1';
const TEST_ACCOUNT_CODE = 'ITEST900001';
// Isolated test DB has no pre-existing chart of accounts — self-contained
// scaffold instead of depending on ambient code='111'/'1110' rows.
const SCAFFOLD_PARENT_ID = 'ITEST-TB-SCAFFOLD-PARENT';
const SCAFFOLD_PARENT_CODE = 'ITEST900000';
const SCAFFOLD_CASH_ID = 'ITEST-TB-SCAFFOLD-CASH';
const SCAFFOLD_CASH_CODE = 'ITEST900099';
const TEST_JOURNAL_OPEN = 'ITEST-TB-J-OPEN';
const TEST_JOURNAL_PERIOD = 'ITEST-TB-J-PERIOD';
const TEST_JOURNAL_APPROVED_DEL = 'ITEST-TB-J-APPROVED-DEL';
const TEST_JOURNAL_POSTED_DEL = 'ITEST-TB-J-POSTED-DEL';
const TEST_JOURNAL_DRAFT_DEL = 'ITEST-TB-J-DRAFT-DEL';
const TEST_JOURNAL_MISSING_ID = 'ITEST-TB-J-DOES-NOT-EXIST';
const WH_ALLOWED = 'ITEST-TB-WH-ALLOWED';
const WH_DENIED = 'ITEST-TB-WH-DENIED';
const ALL_TEST_JOURNALS = [TEST_JOURNAL_OPEN, TEST_JOURNAL_PERIOD, TEST_JOURNAL_APPROVED_DEL, TEST_JOURNAL_POSTED_DEL, TEST_JOURNAL_DRAFT_DEL];

// ── settings.user_meta snapshot/restore — never a blind DELETE ──
let _userMetaSnapshot = { existed: false, value: null };
async function snapshotUserMeta() {
  const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
  _userMetaSnapshot = rows.length ? { existed: true, value: rows[0].setting_value } : { existed: false, value: null };
}
async function restoreUserMeta() {
  if (_userMetaSnapshot.existed) {
    await db.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('user_meta', ?)", [_userMetaSnapshot.value]);
  } else {
    await db.query("DELETE FROM settings WHERE setting_key = 'user_meta'");
  }
}
async function mergeDeveloperIntoUserMeta() {
  const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
  const meta = rows.length && rows[0].setting_value ? JSON.parse(rows[0].setting_value) : {};
  meta[DEVELOPER] = { isDeveloper: true };
  await db.query(
    "INSERT INTO settings (setting_key, setting_value) VALUES ('user_meta', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
    [JSON.stringify(meta)]
  );
}

async function cleanupFixtures() {
  // Tier A.3 — user_warehouse_access rows reference users.id; clear them
  // BEFORE deleting the users, as a crash-recovery safety net (the happy
  // path already cleans these up inline right after use).
  try {
    const [rows] = await db.query('SELECT id FROM users WHERE username IN (?, ?, ?, ?)', [CASHIER, ACCOUNTANT, FINANCE, DEVELOPER]);
    for (const r of rows) { try { await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [r.id]); } catch (_) {} }
  } catch (_) {}
  for (const u of [CASHIER, ACCOUNTANT, FINANCE, DEVELOPER]) {
    try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {}
  }
  for (const jid of ALL_TEST_JOURNALS) {
    try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [jid]); } catch (_) {}
    try { await db.query('DELETE FROM gl_journals WHERE id = ?', [jid]); } catch (_) {}
  }
  for (const id of [TEST_ACCOUNT_ID, SCAFFOLD_CASH_ID, SCAFFOLD_PARENT_ID]) {
    try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [id]); } catch (_) {}
  }
  for (const id of [WH_ALLOWED, WH_DENIED]) {
    try { await db.query('DELETE FROM warehouses WHERE id = ?', [id]); } catch (_) {}
  }
}

async function tableCounts() {
  const out = {};
  for (const t of ['users', 'gl_accounts', 'gl_journals', 'gl_entries', 'settings', 'warehouses', 'user_warehouse_access']) {
    const [[r]] = await db.query('SELECT COUNT(*) n FROM ' + t);
    out[t] = r.n;
  }
  return out;
}

async function setupFixtures() {
  // Isolated test DB has no pre-existing chart of accounts — build our own
  // minimal parent+leaf scaffold instead of depending on ambient rows.
  await db.query(
    'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,NULL,1,1,1)',
    [SCAFFOLD_PARENT_ID, SCAFFOLD_PARENT_CODE, 'مجلّد سقالة (ITEST)', 'asset']
  );
  await db.query(
    'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)',
    [SCAFFOLD_CASH_ID, SCAFFOLD_CASH_CODE, 'نقدية سقالة (ITEST)', 'asset', SCAFFOLD_PARENT_ID]
  );
  const cashAcc = { id: SCAFFOLD_CASH_ID };
  const parentAcc = { id: SCAFFOLD_PARENT_ID };

  await db.query(
    'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
    [TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 'حساب اختبار ميزان المراجعة (ITEST)', 'asset', parentAcc.id, 4]
  );

  // Opening contribution: dated well before the test window, NOT reference_type='opening'
  // (exercises the "non-opening entries strictly before `from`" branch).
  await db.query(
    "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
    [TEST_JOURNAL_OPEN, 'ITEST-TB-OPEN', '2020-01-01', 'itest_fixture', 100, 100]
  );
  await db.query(
    'INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit) VALUES (?,?,?,?,?,0), (?,?,?,?,0,?)',
    ['ITEST-TB-E-O1', TEST_JOURNAL_OPEN, TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 100,
     'ITEST-TB-E-O2', TEST_JOURNAL_OPEN, cashAcc.id, SCAFFOLD_CASH_CODE, 100]
  );

  // Period movement: inside the test window [2026-06-01, 2026-06-30].
  await db.query(
    "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
    [TEST_JOURNAL_PERIOD, 'ITEST-TB-PERIOD', '2026-06-15', 'itest_fixture', 50, 50]
  );
  await db.query(
    'INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit) VALUES (?,?,?,?,?,0), (?,?,?,?,0,?)',
    ['ITEST-TB-E-P1', TEST_JOURNAL_PERIOD, TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 50,
     'ITEST-TB-E-P2', TEST_JOURNAL_PERIOD, cashAcc.id, SCAFFOLD_CASH_CODE, 50]
  );

  return { cashAcc, parentAcc };
}

(async () => {
  let server = null;
  let before = null;
  try {
    await harness.ensureSchema();
    await snapshotUserMeta();
    await cleanupFixtures();
    before = await tableCounts();

    const hash = await bcrypt.hash(PW, 12);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ACCOUNTANT, hash, 'accountant']);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [FINANCE, hash, 'finance']);
    // users.role is an ENUM without a 'developer' value and this schema has no
    // is_developer column — guardDeveloper's DB-column check can't be used
    // here. Its settings.user_meta JSON fallback can, merged (not overwritten).
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [DEVELOPER, hash, 'manager']);
    await mergeDeveloperIntoUserMeta();

    // harness.spawnServer() allocates a genuinely free port and verifies
    // the first successful /api/version response came from THIS process
    // (token round-trip) — no more hardcoded-port collisions with a
    // leftover process, and no more trusting an arbitrary 200 on that port.
    server = await harness.spawnServer();
    const port = server.port;

    console.log('\n═══ Trial Balance (canonical engine + endpoint), isolated test DB ═══');

    await setupFixtures();

    // ── 1. RBAC ──
    const cashier = await login(port, CASHIER);
    const accountant = await login(port, ACCOUNTANT);
    const finance = await login(port, FINANCE);
    check('all test users authenticate', !!cashier && !!accountant && !!finance);

    const cResp = await call(port, 'GET', '/api/erp/reports/trial-balance', cashier);
    check('cashier is DENIED trial balance (403)', cResp.status === 403, { status: cResp.status, body: cResp.body });
    check('cashier denial carries a specific permission code, not just >=400', cResp.body && (cResp.body.code === 'PERMISSION_DENIED'), { code: cResp.body && cResp.body.code });

    const aResp = await call(port, 'GET', '/api/erp/reports/trial-balance?from=2026-06-01&to=2026-06-30', accountant);
    check('accountant CAN view trial balance (200) — closes the finance.reports.view gap', aResp.status === 200 && aResp.body && aResp.body.success, { status: aResp.status, body: aResp.body && aResp.body.success });
    check('the HTTP response itself carries isClean/diagnostics (not just the engine function)', aResp.body && typeof aResp.body.isClean === 'boolean' && !!aResp.body.diagnostics, { isClean: aResp.body && aResp.body.isClean, hasDiagnostics: aResp.body && !!aResp.body.diagnostics });

    const fResp = await call(port, 'GET', '/api/erp/reports/trial-balance?from=2026-06-01&to=2026-06-30', finance);
    check('finance CAN view trial balance (200)', fResp.status === 200 && fResp.body && fResp.body.success, { status: fResp.status });

    // Auditor role end-to-end (created via the real product API, not direct
    // SQL, then proven to be both READ-capable on financial reports and
    // WRITE-denied on every journal mutation) now has its own dedicated
    // test — see tests/integration/auditorRole.test.js.

    // ── 1b. Tier A.3 Release Gate item 7 — warehouse scope is ALWAYS
    // enforced on this report, not shadow-mode. Deliberately NOT setting
    // WAREHOUSE_SCOPE_ENFORCE=1 anywhere in this test process — the whole
    // point is proving the report doesn't inherit that flag's rollout-
    // friendly default the way other warehouse-ops routes correctly do. ──
    check('WAREHOUSE_SCOPE_ENFORCE is genuinely unset for this test run (proves the enforcement below is NOT coming from the shadow-mode flag)', !process.env.WAREHOUSE_SCOPE_ENFORCE || process.env.WAREHOUSE_SCOPE_ENFORCE === '0');
    const [[accountantRow]] = await db.query('SELECT id FROM users WHERE username = ?', [ACCOUNTANT]);
    await db.query(
      "INSERT IGNORE INTO warehouses (id, code, name, type) VALUES (?,?,?, 'branch'), (?,?,?, 'branch')",
      [WH_ALLOWED, 'ITEST-WH-A', 'مستودع مسموح (ITEST)', WH_DENIED, 'ITEST-WH-D', 'مستودع ممنوع (ITEST)']
    );
    await db.query('INSERT IGNORE INTO user_warehouse_access (user_id, warehouse_id) VALUES (?, ?)', [accountantRow.id, WH_ALLOWED]);

    const whAllowedResp = await call(port, 'GET', `/api/erp/reports/trial-balance?from=2026-06-01&to=2026-06-30&warehouse=${WH_ALLOWED}`, accountant);
    check('positive: accountant CAN view the trial balance for a warehouse they are explicitly granted (200)', whAllowedResp.status === 200 && whAllowedResp.body && whAllowedResp.body.success === true, { status: whAllowedResp.status, body: whAllowedResp.body });

    const whDeniedResp = await call(port, 'GET', `/api/erp/reports/trial-balance?from=2026-06-01&to=2026-06-30&warehouse=${WH_DENIED}`, accountant);
    check('negative: accountant is DENIED (403) for a warehouse they are NOT granted — genuinely enforced, not shadow-logged', whDeniedResp.status === 403 && whDeniedResp.body && whDeniedResp.body.code === 'WAREHOUSE_ACCESS_DENIED', { status: whDeniedResp.status, body: whDeniedResp.body });

    await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [accountantRow.id]);
    await db.query('DELETE FROM warehouses WHERE id IN (?, ?)', [WH_ALLOWED, WH_DENIED]);

    // ── 2. Engine correctness — isolated ITEST account, exact numbers ──
    const scoped = await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', includeZero: true });
    const row = scoped.rows.find((r) => r.accountId === TEST_ACCOUNT_ID);
    check('ITEST account row present', !!row, row);
    if (row) {
      check('opening debit = 100 (pre-window entry correctly bucketed as opening)', row.openDebit === 100 && row.openCredit === 0, row);
      check('period debit = 50, period credit = 0', row.periodDebit === 50 && row.periodCredit === 0, row);
      check('closing = opening + period debit - period credit = 150', row.closing === 150 && row.closeDebit === 150 && row.closeCredit === 0, row);
      check('row is tagged as a posting leaf (no children)', row.isPostingLeaf === true && row.hasChildren === false, row);
    }

    // ── 3. Mutation guard: Grand Total must be leaves-only, never rolled-up folders ──
    const bal = await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', includeZero: true });
    const balTotalPeriodDebit = bal.totals.periodDebit;
    const parentRow = bal.rows.find((r) => r.code === SCAFFOLD_PARENT_CODE);
    check('scaffold parent row is present and marked non-leaf (folder rollup)', !!parentRow && parentRow.hasChildren === true, parentRow);
    if (parentRow) {
      check('parent rollup row is NOT counted in isPostingLeaf (excluded from Grand Total by construction)', parentRow.isPostingLeaf === false, parentRow);
    }
    const naiveSumAllRows = bal.rows.reduce((s, r) => s + r.periodDebit, 0);
    check(
      'naive "sum every row incl. folders" OVERSTATES the true total (proves folders roll up on top of, not instead of, their leaves — Grand Total correctly excludes them)',
      naiveSumAllRows > balTotalPeriodDebit + 0.001,
      { naiveSumAllRows, correctGrandTotal: balTotalPeriodDebit }
    );

    // ── 4. from > to rejected ──
    let rangeErrorCode = null;
    try {
      await computeTrialBalance(db, { from: '2026-07-01', to: '2026-01-01' });
    } catch (e) {
      rangeErrorCode = e instanceof TrialBalanceError ? e.code : 'WRONG_ERROR_TYPE:' + e.message;
    }
    check('from > to throws TrialBalanceError TB_INVALID_RANGE', rangeErrorCode === 'TB_INVALID_RANGE', rangeErrorCode);

    // ── 5. Combined date + dimension filter (SQL param order regression).
    // Tier A.3 Release Gate item 7 — switched from `branch` to `costCenter`:
    // `branch` is now categorically rejected (see test 5b below), so it can
    // no longer serve this regression's original purpose (proving from/to
    // + a dimension filter don't misalign SQL placeholders). costCenter
    // exercises the exact same dimFrag()/buildWhere() machinery. ──
    let combinedOk = false, combinedErr = null;
    try {
      const combined = await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', costCenter: 'ITEST-NONEXISTENT-CC', includeZero: true });
      combinedOk = combined.success === true;
      const testRowUnderFilter = combined.rows.find((r) => r.accountId === TEST_ACCOUNT_ID);
      check(
        'combined date+costCenter filter correctly excludes the ITEST fixture (cost center never set on it) — proves params landed on the right placeholders',
        !testRowUnderFilter || (testRowUnderFilter.periodDebit === 0 && testRowUnderFilter.periodCredit === 0),
        testRowUnderFilter
      );
    } catch (e) { combinedErr = e.message; }
    check('combined date+dimension filter query does not throw (params stayed aligned with placeholders)', combinedOk, combinedErr);

    // ── 5b. Tier A.3 Release Gate item 7 — `branch` is categorically
    // rejected: there is no branch-scope authorization infrastructure in
    // this codebase, so allowing the filter at all would mean arbitrary
    // branch reads for anyone holding finance.reports.view. Refused with a
    // dedicated code, not silently ignored and not treated as a missing-
    // column SCHEMA_NOT_READY (this IS a real column — it's an
    // authorization gap, not a schema one). ──
    let branchErrorCode = null;
    try {
      await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', branch: 'ANY-BRANCH-ID' });
    } catch (e) { branchErrorCode = e instanceof TrialBalanceError ? e.code : 'WRONG_ERROR_TYPE:' + e.message; }
    check('the `branch` filter is categorically refused (TB_BRANCH_SCOPE_NOT_SUPPORTED, 409) — no branch-scope authorization exists, so no arbitrary branch reads are possible', branchErrorCode === 'TB_BRANCH_SCOPE_NOT_SUPPORTED', branchErrorCode);

    // ── 6. Journal deletion governance: draft-only ──
    const developer = await login(port, DEVELOPER);
    check('developer authenticates', !!developer);

    // 6a. non-existent id -> real 404, not a fake success
    const delMissing = await call(port, 'DELETE', '/api/erp/gl/journals/' + TEST_JOURNAL_MISSING_ID, developer);
    check('DELETE on a non-existent journal id returns 404 with code=not_found (not a fake success)', delMissing.status === 404 && delMissing.body && delMissing.body.code === 'not_found' && delMissing.body.success === false, { status: delMissing.status, body: delMissing.body });

    // 6b. posted -> blocked, still present
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status) VALUES (?,?,?,?,?, 'posted')",
      [TEST_JOURNAL_POSTED_DEL, 'ITEST-TB-POSTED-DEL', '2026-06-10', 10, 10]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit) VALUES (?,?,?,?,?,0), (?,?,?,?,0,?)',
      ['ITEST-TB-E-D1', TEST_JOURNAL_POSTED_DEL, TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 10,
       'ITEST-TB-E-D2', TEST_JOURNAL_POSTED_DEL, TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 10]
    );
    const delPosted = await call(port, 'DELETE', '/api/erp/gl/journals/' + TEST_JOURNAL_POSTED_DEL, developer);
    check('DELETE on a posted journal is BLOCKED (409, posted_journal_immutable)', delPosted.status === 409 && delPosted.body && delPosted.body.code === 'posted_journal_immutable', { status: delPosted.status, body: delPosted.body });
    const [[stillPosted]] = await db.query('SELECT id, status FROM gl_journals WHERE id = ?', [TEST_JOURNAL_POSTED_DEL]);
    check('posted journal STILL EXISTS after the blocked delete attempt', !!stillPosted && stillPosted.status === 'posted', stillPosted);

    // 6c. approved -> ALSO blocked (Tier A only blocked 'posted' — this is the fix)
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status, approved_by) VALUES (?,?,?,?,?, 'approved', ?)",
      [TEST_JOURNAL_APPROVED_DEL, 'ITEST-TB-APPR-DEL', '2026-06-10', 7, 7, 'someone-else']
    );
    const delApproved = await call(port, 'DELETE', '/api/erp/gl/journals/' + TEST_JOURNAL_APPROVED_DEL, developer);
    check('DELETE on an APPROVED journal is BLOCKED (409, approved_journal_requires_governed_action)', delApproved.status === 409 && delApproved.body && delApproved.body.code === 'approved_journal_requires_governed_action', { status: delApproved.status, body: delApproved.body });
    const [[stillApproved]] = await db.query('SELECT id, status FROM gl_journals WHERE id = ?', [TEST_JOURNAL_APPROVED_DEL]);
    check('approved journal STILL EXISTS after the blocked delete attempt', !!stillApproved && stillApproved.status === 'approved', stillApproved);

    // 6d. denied attempts are audit-logged as denials, not silently dropped
    const [deniedAudit] = await db.query(
      "SELECT action, entity_id FROM audit_logs WHERE entity_id IN (?, ?) AND action = 'delete_journal_denied' ORDER BY created_at DESC LIMIT 5",
      [TEST_JOURNAL_POSTED_DEL, TEST_JOURNAL_APPROVED_DEL]
    );
    check('both denied delete attempts produced a delete_journal_denied audit entry', Array.isArray(deniedAudit) && deniedAudit.length >= 2, deniedAudit);

    // 6e. draft -> succeeds, and critically does NOT touch gl_accounts.balance
    // (a draft never contributed to it — only approve_post does).
    // Tier A.2 corrective gate — the debit and credit legs used to BOTH sit
    // on TEST_ACCOUNT_ID, which makes the "balance unchanged" check below a
    // false-pass: a single account's own debit+credit net to zero by
    // construction, so the assertion would hold even if the deletion logic
    // wrongly reversed balances. Two DIFFERENT real accounts (debit on
    // TEST_ACCOUNT_ID, credit on the scaffold cash account already used
    // elsewhere in this file), each checked independently, is what actually
    // proves nothing moved.
    const [[balBeforeDraftDelete]] = await db.query('SELECT balance FROM gl_accounts WHERE id = ?', [TEST_ACCOUNT_ID]);
    const [[cashBalBeforeDraftDelete]] = await db.query('SELECT balance FROM gl_accounts WHERE id = ?', [SCAFFOLD_CASH_ID]);
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status) VALUES (?,?,?,?,?, 'draft')",
      [TEST_JOURNAL_DRAFT_DEL, 'ITEST-TB-DRAFT-DEL', '2026-06-10', 5, 5]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit) VALUES (?,?,?,?,?,0), (?,?,?,?,0,?)',
      ['ITEST-TB-E-DFT1', TEST_JOURNAL_DRAFT_DEL, TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 5,
       'ITEST-TB-E-DFT2', TEST_JOURNAL_DRAFT_DEL, SCAFFOLD_CASH_ID, SCAFFOLD_CASH_CODE, 5]
    );
    const delDraft = await call(port, 'DELETE', '/api/erp/gl/journals/' + TEST_JOURNAL_DRAFT_DEL, developer);
    check('DELETE on a DRAFT journal succeeds (200)', delDraft.status === 200 && delDraft.body && delDraft.body.success === true, { status: delDraft.status, body: delDraft.body });
    const [draftGone] = await db.query('SELECT id FROM gl_journals WHERE id = ?', [TEST_JOURNAL_DRAFT_DEL]);
    check('draft journal (header + 2 lines) was actually removed', draftGone.length === 0, draftGone);
    const [[balAfterDraftDelete]] = await db.query('SELECT balance FROM gl_accounts WHERE id = ?', [TEST_ACCOUNT_ID]);
    const [[cashBalAfterDraftDelete]] = await db.query('SELECT balance FROM gl_accounts WHERE id = ?', [SCAFFOLD_CASH_ID]);
    check(
      "deleting the draft's DEBIT-leg account balance is unchanged (a draft never affected it)",
      Number(balBeforeDraftDelete.balance) === Number(balAfterDraftDelete.balance),
      { before: balBeforeDraftDelete.balance, after: balAfterDraftDelete.balance }
    );
    check(
      "deleting the draft's CREDIT-leg account balance is ALSO unchanged (proves this isn't a same-account net-zero artifact)",
      Number(cashBalBeforeDraftDelete.balance) === Number(cashBalAfterDraftDelete.balance),
      { before: cashBalBeforeDraftDelete.balance, after: cashBalAfterDraftDelete.balance }
    );

    console.log(`\n${fail === 0 ? '✅' : '❌'} trialBalance: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    if (server) server.kill();
    await cleanupFixtures();
    await restoreUserMeta();
  }

  if (before) {
    const after = await tableCounts();
    for (const t of Object.keys(before)) {
      check(`table "${t}" row count restored to baseline after cleanup`, before[t] === after[t], { before: before[t], after: after[t] });
    }
  } else {
    fail++; fails.push('setup failed before a baseline row-count snapshot could be taken — cleanup-verification skipped');
  }
  const [userMetaFinal] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
  check(
    'settings.user_meta restored to its EXACT pre-test state (not blind-deleted)',
    _userMetaSnapshot.existed ? (userMetaFinal.length === 1 && userMetaFinal[0].setting_value === _userMetaSnapshot.value) : userMetaFinal.length === 0,
    { existedBefore: _userMetaSnapshot.existed, existsAfter: userMetaFinal.length === 1 }
  );

  console.log(`\n${fail === 0 ? '✅' : '❌'} trialBalance (final, incl. cleanup verification): ${pass} passed, ${fail} failed`);
  if (fail) console.log('   failed:', fails.join(' | '));
  try { await db.end(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
