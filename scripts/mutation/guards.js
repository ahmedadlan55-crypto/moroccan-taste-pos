/**
 * MUTATION TEST for the financial / inventory guards.
 *
 * A passing test suite only proves the code does what it does today. This
 * breaks each critical guard ON PURPOSE, one at a time, and asserts the suite
 * NOTICES. A mutation that survives means the guard is not really covered and
 * could be deleted in a refactor without anything going red.
 *
 * Each mutation is written as the ACTUAL pre-fix code wherever possible, so a
 * surviving mutant would mean the original defect could silently come back.
 *
 * Run: npm run test:mutation            (pure guards only, seconds)
 *      npm run test:mutation:full       (adds the real-server/real-DB mutants)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const withIntegration = process.argv.includes('--integration');

const MUTANTS = [
  // ── lib/recipeEngine.js — the pure rules (fast) ──────────────────────────
  {
    id: 'fold-keeps-only-first',
    why: 'the duplicate-component fold stops summing quantities (material silently lost)',
    file: 'lib/recipeEngine.js',
    from: '    prev.quantity = round6(prev.quantity + net);',
    to: '    prev.quantity = round6(prev.quantity);',
    test: ['node', 'tests/recipeEngine.test.js'],
  },
  {
    id: 'fold-drops-waste-rederivation',
    why: 'the folded line keeps waste 0, so the gross demand production expands shrinks',
    file: 'lib/recipeEngine.js',
    from: '    let waste = r._netBase > 0 ? (r._grossBase / r._netBase - 1) * 100 : 0;',
    to: '    let waste = 0;',
    test: ['node', 'tests/recipeEngine.test.js'],
  },
  {
    id: 'yield-zero-coerced-to-one',
    why: 'the pre-fix `Number(yieldQuantity) || 1` behaviour — a typed 0 becomes a silent 1',
    file: 'lib/recipeEngine.js',
    from: "  if (!Number.isFinite(y) || y <= 0) {\n    throw _err('VALIDATION_ERROR', 'كمية الإنتاج (yield) يجب أن تكون أكبر من صفر');\n  }",
    to: '  if (false) { throw _err(\'VALIDATION_ERROR\', \'x\'); }',
    test: ['node', 'tests/recipeEngine.test.js'],
  },
  {
    id: 'cycle-detection-disabled',
    why: 'multi-level recipe cycles stop being detected (A->B->C->A becomes constructible)',
    file: 'lib/recipeEngine.js',
    from: '  return walk(startKey);',
    to: '  return null;',
    test: ['node', 'tests/recipeEngine.test.js'],
  },
  {
    id: 'joint-alloc-no-remainder-absorption',
    why: 'the last output stops absorbing the rounding remainder, so WIP is left un-relieved',
    file: 'lib/recipeEngine.js',
    from: '    if (i === rest.length - 1) r.value = round4(remaining - handedOut); // absorbs the remainder',
    to: '    if (false) { r.value = 0; }',
    test: ['node', 'tests/recipeEngine.test.js'],
  },
  {
    id: 'allocation-invariant-guard-off',
    why: 'outputs + waste + variance may disagree with the WIP relieved, and nothing complains',
    file: 'lib/recipeEngine.js',
    from: '  if (Math.abs(total - relieved) > 0.005) {',
    to: '  if (false) {',
    test: ['node', 'tests/recipeEngine.test.js'],
  },
  {
    id: 'scrap-zero-means-no-gate',
    why: 'the EXACT pre-fix rule — allowedScrapPct=0 stops meaning zero and gates nothing',
    file: 'lib/recipeEngine.js',
    from: "  if (allowedScrapPct == null || allowedScrapPct === '') return { pct: DEFAULT_SCRAP_ALLOWANCE_PCT, explicit: false };",
    to: "  if (allowedScrapPct == null || allowedScrapPct === '' || Number(allowedScrapPct) <= 0) return { pct: DEFAULT_SCRAP_ALLOWANCE_PCT, explicit: false };",
    test: ['node', 'tests/recipeEngine.test.js'],
  },
  {
    id: 'over-allocation-guard-off',
    why: 'material may be attributed beyond what was consumed — the genealogy defect returning',
    file: 'lib/recipeEngine.js',
    from: '  if (total > round6(Number(consumedQty) || 0) + 1e-6) {',
    to: '  if (false) {',
    test: ['node', 'tests/recipeEngine.test.js'],
  },
  {
    id: 'output-share-always-full',
    why: 'EVERY partial output claims 100% of the remaining material (the original bug)',
    file: 'lib/recipeEngine.js',
    from: '  if (o.isFinal) return 1;',
    to: '  return 1;',
    test: ['node', 'tests/recipeEngine.test.js'],
  },

  // ── lib/inventoryOperations.js — the union read model (fast) ─────────────
  {
    id: 'ops-identifier-validation-off',
    why: 'table/column identifiers stop being validated before entering SQL',
    file: 'lib/inventoryOperations.js',
    from: "  if (!IDENT_RE.test(s)) throw new Error('INVALID_IDENTIFIER: ' + s);",
    to: '  if (false) { throw new Error(1); }',
    test: ['node', 'tests/inventoryOperations.test.js'],
  },

  // ── integration mutants (slow — real server + real DB) ───────────────────
  {
    id: 'expand-bom-no-dedup',
    why: 'a BOM listing one component twice produces two plan rows again, and the issue-plan Map silently drops one',
    file: 'routes/inventory-production.js',
    // Single-line anchor on purpose: this file is checked out with CRLF, so a
    // multi-line anchor written with \n would never match and the mutant would
    // report STALE instead of running.
    from: '      prev.qty = P.round4(prev.qty + qty);',
    to: '      prev.qty = P.round4(qty);',
    test: ['npm', 'run', 'test:production-integrity'],
    integration: true,
  },
  {
    id: 'genealogy-attributes-whole-order',
    why: 'THE original defect: every output event attributed the order`s entire consumption',
    file: 'lib/productionAllocation.js',
    from: '    isFinal: !!o.isFinal,\n  });',
    to: '    isFinal: true,\n  });',
    test: ['npm', 'run', 'test:production-integrity'],
    integration: true,
  },
];

function run(cmd) {
  try {
    execFileSync(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
    return { passed: true };
  } catch (e) {
    return { passed: false, out: String((e.stdout || '') + (e.stderr || '')).slice(-400) };
  }
}

let killed = 0, survived = 0, skipped = 0;
const results = [];

console.log('\n══════ MUTATION TEST — do the guards actually have teeth? ══════\n');

for (const m of MUTANTS) {
  if (m.integration && !withIntegration) { skipped++; console.log('  ⏭  ' + m.id + ' (integration; pass --integration to run)'); continue; }
  const abs = path.join(ROOT, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  if (original.indexOf(m.from) === -1) {
    console.log('  ⚠️  ' + m.id + ' — ANCHOR NOT FOUND in ' + m.file + ' (mutation is stale, fix it)');
    results.push({ id: m.id, verdict: 'STALE' });
    continue;
  }
  fs.writeFileSync(abs, original.replace(m.from, m.to));
  const r = run(m.test);
  fs.writeFileSync(abs, original); // restore ALWAYS, before anything else can throw
  if (r.passed) {
    survived++;
    console.log('  ❌ SURVIVED  ' + m.id + '\n       ' + m.why + '\n       -> the suite did NOT notice. This guard is not covered.');
    results.push({ id: m.id, verdict: 'SURVIVED', why: m.why });
  } else {
    killed++;
    console.log('  ✅ killed    ' + m.id + '  — ' + m.why);
    results.push({ id: m.id, verdict: 'KILLED' });
  }
}

console.log('\n' + (survived === 0 ? '✅' : '❌') + ' mutants killed: ' + killed + ' · survived: ' + survived + (skipped ? ' · skipped: ' + skipped : ''));
if (results.some((r) => r.verdict === 'STALE')) console.log('⚠️  some mutations no longer match the source — update scripts/mutation/guards.js');
console.log('');
process.exit(survived === 0 && !results.some((r) => r.verdict === 'STALE') ? 0 : 1);
