#!/usr/bin/env node
/**
 * ADLAN design-token guard — "no new hex in components".
 *
 * Modes:
 *   node scripts/check-design-tokens.mjs           check against baseline, exit 0/1
 *   node scripts/check-design-tokens.mjs --update  (re)write scripts/design-tokens.baseline.json
 *
 * Rules:
 *   1) HARD FAIL: any hex in frontend/<app>/tailwind.config.ts or frontend/shared/**.ts
 *   2) RATCHET:   per-file hex count must be <= baseline; files absent from baseline must have 0
 *   3) If counts dropped below baseline, exit 0 but suggest re-running with --update
 *
 * Pure Node (no deps), ESM, Windows-path-safe, deterministic ordering.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const BASELINE_PATH = path.join(SCRIPT_DIR, 'design-tokens.baseline.json');

// #RGB #RGBA #RRGGBB #RRGGBBAA — word-bounded, longest alternative first.
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;

const SKIP_DIRS = new Set(['node_modules', 'dist']);

// ---------------------------------------------------------------------------
// Scan-set definition
// ---------------------------------------------------------------------------

/** Repo-relative, forward-slash key for a path. */
function toKey(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

/** Recursively collect files under dir matching extensions, skipping node_modules/dist. */
function collectFiles(absDir, extensions, out) {
  if (!existsSync(absDir)) return;
  const entries = readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(path.join(absDir, entry.name), extensions, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) out.push(path.join(absDir, entry.name));
    }
  }
}

const EXEMPT = new Set(['public/shared/design-tokens.css']); // the token source itself

function buildScanSet() {
  const files = [];

  for (const app of ['warehouse', 'sales', 'pos']) {
    collectFiles(path.join(ROOT, 'frontend', app, 'src'), ['.ts', '.tsx', '.css'], files);
    const tw = path.join(ROOT, 'frontend', app, 'tailwind.config.ts');
    if (existsSync(tw) && statSync(tw).isFile()) files.push(tw);
  }

  collectFiles(path.join(ROOT, 'frontend', 'shared'), ['.ts', '.tsx', '.css'], files);

  const adminSkin = path.join(ROOT, 'public', 'css', 'admin-skin.css');
  if (existsSync(adminSkin) && statSync(adminSkin).isFile()) files.push(adminSkin);

  const unique = [...new Set(files)].filter((f) => !EXEMPT.has(toKey(f)));
  unique.sort((a, b) => {
    const ka = toKey(a);
    const kb = toKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return unique;
}

/** Files where ANY hex is a hard failure, baseline or not. */
function isHardFailFile(key) {
  if (/^frontend\/(warehouse|sales|pos)\/tailwind\.config\.ts$/.test(key)) return true;
  if (/^frontend\/shared\/.+\.(ts|tsx|css)$/.test(key)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** @returns {{count: number, matches: Array<{line: number, hex: string}>}} */
function scanFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const matches = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    HEX_RE.lastIndex = 0;
    let m;
    while ((m = HEX_RE.exec(lines[i])) !== null) {
      matches.push({ line: i + 1, hex: m[0] });
    }
  }
  return { count: matches.length, matches };
}

/** Scan everything → Map<key, {count, matches}> (sorted keys, only counted files carry matches). */
function scanAll() {
  const results = new Map();
  for (const abs of buildScanSet()) {
    const key = toKey(abs);
    const res = scanFile(abs);
    results.set(key, res);
  }
  return results;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function formatMatches(matches, indent = '      ') {
  return matches.map((m) => `${indent}line ${m.line}: ${m.hex}`).join('\n');
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function runUpdate() {
  const results = scanAll();
  const baseline = {};
  let total = 0;
  for (const [key, res] of results) {
    if (res.count > 0) {
      baseline[key] = res.count;
      total += res.count;
    }
  }
  const sorted = {};
  for (const key of Object.keys(baseline).sort()) sorted[key] = baseline[key];
  writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

  console.log('✔ تم تحديث خط الأساس (baseline updated)');
  console.log(`  الملفات المفحوصة (files scanned): ${results.size}`);
  console.log(`  ملفات تحتوي hex (files with hex): ${Object.keys(sorted).length}`);
  console.log(`  إجمالي قيم hex (total hex count): ${total}`);
  console.log(`  الملف (file): ${toKey(BASELINE_PATH)}`);
  return 0;
}

function runCheck() {
  const results = scanAll();
  const baseline = loadBaseline();

  if (baseline === null) {
    console.error('✖ لا يوجد خط أساس (baseline missing): scripts/design-tokens.baseline.json');
    console.error('  أنشئه أولاً (create it first):  node scripts/check-design-tokens.mjs --update');
    return 1;
  }

  const hardFailures = [];
  const ratchetFailures = [];
  const improvements = [];
  let totalHex = 0;

  for (const [key, res] of results) {
    totalHex += res.count;
    const base = Object.prototype.hasOwnProperty.call(baseline, key) ? baseline[key] : 0;

    if (isHardFailFile(key) && res.count > 0) {
      hardFailures.push({ key, res });
      continue;
    }
    if (res.count > base) {
      ratchetFailures.push({ key, base, res });
    } else if (res.count < base) {
      improvements.push({ key, base, count: res.count });
    }
  }

  // Baseline entries whose file vanished from the scan set also count as improvements.
  for (const key of Object.keys(baseline).sort()) {
    if (!results.has(key) && baseline[key] > 0) {
      improvements.push({ key, base: baseline[key], count: 0 });
    }
  }

  console.log('فحص رموز التصميم — hex guard (design-token check)');
  console.log(`  الملفات المفحوصة (files scanned): ${results.size}`);
  console.log(`  إجمالي قيم hex الحالية (current total hex): ${totalHex}`);
  console.log('');

  let failed = false;

  if (hardFailures.length > 0) {
    failed = true;
    console.error('✖ فشل صارم (HARD FAIL) — لا يُسمح بأي hex في هذه الملفات إطلاقاً:');
    for (const { key, res } of hardFailures) {
      console.error(`  - ${key} (${res.count} hex)`);
      console.error(formatMatches(res.matches));
    }
    console.error('');
  }

  if (ratchetFailures.length > 0) {
    failed = true;
    console.error('✖ انتهاك السقف (RATCHET) — عدد hex تجاوز خط الأساس:');
    for (const { key, base, res } of ratchetFailures) {
      console.error(`  - ${key}`);
      console.error(`      خط الأساس (baseline): ${base} | الحالي (current): ${res.count}`);
      console.error(formatMatches(res.matches));
    }
    console.error('');
  }

  if (failed) {
    console.error('القاعدة: الألوان الجديدة تُعرَّف في public/shared/design-tokens.css وتُستهلك عبر var(--…).');
    console.error('(New colors belong in public/shared/design-tokens.css — consume them via var(--…).)');
    return 1;
  }

  if (improvements.length > 0) {
    console.log('✔ نجح الفحص — وانخفضت الأعداد تحت خط الأساس في:');
    for (const { key, base, count } of improvements) {
      console.log(`  - ${key}: ${base} → ${count}`);
    }
    console.log('');
    console.log('اقتراح (suggestion): ثبّت التحسن بتحديث خط الأساس:');
    console.log('  node scripts/check-design-tokens.mjs --update');
  } else {
    console.log('✔ نجح الفحص — لا قيم hex جديدة (no new hex values).');
  }
  return 0;
}

const mode = process.argv.includes('--update') ? 'update' : 'check';
process.exit(mode === 'update' ? runUpdate() : runCheck());
