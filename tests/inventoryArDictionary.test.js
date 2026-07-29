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

// ── 6. The repair's safety contract ──────────────────────────────────────
// Asserted against lib/inventory/bilingualNames.js — the single module the CLI
// AND the InventoryBilingualNames_v1 boot migration both call. Pinning it here
// rather than in the script is the point: the unattended caller is the one
// nobody watches.
const bilingual = require('../lib/inventory/bilingualNames');
{
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory', 'bilingualNames.js'), 'utf8');
  const sqlLiterals = s.match(/'(?:SELECT|UPDATE|INSERT|DELETE)[^']*'/gi) || [];
  const writes = sqlLiterals.filter((q) => /^'(UPDATE|INSERT|DELETE)/i.test(q));
  check('exactly one write statement exists', writes.length === 1, writes);
  check('it names exactly name, name_en, sku, sku_norm — by primary key',
    /^'UPDATE inv_items SET name = \?, name_en = \?, sku = \?, sku_norm = \? WHERE id = \?'$/.test(writes[0] || ''), writes[0]);
  for (const col of ['cost', 'stock', 'category', 'unit', 'active', 'conv_rate', 'min_stock']) {
    check(`the write never names \`${col}\``, !new RegExp('\\b' + col + '\\s*=\\s*\\?').test(writes[0] || ''), col);
  }
  check('it never DELETEs', !/DELETE\s+FROM/i.test(s));
  check('every statement targets inv_items',
    sqlLiterals.every((q) => /inv_items/.test(q)), sqlLiterals);
  check('the writable-column list matches the statement',
    JSON.stringify(bilingual.WRITABLE_COLUMNS) === JSON.stringify(['name', 'name_en', 'sku', 'sku_norm']),
    bilingual.WRITABLE_COLUMNS);

  // The CLI keeps its own guarantee: nothing is written without --apply.
  const cli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inventory', 'fix-bilingual-names.js'), 'utf8');
  check('the CLI defaults to dry run', /const APPLY = args\.includes\('--apply'\)/.test(cli));
  check('the CLI returns before applyPlan when not --apply', /if \(!APPLY\)[\s\S]{0,200}return;[\s\S]{0,200}applyPlan/.test(cli));
  check('the CLI does not carry its own copy of the write', !/UPDATE inv_items SET/i.test(cli));

  // The boot migration must be gated, and must not be able to stop the server.
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = (srv.split("const INV_NAMES_KEY")[1] || '').slice(0, 3000);
  check('the boot migration is gated on a settings key', /SELECT setting_value FROM settings WHERE setting_key = \? LIMIT 1/.test(block));
  check('…and records the key when it finishes', /INSERT INTO settings \(setting_key, setting_value\) VALUES \(\?, \\?'1\\?'\)/.test(block), block.slice(0, 200));
  check('…and cannot abort startup', /catch \(e\) \{ console\.error\('\[inv-names\]'/.test(srv));
  check('…and calls the shared module, not its own SQL', /bilingual\.applyPlan\(db, r\.plan\)/.test(block));
  check('…and does not hand-roll the row query', !/UPDATE inv_items SET/i.test(block));
}

// ── 7. Candidacy — including the re-run rule ─────────────────────────────
// A row the dictionary could not translate keeps name_en === name. If
// candidacy demanded an EMPTY name_en, that row would be frozen out of every
// future run and a better dictionary could never reach it.
{
  const C = bilingual.isCandidate;
  check('English name, no English column → candidate', C({ name: 'Cup Holder 2', name_en: null }));
  check('English name, blank English column → candidate', C({ name: 'Cup Holder 2', name_en: '   ' }));
  check('a previous run left name_en === name → STILL a candidate',
    C({ name: 'Widget XYZ', name_en: 'Widget XYZ' }));
  check('a DIFFERENT human-typed name_en → never a candidate',
    !C({ name: 'Dome Lid 90mm', name_en: 'Dome Lid 90 mm' }));
  check('Arabic name → never a candidate, even with everything else empty',
    !C({ name: 'كوب ورقي', name_en: null, sku: null }));
}

// ── 8. Planning: SKU allocation and the skip buckets ─────────────────────
{
  const rows = [
    { id: 1, name: 'Cup Holder 2', name_en: null, sku: null, sku_norm: null },
    { id: 2, name: 'Paper Bag Large', name_en: null, sku: null, sku_norm: null },
    { id: 3, name: 'كوب ورقي', name_en: null, sku: null, sku_norm: null },
    { id: 4, name: 'Dome Lid 90mm', name_en: 'Dome Lid 90 mm', sku: null, sku_norm: null },
    { id: 5, name: 'Napkin Pack', name_en: null, sku: 'OLD-777', sku_norm: 'OLD-777' },
    { id: 6, name: 'Wooden Stirrer', name_en: null, sku: null, sku_norm: 'INV-00007' },
  ];
  const r = bilingual.planBilingualNames(rows);
  const by = (id) => r.plan.find((p) => p.id === id);

  check('the Arabic row is skipped', r.stats.alreadyArabic === 1 && !by(3), r.stats);
  check('the human-English row is skipped', r.stats.humanEnglish === 1 && !by(4), r.stats);
  check('four rows are planned', r.stats.planned === 4, r.stats);
  check('an existing SKU is carried through untouched', by(5).sku === 'OLD-777', by(5));
  check('…and is not counted as a new SKU', r.stats.newSkus === 3, r.stats);
  // id 6 already holds INV-00007, so allocation must resume ABOVE it rather
  // than colliding at INV-00001.
  check('SKU allocation seeds past the highest existing INV-NNNNN',
    r.plan.filter((p) => !p.hadSku).every((p) => p.sku > 'INV-00007'),
    r.plan.map((p) => p.sku));
  check('every issued SKU is unique',
    new Set(r.plan.map((p) => p.sku)).size === r.plan.length, r.plan.map((p) => p.sku));
  check('the English name is carried over verbatim', by(1).newNameEn === 'Cup Holder 2');
  check('and the Arabic is the translation', by(1).newNameAr === 'حامل أكواب 2');
  check('planning is pure — the input rows are not mutated',
    rows[0].name === 'Cup Holder 2' && rows[0].name_en === null);
  check('planning is deterministic',
    JSON.stringify(bilingual.planBilingualNames(rows).plan) === JSON.stringify(r.plan));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ inventory naming: codes preserved, unknowns stay English, only 4 columns writable');
