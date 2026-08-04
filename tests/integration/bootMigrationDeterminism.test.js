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
 * Proves: (1) MIGRATE_ONLY exits 0 on a ready DB; (2) the first completed pass
 * already contains late-created POS/workflow/procurement schema (no restart is
 * needed to finish it); (3) two concurrent MIGRATE_ONLY boots both exit 0;
 * (4) payment-method seeding remains deterministic.
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
      PROCUREMENT_P2P_ENABLE: '1',
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

    // Regression: these objects used to be created only on the second boot.
    // Assert their canonical shape immediately after the first completed pass.
    const [[procurementTable]] = await db.query(
      `SELECT TABLE_COLLATION AS collation
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_procurement_migrations'`
    );
    check(
      '_procurement_migrations is born with the canonical collation',
      procurementTable && procurementTable.collation === 'utf8mb4_unicode_ci',
      procurementTable
    );
    const [posColumns] = await db.query(
      `SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH AS max_len
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND ((TABLE_NAME = 'pos_order_lines' AND COLUMN_NAME = 'combo_choices_json')
            OR (TABLE_NAME = 'pos_payments' AND COLUMN_NAME = 'method'))`
    );
    const comboColumn = posColumns.find((c) => c.TABLE_NAME === 'pos_order_lines');
    const paymentMethod = posColumns.find((c) => c.TABLE_NAME === 'pos_payments');
    check('first pass creates pos_order_lines.combo_choices_json', !!comboColumn, posColumns);
    check('first pass widens pos_payments.method to VARCHAR(50)', Number(paymentMethod && paymentMethod.max_len) === 50, posColumns);
    const [replyIndex] = await db.query(
      `SELECT INDEX_NAME
         FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'transaction_replies'
          AND INDEX_NAME = 'idx_replies_txn_created'`
    );
    check('first pass creates transaction_replies.idx_replies_txn_created', replyIndex.length === 2, replyIndex);

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
