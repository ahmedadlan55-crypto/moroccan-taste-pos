'use strict';
/*
 * scripts/migrate-item-units.js — seed the per-item item_units rows from the
 * legacy free-text unit fields on inv_items (unit / big_unit / conv_rate).
 *
 *   base unit   ← inv_items.unit           (conversion_to_base = 1, is_base = 1)
 *   major unit  ← inv_items.big_unit       (conversion_to_base = conv_rate)  [only if set & >1]
 *
 * Idempotent (INSERT … ON DUPLICATE KEY UPDATE keeps existing rows), and it
 * NEVER touches stock / warehouse_stock / lot balances — quantities already
 * live in the base unit, so migrating the unit metadata changes nothing
 * quantitatively. Dry-run by default; pass --apply to write.
 *
 *   node scripts/migrate-item-units.js            # dry-run summary
 *   node scripts/migrate-item-units.js --apply    # write rows
 */
require('dotenv').config();
const crypto = require('crypto');
const db = require('../db/connection');

const APPLY = process.argv.includes('--apply');
const rid = () => 'IU-' + crypto.randomBytes(7).toString('hex');
const norm = (s) => String(s == null ? '' : s).trim();
const codeOf = (s) => norm(s).replace(/\s+/g, '_').toUpperCase().slice(0, 30);

async function unitMasterMap() {
  const map = new Map();
  try {
    const [rows] = await db.query('SELECT id, name_ar, name_en FROM units');
    for (const r of rows) {
      if (r.name_ar) map.set(norm(r.name_ar), r.id);
      if (r.name_en) map.set(norm(r.name_en).toLowerCase(), r.id);
    }
  } catch (_) {}
  return map;
}

(async () => {
  const master = await unitMasterMap();
  const [items] = await db.query(
    "SELECT id, COALESCE(NULLIF(TRIM(unit),''),'حبة') AS unit, big_unit, COALESCE(conv_rate,1) AS conv_rate FROM inv_items"
  );
  let baseNew = 0, baseSkip = 0, majorNew = 0, majorSkip = 0, majorInvalid = 0;
  const rowsToWrite = [];

  for (const it of items) {
    const baseName = norm(it.unit) || 'حبة';
    const baseCode = codeOf(baseName) || 'UNIT';
    rowsToWrite.push({
      item_id: it.id, unit_id: master.get(baseName) || null, unit_name: baseName,
      unit_code: baseCode, is_base: 1, conversion_to_base: 1,
    });

    const bigName = norm(it.big_unit);
    const factor = Number(it.conv_rate) || 1;
    if (bigName) {
      const bigCode = codeOf(bigName);
      if (!(factor > 0)) { majorInvalid++; }
      else if (bigCode === baseCode || factor === 1) { majorSkip++; } // not a real major unit
      else {
        rowsToWrite.push({
          item_id: it.id, unit_id: master.get(bigName) || null, unit_name: bigName,
          unit_code: bigCode, is_base: 0, conversion_to_base: factor,
        });
      }
    }
  }

  // Determine which already exist (idempotency reporting)
  const [existing] = await db.query('SELECT item_id, unit_code FROM item_units');
  const have = new Set(existing.map((r) => r.item_id + '|' + r.unit_code));
  for (const r of rowsToWrite) {
    const key = r.item_id + '|' + r.unit_code;
    if (r.is_base) { have.has(key) ? baseSkip++ : baseNew++; }
    else { have.has(key) ? majorSkip++ : majorNew++; }
  }

  console.log('═══ migrate-item-units (' + (APPLY ? 'APPLY' : 'DRY-RUN') + ') ═══');
  console.log('items scanned:', items.length);
  console.log('base units  → new:', baseNew, '| existing:', baseSkip);
  console.log('major units → new:', majorNew, '| existing:', majorSkip, '| skipped(invalid/factor≤1/dup):', majorSkip, '(', majorInvalid, 'invalid factor)');

  if (!APPLY) { console.log('\nDRY-RUN — no writes. Re-run with --apply.'); await db.end(); return; }

  let written = 0;
  await db.withTransaction(async (conn) => {
    for (const r of rowsToWrite) {
      await conn.query(
        `INSERT INTO item_units (id, item_id, unit_id, unit_name, unit_code, is_base, conversion_to_base, created_by)
         VALUES (?,?,?,?,?,?,?, 'migrate-item-units')
         ON DUPLICATE KEY UPDATE unit_name = VALUES(unit_name), unit_id = COALESCE(item_units.unit_id, VALUES(unit_id))`,
        [rid(), r.item_id, r.unit_id, r.unit_name, r.unit_code, r.is_base, r.conversion_to_base]
      );
      written++;
    }
  });
  // Invariant check: exactly one base unit per item that has any unit row.
  const [dupBase] = await db.query(
    'SELECT item_id, COUNT(*) c FROM item_units WHERE is_base=1 GROUP BY item_id HAVING c<>1'
  );
  console.log('\nwrote/updated rows:', written);
  console.log('items with ≠1 base unit (must be 0):', dupBase.length, dupBase.slice(0, 5));
  console.log('quantities/stock untouched ✓');
  await db.end();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
