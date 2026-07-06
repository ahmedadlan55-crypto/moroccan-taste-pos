/**
 * Procurement migration integrity (live, production-like DB — the full 175-table
 * schema with real GL data):
 *   • migrate dry-run → apply → rerun (idempotent, no dup-column errors)
 *   • _procurement_migrations markers recorded
 *   • GRNI 2150 exists as an ACTIVE liability leaf and does not conflict with the
 *     existing chart of accounts
 *   • backfill dry-run → apply → rerun (idempotent)
 *   • reconcile → PASS (exit 0)
 *   • rollback guard → REFUSES while documents exist (exit 2)
 *
 * Run: node tests/procurementMigration.integration.test.js
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const db = require('../db/connection');
const migrate = require('../scripts/procurement/migrate');
const backfill = require('../scripts/procurement/backfill');

let _p = 0, _f = 0;
function ok(c, m) { if (c) { _p++; console.log('  ✅', m); } else { _f++; console.log('  ❌', m); } }
async function noThrow(label, fn) { try { await fn(); ok(true, label); } catch (e) { ok(false, `${label} — ${e.message}`); } }

function runScript(rel, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', rel), ...(args || [])], {
    env: Object.assign({}, process.env, { PROCUREMENT_P2P_ENABLE: '1' }), encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function main() {
  console.log('\n── migrate: dry-run → apply → rerun (idempotent) ──');
  await noThrow('migrate --dry-run does not throw', () => migrate.run({ dryRun: true }));
  await noThrow('migrate apply does not throw', () => migrate.run({ dryRun: false }));
  await noThrow('migrate rerun is idempotent (no dup-column errors)', () => migrate.run({ dryRun: false }));
  const [mig] = await db.query("SELECT version FROM _procurement_migrations WHERE version IN ('P0013','P0014','P0015')");
  ok(mig.length === 3, `_procurement_migrations records all 3 markers (got ${mig.length})`);

  console.log('\n── GRNI account non-conflict ──');
  const [grni] = await db.query("SELECT code, type, is_active, is_folder FROM gl_accounts WHERE code='2150'");
  ok(grni.length === 1, 'exactly one 2150 account (no duplicate)');
  if (grni.length) {
    ok(grni[0].type === 'liability', 'GRNI 2150 is a liability');
    ok(Number(grni[0].is_active) === 1 && Number(grni[0].is_folder) === 0, 'GRNI 2150 is an active postable leaf');
  }
  // no pre-existing NON-GRNI account collided with the configured code
  const [others] = await db.query("SELECT id FROM gl_accounts WHERE code='2150' AND id <> 'GL-2150'");
  ok(others.length === 0, 'no foreign account already occupied code 2150');

  console.log('\n── backfill: dry-run → apply → rerun (idempotent, subprocess) ──');
  const bfDry = runScript('scripts/procurement/backfill.js');
  ok(bfDry.code === 0 && /DRY-RUN complete/.test(bfDry.out), `backfill --dry-run → exit ${bfDry.code}`);
  const bfApply = runScript('scripts/procurement/backfill.js', ['--apply']);
  ok(bfApply.code === 0 && /APPLIED/.test(bfApply.out), `backfill --apply → exit ${bfApply.code}`);
  const bfRerun = runScript('scripts/procurement/backfill.js', ['--apply']);
  ok(bfRerun.code === 0, `backfill rerun idempotent → exit ${bfRerun.code}`);

  console.log('\n── reconcile + rollback guard (subprocess) ──');
  const rec = runScript('scripts/procurement/reconcile.js');
  ok(rec.code === 0 && /RESULT: PASS/.test(rec.out), `reconcile → PASS (exit ${rec.code})`);
  const rb = runScript('scripts/procurement/rollback.js'); // no --confirm; events exist → must refuse
  ok(rb.code === 2 && /REFUSING/.test(rb.out), `rollback guard refuses while documents exist (exit ${rb.code})`);

  await db.end();
  console.log(`\nProcurement migration integrity: ${_p} passed, ${_f} failed`);
  process.exit(_f ? 1 : 0);
}

main().catch((e) => { console.error('MIGRATION TEST ERROR:', e.stack || e.message); process.exit(1); });
