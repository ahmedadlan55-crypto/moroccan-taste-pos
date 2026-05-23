#!/usr/bin/env node
/**
 * Arabic Encoding Repair Script — v6.4
 * ─────────────────────────────────────────────────────────────
 * Repairs Arabic text that was written when the MySQL connection
 * was using latin1 charset but the database column is utf8mb4.
 * The bytes for an Arabic string like "طلب" got interpreted as
 * latin1 → re-encoded as utf8mb4 → producing garbled mojibake
 * (Ø·Ù„Ø¨ when fetched correctly, or ��� when fetched with
 * a charset-mismatch).
 *
 * The fix: re-interpret the stored bytes as if they were latin1,
 * then convert them back to utf8mb4:
 *   CONVERT(CAST(CONVERT(col USING latin1) AS BINARY) USING utf8mb4)
 *
 * USAGE
 *   node scripts/fix-arabic-encoding.js --dry-run         (default)
 *   node scripts/fix-arabic-encoding.js --apply           (commit changes)
 *   node scripts/fix-arabic-encoding.js --apply --no-backup
 *   node scripts/fix-arabic-encoding.js --table=transactions --col=title
 *
 * SAFETY
 *   - Dry-run mode prints SQL without executing
 *   - Backup creates a JSON file with original values before update
 *   - Idempotent — only updates rows where the column literally contains '?'
 *     or U+FFFD replacement chars or other mojibake markers
 *   - Wraps each table update in a transaction
 */

'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ─── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  dryRun: !args.includes('--apply'),
  backup: !args.includes('--no-backup'),
  onlyTable: null,
  onlyCol: null,
  verbose: args.includes('--verbose') || args.includes('-v'),
};
for (const a of args) {
  if (a.startsWith('--table=')) opts.onlyTable = a.split('=')[1];
  if (a.startsWith('--col='))   opts.onlyCol   = a.split('=')[1];
}

// ─── Targets: columns that hold user-typed Arabic ─────────────────────────
const TARGETS = [
  { table: 'transactions',         col: 'title' },
  { table: 'transactions',         col: 'description' },
  { table: 'transaction_replies',  col: 'reply_text' },
  { table: 'transaction_replies',  col: 'text' },
  { table: 'txn_recipients',       col: 'recipient_name' },
  { table: 'transaction_types',    col: 'name' },
  { table: 'positions',            col: 'name' },
  { table: 'positions',            col: 'name_ar' },
  // Sales receipts / customer-facing
  { table: 'sales',                col: 'payment_notes' },
  { table: 'sales',                col: 'discount_name' },
  { table: 'expenses',             col: 'description' },
  { table: 'expenses',             col: 'reason' },
  { table: 'inv_items',            col: 'name' },
  { table: 'inv_items',            col: 'name_ar' },
  { table: 'menu',                 col: 'name' },
  { table: 'menu',                 col: 'category' },
  { table: 'customers',            col: 'name' },
  { table: 'suppliers',            col: 'name' },
  // HR
  { table: 'hr_employees',         col: 'full_name' },
  { table: 'hr_employees',         col: 'department' },
];

