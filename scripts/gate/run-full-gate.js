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
  { id: 'erp:tsc',            cmd: NPM, args: ['--prefix', 'frontend/erp', 'exec', '--', 'tsc', '--noEmit'] },
  { id: 'pos:tsc',            cmd: NPM, args: ['--prefix', 'frontend/pos', 'exec', '--', 'tsc', '--noEmit'] },
  { id: 'erp:vitest',         cmd: NPM, args: ['--prefix', 'frontend/erp', 'run', 'test'] },
  { id: 'pos:vitest',         cmd: NPM, args: ['--prefix', 'frontend/pos', 'run', 'test'] },
  { id: 'root:tests',         cmd: NPM, args: ['test'] },
  { id: 'backend:coa-gl-gate', cmd: NPM, args: ['run', 'test:coa-gl-gate'] },
  { id: 'backend:jv-concurrency', cmd: process.execPath, args: ['tests/integration/glJournalConcurrency.api.test.js'] },
  // CO-4 item 7 — the recipe cost-lock (COST_LOCKED_BY_RECIPE + costOverride
  // unlock) and the "assignments never touch balances" invariant are proven by
  // these backend integration tests. They belong in the gate so the contract is
  // enforced continuously, not just asserted once in the E2E.
  { id: 'backend:cost-source', cmd: NPM, args: ['run', 'test:cost-source'] },
  { id: 'backend:menu-list', cmd: NPM, args: ['run', 'test:menu-list'] },
  { id: 'backend:item-assignments', cmd: NPM, args: ['run', 'test:item-assignments'] },
  { id: 'schema:release-chain', cmd: NPM, args: ['run', 'test:release-chain'] },
  { id: 'schema:release-sequence', cmd: NPM, args: ['run', 'test:release-sequence'] },
  { id: 'schema:migration-concurrency', cmd: NPM, args: ['run', 'test:migration-concurrency'] },
  { id: 'hygiene:test-residue', cmd: process.execPath, args: ['scripts/audit/test-residue-report.js'] },
  { id: 'build:erp',          cmd: NPM, args: ['run', 'build:erp'] },
  { id: 'build:pos',          cmd: NPM, args: ['run', 'build:pos'] },
  { id: 'e2e:erp',            cmd: NPX, args: ['playwright', 'test', '--config=playwright.erp.config.ts', '--reporter=line'] },
  { id: 'e2e:pos',            cmd: NPX, args: ['playwright', 'test', '--config=playwright.pos.config.ts', '--reporter=line'] },
];

function run(step) {
  const started = Date.now();
  process.stdout.write(`\n━━━ ${step.id} ━━━\n`);
  const r = spawnSync(step.cmd, step.args, { cwd: ROOT, stdio: 'inherit', shell: false, env: process.env });
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
