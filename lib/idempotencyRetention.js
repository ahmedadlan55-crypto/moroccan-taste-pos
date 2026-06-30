/**
 * Idempotency-key retention policy (Phase 3B — closes a 3A.1 gap).
 *
 * The `idempotency_keys` table stores one row per (user, operation, document,
 * client-key) reservation:
 *   • status_code IS NULL   → reservation IN PROGRESS (request still running).
 *   • status_code IS NOT NULL → a COMPLETED result (replayable on retry).
 *
 * Retention rules (configurable via env `IDEMPOTENCY_RETENTION_DAYS`, default 30):
 *   • A COMPLETED result is kept for `retentionDays`, then purged — long enough
 *     to absorb any realistic client retry window, short enough to bound growth.
 *   • An IN-PROGRESS reservation is NEVER purged by the sweep. A live request
 *     must never have its reservation deleted out from under it (that would let
 *     a concurrent duplicate slip through). Because every reservation key embeds
 *     a fresh client-generated token, a crashed in-flight reservation never
 *     blocks a genuine retry (the retry carries a new key), so leaving it in
 *     place is safe; operators can clear stragglers manually if ever needed.
 *
 * The sweep runs once on boot and then daily (see startIdempotencyCleanup).
 */
'use strict';

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Resolve the retention horizon from the environment. Any non-positive / unparsable
// value falls back to the 30-day default.
function retentionDays(env) {
  const src = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const n = parseInt(src.IDEMPOTENCY_RETENTION_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

// Purge COMPLETED idempotency results older than the horizon. Returns the number
// of rows deleted. IN-PROGRESS reservations (status_code IS NULL) are untouched.
async function cleanupIdempotencyKeys(db, days) {
  const d = Number.isFinite(days) && days > 0 ? Math.floor(days) : retentionDays();
  const [res] = await db.query(
    'DELETE FROM idempotency_keys ' +
    'WHERE status_code IS NOT NULL AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [d]
  );
  return (res && res.affectedRows) || 0;
}

// Schedule the daily sweep. The timer is unref'd so it never keeps a test/boot
// process alive. Returns the timer handle.
function startIdempotencyCleanup(db, intervalMs) {
  const ms = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DAY_MS;
  const t = setInterval(() => {
    cleanupIdempotencyKeys(db).catch(() => {});
  }, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  retentionDays,
  cleanupIdempotencyKeys,
  startIdempotencyCleanup,
};
