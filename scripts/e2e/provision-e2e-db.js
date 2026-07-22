#!/usr/bin/env node
'use strict';
/* ─── Provision the isolated E2E database ────────────────────────────────────
 *
 * WHY THIS EXISTS
 *   Both Playwright configs used to launch `node server.js` with no DB_NAME
 *   override, so every E2E run — the 104-leaf closure gate, the POS sell flow,
 *   the RBAC specs, every screenshot — executed against the REAL development
 *   database. That is why:
 *     • the release-candidate gate could not honestly claim "zero writes to the
 *       development database";
 *     • the POS visual baselines drifted for reasons that had nothing to do
 *       with the UI (the product catalog they photograph kept changing);
 *     • test state accumulated across runs, so "passes in isolation" and
 *       "fails in the suite" could both be true at once.
 *
 * WHAT IT DOES
 *   Clones the development database into a throwaway `..._e2e` database. The
 *   development database is only ever READ (mysqldump), never written. Every
 *   E2E run therefore starts from an identical, known snapshot, and anything a
 *   test writes dies with the clone.
 *
 * SAFETY
 *   Refuses to run unless the host is local AND the target name ends in
 *   `_e2e` AND the target is not the source. It DROPs the target, so those
 *   guards are the only thing standing between this and someone's real data —
 *   they are deliberately paranoid and deliberately not overridable by a flag.
 *
 * USAGE
 *   node scripts/e2e/provision-e2e-db.js          # clone dev -> dev_e2e
 *   E2E_DB_NAME=... node scripts/e2e/provision-e2e-db.js
 *   Playwright calls this from its globalSetup; see playwright.*.config.ts.
 * ────────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const HOST = process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.DB_PORT) || 3306;
const USER = process.env.DB_USER || 'root';
const PASS = process.env.DB_PASSWORD || '';
const SOURCE_DB = process.env.DB_NAME || 'moroccan_taste_pos';
const TARGET_DB = process.env.E2E_DB_NAME || `${SOURCE_DB}_e2e`;

function fail(msg) {
  console.error('[e2e-db] REFUSING: ' + msg);
  process.exit(2);
}

function guard() {
  if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
    fail(`DB_HOST is "${HOST}". This script DROPs a database and only runs against a local server.`);
  }
  for (const v of ['DATABASE_URL', 'MYSQL_URL', 'MYSQLHOST']) {
    if (process.env[v]) fail(`${v} is set — that indicates a managed/remote database. Refusing.`);
  }
  if (!/_e2e$/.test(TARGET_DB)) {
    fail(`target "${TARGET_DB}" does not end in _e2e. The DROP target must be unmistakably a throwaway.`);
  }
  if (TARGET_DB === SOURCE_DB) fail('target and source are the same database.');
}

/** Locate mysqldump/mysql. PATH first, then the standard Windows install. */
function findBinary(name) {
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return name;
  const candidates = [
    `C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\${name}.exe`,
    `C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\${name}.exe`,
    '/usr/bin/' + name,
    '/usr/local/bin/' + name,
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  fail(`could not find "${name}" on PATH or in the usual install locations.`);
  return null;
}

(async () => {
  guard();

  const root = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS });
  const [[srcExists]] = await root.query(
    'SELECT COUNT(*) n FROM information_schema.schemata WHERE schema_name = ?', [SOURCE_DB],
  );
  if (!srcExists.n) fail(`source database "${SOURCE_DB}" does not exist.`);

  const started = Date.now();
  console.log(`[e2e-db] cloning ${SOURCE_DB} -> ${TARGET_DB} (source is READ-ONLY)`);

  await root.query('DROP DATABASE IF EXISTS `' + TARGET_DB + '`');
  await root.query('CREATE DATABASE `' + TARGET_DB + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');

  const dumpBin = findBinary('mysqldump');
  const mysqlBin = findBinary('mysql');
  const dumpFile = path.join(os.tmpdir(), `mt-e2e-clone-${process.pid}.sql`);

  // --set-gtid-purged=OFF keeps the dump replayable into a plain local server.
  // --routines/--events are included for completeness even though this schema
  // currently has none, so adding one later does not silently skip the clone.
  const dumpArgs = [
    `--host=${HOST}`, `--port=${PORT}`, `--user=${USER}`,
    '--single-transaction', '--quick', '--routines', '--events', '--triggers',
    '--set-gtid-purged=OFF', '--column-statistics=0',
    '--result-file=' + dumpFile,
    SOURCE_DB,
  ];
  if (PASS) dumpArgs.splice(3, 0, `--password=${PASS}`);

  let d = spawnSync(dumpBin, dumpArgs, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  // Older/newer builds disagree on --column-statistics; retry once without it.
  if (d.status !== 0 && /column-statistics/i.test(String(d.stderr))) {
    d = spawnSync(dumpBin, dumpArgs.filter((a) => a !== '--column-statistics=0'),
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  }
  if (d.status !== 0) {
    fail('mysqldump failed: ' + String(d.stderr || d.error).slice(0, 500));
  }

  const restoreArgs = [`--host=${HOST}`, `--port=${PORT}`, `--user=${USER}`, TARGET_DB];
  if (PASS) restoreArgs.splice(3, 0, `--password=${PASS}`);
  const sql = fs.readFileSync(dumpFile);
  const r = spawnSync(mysqlBin, restoreArgs, { input: sql, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  try { fs.unlinkSync(dumpFile); } catch { /* best effort */ }
  if (r.status !== 0) {
    fail('restore failed: ' + String(r.stderr).slice(0, 500));
  }

  const target = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS, database: TARGET_DB });
  const [[tables]] = await target.query(
    'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ?', [TARGET_DB],
  );
  const [[users]] = await target.query('SELECT COUNT(*) n FROM users');
  // Sanity-check the clone actually carries the data the E2E specs depend on,
  // instead of reporting success for an empty shell.
  const [[items]] = await target.query('SELECT COUNT(*) n FROM inv_items').catch(() => [[{ n: -1 }]]);
  const [[menu]] = await target.query('SELECT COUNT(*) n FROM menu').catch(() => [[{ n: -1 }]]);
  await target.end();
  await root.end();

  if (tables.n < 50) fail(`clone has only ${tables.n} tables — that is not a complete copy.`);
  if (users.n < 1) fail('clone has no users — the E2E specs cannot authenticate.');

  console.log(
    `[e2e-db] ready: ${TARGET_DB} — ${tables.n} tables, ${users.n} users, ` +
    `${items.n} inventory items, ${menu.n} menu rows (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  process.exit(0);
})().catch((e) => {
  console.error('[e2e-db] ERROR:', e && e.message);
  process.exit(1);
});
