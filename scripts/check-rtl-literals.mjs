#!/usr/bin/env node
/**
 * RTL-literals guard — "no hardcoded physical-direction classes in POS components".
 *
 *   node scripts/check-rtl-literals.mjs
 *
 * Rule:
 *   HARD FAIL: any hardcoded physical-direction Tailwind class
 *   (right-N / left-N / pr-N / pl-N / text-right / text-left) found under
 *   frontend/pos/src/**\/*.tsx. These break automatically when the document
 *   direction flips (RTL <-> LTR) because they hardcode a physical side
 *   instead of a logical one. Use the logical equivalents instead:
 *     right-N / left-N   -> start-N / end-N   (inset-inline-start/end)
 *     pr-N / pl-N         -> ps-N / pe-N       (padding-inline-start/end)
 *     text-right/-left    -> text-start/-end   (text-align: start/end)
 *
 * Modeled on scripts/check-design-tokens.mjs: pure Node (no deps), ESM,
 * Windows-path-safe, deterministic ordering.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const SCAN_ROOT = path.join(ROOT, 'frontend', 'pos', 'src');

// Same shape as the task's confirmation-grep pattern — kept in sync intentionally.
const RTL_RE = /(right-[0-9]|left-[0-9]|\bpr-[0-9]|\bpl-[0-9]|text-right|text-left)/g;

const SKIP_DIRS = new Set(['node_modules', 'dist']);

// Legitimate exceptions go here as { file: 'repo/relative/path.tsx', line: N, reason: '...' }.
// Empty today — every current hit in frontend/pos/src is a real bug, not a false positive.
const ALLOWLIST = [];

// ---------------------------------------------------------------------------
// Scan-set definition
// ---------------------------------------------------------------------------

/** Repo-relative, forward-slash key for a path. */
function toKey(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

/** Recursively collect .tsx files under dir, skipping node_modules/dist. */
function collectFiles(absDir, out) {
  if (!existsSync(absDir)) return;
  const entries = readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(path.join(absDir, entry.name), out);
    } else if (entry.isFile()) {
      if (path.extname(entry.name).toLowerCase() === '.tsx') out.push(path.join(absDir, entry.name));
    }
  }
}

function buildScanSet() {
  const files = [];
  collectFiles(SCAN_ROOT, files);
  files.sort((a, b) => {
    const ka = toKey(a);
    const kb = toKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return files;
}

function isAllowlisted(key, line) {
  return ALLOWLIST.some((e) => e.file === key && e.line === line);
}

/** @returns {Array<{line: number, text: string, match: string}>} */
function scanFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const lines = text.split(/\r\n|\r|\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    RTL_RE.lastIndex = 0;
    let m;
    while ((m = RTL_RE.exec(lines[i])) !== null) {
      hits.push({ line: i + 1, text: lines[i].trim(), match: m[0] });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function run() {
  const files = buildScanSet();
  const failures = [];
  let scannedFiles = 0;

  for (const abs of files) {
    scannedFiles++;
    const key = toKey(abs);
    const hits = scanFile(abs);
    for (const hit of hits) {
      if (isAllowlisted(key, hit.line)) continue;
      failures.push({ key, ...hit });
    }
  }

  console.log('فحص الاتجاه المكتوب حرفياً — RTL-literals guard (hardcoded direction check)');
  console.log(`  الملفات المفحوصة (files scanned): ${scannedFiles}`);
  console.log('');

  if (failures.length > 0) {
    console.error('✖ فشل صارم (HARD FAIL) — كلاسات اتجاه فعلي (physical-direction) بدل المنطقي (logical):');
    for (const f of failures) {
      console.error(`  - ${f.key}:${f.line}  [${f.match}]`);
      console.error(`      ${f.text}`);
    }
    console.error('');
    console.error('استبدل: right-N/left-N -> start-N/end-N | pr-N/pl-N -> ps-N/pe-N | text-right/-left -> text-start/-end');
    console.error('(Replace with logical Tailwind utilities so layout flips correctly between RTL and LTR.)');
    console.error('');
    console.error('استثناء حقيقي؟ أضِفه إلى ALLOWLIST في أعلى هذا الملف مع سبب.');
    console.error('(Genuine exception? Add it to ALLOWLIST at the top of this script with a reason.)');
    return 1;
  }

  console.log('✔ نجح الفحص — لا كلاسات اتجاه فعلي (no hardcoded physical-direction classes).');
  return 0;
}

process.exit(run());
