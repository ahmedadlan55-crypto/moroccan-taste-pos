#!/usr/bin/env node
/**
 * scripts/analytics/migrate.js — idempotent Unified Sales Analytics migration.
 * Applies the additive analytics schema (fact/rollup/budget/export tables +
 * branch/pos/AR-line column adds) and the g-analytics capability seeds. Safe
 * on empty / partial DBs and on rerun.
 *
 * Runs under the SAME advisory lock as the release chain (db/migrationLock.js)
 * so a standalone invocation can never race a booting server.js — two
 * connections issuing the same ALTER would fail with a duplicate-column error
 * that aborts the run.
 *
 *   node scripts/analytics/migrate.js            # apply
 *   node scripts/analytics/migrate.js --dry-run  # report only, no writes
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));
const { withMigrationLock } = require('../../db/migrationLock');
const schema = require('../../db/migrations/analytics/schema');
const { applyCapabilitySeeds } = require('../../db/migrations/capability-seeds/apply');
const H = require('../../db/migrations/order-to-cash/ddlHelpers');

const NEW_TABLES = [
  'analytics_meal_periods', 'analytics_order_facts', 'analytics_payment_facts',
  'analytics_modifier_facts', 'analytics_till_facts', 'analytics_sales_budget',
  'analytics_daily_branch', 'analytics_daily_item', 'analytics_daily_payment',
  'analytics_hourly_branch', 'analytics_rollup_dirty', 'analytics_rollup_state',
  'analytics_projection_repair', 'export_jobs', 'report_schedules',
];

async function ensureMarker() {
  await db.query(`CREATE TABLE IF NOT EXISTS _analytics_migrations (
    version VARCHAR(48) PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function run({ dryRun = false } = {}) {
  const log = (m) => console.log(m);
  if (dryRun) {
    console.log('=== analytics migrate DRY-RUN (no writes) ===');
    for (const t of NEW_TABLES) {
      const exists = await H.tableExists(db, t);
      console.log(`  ${exists ? '· exists' : '+ would create'}  ${t}`);
    }
    for (const t of ['branches', 'pos_orders', 'ar_document_lines', 'anomaly_alerts', 'sales']) {
      const exists = await H.tableExists(db, t);
      console.log(`  ${t}: ${exists ? 'would add missing analytics columns/indexes' : 'absent — its adds are skipped (guarded)'}`);
    }
    console.log('  capability seeds: db/migrations/capability-seeds/g-analytics.json (10 analytics.* caps)');
    console.log('=== DRY-RUN complete ===');
    await db.end();
    return;
  }
  await withMigrationLock(async () => {
    await ensureMarker();
    console.log('[schema]');
    await schema.apply(db, log);
    console.log('[capabilities]');
    await applyCapabilitySeeds(db, log);
    await db.query(
      "INSERT IGNORE INTO _analytics_migrations (version) VALUES ('AN0001_schema'), ('AN0002_capabilities')");
  });
  console.log('=== APPLIED. Analytics schema is up to date. ===');
  await db.end();
}

if (require.main === module) {
  run({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((e) => { console.error('ANALYTICS-MIGRATE ERROR:', e.message, '\n', e.stack); process.exit(1); });
}

module.exports = { run };
