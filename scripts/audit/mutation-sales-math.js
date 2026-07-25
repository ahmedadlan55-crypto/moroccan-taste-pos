#!/usr/bin/env node
'use strict';
/* ─── Mutation-testing runner for the sales-analytics pure math ──────────────
 *
 * WHAT THIS PROVES
 *   The unit suites guarding the sprint's pure financial logic actually FAIL
 *   when the logic is wrong. A test file that passes on correct code proves
 *   nothing by itself; a test file that also fails on every surgically broken
 *   variant proves it pins the arithmetic. Targets:
 *
 *     lib/analytics/equations.js   ← tests/analyticsEquations.test.js
 *     lib/analytics/businessDay.js ← tests/analyticsBusinessDay.test.js
 *     frontend/erp/src/modules/reports/sales/lib/pivot.ts
 *                                  ← src/modules/reports/sales/__tests__/pivot.test.ts (vitest)
 *
 * HOW IT WORKS
 *   A FIXED, hand-reviewed catalog of mutants (exact find→replace snippets
 *   against the CURRENT file text). For each mutant:
 *     1. verify `find` matches the target EXACTLY ONCE (drift check — if the
 *        source evolved, the run errors out instead of silently testing air);
 *     2. back the file up (in-memory + a copy in a scratch dir);
 *     3. apply the patch IN PLACE at the original path;
 *     4. run the killing suite — non-zero exit = KILLED;
 *     5. restore the original in `finally`, byte-for-byte.
 *   After the run every target's SHA-256 is compared against its pre-run hash;
 *   a mismatch is a hard failure (never leave a mutant on disk).
 *
 * EXIT CODES: 0 = 100% kill, 1 = at least one survivor (or restore mismatch),
 *             2 = catalog drift / harness failure.
 *
 * USAGE
 *   node scripts/audit/mutation-sales-math.js            # run everything
 *   node scripts/audit/mutation-sales-math.js --list     # print the catalog
 *   node scripts/audit/mutation-sales-math.js --only=EQ-01,BD-03
 * ────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ERP_DIR = path.join(ROOT, 'frontend', 'erp');

const TARGETS = Object.freeze({
  equations: 'lib/analytics/equations.js',
  businessDay: 'lib/analytics/businessDay.js',
  pivot: 'frontend/erp/src/modules/reports/sales/lib/pivot.ts',
});

// Killing suites per target. A mutant is KILLED when ANY of its suites exits
// non-zero. Backend targets run both pure node suites (equations mutants can
// only realistically die in the equations suite, but running both keeps the
// contract simple and each takes <1s).
const PIVOT_SPEC = 'src/modules/reports/sales/__tests__/pivot.test.ts';
const SUITES = Object.freeze({
  equations: [
    { name: 'node tests/analyticsEquations.test.js', cmd: process.execPath, args: ['tests/analyticsEquations.test.js'], cwd: ROOT },
    { name: 'node tests/analyticsBusinessDay.test.js', cmd: process.execPath, args: ['tests/analyticsBusinessDay.test.js'], cwd: ROOT },
  ],
  businessDay: [
    { name: 'node tests/analyticsEquations.test.js', cmd: process.execPath, args: ['tests/analyticsEquations.test.js'], cwd: ROOT },
    { name: 'node tests/analyticsBusinessDay.test.js', cmd: process.execPath, args: ['tests/analyticsBusinessDay.test.js'], cwd: ROOT },
  ],
  pivot: [
    {
      name: `vitest run ${PIVOT_SPEC}`,
      cmd: process.execPath,
      args: [path.join(ERP_DIR, 'node_modules', 'vitest', 'vitest.mjs'), 'run', PIVOT_SPEC, '--reporter=basic'],
      cwd: ERP_DIR,
    },
  ],
});

/* ─── the mutant catalog ─────────────────────────────────────────────────────
 * Every `find` is a verbatim snippet of the CURRENT target file and MUST match
 * exactly once. Keep descriptions honest about which assertion is expected to
 * kill the mutant — that is the documentation of WHY the suite is sufficient.
 */
