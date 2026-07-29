#!/usr/bin/env node
'use strict';
/**
 * tests/inventoryArDictionary.test.js — the English→Arabic inventory naming
 * rules, pinned.
 *
 * The owner's catalogue has English text in the Arabic-name column, no English
 * name, and no SKU. lib/inventory-ar-dictionary.js + the migration script fix
 * that — and the rules below are the ones that make the result trustworthy
 * rather than merely different:
 *
 *   • a measurement or supplier code is NEVER translated. «30oz», «900ML»,
 *     «A-31» identify the physical box on the shelf and in the supplier's
 *     catalogue. Translating or reformatting one severs the row from the thing
 *     it represents.
 *   • an unknown word stays ENGLISH. The temptation is to transliterate, which
 *     is what the menu worker does — but «Cup Holder» → «كب هولدر» is not
 *     Arabic, it is noise nobody can search or read. Half-translated is
 *     legible; transliterated is not.
 *   • a row that already has Arabic is never a candidate, whatever else is
 *     missing.
 *
 * Run: node tests/inventoryArDictionary.test.js   (pure, no DB)
 */
const fs = require('fs');
const path = require('path');
const d = require('../lib/inventory-ar-dictionary');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}

// ── 1. The owner's actual item names ─────────────────────────────────────
{
  const cases = [
    ['Cup Holder 2', 'حامل أكواب 2'],
    ['Cup Holder 4', 'حامل أكواب 4'],
    ['Paper Bag Large', 'كيس ورقي كبير'],
    ['Wooden Stirrer', 'محرّك خشبي'],
    ['Plastic Spoon Small', 'ملعقة بلاستيك صغير'],
  ];
  for (const [en, ar] of cases) {
    check(`«${en}» → «${ar}»`, d.toArabic(en).ar === ar, d.toArabic(en).ar);
  }
}

// ── 2. Measurements, sizes and supplier codes survive verbatim ───────────
// This is the rule that keeps a translated row identifiable on a shelf.
{
  const r = d.toArabic('A-31 Cold Drinks 30oz 900ML Laser Logo Black');
  check('the supplier code A-31 is preserved', r.ar.includes('A-31'), r.ar);
  check('30oz is preserved exactly', r.ar.includes('30oz'), r.ar);
  check('900ML is preserved exactly', r.ar.includes('900ML'), r.ar);
  check('«Cold Drinks» became «مشروبات باردة»', r.ar.includes('مشروبات باردة'), r.ar);
  check('«Laser Logo» became «شعار ليزر»', r.ar.includes('شعار ليزر'), r.ar);
  check('«Black» became «أسود»', r.ar.includes('أسود'), r.ar);
  check('no Latin letters survive except the preserved code/measurements',
    (r.ar.match(/[A-Za-z]+/g) || []).every((t) => /^(A|oz|ML)$/i.test(t) || /\d/.test(t)),
    r.ar.match(/[A-Za-z]+/g));

  // Colour must be the ONLY difference between two otherwise identical SKUs.
  const blue = d.toArabic('A-31 Cold Drinks 30oz 900ML Laser Logo Blue').ar;
  check('the Blue variant differs only in the colour word',
    blue === r.ar.replace('أسود', 'أزرق'), { black: r.ar, blue });
}

// ── 3. Unknown words stay English — never transliterated ─────────────────
{
  const r = d.toArabic('Widget XYZ Unknown');
  check('an entirely unknown name is left as-is', r.ar === 'Widget XYZ Unknown', r.ar);
  check('and it reports zero matches so the caller can flag it', r.matched === 0, r.matched);
  check('and it lists what it could not translate', r.untranslated.length === 3, r.untranslated);

  const mixed = d.toArabic('Cup Widget');
  check('a partially-known name translates what it knows', mixed.ar.includes('كوب'), mixed.ar);
  check('and keeps the rest in English', mixed.ar.includes('Widget'), mixed.ar);
}

