/**
 * lib/image-sourcing-worker.js — Background worker that finds candidate
 * product photos for menu items via Open Food Facts (looked up by
 * primary barcode) and stages them for human review. Same lifecycle
 * shape as lib/zatca-worker.js on purpose.
 *
 * Architecture:
 *   1. A job-creation endpoint (owned separately — not part of this
 *      change) inserts a row into image_sourcing_jobs plus one row per
 *      target menu item into image_sourcing_queue.
 *   2. This worker polls image_sourcing_queue. For each pending row
 *      whose next_attempt_at <= NOW():
 *        a) Looks up the menu item's PRIMARY barcode (item_barcodes,
 *           is_primary=1). No barcode → mark 'done', zero matches, no
 *           candidate row. This item goes to the manual/placeholder
 *           path — never a guessed image.
 *        b) Calls the Open Food Facts product API for that barcode via
 *           lib/safeImageFetch.fetchJsonSafely (SSRF-safe: https-only,
 *           host allowlist, private-IP rejection, redirect
 *           re-validation, size cap, DNS-rebind pinning).
 *        c) No OFF match / no image_front_url → mark 'done', zero
 *           matches, no candidate row.
 *        d) On a hit: fetches the image bytes via
 *           lib/safeImageFetch.fetchImageSafely, magic-byte validates
 *           them (PNG/JPEG/WebP only — SVG/MZ/ELF explicitly rejected),
 *           computes sha256 + a real dHash (lib/imageHash), de-dupes
 *           against this menu item's existing candidates (exact sha256
 *           AND near-duplicate phash via Hamming distance), and inserts
 *           ONE row into image_candidates with review_status='pending'.
 *   3. Concurrent workers are safe via SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * THE RULE THIS WORKER NEVER BREAKS: it does not contain a single
 * `UPDATE menu` or `UPDATE ... image_data` statement anywhere in this
 * file. A found image always lands as a pending image_candidates row.
 * Applying a candidate to menu.image_data is the job of the existing,
 * separately-owned product-images approval endpoint — this worker only
 * ever produces candidates for it to consume. (An optional env-gated
 * auto-apply threshold was described as an optional stretch goal in the
 * spec and was intentionally NOT implemented here — see README note in
 * the PR description / owner report. Nothing auto-applies.)
 *
 * dry_run jobs (image_sourcing_jobs.dry_run=1, the default) run the full
 * read-only pipeline — barcode lookup, OFF call, image fetch, hashing —
 * so progress counters are meaningful, but never write image_candidates
 * or image_sourcing_rollback. Nothing side-effecting happens until a job
 * is explicitly created with dry_run=0.
 *
 * Graceful no-op when:
 *   - IMAGE_SOURCING_DISABLE_WORKER=1 env (for local dev / tests)
 *
 * Owner D — bilingual-i18n-images.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const safeImageFetch = require('./safeImageFetch');
const imageHash = require('./imageHash');

const BACKOFF_SECS = [60, 300, 1800, 7200, 28800];   // 1m → 5m → 30m → 2h → 8h
const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 10;

// Near-duplicate threshold for the 64-bit dHash — empirically, re-encodes
// of the same photo land within a handful of bits; unrelated photos land
// near 32 (random). 10 is a conservative "same photo, different encode".
const PHASH_DUPE_HAMMING_THRESHOLD = 10;

let _started = false;
let _pollTimer = null;

function start() {
  if (_started) return;
  if (process.env.IMAGE_SOURCING_DISABLE_WORKER === '1') {
    console.log('[image-sourcing-worker] disabled via env');
    return;
  }
  _started = true;
  console.log('[image-sourcing-worker] started, polling every ' + (POLL_INTERVAL_MS / 1000) + 's');
  setTimeout(_tick, 5000);
}

function stop() {
  _started = false;
  if (_pollTimer) clearTimeout(_pollTimer);
  _pollTimer = null;
}

async function _tick() {
  if (!_started) return;
  try {
    await _processBatch();
  } catch (e) {
    console.warn('[image-sourcing-worker] tick error:', e.message);
  } finally {
    if (_started) _pollTimer = setTimeout(_tick, POLL_INTERVAL_MS);
  }
}

// ─── Magic-byte MIME validation (belongs HERE, not in safeImageFetch) ────
function _detectMagicMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 12 &&
      buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null; // allowlist, not a blocklist — anything else is untrusted
}

function _isExplicitlyDangerous(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.slice(0, 32).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return true; // script-capable
  if (buf.length >= 2 && buf[0] === 0x4D && buf[1] === 0x5A) return true; // MZ (Windows exe)
  if (buf.length >= 4 && buf[0] === 0x7F && buf[1] === 0x45 && buf[2] === 0x4C && buf[3] === 0x46) return true; // ELF
  return false;
}

async function _processBatch() {
  let rows = [];
  try {
    const result = await db.withTransaction(async (conn) => {
      const [pending] = await conn.query(
        `SELECT id, job_id, menu_id, attempt_count
         FROM image_sourcing_queue
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT ? FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );
      for (const r of pending) {
        await conn.query("UPDATE image_sourcing_queue SET status='running' WHERE id = ?", [r.id]);
      }
      return pending;
    });
    rows = result;
  } catch (e) {
    // FOR UPDATE SKIP LOCKED not supported on older MySQL — fall back to
    // a plain SELECT + best-effort update.
    const [pending] = await db.query(
      `SELECT id, job_id, menu_id, attempt_count
       FROM image_sourcing_queue
       WHERE status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC LIMIT ?`,
      [BATCH_SIZE]
    );
    for (const r of pending) {
      await db.query("UPDATE image_sourcing_queue SET status='running' WHERE id = ? AND status='pending'", [r.id]);
    }
    rows = pending;
  }
  if (!rows.length) return;

  for (const row of rows) {
    try {
      await _processOne(row);
    } catch (e) {
      const newCount = row.attempt_count + 1;
      const failed = newCount >= MAX_ATTEMPTS;
      const next = failed ? null :
        new Date(Date.now() + BACKOFF_SECS[newCount - 1] * 1000);
      await db.query(
        `UPDATE image_sourcing_queue
         SET status = ?, attempt_count = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?`,
        [
          failed ? 'failed' : 'pending',
          newCount,
          next || new Date(),
          String(e.message || e).slice(0, 1000),
          row.id
        ]
      );
      if (failed) {
        await db.query(
          'UPDATE image_sourcing_jobs SET processed_items = processed_items + 1 WHERE id = ?',
          [row.job_id]
        );
        await _maybeFinishJob(row.job_id);
      }
    }
  }
}

/**
 * Mark a queue row terminally 'done' and roll the job counters forward.
 * `matched` = a candidate was found (dry-run: WOULD have been queued).
 */
