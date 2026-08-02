#!/usr/bin/env node
/**
 * RTL-literals guard — no hardcoded physical-direction classes.
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

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
// The POS is held at ZERO — it has always been clean and stays that way.
const SCAN_ROOTS = [
  { key: 'frontend/pos/src', abs: path.join(ROOT, 'frontend', 'pos', 'src'), mode: 'zero' },
  // The ERP was NEVER scanned before, and carries ~390 pre-existing hits —
  // including inside the shared table kit itself. Failing on all of them would
  // make the guard unrunnable, and leaving the ERP unscanned means every NEW
  // page is free to hardcode a physical side that silently breaks the moment
  // the app renders LTR (the provider really does flip <html dir> for English).
  // So: a RATCHET, exactly like scripts/check-design-tokens.mjs. Existing debt
  // is recorded per file in the baseline and may only ever go DOWN; a file not
  // in the baseline — i.e. every new file — must be at ZERO.
  { key: 'frontend/erp/src', abs: path.join(ROOT, 'frontend', 'erp', 'src'), mode: 'ratchet' },
];
const BASELINE_PATH = path.join(ROOT, 'scripts', 'rtl-literals.baseline.json');

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
  const out = [];
  for (const rootSpec of SCAN_ROOTS) {
    const files = [];
    collectFiles(rootSpec.abs, files);
    for (const abs of files) out.push({ abs, mode: rootSpec.mode });
  }
  out.sort((a, b) => {
    const ka = toKey(a.abs);
    const kb = toKey(b.abs);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  try { return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); } catch (_) { return {}; }
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
  const entries = buildScanSet();
  const baseline = readBaseline();
  const failures = [];      // zero-tolerance violations (the POS)
  const regressions = [];   // the ERP ratchet went UP
  const improvements = [];  // the ERP ratchet went DOWN — nudge to re-baseline
  const counts = {};
  let scannedFiles = 0;

  for (const { abs, mode } of entries) {
    scannedFiles++;
    const key = toKey(abs);
    const hits = scanFile(abs).filter((h) => !isAllowlisted(key, h.line));
    if (hits.length) counts[key] = hits.length;
    if (mode === 'zero') {
      for (const hit of hits) failures.push({ key, ...hit });
      continue;
    }
    // A file ABSENT from the baseline is allowed ZERO — that is what makes
    // every NEW page clean by construction.
    const allowed = Object.prototype.hasOwnProperty.call(baseline, key) ? baseline[key] : 0;
    if (hits.length > allowed) regressions.push({ key, found: hits.length, allowed, samples: hits.slice(0, 3) });
    else if (hits.length < allowed) improvements.push({ key, found: hits.length, allowed });
  }

  if (process.argv.includes('--update')) {
    const next = {};
    for (const k of Object.keys(counts).sort()) if (k.startsWith('frontend/erp/src')) next[k] = counts[k];
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log('✔ baseline updated: ' + Object.keys(next).length + ' ERP file(s) recorded in scripts/rtl-literals.baseline.json');
    return 0;
  }


  console.log('فحص الاتجاه المكتوب حرفياً — RTL-literals guard (hardcoded direction check)');
  console.log(`  الملفات المفحوصة (files scanned): ${scannedFiles}`);
  console.log('');

  if (regressions.length > 0) {
    console.error('✖ فشل صارم (HARD FAIL) — كلاسات اتجاه فعلي جديدة في ERP (ratchet regression):');
    for (const r of regressions) {
      console.error('  - ' + r.key + ': found ' + r.found + ', allowed ' + r.allowed +
        (r.allowed === 0 ? '  (ملف جديد يجب أن يكون نظيفاً تماماً / new file must be clean)' : ''));
      for (const h of r.samples) console.error('      ' + r.key + ':' + h.line + '  [' + h.match + ']  ' + h.text.slice(0, 120));
    }
    console.error('');
    console.error('استبدل: right-N/left-N -> start-N/end-N | pr-N/pl-N -> ps-N/pe-N | text-right/-left -> text-start/-end');
    console.error('(New ERP files must use LOGICAL utilities. Existing debt is recorded in scripts/rtl-literals.baseline.json and may only go DOWN.)');
    return 1;
  }

  if (improvements.length > 0) {
    console.log('↓ تحسّن (improved) in ' + improvements.length + ' file(s) — run with --update to lower the baseline.');
    for (const i of improvements.slice(0, 10)) console.log('  - ' + i.key + ': ' + i.allowed + ' -> ' + i.found);
    console.log('');
  }

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
