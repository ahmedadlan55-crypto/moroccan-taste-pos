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

const db = require('./connection');

const LOCK_TIMEOUT_SECONDS = 600;

/** The lock name actually used for a given database. Exported for tests. */
function lockName(dbName) {
  const target = dbName
    || process.env.MYSQL_DATABASE
    || process.env.MYSQLDATABASE
    || process.env.DB_NAME
    || 'default';
  return 'mt_pos_migrations:' + target;
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
