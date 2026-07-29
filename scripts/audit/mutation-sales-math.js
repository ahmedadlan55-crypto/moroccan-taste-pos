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
 *     3. apply the patch IN PLACE at the original path, then RE-READ the file
 *        and confirm the mutated bytes really landed (never "test air");
 *     4. run the killing suite — a non-zero EXIT STATUS = KILLED;
 *     5. restore the original in `finally`, byte-for-byte.
 *   After the run every target's SHA-256 is compared against its pre-run hash
 *   and both hashes are PRINTED; a mismatch is a hard failure (never leave a
 *   mutant on disk). Signal handlers restore the originals if the run is
 *   interrupted.
 *
 * WHAT COUNTS AS A KILL (honesty rule)
 *   Only a suite that RAN and exited non-zero. If the child process failed to
 *   spawn or hit the timeout, spawnSync reports `error` and the exit status is
 *   meaningless — that is a HARNESS FAILURE (exit 2), never a kill. Without
 *   this distinction a broken node path would report a flawless 100%.
 *
 * EXIT CODES: 0 = 100% kill, 1 = at least one survivor (or restore mismatch),
 *             2 = catalog drift / harness failure.
 *
 * USAGE
 *   node scripts/audit/mutation-sales-math.js            # run everything
 *   node scripts/audit/mutation-sales-math.js --list     # print the catalog
 *   node scripts/audit/mutation-sales-math.js --only=EQ-01,BD-03
 *
 * The pivot suite is spawned as the erp package's own vitest binary with cwd
 * = frontend/erp, so it runs under frontend/erp/vite.config.ts. The equivalent
 * hand-typed command from the repo root is
 *   npx --prefix frontend/erp vitest run \
 *     src/modules/reports/sales/__tests__/pivot.test.ts --reporter=basic
 * (verified to select the same spec and pass; it resolves the ROOT vitest
 * config rather than the erp one, which is why the spawn below is used.)
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
const VITEST_BIN = path.join(ERP_DIR, 'node_modules', 'vitest', 'vitest.mjs');
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
      args: [VITEST_BIN, 'run', PIVOT_SPEC, '--reporter=basic'],
      cwd: ERP_DIR,
    },
  ],
});

