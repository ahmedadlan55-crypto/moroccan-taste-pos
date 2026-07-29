#!/usr/bin/env node
'use strict';
/**
 * scripts/inventory/fix-bilingual-names.js — CLI over lib/inventory/bilingualNames.js.
 *
 * The repair itself (candidate rule, translation, SKU allocation, the write
 * statement) lives in that module because the `InventoryBilingualNames_v1`
 * boot migration in server.js runs the same repair unattended. This file only
 * adds what a human at a terminal needs: a full before/after table, a CSV
 * export, and the requirement to type --apply before anything is written.
 *
 * In normal operation nobody runs this — the boot migration already fixed the
 * catalogue on deploy. It exists for re-running after the dictionary grows,
 * for previewing against a copy, and for the CSV.
 *
 * Usage:
 *   node scripts/inventory/fix-bilingual-names.js                 # preview
 *   node scripts/inventory/fix-bilingual-names.js --csv out.csv   # preview + export
 *   node scripts/inventory/fix-bilingual-names.js --apply         # write
 *   node scripts/inventory/fix-bilingual-names.js --apply --sku-prefix PKG
 */

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const db = require('../../db/connection');
const bilingual = require('../../lib/inventory/bilingualNames');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const opt = (n, d) => {
  const hit = args.find((a) => a.startsWith('--' + n + '='));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const SKU_PREFIX = opt('sku-prefix', bilingual.DEFAULT_SKU_PREFIX);
const CSV_OUT = opt('csv', null);
const LIMIT = Number(opt('limit', 0)) || 0;

const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';

(async () => {
  const [[meta]] = await db.query('SELECT DATABASE() AS db, @@hostname AS host');
  console.log(`\nDatabase: ${meta.db} @ ${meta.host}`);
  console.log(APPLY
    ? 'MODE: APPLY — rows will be written.\n'
    : 'MODE: DRY RUN — nothing will be written. Add --apply to commit.\n');

  const [rows] = await db.query(bilingual.SELECT_SQL);
  const r = bilingual.planBilingualNames(rows, { skuPrefix: SKU_PREFIX, limit: LIMIT });
  const s = r.stats;

  console.log(`inv_items rows: ${s.total}`);
  console.log(`  already Arabic (skipped)          : ${s.alreadyArabic}`);
  console.log(`  Latin name but name_en set (skip) : ${s.humanEnglish}`);
  console.log(`  CANDIDATES                        : ${s.candidates}\n`);
  if (r.skipped.humanEnglish.length) {
    console.log('  ⚠ these have a Latin `name` AND a human-typed `name_en` — left untouched');
    r.skipped.humanEnglish.slice(0, 10).forEach((x) => console.log(`      ${x.name}  |  ${x.name_en}`));
    if (r.skipped.humanEnglish.length > 10) console.log(`      … and ${r.skipped.humanEnglish.length - 10} more`);
    console.log('');
  }
  if (!r.plan.length) { console.log('Nothing to do.'); await db.end?.(); return; }

  console.log('─'.repeat(100));
  console.log('SKU'.padEnd(12) + 'ENGLISH (moves to name_en)'.padEnd(48) + 'ARABIC (new name)');
  console.log('─'.repeat(100));
  for (const p of r.plan) {
    const flag = p.needsReview ? ' ⚠' : p.wordOrderRisk ? ' ↔' : p.untranslated.length ? ' ~' : '  ';
    console.log(p.sku.padEnd(12) + p.newNameEn.slice(0, 46).padEnd(48) + p.newNameAr + flag);
  }
  console.log('─'.repeat(100));
  console.log(`\nplanned: ${s.planned}   new SKUs: ${s.newSkus}`);
  console.log(`fully translated: ${s.clean}`);
  console.log(`~ partial (some English words kept): ${s.partial}`);
  console.log(`↔ word order unverified (every word right, phrase may not be): ${s.wordOrderRisk}`);
  console.log(`⚠ NOT translated — Arabic will equal the English: ${s.needsReview}`);
  if (r.ordering.length) {
    console.log('\n  ↔ English puts the head noun LAST, Arabic puts it FIRST. These are');
    console.log('  compounds the dictionary has no phrase for, so they came out in English');
    console.log('  order. Read them, and send me any that are backwards:');
    r.ordering.slice(0, 25).forEach((p) => console.log(`      ${p.newNameEn}  →  ${p.newNameAr}`));
    if (r.ordering.length > 25) console.log(`      … and ${r.ordering.length - 25} more`);
  }
  if (r.review.length) {
    console.log('\n  ⚠ These need a human Arabic name. A later run with a bigger dictionary');
    console.log('  will pick them up again (name_en === name keeps them eligible):');
    r.review.slice(0, 25).forEach((p) => console.log('      ' + p.newNameEn));
    if (r.review.length > 25) console.log(`      … and ${r.review.length - 25} more`);
  }
  if (r.vocabulary.length) {
    console.log(`\n  Untranslated vocabulary across all rows (${r.vocabulary.length}):`);
    console.log('      ' + r.vocabulary.join(', '));
  }

  if (CSV_OUT) {
    const csv = ['﻿id,sku,name_en,name_ar,needs_review,word_order_unverified',
      ...r.plan.map((p) => [p.id, p.sku, p.newNameEn, p.newNameAr,
        p.needsReview ? 'yes' : '', p.wordOrderRisk ? 'yes' : ''].map(esc).join(','))].join('\n');
    fs.writeFileSync(CSV_OUT, csv, 'utf8');
    console.log(`\nCSV written: ${CSV_OUT}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.\n');
    await db.end?.();
    return;
  }

  const res = await bilingual.applyPlan(db, r.plan);
  console.log(`\nAPPLIED: ${res.updated} updated, ${res.failures.length} failed.`);
  res.failures.forEach((f) => console.error(`  ✗ ${f.id} «${f.name}» — ${f.error}`));
  if (r.review.length) {
    console.log(`${r.review.length} row(s) still carry an English Arabic-name — see the ⚠ list above.`);
  }
  await db.end?.();
})().catch((e) => {
  console.error('FAILED:', e.code || e.message);
  process.exit(1);
});
