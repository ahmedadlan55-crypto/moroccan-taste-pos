/**
 * scripts/name-en-backfill-sweep.js — one-shot CLI that enqueues menu
 * items missing name_en into name_en_backfill_queue for
 * lib/name-en-backfill-worker.js to pick up.
 *
 * This is a SWEEP, not the worker itself: it only ever INSERTs queue
 * rows (or, with --dry-run, only SELECTs and prints — it writes
 * nothing). It never touches `menu`.
 *
 * Usage:
 *   node scripts/name-en-backfill-sweep.js              # enqueue for real
 *   node scripts/name-en-backfill-sweep.js --dry-run     # print only
 *
 * Owner D — bilingual-i18n-images.
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const db = require('../db/connection');

const CANDIDATE_SQL =
  `FROM menu
   WHERE (name_en IS NULL OR name_en = '')
     AND id NOT LIKE 'SEED-%'
     AND id NOT IN (SELECT menu_id FROM name_en_backfill_queue)`;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    const [rows] = await db.query(`SELECT id, name ${CANDIDATE_SQL}`);
    console.log(`[name-en-backfill-sweep] DRY RUN — ${rows.length} item(s) would be enqueued:`);
    for (const r of rows) console.log('  ' + r.id + '  ' + r.name);
    console.log(`[name-en-backfill-sweep] DRY RUN — nothing written. count=${rows.length}`);
    return rows.length;
  }

  const [result] = await db.query(
    `INSERT IGNORE INTO name_en_backfill_queue (id, menu_id, next_attempt_at)
     SELECT CONCAT('NEBQ-', id), id, NOW() ${CANDIDATE_SQL}`
  );
  console.log(`[name-en-backfill-sweep] enqueued ${result.affectedRows} item(s)`);
  return result.affectedRows;
}

if (require.main === module) {
  main()
    .then(async () => { try { await db.end(); } catch (_) {} process.exit(0); })
    .catch(async (e) => {
      console.error('[name-en-backfill-sweep] FAILED:', e.message);
      try { await db.end(); } catch (_) {}
      process.exit(1);
    });
}

module.exports = { main };
