'use strict';
/* Integration — Release-Candidate gate: prove the ACTUAL production run
 * command, not a hand-written approximation of it.
 *
 * `tests/integration/releaseSequence.test.js` already proves that the FOUR
 * underlying commands work in order on an empty database. It does that by
 * invoking each command itself. That leaves the most important question
 * unanswered: does the thing production actually executes run those commands,
 * in that order, and does it genuinely refuse to start the server when a step
 * fails?
 *
 * Before this gate the honest answer was "no": the Dockerfile's last line was
 * `CMD ["node", "server.js"]`, so the numbered migrations under db/migrations/
 * never ran in production at all. The live schema was only ever whatever
 * server.js's legacy runMigrations() happened to build at boot.
 *
 * This test drives `scripts/release-start.js` — the single definition of the
 * chain, invoked verbatim by the Dockerfile CMD and by `npm run
 * release:start` — against a genuinely empty throwaway database, and asserts:
 *
 *   1. The Dockerfile really does invoke this script (parsed from the file,
 *      not assumed). A green chain nobody wired up is worthless.
 *   2. On an empty DB the chain completes, in order, and the numbered
 *      migrations are genuinely recorded as applied.
 *   3. FAIL-CLOSED, proven by real breakage rather than by reading `set -e`:
 *      a deliberately corrupted migration makes step 2 exit non-zero, and the
 *      chain then does NOT proceed to start the server.
 *
 * Run: node tests/integration/releaseChain.test.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const { assertLocalTestEnvironment, TestHarnessError } = require('../helpers/testHarness');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 500) : ''); }
}

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

const TEST_DB_NAME = 'moroccan_taste_pos_release_chain_test';
const REPO_ROOT = path.join(__dirname, '..', '..');
const CHAIN_SCRIPT = path.join('scripts', 'release-start.js');

async function connectRoot() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: false,
  });
}

// Runs the real chain with step 3 (the long-lived HTTP server) suppressed, so
// the process terminates deterministically and this test never leaks a
// listener. Steps 0-2 — the entire fail-closed surface — run for real.
function runChain(extraEnv) {
  const r = spawnSync(process.execPath, [CHAIN_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DB_NAME: TEST_DB_NAME,
      MYSQL_DATABASE: TEST_DB_NAME,
      RELEASE_CHAIN_PROVISION_ONLY: '1',
      ...extraEnv,
    },
    timeout: 900000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    signal: r.signal,
  };
}

(async () => {
  assertTestEnvironment();
  console.log('\n═══ Release chain — the real production run command, empty DB, fail-closed ═══');

  let root = null;
  let corruptedFile = null;
  let corruptedOriginal = null;

  try {
    root = await connectRoot();

    // ── 1. The Dockerfile must actually invoke this chain ──
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const cmdLine = (dockerfile.match(/^CMD .*$/m) || [''])[0];
    check(
      'the Dockerfile CMD invokes scripts/release-start.js (the chain is genuinely wired into production, not just present in the repo)',
      /release-start\.js/.test(cmdLine),
      { cmdLine }
    );
    check(
      'the Dockerfile CMD no longer starts the bare server directly (which is what skipped every numbered migration)',
      !/^CMD\s*\[\s*"node"\s*,\s*"server\.js"\s*\]/.test(cmdLine),
      { cmdLine }
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    check(
      'package.json exposes the identical chain as `release:start` (one definition, not a second copy that can drift)',
      pkg.scripts['release:start'] === 'node scripts/release-start.js',
      { script: pkg.scripts['release:start'] }
    );

    // ── 2. Happy path on a genuinely empty database ──
    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`');
    await root.query('CREATE DATABASE `' + TEST_DB_NAME + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    console.log(`  (created genuinely empty database ${TEST_DB_NAME})`);

    const good = runChain();
    check('the real chain exits 0 on a genuinely empty database', good.status === 0, { status: good.status, tail: good.out.slice(-1500) });
    check('it ran the legacy provisioning step (1/3) before the numbered migrations', /1\/3 legacy schema provisioning/.test(good.out), { tail: good.out.slice(-800) });
    check('it ran the numbered migrations step (2/3)', /2\/3 numbered migrations/.test(good.out), { tail: good.out.slice(-800) });
    check('db:init was skipped by default (it is a deliberate bootstrap, not a per-start step)', /0\/3 db:init — skipped/.test(good.out), { tail: good.out.slice(-800) });

    const dbConn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: TEST_DB_NAME,
    });
    const [applied] = await dbConn.query('SELECT version FROM _migrations ORDER BY version');
    check(
      'the numbered migrations genuinely ran — _migrations records them (this is what production has NEVER had)',
      applied.length >= 10,
      { appliedCount: applied.length, versions: applied.map(r => r.version) }
    );
    const [legacyTable] = await dbConn.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('hr_employees','pos_orders','account_roles')`,
      [TEST_DB_NAME]
    );
    check(
      'both schema sources are present afterwards — legacy-only tables AND a numbered-migration-only table',
      legacyTable.length === 3,
      legacyTable.map(r => r.TABLE_NAME)
    );
    await dbConn.end();

    // ── 3. FAIL-CLOSED — proven by real breakage, not by reading `set -e` ──
    // Corrupt a numbered migration so step 2 genuinely fails, then confirm the
    // chain aborts BEFORE step 3. The migration is restored in `finally`.
    const migDir = path.join(REPO_ROOT, 'db', 'migrations');
    const candidates = fs.readdirSync(migDir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
    corruptedFile = path.join(migDir, candidates[candidates.length - 1]);
    corruptedOriginal = fs.readFileSync(corruptedFile, 'utf8');
    fs.writeFileSync(corruptedFile, corruptedOriginal + '\n\nTHIS IS NOT VALID SQL AT ALL;\n');

    // Reset to an empty DB so the corrupted migration is genuinely pending.
    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`');
    await root.query('CREATE DATABASE `' + TEST_DB_NAME + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');

    const broken = runChain();
    check(
      'a failing migration makes the whole chain exit NON-ZERO (fail closed)',
      broken.status !== 0 && broken.status != null,
      { status: broken.status, tail: broken.out.slice(-1200) }
    );
    check(
      'the chain says out loud that it is refusing to start the server on an incomplete schema',
      /will NOT be started on an incomplete schema/.test(broken.out),
      { tail: broken.out.slice(-1200) }
    );
    check(
      'step 3 (starting the server) was NEVER reached after the failure',
      !/3\/3 starting HTTP server/.test(broken.out),
      { tail: broken.out.slice(-1200) }
    );
    check(
      'the failure was the migration step specifically, not something earlier',
      /2\/3 numbered migrations/.test(broken.out) && /FAILED/.test(broken.out),
      { tail: broken.out.slice(-1200) }
    );
  } catch (e) {
    fail++;
    fails.push('UNEXPECTED EXCEPTION');
    console.error('UNEXPECTED EXCEPTION during test run:', e);
  } finally {
    if (corruptedFile && corruptedOriginal != null) {
      try {
        fs.writeFileSync(corruptedFile, corruptedOriginal);
        console.log(`  (restored ${path.basename(corruptedFile)})`);
      } catch (e) {
        console.error('  !! FAILED TO RESTORE ' + corruptedFile + ' — restore it manually from git: ' + e.message);
      }
    }
    if (root) {
      await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`').catch(() => {});
      console.log(`  (dropped throwaway database ${TEST_DB_NAME})`);
      await root.end().catch(() => {});
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} releaseChain: ${pass} passed, ${fail} failed`);
  if (fail) { fails.forEach(f => console.log('   failed:', f)); process.exit(1); }
  process.exit(0);
})();
