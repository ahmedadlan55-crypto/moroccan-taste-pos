'use strict';
/**
 * Isolated test-database harness — Tier A.2 Corrective Gate, item 0.2.
 *
 * The Tier A.1 integration tests (trialBalance.api.test.js,
 * trialBalanceEngine.test.js, accountRoles.test.js, journalMakerChecker.test.js)
 * wrote fixture rows directly into the REAL `moroccan_taste_pos` dev database
 * through db/connection.js's shared pool. Their "assertTestEnvironment()"
 * guards only checked DATABASE_URL/MYSQL_URL/MYSQLHOST and that DB_NAME
 * equalled the real dev DB name — never that DB_HOST was actually local, and
 * never routing to a genuinely separate database. This module is the fix:
 * every test file that touches the database MUST require this module FIRST
 * (before `require('../../db/connection')` anywhere in the process) and
 * call `activate()` — it rewrites `process.env.DB_NAME` to a dedicated
 * `..._test`-suffixed database BEFORE db/connection.js's module-level pool
 * is ever constructed, so the pool that pool that gets created is already
 * bound to the isolated database from its very first connection.
 *
 * Usage (must be the FIRST lines of a test file, before any other require
 * that might transitively pull in db/connection.js):
 *
 *   require('dotenv').config();
 *   const harness = require('../helpers/testHarness');
 *   harness.activate();
 *   const db = require('../../db/connection'); // now bound to the test DB
 *
 *   (async () => {
 *     await harness.ensureSchema(); // only needed if this file never spawns
 *                                   // its own server.js child (see below)
 *     ...
 *   })();
 *
 * For files that spawn their own `node server.js` child for HTTP calls
 * (the existing pattern), use `harness.spawnServer()` instead of hand-rolling
 * child_process.spawn — it allocates a real free port (no more hardcoded
 * 3988/3989-style ports colliding with a leftover process) and verifies the
 * FIRST successful /api/version response actually came from the process it
 * just spawned (via a random token round-tripped through the response —
 * see server.js's /api/version handler), not a stale server that happened
 * to already be listening on the reused port.
 */

const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

const REPO_ROOT = path.join(__dirname, '..', '..');

class TestHarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TestHarnessError';
  }
}

/**
 * Refuses to proceed unless every signal says "this is an isolated local
 * test database" — not the developer's real local DB, and absolutely never
 * anything that could be a remote/production connection.
 */
function assertLocalTestEnvironment() {
  const looksRemote = !!(process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQLHOST);
  if (looksRemote) {
    throw new TestHarnessError(
      'REFUSING TO RUN: DATABASE_URL/MYSQL_URL/MYSQLHOST is set — this looks like a remote/managed ' +
      'database connection string, which this harness must never write fixture data into.'
    );
  }
  const host = process.env.DB_HOST || 'localhost';
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new TestHarnessError(
      `REFUSING TO RUN: DB_HOST is "${host}", not literally "localhost" or "127.0.0.1". ` +
      'Tests only ever run against a local MySQL server.'
    );
  }
}

function deriveTestDbName() {
  const base = process.env.DB_NAME || 'moroccan_taste_pos';
  return base.endsWith('_test') ? base : base + '_test';
}

let _activated = false;
/**
 * MUST be called before the first `require('../../db/connection')` anywhere
 * in the process — rewrites process.env.DB_NAME to the isolated test
 * database name and strips any remote-connection env vars, so the shared
 * pool db/connection.js creates on its first require is already bound to
 * the isolated database.
 * @returns {string} the test database name now active in process.env.DB_NAME
 */
function activate() {
  assertLocalTestEnvironment();
  const testDbName = deriveTestDbName();
  process.env.DB_NAME = testDbName;
  delete process.env.DATABASE_URL;
  delete process.env.MYSQL_URL;
  delete process.env.MYSQLHOST;
  delete process.env.MYSQL_DATABASE;
  delete process.env.MYSQLDATABASE;
  _activated = true;
  return testDbName;
}

