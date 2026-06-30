/**
 * Phase 3B — idempotency-key retention test (closes a 3A.1 gap).
 *
 * Proves lib/idempotencyRetention:
 *   • IDEMPOTENCY_RETENTION_DAYS is read from env (default 30, bad values ignored),
 *   • a COMPLETED row older than the horizon is purged,
 *   • a COMPLETED row inside the horizon is kept,
 *   • an IN-PROGRESS reservation (status_code IS NULL) is NEVER purged — even when
 *     it is far older than the horizon (a live request must not be torn out).
 *
 * Run: node tests/integration/idempotencyRetention.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const db = require('../../db/connection');
const ret = require('../../lib/idempotencyRetention');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

const PREFIX = 'ret-test:';
async function ensureTable() {
  await db.query(
    'CREATE TABLE IF NOT EXISTS idempotency_keys (' +
    ' id VARCHAR(80) PRIMARY KEY, username VARCHAR(80), endpoint VARCHAR(160),' +
    ' response_json LONGTEXT, status_code SMALLINT, request_hash VARCHAR(64),' +
    ' created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_user_age (username, created_at)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
}
async function cleanup() { try { await db.query("DELETE FROM idempotency_keys WHERE id LIKE ?", [PREFIX + '%']); } catch (_) {} }
// Insert a row with an explicit age (days ago) and status_code (null = processing).
async function seed(id, statusCode, daysAgo) {
  await db.query(
    'INSERT INTO idempotency_keys (id, username, endpoint, response_json, status_code, created_at) ' +
    'VALUES (?,?,?,?,?, DATE_SUB(NOW(), INTERVAL ? DAY))',
    [PREFIX + id, 'tester', '/x', statusCode != null ? '{"ok":true}' : null, statusCode, daysAgo]
  );
}
async function exists(id) {
  const [r] = await db.query('SELECT 1 FROM idempotency_keys WHERE id = ? LIMIT 1', [PREFIX + id]);
  return r.length > 0;
}

(async () => {
  console.log('\n═══ Idempotency retention ═══\n');
  let exitCode = 0;
  try {
    await ensureTable();
    await cleanup();

    // ── retentionDays() resolution ──
    check('default is 30 when unset', ret.retentionDays({}) === 30);
    check('reads a valid env value', ret.retentionDays({ IDEMPOTENCY_RETENTION_DAYS: '7' }) === 7);
    check('ignores zero / negative', ret.retentionDays({ IDEMPOTENCY_RETENTION_DAYS: '0' }) === 30 && ret.retentionDays({ IDEMPOTENCY_RETENTION_DAYS: '-5' }) === 30);
    check('ignores garbage', ret.retentionDays({ IDEMPOTENCY_RETENTION_DAYS: 'abc' }) === 30);

    // ── seed four rows, sweep at 30-day horizon ──
    await seed('old-done', 200, 40);     // completed, 40d old  → purge
    await seed('new-done', 200, 1);      // completed, 1d old   → keep
    await seed('old-proc', null, 40);    // processing, 40d old → keep (never purge in-progress)
    await seed('new-proc', null, 0);     // processing, now     → keep
    const deleted = await ret.cleanupIdempotencyKeys(db, 30);

    check('purged the old completed row', !(await exists('old-done')));
    check('kept the recent completed row', await exists('new-done'));
    check('kept the OLD in-progress reservation (never purge processing)', await exists('old-proc'));
    check('kept the recent in-progress reservation', await exists('new-proc'));
    check('reported >=1 deletion', deleted >= 1, { deleted });

    // ── custom horizon: 3-day sweep purges the 1-day-old? no; purge a 5-day one ──
    await seed('mid-done', 200, 5);      // completed, 5d old
    await ret.cleanupIdempotencyKeys(db, 3); // horizon 3d → 5d-old purged, 1d-old kept
    check('custom horizon purges past-horizon completed', !(await exists('mid-done')));
    check('custom horizon keeps within-horizon completed', await exists('new-done'));

    await cleanup();
  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.message);
    try { await cleanup(); } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
