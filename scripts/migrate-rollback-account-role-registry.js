#!/usr/bin/env node
/**
 * Rollback for migrations 0014 (account_role_registry) and 0015
 * (account_role_registry_scope_fix) — Tier A.1 Corrective Gate, item 6.
 *
 * db/migrate.js only applies forward; it has no built-in "down" mechanism.
 * This script is the documented, guarded manual procedure for reversing
 * these two specific migrations, in the correct order (0015 before 0014 —
 * 0014's tables must still exist for 0015's ALTERs to be reversible).
 *
 * Safety:
 *   - NEVER drops a table that has any rows. account_roles/
 *     account_role_history are currently empty in every environment (no
 *     consumer is wired to this registry yet — see ADR 0002 section 5), so
 *     this refusal should never actually trigger today, but it stays a
 *     hard, unconditional check regardless.
 *   - Reverting 0015's UNIQUE(role_key, company_id) back to 0014's
 *     UNIQUE(role_key) would silently violate the constraint (and lose the
 *     ability to distinguish rows) if two rows ever share a role_key across
 *     different companies — checked and refused, not merged/guessed.
 *   - Removes the corresponding `_migrations` bookkeeping rows so
 *     db/migrate.js will re-apply cleanly if run again afterward.
 *
 * Usage: node scripts/migrate-rollback-account-role-registry.js [--yes]
 * Without --yes, runs in dry-run mode (reports what it WOULD do).
 */
'use strict';

const db = require('../db/connection');

async function main() {
  const apply = process.argv.includes('--yes');
  console.log(apply ? 'APPLYING rollback (0015 then 0014)...' : 'DRY RUN — pass --yes to actually apply.');

  const [[rolesCount]] = await db.query('SELECT COUNT(*) n FROM account_roles').catch(() => [[{ n: 0 }]]);
  const [[historyCount]] = await db.query('SELECT COUNT(*) n FROM account_role_history').catch(() => [[{ n: 0 }]]);
  console.log(`account_roles rows: ${rolesCount.n}, account_role_history rows: ${historyCount.n}`);

  const [crossCompanyDupes] = await db.query(
    `SELECT role_key, COUNT(DISTINCT company_id) c FROM account_roles GROUP BY role_key HAVING c > 1`
  ).catch(() => [[]]);
  if (crossCompanyDupes.length) {
    console.error('REFUSING: these role_keys have mappings in more than one company — reverting to ' +
      'UNIQUE(role_key) alone would violate the constraint:', crossCompanyDupes);
    process.exitCode = 1;
    return;
  }

  const rollback0015 = [
    'ALTER TABLE account_role_history DROP FOREIGN KEY fk_arh_new_account',
    'ALTER TABLE account_role_history DROP FOREIGN KEY fk_arh_old_account',
    'ALTER TABLE account_role_history DROP FOREIGN KEY fk_arh_company',
    'ALTER TABLE account_role_history DROP COLUMN expected_version',
    'ALTER TABLE account_role_history MODIFY COLUMN company_id VARCHAR(50) NULL DEFAULT NULL',
    'ALTER TABLE account_roles DROP INDEX uq_role_company',
    'ALTER TABLE account_roles ADD UNIQUE KEY uq_role_key (role_key)',
    'ALTER TABLE account_roles MODIFY COLUMN company_id VARCHAR(50) NULL DEFAULT NULL',
    'ALTER TABLE account_roles DROP COLUMN version',
  ];

  // 0014's DROP TABLE guarded by the row-count check above (never touched
  // if rolesCount/historyCount > 0 — checked again immediately before drop
  // in case something wrote to these tables between the check and here).
  const rollback0014 = [
    'DROP TABLE IF EXISTS account_role_history',
    'DROP TABLE IF EXISTS account_roles',
  ];

  if (!apply) {
    console.log('Would run (0015 reversal):');
    rollback0015.forEach((s) => console.log('  ' + s));
    if (Number(rolesCount.n) === 0 && Number(historyCount.n) === 0) {
      console.log('Would then run (0014 reversal — tables are empty, safe to drop):');
      rollback0014.forEach((s) => console.log('  ' + s));
    } else {
      console.log('Would SKIP 0014 reversal (tables are not empty) — only 0015\'s ALTERs would revert.');
    }
    console.log('Would then DELETE FROM _migrations WHERE version IN (\'0014\',\'0015\') as applicable.');
    return;
  }

  for (const stmt of rollback0015) {
    await db.query(stmt);
    console.log('OK:', stmt);
  }
  await db.query("DELETE FROM _migrations WHERE version = '0015'");

  const [[recheckRoles]] = await db.query('SELECT COUNT(*) n FROM account_roles');
  const [[recheckHistory]] = await db.query('SELECT COUNT(*) n FROM account_role_history');
  if (Number(recheckRoles.n) === 0 && Number(recheckHistory.n) === 0) {
    for (const stmt of rollback0014) {
      await db.query(stmt);
      console.log('OK:', stmt);
    }
    await db.query("DELETE FROM _migrations WHERE version = '0014'");
  } else {
    console.log('SKIPPED 0014 table drop — non-empty. 0015\'s ALTERs were still reverted; ' +
      'account_roles/account_role_history remain in 0014\'s original shape.');
  }

  console.log('Rollback complete.');
}

if (require.main === module) {
  main()
    .then(() => db.end())
    .catch((e) => { console.error('ROLLBACK FAILED:', e.message); db.end().finally(() => process.exit(1)); });
}

module.exports = { main };