const CATALOG = [
  // ── lib/analytics/equations.js ────────────────────────────────────────────
  {
    id: 'EQ-01', target: 'equations',
    description: 'toMinor: drop the +1e-9 epsilon (2.005 no longer rounds up — the 0.5 boundary breaks)',
    find: 'return sign * Math.round(Math.abs(n) * 100 + 1e-9);',
    replace: 'return sign * Math.round(Math.abs(n) * 100 - 1e-9);',
  },
  {
    id: 'EQ-02', target: 'equations',
    description: 'toMinor: lose half-AWAY-FROM-ZERO mirroring (negative .005 rounds toward +∞)',
    find: 'return sign * Math.round(Math.abs(n) * 100 + 1e-9);',
    replace: 'return Math.round(n * 100 + 1e-9);',
  },
  {
    id: 'EQ-03', target: 'equations',
    description: 'fromMinor: divide → multiply (halalas scale inverted)',
    find: 'function fromMinor(minor) {\n  return minor / 100;\n}',
    replace: 'function fromMinor(minor) {\n  return minor * 100;\n}',
  },
  {
    id: 'EQ-04', target: 'equations',
    description: 'sumMoney: sum raw floats instead of halalas (10×0.1 drifts to 0.9999…)',
    find: 'for (const v of values || []) total += toMinor(v);',
    replace: 'for (const v of values || []) total += Number(v);',
  },
  {
    id: 'EQ-05', target: 'equations',
    description: 'netProductSales: discounts ADDED instead of subtracted (− → +)',
    find: 'return fromMinor(toMinor(gross) - toMinor(discounts) - toMinor(returnsNet));',
    replace: 'return fromMinor(toMinor(gross) + toMinor(discounts) - toMinor(returnsNet));',
  },
  {
    id: 'EQ-06', target: 'equations',
    description: 'netInclVat: stored VAT subtracted instead of added (+ → −)',
    find: 'return fromMinor(toMinor(netExVat) + toMinor(vatAmount));',
    replace: 'return fromMinor(toMinor(netExVat) - toMinor(vatAmount));',
  },
  {
    id: 'EQ-07', target: 'equations',
    description: 'invoiceTotal: discounts flip sign inside the 6-term sum',
    find: 'toMinor(products) + toMinor(modifiers) - toMinor(discounts) +',
    replace: 'toMinor(products) + toMinor(modifiers) + toMinor(discounts) +',
  },
  {
    id: 'EQ-08', target: 'equations',
    description: 'marginPct: zero-net returns 0% instead of null (the "0% margin lie")',
    find: 'if (net === 0) return null;',
    replace: 'if (net === 0) return 0;',
  },
  {
    id: 'EQ-09', target: 'equations',
    description: 'expectedCash: payIns/payOuts variable reads swapped',
    find: 'toMinor(payIns) - toMinor(payOuts)',
    replace: 'toMinor(payOuts) - toMinor(payIns)',
  },
  {
    id: 'EQ-10', target: 'equations',
    description: 'tillVariance: counted/expected reads swapped (shortage becomes overage)',
    find: 'return fromMinor(toMinor(counted) - toMinor(expected));',
    replace: 'return fromMinor(toMinor(expected) - toMinor(counted));',
  },
  {
    id: 'EQ-11', target: 'equations',
    description: 'avgTicket: divide by orders → multiply by orders',
    find: 'return round2(fromMinor(toMinor(netExVat)) / n);',
    replace: 'return round2(fromMinor(toMinor(netExVat)) * n);',
  },
  {
    id: 'EQ-12', target: 'equations',
    description: 'ratePct: ×100 percent scale → ×10 (cashier rate primitive off 10×)',
    find: 'return round2((Number(part) / w) * 100);',
    replace: 'return round2((Number(part) / w) * 10);',
  },
  {
    id: 'EQ-13', target: 'equations',
    description: 'growth: |prev| denominator loses Math.abs (negative-base direction flips)',
    find: 'return round2(((Number(current) - prev) / Math.abs(prev)) * 100);',
    replace: 'return round2(((Number(current) - prev) / prev) * 100);',
  },

  // ── lib/analytics/businessDay.js ──────────────────────────────────────────
  {
    id: 'BD-01', target: 'businessDay',
    description: 'Riyadh offset constant 3h → 2h (every DB string shifts an hour)',
    find: 'const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;',
    replace: 'const RIYADH_OFFSET_MS = 2 * 60 * 60 * 1000;',
  },
  {
    id: 'BD-02', target: 'businessDay',
    description: 'toInstant: wall-clock − offset → + offset (conversion direction inverted)',
    find: 'return new Date(wallUtcMs - RIYADH_OFFSET_MS);',
    replace: 'return new Date(wallUtcMs + RIYADH_OFFSET_MS);',
  },
  {
    id: 'BD-03', target: 'businessDay',
    description: 'day-close boundary < → <= (exactly-at-close falls into YESTERDAY)',
    find: 'if (localSec < closeSec) bd = shiftDate(p.y, p.mo, p.d, -1);',
    replace: 'if (localSec <= closeSec) bd = shiftDate(p.y, p.mo, p.d, -1);',
  },
  {
    id: 'BD-04', target: 'businessDay',
    description: 'day-close comparison < → > (before-close no longer rolls back)',
    find: 'if (localSec < closeSec) bd = shiftDate(p.y, p.mo, p.d, -1);',
    replace: 'if (localSec > closeSec) bd = shiftDate(p.y, p.mo, p.d, -1);',
  },
  {
    id: 'BD-05', target: 'businessDay',
    description: 'shiftDate: + days → − days (the −1 day shift moves FORWARD)',
    find: 'const dt = new Date(Date.UTC(y, mo - 1, d) + days * 86400000);',
    replace: 'const dt = new Date(Date.UTC(y, mo - 1, d) - days * 86400000);',
  },
  {
    id: 'BD-06', target: 'businessDay',
    description: 'parseTimeOfDay: hour weight 3600 → 60 (day-close 04:00 becomes 04 minutes)',
    find: 'return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));',
    replace: 'return (+m[1]) * 60 + (+m[2]) * 60 + (+(m[3] || 0));',
  },
  {
    id: 'BD-07', target: 'businessDay',
    description: 'computeLocal: seconds term negated in the local-seconds sum',
    find: 'const localSec = p.h * 3600 + p.mi * 60 + p.s;',
    replace: 'const localSec = p.h * 3600 + p.mi * 60 - p.s;',
  },
  {
    id: 'BD-08', target: 'businessDay',
    description: 'nextRunAt: strictly-after > → >= (fires AT the now instant)',
    find: 'if (candidate.getTime() > now.getTime()) return candidate;',
    replace: 'if (candidate.getTime() >= now.getTime()) return candidate;',
  },
  {
    id: 'BD-09', target: 'businessDay',
    description: 'nextRunAt weekly: weekday guard !== → === (fires on every OTHER weekday)',
    find: 'if (dow !== Number(schedule.weekday)) continue;',
    replace: 'if (dow === Number(schedule.weekday)) continue;',
  },
  {
    id: 'BD-10', target: 'businessDay',
    description: 'nextRunAt monthly: clamp Math.min → Math.max (month_day 31 skips short months)',
    find: 'if (day.d !== Math.min(wanted, lastOfMonth)) continue;',
    replace: 'if (day.d !== Math.max(wanted, lastOfMonth)) continue;',
  },
  {
    id: 'BD-11', target: 'businessDay',
    description: 'wallTimeToUtc: second fixpoint pass adds the offset instead of subtracting',
    find: '  offset = tzOffsetMs(tz, new Date(guess));\n  guess = naive - offset;\n  return new Date(guess);',
    replace: '  offset = tzOffsetMs(tz, new Date(guess));\n  guess = naive + offset;\n  return new Date(guess);',
  },
  {
    id: 'BD-12', target: 'businessDay',
    description: 'tzOffsetMs: offset sign inverted (asUtc − instant → instant − asUtc)',
    find: 'return asUtc - instant.getTime();',
    replace: 'return instant.getTime() - asUtc;',
  },

  // ── frontend pivot.ts ─────────────────────────────────────────────────────
  {
    id: 'PV-01', target: 'pivot',
    description: 'sumMeasure: += → −= (group subtotals negate)',
    find: '      sum += v;',
    replace: '      sum -= v;',
  },
  {
    id: 'PV-02', target: 'pivot',
    description: 'sumMeasure: ALL-null group returns 0 instead of null (the fake-zero lie)',
    find: '  return seen ? sum : null;',
    replace: '  return seen ? sum : 0;',
  },
  {
    id: 'PV-03', target: 'pivot',
    description: 'sumMeasure: seen never latched (every subtotal collapses to null)',
    find: '      sum += v;\n      seen = true;',
    replace: '      sum += v;\n      seen = false;',
  },
  {
    id: 'PV-04', target: 'pivot',
    description: 'indexSubtotals: path key sliced one short (API subtotals never matched)',
    find: '    map.set(`${depth}:${pivotPathKey(row.keys.slice(0, depth + 1))}`, row);',
    replace: '    map.set(`${depth}:${pivotPathKey(row.keys.slice(0, depth))}`, row);',
  },
  {
    id: 'PV-05', target: 'pivot',
    description: 'buildLevel: leaf-level >= → > (an extra bogus group layer appears)',
    find: '  const isLeafLevel = level >= rowDims.length - 1;',
    replace: '  const isLeafLevel = level > rowDims.length - 1;',
  },
  {
    id: 'PV-06', target: 'pivot',
    description: 'API-subtotal precedence: !== undefined → != null (a null API subtotal loses to the client sum)',
    find: '      values[m] = fromApi !== undefined ? fromApi : sumMeasure(children, m);',
    replace: '      values[m] = fromApi != null ? fromApi : sumMeasure(children, m);',
  },
  {
    id: 'PV-07', target: 'pivot',
    description: 'buildLevel grouping: off-by-one on the level key read (groups by the NEXT dimension)',
    find: '    const key = row.keys[level] ?? null;',
    replace: '    const key = row.keys[level + 1] ?? null;',
  },
  {
    id: 'PV-08', target: 'pivot',
    description: 'buildTree empty-guard: || → && (no-dims input returns leaves instead of [])',
    find: '  if (rows.length === 0 || rowDims.length === 0) return [];',
    replace: '  if (rows.length === 0 && rowDims.length === 0) return [];',
  },
  {
    id: 'PV-09', target: 'pivot',
    description: 'flattenTree: expansion && → || (every group renders expanded)',
    find: '      const isExpanded = !node.isLeaf && expanded.has(node.key);',
    replace: '      const isExpanded = !node.isLeaf || expanded.has(node.key);',
  },
  {
    id: 'PV-10', target: 'pivot',
    description: 'flattenTree: dropped negation — walks children of COLLAPSED groups',
    find: '      if (isExpanded) walk(node.children);',
    replace: '      if (!isExpanded) walk(node.children);',
  },
  {
    id: 'PV-11', target: 'pivot',
    description: 'labelOf: && → || (missing labels leak undefined instead of falling back to the key)',
    find: '  if (label != null && label !== "") return label;',
    replace: '  if (label != null || label !== "") return label;',
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function countOccurrences(haystack, needle) {
  let count = 0, idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) return count;
    count++;
    idx += 1; // overlapping-safe; find snippets are code lines, overlap is drift anyway
  }
}

