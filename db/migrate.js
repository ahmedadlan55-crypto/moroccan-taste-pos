/**
 * ─── Versioned SQL Migrations Runner ──────────────────────────────
 *
 * Reads .sql files from `db/migrations/` and applies any that haven't
 * been recorded in the `_migrations` table yet.
 *
 * Migration files MUST be named `NNNN_short_description.sql` (4-digit
 * zero-padded version + underscore + lowercase snake_case description).
 * Application order is alphabetical, which for zero-padded numbers
 * matches numerical order. Examples:
 *
 *   0001_baseline_marker.sql
 *   0002_unified_workflow.sql
 *   0010_audit_v2_table.sql
 *
 * Each file is run as ONE atomic statement-set: the runner reads the
 * whole file, splits on `;` (top-level only — see SQL splitter notes),
 * and executes statements in order. Either every statement succeeds
 * and the version is recorded, or the migration aborts with no row in
 * `_migrations` so it will be retried on next start.
 *
 * Design constraints intentionally honored:
 *   - Does NOT replace `db/init.js` or `server.js runMigrations()`.
 *     Those continue to manage the LEGACY schema. This runner sits
 *     alongside them and applies NEW migrations going forward.
 *   - Idempotent: running twice in a row is safe; already-applied
 *     versions are skipped.
 *   - Compatible with the existing pool from `db/connection.js`.
 *
 * Phased migration of legacy schema into versioned migrations will
 * happen in later phases — for now, this is purely additive.
 *
 * v6.8.0 — Phase 0 Foundation (Enterprise rebuild plan)
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const db   = require('./connection');
const { withMigrationLock } = require('./migrationLock');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = '_migrations';

// ─── 1. Ensure the bookkeeping table exists ──────────────────────────
async function _ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    VARCHAR(20)  NOT NULL PRIMARY KEY,
      filename   VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      checksum   VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// ─── 2. List on-disk migration files ─────────────────────────────────
function _listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{4}_[a-z0-9_]+\.sql$/i.test(f))
    .sort();
}

// ─── 3. Read which versions are already applied ──────────────────────
async function _appliedVersions() {
  const [rows] = await db.query(`SELECT version FROM ${MIGRATIONS_TABLE}`);
  return new Set(rows.map(r => r.version));
}

// ─── 3b. Read the full applied-version -> stored-checksum map ────────
async function _appliedChecksums() {
  const [rows] = await db.query(`SELECT version, checksum FROM ${MIGRATIONS_TABLE}`);
  const out = new Map();
  for (const r of rows) out.set(r.version, r.checksum);
  return out;
}

// ─── 4. Naive SQL splitter — top-level `;` only ──────────────────────
// MySQL doesn't allow multi-statement queries via mysql2 by default, so
// we split the file and execute statement by statement. The splitter is
// intentionally simple: it skips line comments (`-- ...`) and string
// literals (single- and double-quoted). It does NOT handle PROCEDURE /
// FUNCTION bodies with internal `;` — for those, wrap the whole body in
// a single CREATE PROCEDURE statement (no internal splits needed) or
// add `multipleStatements: true` to the connection config when the time
// comes. For now, keep migrations limited to plain DDL/DML.
function _splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const N = sql.length;
  while (i < N) {
    const c = sql[i];
    // Line comment `-- ...` until newline
    if (c === '-' && sql[i + 1] === '-') {
      while (i < N && sql[i] !== '\n') i++;
      continue;
    }
    // Block comment `/* ... */`
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < N && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Quoted string — copy verbatim, including escapes
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      buf += c; i++;
      while (i < N) {
        const cc = sql[i];
        buf += cc;
        if (cc === '\\' && i + 1 < N) { buf += sql[i + 1]; i += 2; continue; }
        if (cc === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === ';') {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

function _checksum(content) {
  // Plain length + simple sum — not cryptographically meaningful, just
  // a sanity check that no one edited an already-applied migration.
  // If they did, we log a warning rather than refuse to start.
  let sum = 0;
  for (let i = 0; i < content.length; i++) sum = (sum + content.charCodeAt(i)) | 0;
  return content.length.toString(16) + ':' + (sum >>> 0).toString(16);
}

// ─── 5. Apply one migration file ─────────────────────────────────────
async function _applyMigration(filename, logger) {
  const version = filename.match(/^(\d{4})_/)[1];
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const content = fs.readFileSync(fullPath, 'utf8');
  const statements = _splitStatements(content);

  logger.info({ event: 'migration_start', version, filename, stmtCount: statements.length }, 'applying migration');

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      await db.query(stmt);
    } catch (e) {
      logger.error({ event: 'migration_failed', version, filename, stmtIndex: i, error: e.message },
        'migration statement failed — aborting (will retry next start)');
      throw e;
    }
  }

  await db.query(
    `INSERT INTO ${MIGRATIONS_TABLE} (version, filename, checksum) VALUES (?, ?, ?)`,
    [version, filename, _checksum(content)]
  );
  logger.info({ event: 'migration_applied', version, filename }, 'migration applied');
}

// ─── 6. Main entry — run pending migrations ──────────────────────────
//
// CO-5: this is step 2/3 of the release chain and it is a SEPARATE process from
// step 1/3 (MIGRATE_ONLY=1 node server.js). B5's advisory lock only ever wrapped
// step 1, so two overlapping deploys serialized on the legacy schema and then
// both ran the numbered DDL migrations at the same time. The lock is now taken
// here too, from the shared db/migrationLock.js under the same name, so the
// whole chain is serialized end to end.
//
// Pass { lock: false } to run unlocked — used only by the migration-lifecycle
// test's deliberate concurrency scenarios, never on any production path.
async function runPendingMigrations(opts) {
  opts = opts || {};
  if (opts.lock !== false) {
    return withMigrationLock(
      () => runPendingMigrations(Object.assign({}, opts, { lock: false })),
      { logger: opts.logger || _defaultLogger() }
    );
  }
  const logger = opts.logger || _defaultLogger();
  try {
    await _ensureMigrationsTable();
    const onDisk = _listMigrationFiles();
    const applied = await _appliedVersions();
    const pending = onDisk.filter(f => {
      const version = f.match(/^(\d{4})_/)[1];
      return !applied.has(version);
    });

    // Tier A.2 corrective gate — this used to compute+store a checksum on
    // every apply (_applyMigration below) but never read it back for
    // comparison, despite a comment claiming drift would be caught. Real
    // check now: for every ALREADY-APPLIED file still on disk, recompute
    // its current checksum and compare against what was recorded at apply
    // time. A mismatch means the file was edited after being applied
    // somewhere — never silently ignored, but also never a hard failure
    // (the DB is already in whatever state that migration left it in; a
    // dead process wouldn't fix that) — logged as an explicit warning with
    // both checksums, once, every run, until someone resolves it.
    const appliedChecksums = await _appliedChecksums();
    const driftedVersions = [];
    for (const f of onDisk) {
      const version = f.match(/^(\d{4})_/)[1];
      const storedChecksum = appliedChecksums.get(version);
      if (storedChecksum == null) continue; // not applied yet — nothing to compare
      const onDiskChecksum = _checksum(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      if (onDiskChecksum !== storedChecksum) {
        driftedVersions.push({ version, filename: f, storedChecksum, onDiskChecksum });
      }
    }
    if (driftedVersions.length) {
      logger.warn(
        { event: 'migration_checksum_drift', count: driftedVersions.length, drifted: driftedVersions },
        'checksum drift: ' + driftedVersions.length + ' already-applied migration file(s) were edited after being applied — the database was NOT re-run against the new content (already-applied migrations are never re-executed); review the diff manually.'
      );
    }

    if (pending.length === 0) {
      logger.info({ event: 'migrations_up_to_date', onDisk: onDisk.length }, 'no pending migrations');
      return { applied: [], pending: [], drifted: driftedVersions };
    }

    logger.info({ event: 'migrations_pending', count: pending.length, files: pending },
      'applying pending migrations');

    const appliedNow = [];
    for (const file of pending) {
      await _applyMigration(file, logger);
      appliedNow.push(file);
    }

    return { applied: appliedNow, pending: [], drifted: driftedVersions };
  } catch (e) {
    logger.error({ event: 'migrate_runner_error', error: e.message }, 'migration runner failed');
    throw e;
  }
}

// ─── 7. Fallback logger when called directly from CLI ────────────────
function _defaultLogger() {
  try {
    return require('../lib/logger');
  } catch (_) {
    return {
      info: (obj, msg) => console.log('[migrate]', msg || obj, obj && obj.event ? JSON.stringify(obj) : ''),
      warn: (obj, msg) => console.warn('[migrate]', msg || obj, obj && obj.event ? JSON.stringify(obj) : ''),
      error: (obj, msg) => console.error('[migrate]', msg || obj, obj && obj.event ? JSON.stringify(obj) : '')
    };
  }
}

// ─── 8. CLI: `node db/migrate.js` ────────────────────────────────────
if (require.main === module) {
  (async () => {
    try {
      const result = await runPendingMigrations();
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (e) {
      console.error('Migration failed:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  runPendingMigrations,
  // Exported for tests
  _splitStatements,
  _checksum
};
