'use strict';
/* Integration — financial-transition atomicity: audit-write atomicity
 * (Tier A.2 corrective gate, Section 3) AND reverse()'s link-back
 * atomicity (Tier A.3 Release Gate item 9).
 *
 * lib/auditLogger.js#logAuditTx is the transactional counterpart to
 * logAudit(): it is called INSIDE the same db.withTransaction() a GL
 * transition (lib/glTransitions.js#approve/post/approvePost/deleteJournal/
 * reverse) already runs in, with NO try/catch — a write failure there MUST
 * roll back the whole transaction, not silently drop the audit row while
 * the financial state change goes through anyway.
 *
 * This proves it with a REAL failure, not a mock: audit_logs is swapped
 * (via two fast, metadata-only RENAME TABLE statements — never an ALTER
 * TABLE MODIFY COLUMN on the real, populated table, which could fail or
 * truncate pre-existing rows other tests already left in this isolated
 * database) for a throwaway table whose `action` column is too narrow for
 * a real transition's hardcoded action string. approve_journal's INSERT
 * then genuinely violates a real MySQL column-width constraint.
 *
 * Run: node tests/integration/auditAtomicity.test.js
 */
require('dotenv').config();
// Tier A.2 — MUST be required and activated before db/connection.js.
const harness = require('../helpers/testHarness');
harness.activate();
const db = require('../../db/connection');
const glTransitions = require('../../lib/glTransitions');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

const SCAFFOLD_PARENT_ID = 'ITEST-AA-SCAFFOLD-PARENT';
const SCAFFOLD_CASH_ID = 'ITEST-AA-SCAFFOLD-CASH';
const SCAFFOLD_REV_ID = 'ITEST-AA-SCAFFOLD-REV';
const MAKER = 'itest_aa_maker';
const CHECKER = 'itest_aa_checker';
const J_ID = 'ITEST-AA-J1';

async function cleanup() {
  // Crash-safety net for the reverse() atomicity test — a successful
  // reversal journal's id isn't known ahead of time, so sweep by tag
  // instead in case an earlier run crashed before its own explicit cleanup.
  try {
    const [orphans] = await db.query("SELECT id FROM gl_journals WHERE reference_type = 'reversal' AND reference_id = ?", [J_ID]);
    for (const o of orphans) {
      try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [o.id]); } catch (_) {}
      try { await db.query('DELETE FROM gl_journals WHERE id = ?', [o.id]); } catch (_) {}
    }
  } catch (_) {}
  try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [J_ID]); } catch (_) {}
  try { await db.query('DELETE FROM gl_journals WHERE id = ?', [J_ID]); } catch (_) {}
  for (const u of [MAKER, CHECKER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  for (const id of [SCAFFOLD_CASH_ID, SCAFFOLD_REV_ID, SCAFFOLD_PARENT_ID]) { try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [id]); } catch (_) {} }
  try { await db.query('DELETE FROM audit_logs WHERE entity_id = ?', [J_ID]); } catch (_) {}
}

// Restores the real audit_logs table (with all its original rows intact)
// if the throwaway-narrow-table swap is still in effect. Safe to call even
// when nothing is swapped (checked by the caller via `swapped`).
async function restoreRealAuditLogs() {
  await db.query('DROP TABLE IF EXISTS audit_logs');
  await db.query('RENAME TABLE audit_logs_aa_backup TO audit_logs');
}

