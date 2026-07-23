'use strict';
/* Integration — B5: deterministic, fail-closed, concurrency-safe boot migrations.
 *
 * The Dockerfile release chain is `MIGRATE_ONLY=1 node server.js && node
 * server.js`: the first step provisions the schema under a MySQL advisory lock
 * and exits non-zero if the schema is NOT ready (fail-closed), so a failed
 * migration aborts the deploy. Two instances booting at once serialize on the
 * lock, so migrations never run twice simultaneously and payment methods are
 * never double-seeded (schema.sql now INSERT IGNOREs into a UNIQUE(name), and a
 * dedup+unique migration heals long-lived DBs).
 *
 * Proves: (1) MIGRATE_ONLY exits 0 on a ready DB; (2) two concurrent
 * MIGRATE_ONLY boots both exit 0; (3) no duplicate payment-method names after;
 * (4) the uq_pm_name UNIQUE index exists.
 *
 * Run: node tests/integration/bootMigrationDeterminism.test.js
 */
require('dotenv').config();
const harness = require('../helpers/testHarness');
harness.activate();
const path = require('path');
const { spawn } = require('child_process');
const db = require('../../db/connection');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

function migrateOnly() {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, {
      MIGRATE_ONLY: '1',
      DB_NAME: 'moroccan_taste_pos_test', MYSQL_DATABASE: 'moroccan_taste_pos_test',
      DATABASE_URL: '', MYSQL_URL: '',
      JWT_SECRET: process.env.JWT_SECRET || 'rc_gate_test_secret_2026_ADLAN_verify_XYZ',
      ZATCA_DISABLE_WORKER: '1', NAME_EN_BACKFILL_DISABLE_WORKER: '1', IMAGE_SOURCING_DISABLE_WORKER: '1',
    });
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env, stdio: 'ignore' });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve({ code: 124, timedOut: true }); }, 240000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code }); });
    child.on('error', () => { clearTimeout(t); resolve({ code: -1 }); });
  });
}

(async () => {
  try {
    console.log('\n═══ B5 boot-migration determinism (isolated test DB) ═══');
    // 1) single fail-closed migrate step exits 0 on a ready DB
    const one = await migrateOnly();
    check('MIGRATE_ONLY=1 exits 0 on a ready DB (fail-closed success)', one.code === 0, one);

    // 2) two concurrent MIGRATE_ONLY boots — both succeed (serialized on the lock)
    const [a, b] = await Promise.all([migrateOnly(), migrateOnly()]);
    check('concurrent MIGRATE_ONLY #1 exits 0', a.code === 0, a);
    check('concurrent MIGRATE_ONLY #2 exits 0', b.code === 0, b);

    // 3) no duplicate payment-method names (never double-seeded)
    const [[dup]] = await db.query('SELECT COUNT(*) AS total, COUNT(DISTINCT name) AS distinct_names FROM payment_methods');
    check('payment_methods have NO duplicate names (COUNT = COUNT DISTINCT)', Number(dup.total) === Number(dup.distinct_names), dup);

    // 4) the UNIQUE(name) guard is in place
    const [idx] = await db.query("SHOW INDEX FROM payment_methods WHERE Key_name='uq_pm_name'");
    check('uq_pm_name UNIQUE index exists on payment_methods', idx.length >= 1);

    console.log('\nB5 boot determinism: ' + pass + ' passed, ' + fail + ' failed' + (fail ? ' → ' + fails.join('; ') : ''));
    process.exit(fail ? 1 : 0);
  } catch (e) { console.error('FATAL', e); process.exit(1); }
})();
