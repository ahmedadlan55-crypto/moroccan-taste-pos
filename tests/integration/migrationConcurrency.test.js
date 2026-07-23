/**
 * ─── CO-5 — the release chain must be concurrency-safe END TO END ────
 *
 * B5 put an advisory lock around step 1/3 of the release chain (the legacy
 * runMigrations() inside `MIGRATE_ONLY=1 node server.js`). It did NOT cover
 * step 2/3 — `node db/migrate.js`, which applies the numbered DDL migrations
 * in a completely separate process. Two overlapping deploys therefore queued
 * politely on the legacy schema and then both ran the same ALTERs at once.
 *
 * This test proves the gap is closed, and proves it by RACING REAL PROCESSES
 * against a real database rather than by asserting that a lock function exists.
 *
 * Checks:
 *   1. withMigrationLock is fail-closed: if the lock is already held, it THROWS
 *      instead of proceeding unlocked. (Held on a foreign connection, 1s timeout.)
 *   2. The lock is released afterwards — the next caller gets it immediately.
 *   3. The lock name is scoped per database, so a run against an isolated test
 *      schema cannot be blocked by an unrelated run on the same mysqld.
 *   4. TWO concurrent `node db/migrate.js` processes against one fresh database
 *      both exit 0, and exactly ONE of them reports applying migrations — the
 *      other finds them already applied. Unserialized, both would attempt the
 *      same DDL and at least one would die on a duplicate-object error.
 *   5. `_migrations` ends up with exactly one row per migration file: no
 *      duplicates, no gaps, no partial application.
 *   6. server.js and db/migrate.js take the lock from the SAME shared module,
 *      so the two chain steps cannot drift apart into two different names.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const { execFile } = require('child_process');

const { assertLocalTestEnvironment, TestHarnessError } = require('../helpers/testHarness');

const ROOT = path.join(__dirname, '..', '..');
const TEST_DB_NAME = 'moroccan_taste_pos_migration_concurrency_test';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (detail ? '  — ' + detail : '')); }
}

function assertTestEnvironment() {
  try { assertLocalTestEnvironment(); }
  catch (e) {
    if (e instanceof TestHarnessError) {
      console.error('REFUSING TO RUN:', e.message, 'This test CREATEs/DROPs a throwaway database and must only run against a local MySQL server.');
      process.exit(2);
    }
    throw e;
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

// Run `node db/migrate.js` as a real child process against the throwaway DB.
// Resolves (never rejects) with the full outcome so a race can be inspected.
function runMigrateProcess(label) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, {
      DB_NAME: TEST_DB_NAME,
      MYSQL_DATABASE: TEST_DB_NAME,
      MYSQLDATABASE: TEST_DB_NAME,
    });
    delete env.DATABASE_URL; delete env.MYSQL_URL; delete env.MYSQLHOST;
    const startedAt = Date.now();
    execFile(process.execPath, [path.join(ROOT, 'db', 'migrate.js')],
      { cwd: ROOT, env, timeout: 600000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          label,
          code: err ? (err.code == null ? 1 : err.code) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          ms: Date.now() - startedAt,
        });
      });
  });
}

// How many migrations did THIS process actually apply?
//
// Not parsed from the CLI's final JSON blob: db/migrate.js also writes pino
// log lines to stdout, so a naive first-`{`..last-`}` slice spans both and
// yields nothing. The runner emits one structured `migration_applied` event per
// file it applies, which is the direct, unambiguous signal.
function appliedCount(out) {
  return (out.match(/"event"\s*:\s*"migration_applied"/g) || []).length;
}

/** Epoch-ms of the LAST pino line carrying `event`, or null if it never appears. */
function lastTime(out, event) {
  let latest = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.indexOf('"' + event + '"') === -1) continue;
    const m = line.match(/"time"\s*:\s*"([^"]+)"/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