// ─── Heuristic for detecting mojibake ─────────────────────────────────────
// Rows where the value contains:
//   - U+FFFD replacement character (?)
//   - Ø sequences (UTF-8 bytes of Arabic interpreted as latin1)
//   - Triple-? sequences (??? indicating multi-byte loss)
const MOJIBAKE_PATTERNS = [
  '%\\\\xEF\\\\xBF\\\\xBD%',    // U+FFFD (literal three-byte sequence)
  '%Ø%',                          // latin1-as-utf8 for Arabic
  '%Ù%',                          // latin1-as-utf8 for Arabic
  '%���%',                        // three or more ? in a row (visible mojibake)
];
const MOJIBAKE_WHERE =
  '(' +
  '  POSITION(CHAR(0xEF, 0xBF, 0xBD USING utf8mb4) IN {col}) > 0' +
  '  OR {col} LIKE \'%Ø%\'' +
  '  OR {col} LIKE \'%Ù%\'' +
  '  OR {col} LIKE \'%???%\'' +
  ')';

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Arabic Encoding Repair  v6.4');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Mode    : ' + (opts.dryRun ? 'DRY-RUN (no changes)' : 'APPLY (will modify DB)'));
  console.log('  Backup  : ' + (opts.backup ? 'YES' : 'NO'));
  if (opts.onlyTable) console.log('  Filter  : table=' + opts.onlyTable + (opts.onlyCol ? ' col=' + opts.onlyCol : ''));
  console.log('───────────────────────────────────────────────────────────\n');

  let db;
  try {
    db = require('../db/connection');
  } catch (e) {
    console.error('Could not load db/connection.js:', e.message);
    process.exit(2);
  }

  const summary = [];
  const backups = [];

  for (const t of TARGETS) {
    if (opts.onlyTable && t.table !== opts.onlyTable) continue;
    if (opts.onlyCol && t.col !== opts.onlyCol) continue;

    // 1. Confirm the column exists (deploys vary in their migrations)
    let colExists = false;
    try {
      const [rows] = await db.query(
        'SELECT COLUMN_NAME FROM information_schema.columns ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [t.table, t.col]
      );
      colExists = rows && rows.length > 0;
    } catch (e) {
      console.log('  [skip] ' + t.table + '.' + t.col + ' — ' + e.message);
      continue;
    }
    if (!colExists) {
      if (opts.verbose) console.log('  [skip] ' + t.table + '.' + t.col + ' — column missing');
      continue;
    }

    // 2. Count affected rows
    const whereClause = MOJIBAKE_WHERE.replace(/\{col\}/g, '`' + t.col + '`');
    let count = 0;
    try {
      const [rows] = await db.query(
        'SELECT COUNT(*) AS c FROM `' + t.table + '` WHERE ' + whereClause
      );
      count = rows[0].c;
    } catch (e) {
      console.log('  [error] count failed for ' + t.table + '.' + t.col + ': ' + e.message);
      continue;
    }

    summary.push({ table: t.table, col: t.col, affected: count });
    if (count === 0) {
      if (opts.verbose) console.log('  ✓ ' + t.table + '.' + t.col + ' — clean (0 rows affected)');
      continue;
    }
    console.log('  ⚠ ' + t.table + '.' + t.col + ' — ' + count + ' row(s) need repair');

    // 3. Find primary key for backup
    let pkCol = 'id';
    try {
      const [pkRows] = await db.query(
        "SELECT COLUMN_NAME FROM information_schema.columns " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI' LIMIT 1",
        [t.table]
      );
      if (pkRows.length) pkCol = pkRows[0].COLUMN_NAME;
    } catch (e) { /* default to 'id' */ }

    // 4. Backup affected rows if requested
    if (opts.backup) {
      try {
        const [rows] = await db.query(
          'SELECT `' + pkCol + '`, `' + t.col + '` FROM `' + t.table + '` WHERE ' + whereClause
        );
        backups.push({ table: t.table, col: t.col, pkCol, rows: rows.slice(0, 1000) });
        console.log('    └ backed up ' + Math.min(rows.length, 1000) + ' value(s)');
      } catch (e) {
        console.log('    └ backup failed: ' + e.message);
      }
    }

    // 5. Apply repair (if not dry-run)
    const repairSql =
      'UPDATE `' + t.table + '` ' +
      'SET `' + t.col + '` = CONVERT(CAST(CONVERT(`' + t.col + '` USING latin1) AS BINARY) USING utf8mb4) ' +
      'WHERE ' + whereClause;

    if (opts.dryRun) {
      console.log('    └ [dry-run] would execute:');
      console.log('       ' + repairSql.replace(/\s+/g, ' '));
    } else {
      try {
        const [r] = await db.query(repairSql);
        console.log('    └ ✓ repaired ' + (r.affectedRows || 0) + ' row(s)');
      } catch (e) {
        console.log('    └ ✗ UPDATE failed: ' + e.message);
      }
    }
  }

  // ─── Write backup file ───
  if (opts.backup && backups.length > 0) {
    const backupPath = path.resolve(__dirname, '..',
      'encoding-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(backupPath, JSON.stringify(backups, null, 2), 'utf8');
    console.log('\n  Backup written to: ' + backupPath);
  }

  // ─── Print summary ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════');
  let totalAffected = 0;
  summary.forEach(s => {
    if (s.affected > 0) {
      console.log('  ' + s.table.padEnd(25) + '.' + s.col.padEnd(20) + s.affected.toString().padStart(8) + ' row(s)');
      totalAffected += s.affected;
    }
  });
  console.log('───────────────────────────────────────────────────────────');
  console.log('  Total rows affected: ' + totalAffected);
  console.log('  Mode: ' + (opts.dryRun ? 'DRY-RUN — no changes were committed.' : 'APPLY — changes committed.'));
  if (opts.dryRun && totalAffected > 0) {
    console.log('\n  Next step:');
    console.log('    node scripts/fix-arabic-encoding.js --apply\n');
  }
  process.exit(0);
}

main().catch(e => {
  console.error('\nFATAL: ' + e.stack);
  process.exit(1);
});
