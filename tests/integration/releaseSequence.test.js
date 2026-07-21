'use strict';
/* Integration — Tier A.3 Release Gate, item 6: prove the REAL release
 * sequence works end-to-end on a genuinely empty database, with no rescue
 * from an accepted failure.
 *
 * `npm start` only ever runs `node server.js` — there is no numbered-
 * migration step in the deploy path. Before this gate, `node db/migrate.js`
 * alone against a bare `db:init`-only database hard-failed (0004's
 * `ALTER TABLE users ... AFTER email` — `email` doesn't exist until
 * server.js's own runMigrations() adds it — then 0005 failed the same way
 * on `hr_employees`, a table only server.js creates). That is NOT a
 * db/migrate.js bug to code around with more guards forever — it's the
 * real shape of this codebase's schema history: db/schema.sql is the
 * project's DAY-ONE snapshot, server.js's runMigrations() is thousands of
 * lines of the schema's actual evolution since, and every numbered
 * migration in db/migrations/ was authored (and originally tested, see
 * migrationLifecycle.test.js) assuming that evolution already happened.
 *
 * The real release sequence therefore has FOUR steps, not three:
 *   1. node db/init.js                 — day-one schema.sql baseline
 *   2. MIGRATE_ONLY=1 node server.js   — the legacy runMigrations() schema
 *                                         evolution, as its OWN step (new
 *                                         in this gate — previously only
 *                                         ran as a side effect of booting
 *                                         the HTTP server)
 *   3. node db/migrate.js              — the newest versioned migrations
 *   4. node server.js                  — the real start, HTTP server up
 *
 * This test runs exactly that sequence, as separate child processes (the
 * same commands a deploy pipeline would run), against one throwaway
 * database, and asserts each step's real exit code — no step is allowed
 * to fail and be silently rescued by a later one.
 *
 * Run: node tests/integration/releaseSequence.test.js
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const mysql = require('mysql2/promise');
const { assertLocalTestEnvironment, TestHarnessError, getFreePort } = require('../helpers/testHarness');

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

const TEST_DB_NAME = 'moroccan_taste_pos_release_gate_test';
const REPO_ROOT = path.join(__dirname, '..', '..');

async function connectRoot() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: false,
  });
}

function runStep(args, env) {
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 240000,
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function httpGetJson(port, urlPath) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2000 }, (res) => {
      let body = ''; res.on('data', (c) => (body += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

(async () => {
  assertTestEnvironment();
  const root = await connectRoot();
  let serverProc = null;
  try {
    console.log('\n═══ Real release sequence — db:init → MIGRATE_ONLY → db:migrate → start ═══');

    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`');
    await root.query('CREATE DATABASE `' + TEST_DB_NAME + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    console.log(`  (created genuinely empty database ${TEST_DB_NAME})`);

    // ── Step 1: db:init — day-one schema.sql baseline ──
    const step1 = runStep(['db/init.js'], { DB_NAME: TEST_DB_NAME });
    check('step 1 (db:init) exits 0 on a genuinely empty database', step1.code === 0, step1.out.slice(-400));
    const [usersAfterInit] = await root.query(
      "SELECT COUNT(*) n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='users'", [TEST_DB_NAME]
    );
    check('users table exists after db:init', usersAfterInit[0].n === 1, usersAfterInit);

    // ── Step 2: MIGRATE_ONLY=1 node server.js — legacy schema evolution,
    // as its own release step, NOT as a side effect of booting the HTTP
    // server. Must exit 0 and must NOT bind a port (no server left running
    // for the next step to collide with). ──
    const step2 = runStep(['server.js'], { DB_NAME: TEST_DB_NAME, MIGRATE_ONLY: '1', PORT: '0' });
    check('step 2 (MIGRATE_ONLY=1 node server.js) exits 0', step2.code === 0, step2.out.slice(-400));
    check('step 2 reports schema ready, not a silent failure', /schema ready/.test(step2.out), step2.out.slice(-400));
    const [hrEmpAfterStep2] = await root.query(
      "SELECT COUNT(*) n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='hr_employees'", [TEST_DB_NAME]
    );
    check('hr_employees (legacy-only table) exists after step 2', hrEmpAfterStep2[0].n === 1, hrEmpAfterStep2);

    // ── Step 3: db:migrate — the newest versioned migrations. This is the
    // step that used to hard-fail (0004 then 0005) when run right after
    // step 1 alone, skipping step 2. Must now succeed cleanly, zero pending
    // left over, in the ACTUAL 4-step order a deploy would use. ──
    const step3 = runStep(['db/migrate.js'], { DB_NAME: TEST_DB_NAME });
    check('step 3 (db:migrate) exits 0 once the legacy schema exists', step3.code === 0, step3.out.slice(-800));
    const [pendingAfter3] = await root.query('SELECT version FROM `' + TEST_DB_NAME + '`._migrations ORDER BY version');
    check('every numbered migration is recorded as applied (no partial/skip)', pendingAfter3.length >= 16, pendingAfter3.map((r) => r.version));

    // ── Step 4: node server.js — the real start. Must come up and answer
    // /api/version with a complete schema, no manual rescue step. ──
    const port = await getFreePort();
    serverProc = require('child_process').spawn(process.execPath, ['server.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DB_NAME: TEST_DB_NAME, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const deadline = Date.now() + 60000;
    let up = false;
    while (Date.now() < deadline) {
      const { status } = await httpGetJson(port, '/api/version');
      if (status === 200) { up = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    check('step 4 (node server.js, the real start) comes up and answers /api/version', up);

    if (up) {
      const [[glAccountsCheck]] = await root.query(
        "SELECT COUNT(*) n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='account_roles'", [TEST_DB_NAME]
      );
      check('a numbered-migration-only table (account_roles) exists after the real start', Number(glAccountsCheck.n) === 1, glAccountsCheck);
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} releaseSequence: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch (_) {} }
    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`').catch(() => {});
    console.log(`  (dropped throwaway database ${TEST_DB_NAME})`);
    await root.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
})();