// ── 3b. Compound word order — English head-final vs Arabic head-initial ──
// Caught by running the real script against a fixture: «Napkin Pack» came out
// «منديل عبوة» — both words right, phrase backwards — and nothing flagged it
// because `matched` was full. Word order can't be fixed without parsing, so
// known compounds became phrases and unknown ones are REPORTED.
{
  check('a known compound is emitted head-first', d.toArabic('Napkin Pack').ar === 'عبوة مناديل', d.toArabic('Napkin Pack').ar);
  check('and is therefore NOT flagged', d.toArabic('Napkin Pack').wordOrderRisk === false);

  // Two nouns, no phrase for the pair → order is unverified and must be said so.
  const risky = d.toArabic('Tray Sleeve');
  check('two word-path nouns raise wordOrderRisk', risky.wordOrderRisk === true, risky);
  check('…while still translating both words', risky.matched === 2, risky);

  // Noun + adjective is NOT a compound — Arabic already wants it in this order.
  check('adjective-modified nouns are not flagged', d.toArabic('Paper Bag Large').wordOrderRisk === false);
  check('single nouns are not flagged', d.toArabic('Wooden Stirrer').wordOrderRisk === false);
  check('phrase-matched multiwords are not flagged', d.toArabic('Cup Holder 2').wordOrderRisk === false);
}

// ── 4. isLatinOnly decides who is a candidate ────────────────────────────
{
  check('English text is a candidate', d.isLatinOnly('Cup Holder 2'));
  check('Arabic text is NOT a candidate', !d.isLatinOnly('كوب ورقي'));
  check('Arabic mixed with a measurement is NOT a candidate', !d.isLatinOnly('كوب 30oz'));
  check('empty is NOT a candidate', !d.isLatinOnly(''));
  check('whitespace is NOT a candidate', !d.isLatinOnly('   '));
  check('digits alone are NOT a candidate (no letters to move)', !d.isLatinOnly('1234'));
}

// ── 5. Purity — the dictionary may never reach the database ──────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory-ar-dictionary.js'), 'utf8');
  check('the dictionary requires nothing', !/require\(/.test(src));
  check('the dictionary contains no SQL', !/UPDATE |INSERT |SELECT /i.test(src));
}

// ── 6. The migration script's safety contract ────────────────────────────
{
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inventory', 'fix-bilingual-names.js'), 'utf8');
  check('dry run is the default (writes need --apply)', /const APPLY = args\.includes\('--apply'\)/.test(s));
  check('it guards every write behind APPLY', /if \(!APPLY\)[\s\S]{0,200}return;/.test(s));
  // The whole point: it must not be able to touch the columns a mistake would
  // be expensive in.
  const update = (s.match(/UPDATE inv_items SET[^']*/g) || []).join(' ');
  check('the only UPDATE names exactly name, name_en, sku, sku_norm',
    /SET name = \?, name_en = \?, sku = \?, sku_norm = \? WHERE id = \?/.test(update), update);
  for (const col of ['cost', 'stock', 'category', 'unit', 'active', 'conv_rate', 'min_stock']) {
    check(`the UPDATE never names \`${col}\``, !new RegExp('\\b' + col + '\\s*=').test(update), col);
  }
  check('it never DELETEs', !/DELETE\s+FROM/i.test(s));
  // Only SQL *string literals* count here — an earlier version of this check
  // read the prose too and failed on the word UPDATE inside a comment.
  const sqlLiterals = s.match(/'(?:SELECT|UPDATE|INSERT|DELETE)[^']*'/gi) || [];
  check('it issues exactly one write statement', sqlLiterals.filter((q) => /^'UPDATE/i.test(q)).length === 1, sqlLiterals);
  check('and that write targets inv_items', sqlLiterals.every((q) => !/^'UPDATE/i.test(q) || /^'UPDATE inv_items /i.test(q)), sqlLiterals);
  check('candidates require BOTH a Latin name and an empty name_en',
    /isLatinOnly\(r\.name\) && !String\(r\.name_en \|\| ''\)\.trim\(\)/.test(s));
  check('an existing sku is never overwritten', /String\(r\.sku \|\| ''\)\.trim\(\) \|\| nextSku\(\)/.test(s));
  check('generated SKUs are checked against the live sku_norm set', /used\.has\(sku\)/.test(s));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ inventory naming: codes preserved, unknowns stay English, only 4 columns writable');