function runSuite(suite) {
  const res = spawnSync(suite.cmd, suite.args, {
    cwd: suite.cwd,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    shell: false,
  });
  return {
    ok: res.status === 0 && !res.error,
    status: res.status,
    tail: ((res.stdout || '') + (res.stderr || '')).slice(-2000),
  };
}

function fail(msg) {
  console.error('[mutation] FATAL: ' + msg);
  process.exit(2);
}

// ── main ─────────────────────────────────────────────────────────────────────

(function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const perFile = {};
  for (const m of CATALOG) {
    perFile[m.target] = (perFile[m.target] || 0) + 1;
  }

  if (listOnly) {
    console.log('Mutant catalog (' + CATALOG.length + ' mutants):');
    for (const [t, n] of Object.entries(perFile)) console.log(`  ${TARGETS[t]}: ${n} mutants`);
    console.log('');
    for (const m of CATALOG) {
      console.log(`  ${m.id}  [${TARGETS[m.target]}]`);
      console.log(`        ${m.description}`);
    }
    process.exit(0);
  }

  const mutants = only ? CATALOG.filter((m) => only.has(m.id)) : CATALOG;
  if (!mutants.length) fail('--only matched no catalog ids');

  // 1. Load originals + drift check ALL selected mutants up front.
  const originals = {}; // target → { abs, buf, text, hash }
  for (const [key, rel] of Object.entries(TARGETS)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) fail(`target file missing: ${rel}`);
    const buf = fs.readFileSync(abs);
    originals[key] = { abs, rel, buf, text: buf.toString('utf8'), hash: sha256(buf) };
  }
  const drift = [];
  for (const m of mutants) {
    const n = countOccurrences(originals[m.target].text, m.find);
    if (n !== 1) drift.push(`${m.id}: find snippet matches ${n} times in ${TARGETS[m.target]} (must be exactly 1)`);
    if (m.find === m.replace) drift.push(`${m.id}: find === replace`);
  }
  if (drift.length) {
    console.error('[mutation] catalog drift — the source has evolved past the catalog:');
    for (const d of drift) console.error('  - ' + d);
    process.exit(2);
  }

  // 2. Scratch-dir backups (belt-and-suspenders next to the in-memory copies).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-sales-math-'));
  for (const o of Object.values(originals)) {
    fs.writeFileSync(path.join(scratch, path.basename(o.rel) + '.orig'), o.buf);
  }
  console.log('[mutation] scratch backups: ' + scratch);

  // 3. Baseline: every killing suite must PASS on unmutated code — otherwise
  //    "killed" would be meaningless.
  const suiteKeys = [...new Set(mutants.map((m) => m.target))];
  console.log('[mutation] baseline (unmutated) suite check…');
  for (const t of suiteKeys) {
    for (const suite of SUITES[t]) {
      const r = runSuite(suite);
      if (!r.ok) {
        console.error(`[mutation] baseline FAILED: ${suite.name} exited ${r.status} on UNMUTATED code`);
        console.error(r.tail);
        process.exit(2);
      }
    }
  }
  console.log('[mutation] baseline green — all killing suites pass on the original code.\n');

  // 4. Run each mutant: apply → test → restore (always, in finally).
  const results = [];
  for (const m of mutants) {
    const o = originals[m.target];
    const mutatedText = o.text.replace(m.find, m.replace);
    if (mutatedText === o.text) fail(`${m.id}: replace produced identical text`);
    let killedBy = null;
    process.stdout.write(`  ${m.id}  applying… `);
    try {
      fs.writeFileSync(o.abs, mutatedText, 'utf8');
      for (const suite of SUITES[m.target]) {
        const r = runSuite(suite);
        if (!r.ok) { killedBy = suite.name; break; }
      }
    } finally {
      // ALWAYS restore the pristine bytes, even if a suite spawn threw.
      fs.writeFileSync(o.abs, o.buf);
    }
    const restoredHash = sha256(fs.readFileSync(o.abs));
    if (restoredHash !== o.hash) fail(`${m.id}: restore mismatch on ${o.rel} — scratch copy at ${scratch}`);
    const killed = killedBy !== null;
    results.push({ id: m.id, target: m.target, description: m.description, killed, killedBy });
    console.log(killed ? `KILLED (${killedBy})` : 'SURVIVED ⚠');
  }

  // 5. Final byte-identical verification of EVERY target vs pre-run hashes.
  let restoreOk = true;
  for (const o of Object.values(originals)) {
    const now = sha256(fs.readFileSync(o.abs));
    if (now !== o.hash) {
      restoreOk = false;
      console.error(`[mutation] RESTORE MISMATCH: ${o.rel} hash ${now} != pre-run ${o.hash}`);
    }
  }

  // 6. Report.
  const survivors = results.filter((r) => !r.killed);
  const width = Math.max(...results.map((r) => r.id.length));
  console.log('\n── mutation results ─────────────────────────────────────────');
  for (const r of results) {
    console.log(`  ${r.id.padEnd(width)}  ${(r.killed ? 'KILLED  ' : 'SURVIVED')}  ${r.description}`);
  }
  const rate = ((results.length - survivors.length) / results.length * 100).toFixed(1);
  console.log('─────────────────────────────────────────────────────────────');
  for (const [t, n] of Object.entries(perFile)) {
    const ran = results.filter((r) => r.target === t);
    if (!ran.length) continue;
    const k = ran.filter((r) => r.killed).length;
    console.log(`  ${TARGETS[t]}: ${k}/${ran.length} killed`);
  }
  console.log(`  kill rate: ${results.length - survivors.length}/${results.length} (${rate}%)`);
  console.log(`  restores byte-identical: ${restoreOk ? 'YES' : 'NO'}`);
  if (survivors.length) {
    console.log('\n  SURVIVORS (each one is a test-suite gap):');
    for (const s of survivors) console.log(`    ${s.id}: ${s.description}`);
  }
  process.exit(survivors.length || !restoreOk ? 1 : 0);
})();
