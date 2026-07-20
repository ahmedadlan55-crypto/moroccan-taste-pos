/**
 * lib/name-en-backfill-worker.js — Background worker that fills in
 * menu.name_en for items the owner never typed an English name for.
 *
 * Architecture (copied from lib/zatca-worker.js — same shape on purpose):
 *   1. scripts/name-en-backfill-sweep.js enqueues a row in
 *      name_en_backfill_queue for every menu item missing name_en.
 *   2. This worker polls the queue. For each pending row whose
 *      next_attempt_at <= NOW():
 *        a) Loads the menu row.
 *        b) CRITICAL RULE: if menu.name_en is already non-empty AND
 *           menu.name_en_source IS NULL — that means the owner typed it
 *           by hand via the existing ERP field. The worker marks the
 *           queue row 'skipped' and updates NOTHING on menu. This is
 *           the only branch that touches zero menu columns.
 *        c) Otherwise: no translation API key is configured in this
 *           environment, so the worker never calls an external
 *           translation API — it goes straight to a deterministic,
 *           honestly-labeled Arabic→Latin transliteration and marks the
 *           result as needing human review.
 *   3. Concurrent workers (multi-instance deploy) are safe via
 *      SELECT ... FOR UPDATE SKIP LOCKED — only one worker grabs each row.
 *
 * STRUCTURAL GUARANTEE: the only UPDATE this worker ever issues against
 * `menu` is:
 *
 *   UPDATE menu SET name_en = ?, name_en_source = ?, name_en_needs_review = 1 WHERE id = ?
 *
 * It never appears anywhere else in this file, and it never names price,
 * stock, name, tax_category, category, cost, or any recipe table — so
 * there is no code path (bug or otherwise) by which this worker can
 * touch anything but those three columns.
 *
 * Graceful no-op when:
 *   - NAME_EN_BACKFILL_DISABLE_WORKER=1 env (for local dev / tests)
 *
 * Owner D — bilingual-i18n-images.
 */

const db = require('../db/connection');

const BACKOFF_SECS = [60, 300, 1800, 7200, 28800];   // 1m → 5m → 30m → 2h → 8h
const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 20;

let _started = false;
let _pollTimer = null;

/**
 * Start the worker. Idempotent — safe to call multiple times.
 */
function start() {
  if (_started) return;
  if (process.env.NAME_EN_BACKFILL_DISABLE_WORKER === '1') {
    console.log('[name-en-backfill-worker] disabled via env');
    return;
  }
  _started = true;
  console.log('[name-en-backfill-worker] started, polling every ' + (POLL_INTERVAL_MS / 1000) + 's');
  // Stagger the first run by 5s so we don't race with server boot
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
    console.warn('[name-en-backfill-worker] tick error:', e.message);
  } finally {
    if (_started) _pollTimer = setTimeout(_tick, POLL_INTERVAL_MS);
  }
}

// ─── Hand-rolled Arabic → Latin transliteration table ────────────────────
// Not linguistically perfect — good enough for restaurant menu terms, and
// honestly labeled (name_en_source='transliteration', needs_review=1) so a
// human can fix it later. Anything not in the map (spaces, digits, Latin
// letters already present, punctuation) passes through unchanged.
const AR_MAP = {
  'ا': 'a',  // ا alef
  'أ': 'a',  // أ alef+hamza above
  'إ': 'i',  // إ alef+hamza below
  'آ': 'aa', // آ alef madda
  'ٱ': 'a',  // ٱ alef wasla
  'ب': 'b',  // ب
  'ت': 't',  // ت
  'ث': 'th', // ث
  'ج': 'j',  // ج
  'ح': 'h',  // ح
  'خ': 'kh', // خ
  'د': 'd',  // د
  'ذ': 'dh', // ذ
  'ر': 'r',  // ر
  'ز': 'z',  // ز
  'س': 's',  // س
  'ش': 'sh', // ش
  'ص': 's',  // ص
  'ض': 'd',  // ض
  'ط': 't',  // ط
  'ظ': 'z',  // ظ
  'ع': '\'', // ع ain
  'غ': 'gh', // غ
  'ف': 'f',  // ف
  'ق': 'q',  // ق
  'ك': 'k',  // ك
  'ل': 'l',  // ل
  'م': 'm',  // م
  'ن': 'n',  // ن
  'ه': 'h',  // ه
  'و': 'w',  // و
  'ي': 'y',  // ي
  'ى': 'a',  // ى alef maksura
  'ة': 'a',  // ة taa marbuta
  'ء': '\'', // ء hamza
  'ئ': '\'', // ئ
  'ؤ': '\'', // ؤ
  // Diacritics (تشكيل) — stripped, they carry no Latin-letter content here.
  'ً': '', 'ٌ': '', 'ٍ': '', 'َ': '',
  'ُ': '', 'ِ': '', 'ّ': '', 'ْ': '', 'ٰ': '',
  // Arabic-Indic digits
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  // Common punctuation
  '،': ',', '؛': ';', '؟': '?'
};

