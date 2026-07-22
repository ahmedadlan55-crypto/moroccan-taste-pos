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
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

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
  'ITEST-TBE-J-OPEN-BEYOND-TO', 'ITEST-TBE-J-DANGLE-OPEN', 'ITEST-TBE-J-DANGLE-PERIOD',
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

    // ── 0. Null-account entry flips isClean from true to false in an
    // otherwise-clean window — run FIRST, right after the two scaffold
    // accounts, before any other test in this file adds its own fixtures.
    // isClean now aggregates structural diagnostics (cycles, level
    // mismatches, orphans) that are NOT scoped to any date window — several
    // later tests in this file deliberately create malformed hierarchies
    // (a 2-node parent cycle, hardcoded `level` values that don't match
    // their fixture's real depth) that persist until the final cleanup(),
    // so "the whole report is clean" stops being a safe assumption once
    // those fixtures exist. Running this proof before they do keeps it valid.
    const cleanWindow = { from: '2010-01-01', to: '2010-01-31', includeZero: true };
    const clean1 = await computeTrialBalance(db, cleanWindow);
    check('a window with zero fixture activity is clean to start with', clean1.isClean === true && clean1.diagnostics.nullAccountPeriod.count === 0 && clean1.diagnostics.nullAccountOpening.count === 0, { isClean: clean1.isClean, diagnostics: clean1.diagnostics });
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
    check('inserting ONE null-account entry flips isClean to false (Debit=Credit is not sufficient to call a report clean)', clean2.isClean === false && clean2.diagnostics.nullAccountPeriod.count === 1, { isClean: clean2.isClean, nullAccountPeriod: clean2.diagnostics.nullAccountPeriod });
    // The source JOURNAL is balanced (total_debit=total_credit=9), but its
    // debit leg has no resolvable account — correctly excluded from the
    // "valid, attributable" totals below, which is EXACTLY why this must
    // surface as an imbalance too, not just a diagnostic count. Hiding this
    // behind a "still balanced" claim would be the same false-comfort bug
    // this whole gate exists to close.
    check('the credit leg alone (9) makes periodDebit/periodCredit genuinely unequal — a second, independent signal beyond the diagnostic count', clean2.totals.periodDebit === 0 && clean2.totals.periodCredit === 9 && clean2.totals.isPeriodBalanced === false, clean2.totals);
    // This fixture's job is done — clean it up now instead of waiting for
    // the file's final cleanup(), so it can't shadow any later diagnostic.
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [JOURNALS[5]]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [JOURNALS[5]]);

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
    const YEAR_2026 = { from: '2026-01-01', to: '2026-12-31' };
    const r1 = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
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
    const r2 = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
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
    const r3 = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
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
    const r4 = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
    const cycleElapsedMs = Date.now() - startCycle;
    check('a 2-node parent cycle does not hang (completed in ' + cycleElapsedMs + 'ms, cycle-guard bounds the walk)', cycleElapsedMs < 5000, cycleElapsedMs);
    const cycleRowA = r4.rows.find((r) => r.accountId === IDS.cycleA);
    const cycleRowB = r4.rows.find((r) => r.accountId === IDS.cycleB);
    // Tier A.3 Release Gate item 4 — a plain A<->B cycle used to flag only
    // the node where the back-edge was detected (A), never B, even though
    // B is equally part of the same 2-node cycle. Both must be flagged now,
    // in both rows and diagnostics.cycleAccounts — not A alone.
    check('cycle member A is flagged isCycleMember', !!cycleRowA && cycleRowA.isCycleMember === true, cycleRowA);
    check('cycle member B is ALSO flagged isCycleMember (not just A)', !!cycleRowB && cycleRowB.isCycleMember === true, cycleRowB);
    check('cycle member A is surfaced in diagnostics.cycleAccounts', r4.diagnostics.cycleAccounts.some((c) => c.code === 'ITEST900013'), r4.diagnostics.cycleAccounts);
    check('cycle member B is ALSO surfaced in diagnostics.cycleAccounts (not just A)', r4.diagnostics.cycleAccounts.some((c) => c.code === 'ITEST900014'), r4.diagnostics.cycleAccounts);
    check('exactly 2 accounts are flagged as cycle members — the two real cycle nodes, nothing more', r4.diagnostics.cycleAccounts.length === 2, r4.diagnostics.cycleAccounts);
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

    // ── 6b. Tier A.3 Release Gate item 3 — an opening-tagged journal dated
    // AFTER `to` (a genuinely future REPORTING PERIOD, not a problem with
    // THIS report) must NOT be counted in futureDatedOpeningJournals and
    // must NOT flip isClean=false. Before the fix this diagnostic had no
    // upper bound at `to` at all, so this case was indistinguishable from
    // test 6 above (dated just after `from`, correctly flagged). ──
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [JOURNALS[6], 'ITEST-TBE-OPEN-FAR', '2027-01-10', 'opening', 30, 30]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-OF1', JOURNALS[6], realCash.id, 30, 'ITEST-TBE-E-OF2', JOURNALS[6], IDS.parentWithActivityChild, 30]
    );
    const r6b = await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', includeZero: true });
    check(
      'an opening journal dated well beyond `to` (a future reporting period) is NOT counted in futureDatedOpeningJournals',
      r6b.diagnostics.futureDatedOpeningJournals.count === 0,
      r6b.diagnostics.futureDatedOpeningJournals
    );
    // Not asserting isClean===true here: by this point in the file several
    // EARLIER, deliberately-unrelated fixtures (the childless folder with
    // direct activity, the cycle accounts, the orphan account, etc.) are
    // still present in the DB and correctly keep isClean=false on their own
    // — this test's job is only to prove futureDatedOpeningJournals itself
    // no longer contributes to that, which the count===0 check above
    // already does precisely.
    const cashRowBeyondTo = r6b.rows.find((r) => r.accountId === realCash.id);
    check('the beyond-`to` opening entry does not leak into that account\'s Opening OR Period figures either', !cashRowBeyondTo || (cashRowBeyondTo.openDebit === 0 && cashRowBeyondTo.periodDebit === 0), cashRowBeyondTo);
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [JOURNALS[6]]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [JOURNALS[6]]);

    // ── 6c. Tier A.3 Release Gate item 5 — a NON-NULL gl_entries.account_id
    // that matches no row in gl_accounts at all was invisible to every
    // existing diagnostic: nullAccountOpening/Period only catch account_id
    // IS NULL; orphanAccounts is about gl_accounts.parent_id, a different
    // thing entirely. db/schema.sql DOES declare a real FK (ON DELETE SET
    // NULL) — a normal INSERT is correctly rejected (verified directly: it
    // throws ER_NO_REFERENCED_ROW), and a normal account deletion auto-
    // nulls the reference instead of leaving it dangling. The only genuine
    // way to reach this state is the same way production data can: a bulk
    // import/migration that ran with FOREIGN_KEY_CHECKS=0. Simulated
    // faithfully here — not a test-only cheat, the same mechanism a real
    // bad import would use. Checked separately in Opening scope (a
    // dangling entry dated before `from`) and Period scope (dated within
    // [from, to]) — must flip isClean=false in both cases. ──
    const DANGLING_ACCOUNT_ID = 'ITEST-TBE-GHOST-ACCOUNT';
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [JOURNALS[7], 'ITEST-TBE-DANGLE-O', '2026-05-10', 'itest_fixture', 7, 7]
    );
    // Prove the FK genuinely protects the normal path first — a plain
    // INSERT (checks ON) referencing a nonexistent account_id must be
    // REJECTED by MySQL itself, not silently accepted.
    let fkRejected = false;
    try {
      await db.query(
        'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0)',
        ['ITEST-TBE-E-FKPROOF', JOURNALS[7], DANGLING_ACCOUNT_ID, 1]
      );
    } catch (e) { fkRejected = e.code === 'ER_NO_REFERENCED_ROW_2' || e.code === 'ER_NO_REFERENCED_ROW'; }
    check('a normal INSERT referencing a nonexistent account_id is genuinely rejected by the real FK constraint (proves the diagnostic below only matters for the abnormal path)', fkRejected);
    await db.query('SET FOREIGN_KEY_CHECKS=0');
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-DO1', JOURNALS[7], DANGLING_ACCOUNT_ID, 7, 'ITEST-TBE-E-DO2', JOURNALS[7], realCash.id, 7]
    );
    await db.query('SET FOREIGN_KEY_CHECKS=1');
    const rDangleOpen = await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', includeZero: true });
    check(
      'a gl_entries row whose account_id matches NO gl_accounts row (dated before `from`) is caught in danglingAccountOpening',
      rDangleOpen.diagnostics.danglingAccountOpening.count === 1 && rDangleOpen.diagnostics.danglingAccountOpening.debit === 7,
      rDangleOpen.diagnostics.danglingAccountOpening
    );
    check('the dangling-account Opening diagnostic makes the report non-clean', rDangleOpen.isClean === false, rDangleOpen.isClean);
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [JOURNALS[7]]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [JOURNALS[7]]);

    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [JOURNALS[8], 'ITEST-TBE-DANGLE-P', '2026-06-15', 'itest_fixture', 11, 11]
    );
    await db.query('SET FOREIGN_KEY_CHECKS=0');
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-DP1', JOURNALS[8], DANGLING_ACCOUNT_ID, 11, 'ITEST-TBE-E-DP2', JOURNALS[8], realCash.id, 11]
    );
    await db.query('SET FOREIGN_KEY_CHECKS=1');
    const rDanglePeriod = await computeTrialBalance(db, { from: '2026-06-01', to: '2026-06-30', includeZero: true });
    check(
      'a gl_entries row whose account_id matches NO gl_accounts row (dated within the period) is caught in danglingAccountPeriod',
      rDanglePeriod.diagnostics.danglingAccountPeriod.count === 1 && rDanglePeriod.diagnostics.danglingAccountPeriod.debit === 11,
      rDanglePeriod.diagnostics.danglingAccountPeriod
    );
    check('a dangling account_id does NOT accidentally trip the Opening diagnostic too (correctly scoped to Period only)', rDanglePeriod.diagnostics.danglingAccountOpening.count === 0, rDanglePeriod.diagnostics.danglingAccountOpening);
    check('the dangling-account Period diagnostic makes the report non-clean', rDanglePeriod.isClean === false, rDanglePeriod.isClean);
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [JOURNALS[8]]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [JOURNALS[8]]);

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
      await computeTrialBalance(fakeDb, { ...YEAR_2026, warehouse: 'WH-1' });
    } catch (e) {
      schemaCode = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE';
      schemaStatus = e.status;
    }
    check('requesting a dimension filter whose column is missing -> SCHEMA_NOT_READY, 409 (not silently dropped)', schemaCode === 'SCHEMA_NOT_READY' && schemaStatus === 409, { schemaCode, schemaStatus });
    resetDimColsCache(); // restore real cache for subsequent calls

    // ── 9. Opening net-vs-gross (Tier A.2 core fix): totals.openDebit/
    // openCredit must be the SUM OF PER-ACCOUNT NET balances, never a raw
    // gross ledger column sum. Account A: historical Dr100 (J1) + Cr80 (J2),
    // net Dr20. Counter account B carries the balancing legs (Cr100 in J1,
    // Dr80 in J2), net Cr20. The TRUE opening footer for this perfectly
    // balanced ledger is 20/20 — the old bug would have shown 180/180 (the
    // raw column sums: 100+80 debit, 100+80 credit). ──
    const openA = 'ITEST-TBE-OPEN-A', openB = 'ITEST-TBE-OPEN-B';
    const openJ1 = 'ITEST-TBE-OPEN-J1', openJ2 = 'ITEST-TBE-OPEN-J2';
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [openA, 'ITEST900020', 'حساب أصل — صافي افتتاحي (ITEST)', 'asset', realParent.id, 2]
    );
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [openB, 'ITEST900021', 'حساب التزام — صافي افتتاحي مقابل (ITEST)', 'liability', realParent.id, 2]
    );
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [openJ1, 'ITEST-TBE-OPENJ1', '2020-01-10', 'itest_fixture', 100, 100]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-OJ1A', openJ1, openA, 100, 'ITEST-TBE-E-OJ1B', openJ1, openB, 100]
    );
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [openJ2, 'ITEST-TBE-OPENJ2', '2020-02-15', 'itest_fixture', 80, 80]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-OJ2B', openJ2, openB, 80, 'ITEST-TBE-E-OJ2A', openJ2, openA, 80]
    );
    const rOpen = await computeTrialBalance(db, { from: '2020-06-01', to: '2020-06-30', includeZero: true });
    const rowA = rOpen.rows.find((r) => r.accountId === openA);
    const rowB = rOpen.rows.find((r) => r.accountId === openB);
    check('account A (Dr100/Cr80 historical) shows Opening = Dr20 only, not Dr100', !!rowA && rowA.openDebit === 20 && rowA.openCredit === 0, rowA);
    check('account B (counter legs Cr100/Dr80 historical) shows Opening = Cr20 only', !!rowB && rowB.openDebit === 0 && rowB.openCredit === 20, rowB);
    check(
      'Grand Total Opening footer is 20/20 (sum of PER-ACCOUNT nets), NOT 180/180 (the old raw-gross-column-sum bug)',
      rOpen.totals.openDebit === 20 && rOpen.totals.openCredit === 20,
      rOpen.totals
    );
    check(
      'diagnostics.grossHistoricalMovement still exposes the raw 180/180 figure, honestly labeled — never presented as the opening balance',
      rOpen.diagnostics.grossHistoricalMovement.debit === 180 && rOpen.diagnostics.grossHistoricalMovement.credit === 180,
      rOpen.diagnostics.grossHistoricalMovement
    );
    check(
      'reconciliation identity: grossHistoricalMovement.debit − .credit === totals.opening (net is invariant to gross-vs-net presentation, only the D/C split changes)',
      round2(rOpen.diagnostics.grossHistoricalMovement.debit - rOpen.diagnostics.grossHistoricalMovement.credit) === rOpen.totals.opening,
      { gross: rOpen.diagnostics.grossHistoricalMovement, opening: rOpen.totals.opening }
    );
    await db.query('DELETE FROM gl_entries WHERE journal_id IN (?, ?)', [openJ1, openJ2]);
    await db.query('DELETE FROM gl_journals WHERE id IN (?, ?)', [openJ1, openJ2]);
    await db.query('DELETE FROM gl_accounts WHERE id IN (?, ?)', [openA, openB]);

    // ── 10. A DRAFT journal dated before `from` must NEVER enter Opening
    // (nor any total) — draft rows are proposals, not posted fact. ──
    const draftJ = 'ITEST-TBE-DRAFT-OPEN';
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'draft')",
      [draftJ, 'ITEST-TBE-DRAFTJ', '2021-01-01', 'itest_fixture', 500, 500]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-DR1', draftJ, realCash.id, 500, 'ITEST-TBE-E-DR2', draftJ, IDS.parentWithActivityChild, 500]
    );
    const rDraft = await computeTrialBalance(db, { from: '2021-06-01', to: '2021-06-30', includeZero: true });
    const cashRowDraft = rDraft.rows.find((r) => r.accountId === realCash.id);
    check(
      'a DRAFT journal dated before `from` contributes NOTHING to Opening (status=posted only)',
      !cashRowDraft || (cashRowDraft.openDebit === 0 && cashRowDraft.openCredit === 0),
      cashRowDraft
    );
    check(
      'draft-only historical activity leaves grossHistoricalMovement at zero for this window too',
      rDraft.diagnostics.grossHistoricalMovement.debit === 0 && rDraft.diagnostics.grossHistoricalMovement.credit === 0,
      rDraft.diagnostics.grossHistoricalMovement
    );
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [draftJ]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [draftJ]);

    // ── 11. from/to are mandatory — no more silently dropping Opening when `from` is absent ──
    let noFromCode = null;
    try { await computeTrialBalance(db, { to: '2026-01-31' }); } catch (e) { noFromCode = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE'; }
    check('missing `from` -> TB_RANGE_REQUIRED', noFromCode === 'TB_RANGE_REQUIRED', noFromCode);
    let noToCode = null;
    try { await computeTrialBalance(db, { from: '2026-01-01' }); } catch (e) { noToCode = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE'; }
    check('missing `to` -> TB_RANGE_REQUIRED', noToCode === 'TB_RANGE_REQUIRED', noToCode);
    let noneCode = null;
    try { await computeTrialBalance(db, {}); } catch (e) { noneCode = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE'; }
    check('missing both from and to -> TB_RANGE_REQUIRED', noneCode === 'TB_RANGE_REQUIRED', noneCode);

    // ── 12. Real calendar-date validation — the YYYY-MM-DD regex alone
    // would accept these; an explicit Date round-trip must reject them. ──
    let feb31Code = null;
    try { await computeTrialBalance(db, { from: '2026-02-31', to: '2026-03-01' }); } catch (e) { feb31Code = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE'; }
    check('2026-02-31 (February has no 31st) -> TB_INVALID_DATE_VALUE', feb31Code === 'TB_INVALID_DATE_VALUE', feb31Code);
    let month13Code = null;
    try { await computeTrialBalance(db, { from: '2026-13-01', to: '2026-13-02' }); } catch (e) { month13Code = e instanceof TrialBalanceError ? e.code : 'WRONG_TYPE'; }
    check('2026-13-01 (no 13th month) -> TB_INVALID_DATE_VALUE', month13Code === 'TB_INVALID_DATE_VALUE', month13Code);

    // ── 13. Orphan account (parent_id set but dangling) — flagged, and flips isClean ──
    const orphanId = 'ITEST-TBE-ORPHAN';
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [orphanId, 'ITEST900030', 'حساب يتيم (ITEST)', 'asset', 'ITEST-DOES-NOT-EXIST', 2]
    );
    const rOrphan = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
    const orphanDiag = rOrphan.diagnostics.orphanAccounts.find((a) => a.code === 'ITEST900030');
    check('an account with a dangling parent_id is surfaced in diagnostics.orphanAccounts', !!orphanDiag && orphanDiag.parentId === 'ITEST-DOES-NOT-EXIST', rOrphan.diagnostics.orphanAccounts);
    check('an orphan account makes the report non-clean', rOrphan.isClean === false, rOrphan.isClean);
    await db.query('DELETE FROM gl_accounts WHERE id = ?', [orphanId]);

    // ── 14. Individually-unbalanced posted journals — checked PER JOURNAL,
    // so two journals that are each unbalanced but happen to cancel out in
    // aggregate can never hide behind a false "clean" report. ──
    const unbalX = 'ITEST-TBE-UNBAL-X', unbalY = 'ITEST-TBE-UNBAL-Y';
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [unbalX, 'ITEST-TBE-UNBALX', '2026-05-05', 'itest_fixture', 110, 100]
    );
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [unbalY, 'ITEST-TBE-UNBALY', '2026-05-06', 'itest_fixture', 100, 110]
    );
    const rUnbal = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
    const foundX = rUnbal.diagnostics.unbalancedJournals.find((j) => j.id === unbalX);
    const foundY = rUnbal.diagnostics.unbalancedJournals.find((j) => j.id === unbalY);
    check('journal X (110 debit / 100 credit) is individually flagged unbalanced', !!foundX && foundX.totalDebit === 110 && foundX.totalCredit === 100, foundX);
    check(
      'journal Y (100 debit / 110 credit) is ALSO individually flagged — X and Y net to zero in aggregate ((110-100)+(100-110)=0), proving they are checked per-journal and cannot cancel each other into a false-clean report',
      !!foundY && foundY.totalDebit === 100 && foundY.totalCredit === 110,
      foundY
    );
    check('unbalanced journals make the report non-clean', rUnbal.isClean === false, rUnbal.isClean);
    await db.query('DELETE FROM gl_journals WHERE id IN (?, ?)', [unbalX, unbalY]);

    // ── header-vs-lines mismatch: header is internally balanced (100=100)
    // but its actual gl_entries lines add up to something else entirely. ──
    const mismatchJ = 'ITEST-TBE-HDRMISMATCH';
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [mismatchJ, 'ITEST-TBE-HDRMIS', '2026-05-07', 'itest_fixture', 100, 100]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-HM1', mismatchJ, realCash.id, 60, 'ITEST-TBE-E-HM2', mismatchJ, IDS.parentWithActivityChild, 60]
    );
    const rMismatch = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
    const hlm = rMismatch.diagnostics.headerLineMismatches.find((j) => j.id === mismatchJ);
    check(
      'a journal whose header (100/100) disagrees with its actual line sum (60/60) is flagged in headerLineMismatches',
      !!hlm && hlm.headerDebit === 100 && hlm.lineDebit === 60,
      hlm
    );
    check('a header/line mismatch makes the report non-clean', rMismatch.isClean === false, rMismatch.isClean);
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [mismatchJ]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [mismatchJ]);

    // ── 15. Stored level disagreeing with the real computed tree depth
    // flips isClean — this diagnostic already existed before Tier A.2 but
    // did NOT affect isClean until this gate. ──
    const levelMismatchId = 'ITEST-TBE-LEVELMISMATCH';
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [levelMismatchId, 'ITEST900031', 'مستوى غير مطابق (ITEST)', 'asset', realParent.id, 99]
    );
    const rLevel = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
    const lm = rLevel.diagnostics.levelMismatches.find((a) => a.code === 'ITEST900031');
    check('an account whose stored level (99) disagrees with its real computed depth (2, one below scaffoldParent) is flagged', !!lm && lm.storedLevel === 99 && lm.computedLevel === 2, lm);
    check('a level mismatch makes the report non-clean', rLevel.isClean === false, rLevel.isClean);
    await db.query('DELETE FROM gl_accounts WHERE id = ?', [levelMismatchId]);

    // ── 16. journalCount is COUNT(DISTINCT journal_id), never a raw
    // gl_entries row count — a single journal with 2 lines touching the
    // SAME account must count as 1 journal, not 2. ──
    const splitJ = 'ITEST-TBE-SPLIT-J';
    const splitAcc = 'ITEST-TBE-SPLIT-ACC';
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
      [splitAcc, 'ITEST900032', 'حساب سطرين لنفس القيد (ITEST)', 'asset', realParent.id, 2]
    );
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, total_debit, total_credit, status) VALUES (?,?,?,?,?,?, 'posted')",
      [splitJ, 'ITEST-TBE-SPLITJ', '2026-05-08', 'itest_fixture', 30, 30]
    );
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,?,0), (?,?,?,0,?)',
      ['ITEST-TBE-E-SP1', splitJ, splitAcc, 10, 'ITEST-TBE-E-SP2', splitJ, splitAcc, 20, 'ITEST-TBE-E-SP3', splitJ, realCash.id, 30]
    );
    const rSplit = await computeTrialBalance(db, { ...YEAR_2026, includeZero: true });
    const splitRow = rSplit.rows.find((r) => r.accountId === splitAcc);
    check(
      'an account touched by 2 lines from the SAME journal shows journalCount=1 (COUNT(DISTINCT journal_id)), not 2 (a raw gl_entries row count would have given 2)',
      !!splitRow && splitRow.journalCount === 1 && splitRow.periodDebit === 30,
      splitRow
    );
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [splitJ]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [splitJ]);
    await db.query('DELETE FROM gl_accounts WHERE id = ?', [splitAcc]);
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