function requireActivated() {
  if (!_activated) {
    throw new TestHarnessError('testHarness.activate() must be called before this function.');
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

/** Creates the isolated test database (empty shell) if it doesn't exist yet. */
async function createTestDatabaseIfMissing() {
  requireActivated();
  const dbName = process.env.DB_NAME;
  const root = await connectRoot();
  try {
    await root.query('CREATE DATABASE IF NOT EXISTS `' + dbName + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  } finally {
    await root.end();
  }
  return dbName;
}

/** Returns a genuinely free TCP port by binding to port 0 and reading it back. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGetJson(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

/**
 * Spawns `node server.js` bound to the isolated test database, on a freshly
 * allocated free port, with a random harness token. Resolves once
 * /api/version answers 200 AND echoes back the SAME token — proving this
 * exact response came from the process just spawned, not a stale server
 * left listening on a reused port.
 *
 * @param {object} [opts]
 * @param {object} [opts.extraEnv] additional env vars for the child
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{proc: import('child_process').ChildProcess, port: number, kill: () => void}>}
 */
async function spawnServer(opts) {
  requireActivated();
  opts = opts || {};
  const port = await getFreePort();
  const token = crypto.randomBytes(12).toString('hex');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), TEST_HARNESS_TOKEN: token, ...(opts.extraEnv || {}) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const deadline = Date.now() + (opts.timeoutMs || 60000);
  let up = false;
  while (Date.now() < deadline) {
    const { status, json } = await httpGetJson(port, '/api/version');
    if (status === 200 && json && json.harnessToken === token) { up = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) {
    try { proc.kill(); } catch (_) {}
    throw new TestHarnessError(`server.js did not become ready (with matching harness token) on port ${port} within the timeout.`);
  }
  return { proc, port, kill: () => { try { proc.kill(); } catch (_) {} } };
}

/**
 * For test files that never spawn their own server.js child (they call
 * engine/service functions directly against db/connection.js) but still
 * need the isolated test database's schema fully provisioned first:
 * spawns a throwaway server (which runs the full autoInitDB() migration
 * sequence before its port opens — server.js guarantees this, see the
 * comment above its app.listen() call), waits for it to come up, then
 * kills it immediately. Idempotent — safe to call every test run; the
 * schema only actually gets created once, on the first ever call against
 * a fresh test database.
 */
async function ensureSchema() {
  requireActivated();
  await createTestDatabaseIfMissing();
  const { kill } = await spawnServer({ timeoutMs: 120000 });
  kill();
  // give the child a moment to release its DB pool connections before the
  // caller opens its own — avoids a noisy (harmless) connection-reset race.
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * server.js's boot sequence creates every TABLE but seeds no chart-of-
 * accounts rows — lib/glPosting.js#ensureCoreAccounts() only runs lazily,
 * on the first postJournal() call. Many fixtures (this repo's existing
 * tests included) assume baseline accounts like code='111'/'1110'/'4100'
 * already exist. Call this once, against the now-activated test database,
 * after ensureSchema() (or after your own spawned server has come up), to
 * seed the same ~28 legacy CORE_ACCOUNTS the real dev DB already has —
 * reuses the existing, already-proven seeding function instead of a
 * parallel hand-rolled fixture set.
 * @param {object} db - a pool/connection (db/connection.js, already bound
 *   to the test database via activate())
 */
async function ensureCoreAccounts(db) {
  requireActivated();
  const glPosting = require('../../lib/glPosting');
  await glPosting.ensureCoreAccounts(db);
}

/**
 * Applies specific numbered migration file(s) from db/migrations/ against
 * the (now-activated) isolated test database, idempotently — skips any
 * version already recorded in _migrations. server.js's boot sequence
 * (ensureSchema()) provisions everything the LEGACY runMigrations() path
 * creates, but tables that only exist via a versioned db/migrations/*.sql
 * file (account_roles/account_role_history, for example — see ADR 0002)
 * are NOT created by ensureSchema() alone and need this.
 * @param {object} db - pool/connection bound to the test database
 * @param {string[]} filenames - e.g. ['0018_account_role_registry.sql', '0019_account_role_registry_scope_fix.sql']
 */
async function applyMigrations(db, filenames) {
  requireActivated();
  const fs = require('fs');
  const path2 = require('path');
  const { _splitStatements, _checksum } = require('../../db/migrate');
  await db.query(
    'CREATE TABLE IF NOT EXISTS _migrations (version VARCHAR(20) NOT NULL PRIMARY KEY, filename VARCHAR(255) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, checksum VARCHAR(64)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
  for (const filename of filenames) {
    const version = filename.match(/^(\d{4})_/)[1];
    const [already] = await db.query('SELECT version FROM _migrations WHERE version = ?', [version]);
    if (already.length) continue;
    const fullPath = path2.join(REPO_ROOT, 'db', 'migrations', filename);
    const content = fs.readFileSync(fullPath, 'utf8');
    for (const stmt of _splitStatements(content)) await db.query(stmt);
    await db.query('INSERT INTO _migrations (version, filename, checksum) VALUES (?, ?, ?)', [version, filename, _checksum(content)]);
  }
}

module.exports = {
  TestHarnessError,
  assertLocalTestEnvironment,
  deriveTestDbName,
  activate,
  createTestDatabaseIfMissing,
  getFreePort,
  spawnServer,
  ensureSchema,
  ensureCoreAccounts,
  applyMigrations,
};
