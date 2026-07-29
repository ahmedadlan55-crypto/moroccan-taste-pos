#!/usr/bin/env node
'use strict';
/**
 * scripts/inventory/fix-bilingual-names.js
 *
 * THE DEFECT (owner-reported, with a screenshot of /app/inventory/items):
 * inventory rows carry ENGLISH text in the Arabic-name column and nothing in
 * the English one — «Cup Holder 2», «A-31 Cold Drinks 30oz 900ML Laser Logo
 * Black» sit under «الاسم (عربي)» while «الاسم (إنجليزي)» shows the
 * «الاسم الإنجليزي مفقود» badge. Most rows also have no SKU («–»).
 *
 * WHAT THIS DOES, per qualifying row:
 *   1. name_en := the current `name`, VERBATIM. It is already correct English;
 *      it was only in the wrong column.
 *   2. name    := an Arabic translation (lib/inventory-ar-dictionary.js).
 *   3. sku     := generated when absent, unique against sku_norm.
 *
 * WHAT IT REFUSES TO DO:
 *   • It never touches a row whose `name` already contains Arabic. A
 *     correctly-named item is not a candidate, no matter what else is empty.
 *   • It never overwrites a non-empty `name_en`. That value was typed by a
 *     human; a migration does not get to second-guess it.
 *   • It never overwrites an existing sku.
 *   • It touches NO other column — not cost, not stock, not category, not
 *     unit, not active. Those are the columns a mistake would be expensive in.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --apply. The dry run
 * prints every row's before/after so the owner can read the whole change
 * before any of it happens — 193 rows is small enough to actually review.
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
const dict = require('../../lib/inventory-ar-dictionary');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const opt = (n, d) => {
  const hit = args.find((a) => a.startsWith('--' + n + '='));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const SKU_PREFIX = String(opt('sku-prefix', 'INV')).toUpperCase().replace(/[^A-Z0-9-]/g, '');
const CSV_OUT = opt('csv', null);
const LIMIT = Number(opt('limit', 0)) || 0;

const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';

(async () => {
  const [[meta]] = await db.query('SELECT DATABASE() AS db, @@hostname AS host');
  console.log(`\nDatabase: ${meta.db} @ ${meta.host}`);
  console.log(APPLY ? 'MODE: APPLY — rows will be written.\n' : 'MODE: DRY RUN — nothing will be written. Add --apply to commit.\n');

  const [rows] = await db.query(
    'SELECT id, name, name_en, sku, category, unit, active FROM inv_items ORDER BY name'
  );
  console.log(`inv_items rows: ${rows.length}`);

  // Candidates: the Arabic column holds Latin text AND the English column is
  // empty. Both conditions — a row that already has a real English name is not
  // suffering from this defect even if its Arabic column is wrong, and fixing
  // it would mean choosing which of two human-entered values to destroy.
  const candidates = rows.filter(
    (r) => dict.isLatinOnly(r.name) && !String(r.name_en || '').trim()
  );
  const alreadyArabic = rows.filter((r) => !dict.isLatinOnly(r.name)).length;
  const hasEnglishAlready = rows.filter(
    (r) => dict.isLatinOnly(r.name) && String(r.name_en || '').trim()
  );

  console.log(`  already Arabic (skipped)          : ${alreadyArabic}`);
  console.log(`  Latin name but name_en set (skip) : ${hasEnglishAlready.length}`);
  console.log(`  CANDIDATES                        : ${candidates.length}\n`);
  if (hasEnglishAlready.length) {
    console.log('  ⚠ these have a Latin `name` AND a human-typed `name_en` — left untouched');
    hasEnglishAlready.slice(0, 10).forEach((r) => console.log(`      ${r.name}  |  ${r.name_en}`));
    if (hasEnglishAlready.length > 10) console.log(`      … and ${hasEnglishAlready.length - 10} more`);
    console.log('');
  }

  const work = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  if (!work.length) { console.log('Nothing to do.'); await db.end?.(); return; }

  // ── SKU allocation ──────────────────────────────────────────────────────
  // Seeded from the highest existing PREFIX-NNNNN so a re-run never reuses a
  // number, and every candidate is checked against sku_norm before it is used.
  const [taken] = await db.query('SELECT sku_norm FROM inv_items WHERE sku_norm IS NOT NULL');
  const used = new Set(taken.map((t) => String(t.sku_norm)));
  let seq = 0;
  for (const t of used) {
    const m = new RegExp('^' + SKU_PREFIX + '-(\\d+)$').exec(t);
    if (m) seq = Math.max(seq, Number(m[1]) || 0);
  }
  const nextSku = () => {
    for (;;) {
      seq += 1;
      const sku = SKU_PREFIX + '-' + String(seq).padStart(5, '0');
      if (!used.has(sku)) { used.add(sku); return sku; }
    }
  };

  // ── Plan ────────────────────────────────────────────────────────────────
  const plan = [];
  for (const r of work) {
    const t = dict.toArabic(r.name);
    plan.push({
      id: r.id,
      oldName: r.name,
      newNameEn: r.name,                       // verbatim — it IS the English
      newNameAr: t.ar || r.name,
      sku: String(r.sku || '').trim() || nextSku(),
      hadSku: !!String(r.sku || '').trim(),
      matched: t.matched,
      tokens: t.tokens,
      untranslated: t.untranslated,
      needsReview: t.matched === 0,
      wordOrderRisk: !!t.wordOrderRisk,
    });
  }

  const review = plan.filter((p) => p.needsReview);
  const partial = plan.filter((p) => !p.needsReview && p.untranslated.length);
  const ordering = plan.filter((p) => !p.needsReview && p.wordOrderRisk);

  console.log('─'.repeat(100));
  console.log('SKU'.padEnd(12) + 'ENGLISH (moves to name_en)'.padEnd(48) + 'ARABIC (new name)');
  console.log('─'.repeat(100));
  for (const p of plan) {
    const flag = p.needsReview ? ' ⚠' : p.wordOrderRisk ? ' ↔' : p.untranslated.length ? ' ~' : '  ';
    console.log(p.sku.padEnd(12) + p.newNameEn.slice(0, 46).padEnd(48) + p.newNameAr + flag);
  }
  console.log('─'.repeat(100));
  console.log(`\nplanned: ${plan.length}   new SKUs: ${plan.filter((p) => !p.hadSku).length}`);
  console.log(`fully translated: ${plan.length - review.length - partial.length - ordering.length}`);
  console.log(`~ partial (some English words kept): ${partial.length}`);
  console.log(`↔ word order unverified (every word right, phrase may not be): ${ordering.length}`);
  console.log(`⚠ NOT translated — Arabic will equal the English: ${review.length}`);
  if (ordering.length) {
    console.log('\n  ↔ English puts the head noun LAST, Arabic puts it FIRST. These are');
    console.log('  compounds the dictionary has no phrase for, so they came out in English');
    console.log('  order. Read them, and send me any that are backwards:');
    ordering.slice(0, 25).forEach((p) => console.log(`      ${p.newNameEn}  →  ${p.newNameAr}`));
    if (ordering.length > 25) console.log(`      … and ${ordering.length - 25} more`);
  }
  if (review.length) {
    console.log('\n  These need a human Arabic name. Send them to me and I will add the terms');
    console.log('  to lib/inventory-ar-dictionary.js so a re-run fixes them:');
    review.slice(0, 25).forEach((p) => console.log('      ' + p.newNameEn));
    if (review.length > 25) console.log(`      … and ${review.length - 25} more`);
  }
  const vocab = [...new Set(plan.flatMap((p) => p.untranslated.map((w) => w.toLowerCase())))].sort();
  if (vocab.length) {
    console.log('\n  Untranslated vocabulary across all rows (' + vocab.length + '):');
    console.log('      ' + vocab.join(', '));
  }

  if (CSV_OUT) {
    const csv = ['﻿id,sku,name_en,name_ar,needs_review,word_order_unverified',
      ...plan.map((p) => [p.id, p.sku, p.newNameEn, p.newNameAr,
        p.needsReview ? 'yes' : '', p.wordOrderRisk ? 'yes' : ''].map(esc).join(','))].join('\n');
    fs.writeFileSync(CSV_OUT, csv, 'utf8');
    console.log(`\nCSV written: ${CSV_OUT}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.\n');
    await db.end?.();
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────────
  // One row per statement, keyed by primary key, naming only the four columns
  // this migration owns. A single set-based statement would be faster and would
  // also be the kind of statement that can wreck a catalogue if its WHERE
  // clause is wrong.
  let ok = 0, failed = 0;
  for (const p of plan) {
    try {
      await db.query(
        'UPDATE inv_items SET name = ?, name_en = ?, sku = ?, sku_norm = ? WHERE id = ?',
        [p.newNameAr, p.newNameEn, p.sku, p.sku.trim().toUpperCase(), p.id]
      );
      ok++;
    } catch (e) {
      failed++;
      console.error(`  ✗ ${p.id} «${p.oldName}» — ${e.code || e.message}`);
    }
  }
  console.log(`\nAPPLIED: ${ok} updated, ${failed} failed.`);
  if (review.length) {
    console.log(`${review.length} row(s) still carry an English Arabic-name — see the ⚠ list above.`);
  }
  await db.end?.();
})().catch((e) => {
  console.error('FAILED:', e.code || e.message);
  process.exit(1);
});