/* ─── the mutant catalog ─────────────────────────────────────────────────────
 * Every `find` is a verbatim snippet of the CURRENT target file and MUST match
 * exactly once. Keep descriptions honest about which assertion is expected to
 * kill the mutant — that is the documentation of WHY the suite is sufficient.
 * Coverage rule: every exported money/ratio function owns at least one mutant.
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
  // EQ-05 targeted netProductSales — now DELETED. That function mixed three
  // tax bases in one subtraction (incl-VAT gross − incl-VAT discounts − ex-VAT
  // returns) and was the exact defect the statement rewrite removed. A mutant
  // whose `find` string no longer exists in the source is not a passing check:
  // it is a permanently red gate. Replaced by one mutant per SURVIVING money
  // function, so the coverage rule at the top of this catalog still holds.
  {
    id: 'EQ-05a', target: 'equations',
    description: 'netSalesInclVat: returns ADDED instead of subtracted (− → +)',
    find: 'return fromMinor(toMinor(invoicedInclVat) - toMinor(returnsInclVat));',
    replace: 'return fromMinor(toMinor(invoicedInclVat) + toMinor(returnsInclVat));',
  },
  {
    id: 'EQ-05b', target: 'equations',
    description: 'netSalesExVat: returns ADDED instead of subtracted (− → +)',
    find: 'return fromMinor(toMinor(netExVat) - toMinor(returnsNet));',
    replace: 'return fromMinor(toMinor(netExVat) + toMinor(returnsNet));',
  },
  {
    id: 'EQ-05c', target: 'equations',
    description: 'salesBeforeDiscount: discount SUBTRACTED instead of added (+ → −)',
    find: 'return fromMinor(toMinor(invoicedInclVat) + toMinor(discounts));',
    replace: 'return fromMinor(toMinor(invoicedInclVat) - toMinor(discounts));',
  },
  {
    id: 'EQ-05d', target: 'equations',
    description: 'statementVariance: operands swapped, so a real gap reports with the wrong sign',
    find: 'return fromMinor(toMinor(invoiceTotal) - toMinor(invoicedInclVat));',
    replace: 'return fromMinor(toMinor(invoicedInclVat) - toMinor(invoiceTotal));',
  },
  {
    id: 'EQ-05e', target: 'equations',
    description: 'netVat: returns VAT ADDED instead of credited back (− → +)',
    find: 'return fromMinor(toMinor(vatOnSales) - toMinor(vatOnReturns));',
    replace: 'return fromMinor(toMinor(vatOnSales) + toMinor(vatOnReturns));',
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
  {
    id: 'EQ-14', target: 'equations',
    description: 'round2: lose half-AWAY-FROM-ZERO mirroring (a negative ratio at the exact .005 boundary rounds toward zero)',
    find: '  return (sign * Math.round(Math.abs(n) * 100 + 1e-9)) / 100;',
    replace: '  return Math.round(n * 100 + 1e-9) / 100;',
  },
  {
    id: 'EQ-15', target: 'equations',
    description: 'round2: non-finite input returns 0 instead of null (undefined ratio reported as a real 0)',
    find: '  if (!Number.isFinite(n)) return null;',
    replace: '  if (!Number.isFinite(n)) return 0;',
  },
  {
    id: 'EQ-16', target: 'equations',
    description: 'roundMoney: edge rounding removed entirely (raw float passthrough)',
    find: 'function roundMoney(value) {\n  return fromMinor(toMinor(value));\n}',
    replace: 'function roundMoney(value) {\n  return Number(value);\n}',
  },
  {
    id: 'EQ-17', target: 'equations',
    description: 'sumMoney: result returned in halalas — the single fromMinor at the edge is dropped (100× overstatement)',
    find: '  return fromMinor(total);',
    replace: '  return total;',
  },
  {
    id: 'EQ-18', target: 'equations',
    description: 'grossProductSales: array/scalar dispatch inverted (an array of line grosses collapses to 0)',
    find: '  if (Array.isArray(lineGrossAmounts)) return sumMoney(lineGrossAmounts);',
    replace: '  if (!Array.isArray(lineGrossAmounts)) return sumMoney(lineGrossAmounts);',
  },
  {
    id: 'EQ-19', target: 'equations',
    description: 'grossProfit: COGS ADDED instead of subtracted (a loss reads as a profit)',
    find: '  return fromMinor(toMinor(netExVat) - toMinor(cogs));',
    replace: '  return fromMinor(toMinor(netExVat) + toMinor(cogs));',
  },
  {
    id: 'EQ-20', target: 'equations',
    description: 'netCollections: refunds ADDED instead of subtracted (refunds inflate takings)',
    find: '  return fromMinor(toMinor(settled) - toMinor(refunds));',
    replace: '  return fromMinor(toMinor(settled) + toMinor(refunds));',
  },
  {
    id: 'EQ-21', target: 'equations',
    description: 'avgItemsPerOrder: divide by orders → multiply by orders',
    find: '  return round2(Number(itemsQty) / n);',
    replace: '  return round2(Number(itemsQty) * n);',
  },
  {
    id: 'EQ-22', target: 'equations',
    description: 'discountPct: numerator left in SAR while the denominator is halalas (unit mismatch, 100× understated)',
    find: '  return round2((toMinor(discounts) / g) * 100);',
    replace: '  return round2((Number(discounts) / g) * 100);',
  },
  {
    id: 'EQ-23', target: 'equations',
    description: 'attachRate: the per-100-items scale is dropped (×100 → ×1)',
    find: '  return round2((Number(modifierCount) / items) * 100);',
    replace: '  return round2((Number(modifierCount) / items) * 1);',
  },
  {
    id: 'EQ-24', target: 'equations',
    description: 'avgModifiersPerItem: ratio inverted (items per modifier instead of modifiers per item)',
    find: '  return round2(Number(modifierQty) / items);',
    replace: '  return round2(items / Number(modifierQty));',
  },
  {
    id: 'EQ-25', target: 'equations',
    description: 'contributionPct: part/whole swapped (a row\'s share of the total inverted)',
    find: 'function contributionPct(part, whole) {\n  return ratePct(part, whole);\n}',
    replace: 'function contributionPct(part, whole) {\n  return ratePct(whole, part);\n}',
  },
  {
    id: 'EQ-26', target: 'equations',
    description: 'netQuantity: returned units ADDED instead of subtracted',
    find: '  return Number(sold || 0) - Number(returned || 0);',
    replace: '  return Number(sold || 0) + Number(returned || 0);',
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
  {
    id: 'BD-13', target: 'businessDay',
    description: 'pad2: zero-padding becomes space-padding (occurredAtLocal stops being a valid DATETIME)',
    find: "  return String(n).padStart(2, '0');",
    replace: "  return String(n).padStart(2, ' ');",
  },
  {
    id: 'BD-14', target: 'businessDay',
    description: 'formatterFor: hourCycle h23 → h24 (local midnight renders as the "24:xx" ICU bug the header warns about)',
    find: "      hourCycle: 'h23',",
    replace: "      hourCycle: 'h24',",
  },
  {
    id: 'BD-15', target: 'businessDay',
    description: 'toInstant: Date.UTC month is not zero-based any more (every DB string lands a month late)',
    find: '  const wallUtcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));',
    replace: '  const wallUtcMs = Date.UTC(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));',
  },
  {
    id: 'BD-16', target: 'businessDay',
    description: 'nextRunAt: at_time minutes taken from the whole day-seconds (no % 3600 — the hour is counted twice)',
    find: '  const h = Math.floor(atSec / 3600), mi = Math.floor((atSec % 3600) / 60), s = atSec % 60;',
    replace: '  const h = Math.floor(atSec / 3600), mi = Math.floor(atSec / 60), s = atSec % 60;',
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
  {
    id: 'PV-12', target: 'pivot',
    description: 'pivotPathKey: a null key encoded as the literal "null" (a real "null" key collides with a masked one)',
    find: '  return keys.map((k) => (k == null ? NULL_KEY : String(k))).join(SEP);',
    replace: '  return keys.map((k) => (k == null ? "null" : String(k))).join(SEP);',
  },
  {
    id: 'PV-13', target: 'pivot',
    description: 'flattenTree: hasChildren > 0 → >= 0 (leaf rows claim children — phantom expand chevrons)',
    find: '        hasChildren: node.children.length > 0,',
    replace: '        hasChildren: node.children.length >= 0,',
  },
  {
    id: 'PV-14', target: 'pivot',
    description: 'indexSubtotals: depth taken from the NULL keys (every API subtotal row is misfiled and dropped)',
    find: '      if (row.keys[i] != null) depth = i;',
    replace: '      if (row.keys[i] == null) depth = i;',
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * LINE ENDINGS ARE NOT PART OF THE MUTANT.
 *
 * A dozen catalog entries are MULTI-LINE snippets written with "\n". The
 * targets are checked out through git on Windows, where core.autocrlf hands
 * back CRLF — so every one of those snippets matched ZERO times and the
 * harness exited 2 with "catalog drift — the source has evolved past the
 * catalog". It had not evolved at all; the bytes differed by a \r per line.
 *
 * That failure mode is worse than it looks, because this harness is what
 * proves the money tests are real. Red on a fresh Windows clone, for a reason
 * that reads like a genuine source/catalog divergence, is exactly the kind of
 * gate failure people learn to wave through.
 *
 * So matching happens on a NORMALISED copy, and the patch is written back with
 * the target file's OWN newline so the mutated file stays byte-plausible and
 * the SHA restore check still means something.
 */
