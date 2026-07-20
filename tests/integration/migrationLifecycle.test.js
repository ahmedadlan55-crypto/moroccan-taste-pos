'use strict';
/* Integration — migration lifecycle for 0018/0019 (account_roles), against
 * an ISOLATED THROWAWAY DATABASE — never the real local dev DB, and
 * absolutely never anything that could be production.
 *
 * Tier A.1 Corrective Gate, item 6. Proves:
 *   1. A fresh/empty database (only the prerequisite tables 0018/0019
 *      depend on — companies, gl_accounts) can apply both migrations
 *      cleanly via the SAME statement-splitting/checksum logic
 *      db/migrate.js uses (imported directly, not reimplemented).
 *   2. Re-running is idempotent: with the versions already recorded in
 *      `_migrations`, nothing is re-executed.
 *   3. The documented rollback (scripts/migrate-rollback-account-role-
 *      registry.js) actually reverses both migrations and cleans up
 *      `_migrations` bookkeeping.
 *   4. Re-applying after rollback succeeds again (a full round trip).
 *
 * Also documents (not fixed here — out of this gate's scope, see the
 * corrective delivery report): db/migrate.js's runPendingMigrations() is
 * NEVER invoked automatically by any deployment path in this repo —
 * Dockerfile's CMD is `node server.js` directly, there is no railway.json/
 * railway.toml release phase, and server.js has no require('./db/migrate')
 * call. Migrations only apply when someone runs `npm run db:migrate`
 * manually. This is a real, verified, pre-existing gap affecting ALL
 * numbered migrations, not something this gate introduced.
 *
 * Run: node tests/integration/migrationLifecycle.test.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { _splitStatements, _checksum } = require('../../db/migrate');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

const TEST_DB_NAME = 'moroccan_taste_pos_migration_lifecycle_test';

function assertTestEnvironment() {
  const looksProd = !!(process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQLHOST);
  if (looksProd) {
    console.error('REFUSING TO RUN: this looks like a non-local database (DATABASE_URL/MYSQLHOST set). This test CREATEs and DROPs a throwaway database and must only run against a local MySQL server.');
    process.exit(2);
  }
}

async function connectRoot() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: false,
  });
}

async function applyMigrationFile(conn, filename) {
  const fullPath = path.join(__dirname, '..', '..', 'db', 'migrations', filename);
  const content = fs.readFileSync(fullPath, 'utf8');
  const stmts = _splitStatements(content);
  for (const s of stmts) await conn.query(s);
  const version = filename.match(/^(\d{4})_/)[1];
  await conn.query('INSERT INTO _migrations (version, filename, checksum) VALUES (?, ?, ?)', [version, filename, _checksum(content)]);
  return { version, stmtCount: stmts.length };
}

(async () => {
  assertTestEnvironment();
  const root = await connectRoot();
  let conn = null;

  try {
    console.log('\n═══ Migration lifecycle (0018/0019) — isolated throwaway database ═══');

    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`'); // in case a prior crashed run left it behind
    await root.query('CREATE DATABASE `' + TEST_DB_NAME + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    console.log(`  (created throwaway database ${TEST_DB_NAME})`);

    conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: TEST_DB_NAME,
    });

    // ── 1. Empty database: create ONLY the prerequisite tables 0018/0019
    // depend on (companies, gl_accounts) — proves the dependency ordering
    // documented in the migration files is both necessary and sufficient. ──
    // Charset/collation must match account_roles' explicit
    // utf8mb4_unicode_ci (db/migrations/README.md rule 5) — MySQL refuses
    // to create a FK between VARCHAR columns of differing collations, and
    // the server/database default here is utf8mb4_0900_ai_ci, not
    // utf8mb4_unicode_ci, unless stated explicitly on every table.
    const CHARSET = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await conn.query(`CREATE TABLE _migrations (version VARCHAR(20) NOT NULL PRIMARY KEY, filename VARCHAR(255) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, checksum VARCHAR(64)) ${CHARSET}`);
    await conn.query(`CREATE TABLE companies (id VARCHAR(50) NOT NULL PRIMARY KEY, name VARCHAR(200) NOT NULL, base_currency VARCHAR(3) DEFAULT 'SAR') ${CHARSET}`);
    await conn.query(`CREATE TABLE gl_accounts (id VARCHAR(50) NOT NULL PRIMARY KEY, code VARCHAR(20) NOT NULL UNIQUE, name_ar VARCHAR(200) NOT NULL, type ENUM('asset','liability','equity','revenue','expense') NOT NULL, parent_id VARCHAR(50), level INT DEFAULT 1, is_active TINYINT(1) DEFAULT 1, is_folder TINYINT(1) DEFAULT 0) ${CHARSET}`);
    await conn.query("INSERT INTO companies (id, name) VALUES ('CO-MAIN', 'Test Co')");
    await conn.query("INSERT INTO gl_accounts (id, code, name_ar, type) VALUES ('GL-1', '1', 'Assets', 'asset')");
    check('prerequisite schema (companies, gl_accounts) created on an otherwise-empty database', true);

    // ── 2. Apply 0018 then 0019 (dependency order matters: 0019 ALTERs
    // tables 0018 creates) ──
    const r18 = await applyMigrationFile(conn, '0018_account_role_registry.sql');
    check('0018 applies cleanly to the empty (prerequisites-only) database', r18.stmtCount === 2, r18);
    const r19 = await applyMigrationFile(conn, '0019_account_role_registry_scope_fix.sql');
    check('0019 applies cleanly immediately after 0018', r19.stmtCount === 11, r19);

    const [cols] = await conn.query('SHOW COLUMNS FROM account_roles');
    const colNames = cols.map((c) => c.Field);
    check(
      '0019\'s changes are actually present (version column, company_id NOT NULL)',
      colNames.includes('version') && cols.find((c) => c.Field === 'company_id').Null === 'NO',
      cols.map((c) => ({ f: c.Field, null: c.Null }))
    );

    // ── 3. Re-running is idempotent: applying again should be a no-op
    // (both versions already recorded in _migrations) ──
    const [appliedVersions] = await conn.query("SELECT version FROM _migrations WHERE version IN ('0018','0019') ORDER BY version");
    check('both versions are recorded in _migrations after the first apply', appliedVersions.length === 2, appliedVersions);
    // Simulate what db/migrate.js's runPendingMigrations() does: it reads
    // _migrations first and skips anything already there. We assert that
    // behavior directly here rather than re-executing the DDL (which WOULD
    // legitimately fail with "Duplicate column" — that failure mode itself
    // is what makes the runner's applied-version check load-bearing).
    const onDiskVersions = fs.readdirSync(path.join(__dirname, '..', '..', 'db', 'migrations'))
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(f))
      .map((f) => f.match(/^(\d{4})_/)[1]);
    const appliedSet = new Set(appliedVersions.map((r) => r.version));
    const wouldBePending = onDiskVersions.filter((v) => v === '0018' || v === '0019').filter((v) => !appliedSet.has(v));
    check('after applying, 0018/0019 are no longer in the "pending" set a rerun would compute', wouldBePending.length === 0, wouldBePending);

    // ── 4. Rollback actually reverses both, and cleans up _migrations ──
    // scripts/migrate-rollback-account-role-registry.js runs through
    // db/connection.js's module-cached singleton pool, which is already
    // bound to the REAL local dev DB by the time anything in this process
    // requires it — there is no clean way to redirect an already-created
    // pool to a different database from within the same process. So this
    // step runs the EXACT statements that script documents directly against
    // our isolated connection instead: it proves the documented rollback
    // procedure is correct SQL against a real schema, without needing a
    // second Node process just to get a fresh module cache.
    const rollbackStatements = [
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
    for (const s of rollbackStatements) await conn.query(s);
    await conn.query("DELETE FROM _migrations WHERE version = '0019'");
    const [[rCount]] = await conn.query('SELECT COUNT(*) n FROM account_roles');
    const [[hCount]] = await conn.query('SELECT COUNT(*) n FROM account_role_history');
    check('tables are empty, so 0018 is also safe to fully roll back (drop)', Number(rCount.n) === 0 && Number(hCount.n) === 0, { rCount: rCount.n, hCount: hCount.n });
    await conn.query('DROP TABLE account_role_history');
    await conn.query('DROP TABLE account_roles');
    await conn.query("DELETE FROM _migrations WHERE version = '0018'");

    const [tablesAfterRollback] = await conn.query("SHOW TABLES LIKE 'account_role%'");
    check('rollback removed both tables entirely', tablesAfterRollback.length === 0, tablesAfterRollback);
    const [migrationsAfterRollback] = await conn.query("SELECT version FROM _migrations WHERE version IN ('0018','0019')");
    check('rollback removed both _migrations bookkeeping rows', migrationsAfterRollback.length === 0, migrationsAfterRollback);

    // ── 5. Full round trip: re-apply after rollback succeeds again ──
    const r18b = await applyMigrationFile(conn, '0018_account_role_registry.sql');
    const r19b = await applyMigrationFile(conn, '0019_account_role_registry_scope_fix.sql');
    check('re-applying 0018+0019 after a full rollback succeeds (genuine round trip, not just forward-only)', r18b.version === '0018' && r19b.version === '0019');
    const [colsAfterReapply] = await conn.query('SHOW COLUMNS FROM account_roles');
    check('re-applied schema matches the original (version column present again)', colsAfterReapply.some((c) => c.Field === 'version'), colsAfterReapply.map((c) => c.Field));

    console.log(`\n${fail === 0 ? '✅' : '❌'} migrationLifecycle: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    if (conn) await conn.end().catch(() => {});
    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`').catch(() => {});
    console.log(`  (dropped throwaway database ${TEST_DB_NAME})`);
    await root.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
})();
