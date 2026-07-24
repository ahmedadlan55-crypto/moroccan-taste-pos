#!/usr/bin/env node
/**
 * READ-ONLY grep audit for RETIRED sales-reporting surfaces — Unified Sales
 * Analytics Hub sprint, Phase 1 (rationalization).
 *
 * The decision matrix in docs/status/SALES_REPORTS_RATIONALIZATION_AR.md
 * retires a set of frontend routes/components and backend endpoints. Each of
 * them is represented here as a MARKER (a route string, a component name, an
 * endpoint path). This script greps the live source trees for those markers:
 *
 *   node scripts/audit/retired-surfaces-report.js          → scan mode
 *   node scripts/audit/retired-surfaces-report.js --list   → print the matrix, exit 0
 *
 * EXIT SEMANTICS (deliberate — read before wiring into any gate):
 *   · --list        → always exit 0. Prints the marker matrix only.
 *   · scan, hits    → exit 1, listing every file:line still referencing an
 *                     APPROVED retired marker.
 *   · scan, clean   → exit 0.
 *   · markers with `pending: true` (dispositions CONTRADICTED during Phase-1
 *     verification — merge owner must decide) are scanned and REPORTED but
 *     NEVER affect the exit code.
 *
 * ⚠ THIS SCRIPT IS EXPECTED TO FAIL (exit 1) TODAY: the surfaces have not
 * been deleted yet — Phase 1 only documents them. The gate step
 * (`node scripts/audit/retired-surfaces-report.js` in the release gate) is to
 * be added ONLY in the retirement commit, where it must pass. Until then it is
 * a standing report, not a gate.
 *
 * Scan scope: frontend/erp/src, frontend/pos/src, routes, services, lib,
 * e2e, tests, public — excluding node_modules/**, **\/dist/**, docs/status/**,
 * *-snapshots/** and the ALLOWED_FILES below (the router redirect table
 * legitimately keeps old path strings alive as redirects).
 *
 * Engine: ripgrep (`rg`) via child_process when available (fast path),
 * otherwise a pure-fs recursive walk over text files. No npm dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const SCAN_DIRS = [
  'frontend/erp/src',
  'frontend/pos/src',
  'routes',
  'services',
  'lib',
  'e2e',
  'tests',
  'public',
];

// Files that are ALLOWED to keep mentioning retired route strings forever:
// the router's redirect table (old deep links must resolve, not 404) and its
// architecture test which asserts over that same table.
const ALLOWED_FILES = [
  'frontend/erp/src/app/router.tsx',
];

const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);
const EXCLUDE_REL_PREFIXES = ['docs/status'];
const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx',
  '.json', '.md', '.html', '.css', '.sql', '.yml', '.yaml',
]);

/**
 * The retirement matrix. `marker` is a FIXED string (no regex).
 * `excludeLineContaining` drops false-positive lines (e.g. balance-sheet-ifrs
 * when hunting the plain balance-sheet endpoint).
 * `pending: true` = Phase-1 verification CONTRADICTED the approved disposition
 * (see the doc, section «تعارضات مع المصفوفة المعتمدة») — informational only.
 */
