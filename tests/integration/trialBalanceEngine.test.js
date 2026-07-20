'use strict';
/* Integration — Trial Balance ENGINE correctness (lib/reports/trialBalance.js),
 * called directly (no HTTP server needed — real DB only).
 *
 * Tier A.1 Corrective Gate — every case here reproduces a bug an independent
 * review found in the Tier A engine, proves the fix, and (where practical)
 * proves what WOULD have failed under the old behavior.
 *
 * Run: node tests/integration/trialBalanceEngine.test.js
 */
require('dotenv').config();
// Tier A.2 — MUST be required and activated before db/connection.js, so the
// shared pool binds to the isolated *_test database from its first connection
// (never the real moroccan_taste_pos dev DB). See tests/helpers/testHarness.js.
const harness = require('../helpers/testHarness');
harness.activate();
const db = require('../../db/connection');
const { computeTrialBalance, TrialBalanceError, resetDimColsCache } = require('../../lib/reports/trialBalance');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); } }

const IDS = {
  // Self-contained scaffold — the isolated test DB has no pre-existing
  // chart of accounts (ensureCoreAccounts() only creates the ~28 LEAF
  // CORE_ACCOUNTS, never their parent codes like '111' — see the comment
  // at this file's IIFE start), so this file no longer depends on any
  // ambient/pre-seeded account existing. scaffoldParent stands in for
  // "some folder to attach ITEST accounts under"; scaffoldCash stands in
  // for "some other real posting-leaf account to balance a journal against".
  scaffoldParent: 'ITEST-TBE-SCAFFOLD-PARENT',
  scaffoldCash: 'ITEST-TBE-SCAFFOLD-CASH',
  childlessFolder: 'ITEST-TBE-CHILDLESS-FOLDER',
  parentWithActivity: 'ITEST-TBE-PARENT-ACTIVE',
  parentWithActivityChild: 'ITEST-TBE-PARENT-ACTIVE-CHILD',
  inactiveWithHistory: 'ITEST-TBE-INACTIVE',
  cycleA: 'ITEST-TBE-CYCLE-A',
  cycleB: 'ITEST-TBE-CYCLE-B',
};
const JOURNALS = [
  'ITEST-TBE-J-CHILDLESS', 'ITEST-TBE-J-PARENTACT', 'ITEST-TBE-J-INACTIVE',
  'ITEST-TBE-J-NULLREF', 'ITEST-TBE-J-OPEN-LATE', 'ITEST-TBE-J-CLEANWIN-NULLACC',
];

async function cleanup() {
  for (const jid of JOURNALS) {
    try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [jid]); } catch (_) {}
    try { await db.query('DELETE FROM gl_journals WHERE id = ?', [jid]); } catch (_) {}
  }
  // cycle accounts reference each other as parent — clear the FK before deleting either
  try { await db.query("UPDATE gl_accounts SET parent_id = NULL WHERE id IN (?, ?)", [IDS.cycleA, IDS.cycleB]); } catch (_) {}
  for (const id of Object.values(IDS)) {
    try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [id]); } catch (_) {}
  }
}

async function tableCounts() {
  const [[a]] = await db.query('SELECT COUNT(*) n FROM gl_accounts');
  const [[j]] = await db.query('SELECT COUNT(*) n FROM gl_journals');
  const [[e]] = await db.query('SELECT COUNT(*) n FROM gl_entries');
  return { accounts: a.n, journals: j.n, entries: e.n };
}

