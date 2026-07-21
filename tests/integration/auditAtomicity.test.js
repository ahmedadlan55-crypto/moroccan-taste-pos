'use strict';
/* Integration — audit-write atomicity (Tier A.2 corrective gate, Section 3).
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
    await db.query(
      'INSERT INTO gl_entries (id, journal_id, account_id, debit, credit) VALUES (?,?,?,?,0), (?,?,?,0,?)',
      [J_ID + '-E1', J_ID, SCAFFOLD_CASH_ID, 15, J_ID + '-E2', J_ID, SCAFFOLD_REV_ID, 15]
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

    console.log(`\n${fail === 0 ? '✅' : '❌'} auditAtomicity: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    if (swapped) {
      try { await restoreRealAuditLogs(); } catch (e) { console.error('CRITICAL: failed to restore the real audit_logs table:', e.message); }
    }
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
