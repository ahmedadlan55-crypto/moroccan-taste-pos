#!/usr/bin/env node
/**
 * ─── CO-6 — the full release gate, as ONE reproducible command ───────
 *
 * The gate has been run many times during this closeout as a hand-typed
 * sequence of npm scripts and playwright invocations. That is not a gate: the
 * exact set of steps lived in a shell history, so "the gate passed" meant
 * whatever happened to be run that afternoon, and a step quietly dropped
 * between two runs was invisible.
 *
 * This file IS the gate. Every step is named, ordered, and its exit code
 * checked. Running it three times in a row is the CO-6 requirement, and the
 * summary it prints is the evidence.
 *
 * Deliberately NOT included: any retry, any `|| true`, any timeout inflation.
 * A step that fails, fails. Use --keep-going to see the full picture of a bad
 * run in one pass instead of fixing failures one round-trip at a time; the exit
 * code is still non-zero.
 *
 * Usage:
 *   node scripts/gate/run-full-gate.js              # stop at the first failure
 *   node scripts/gate/run-full-gate.js --keep-going # run everything, still fail
 *   node scripts/gate/run-full-gate.js --only=e2e   # substring filter on step id
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const KEEP_GOING = process.argv.includes('--keep-going');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/**
 * Order matters:
 *   1. static + unit first — cheapest signal, fails in seconds;
 *   2. backend integration next — needs MySQL but no browser;
 *   3. schema/release-path — provisions throwaway databases;
 *   4. production build — the E2E suites serve the built bundles;
 *   5. E2E last — slowest, and meaningless if the build is broken.
 */
const STEPS = [
  // Static, sub-second: fail if any backend SQL calls a MySQL-9-removed built-in
  // (SHA1/MD5). The gate's MySQL is 8.4 (still has them) but prod is 9.6 (removed
  // them) — a query using SHA1() passes every local test yet 500s in production
  // (this took down the menu/POS/product-images reads). Cheapest signal, so first.
  { id: 'static:sql-removed-fns', cmd: process.execPath, args: ['scripts/audit/sql-removed-functions.js'] },
  // Static sub-second: no hardcoded 1.15/0.15 VAT constants in the analytics
  // read path (rates live in the recorded lines, never in code).
  { id: 'audit:analytics-vat',    cmd: process.execPath, args: ['scripts/audit/analytics-no-vat-constant.js'] },
  // `run typecheck` (each frontend's own `tsc --noEmit` script), NOT
  // `exec -- tsc --noEmit`: `npm --prefix X exec` does NOT change the working
  // directory, so tsc ran in the repo root, found no project, printed its help
  // and exited 1. `npm --prefix X run <script>` executes with cwd = X, so tsc
  // sees frontend/<app>/tsconfig.json.
  // Design-system guards. BOTH existed as opt-in manual commands and neither
  // was in this gate, so a page violating them shipped green. tokens:check is
  // a hex ratchet; check:rtl-literals holds the POS at zero and ratchets the
  // ERP, so every NEW ERP file must use logical direction utilities.
  { id: 'static:design-tokens', cmd: NPM, args: ['run', 'tokens:check'] },
  { id: 'static:rtl-literals',  cmd: NPM, args: ['run', 'check:rtl-literals'] },
  { id: 'erp:tsc',            cmd: NPM, args: ['--prefix', 'frontend/erp', 'run', 'typecheck'] },
  { id: 'pos:tsc',            cmd: NPM, args: ['--prefix', 'frontend/pos', 'run', 'typecheck'] },
  { id: 'erp:vitest',         cmd: NPM, args: ['--prefix', 'frontend/erp', 'run', 'test'] },
  { id: 'pos:vitest',         cmd: NPM, args: ['--prefix', 'frontend/pos', 'run', 'test'] },
  { id: 'root:tests',         cmd: NPM, args: ['test'] },
  // The recipe / production / operations domains, each asserting the DATABASE
  // effect rather than the status code, plus the mutation harness that proves
  // the financial guards actually fail when broken.
  { id: 'backend:recipes-api',        cmd: NPM, args: ['run', 'test:recipes-api'] },
  { id: 'backend:production-integrity', cmd: NPM, args: ['run', 'test:production-integrity'] },
  { id: 'backend:operations-api',     cmd: NPM, args: ['run', 'test:operations-api'] },
  { id: 'audit:mutation-guards',      cmd: NPM, args: ['run', 'test:mutation'] },
  { id: 'backend:coa-gl-gate', cmd: NPM, args: ['run', 'test:coa-gl-gate'] },
  { id: 'backend:jv-concurrency', cmd: process.execPath, args: ['tests/integration/glJournalConcurrency.api.test.js'] },
  // CO-4 item 7 — the recipe cost-lock (COST_LOCKED_BY_RECIPE + costOverride
  // unlock) and the "assignments never touch balances" invariant are proven by
  // these backend integration tests. They belong in the gate so the contract is
  // enforced continuously, not just asserted once in the E2E.
  { id: 'backend:cost-source', cmd: NPM, args: ['run', 'test:cost-source'] },
  { id: 'backend:menu-list', cmd: NPM, args: ['run', 'test:menu-list'] },
  // The image-version tests assert the exact SUBSTRING(SHA2(image_data,256),1,8)
  // token value (Node recomputes the same SHA-256). They were NOT gate steps, so
  // the SHA1→SHA2 regression they cover slipped straight to prod — now wired in.
  // The owner's requirement as arithmetic, end to end on a real DB: a 16.00
  // NET item must be 16.00 + 2.40 = 18.40 on screen, in sales.total_final, in
  // tax_subtotals_json and in the GL. Every OTHER test seeds is_tax_inclusive=1,
  // a state no production row is in — which is how the mismatch shipped.
  // The sales-report registry contracts: discount answerable beside an item
  // dimension, category grouped on a populated column, returns counted only
  // when posted, profit net of returned-goods cost. All four shipped green.
  { id: 'backend:analytics-truth', cmd: NPM, args: ['run', 'test:analytics-truth'] },
  { id: 'backend:vat-money-path', cmd: NPM, args: ['run', 'test:vat-money-path'] },
  { id: 'backend:item-image', cmd: NPM, args: ['run', 'test:item-image'] },
  { id: 'backend:product-images', cmd: NPM, args: ['run', 'test:product-images-upload'] },
  { id: 'backend:item-assignments', cmd: NPM, args: ['run', 'test:item-assignments'] },
  // ── Unified Sales Analytics Hub (retirement commit) ─────────────────────
  // Core engine (query + no-double-count + timezone + rollup parity), then the
  // security surface (scope clamp + exports), then the money paths (payments /
  // three-way reconciliation / budgets / anomalies / forecast API), then the
  // sales fixes incl. the retired-surfaces negative suite (every deleted
  // endpoint 404s; the unshadowed aging routes answer the page contract).
  { id: 'backend:analytics-core',     cmd: NPM, args: ['run', 'test:analytics-core'] },
  { id: 'backend:analytics-security', cmd: NPM, args: ['run', 'test:analytics-security'] },
  { id: 'backend:analytics-money',    cmd: NPM, args: ['run', 'test:analytics-money'] },
  { id: 'backend:sales-fixes',        cmd: NPM, args: ['run', 'test:sales-fixes'] },
  // Mutation harness (W5a): each seeded math mutant must be KILLED by the
  // analytics unit suites — proves the equations tests bite, not just pass.
  { id: 'audit:mutation-sales-math',  cmd: process.execPath, args: ['scripts/audit/mutation-sales-math.js'] },
  { id: 'schema:release-chain', cmd: NPM, args: ['run', 'test:release-chain'] },
  { id: 'schema:release-sequence', cmd: NPM, args: ['run', 'test:release-sequence'] },
  { id: 'schema:migration-concurrency', cmd: NPM, args: ['run', 'test:migration-concurrency'] },
  { id: 'hygiene:test-residue', cmd: process.execPath, args: ['scripts/audit/test-residue-report.js'] },
  // Retired sales-report surfaces stay dead: greps the live trees for every
  // retired route/component/endpoint marker; any resurrected reference fails.
  { id: 'audit:retired-surfaces', cmd: process.execPath, args: ['scripts/audit/retired-surfaces-report.js'] },
  { id: 'build:erp',          cmd: NPM, args: ['run', 'build:erp'] },
  { id: 'build:pos',          cmd: NPM, args: ['run', 'build:pos'] },
  { id: 'e2e:erp',            cmd: NPX, args: ['playwright', 'test', '--config=playwright.erp.config.ts', '--reporter=line'] },
  // rc-inventory-menu functional spec against its own rc-gate-seeded DB (2000
  // synthetic items). Separate config + port + database from e2e:erp.
  { id: 'e2e:rc-gate',        cmd: NPX, args: ['playwright', 'test', '--config=playwright.rc-gate.config.ts', '--reporter=line'] },
  { id: 'e2e:pos',            cmd: NPX, args: ['playwright', 'test', '--config=playwright.pos.config.ts', '--reporter=line'] },
];

