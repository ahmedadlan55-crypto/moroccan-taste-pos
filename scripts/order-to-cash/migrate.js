#!/usr/bin/env node
/**
 * scripts/order-to-cash/migrate.js — idempotent Order-to-Cash schema migration.
 * Applies the additive schema (7 new tables + customers evolve + AR-balance view)
 * and seeds o2c.* capabilities. Safe on empty / partial DBs and on rerun.
 *
 *   node scripts/order-to-cash/migrate.js            # apply
 *   node scripts/order-to-cash/migrate.js --dry-run  # report only, no writes
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));
const schema = require('../../db/migrations/order-to-cash/schema');
const capabilities = require('../../db/migrations/order-to-cash/capabilities');
const H = require('../../db/migrations/order-to-cash/ddlHelpers');

const NEW_TABLES = ['ar_documents', 'ar_document_lines', 'sales_orders', 'sales_order_lines', 'customer_payments', 'ar_payment_allocations', 'sales_returns', 'sales_return_lines', 'ar_events'];

async function ensureMarker() {
  await db.query(`CREATE TABLE IF NOT EXISTS _o2c_migrations (
    version VARCHAR(48) PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function run({ dryRun = false } = {}) {
  const log = (m) => console.log(m);
  if (dryRun) {
    console.log('=== O2C migrate DRY-RUN (no writes) ===');
    for (const t of NEW_TABLES) {
      const exists = await H.tableExists(db, t);
      console.log(`  ${exists ? '· exists' : '+ would create'}  ${t}`);
    }
    const custExists = await H.tableExists(db, 'customers');
    console.log(`  customers evolve: ${custExists ? 'would add missing columns (name_en/vat_number/payment_terms/credit_days/...)' : 'customers table absent (bootstrap creates it elsewhere)'}`);
    console.log(`  view v_customer_ar_balance: would CREATE OR REPLACE`);
    console.log(`  capabilities: ${capabilities.CAPS.length} o2c.* + role grants`);
    console.log('=== DRY-RUN complete ===');
    await db.end();
    return;
  }
  await ensureMarker();
  console.log('[schema]');
  await schema.apply(db, log);
  console.log('[capabilities]');
  await capabilities.seedO2CCapabilities(db, log);
  await db.query("INSERT IGNORE INTO _o2c_migrations (version) VALUES ('O2C0001_schema'), ('O2C0002_capabilities')");
  console.log('=== APPLIED. Order-to-Cash schema is up to date. ===');
  await db.end();
}

if (require.main === module) {
  run({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((e) => { console.error('O2C-MIGRATE ERROR:', e.message, '\n', e.stack); process.exit(1); });
}

module.exports = { run };
