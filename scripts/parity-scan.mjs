// scripts/parity-scan.mjs — the POS parity DELETION GATE.
//
// docs/pos-parity-matrix.md is the binding contract: 374 legacy cashier
// functions, each with a <code>slug</code>. Legacy /pos cannot be deleted until
// every slug is classified in docs/pos-parity-map.json as either:
//   covered      → { react, api?, cap?, test }   (a real React surface + a test)
//   not-required → { reason }                    (documented: dead/orphan in
//                                                 legacy itself, or an explicit
//                                                 product decision — never silence)
//
// This tool FAILS (exit 1) while any slug is unclassified or malformed, and
// prints exactly what remains, grouped by domain. It never guesses.
//
//   node scripts/parity-scan.mjs            # gate (exit 1 on gaps)
//   node scripts/parity-scan.mjs --list     # dump remaining slugs only
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = path.join(root, 'docs', 'pos-parity-matrix.md');
const mapPath = path.join(root, 'docs', 'pos-parity-map.json');
const LIST_ONLY = process.argv.includes('--list');

const matrix = readFileSync(matrixPath, 'utf8');

// Rows live under "## <domain>" headings; each row carries **name**<br><code>slug</code>.
const rows = [];
let domain = '(preamble)';
for (const line of matrix.split(/\r?\n/)) {
  const h = line.match(/^##+\s+(.+)$/);
  if (h) { domain = h[1].trim(); continue; }
  const m = line.match(/\*\*(.+?)\*\*.*?<code>([\w][\w-]*)<\/code>/);
  if (m) rows.push({ slug: m[2], name: m[1], domain });
}
if (rows.length === 0) { console.error('parity-scan: parsed 0 rows — matrix format changed?'); process.exit(2); }

// Duplicate slugs in the matrix are a matrix bug worth surfacing, not hiding.
const counts = new Map();
for (const r of rows) counts.set(r.slug, (counts.get(r.slug) || 0) + 1);
const dupes = [...counts.entries()].filter(([, n]) => n > 1);

const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : {};

const covered = [];
const notRequired = [];
const malformed = [];
const unclassified = [];
for (const r of rows) {
  const e = map[r.slug];
  if (!e) { unclassified.push(r); continue; }
  if (e.status === 'covered') {
    if (!e.react || !e.test) { malformed.push({ ...r, why: 'covered يتطلب react + test' }); continue; }
    covered.push(r);
  } else if (e.status === 'not-required') {
    if (!e.reason || String(e.reason).trim().length < 10) { malformed.push({ ...r, why: 'not-required يتطلب سببًا موثقًا' }); continue; }
    notRequired.push(r);
  } else {
    malformed.push({ ...r, why: `status غير معروف: ${e.status}` });
  }
}
// Map entries pointing at slugs that do not exist in the matrix = typos to fix.
const strays = Object.keys(map).filter((slug) => !counts.has(slug));

if (LIST_ONLY) {
  for (const r of unclassified) console.log(`${r.slug}\t${r.domain}\t${r.name}`);
  process.exit(unclassified.length ? 1 : 0);
}

const byDomain = (list) => {
  const g = {};
  for (const r of list) (g[r.domain] = g[r.domain] || []).push(r);
  return g;
};

console.log('═══ POS parity gate ═══');
console.log(`  matrix rows      ${rows.length}`);
console.log(`  covered          ${covered.length}`);
console.log(`  not-required     ${notRequired.length}`);
console.log(`  malformed        ${malformed.length}`);
console.log(`  UNCLASSIFIED     ${unclassified.length}`);
if (dupes.length) console.log(`  ⚠ duplicate slugs in matrix: ${dupes.map(([s, n]) => `${s}×${n}`).join(', ')}`);
if (strays.length) console.log(`  ⚠ map entries with no matrix row (typos?): ${strays.join(', ')}`);

if (malformed.length) {
  console.log('\n── malformed entries ──');
  for (const r of malformed) console.log(`  ${r.slug} (${r.domain}): ${r.why}`);
}
if (unclassified.length) {
  console.log('\n── unclassified, by domain ──');
  const g = byDomain(unclassified);
  for (const d of Object.keys(g)) {
    console.log(`  ${d} (${g[d].length}):`);
    for (const r of g[d]) console.log(`    ${r.slug} — ${r.name}`);
  }
}

const ok = unclassified.length === 0 && malformed.length === 0 && strays.length === 0;
console.log(ok ? '\n✅ GATE PASS — every legacy function is accounted for.' : '\n❌ GATE FAIL — deletion is blocked until the above reach zero.');
process.exit(ok ? 0 : 1);