function run(step) {
  const started = Date.now();
  process.stdout.write(`\n━━━ ${step.id} ━━━\n`);
  // Windows + Node's CVE-2024-27980 patch (>=18.20.2/20.12.2/21.7.3) refuses to
  // spawnSync a .cmd/.bat with shell:false — it throws EINVAL before the process
  // even starts (surfacing here as "exit null" at 0.0s). npm.cmd / npx.cmd steps
  // therefore need shell:true; the node-script steps (process.execPath, an .exe
  // whose full path may contain spaces) must stay shell:false so the path is not
  // re-parsed by cmd.exe. All step args are simple flags/paths with no shell
  // metacharacters, so shell:true is safe for the .cmd steps.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(step.cmd);
  const r = spawnSync(step.cmd, step.args, { cwd: ROOT, stdio: 'inherit', shell: needsShell, env: process.env });
  const ms = Date.now() - started;
  const ok = r.status === 0;
  if (r.error) console.error(`  (spawn error: ${r.error.message})`);
  return { id: step.id, ok, status: r.status, ms };
}

(function main() {
  const selected = STEPS.filter((s) => !ONLY || s.id.includes(ONLY));
  if (!selected.length) {
    console.error(`No gate step matches --only=${ONLY}. Known ids:\n  ` + STEPS.map((s) => s.id).join('\n  '));
    process.exit(2);
  }

  const results = [];
  for (const step of selected) {
    const res = run(step);
    results.push(res);
    if (!res.ok && !KEEP_GOING) break;
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = selected.length - results.length;

  console.log('\n═══════════ FULL GATE SUMMARY ═══════════');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.id.padEnd(32)} ${(r.ms / 1000).toFixed(1)}s${r.ok ? '' : `  (exit ${r.status})`}`);
  }
  if (skipped > 0) {
    // Never silently truncate: a run that stopped early must not read as a run
    // that covered everything.
    console.log(`  ⏭  ${skipped} step(s) NOT RUN — the gate stopped at the first failure.`);
    for (const s of selected.slice(results.length)) console.log(`       not run: ${s.id}`);
  }
  const total = results.reduce((a, r) => a + r.ms, 0);
  console.log(`\n  ${results.length - failed.length}/${selected.length} steps passed in ${(total / 60000).toFixed(1)} min`);
  console.log('═════════════════════════════════════════\n');

  process.exit(failed.length === 0 && skipped === 0 ? 0 : 1);
})();