(async () => {
  await harness.ensureSchema();
  await cleanup();
  let swapped = false;
  let narrowedReversedByOuter = false;
  // The reverse()-link-back test narrows gl_journals.reversed_by_journal_id to
  // VARCHAR(1) to force a truncation. That ALTER validates EVERY existing row,
  // and this harness DB (`..._test`) is shared — another suite (rc-gate-seed)
  // leaves a real reversal link (e.g. RCGL-J-0003R) that a global narrow can't
  // shrink past. So snapshot any other rows' values, NULL them for the duration
  // of the narrow (J_ID's own is still NULL — it isn't reversed yet), and
  // restore them VERBATIM afterward. Declared out here so both finally blocks
  // can guarantee the restore even on a crash.
  let preservedReversedBy = [];
  let reversedByCleared = false;
  try {
    console.log('\n═══ Audit-write atomicity (logAuditTx rolls back the whole transition), isolated test DB ═══');

    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,NULL,1,1,1)',
      [SCAFFOLD_PARENT_ID, 'ITEST900050', 'مجلّد سقالة (ITEST)', 'asset']
    );
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)',
      [SCAFFOLD_CASH_ID, 'ITEST900051', 'نقدية سقالة (ITEST)', 'asset', SCAFFOLD_PARENT_ID]
    );
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)',
      [SCAFFOLD_REV_ID, 'ITEST900052', 'إيراد سقالة (ITEST)', 'revenue', SCAFFOLD_PARENT_ID]
    );
    await db.query(
      "INSERT INTO gl_journals (id, journal_number, journal_date, total_debit, total_credit, status, created_by) VALUES (?,?,?,?,?, 'draft', ?)",
      [J_ID, 'ITEST-AA-J1', '2026-06-10', 15, 15, MAKER]
    );
    // Tier A.3 — account_code is now required on both legs: reverse()'s new
    // exercise of postJournal() (via the link-back atomicity test below)
    // resolves accounts by code, not id, so a NULL account_code here would
    // fail with "account not found: null" — a gap this fixture never hit
    // before nothing in this file called postJournal() on it.
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit) VALUES (?,?,?,?,?,0), (?,?,?,?,0,?)',
      [J_ID + '-E1', J_ID, SCAFFOLD_CASH_ID, 'ITEST900051', 15, J_ID + '-E2', J_ID, SCAFFOLD_REV_ID, 'ITEST900052', 15]
    );

    const [[before]] = await db.query('SELECT status, approved_by FROM gl_journals WHERE id = ?', [J_ID]);
    check('journal starts as draft, not yet approved', before.status === 'draft' && !before.approved_by, before);

    // ── swap in a throwaway audit_logs whose action column is too narrow
    // for 'approve_journal' (16 chars) — a REAL constraint, never a mock. ──
    await db.query('RENAME TABLE audit_logs TO audit_logs_aa_backup');
    swapped = true;
    await db.query(`
      CREATE TABLE audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_username VARCHAR(100),
        action VARCHAR(5) NOT NULL,
        entity_type VARCHAR(40) NOT NULL,
        entity_id VARCHAR(80),
        details TEXT,
        ip_address VARCHAR(45),
        user_agent VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    let threw = null;
    try {
      await glTransitions.approve(J_ID, { username: CHECKER, role: 'finance' }, {});
    } catch (e) {
      threw = e;
    }
    check(
      'approve() THROWS when the audit write genuinely fails (real MySQL column-width violation, not a mock)',
      !!threw && /too long|data truncated/i.test(threw.message || ''),
      threw && threw.message
    );

    const [[afterFailedApprove]] = await db.query('SELECT status, approved_by FROM gl_journals WHERE id = ?', [J_ID]);
    check(
      "the journal's status did NOT change — the failed audit write rolled back the WHOLE transaction, including the UPDATE that would have approved it",
      afterFailedApprove.status === 'draft' && !afterFailedApprove.approved_by,
      afterFailedApprove
    );

    const [narrowTableRows] = await db.query('SELECT id FROM audit_logs');
    check('no row was left behind in the (narrow, throwaway) audit_logs either — the INSERT itself never committed', narrowTableRows.length === 0, narrowTableRows);

    // ── restore the REAL audit_logs (with every pre-existing row intact),
    // then prove the SAME approve() call succeeds cleanly once the
    // constraint is gone — this is what actually proves the failure above
    // was caused by the narrowed column, not some unrelated break. ──
    await restoreRealAuditLogs();
    swapped = false;

    const okResult = await glTransitions.approve(J_ID, { username: CHECKER, role: 'finance' }, {});
    check('once the real (wide) column is back, the SAME approve() call succeeds cleanly', okResult.ok === true, okResult);
    const [[afterRealApprove]] = await db.query('SELECT status, approved_by FROM gl_journals WHERE id = ?', [J_ID]);
    check('journal is genuinely approved this time', afterRealApprove.status === 'approved' && afterRealApprove.approved_by === CHECKER, afterRealApprove);
    const [auditRowsAfter] = await db.query("SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'approve_journal'", [J_ID]);
    check('the successful approve DID write its audit row this time (proves logAuditTx runs on the happy path too, not just as a failure trigger)', auditRowsAfter.length === 1, auditRowsAfter);

    // ── Tier A.3 Release Gate item 9 — reverse()'s link-back UPDATE
    // (gl_journals.reversed_by_journal_id / reverses_journal_id) used to be
    // wrapped in a try/catch that swallowed ANY failure. By the time that
    // UPDATE runs, the NEW reversal journal has ALREADY been posted inside
    // the SAME transaction — if the link-back then silently failed, the
    // ORIGINAL journal's reversed_by_journal_id would stay NULL forever,
    // meaning the double-reversal guard (`if (j.reversed_by_journal_id)`
    // at the top of reverse()) would never trip and the same journal could
    // be reversed twice. Proven with a REAL failure: narrow the column so
    // no generated journal id can possibly fit, same technique as the
    // audit_logs swap above but via MODIFY COLUMN (gl_journals is a large,
    // widely-referenced table — RENAME-swapping it would be far riskier
    // than narrowing one column and putting it back). ──
    const postResult = await glTransitions.post(J_ID, { username: CHECKER, role: 'finance' }, {});
    check('setup: journal is posted (reversible) before the link-back atomicity test', postResult.ok === true, postResult);

    let narrowedReversedBy = false;
    try {
      // Set aside any OTHER suite's reversal links so narrowing can't fail on
      // them (see the declaration comment above); restored in finally.
      [preservedReversedBy] = await db.query(
        'SELECT id, reversed_by_journal_id FROM gl_journals WHERE reversed_by_journal_id IS NOT NULL AND id <> ?',
        [J_ID]
      );
      if (preservedReversedBy.length) {
        await db.query('UPDATE gl_journals SET reversed_by_journal_id = NULL WHERE reversed_by_journal_id IS NOT NULL AND id <> ?', [J_ID]);
        reversedByCleared = true;
      }
      await db.query('ALTER TABLE gl_journals MODIFY COLUMN reversed_by_journal_id VARCHAR(1) NULL');
      narrowedReversedBy = true;
      narrowedReversedByOuter = true;

      const reverseResult = await glTransitions.reverse(J_ID, { username: CHECKER, role: 'finance' }, { reason: 'atomicity test' });
      check(
        'reverse() reports failure when the link-back UPDATE genuinely cannot fit (real MySQL data-truncation, not a mock)',
        reverseResult.ok === false,
        reverseResult
      );

      const [[afterFailedReverse]] = await db.query('SELECT status, reversed_by_journal_id FROM gl_journals WHERE id = ?', [J_ID]);
      check(
        "the ORIGINAL journal is still 'posted' with reversed_by_journal_id still NULL — the failed link-back rolled back the WHOLE transaction",
        afterFailedReverse.status === 'posted' && !afterFailedReverse.reversed_by_journal_id,
        afterFailedReverse
      );

      const [orphanReversalJournals] = await db.query(
        "SELECT id FROM gl_journals WHERE reference_type = 'reversal' AND reference_id = ?",
        [J_ID]
      );
      check(
        'no orphan reversal journal was left behind either — the postJournal() call inside the same transaction was rolled back too, not just the link-back UPDATE',
        orphanReversalJournals.length === 0,
        orphanReversalJournals
      );
    } finally {
      if (narrowedReversedBy) {
        await db.query('ALTER TABLE gl_journals MODIFY COLUMN reversed_by_journal_id VARCHAR(50) NULL');
        narrowedReversedBy = false;
        narrowedReversedByOuter = false;
      }
      // Restore the other suites' reversal links VERBATIM, only after the column
      // is wide again so their real (multi-char) values fit.
      if (reversedByCleared) {
        for (const r of preservedReversedBy) {
          await db.query('UPDATE gl_journals SET reversed_by_journal_id = ? WHERE id = ?', [r.reversed_by_journal_id, r.id]);
        }
        reversedByCleared = false;
      }
    }

    // ── Same reverse() call, now that the real (wide) column is back —
    // proves the failure above was caused by the narrowed column, not some
    // unrelated break, AND that the rollback was genuinely clean (this
    // call does not see a half-reversed journal or an already-reversed
    // error — it succeeds as if the failed attempt never happened). ──
    const realReverseResult = await glTransitions.reverse(J_ID, { username: CHECKER, role: 'finance' }, { reason: 'atomicity test — real attempt' });
    check('once the real (wide) column is back, the SAME reverse() call succeeds cleanly', realReverseResult.ok === true, realReverseResult);
    const [[afterRealReverse]] = await db.query('SELECT status, reversed_by_journal_id FROM gl_journals WHERE id = ?', [J_ID]);
    check('the original journal is now genuinely linked to its reversal', afterRealReverse.status === 'posted' && !!afterRealReverse.reversed_by_journal_id, afterRealReverse);
    // Compared via DATE_FORMAT on BOTH sides, never a JS Date object's
    // .toString()/.toISOString() (those depend on the RUNNING PROCESS's own
    // system timezone, which is exactly the class of bug this fix closes —
    // asserting through the same JS-Date path would risk masking a
    // regression on a machine whose OS timezone happens to agree by luck).
    const [[dateCompare]] = await db.query(
      "SELECT DATE_FORMAT(journal_date, '%Y-%m-%d') AS reversalDate, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS riyadhToday FROM gl_journals WHERE id = ?",
      [afterRealReverse.reversed_by_journal_id]
    );
    check(
      "the reversal journal's date matches MySQL's OWN Asia/Riyadh-pinned CURDATE() (proves it used the DB's session timezone, not a raw new Date().toISOString() that could be a UTC day off)",
      dateCompare.reversalDate === dateCompare.riyadhToday,
      dateCompare
    );
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [afterRealReverse.reversed_by_journal_id]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [afterRealReverse.reversed_by_journal_id]);

    console.log(`\n${fail === 0 ? '✅' : '❌'} auditAtomicity: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    if (swapped) {
      try { await restoreRealAuditLogs(); } catch (e) { console.error('CRITICAL: failed to restore the real audit_logs table:', e.message); }
    }
    if (narrowedReversedByOuter) {
      try { await db.query('ALTER TABLE gl_journals MODIFY COLUMN reversed_by_journal_id VARCHAR(50) NULL'); } catch (e) { console.error('CRITICAL: failed to restore gl_journals.reversed_by_journal_id width:', e.message); }
    }
    // Safety net — if a crash skipped the inner-finally restore, put the other
    // suites' reversal links back now that the column is wide again.
    if (reversedByCleared) {
      for (const r of preservedReversedBy) {
        try { await db.query('UPDATE gl_journals SET reversed_by_journal_id = ? WHERE id = ?', [r.reversed_by_journal_id, r.id]); } catch (e) { console.error('CRITICAL: failed to restore a preserved reversed_by_journal_id link:', e.message); }
      }
      reversedByCleared = false;
    }
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
