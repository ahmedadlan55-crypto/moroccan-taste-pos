'use strict';
/* Integration — the REAL db/migrate.js runner lifecycle (Tier A.2
 * corrective gate, Section 6).
 *
 * The previous version of this file manually read + split each migration
 * file's SQL itself (its own applyMigrationFile() helper) instead of
 * calling the actual shipped runner (runPendingMigrations()) — meaning it
 * only ever proved the SQL text was valid when executed by a hand-rolled
 * loop, never that `node db/migrate.js` (the real CLI entry point anyone
 * deploying this app would actually run) behaves correctly. Every check
 * below calls migrate.runPendingMigrations() directly.
 *
 * Uses its own throwaway CREATE/DROP DATABASE (never the shared
 * db/connection.js pool bound to the real dev DB) — this file swaps
 * process.env.DB_NAME BEFORE requiring db/migrate.js, so its internal
 * require('./connection') binds to the throwaway DB from the first
 * connection, same activation pattern as tests/helpers/testHarness.js.
 *
 * Covers:
 *   1. FRESH/bare DB — the runner stops cleanly on the first genuinely
 *      unmet prerequisite (0002 needs `sales` to exist), earlier
 *      migrations stay correctly recorded, nothing corrupts.
 *   2. EXISTING DB — once the full legacy schema is provisioned (a real
 *      spawned server.js boot against this same throwaway DB, matching
 *      every other isolated-DB test in this gate), resuming the SAME
 *      runner call applies every remaining migration, including 0002
 *      (whose columns may already exist from the legacy boot path — this
 *      is what actually proves Section 6's idempotent-guard rewrite
 *      through the real runner, not a hand-copied statement list) and
 *      this gate's own 0018/0019/0020/0021.
 *   3. RERUN — a further call reports zero pending, zero applied.
 *   4. PARTIAL FAILURE, then RESUME through the REAL runner — simulates
 *      the exact state a genuine crash leaves behind (no _migrations row
 *      for the interrupted version, since _applyMigration only inserts
 *      after every statement succeeds) and confirms runPendingMigrations()
 *      re-applies the whole file cleanly, completing only what's missing.
 *   5. Checksum drift — a stored checksum manipulated to no longer match
 *      on-disk content is detected and WARNED about (never thrown, never
 *      blocks other migrations).
 *
 * Run: node tests/integration/migrationLifecycle.test.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');
const { assertLocalTestEnvironment, TestHarnessError } = require('../helpers/testHarness');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); } }

function assertTestEnvironment() {
  try {
    assertLocalTestEnvironment();
  } catch (e) {
    if (e instanceof TestHarnessError) {
      console.error('REFUSING TO RUN:', e.message, 'This test CREATEs/DROPs a throwaway database and must only run against a local MySQL server.');
      process.exit(2);
    }
    throw e;
  }
}

const TEST_DB_NAME = 'moroccan_taste_pos_migration_runner_test';

async function connectRoot() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: false,
  });
}

// Captures info/warn events instead of only printing them, so checks below
// can assert on exactly what the runner reported — not just its return value.
function captureLogger() {
  const warnings = []; const infos = [];
  return {
    logger: {
      info: (obj, msg) => infos.push({ obj, msg }),
      warn: (obj, msg) => warnings.push({ obj, msg }),
      error: (obj, msg) => console.error('[migrate:error]', msg, obj && obj.event ? JSON.stringify(obj) : ''),
    },
    warnings, infos,
  };
}

function getFreePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close((err) => (err ? reject(err) : resolve(port))); });
  });
}

(async () => {
  assertTestEnvironment();
  const root = await connectRoot();
  let serverProc = null;
  try {
    console.log('\n═══ Real db/migrate.js runner lifecycle — isolated throwaway database ═══');

    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`'); // in case a prior crashed run left it behind
    await root.query('CREATE DATABASE `' + TEST_DB_NAME + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    console.log(`  (created throwaway database ${TEST_DB_NAME})`);

    process.env.DB_NAME = TEST_DB_NAME;
    delete process.env.DATABASE_URL; delete process.env.MYSQL_URL; delete process.env.MYSQLHOST;
    delete process.env.MYSQL_DATABASE; delete process.env.MYSQLDATABASE;

    const migrate = require('../../db/migrate');
    const db = require('../../db/connection');

    // ── 1. FRESH/bare DB — stops cleanly on the first real missing prerequisite ──
    const cap1 = captureLogger();
    let freshError = null;
    try {
      await migrate.runPendingMigrations({ logger: cap1.logger });
    } catch (e) { freshError = e; }
    check('a fresh/bare DB run THROWS (does not silently succeed or corrupt state) once it hits a migration whose prerequisite table is genuinely missing', !!freshError, freshError && freshError.message);
    check("the failure is the expected one — 0002 needs `sales`, which doesn't exist yet on a bare DB", freshError && /sales.*doesn.?t exist/i.test(freshError.message || ''), freshError && freshError.message);
    const [appliedAfterFresh] = await db.query('SELECT version FROM _migrations ORDER BY version');
    check('0001 (a true no-op) is recorded as applied; 0002 onward is NOT (clean partial state, safe to retry)', appliedAfterFresh.length === 1 && appliedAfterFresh[0].version === '0001', appliedAfterFresh);

    // ── 2. EXISTING DB — provision the full legacy schema via a real
    // server.js boot against this SAME throwaway DB, then resume the SAME
    // runner call. ──
    const port = await getFreePort();
    serverProc = require('child_process').spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    // A full legacy-schema boot (hundreds of addColumnIfMissing/
    // createTableIfMissing calls) genuinely takes over a minute on a
    // loaded dev machine — measured ~66s on a clean run. 60s was too tight
    // and produced a false failure (server killed mid-boot, before
    // pos_orders even existed yet, which then made the runner's own retry
    // look like a real bug). 3 minutes gives real margin without masking
    // an actually-hung boot.
    const deadline = Date.now() + 180000;
    let up = false;
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const req = require('http').get({ host: '127.0.0.1', port, path: '/api/version', timeout: 2000 }, (res) => { resolve(res.statusCode === 200); res.resume(); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) { up = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    check('a real server.js boot against the throwaway DB comes up (provisions the full legacy schema)', up);
    if (serverProc) { serverProc.kill(); serverProc = null; }

    const cap2 = captureLogger();
    const result2 = await migrate.runPendingMigrations({ logger: cap2.logger });
    check('resuming the SAME runner call now applies every remaining migration (0002 through the newest) once the legacy schema exists', result2.pending.length === 0 && result2.applied.length > 0, result2);
    check(
      "0002 specifically applied cleanly even though server.js's legacy boot may already have created some of its columns — proves Section 6's idempotent guards through the REAL runner, not hand-copied SQL",
      result2.applied.includes('0002_sales_numbering.sql'),
      result2.applied
    );
    const [appliedAfterExisting] = await db.query("SELECT version FROM _migrations WHERE version IN ('0018','0019','0020','0021') ORDER BY version");
    check("this gate's own migrations (0018/0019/0020/0021) are all recorded as applied", appliedAfterExisting.length === 4, appliedAfterExisting);

    // ── 3. RERUN — idempotent, zero pending, zero errors ──
    const cap3 = captureLogger();
    const result3 = await migrate.runPendingMigrations({ logger: cap3.logger });
    check('re-running immediately afterward reports zero pending and zero newly-applied (idempotent)', result3.pending.length === 0 && result3.applied.length === 0, result3);

    // ── 4. PARTIAL FAILURE, then RESUME through the REAL runner. A genuine
    // partial DDL failure leaves NO row in _migrations for that version
    // (_applyMigration only INSERTs after every statement in the file
    // succeeds) — simulate exactly that: delete 0019's bookkeeping row and
    // undo one of its effects (as if the process crashed after most of the
    // file ran but before finishing), then let runPendingMigrations() see
    // it as pending again and re-apply the WHOLE file. ──
    await db.query("DELETE FROM _migrations WHERE version = '0019'");
    await db.query('ALTER TABLE account_role_history DROP FOREIGN KEY fk_arh_new_account');
    const [beforeResume] = await db.query("SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_role_history' AND CONSTRAINT_TYPE='FOREIGN KEY'");
    check('simulated partial failure: fk_arh_new_account is gone, the other two FKs remain, 0019 no longer recorded as applied', beforeResume.length === 2, beforeResume);

    const cap4 = captureLogger();
    const result4 = await migrate.runPendingMigrations({ logger: cap4.logger });
    check(
      'the REAL runner sees 0019 as pending again and re-applies the WHOLE file cleanly — no "duplicate column/key/constraint" error on the steps that never actually broke',
      result4.applied.includes('0019_account_role_registry_scope_fix.sql'),
      result4
    );
    const [afterResume] = await db.query("SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_role_history' AND CONSTRAINT_TYPE='FOREIGN KEY'");
    check('fk_arh_new_account is restored — the runner completed exactly the missing step', afterResume.length === 3, afterResume);

    // ── 5. Checksum drift — detected and WARNED, never thrown, never blocks ──
    const [[stored0021]] = await db.query("SELECT checksum FROM _migrations WHERE version = '0021'");
    await db.query("UPDATE _migrations SET checksum = 'deadbeef-simulated-drift' WHERE version = '0021'");
    const cap5 = captureLogger();
    const result5 = await migrate.runPendingMigrations({ logger: cap5.logger });
    check('a manipulated stored checksum does NOT throw — drift is reported, not fatal', result5.pending.length === 0, result5);
    check('exactly one drifted entry is reported, naming the tampered version (0021)', Array.isArray(result5.drifted) && result5.drifted.length === 1 && result5.drifted[0].version === '0021', result5.drifted);
    check('a warning was actually logged for the drift (not just silently returned)', cap5.warnings.some((w) => w.obj && w.obj.event === 'migration_checksum_drift'), cap5.warnings);

    await db.query('UPDATE _migrations SET checksum = ? WHERE version = ?', [stored0021.checksum, '0021']);
    const cap6 = captureLogger();
    const result6 = await migrate.runPendingMigrations({ logger: cap6.logger });
    check('after restoring the real checksum, no drift is reported', Array.isArray(result6.drifted) && result6.drifted.length === 0, result6.drifted);

    console.log(`\n${fail === 0 ? '✅' : '❌'} migrationLifecycle: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch (_) {} }
    try {
      const db2 = require('../../db/connection');
      await db2.end();
    } catch (_) {}
    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`').catch(() => {});
    console.log(`  (dropped throwaway database ${TEST_DB_NAME})`);
    await root.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
})();
