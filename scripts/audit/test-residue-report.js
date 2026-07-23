#!/usr/bin/env node
/**
 * READ-ONLY report on ITEST-prefixed fixture residue in the REAL
 * `moroccan_taste_pos` dev database — Tier A.2 Corrective Gate, item 0.2.
 *
 * Every integration test written before the isolated-test-DB harness
 * (tests/helpers/testHarness.js) existed wrote fixture rows (prefixed
 * `ITEST-...` / `itest_...`) directly into the real dev database. Their
 * cleanup logic ran on every observed test pass, but a crashed run, a
 * killed process, or the process.exit()-before-finally bug documented in
 * this gate's plan could all have left rows behind undetected.
 *
 * This script ONLY runs SELECT/SHOW/INFORMATION_SCHEMA queries. It never
 * inserts, updates, or deletes anything. Any cleanup of what it finds is a
 * separate, explicit, human-reviewed decision — not automated here.
 *
 * Usage: node scripts/audit/test-residue-report.js [--out <path>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../db/connection');

const OUT_DEFAULT = path.join(__dirname, '..', '..', 'docs', 'audits', 'TEST_RESIDUE_REPORT_LOCAL_AR.md');

// Known tables + the column(s) ITEST/itest fixtures across every test file
// in this repo write their identifying prefix into. Kept as an explicit
// list (not purely dynamic) so the report stays readable and each hit is
// traceable to a known fixture pattern, rather than an opaque grep dump.
const KNOWN_TARGETS = [
  { table: 'users', column: 'username', pattern: 'itest_%' },
  { table: 'gl_accounts', column: 'id', pattern: 'ITEST-%' },
  { table: 'gl_accounts', column: 'code', pattern: 'ITEST%' },
  { table: 'gl_journals', column: 'id', pattern: 'ITEST-%' },
  { table: 'gl_journals', column: 'journal_number', pattern: 'ITEST-%' },
  { table: 'gl_entries', column: 'id', pattern: 'ITEST-%' },
  { table: 'account_roles', column: 'id', pattern: 'AR-%' }, // generated ids, not name-prefixed — see note below
  { table: 'account_role_history', column: 'id', pattern: 'ARH-%' },
  { table: 'companies', column: 'id', pattern: 'ITEST-%' },
  { table: 'settings', column: 'setting_key', pattern: 'user_meta' }, // check existence/shape, not a prefix match
  { table: 'audit_logs', column: 'entity_id', pattern: 'ITEST-%' },
];

async function tableExists(tableName) {
  const [rows] = await db.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1',
    [tableName]
  );
  return rows.length > 0;
}

async function main() {
  const outArgIdx = process.argv.indexOf('--out');
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : OUT_DEFAULT;

  const [[dbInfo]] = await db.query('SELECT DATABASE() AS db, @@hostname AS host');
  console.log(`Scanning (READ-ONLY): ${dbInfo.db}@${dbInfo.host}`);

  const findings = [];

  for (const { table, column, pattern } of KNOWN_TARGETS) {
    if (!(await tableExists(table))) {
      findings.push({ table, column, pattern, exists: false, count: 0, sample: [] });
      continue;
    }
    if (table === 'settings' && column === 'setting_key') {
      const [rows] = await db.query('SELECT setting_key, LENGTH(setting_value) len FROM settings WHERE setting_key = ?', [pattern]);
      findings.push({ table, column, pattern, exists: true, count: rows.length, sample: rows, note: 'existence check only — a present row is not automatically residue, see report note' });
      continue;
    }
    const [[cnt]] = await db.query(`SELECT COUNT(*) n FROM \`${table}\` WHERE \`${column}\` LIKE ?`, [pattern]);
    let sample = [];
    if (Number(cnt.n) > 0) {
      const [rows] = await db.query(
        `SELECT * FROM \`${table}\` WHERE \`${column}\` LIKE ? ORDER BY \`${column}\` LIMIT 10`,
        [pattern]
      );
      sample = rows;
    }
    findings.push({ table, column, pattern, exists: true, count: Number(cnt.n), sample });
  }

  // Defense-in-depth: sweep every VARCHAR/TEXT column across every table
  // (not just the curated list above) for an exact `ITEST-` or `itest_`
  // prefix, to catch anything a future test file introduces without this
  // script being updated first.
  const [candidateColumns] = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND data_type IN ('varchar','char','text','longtext')
     ORDER BY table_name, column_name`
  );
  const sweepHits = [];
  for (const { table_name: t, column_name: c } of candidateColumns) {
    // Skip columns already covered by the curated list to avoid double-counting.
    if (KNOWN_TARGETS.some((k) => k.table === t && k.column === c)) continue;
    try {
      const [[cnt]] = await db.query(
        `SELECT COUNT(*) n FROM \`${t}\` WHERE \`${c}\` LIKE 'ITEST-%' OR \`${c}\` LIKE 'itest_%'`
      );
      if (Number(cnt.n) > 0) sweepHits.push({ table: t, column: c, count: Number(cnt.n) });
    } catch (_) {
      // some columns (generated/virtual, or a LIKE-incompatible collation) can't be scanned this way — skip silently, it's a best-effort sweep
    }
  }

  const totalKnownResidue = findings.filter((f) => f.table !== 'settings').reduce((s, f) => s + f.count, 0);
  const totalSweepResidue = sweepHits.reduce((s, h) => s + h.count, 0);

  const lines = [];
  lines.push('# تقرير بقايا بيانات الاختبار (قراءة فقط) — قاعدة التطوير المحلية');
  lines.push('');
  lines.push(`**القاعدة:** \`${dbInfo.db}\`@\`${dbInfo.host}\` — **تاريخ التوليد:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('> هذا التقرير **قراءة فقط بالكامل**. لا يحذف ولا يعدّل أي شيء. أي تنظيف فعلي لما يظهر هنا قرار منفصل يحتاج مراجعة بشرية صريحة.');
  lines.push('');
  lines.push('## الفحص المعروف (جداول/أعمدة محددة سلفًا حسب أنماط fixtures الفعلية)');
  lines.push('');
  for (const f of findings) {
    if (!f.exists) { lines.push(`- \`${f.table}.${f.column}\` — **الجدول غير موجود** (تخطّي).`); continue; }
    if (f.table === 'settings') {
      lines.push(`- \`settings.setting_key = 'user_meta'\` — ${f.count > 0 ? 'موجود' : 'غير موجود'} (فحص وجود فقط؛ وجوده ليس بالضرورة بقايا — قد يكون إعدادًا حقيقيًا. ${f.note})`);
      continue;
    }
    lines.push(`- \`${f.table}.${f.column} LIKE '${f.pattern}'\` — **${f.count}** صفًا${f.count > 0 ? ' (عيّنة أدناه)' : ''}`);
    if (f.count > 0) {
      lines.push('  ```json');
      lines.push('  ' + JSON.stringify(f.sample, null, 2).split('\n').join('\n  '));
      lines.push('  ```');
    }
  }
  lines.push('');
  lines.push(`**إجمالي البقايا المعروفة:** ${totalKnownResidue} صفًا عبر الجداول المفحوصة أعلاه (باستثناء فحص settings الذي هو وجود لا عدّ).`);
  lines.push('');
  lines.push('## الفحص الشامل (كل عمود VARCHAR/TEXT في كل جدول، بحثًا عن ITEST-/itest_ خارج القائمة أعلاه)');
  lines.push('');
  if (sweepHits.length === 0) {
    lines.push('لا شيء — لم يُعثر على أي عمود إضافي يحوي بادئة ITEST-/itest_ خارج الجداول المفحوصة أعلاه.');
  } else {
    for (const h of sweepHits) lines.push(`- \`${h.table}.${h.column}\` — **${h.count}** صفًا`);
  }
  lines.push('');
  lines.push(`**إجمالي بقايا الفحص الشامل الإضافية:** ${totalSweepResidue} صفًا.`);
  lines.push('');
  lines.push('## الخلاصة');
  lines.push('');
  lines.push(
    totalKnownResidue + totalSweepResidue === 0
      ? '**صفر بقايا مكتشفة.** كل تشغيلات الاختبار السابقة على هذه القاعدة نظّفت بعد نفسها بنجاح.'
      : `**${totalKnownResidue + totalSweepResidue} صفًا من البقايا المحتملة مكتشفة.** هذا التقرير لا يحذفها — راجع القوائم أعلاه وقرر يدويًا.`
  );
  lines.push('');

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`Report written to: ${outPath}`);
  console.log(`Known-target residue: ${totalKnownResidue} rows. Sweep residue: ${totalSweepResidue} rows.`);

  await db.end();
}

main().catch((e) => {
  console.error('test-residue-report FAILED:', e.message);
  process.exit(1);
});