async function _finishItem(row, matched) {
  await db.query("UPDATE image_sourcing_queue SET status='done' WHERE id = ?", [row.id]);
  await db.query(
    `UPDATE image_sourcing_jobs
     SET processed_items = processed_items + 1,
         matched_items = matched_items + ?,
         queued_for_review = queued_for_review + ?
     WHERE id = ?`,
    [matched ? 1 : 0, matched ? 1 : 0, row.job_id]
  );
  await _maybeFinishJob(row.job_id);
}

async function _maybeFinishJob(jobId) {
  const [rows] = await db.query(
    'SELECT total_items, processed_items FROM image_sourcing_jobs WHERE id = ? LIMIT 1',
    [jobId]
  );
  if (!rows.length) return;
  const job = rows[0];
  if (job.total_items > 0 && job.processed_items >= job.total_items) {
    await db.query(
      "UPDATE image_sourcing_jobs SET status='done', finished_at=NOW() WHERE id = ? AND status <> 'done'",
      [jobId]
    );
  }
}

async function _processOne(row) {
  const [m] = await db.query('SELECT id FROM menu WHERE id = ? LIMIT 1', [row.menu_id]);
  if (!m.length) { await _finishItem(row, false); return; }

  const [jobRows] = await db.query('SELECT dry_run FROM image_sourcing_jobs WHERE id = ? LIMIT 1', [row.job_id]);
  const dryRun = !jobRows.length || !!jobRows[0].dry_run;

  // ── barcode gate — no barcode, no guess ──
  const [bc] = await db.query(
    "SELECT code FROM item_barcodes WHERE item_id = ? AND is_primary = 1 LIMIT 1",
    [row.menu_id]
  );
  const barcode = bc.length ? String(bc[0].code || '').trim() : '';
  if (!barcode) { await _finishItem(row, false); return; }

  // ── Open Food Facts lookup (SSRF-safe, allowlisted host only) ──
  const offUrl = 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(barcode) + '.json';
  let offJson;
  try {
    const r = await safeImageFetch.fetchJsonSafely(offUrl);
    offJson = r.json;
  } catch (e) {
    // A bad/unknown barcode or a benign lookup failure is NOT a candidate
    // — it's a "no match", not a worker failure that should retry forever.
    await _finishItem(row, false);
    return;
  }

  const product = offJson && offJson.product;
  const imageUrl = product && (product.image_front_url || product.image_url);
  if (!offJson || Number(offJson.status) !== 1 || !imageUrl) {
    await _finishItem(row, false);
    return;
  }

  // ── fetch the actual image bytes (SSRF-safe) ──
  const { buffer } = await safeImageFetch.fetchImageSafely(imageUrl);

  if (_isExplicitlyDangerous(buffer)) {
    throw new Error('REJECTED_DANGEROUS_PAYLOAD: image bytes matched a disallowed signature (svg/exe/elf)');
  }
  const mime = _detectMagicMime(buffer);
  if (!mime) {
    // Not a recognized image format — no candidate, but not a hard
    // failure either; OFF occasionally serves odd content-types.
    await _finishItem(row, false);
    return;
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // Exact-duplicate guard for this menu item (also enforced by the
  // uq_candidate_dedupe UNIQUE KEY — checked here first to avoid a noisy
  // duplicate-key error on every re-run of an already-sourced item).
  const [exact] = await db.query(
    'SELECT id FROM image_candidates WHERE menu_id = ? AND sha256 = ? LIMIT 1',
    [row.menu_id, sha256]
  );
  if (exact.length) { await _finishItem(row, false); return; }

  const phash = await imageHash.computeDHash(buffer);

  // Near-duplicate guard (same photo, re-encoded/re-compressed) for this
  // menu item, via Hamming distance over existing candidates' phash.
  const [existing] = await db.query('SELECT phash FROM image_candidates WHERE menu_id = ?', [row.menu_id]);
  const isNearDupe = existing.some(
    (r) => imageHash.hammingDistanceHex(r.phash, phash) <= PHASH_DUPE_HAMMING_THRESHOLD
  );
  if (isNearDupe) { await _finishItem(row, false); return; }

  if (dryRun) {
    // Read-only pipeline complete — report what WOULD have matched
    // without writing image_candidates or touching menu in any way.
    await _finishItem(row, true);
    return;
  }

  const candidateId = 'IMGC-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  await db.query(
    `INSERT INTO image_candidates
       (id, menu_id, job_id, source_provider, source_url, query_used, license,
        attribution, author, confidence, sha256, phash, mime, bytes, review_status)
     VALUES (?, ?, ?, 'openfoodfacts', ?, ?, ?, ?, ?, 1.0000, ?, ?, ?, ?, 'pending')`,
    [
      candidateId, row.menu_id, row.job_id, imageUrl, barcode,
      null, // OFF exposes no reliable per-image license field — leave NULL, never guess
      'Open Food Facts contributors',
      null,
      sha256, phash, mime, buffer.length
    ]
  );

  await _finishItem(row, true);
}

module.exports = {
  start,
  stop,
  // Exported for tests — run the queue-claim + process loop synchronously
  // without waiting on the poll timer.
  _processBatch,
  _processOne,
  _detectMagicMime,
  _isExplicitlyDangerous
};