const MARKERS = [
  // ── /accounting/sales-analytics → /reports/sales/executive ──────────────
  { marker: '/accounting/sales-analytics', kind: 'route',
    surface: 'صفحة تحليلات المبيعات (المحاسبة)', replacement: '/reports/sales/executive' },
  { marker: 'ac-sales-analytics', kind: 'nav-id/i18n',
    surface: 'بند القائمة + مفتاح الترجمة للصفحة أعلاه', replacement: 'بند rp-sales الموسّع' },
  { marker: 'SalesAnalyticsPage', kind: 'component',
    surface: 'frontend/erp/src/modules/accounting/pages/SalesAnalytics.tsx', replacement: 'صفحات الهَب الجديدة' },
  { marker: 'useSalesAnalytics', kind: 'api-hook',
    surface: 'frontend/erp/src/modules/accounting/api.ts (hook)', replacement: 'هوكات محرك التقارير الجديد' },
  { marker: 'salesAnalytics', kind: 'i18n-namespace',
    surface: 'قاموسا accounting (ar/en) + استخدامات t()', replacement: 'قاموس الهَب الجديد' },

  // ── /pos-admin/reports → /reports/sales/shifts (تحليلي) + /pos-admin/shifts (تشغيلي) ──
  { marker: '/pos-admin/reports', kind: 'route',
    surface: 'صفحة تقارير الكاشير (pos-admin)', replacement: '/reports/sales/shifts' },
  { marker: 'pa-reports', kind: 'nav-id/i18n',
    surface: 'بند القائمة + مفتاح الترجمة للصفحة أعلاه', replacement: 'بند rp-sales الموسّع' },
  { marker: 'pages/ReportsPage', kind: 'file-ref',
    surface: 'frontend/erp/src/modules/pos-admin/pages/ReportsPage.tsx (استيرادها في index.tsx)', replacement: 'صفحة shifts التحليلية في الهَب' },
  { marker: 'posAdmin.reports.', kind: 'i18n-namespace',
    surface: 'مفاتيح t("posAdmin.reports.*")', replacement: 'قاموس الهَب الجديد' },

  // ── Backend endpoints يتيمة (صفر مستهلكين، مثبت بالجرد) ────────────────
  { marker: "/report/advanced", kind: 'endpoint',
    surface: 'GET /api/sales/report/advanced — routes/sales.js:2950', replacement: 'محرك تقارير الهَب' },
  { marker: '/reports/sales-by-channel', kind: 'endpoint',
    surface: 'GET /api/erp/reports/sales-by-channel — routes/erp-core.js:2963', replacement: 'صفحة القنوات في الهَب' },
  { marker: '/reports/channel-settlements', kind: 'endpoint',
    surface: 'GET /api/erp/reports/channel-settlements — routes/erp-core.js:3047', replacement: 'صفحة تسويات القنوات في الهَب' },
  { marker: '/reports/discounts-given', kind: 'endpoint',
    surface: 'GET /api/erp/reports/discounts-given — routes/erp-core.js:3134', replacement: 'صفحة الخصومات في الهَب' },
  { marker: '/reports/waste-analytics', kind: 'endpoint',
    surface: 'GET /api/erp/reports/waste-analytics — routes/erp-core.js:3188', replacement: 'مؤجّل: /reports/inventory مستقبلًا' },
  { marker: '/reports/royalty-reconciliation', kind: 'endpoint',
    surface: 'GET /api/erp/reports/royalty-reconciliation — routes/erp-core.js:3268 (الدالة _royaltyBase ليست منه — تبقى، مشتركة مع صفحة الرويالتي الحية)', replacement: 'شاشة /accounting/royalties الحية' },

  // ── endpoint التحليلات نفسه — يُحذف في كوميت الإخراج فقط، بعد إعادة توجيه
  //    tests/integration/reportsEquations.api.test.js إلى المحرك الجديد ──
  { marker: '/reports/sales-analytics', kind: 'endpoint',
    surface: 'GET /api/erp/reports/sales-analytics — routes/erp-core.js:2792 (يبقى خلال السبرنت)', replacement: 'محرك تقارير الهَب' },

  // ── قرارات نقضها التحقق — pending، لا تؤثر على exit code ────────────────
  { marker: 'erp/reports/ar-aging', kind: 'file', pending: true,
    surface: 'routes/erp/reports/ar-aging.js (مظلَّل بترتيب mount — لكن عقده هو ما تتوقعه الواجهة، انظر الوثيقة §2.2)',
    replacement: 'قرار مالك الدمج: نقل الشكل إلى erp-core أو عكس الترتيب' },
  { marker: 'erp/reports/ap-aging', kind: 'file', pending: true,
    surface: 'routes/erp/reports/ap-aging.js (نفس تعارض ar-aging)',
    replacement: 'قرار مالك الدمج' },
  { marker: '/reports/balance-sheet', kind: 'endpoint', pending: true,
    excludeLineContaining: 'balance-sheet-ifrs',
    surface: 'GET /api/erp/reports/balance-sheet — erp-core.js:2359 — ليس يتيمًا: FinancialRatios.tsx:28 يستهلكه (الوثيقة §2.1)',
    replacement: 'قرار مالك الدمج: تحويل FinancialRatios إلى ifrs أولًا' },
];

// ── helpers ─────────────────────────────────────────────────────────────────

function toPosix(p) { return p.split(path.sep).join('/'); }

function isAllowedFile(relPosix) {
  return ALLOWED_FILES.some((f) => relPosix === f);
}

function isExcluded(relPosix) {
  return EXCLUDE_REL_PREFIXES.some((p) => relPosix === p || relPosix.startsWith(p + '/'));
}

