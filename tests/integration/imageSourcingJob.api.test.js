/**
 * Owner D — bilingual-i18n-images. Proves lib/image-sourcing-worker.js's
 * DB-layer behavior directly against the four 0016 tables — no live app
 * server needed (there is no HTTP surface to source images yet; job/queue
 * rows are seeded here exactly the way the separately-owned job-creation
 * endpoint would create them).
 *
 *   · no primary barcode → queue row 'done', zero matches, NO candidate row
 *     (never guesses an image).
 *   · barcode with no Open Food Facts match → same: 'done', zero matches,
 *     no candidate row.
 *   · a REAL barcode with a REAL OFF match: the SSRF-safe fetch + magic-byte
 *     pipeline runs end-to-end against the real network. If `sharp` is
 *     installed (lib/imageHash) the candidate is inserted with
 *     review_status='pending', confidence=1.0, sha256/phash populated, and
 *     the job counters (processed/matched/queued_for_review) advance. If
 *     `sharp` is NOT installed in this environment (it wasn't at the time
 *     this suite was written — see the owner report), the pipeline fails
 *     CLOSED with a clear IMAGE_DECODE_UNAVAILABLE error and the row is
 *     retried per backoff rather than silently fabricating a candidate —
 *     this test asserts that graceful-degradation contract either way.
 *   · exact sha256 dedupe: re-processing the same menu_id + already-seen
 *     bytes never inserts a second image_candidates row (also enforced by
 *     the uq_candidate_dedupe UNIQUE KEY).
 *   · dry_run=1 jobs run the full read-only pipeline but write ZERO rows to
 *     image_candidates.
 *   · concurrent workers never double-process the same queue row
 *     (SELECT...FOR UPDATE SKIP LOCKED).
 *   · a job's counters auto-complete (status='done') once every queued item
 *     has reached a terminal state.
 *   · this worker file contains no `UPDATE ... menu` / `image_data` write —
 *     verified by scanning the source, the same structural-guarantee style
 *     used in nameEnBackfill.test.js.
 *
 * DB tables are self-provisioned here (0016) so this test does not depend
 * on `node db/migrate.js` having been run first.
 *
 * Run: node tests/integration/imageSourcingJob.api.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const db = require('../../db/connection');
const worker = require('../../lib/image-sourcing-worker');
const imageHash = require('../../lib/imageHash');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

const PREFIX = 'ZZIMGJ-';
// Real, stable barcodes on Open Food Facts — used to prove the end-to-end
// match path against the real API, per item 8's own allowance that hitting
// the real allowlisted network is fine here. Two distinct barcodes because
// item_barcodes.code_norm is globally UNIQUE (a real UPC can't be assigned
// to two different menu fixtures at once).
const REAL_BARCODE = '3017620422003';   // Nutella 400g
const REAL_BARCODE_2 = '5449000000996'; // Coca-Cola

async function ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS image_sourcing_jobs (
    id VARCHAR(50) NOT NULL PRIMARY KEY, status ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
    dry_run TINYINT(1) NOT NULL DEFAULT 1, filter_json LONGTEXT NULL, total_items INT NOT NULL DEFAULT 0,
    processed_items INT NOT NULL DEFAULT 0, matched_items INT NOT NULL DEFAULT 0, queued_for_review INT NOT NULL DEFAULT 0,
    created_by VARCHAR(100) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS image_sourcing_queue (
    id VARCHAR(50) NOT NULL PRIMARY KEY, job_id VARCHAR(50) NOT NULL, menu_id VARCHAR(50) NOT NULL,
    status ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending', attempt_count INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME NOT NULL, last_error VARCHAR(1000) NULL,
    INDEX idx_isq_status (status, next_attempt_at), INDEX idx_isq_job (job_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS image_candidates (
    id VARCHAR(50) NOT NULL PRIMARY KEY, menu_id VARCHAR(50) NOT NULL, job_id VARCHAR(50) NOT NULL,
    source_provider VARCHAR(50) NOT NULL, source_url VARCHAR(1000) NOT NULL, query_used VARCHAR(300) NULL,
    license VARCHAR(100) NULL, attribution VARCHAR(500) NULL, author VARCHAR(200) NULL,
    confidence DECIMAL(5,4) NOT NULL DEFAULT 0, sha256 CHAR(64) NOT NULL, phash CHAR(16) NOT NULL,
    mime VARCHAR(30) NOT NULL, bytes INT NOT NULL,
    review_status ENUM('pending','approved','rejected','auto_applied') NOT NULL DEFAULT 'pending',
    reviewer VARCHAR(100) NULL, reviewed_at DATETIME NULL, applied_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_candidate_dedupe (menu_id, sha256), INDEX idx_ic_phash (phash), INDEX idx_ic_review (review_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS image_sourcing_rollback (
    id VARCHAR(50) NOT NULL PRIMARY KEY, menu_id VARCHAR(50) NOT NULL, job_id VARCHAR(50) NOT NULL,
    prev_image_data LONGTEXT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function cleanup() {
  await db.query("DELETE FROM image_candidates WHERE menu_id LIKE ?", [PREFIX + '%']);
  await db.query("DELETE FROM image_sourcing_queue WHERE menu_id LIKE ?", [PREFIX + '%']);
  await db.query("DELETE FROM image_sourcing_jobs WHERE id LIKE ?", [PREFIX + '%']);
  await db.query("DELETE FROM item_barcodes WHERE item_id LIKE ?", [PREFIX + '%']);
  await db.query("DELETE FROM menu WHERE id LIKE ?", [PREFIX + '%']);
}

async function makeJob(id, opts) {
  await db.query(
    'INSERT INTO image_sourcing_jobs (id, status, dry_run, total_items) VALUES (?,?,?,?)',
    [id, 'running', opts.dryRun ? 1 : 0, opts.totalItems]
  );
}
async function enqueue(qid, jobId, menuId) {
  await db.query(
    'INSERT INTO image_sourcing_queue (id, job_id, menu_id, next_attempt_at) VALUES (?,?,?,NOW())',
    [qid, jobId, menuId]
  );
}
async function queueStatus(qid) {
  const [r] = await db.query('SELECT status, attempt_count, last_error FROM image_sourcing_queue WHERE id=?', [qid]);
  return r[0];
}
async function jobRow(id) {
  const [r] = await db.query('SELECT * FROM image_sourcing_jobs WHERE id=?', [id]);
  return r[0];
}
async function candidatesFor(menuId) {
  const [r] = await db.query('SELECT * FROM image_candidates WHERE menu_id=?', [menuId]);
  return r;
}

(async () => {
  console.log('\n═══ image sourcing pipeline (DB-layer) ═══\n');
  let exitCode = 0;
  try {
    await ensureSchema();
    await cleanup();

    // ═══ 1. No barcode → done, zero matches, no candidate ═══
    const NOBC_ID = PREFIX + 'NOBC';
    await db.query("INSERT INTO menu (id,name,price,stock,category) VALUES (?,?,?,?,?)", [NOBC_ID, 'no barcode item', 10, 1, 'ZZIMGJ']);
    await makeJob(PREFIX + 'J1', { dryRun: false, totalItems: 1 });
    await enqueue(PREFIX + 'Q1', PREFIX + 'J1', NOBC_ID);

    await worker._processBatch();

    const q1 = await queueStatus(PREFIX + 'Q1');
    check('no-barcode item → queue row done', q1 && q1.status === 'done', q1);
    check('…zero candidate rows created', (await candidatesFor(NOBC_ID)).length === 0);
    const j1 = await jobRow(PREFIX + 'J1');
    check('…job auto-completed (only item, terminal)', j1.status === 'done', j1);
    check('…matched_items stayed 0', j1.matched_items === 0, j1.matched_items);

    // ═══ 2. Barcode with no OFF match → done, zero matches, no candidate ═══
    const NOMATCH_ID = PREFIX + 'NOMATCH';
    await db.query("INSERT INTO menu (id,name,price,stock,category) VALUES (?,?,?,?,?)", [NOMATCH_ID, 'unknown barcode item', 10, 1, 'ZZIMGJ']);
    await db.query("INSERT INTO item_barcodes (id,item_id,code,code_norm,is_primary) VALUES (?,?,?,?,1)",
      [PREFIX + 'BC-NOMATCH', NOMATCH_ID, '0000000000000', '0000000000000']);
    await makeJob(PREFIX + 'J2', { dryRun: false, totalItems: 1 });
    await enqueue(PREFIX + 'Q2', PREFIX + 'J2', NOMATCH_ID);

    await worker._processBatch();

    const q2 = await queueStatus(PREFIX + 'Q2');
    check('unknown-barcode item → queue row done (not a crash/retry)', q2 && q2.status === 'done', q2);
    check('…zero candidate rows created', (await candidatesFor(NOMATCH_ID)).length === 0);

    // ═══ 3. Real barcode, real OFF match — end-to-end against the real
    //        allowlisted network. Graceful-degradation-aware: sharp may or
    //        may not be installed in this environment. ═══
    const MATCH_ID = PREFIX + 'MATCH';
    await db.query("INSERT INTO menu (id,name,price,stock,category) VALUES (?,?,?,?,?)", [MATCH_ID, 'nutella', 10, 1, 'ZZIMGJ']);
    await db.query("INSERT INTO item_barcodes (id,item_id,code,code_norm,is_primary) VALUES (?,?,?,?,1)",
      [PREFIX + 'BC-MATCH', MATCH_ID, REAL_BARCODE, REAL_BARCODE]);
    await makeJob(PREFIX + 'J3', { dryRun: false, totalItems: 1 });
    await enqueue(PREFIX + 'Q3', PREFIX + 'J3', MATCH_ID);

    await worker._processBatch();
    const q3 = await queueStatus(PREFIX + 'Q3');

    if (imageHash.isAvailable()) {
      check('sharp IS installed — real match produced exactly one candidate', q3 && q3.status === 'done', q3);
      const cands = await candidatesFor(MATCH_ID);
      check('…exactly one image_candidates row', cands.length === 1, cands.length);
      if (cands.length) {
        const c = cands[0];
        check('…source_provider=openfoodfacts', c.source_provider === 'openfoodfacts');
        check('…review_status=pending (never auto-applied)', c.review_status === 'pending');
        check('…confidence=1.0000', Number(c.confidence) === 1);
        check('…sha256 is a 64-char hex string', /^[0-9a-f]{64}$/.test(c.sha256), c.sha256);
        check('…phash is a 16-char hex string', /^[0-9a-f]{16}$/.test(c.phash), c.phash);
        check('…mime is one of the three allowed image types', ['image/png', 'image/jpeg', 'image/webp'].includes(c.mime), c.mime);
      }
      const j3 = await jobRow(PREFIX + 'J3');
      check('…job matched_items and queued_for_review both advanced by 1', j3.matched_items === 1 && j3.queued_for_review === 1, j3);

      // ═══ dedupe: re-queue the SAME menu item — must not insert a 2nd row ═══
      await db.query("UPDATE image_sourcing_jobs SET status='running', total_items=total_items+1 WHERE id=?", [PREFIX + 'J3']);
      await enqueue(PREFIX + 'Q3B', PREFIX + 'J3', MATCH_ID);
      await worker._processBatch();
      const candsAfter = await candidatesFor(MATCH_ID);
      check('re-processing the same menu item does not create a duplicate candidate (sha256 dedupe)', candsAfter.length === 1, candsAfter.length);
    } else {
      // sharp isn't installed in this environment — the worker MUST fail
      // closed (retry per backoff) rather than fabricate a candidate.
      check('sharp NOT installed — pipeline fails closed, no candidate fabricated', (await candidatesFor(MATCH_ID)).length === 0);
      check('…queue row stays pending for retry (not silently marked done)', q3 && q3.status === 'pending', q3);
      check('…last_error explains why (IMAGE_DECODE_UNAVAILABLE)', q3 && /IMAGE_DECODE_UNAVAILABLE/.test(q3.last_error || ''), q3 && q3.last_error);
      console.log('  ℹ️  sharp is not installed in this environment — see owner report. This is the expected, honest graceful-degradation path, not a failure of the SSRF/queue logic under test.');
    }

    // ═══ 4. dry_run job — full pipeline runs, but writes ZERO candidates ═══
    const DRY_ID = PREFIX + 'DRY';
    await db.query("INSERT INTO menu (id,name,price,stock,category) VALUES (?,?,?,?,?)", [DRY_ID, 'dry run nutella', 10, 1, 'ZZIMGJ']);
    await db.query("INSERT INTO item_barcodes (id,item_id,code,code_norm,is_primary) VALUES (?,?,?,?,1)",
      [PREFIX + 'BC-DRY', DRY_ID, REAL_BARCODE_2, REAL_BARCODE_2]);
    await makeJob(PREFIX + 'J4', { dryRun: true, totalItems: 1 });
    await enqueue(PREFIX + 'Q4', PREFIX + 'J4', DRY_ID);

    await worker._processBatch();
    check('dry_run job never writes an image_candidates row, regardless of match outcome', (await candidatesFor(DRY_ID)).length === 0);

    // ═══ 5. Concurrency — FOR UPDATE SKIP LOCKED prevents double-processing ═══
    const CONC_ID = PREFIX + 'CONC';
    await db.query("INSERT INTO menu (id,name,price,stock,category) VALUES (?,?,?,?,?)", [CONC_ID, 'no barcode conc', 10, 1, 'ZZIMGJ']);
    await makeJob(PREFIX + 'J5', { dryRun: false, totalItems: 1 });
    await enqueue(PREFIX + 'Q5', PREFIX + 'J5', CONC_ID);
    await Promise.all([worker._processBatch(), worker._processBatch()]);
    const j5 = await jobRow(PREFIX + 'J5');
    check('two concurrent _processBatch() calls process the row exactly once (processed_items=1, not 2)', j5.processed_items === 1, j5);

    // ═══ 6. Structural guarantee — never writes menu/image_data. Scanned
    //        over executable code only — the file's own header comment
    //        documents (in prose) that no such statement exists, which
    //        would otherwise trip a naive substring scan. ═══
    const rawSrc = fs.readFileSync(__dirname + '/../../lib/image-sourcing-worker.js', 'utf8');
    const codeOnly = rawSrc.split('\n').filter((l) => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
    }).join('\n');
    check('worker source contains NO "UPDATE menu" statement in executable code', !/UPDATE\s+menu\b/i.test(codeOnly));
    check('worker source contains NO write to image_data in executable code', !/image_data\s*=/i.test(codeOnly));

    await cleanup();
  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack);
    try { await cleanup(); } catch (_) {}
  }

  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
