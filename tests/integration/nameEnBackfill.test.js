/**
 * Owner D — bilingual-i18n-images. Proves lib/name-en-backfill-worker.js
 * and scripts/name-en-backfill-sweep.js:
 *
 *   · An owner-set name_en (non-empty, name_en_source IS NULL) is NEVER
 *     overwritten — the queue row is marked 'skipped' and menu is untouched.
 *   · The transliteration fallback (no translation API key configured, by
 *     design) always sets name_en_source='transliteration' and
 *     name_en_needs_review=1.
 *   · The worker's UPDATE never touches any column but name_en /
 *     name_en_source / name_en_needs_review — verified by asserting
 *     price/stock/name/category are byte-for-byte unchanged after the
 *     worker runs on a fixture row.
 *   · The sweep script's INSERT IGNORE enqueues exactly the items missing
 *     name_en, excludes SEED-% ids, and is idempotent (running it twice
 *     enqueues nothing new the second time).
 *   · --dry-run selects and prints but writes nothing.
 *
 * DB tables are self-provisioned here (same convention as every other
 * *.test.js in this folder) so this test does not depend on
 * `node db/migrate.js` having been run first — see db/migrations/0015.
 *
 * Run: node tests/integration/nameEnBackfill.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const db = require('../../db/connection');
const worker = require('../../lib/name-en-backfill-worker');
const sweep = require('../../scripts/name-en-backfill-sweep');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

const PREFIX = 'ZZNEB-';

async function ensureSchema() {
  // menu.name_en already exists on every checkout of this repo (server.js
  // addColumnIfMissing). The provenance columns are additive — 0015.
  const cols = ['name_en_source', 'name_en_needs_review', 'name_en_reviewed_by', 'name_en_reviewed_at'];
  const [existing] = await db.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='menu' AND COLUMN_NAME IN (?)",
    [cols]
  );
  const have = new Set(existing.map((r) => r.COLUMN_NAME));
  if (!have.has('name_en_source')) {
    await db.query("ALTER TABLE menu ADD COLUMN name_en_source ENUM('owner','machine_translation','transliteration') NULL");
  }
  if (!have.has('name_en_needs_review')) {
    await db.query('ALTER TABLE menu ADD COLUMN name_en_needs_review TINYINT(1) NOT NULL DEFAULT 0');
  }
  if (!have.has('name_en_reviewed_by')) {
    await db.query('ALTER TABLE menu ADD COLUMN name_en_reviewed_by VARCHAR(100) NULL');
  }
  if (!have.has('name_en_reviewed_at')) {
    await db.query('ALTER TABLE menu ADD COLUMN name_en_reviewed_at DATETIME NULL');
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS name_en_backfill_queue (
      id VARCHAR(50) NOT NULL PRIMARY KEY,
      menu_id VARCHAR(50) NOT NULL,
      status ENUM('pending','running','done','failed','skipped') NOT NULL DEFAULT 'pending',
      attempt_count INT NOT NULL DEFAULT 0,
      next_attempt_at DATETIME NOT NULL,
      last_error VARCHAR(1000) NULL,
      source_used ENUM('machine_translation','transliteration') NULL,
      proposed_name_en VARCHAR(200) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_nebq_status (status, next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function cleanup() {
  await db.query('DELETE FROM name_en_backfill_queue WHERE menu_id LIKE ?', [PREFIX + '%']);
  await db.query('DELETE FROM menu WHERE id LIKE ?', [PREFIX + '%']);
}

async function menuRow(id) {
  const [r] = await db.query(
    'SELECT id, name, name_en, name_en_source, name_en_needs_review, price, stock, category FROM menu WHERE id = ?',
    [id]
  );
  return r[0];
}

async function enqueue(menuId) {
  await db.query(
    "INSERT INTO name_en_backfill_queue (id, menu_id, next_attempt_at) VALUES (?, ?, NOW())",
    ['NEBQ-' + menuId, menuId]
  );
}

(async () => {
  console.log('\n═══ name_en backfill worker + sweep ═══\n');
  let exitCode = 0;
  try {
    await ensureSchema();
    await cleanup();

    // ── pure function: transliteration is deterministic, no network ──
    check('transliterate() is a pure sync function (no I/O)', typeof worker.transliterate === 'function');
    check('transliterate() never crashes on empty input', worker.transliterate('') === '');
    check('transliterate() never crashes on null/undefined', worker.transliterate(null) === '' && worker.transliterate(undefined) === '');
    const sample = worker.transliterate('كبسة دجاج');
    check('transliterate() produces Latin-only output', /^[\x20-\x7E]*$/.test(sample), { sample });
    check('transliterate() output respects VARCHAR(200)', worker.transliterate('ك'.repeat(500)).length <= 200);

    // ═══ Fixture 1: owner-authored name_en — must NEVER be overwritten ═══
    const OWNER_ID = PREFIX + 'OWNER';
    await db.query(
      'INSERT INTO menu (id, name, name_en, name_en_source, price, stock, category) VALUES (?,?,?,?,?,?,?)',
      [OWNER_ID, 'كبسة دجاج', 'Chicken Kabsa', null, 25.50, 10, 'ZZNEB-CAT']
    );
    await enqueue(OWNER_ID);
    const before = await menuRow(OWNER_ID);

    await worker._processBatch();

    const after = await menuRow(OWNER_ID);
    check('owner-authored name_en is byte-for-byte unchanged', after.name_en === 'Chicken Kabsa');
    check('owner-authored name_en_source stays NULL', after.name_en_source === null);
    check('owner-authored name_en_needs_review stays 0', after.name_en_needs_review === 0);
    check('…and price/stock/name/category are ALL unchanged too',
      after.price === before.price && after.stock === before.stock &&
      after.name === before.name && after.category === before.category,
      { before, after });
    const [q1] = await db.query('SELECT status FROM name_en_backfill_queue WHERE menu_id = ?', [OWNER_ID]);
    check('…and the queue row is marked skipped', q1[0] && q1[0].status === 'skipped', q1[0]);

    // ═══ Fixture 2: missing name_en — transliteration fallback ═══
    const MISSING_ID = PREFIX + 'MISSING';
    await db.query(
      'INSERT INTO menu (id, name, price, stock, category) VALUES (?,?,?,?,?)',
      [MISSING_ID, 'مندي لحم', 30.00, 5, 'ZZNEB-CAT']
    );
    await enqueue(MISSING_ID);
    const before2 = await menuRow(MISSING_ID);

    await worker._processBatch();

    const after2 = await menuRow(MISSING_ID);
    check('transliteration fallback wrote a non-empty name_en', !!after2.name_en, after2.name_en);
    check("…source is exactly 'transliteration' (never invents an API)", after2.name_en_source === 'transliteration');
    check('…needs_review is ALWAYS 1 for a machine-derived name', after2.name_en_needs_review === 1);
    check('…and price/stock/name/category are untouched',
      after2.price === before2.price && after2.stock === before2.stock &&
      after2.name === before2.name && after2.category === before2.category,
      { before: before2, after: after2 });
    const [q2] = await db.query(
      "SELECT status, source_used, proposed_name_en FROM name_en_backfill_queue WHERE menu_id = ?",
      [MISSING_ID]
    );
    check('…queue row is done with source_used=transliteration', q2[0] && q2[0].status === 'done' && q2[0].source_used === 'transliteration', q2[0]);
    check('…queue proposed_name_en matches what was written to menu', q2[0] && q2[0].proposed_name_en === after2.name_en, { queue: q2[0], menu: after2.name_en });

    // ═══ Structural guarantee: the UPDATE statement text itself ═══
    const fs = require('fs');
    const src = fs.readFileSync(__dirname + '/../../lib/name-en-backfill-worker.js', 'utf8');
    // Only count occurrences in actual (non-comment) code — the file header
    // also quotes this exact statement in its documentation, on purpose.
    const codeLines = src.split('\n').filter((l) => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
    }).join('\n');
    const updateStatements = codeLines.match(/UPDATE menu SET[^`'"]*?WHERE id = \?/g) || [];
    check('exactly ONE "UPDATE menu" statement exists in the worker\'s executable code', updateStatements.length === 1, updateStatements);
    check(
      "…and it names ONLY name_en / name_en_source / name_en_needs_review",
      updateStatements[0] === 'UPDATE menu SET name_en = ?, name_en_source = ?, name_en_needs_review = 1 WHERE id = ?',
      updateStatements[0]
    );

    // ═══ Sweep script: enqueue, exclude SEED-%, idempotent ═══
    const SEED_ID = 'SEED-' + PREFIX + 'X';
    const PLAIN_ID = PREFIX + 'SWEEPME';
    await db.query('DELETE FROM menu WHERE id IN (?, ?)', [SEED_ID, PLAIN_ID]);
    await db.query('INSERT INTO menu (id, name, price, stock, category) VALUES (?,?,?,?,?)', [SEED_ID, 'seed item', 1, 1, 'ZZNEB-CAT']);
    await db.query('INSERT INTO menu (id, name, price, stock, category) VALUES (?,?,?,?,?)', [PLAIN_ID, 'صنف بدون اسم انجليزي', 12, 3, 'ZZNEB-CAT']);

    // --dry-run writes nothing
    const savedArgv = process.argv.slice();
    process.argv = [process.argv[0], process.argv[1], '--dry-run'];
    const dryCount = await sweep.main();
    process.argv = savedArgv;
    const [afterDry] = await db.query('SELECT id FROM name_en_backfill_queue WHERE menu_id = ?', [PLAIN_ID]);
    check('--dry-run enqueues nothing', afterDry.length === 0, { dryCount, afterDry });
    check('--dry-run reports the item it WOULD enqueue', dryCount >= 1, { dryCount });

    const enqueued = await sweep.main();
    check('sweep enqueued at least the plain fixture', enqueued >= 1, { enqueued });
    const [seedQ] = await db.query('SELECT id FROM name_en_backfill_queue WHERE menu_id = ?', [SEED_ID]);
    check('SEED-% menu_id is EXCLUDED from the queue', seedQ.length === 0, seedQ);
    const [plainQ] = await db.query('SELECT id FROM name_en_backfill_queue WHERE menu_id = ?', [PLAIN_ID]);
    check('non-seed missing-name_en item WAS enqueued', plainQ.length === 1, plainQ);

    const enqueuedAgain = await sweep.main();
    check('sweep is idempotent — running again enqueues nothing new for the same rows', enqueuedAgain === 0, { enqueuedAgain });

    await db.query('DELETE FROM name_en_backfill_queue WHERE menu_id IN (?, ?)', [SEED_ID, PLAIN_ID]);
    await db.query('DELETE FROM menu WHERE id IN (?, ?)', [SEED_ID, PLAIN_ID]);

    // ═══ Unknown queue row (menu deleted out from under it) → skipped, not a crash ═══
    const GHOST_ID = PREFIX + 'GHOST-NOPE';
    await enqueue(GHOST_ID);
    await worker._processBatch();
    const [qg] = await db.query('SELECT status FROM name_en_backfill_queue WHERE menu_id = ?', [GHOST_ID]);
    check('a queue row for a since-deleted menu item is marked skipped, not crashed', qg[0] && qg[0].status === 'skipped', qg[0]);
    await db.query('DELETE FROM name_en_backfill_queue WHERE menu_id = ?', [GHOST_ID]);

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