function rgAvailable() {
  try {
    const r = spawnSync('rg', ['--version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch (_) { return false; }
}

/** rg fast path — one invocation per marker across all scan dirs. */
function scanWithRg(marker) {
  const dirs = SCAN_DIRS.filter((d) => fs.existsSync(path.join(ROOT, d)));
  const args = [
    '--fixed-strings', '--line-number', '--no-heading', '--color', 'never',
    '-g', '!**/node_modules/**', '-g', '!**/dist/**', '-g', '!**/*-snapshots/**',
    marker.marker, ...dirs,
  ];
  const r = spawnSync('rg', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // rg exit codes: 0 = hits, 1 = no hits, 2 = error. Treat 2 as a hard fail so
  // a broken invocation can never masquerade as "clean".
  if (r.status === 2) throw new Error('rg failed: ' + (r.stderr || '').slice(0, 500));
  const hits = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    // format: path:line:content   (path may contain no colon on these trees)
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const rel = toPosix(path.relative(ROOT, path.resolve(ROOT, m[1])));
    if (isAllowedFile(rel) || isExcluded(rel)) continue;
    if (marker.excludeLineContaining && m[3].includes(marker.excludeLineContaining)) continue;
    hits.push({ file: rel, line: Number(m[2]), text: m[3].trim().slice(0, 160) });
  }
  return hits;
}

/** Pure-fs fallback — walk once, scan every text file for every marker. */
function walkFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(e.name) || e.name.endsWith('-snapshots')) continue;
      walkFiles(full, out);
    } else if (e.isFile()) {
      if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
}

function scanWithWalk(markers) {
  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walkFiles(abs, files);
  }
  const byMarker = new Map(markers.map((m) => [m.marker, []]));
  for (const file of files) {
    const rel = toPosix(path.relative(ROOT, file));
    if (isAllowedFile(rel) || isExcluded(rel)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (!markers.some((m) => text.includes(m.marker))) continue;
    const lines = text.split('\n');
    for (const m of markers) {
      if (!text.includes(m.marker)) continue;
      lines.forEach((ln, i) => {
        if (!ln.includes(m.marker)) return;
        if (m.excludeLineContaining && ln.includes(m.excludeLineContaining)) return;
        byMarker.get(m.marker).push({ file: rel, line: i + 1, text: ln.trim().slice(0, 160) });
      });
    }
  }
  return byMarker;
}

// ── modes ───────────────────────────────────────────────────────────────────

function printMatrix() {
  console.log('مصفوفة الأسطح المُخرَجة (Unified Sales Analytics Hub — Phase 1)');
  console.log('المرجع: docs/status/SALES_REPORTS_RATIONALIZATION_AR.md');
  console.log('');
  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  for (const m of MARKERS) {
    const status = m.pending ? '⚠ pending (تعارض — قرار مالك الدمج)' : 'approved';
    console.log(`· [${pad(m.kind, 14)}] ${m.marker}`);
    console.log(`    السطح   : ${m.surface}`);
    console.log(`    البديل  : ${m.replacement}`);
    console.log(`    الحالة  : ${status}`);
  }
  console.log('');
  console.log(`الإجمالي: ${MARKERS.length} علامة (${MARKERS.filter((m) => !m.pending).length} معتمدة + ${MARKERS.filter((m) => m.pending).length} معلّقة).`);
  console.log('وضع الفحص: node scripts/audit/retired-surfaces-report.js (يفشل الآن عمدًا — الأسطح لم تُحذف بعد).');
}

function runScan() {
  const useRg = rgAvailable();
  console.log(`retired-surfaces-report — scan (engine: ${useRg ? 'ripgrep' : 'fs-walk'})`);
  console.log(`scope: ${SCAN_DIRS.join(', ')}  |  allow-list: ${ALLOWED_FILES.join(', ')}`);
  console.log('');

  let byMarker;
  if (useRg) {
    byMarker = new Map();
    for (const m of MARKERS) byMarker.set(m.marker, scanWithRg(m));
  } else {
    byMarker = scanWithWalk(MARKERS);
  }

  let activeHits = 0;
  let pendingHits = 0;
  for (const m of MARKERS) {
    const hits = byMarker.get(m.marker) || [];
    if (!hits.length) {
      console.log(`✓ نظيف  ${m.marker}`);
      continue;
    }
    if (m.pending) {
      pendingHits += hits.length;
      console.log(`⚠ معلّق  ${m.marker} — ${hits.length} إشارة (لا تؤثر على النتيجة؛ ${m.surface})`);
    } else {
      activeHits += hits.length;
      console.log(`✗ متبقٍ  ${m.marker} — ${hits.length} إشارة:`);
    }
    for (const h of hits.slice(0, 20)) {
      console.log(`      ${h.file}:${h.line}  ${h.text}`);
    }
    if (hits.length > 20) console.log(`      … و ${hits.length - 20} إشارة أخرى`);
  }

  console.log('');
  console.log(`الخلاصة: ${activeHits} إشارة معتمدة متبقية، ${pendingHits} إشارة معلّقة (معلوماتية).`);
  if (activeHits > 0) {
    console.log('النتيجة: FAIL (exit 1) — أسطح مُخرَجة ما زالت مُشارًا إليها. متوقَّع قبل كوميت الإخراج.');
    process.exit(1);
  }
  console.log('النتيجة: PASS (exit 0) — لا إشارات متبقية لأي سطح مُخرَج معتمد.');
  process.exit(0);
}

// ── entry ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--list')) {
  printMatrix();
  process.exit(0);
}

try {
  runScan();
} catch (e) {
  console.error('retired-surfaces-report FAILED:', e.message);
  process.exit(1);
}