(async () => {
  // Isolated test DB starts with every TABLE but no chart-of-accounts rows
  // (ensureCoreAccounts() only runs lazily on the first real postJournal()
  // call) — provision schema, then seed the same baseline CORE_ACCOUNTS the
  // real dev DB already has, so code='111'/'1110' below resolve for real.
  await harness.ensureSchema();
  await harness.ensureCoreAccounts(db);
  await cleanup();
  const before = await tableCounts();

  try {
    console.log('\n═══ Trial Balance Engine correctness (Tier A.2, isolated test DB) ═══');

    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,NULL,?,1,1)',
      [IDS.scaffoldParent, 'ITEST900000', 'مجلّد سقالة (ITEST)', 'asset', 1]
    );
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [IDS.scaffoldCash, 'ITEST900001', 'نقدية سقالة (ITEST)', 'asset', IDS.scaffoldParent, 2]
    );
    const realParent = { id: IDS.scaffoldParent };
    const realCash = { id: IDS.scaffoldCash };

    // ── 1. Inactive account WITH history must still appear ──
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,0,0)',
      [IDS.inactiveWithHistory, 'ITEST900010', 'حساب معطَّل له تاريخ (ITEST)', 'asset', realParent.id, 4]
    );
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [JOURNALS[2], 'ITEST-TBE-INACTIVE', '2026-05-01', 'itest_fixture', 40, 40]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-INA1', JOURNALS[2], IDS.inactiveWithHistory, 40, 'ITEST-TBE-E-INA2', JOURNALS[2], realCash.id, 40]
    );
    const r1 = await computeTrialBalance(db, { includeZero: true });
    const inactiveRow = r1.rows.find((r) => r.accountId === IDS.inactiveWithHistory);
    check('inactive account WITH history is present in the report (not dropped upstream)', !!inactiveRow, inactiveRow);
    if (inactiveRow) {
      check('inactive account shows isActive=false but real closing figures', inactiveRow.isActive === false && inactiveRow.closing !== 0, inactiveRow);
    }

    // ── 2. Folder with NO children but with direct activity: not a posting
    // leaf, excluded from closeDebit/closeCredit double-counting risk, but
    // its money is NOT lost from Grand Total, and it IS flagged. ──
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,1)',
      [IDS.childlessFolder, 'ITEST900011', 'Folder بلا أبناء له حركة (ITEST)', 'asset', realParent.id, 4]
    );
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [JOURNALS[0], 'ITEST-TBE-CHILDLESS', '2026-05-02', 'itest_fixture', 25, 25]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-CH1', JOURNALS[0], IDS.childlessFolder, 25, 'ITEST-TBE-E-CH2', JOURNALS[0], realCash.id, 25]
    );
    const r2 = await computeTrialBalance(db, { includeZero: true });
    const folderRow = r2.rows.find((r) => r.accountId === IDS.childlessFolder);
    check('childless Folder row is present', !!folderRow, folderRow);
    if (folderRow) {
      check('childless Folder is NOT a posting leaf (is_folder=1 alone is not enough to include, but also not enough to exclude money)', folderRow.isPostingLeaf === false, folderRow);
    }
    const folderDiag = r2.diagnostics.nonLeafPostingActivity.find((d) => d.code === 'ITEST900011');
    check('childless Folder with direct activity is flagged in nonLeafPostingActivity diagnostic', !!folderDiag, r2.diagnostics.nonLeafPostingActivity);
    check('flagging the Folder makes the report non-clean', r2.isClean === false, r2.isClean);
    check('Folder-posting money is NOT dropped: raw ledger totals include it (period debit >= 25 for this window)', r2.totals.periodDebit >= 25, r2.totals);

    // ── 3. Parent (is_folder=0) WITH children AND its own direct activity ──
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [IDS.parentWithActivity, 'ITEST900012', 'Parent له نشاط مباشر وأبناء (ITEST)', 'asset', realParent.id, 4]
    );
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [IDS.parentWithActivityChild, 'ITEST9000121', 'ابن (ITEST)', 'asset', IDS.parentWithActivity, 5]
    );
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [JOURNALS[1], 'ITEST-TBE-PARENTACT', '2026-05-03', 'itest_fixture', 15, 15]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-PA1', JOURNALS[1], IDS.parentWithActivity, 15, 'ITEST-TBE-E-PA2', JOURNALS[1], realCash.id, 15]
    );
    const r3 = await computeTrialBalance(db, { includeZero: true });
    const parentActRow = r3.rows.find((r) => r.accountId === IDS.parentWithActivity);
    check('"non-aggregating parent" (is_folder=0, has children) is present and NOT a posting leaf', !!parentActRow && parentActRow.isPostingLeaf === false && parentActRow.hasChildren === true, parentActRow);
    const parentActDiag = r3.diagnostics.nonLeafPostingActivity.find((d) => d.code === 'ITEST900012');
    check('its direct activity is flagged in nonLeafPostingActivity', !!parentActDiag, r3.diagnostics.nonLeafPostingActivity);
    check('closing is still balanced overall despite the non-leaf posting (own-all-rows total, not leaves-only)', r3.totals.isClosingBalanced === true, r3.totals);
    // Mutation-style proof: a LEAVES-ONLY close total (the Tier A bug) would
    // have excluded this parent's own 15 debit, producing a smaller number.
    const leafOnlyCloseDebit = r3.rows.filter((r) => r.isPostingLeaf).reduce((s, r) => s + r.closeDebit, 0);
    check(
      'mutation guard: a leaves-only closeDebit total would DIFFER from the correct own-all-rows total whenever a non-leaf has direct activity (proves the Tier A leaves-only design was wrong, not just different)',
      Math.round((r3.totals.closeDebit - leafOnlyCloseDebit) * 100) / 100 !== 0,
      { correct: r3.totals.closeDebit, leavesOnlyWouldGive: leafOnlyCloseDebit }
    );

    // ── 4. Hierarchy cycle — must not hang/crash, must be flagged ──
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,NULL,?,1,0)',
      [IDS.cycleA, 'ITEST900013', 'دورة A (ITEST)', 'asset', 9]
    );
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [IDS.cycleB, 'ITEST900014', 'دورة B (ITEST)', 'asset', IDS.cycleA, 9]
    );
    await db.query('UPDATE gl_accounts SET parent_id = ? WHERE id = ?', [IDS.cycleB, IDS.cycleA]); // A.parent = B, B.parent = A
    const startCycle = Date.now();
    const r4 = await computeTrialBalance(db, { includeZero: true });
    const cycleElapsedMs = Date.now() - startCycle;
    check('a 2-node parent cycle does not hang (completed in ' + cycleElapsedMs + 'ms, cycle-guard bounds the walk)', cycleElapsedMs < 5000, cycleElapsedMs);
    const cycleRowA = r4.rows.find((r) => r.accountId === IDS.cycleA);
    check('cycle member is flagged isCycleMember', !!cycleRowA && cycleRowA.isCycleMember === true, cycleRowA);
    check('cycle is surfaced in diagnostics.cycleAccounts', r4.diagnostics.cycleAccounts.some((c) => c.code === 'ITEST900013'), r4.diagnostics.cycleAccounts);
    check('a detected cycle makes the report non-clean', r4.isClean === false, r4.isClean);
    await db.query("UPDATE gl_accounts SET parent_id = NULL WHERE id IN (?, ?)", [IDS.cycleA, IDS.cycleB]); // untangle before further tests / cleanup

    // ── 5. reference_type IS NULL must behave as a normal (non-opening) entry ──
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,NULL,?,?, 'posted')",
      [JOURNALS[3], 'ITEST-TBE-NULLREF', '2026-05-15', 8, 8]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-NR1', JOURNALS[3], realCash.id, 8, 'ITEST-TBE-E-NR2', JOURNALS[3], IDS.parentWithActivityChild, 8]
    );
    const r5 = await computeTrialBalance(db, { from: '2026-05-01', to: '2026-05-31', includeZero: true });
    const nullRefChildRow = r5.rows.find((r) => r.accountId === IDS.parentWithActivityChild);
    check(
      'a journal with reference_type IS NULL is NOT silently dropped from period movement (child account shows its 8 credit)',
      !!nullRefChildRow && nullRefChildRow.periodCredit === 8,
      nullRefChildRow
    );

    // ── 6. Opening journal dated AFTER `from` is excluded from Opening, not silently merged ──
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [JOURNALS[4], 'ITEST-TBE-OPEN-LATE', '2026-06-20', 'opening', 12, 12]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-OL1', JOURNALS[4], realCash.id, 12, 'ITEST-TBE-E-OL2', JOURNALS[4], IDS.parentWithActivityChild, 12]
    );
    const r6 = await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', includeZero: true });
    check('a future-dated (relative to `from`) opening journal is NOT counted as Opening', r6.diagnostics.futureDatedOpeningJournals.count >= 1, r6.diagnostics.futureDatedOpeningJournals);
    check('future-dated opening journal debit/credit is captured in the diagnostic, not silently lost', r6.diagnostics.futureDatedOpeningJournals.debit >= 12, r6.diagnostics.futureDatedOpeningJournals);
    check('a non-empty futureDatedOpeningJournals diagnostic makes the report non-clean', r6.isClean === false, r6.isClean);
    const cashRowJune = r6.rows.find((r) => r.accountId === realCash.id);
    check('the future-dated opening entry does not appear in that account\'s Opening OR Period figures either', !cashRowJune || (cashRowJune.openDebit === 0 && cashRowJune.periodDebit === 0), cashRowJune);
    // "future-dated" is relative to whichever `from` a caller passes — this
    // fixture's job is done; remove it now so it doesn't also read as
    // future-dated relative to the earlier `from` used by test 9 below.
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [JOURNALS[4]]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [JOURNALS[4]]);

    // ── 7. from > to / bad format ──
    let rangeCode = null;
    try { await computeTrialBalance(db, { from: '2026-07-01', to: '2026-01-01' }); } catch (e) { rangeCode = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE'; }
    check('from > to -> TB_INVALID_RANGE', rangeCode === 'TB_INVALID_RANGE', rangeCode);
    let fmtCode = null;
    try { await computeTrialBalance(db, { from: '2026/07/01' }); } catch (e) { fmtCode = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE'; }
    check('malformed date format -> TB_INVALID_DATE_FORMAT', fmtCode === 'TB_INVALID_DATE_FORMAT', fmtCode);

    // ── 8. Missing dimension column -> 409 SCHEMA_NOT_READY, not silently ignored ──
    resetDimColsCache();
    const realQuery = db.query.bind(db);
    const fakeDb = {
      query: (sql, params) => {
        if (typeof sql === 'string' && sql.includes('SHOW COLUMNS FROM gl_entries') && params && params[0] === 'warehouse_id') {
          return Promise.resolve([[]]); // simulate: column does not exist on this schema
        }
        return realQuery(sql, params);
      },
    };
    let schemaCode = null, schemaStatus = null;
    try {
      await computeTrialBalance(fakeDb, { warehouse: 'WH-1' });
    } catch (e) {
      schemaCode = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE';
      schemaStatus = e.status;
    }
    check('requesting a dimension filter whose column is missing -> SCHEMA_NOT_READY, 409 (not silently dropped)', schemaCode === 'SCHEMA_NOT_READY' && schemaStatus === 409, { schemaCode, schemaStatus });
    resetDimColsCache(); // restore real cache for subsequent calls

    // ── 9. Null-account entry flips isClean from true to false in an otherwise-clean window ──
    // Window chosen BEFORE the earliest real journal in this DB (2026-01-08)
    // and before every other fixture in this file (all 2026+), so Opening
    // (which aggregates everything dated before `from`, unbounded) is
    // genuinely empty rather than accidentally picking up prior activity.
    const cleanWindow = { from: '2010-01-01', to: '2010-01-31', includeZero: true };
    const clean1 = await computeTrialBalance(db, cleanWindow);
    check('a window with zero fixture activity is clean to start with', clean1.isClean === true && clean1.diagnostics.nullAccountEntries === 0, { isClean: clean1.isClean, diagnostics: clean1.diagnostics });
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [JOURNALS[5], 'ITEST-TBE-CWNA', '2010-01-15', 'itest_fixture', 9, 9]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit) VALUES (?,?,NULL,?,?,0), (?,?,?,?,0,?)',
      ['ITEST-TBE-E-NA1', JOURNALS[5], 'ITEST-DELETED-CODE', 9,
       'ITEST-TBE-E-NA2', JOURNALS[5], realCash.id, 'ITEST900001', 9]
    );
    const clean2 = await computeTrialBalance(db, cleanWindow);
    check('inserting ONE null-account entry flips isClean to false (Debit=Credit is not sufficient to call a report clean)', clean2.isClean === false && clean2.diagnostics.nullAccountEntries === 1, { isClean: clean2.isClean, nullAccountEntries: clean2.diagnostics.nullAccountEntries });
    // The source JOURNAL is balanced (total_debit=total_credit=9), but its
    // debit leg has no resolvable account — correctly excluded from the
    // "valid, attributable" totals below, which is EXACTLY why this must
    // surface as an imbalance too, not just a diagnostic count. Hiding this
    // behind a "still balanced" claim would be the same false-comfort bug
    // this whole gate exists to close.
    check('the credit leg alone (9) makes periodDebit/periodCredit genuinely unequal — a second, independent signal beyond the diagnostic count', clean2.totals.periodDebit === 0 && clean2.totals.periodCredit === 9 && clean2.totals.isPeriodBalanced === false, clean2.totals);
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    await cleanup();
  }

  // Cleanup-verification and the pass/fail summary both happen AFTER the
  // finally block, once, so the printed totals actually include them.
  const after = await tableCounts();
  check('DB fixture counts restored to baseline after cleanup (accounts)', after.accounts === before.accounts, { before: before.accounts, after: after.accounts });
  check('DB fixture counts restored to baseline after cleanup (journals)', after.journals === before.journals, { before: before.journals, after: after.journals });
  check('DB fixture counts restored to baseline after cleanup (entries)', after.entries === before.entries, { before: before.entries, after: after.entries });

  console.log(`\n${fail === 0 ? '✅' : '❌'} trialBalanceEngine: ${pass} passed, ${fail} failed`);
  if (fail) console.log('   failed:', fails.join(' | '));
  try { await db.end(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