/**
 * Deterministic Arabic→Latin transliteration. Exported for direct unit
 * testing. No network calls, no external API, no dictionary lookups.
 */
function transliterate(text) {
  if (!text) return '';
  let out = '';
  for (const ch of String(text)) {
    out += Object.prototype.hasOwnProperty.call(AR_MAP, ch) ? AR_MAP[ch] : ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  // Menu-friendly title case per word.
  out = out.replace(/\b\w/g, (c) => c.toUpperCase());
  // menu.name_en is VARCHAR(200) — never propose something that can't fit.
  return out.slice(0, 200);
}

async function _processBatch() {
  let rows = [];
  try {
    const result = await db.withTransaction(async (conn) => {
      const [pending] = await conn.query(
        `SELECT id, menu_id, attempt_count
         FROM name_en_backfill_queue
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT ? FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );
      for (const r of pending) {
        await conn.query("UPDATE name_en_backfill_queue SET status='running' WHERE id = ?", [r.id]);
      }
      return pending;
    });
    rows = result;
  } catch (e) {
    // FOR UPDATE SKIP LOCKED not supported on older MySQL — fall back to
    // a plain SELECT + best-effort update.
    const [pending] = await db.query(
      `SELECT id, menu_id, attempt_count
       FROM name_en_backfill_queue
       WHERE status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC LIMIT ?`,
      [BATCH_SIZE]
    );
    for (const r of pending) {
      await db.query("UPDATE name_en_backfill_queue SET status='running' WHERE id = ? AND status='pending'", [r.id]);
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
        `UPDATE name_en_backfill_queue
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
    }
  }
}

async function _processOne(row) {
  const [m] = await db.query(
    'SELECT id, name, name_en, name_en_source FROM menu WHERE id = ? LIMIT 1',
    [row.menu_id]
  );
  if (!m.length) {
    await db.query("UPDATE name_en_backfill_queue SET status='skipped' WHERE id = ?", [row.id]);
    return;
  }
  const menu = m[0];

  // ── CRITICAL RULE — never overwrite an owner-authored name_en ──
  // Owner-authored = non-empty name_en AND name_en_source IS NULL (the
  // worker itself always sets name_en_source to a non-NULL value, so a
  // NULL source with a non-empty value can only mean a human typed it
  // through the existing ERP field before this pipeline ever ran).
  const ownerAuthored = menu.name_en != null && String(menu.name_en).trim() !== '' &&
    menu.name_en_source === null;
  if (ownerAuthored) {
    await db.query("UPDATE name_en_backfill_queue SET status='skipped' WHERE id = ?", [row.id]);
    return; // menu is NOT touched — nothing to update
  }

  // No translation API key is configured in this environment — go
  // straight to deterministic transliteration (never invent/call one).
  const proposed = transliterate(menu.name || '');

  // The ONLY UPDATE this worker issues against `menu`. See file header —
  // this column list is the structural guarantee, not just documentation.
  await db.query(
    'UPDATE menu SET name_en = ?, name_en_source = ?, name_en_needs_review = 1 WHERE id = ?',
    [proposed, 'transliteration', menu.id]
  );

  await db.query(
    "UPDATE name_en_backfill_queue SET status='done', source_used=?, proposed_name_en=? WHERE id = ?",
    ['transliteration', proposed, row.id]
  );
}

module.exports = {
  start,
  stop,
  transliterate,
  // Exported for tests — run the queue-claim + process loop synchronously
  // without waiting on the poll timer.
  _processBatch,
  _processOne
};