(async () => {
  assertTestEnvironment();
  const root = await connectRoot();
  let holder = null;
  try {
    console.log('\n═══ CO-5 migration-chain concurrency (isolated test DB) ═══');

    await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`');
    await root.query('CREATE DATABASE `' + TEST_DB_NAME + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    console.log(`  (created throwaway database ${TEST_DB_NAME})`);

    process.env.DB_NAME = TEST_DB_NAME;
    process.env.MYSQL_DATABASE = TEST_DB_NAME;
    process.env.MYSQLDATABASE = TEST_DB_NAME;
    delete process.env.DATABASE_URL; delete process.env.MYSQL_URL; delete process.env.MYSQLHOST;

    const { withMigrationLock, lockName } = require('../../db/migrationLock');

    // ── 1+2. Fail-closed, then released ────────────────────────────────
    const LOCK = lockName();
    holder = await connectRoot();
    const [held] = await holder.query('SELECT GET_LOCK(?, 5) AS got', [LOCK]);
    check('a foreign connection can take the lock (setup)', Number(held[0].got) === 1);

    let ranWhileHeld = false;
    let lockError = null;
    try {
      await withMigrationLock(async () => { ranWhileHeld = true; }, { timeoutSeconds: 1 });
    } catch (e) { lockError = e; }

    check('withMigrationLock THROWS when the lock is already held (fail-closed)',
      lockError !== null, lockError ? '' : 'it returned normally');
    check('the guarded work did NOT run while the lock was held',
      ranWhileHeld === false, ranWhileHeld ? 'the callback executed unlocked' : '');
    check('the error names the lock and the timeout',
      !!lockError && /migration advisory lock/.test(lockError.message) && lockError.message.includes(LOCK),
      lockError ? lockError.message : '');

    await holder.query('SELECT RELEASE_LOCK(?)', [LOCK]);
    let ranAfterRelease = false;
    await withMigrationLock(async () => { ranAfterRelease = true; }, { timeoutSeconds: 5 });
    check('the lock is acquirable again once released', ranAfterRelease === true);

    // withMigrationLock must also RELEASE what it took — a second, independent
    // acquisition on a foreign connection proves it did not leak the lock.
    const [after] = await holder.query('SELECT GET_LOCK(?, 3) AS got', [LOCK]);
    check('withMigrationLock releases the lock when its work finishes',
      Number(after[0].got) === 1, 'a foreign connection could not re-take it');
    await holder.query('SELECT RELEASE_LOCK(?)', [LOCK]);

    // ── 3. Per-database scoping ────────────────────────────────────────
    check('the lock name is scoped to the target database',
      LOCK === 'mt_pos_migrations:' + TEST_DB_NAME, 'got ' + LOCK);
    check('a different database yields a different lock name',
      lockName('some_other_db') !== LOCK);

    // ── 6. ONE shared definition across both chain steps ───────────────
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const migrateSrc = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
    check('server.js (chain step 1/3) takes the lock from db/migrationLock.js',
      /require\(['"]\.\/db\/migrationLock['"]\)/.test(serverSrc));
    check('db/migrate.js (chain step 2/3) takes the lock from the same module',
      /require\(['"]\.\/migrationLock['"]\)/.test(migrateSrc));
    check('neither step defines its own GET_LOCK call any more',
      !/GET_LOCK/.test(serverSrc) && !/GET_LOCK/.test(migrateSrc),
      'a private lock implementation survived');

    // ── 4. Race two REAL migrate processes ─────────────────────────────
    // The numbered migrations ALTER tables that only the legacy provisioning
    // step creates, so give the throwaway DB that baseline first — exactly as
    // the release chain does — then race step 2/3 against itself.
    console.log('  (provisioning the legacy baseline — chain step 1/3, this takes ~2 min)');
    const provision = await new Promise((resolve) => {
      const env = Object.assign({}, process.env, { MIGRATE_ONLY: '1', DB_NAME: TEST_DB_NAME, MYSQL_DATABASE: TEST_DB_NAME, MYSQLDATABASE: TEST_DB_NAME });
      delete env.DATABASE_URL; delete env.MYSQL_URL; delete env.MYSQLHOST;
      execFile(process.execPath, [path.join(ROOT, 'server.js')],
        { cwd: ROOT, env, timeout: 600000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ code: err ? (err.code == null ? 1 : err.code) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
    check('legacy provisioning (step 1/3) succeeded', provision.code === 0,
      'exit ' + provision.code + ' :: ' + provision.stderr.slice(-400));

    console.log('  (racing two concurrent `node db/migrate.js` processes)');
    const [a, b] = await Promise.all([runMigrateProcess('A'), runMigrateProcess('B')]);

    check('both concurrent migrate processes exited 0',
      a.code === 0 && b.code === 0,
      `A=${a.code} B=${b.code} :: ${(a.stderr + b.stderr).slice(-500)}`);

    const na = appliedCount(a.stdout), nb = appliedCount(b.stdout);
    check('exactly one process applied the migrations; the other found none pending',
      (na > 0 && nb === 0) || (nb > 0 && na === 0),
      `applied counts A=${na} B=${nb} (both > 0 means they ran the same DDL concurrently)`);

    // Non-overlap, proven from the processes' OWN timestamps rather than from
    // wall-clock totals: the process that waited must have taken the lock only
    // AFTER the other one finished applying its last migration.
    const applier = na > 0 ? a : b;
    const waiter  = na > 0 ? b : a;
    const lastApplied = lastTime(applier.stdout, 'migration_applied');
    const waiterGotLock = lastTime(waiter.stdout, 'migration_lock_acquired');
    check('the waiting process acquired the lock only AFTER the other finished applying',
      lastApplied !== null && waiterGotLock !== null && waiterGotLock >= lastApplied,
      `applier's last migration_applied=${lastApplied}, waiter's lock_acquired=${waiterGotLock}`);

    check('neither process hit a duplicate-object error',
      !/ER_DUP_(ENTRY|FIELDNAME|KEYNAME)|Duplicate (column|key|entry)/i.test(a.stdout + a.stderr + b.stdout + b.stderr),
      'a duplicate error appeared — the two runs overlapped');

    // ── 5. Exactly one _migrations row per file, no duplicates ──────────
    const target = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: TEST_DB_NAME,
    });
    const onDisk = fs.readdirSync(path.join(ROOT, 'db', 'migrations'))
      .filter(f => /^\d{4}_[a-z0-9_]+\.sql$/i.test(f));
    const [rows] = await target.query('SELECT version, COUNT(*) c FROM _migrations GROUP BY version');
    const dupes = rows.filter(r => Number(r.c) !== 1);
    check('_migrations has no duplicated version rows', dupes.length === 0, JSON.stringify(dupes));
    check(`_migrations recorded every on-disk migration (${onDisk.length})`,
      rows.length === onDisk.length, `recorded ${rows.length} of ${onDisk.length}`);
    await target.end();

    console.log(`\n  (A: ${a.ms}ms, B: ${b.ms}ms — serialized, not parallel)`);
  } finally {
    if (holder) { try { await holder.end(); } catch (_) {} }
    try { await root.query('DROP DATABASE IF EXISTS `' + TEST_DB_NAME + '`'); } catch (_) {}
    try { await root.end(); } catch (_) {}
    try { require('../../db/connection').end(); } catch (_) {}
  }

  console.log(`\nCO-5 migration concurrency: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
