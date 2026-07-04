#!/usr/bin/env node
'use strict';
/*
 * Phase U — searchable-list coverage audit.
 *
 * The delivery gate requires ZERO long, non-searchable `<select>` (or "load
 * everything then filter") lists for MATERIALS/ITEMS and GL ACCOUNTS anywhere in
 * the warehouse React app. This script scans the source, classifies every
 * <select> and every large item fetch, and fails (exit 1) if any material/account
 * long-list survives. Short bounded selects (status / type / scope / warehouse /
 * priority / category filters) are allowed and reported separately.
 *
 * Run: node scripts/reporting/searchable-coverage.cjs
 * JSON: node scripts/reporting/searchable-coverage.cjs --json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'frontend', 'warehouse', 'src');
const AS_JSON = process.argv.includes('--json');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p, out); }
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// Does a <select>…</select> element pick a MATERIAL/ITEM or a GL ACCOUNT?
const ITEM_TOKENS = /\b(addItem|itemOptions|pickable|itemRows|\.itemId|item_id|materialId|itemIds\.(?:push|concat)|inv\.data\?\.rows)\b/;
const ACCOUNT_TOKENS = /\b(accounts\.data|counterAccount|expenseAccount|a\.code\b|glAccounts|accountId)\b/;
// large "load everything" item fetch used to feed a picker
const LOAD_ALL = /useWarehouseInventory\(\s*\{[^}]*pageSize:\s*(\d{3,})/g;

function selectsIn(src) {
  const res = [];
  let i = 0;
  while ((i = src.indexOf('<select', i)) !== -1) {
    const end = src.indexOf('</select>', i);
    const block = src.slice(i, end === -1 ? i + 400 : end + 9);
    const line = src.slice(0, i).split('\n').length;
    res.push({ line, block });
    i = end === -1 ? i + 7 : end + 9;
  }
  return res;
}

const files = walk(ROOT, []);
const violations = [];
const shortSelects = [];
let comboboxUses = 0;
let itemFetcherUses = 0;
let unitInputUses = 0;
const comboboxFiles = new Set();

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(path.join(__dirname, '..', '..'), f).replace(/\\/g, '/');
  const jsxUses = (src.match(/<SearchableEntityCombobox/g) || []).length;
  if (jsxUses) { comboboxUses += jsxUses; comboboxFiles.add(rel); }
  itemFetcherUses += (src.match(/makeItemFetcher\(/g) || []).length;
  unitInputUses += (src.match(/<UnitQtyInput/g) || []).length;

  for (const s of selectsIn(src)) {
    const isItem = ITEM_TOKENS.test(s.block);
    const isAccount = ACCOUNT_TOKENS.test(s.block);
    if (isItem || isAccount) violations.push({ file: rel, line: s.line, kind: isItem ? 'MATERIAL' : 'ACCOUNT' });
    else shortSelects.push({ file: rel, line: s.line });
  }
  let mm;
  while ((mm = LOAD_ALL.exec(src)) !== null) {
    // a large inventory fetch is only a violation if it feeds a picker (mapped to options / addItem)
    if (/addItem|itemOptions|pickable|\.map\(/.test(src)) violations.push({ file: rel, line: src.slice(0, mm.index).split('\n').length, kind: 'LOAD_ALL', pageSize: Number(mm[1]) });
  }
}

const report = {
  scannedFiles: files.length,
  centralComponent: 'SearchableEntityCombobox',
  comboboxUsages: comboboxUses,
  comboboxFiles: [...comboboxFiles].sort(),
  itemFetcherUsages: itemFetcherUses,
  unitQtyInputUsages: unitInputUses,
  shortSelectCount: shortSelects.length,
  violations,
  pass: violations.length === 0,
};

if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(report.pass ? 0 : 1); }

console.log('\n═══ Searchable-list Coverage Audit ═══');
console.log(`ملفات مفحوصة: ${report.scannedFiles}`);
console.log(`استخدامات SearchableEntityCombobox: ${comboboxUses} في ${comboboxFiles.size} ملف`);
console.log(`  ${[...comboboxFiles].sort().map((c) => '• ' + c).join('\n  ')}`);
console.log(`استخدامات makeItemFetcher (بحث أصناف خادمي): ${itemFetcherUses}`);
console.log(`استخدامات UnitQtyInput (إدخال بالوحدة): ${unitInputUses}`);
console.log(`قوائم <select> قصيرة مسموحة (حالة/نوع/نطاق/مستودع…): ${shortSelects.length}`);
if (violations.length) {
  console.log(`\n❌ مخالفات (قوائم مواد/حسابات طويلة غير قابلة للبحث): ${violations.length}`);
  for (const v of violations) console.log(`  - [${v.kind}] ${v.file}:${v.line}` + (v.pageSize ? ` (pageSize ${v.pageSize})` : ''));
} else {
  console.log('\n✅ صفر قوائم مواد/حسابات طويلة غير قابلة للبحث — كل منتقيات المواد والحسابات تستخدم المكوّن المركزي.');
}
process.exit(report.pass ? 0 : 1);
