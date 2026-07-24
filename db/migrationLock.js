/**
 * ─── Migration advisory lock — ONE definition for the WHOLE chain ───
 *
 * The release chain (scripts/release-start.js) mutates the schema in TWO
 * separate processes:
 *
 *   step 1/3  MIGRATE_ONLY=1 node server.js   → legacy runMigrations()
 *   step 2/3  node db/migrate.js              → numbered db/migrations/*.sql
 *
 * B5 added a lock around step 1 only. That left step 2 completely unserialized:
 * two containers starting at once (a Railway redeploy overlapping the old
 * instance, or a scaled replica set) would correctly queue on step 1 and then
 * BOTH run the numbered migrations concurrently. Numbered migrations are not
 * merely "seed twice" hazards — several are DDL, and two connections issuing
 * the same ALTER race to a duplicate-column / duplicate-key error that aborts
 * the file with no `_migrations` row, i.e. a fail-closed crash loop on every
 * deploy where timing happens to overlap.
 *
 * So the lock lives here, is imported by both steps, and uses the same name in
 * both — the two steps serialize against each other as well as against their
 * own concurrent copies.
 *
 * SCOPING: MySQL user-level locks (GET_LOCK) live in a SERVER-wide namespace,
 * not per-schema. A bare 'mt_pos_migrations' would make a migration run against
 * an isolated test database block on an unrelated run against dev on the same
 * mysqld. The name is therefore qualified with the target database, so runs
 * contend if and only if they would actually touch the same schema.
 *
 * FAIL-CLOSED: GET_LOCK returns 1 (acquired), 0 (timed out), or NULL (error /
 * killed). Anything other than 1 THROWS — we never proceed to migrate without
 * holding the lock, and we never silently skip migrations.
 *
 * The lock is held on a DEDICATED connection for the whole run: MySQL scopes
 * user-level locks to the connection, so taking it on a pooled connection that
 * gets recycled mid-run would silently release it.
 */
'use strict';

const crypto = require('crypto');
const db = require('./connection');

const LOCK_TIMEOUT_SECONDS = 600;
// MySQL user-level lock names (GET_LOCK/RELEASE_LOCK) are capped at 64
// characters since 5.7.5 — a longer name makes GET_LOCK THROW
// ("...should not exceed 64 characters"), which in withMigrationLock() aborts
// the whole run before a single migration is applied. `mt_pos_migrations:` is
// 18 chars, so any target database name longer than 46 chars would blow the
// cap. Real dev/prod names are short, but a long one (or a long throwaway test
// DB) must NOT turn a length limit into a fail-closed migration crash.
const MAX_LOCK_NAME = 64;
const LOCK_PREFIX = 'mt_pos_migrations:';

/**
 * The lock name actually used for a given database. Exported for tests.
 *
 * Deterministic and stable for a given target (the release chain's step 1 and
 * step 2 must derive the SAME name to serialize against each other). When the
 * plain `prefix + target` would exceed MySQL's 64-char limit, keep as much of
 * the readable target as fits and append a short, deterministic SHA-1 of the
 * FULL target so distinct schemas still get distinct locks.
 */
function lockName(dbName) {
  const target = dbName
    || process.env.MYSQL_DATABASE
    || process.env.MYSQLDATABASE
    || process.env.DB_NAME
    || 'default';
  const full = LOCK_PREFIX + target;
  if (full.length <= MAX_LOCK_NAME) return full;
  const hash = crypto.createHash('sha1').update(target).digest('hex').slice(0, 12);
  // prefix(18) + head + ':'(1) + hash(12) must stay <= 64 → head <= 33.
  const room = MAX_LOCK_NAME - LOCK_PREFIX.length - 1 - hash.length;
  return LOCK_PREFIX + target.slice(0, Math.max(0, room)) + ':' + hash;
}

/**
 * Run `fn` while holding the migration advisory lock.
 *
 * @param {Function} fn     the migration work; its return value is passed through
 * @param {Object}   [opts] { dbName, timeoutSeconds, logger }
 */
async function withMigrationLock(fn, opts) {
  opts = opts || {};
  const LOCK = lockName(opts.dbName);
  const timeout = opts.timeoutSeconds != null ? opts.timeoutSeconds : LOCK_TIMEOUT_SECONDS;
  const log = opts.logger || null;

  let conn = null;
  try {
    conn = await db.getConnection();
    const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LOCK, timeout]);
    const raw = rows && rows[0] ? rows[0].got : null;
    // 1 = acquired, 0 = timed out, NULL = error/killed. Only 1 may proceed.
    if (Number(raw) !== 1) {
      throw new Error(
        'could not acquire migration advisory lock "' + LOCK + '" within ' +
        timeout + 's (GET_LOCK returned ' + (raw === null ? 'NULL' : raw) + ')'
      );
    }
    if (log && log.info) log.info({ event: 'migration_lock_acquired', lock: LOCK }, 'migration lock acquired');
    try {
      return await fn();
    } finally {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]); } catch (_) {}
    }
  } finally {
    if (conn) { try { conn.release(); } catch (_) {} }
  }
}

module.exports = { withMigrationLock, lockName, LOCK_TIMEOUT_SECONDS };