function normalizeNewlines(s) {
  return s.replace(/\r\n/g, '\n');
}

/** The newline this file actually uses — CRLF if any CRLF is present. */
function dominantNewline(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

function countOccurrences(haystack, needle) {
  const h = normalizeNewlines(haystack);
  const n = normalizeNewlines(needle);
  let count = 0, idx = 0;
  for (;;) {
    idx = h.indexOf(n, idx);
    if (idx === -1) return count;
    count++;
    idx += 1; // overlapping-safe; find snippets are code lines, overlap is drift anyway
  }
}

/**
 * Literal splice — never String.replace(), whose `$` sequences are magic.
 * Indices are computed on the normalised text, so the splice is done on the
 * normalised text too and the result is re-encoded to the file's own newline.
 */
function applyMutant(text, find, replace) {
  const nl = dominantNewline(text);
  const h = normalizeNewlines(text);
  const f = normalizeNewlines(find);
  const i = h.indexOf(f);
  if (i === -1) return null;
  const spliced = h.slice(0, i) + normalizeNewlines(replace) + h.slice(i + f.length);
  return nl === '\r\n' ? spliced.replace(/\n/g, '\r\n') : spliced;
}

function stripAnsi(s) {
  return s.replace(/\[[0-9;]*m/g, '');
}

/**
 * Run a killing suite.
 *   ran=false  → the process could not be spawned or timed out. The exit
 *                status is meaningless; the caller MUST treat this as a
 *                harness failure, never as a kill.
 *   ran=true   → status 0 = suite passed, non-zero = suite failed (a kill).
 */
function runSuite(suite) {
  const res = spawnSync(suite.cmd, suite.args, {
    cwd: suite.cwd,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    shell: false,
  });
  const output = stripAnsi((res.stdout || '') + (res.stderr || ''));
  return {
    ran: !res.error && res.status !== null,
    error: res.error ? String(res.error.message || res.error) : null,
    passed: res.status === 0,
    status: res.status,
    output,
    tail: output.slice(-2000),
  };
}

/** First failing test name in a suite's output — evidence of WHY it died. */
function firstFailure(output) {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('❌')) return line.slice(1).trim();
    if (/^×\s/.test(line)) return line.replace(/^×\s*/, '').trim();
    if (/^(AssertionError|Error):/.test(line)) return line;
  }
  return null;
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

  const seen = new Set();
  for (const m of CATALOG) {
    if (seen.has(m.id)) fail(`duplicate mutant id ${m.id}`);
    seen.add(m.id);
  }

  const mutants = only ? CATALOG.filter((m) => only.has(m.id)) : CATALOG;
  if (!mutants.length) fail('--only matched no catalog ids');

  if (!fs.existsSync(VITEST_BIN) && mutants.some((m) => m.target === 'pivot')) {
    fail(`vitest binary missing at ${VITEST_BIN} (run npm ci in frontend/erp)`);
  }

  // 1. Load originals + drift check ALL selected mutants up front.
  const originals = {}; // target → { abs, rel, buf, text, hash }
  for (const [key, rel] of Object.entries(TARGETS)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) fail(`target file missing: ${rel}`);
    const buf = fs.readFileSync(abs);
    originals[key] = { abs, rel, buf, text: buf.toString('utf8'), hash: sha256(buf) };
  }

  // Restore-on-interrupt: an aborted run must never leave a mutant on disk.
  const restoreAll = () => {
    for (const o of Object.values(originals)) {
      try { fs.writeFileSync(o.abs, o.buf); } catch (_) { /* best effort */ }
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreAll(); process.exit(2); });
  }
  process.on('uncaughtException', (e) => {
    restoreAll();
    console.error('[mutation] uncaught: ' + (e && e.stack || e));
    process.exit(2);
  });

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
  console.log('[mutation] pre-run hashes:');
  for (const o of Object.values(originals)) console.log(`    ${o.hash}  ${o.rel}`);

  // 3. Baseline: every killing suite must PASS on unmutated code — otherwise
  //    "killed" would be meaningless.
  const suiteKeys = [...new Set(mutants.map((m) => m.target))];
  console.log('\n[mutation] baseline (unmutated) suite check…');
  for (const t of suiteKeys) {
    for (const suite of SUITES[t]) {
      const r = runSuite(suite);
      if (!r.ran) fail(`baseline: ${suite.name} could not run (${r.error || 'no exit status'})`);
      if (!r.passed) {
        console.error(`[mutation] baseline FAILED: ${suite.name} exited ${r.status} on UNMUTATED code`);
        console.error(r.tail);
        process.exit(2);
      }
    }
  }
  console.log('[mutation] baseline green — all killing suites pass on the original code.\n');

  // 4. Run each mutant: apply → verify on disk → test → restore (always).
  const results = [];
  for (const m of mutants) {
    const o = originals[m.target];
    const mutatedText = applyMutant(o.text, m.find, m.replace);
    if (mutatedText === null) fail(`${m.id}: find snippet vanished between the drift check and apply`);
    if (mutatedText === o.text) fail(`${m.id}: replace produced identical text`);
    const mutatedHash = sha256(Buffer.from(mutatedText, 'utf8'));
    let killedBy = null;
    let why = null;
    let harnessError = null;
    process.stdout.write(`  ${m.id}  applying… `);
    try {
      fs.writeFileSync(o.abs, mutatedText, 'utf8');
      // Prove we are testing the MUTANT, not the original.
      if (sha256(fs.readFileSync(o.abs)) !== mutatedHash) {
        harnessError = 'mutated bytes did not land on disk';
      } else {
        for (const suite of SUITES[m.target]) {
          const r = runSuite(suite);
          if (!r.ran) { harnessError = `${suite.name} could not run (${r.error || 'no exit status'})`; break; }
          if (!r.passed) { killedBy = suite.name; why = firstFailure(r.output); break; }
        }
      }
    } finally {
      // ALWAYS restore the pristine bytes, even if a suite spawn threw.
      fs.writeFileSync(o.abs, o.buf);
    }
    const restoredHash = sha256(fs.readFileSync(o.abs));
    if (restoredHash !== o.hash) fail(`${m.id}: restore mismatch on ${o.rel} — scratch copy at ${scratch}`);
    if (harnessError) fail(`${m.id}: ${harnessError} (NOT counted as a kill)`);
    const killed = killedBy !== null;
    results.push({ id: m.id, target: m.target, description: m.description, killed, killedBy, why });
    console.log(killed ? `KILLED by ${killedBy}${why ? ` ← "${why}"` : ''}` : 'SURVIVED ⚠');
  }

  // 5. Final byte-identical verification of EVERY target vs pre-run hashes.
  let restoreOk = true;
  const postHashes = [];
  for (const o of Object.values(originals)) {
    const now = sha256(fs.readFileSync(o.abs));
    postHashes.push({ rel: o.rel, pre: o.hash, post: now, same: now === o.hash });
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
  for (const [t] of Object.entries(perFile)) {
    const ran = results.filter((r) => r.target === t);
    if (!ran.length) continue;
    const k = ran.filter((r) => r.killed).length;
    console.log(`  ${TARGETS[t]}: ${k}/${ran.length} killed`);
  }
  console.log(`  kill rate: ${results.length - survivors.length}/${results.length} (${rate}%)`);

  console.log('\n── restore verification (SHA-256, pre-run vs post-run) ──────');
  for (const h of postHashes) {
    console.log(`  ${h.same ? 'IDENTICAL' : 'MISMATCH '}  ${h.rel}`);
    console.log(`      pre : ${h.pre}`);
    console.log(`      post: ${h.post}`);
  }
  console.log(`  all targets byte-identical: ${restoreOk ? 'YES' : 'NO'}`);

  if (survivors.length) {
    console.log('\n  SURVIVORS (each one is a test-suite gap):');
    for (const s of survivors) console.log(`    ${s.id}: ${s.description}`);
  }
  process.exit(survivors.length || !restoreOk ? 1 : 0);
})();
