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
const fs = require('fs');
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
    // RC-1 (Release-Candidate gate) — this step used to spawn the HTTP server
    // directly onto the bare database and poll /api/version against a fixed
    // 180s wall clock. That is a guess, not a proof, and measurement showed
    // it was a bad guess. A cold server.js boot issues ~668 sequential DDL
    // statements (558 `addColumnIfMissing` + 173 `createTableIfMissing` call
    // sites in server.js); on MySQL 8.4 each one costs ~135ms because every
    // DDL is its own durable data-dictionary commit. That is ~120s of
    // irreducible grind — measured 118.1s / 119.5s / 123.1s / 125.9s across
    // four solo runs, with the largest single gap anywhere in the boot being
    // 2.3s (i.e. no stall, no lock wait — a flat loop). Binlog fsync is NOT
    // the driver: the same DDL with `sql_log_bin=0` measured 137.0ms/stmt,
    // statistically identical. Warm re-boot of the same DB: 3.7s (33x less),
    // so 100% of the cost is one-time provisioning.
    //
    // 120s under a 180s budget is only 1.4x margin, and it was routinely
    // consumed by unrelated machine load: two concurrent cold boots measured
    // 198.9s each (already over), four measured 332-344s. The assertion was
    // failing on contention, never on anything server.js did wrong. Raising
    // the number would just move the guess.
    //
    // The real fix is to stop timing a wall clock and start waiting for a
    // genuine terminating signal. MIGRATE_ONLY=1 runs the IDENTICAL
    // autoInitDB() -> runMigrations() path and then exits, so provisioning is
    // awaited by process EXIT — arbitrary machine slowness can no longer
    // flake it. The HTTP proof is deliberately kept (this check must keep
    // meaning "a real server.js boot comes up"), but it now runs against the
    // already-warm schema where it costs ~4s, so its 60s budget carries ~15x
    // margin instead of 1.4x. BOTH halves must pass for this check to pass.
    // The 600s below is a hang-detector, not the success criterion.
    const bootStartedAt = Date.now();
    let provisionCode = 0;
    let provisionOut = '';
    try {
      provisionOut = require('child_process').execFileSync(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..', '..'),
        env: { ...process.env, MIGRATE_ONLY: '1' },
        timeout: 600000,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      provisionCode = e.status == null ? 1 : e.status;
      provisionOut = (e.stdout || '') + (e.stderr || '');
    }
    const provisionedMs = Date.now() - bootStartedAt;

    // Now prove the real HTTP server comes up — against the warm schema.
    const port = await getFreePort();
    // Adversarial review — stdio:['ignore','ignore','ignore'] discarded the
    // child's entire console output, so a boot failure or the deadline
    // being hit left nothing to debug beyond a bare "❌ ... comes up" (no
    // exit code, no elapsed time, none of server.js's own DB-retry/
    // migration-failure diagnostics). bankRecon.api.test.js and a dozen
    // other spawns in this suite already establish the fix: pipe stdout+
    // stderr into a buffer and surface it as the check's `extra` on failure.
    let childLog = '';
    serverProc = require('child_process').spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', (d) => { childLog += d; });
    serverProc.stderr.on('data', (d) => { childLog += d; });
    let exitInfo = null;
    serverProc.on('exit', (code, signal) => { exitInfo = { code, signal }; });
    const httpStartedAt = Date.now();
    const deadline = httpStartedAt + 60000;
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
    const provisioned = provisionCode === 0 && /schema ready/.test(provisionOut);
    check(
      'a real server.js boot against the throwaway DB comes up (provisions the full legacy schema)',
      provisioned && up,
      (provisioned && up) ? undefined : {
        provisionCode,
        provisionedMs,
        provisionSawSchemaReady: /schema ready/.test(provisionOut),
        httpUp: up,
        httpWaitedMs: Date.now() - httpStartedAt,
        exitInfo,
        tailOfProvisionLog: provisionOut.slice(-1200),
        tailOfChildLog: childLog.slice(-1200),
      }
    );
    if (serverProc) { serverProc.kill(); serverProc = null; }

    // Adversarial review — checking pos_orders.branch_id only AFTER
    // db/migrate.js's second run (below) would prove nothing about the
    // server.js ordering fix specifically: 0014_brand_branch_scope.sql has
    // its OWN INFORMATION_SCHEMA guard and would silently re-add the column
    // itself even if server.js's ordering bug were reintroduced — verified
    // directly by temporarily reverting the server.js fix and re-running
    // this suite: it still passed 16/16, because 0014's guard papered over
    // the regression. The check has to run HERE, before db/migrate.js's
    // second pass, to isolate what server.js's OWN boot actually achieved.
    const [serverOwnColumns] = await db.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND ((TABLE_NAME = 'pos_orders' AND COLUMN_NAME = 'branch_id')
           OR (TABLE_NAME = 'shifts' AND COLUMN_NAME = 'branch_id'))`
    );
    check(
      "server.js's OWN legacy boot (not db/migrate.js's later reconciliation) already added pos_orders.branch_id and shifts.branch_id — proves the ordering-bug fix, not just that SOME path eventually adds the column",
      serverOwnColumns.length === 2,
      serverOwnColumns
    );

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
    // 0002's own DDL landing for real (not just its _migrations bookkeeping
    // row) — server.js's legacy path already creates sales.invoice_number/
    // void_serial/return_serial too, so this doesn't isolate 0002's guard
    // the way the pos_orders check above isolates server.js's fix (a
    // reconciliation gap tracked separately — see db/migrations/README.md's
    // note on db:init-only deployments), but it does confirm the final
    // state is genuinely correct, not just recorded as applied.
    const [realColumns] = await db.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'sales' AND COLUMN_NAME IN ('invoice_number','void_serial','return_serial')`
    );
    check(
      "0002's sales.* columns genuinely exist on disk — not just recorded as applied in _migrations",
      realColumns.length === 3,
      realColumns
    );

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

    // ── 6. db:init-only deployment — 0002's REAL "column is genuinely
    // missing" branch. Adversarial review caught that scenario 2 above can
    // never actually exercise this: server.js's own legacy boot always
    // creates sales.invoice_number/void_serial/return_serial FIRST (line
    // ~2449), so by the time db/migrate.js reaches 0002 in every scenario
    // above, the guard only ever takes the "already exists" branch. A guard
    // that always (wrongly) reports "already exists" — e.g. a mistaken
    // TABLE_SCHEMA or COLUMN_NAME binding — would pass every check above
    // while never actually adding these columns on the ONE real deployment
    // path where it matters: `npm run db:init` (db/schema.sql, which does
    // NOT include these 3 columns) followed by `node db/migrate.js`,
    // without server.js ever booting first. Needs its own throwaway DB and
    // its own db/connection pool (Node's require() cache means the `db`/
    // `migrate` bound above can't be redirected mid-file), so this runs as
    // a small isolated child process, written to a real temp file (an
    // escaped-string-inside-a-template-literal-inside-a-shell-arg
    // three-deep nesting proved genuinely unworkable to get right).
    //
    // Building this scenario surfaced TWO real, pre-existing, SEPARATE bugs
    // in db/init.js + db/schema.sql (out of this gate's COA/Trial-Balance/
    // GL/migrations-of-this-branch scope — flagged in the delivery report,
    // not fixed here, since fixing a generic SQL-file executor correctly is
    // its own body of work):
    //   1. schema.sql line 6 is a hardcoded "USE moroccan_taste_pos"
    //      statement. db/init.js's own naive split-and-execute runs that
    //      statement too, silently switching the CONNECTION's active
    //      database away from whatever DB_NAME/MYSQL_DATABASE is
    //      configured — `npm run db:init` can only EVER target the
    //      literal hardcoded name, never a differently-named database.
    //   2. schema.sql line 135 is a `-- ...column set; no migration-window
    //      column drift.` comment that itself CONTAINS a semicolon.
    //      db/init.js's naive `.split(';')` has no notion of SQL comments,
    //      so it cuts THROUGH this comment line, mangling the very next
    //      statement (CREATE TABLE sales) into a syntax error that gets
    //      silently swallowed by the same tolerate-errors catch — meaning
    //      `npm run db:init` never actually creates the `sales` table at
    //      all, on any fresh database, today.
    // This scenario therefore does NOT reuse db/init.js's naive splitter
    // as-is (that would just reproduce bug 2 and never reach a state where
    // 0002's guard can be tested) — it strips `--` line comments before
    // splitting, which is what db/init.js itself should arguably do. The
    // strip regex is `/--.*/ ` with NO `$` anchor — schema.sql has CRLF
    // line endings, and `.` never matches `\r`, so `/--.*$/` (with `$`)
    // silently fails to match ANY line ending in `\r\n` (the trailing `\r`
    // blocks `.*` from ever reaching the true end-of-string `$` demands) —
    // caught empirically: the naive `$`-anchored version left the exact
    // same comment text behind, byte for byte, as if no stripping ran at
    // all. `.*` alone is already correctly bounded by the same
    // can't-match-a-line-terminator rule, so no anchor is needed. ──
    const initDbName = TEST_DB_NAME + '_dbinit_only';
    await root.query('DROP DATABASE IF EXISTS `' + initDbName + '`');
    await root.query('CREATE DATABASE `' + initDbName + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    const childScriptPath = path.join(__dirname, '_scenario6-dbinit-only.child.js');
    try {
      const childScript = [
        "process.env.DB_NAME = " + JSON.stringify(initDbName) + ";",
        "(async () => {",
        "  const fs = require('fs');",
        "  const path = require('path');",
        "  const pool = require('../../db/connection');",
        "  const conn = await pool.getConnection();",
        "  try {",
        "    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');",
        "    const noComments = schema.split('\\n').map((line) => line.replace(/--.*/, '')).join('\\n');",
        "    for (const stmt of noComments.split(';').map((s) => s.trim()).filter(Boolean)) {",
        "      if (/^USE\\s/i.test(stmt)) continue;",
        "      try { await conn.query(stmt); } catch (e) {}",
        "    }",
        "    const [before] = await conn.query(",
        "      \"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND COLUMN_NAME IN ('invoice_number','void_serial','return_serial')\"",
        "    );",
        "    conn.release();",
        "    const migrate = require('../../db/migrate');",
        "    try { await migrate.runPendingMigrations({ logger: { info(){}, warn(){}, error(){} } }); } catch (e) {",
        "      // Expected on a genuinely bare schema.sql-only install: later",
        "      // migrations (0003+) assume columns from EARLIER migration-window",
        "      // drift that a schema.sql-only DB never had either (e.g. users.email)",
        "      // — a separate, pre-existing gap in schema.sql being out of sync",
        "      // with the full migration history, out of THIS gate's scope. The",
        "      // runner stops at the FIRST failure, so 0002 (which runs before any",
        "      // such later gap) already either applied or didn't by this point —",
        "      // that's the one thing this check verifies, not a full apply-to-completion.",
        "    }",
        "    const conn2 = await pool.getConnection();",
        "    const [after] = await conn2.query(",
        "      \"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND COLUMN_NAME IN ('invoice_number','void_serial','return_serial')\"",
        "    );",
        "    const [applied0002] = await conn2.query(\"SELECT version FROM _migrations WHERE version = '0002'\");",
        "    conn2.release();",
        "    console.log(JSON.stringify({ beforeCount: before.length, afterCount: after.length, applied0002: applied0002.length === 1 }));",
        "  } finally {",
        "    await pool.end();",
        "  }",
        "  process.exit(0);",
        "})().catch((e) => { console.error(e); process.exit(1); });",
      ].join('\n');
      fs.writeFileSync(childScriptPath, childScript, 'utf8');

      const { execFileSync } = require('child_process');
      let childOut = null;
      let childErr = null;
      try {
        childOut = execFileSync(process.execPath, [childScriptPath], {
          cwd: path.join(__dirname, '..', '..'),
          env: process.env,
          timeout: 60000,
        }).toString();
      } catch (e) {
        childErr = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : e.message);
      }
      let parsed = null;
      try { parsed = childOut && JSON.parse(childOut.trim().split('\n').pop()); } catch (_) {}
      check(
        "on a bare db:init-only schema (no server.js boot), 0002's guard genuinely takes the ADD branch: 0 sales.* columns before, 3 after, 0002 recorded as applied",
        !!parsed && parsed.beforeCount === 0 && parsed.afterCount === 3 && parsed.applied0002 === true,
        parsed || { childOut, childErr }
      );
    } finally {
      try { fs.unlinkSync(childScriptPath); } catch (_) {}
      await root.query('DROP DATABASE IF EXISTS `' + initDbName + '`').catch(() => {});
    }

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
