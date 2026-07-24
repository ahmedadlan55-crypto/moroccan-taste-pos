#!/usr/bin/env node
'use strict';
/**
 * Gate guard — fail if any analytics code carries a hardcoded VAT constant.
 *
 * WHY THIS EXISTS
 *   The analytics contract is that VAT is ONLY ever read from stored columns
 *   (ar_document_lines.vat_amount / vat_rate) — never derived from a literal
 *   rate. A hardcoded 15% works until the day the rate changes (KSA already
 *   moved 5% → 15% once) or a zero-rated/exempt line shows up, and then every
 *   report silently disagrees with the GL and the ZATCA documents. This scan
 *   makes the constant un-shippable rather than merely discouraged.
 *
 * WHAT IT MATCHES (STRICT — comments included, on purpose: a commented-out
 * constant is one uncomment away from shipping):
 *   1.15 multipliers, 0.15 rates, "/ 115" gross-to-net division, "15 %"
 *   spelled as a percentage, and VAT_RATE fallback literals
 *   (VAT_RATE = 0.15 / VAT_RATE || 15 / VAT_RATE ?? 15).
 *
 * SCOPE: lib/analytics/**, services/analytics/**, routes/analytics/** —
 *   missing directories are skipped (they land in later waves).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = [
  path.join('lib', 'analytics'),
  path.join('services', 'analytics'),
  path.join('routes', 'analytics'),
];
const EXT = /\.(js|mjs|cjs|sql)$/;

const PATTERNS = [
  { name: '1.15 multiplier', re: /\b1\.15\b/ },
  { name: '0.15 rate', re: /\b0\.15\b/ },
  { name: '/115 gross-to-net', re: /\/\s*115\b/ },
  { name: '15% literal', re: /\b15\s*%/ },
  { name: 'VAT_RATE fallback literal', re: /VAT_RATE\s*(?:=|\|\||\?\?|:)\s*['"]?\d/i },
];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (EXT.test(e.name)) out.push(p);
  }
}

const files = [];
for (const d of DIRS) walk(path.join(ROOT, d), files);

const violations = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        violations.push({ file: path.relative(ROOT, f), line: i + 1, name: p.name, text: line.trim().slice(0, 120) });
      }
    }
  });
}

if (violations.length) {
  console.error(`❌ ${violations.length} hardcoded VAT constant(s) in analytics code — VAT must come from stored vat_amount/vat_rate columns:`);
  for (const v of violations) console.error(`   ${v.file}:${v.line}  [${v.name}]  ${v.text}`);
  console.error('\nRead VAT from ar_document_lines.vat_amount / vat_rate (or the payment/return snapshots). Never from a literal.');
  process.exit(1);
}
console.log(`✅ analytics-no-vat-constant: no VAT literals across ${files.length} analytics files`);
process.exit(0);
