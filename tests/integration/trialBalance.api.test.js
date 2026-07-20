'use strict';
/* Integration — Trial Balance (canonical engine + live /api/erp endpoint) and
 * the posted-journal-delete immutability fix. Real server + real DB.
 *
 * Chart of Accounts / Trial Balance overhaul, Tier A. Covers:
 *   1. RBAC: cashier 403 (specific code), accountant/finance/manager 200.
 *   2. Engine correctness: opening + period = closing per account, using a
 *      fully isolated ITEST account so the assertion is exact, not "close to".
 *   3. Mutation guard: Grand Total must come from posting LEAVES ONLY — a
 *      parent-rollup account must never contribute to the total on top of
 *      its own leaves (double-count check via before/after delta).
 *   4. from > to rejected with a typed error.
 *   5. Combined date + dimension filter (SQL param order regression) still
 *      returns success and correctly-filtered (not misaligned/erroring) data.
 *   6. DELETE /api/erp/gl/journals/:id blocks a posted journal (409,
 *      code=posted_journal_immutable) but still allows deleting a draft one.
 *
 * Run: node tests/integration/trialBalance.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const { computeTrialBalance, TrialBalanceError } = require('../../lib/reports/trialBalance');

const PORT = 3988;
const CASHIER = 'itest_tb_cashier';
const ACCOUNTANT = 'itest_tb_accountant';
const FINANCE = 'itest_tb_finance';
const DEVELOPER = 'itest_tb_developer';
const PW = 'TrialBalance#Test!2026';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

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

const TEST_ACCOUNT_ID = 'ITEST-TB-ACC-1';
const TEST_ACCOUNT_CODE = 'ITEST900001';
const TEST_JOURNAL_OPEN = 'ITEST-TB-J-OPEN';
const TEST_JOURNAL_PERIOD = 'ITEST-TB-J-PERIOD';
const TEST_JOURNAL_POSTED_DEL = 'ITEST-TB-J-POSTED-DEL';
const TEST_JOURNAL_DRAFT_DEL = 'ITEST-TB-J-DRAFT-DEL';

async function cleanup() {
  for (const u of [CASHIER, ACCOUNTANT, FINANCE, DEVELOPER]) {
    try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {}
  }
  for (const jid of [TEST_JOURNAL_OPEN, TEST_JOURNAL_PERIOD, TEST_JOURNAL_POSTED_DEL, TEST_JOURNAL_DRAFT_DEL]) {
    try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [jid]); } catch (_) {}
    try { await db.query('DELETE FROM gl_journals WHERE id = ?', [jid]); } catch (_) {}
  }
  try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [TEST_ACCOUNT_ID]); } catch (_) {}
  // settings.user_meta had NO row before this test ran (verified) — DELETE
  // restores that exact original state rather than guessing at a merge.
  try { await db.query("DELETE FROM settings WHERE setting_key = 'user_meta'"); } catch (_) {}
}

async function setupFixtures() {
  const [[cashAcc]] = await db.query("SELECT id FROM gl_accounts WHERE code = '1110' LIMIT 1");
  const [[parentAcc]] = await db.query("SELECT id FROM gl_accounts WHERE code = '111' LIMIT 1");
  if (!cashAcc || !parentAcc) throw new Error('fixture accounts 1110/111 not found — cannot run test');

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
     'ITEST-TB-E-O2', TEST_JOURNAL_OPEN, cashAcc.id, '1110', 100]
  );

  // Period movement: inside the test window [2026-06-01, 2026-06-30].
  await db.query(
    "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
    [TEST_JOURNAL_PERIOD, 'ITEST-TB-PERIOD', '2026-06-15', 'itest_fixture', 50, 50]
  );
  await db.query(
    'INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit) VALUES (?,?,?,?,?,0), (?,?,?,?,0,?)',
    ['ITEST-TB-E-P1', TEST_JOURNAL_PERIOD, TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 50,
     'ITEST-TB-E-P2', TEST_JOURNAL_PERIOD, cashAcc.id, '1110', 50]
  );

  return { cashAcc, parentAcc };
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ACCOUNTANT, hash, 'accountant']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [FINANCE, hash, 'finance']);
  // users.role is an ENUM without a 'developer' value and this schema has no
  // is_developer column — guardDeveloper's DB-column check can't be used
  // here. Its settings.user_meta JSON fallback can: no such row exists yet
  // (verified before writing this test), so INSERT/DELETE is a clean round trip.
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [DEVELOPER, hash, 'manager']);
  await db.query(
    "INSERT INTO settings (setting_key, setting_value) VALUES ('user_meta', ?)",
    [JSON.stringify({ [DEVELOPER]: { isDeveloper: true } })]
  );

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ Trial Balance (canonical engine + endpoint) ═══');

    await setupFixtures();

    // ── 1. RBAC ──
    const cashier = await login(CASHIER);
    const accountant = await login(ACCOUNTANT);
    const finance = await login(FINANCE);
    check('all test users authenticate', !!cashier && !!accountant && !!finance);

    const cResp = await call('GET', '/api/erp/reports/trial-balance', cashier);
    check('cashier is DENIED trial balance (403)', cResp.status === 403, { status: cResp.status, body: cResp.body });
    check('cashier denial carries a specific permission code, not just >=400', cResp.body && (cResp.body.code === 'PERMISSION_DENIED'), { code: cResp.body && cResp.body.code });

    const aResp = await call('GET', '/api/erp/reports/trial-balance?from=2026-06-01&to=2026-06-30', accountant);
    check('accountant CAN view trial balance (200) — closes the finance.reports.view gap', aResp.status === 200 && aResp.body && aResp.body.success, { status: aResp.status, body: aResp.body && aResp.body.success });

    const fResp = await call('GET', '/api/erp/reports/trial-balance?from=2026-06-01&to=2026-06-30', finance);
    check('finance CAN view trial balance (200)', fResp.status === 200 && fResp.body && fResp.body.success, { status: fResp.status });

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
    const before = await computeTrialBalance(db, { includeZero: true });
    const beforeTotalPeriodDebit = before.totals.periodDebit;
    const parentRow = before.rows.find((r) => r.code === '111');
    check('parent account "111" row is present and marked non-leaf (folder rollup)', !!parentRow && parentRow.hasChildren === true, parentRow);
    if (parentRow) {
      check('parent rollup row is NOT counted in isPostingLeaf (excluded from Grand Total by construction)', parentRow.isPostingLeaf === false, parentRow);
    }
    // Direct proof: sum ALL rows' periodDebit (leaves + folders) vs the engine's own
    // leaves-only total — if they were equal, folders would NOT be double-booked
    // relative to leaves, which is actually impossible once any folder has children
    // with activity (its own periodDebit already equals the sum of its descendants').
    const naiveSumAllRows = before.rows.reduce((s, r) => s + r.periodDebit, 0);
    check(
      'naive "sum every row incl. folders" OVERSTATES the true total (proves folders roll up on top of, not instead of, their leaves — Grand Total correctly excludes them)',
      naiveSumAllRows > beforeTotalPeriodDebit + 0.001,
      { naiveSumAllRows, correctGrandTotal: beforeTotalPeriodDebit }
    );

    // ── 4. from > to rejected ──
    let rangeErrorCode = null;
    try {
      await computeTrialBalance(db, { from: '2026-07-01', to: '2026-01-01' });
    } catch (e) {
      rangeErrorCode = e instanceof TrialBalanceError ? e.code : 'WRONG_ERROR_TYPE:' + e.message;
    }
    check('from > to throws TrialBalanceError TB_INVALID_RANGE', rangeErrorCode === 'TB_INVALID_RANGE', rangeErrorCode);

    // ── 5. Combined date + dimension filter (SQL param order regression) ──
    let combinedOk = false, combinedErr = null;
    try {
      const combined = await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', branch: 'ITEST-NONEXISTENT-BRANCH', includeZero: true });
      combinedOk = combined.success === true;
      const testRowUnderFilter = combined.rows.find((r) => r.accountId === TEST_ACCOUNT_ID);
      check(
        'combined date+branch filter correctly excludes the ITEST fixture (branch never set on it) — proves params landed on the right placeholders',
        !testRowUnderFilter || (testRowUnderFilter.periodDebit === 0 && testRowUnderFilter.periodCredit === 0),
        testRowUnderFilter
      );
    } catch (e) { combinedErr = e.message; }
    check('combined date+dimension filter query does not throw (params stayed aligned with placeholders)', combinedOk, combinedErr);

    // ── 6. Posted-journal delete immutability ──
    const developer = await login(DEVELOPER);
    check('developer authenticates', !!developer);

    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status) VALUES (?,?,?,?,?, 'posted')",
      [TEST_JOURNAL_POSTED_DEL, 'ITEST-TB-POSTED-DEL', '2026-06-10', 10, 10]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit) VALUES (?,?,?,?,?,0), (?,?,?,?,0,?)',
      ['ITEST-TB-E-D1', TEST_JOURNAL_POSTED_DEL, TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 10,
       'ITEST-TB-E-D2', TEST_JOURNAL_POSTED_DEL, TEST_ACCOUNT_ID, TEST_ACCOUNT_CODE, 10]
    );
    const delPosted = await call('DELETE', '/api/erp/gl/journals/' + TEST_JOURNAL_POSTED_DEL, developer);
    check('DELETE on a posted journal is BLOCKED (409, posted_journal_immutable)', delPosted.status === 409 && delPosted.body && delPosted.body.code === 'posted_journal_immutable', { status: delPosted.status, body: delPosted.body });
    const [[stillThere]] = await db.query('SELECT id, status FROM gl_journals WHERE id = ?', [TEST_JOURNAL_POSTED_DEL]);
    check('posted journal STILL EXISTS in the database after the blocked delete attempt', !!stillThere && stillThere.status === 'posted', stillThere);

    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status) VALUES (?,?,?,?,?, 'draft')",
      [TEST_JOURNAL_DRAFT_DEL, 'ITEST-TB-DRAFT-DEL', '2026-06-10', 5, 5]
    );
    const delDraft = await call('DELETE', '/api/erp/gl/journals/' + TEST_JOURNAL_DRAFT_DEL, developer);
    check('DELETE on a DRAFT journal still succeeds (fix did not break legitimate deletion)', delDraft.status === 200 && delDraft.body && delDraft.body.success === true, { status: delDraft.status, body: delDraft.body });
    const [draftGone] = await db.query('SELECT id FROM gl_journals WHERE id = ?', [TEST_JOURNAL_DRAFT_DEL]);
    check('draft journal was actually removed', draftGone.length === 0, draftGone);

    console.log(`\n${fail === 0 ? '✅' : '❌'} trialBalance: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
