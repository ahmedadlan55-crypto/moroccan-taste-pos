#!/usr/bin/env node
/**
 * scripts/order-to-cash/rollback.js — SAFE teardown of the additive O2C schema.
 * The PRIMARY rollback is ORDER_TO_CASH_ENABLE=0 (the module goes dormant, the
 * legacy AR paths resume, the additive tables sit idle). This script only DROPS
 * the O2C tables, and ONLY when they hold NO real activity (ar_events empty and
 * no non-backfill documents) — so it can never destroy live data. Refuses
 * otherwise. Never touches legacy tables.
 *
 *   node scripts/order-to-cash/rollback.js            # report what it would do
 *   node scripts/order-to-cash/rollback.js --confirm  # actually drop (guarded)
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));

const O2C_TABLES = [
  'ar_payment_allocations', 'sales_return_lines', 'sales_returns',
  'ar_document_lines', 'ar_documents',
  'customer_payments', 'ar_events',
];

async function activityGuard() {
  const [[ev]] = [await db.query('SELECT COUNT(*) AS n FROM ar_events')];
  const [[nonBackfill]] = [await db.query("SELECT COUNT(*) AS n FROM ar_documents WHERE COALESCE(created_by,'') NOT IN ('o2c-backfill','backfill')")];
  const [[pay]] = [await db.query('SELECT COUNT(*) AS n FROM customer_payments')];
  return { events: Number(ev[0].n), liveDocs: Number(nonBackfill[0].n), payments: Number(pay[0].n) };
}

async function run({ confirm }) {
  const g = await activityGuard();
  console.log('=== O2C rollback guard ===');
  console.log(`  ar_events=${g.events} · non-backfill ar_documents=${g.liveDocs} · customer_payments=${g.payments}`);
  const blocked = g.events > 0 || g.liveDocs > 0 || g.payments > 0;
  if (blocked) {
    console.log('  REFUSING to drop — real O2C activity present. Roll back via ORDER_TO_CASH_ENABLE=0 instead (tables stay idle, data preserved).');
    await db.end();
    process.exit(2);
  }
  if (!confirm) {
    console.log('  Tables are empty and safe to drop. Re-run with --confirm to drop them.');
    await db.end();
    return;
  }
  await db.query('SET FOREIGN_KEY_CHECKS=0');
  for (const t of O2C_TABLES) { await db.query(`DROP TABLE IF EXISTS \`${t}\``); console.log(`  - dropped ${t}`); }
  await db.query('DROP VIEW IF EXISTS v_customer_ar_balance');
  await db.query("DELETE FROM _o2c_migrations WHERE version LIKE 'O2C%'");
  await db.query('SET FOREIGN_KEY_CHECKS=1');
  console.log('=== O2C tables dropped (additive columns on customers are LEFT in place — harmless) ===');
  await db.end();
}

if (require.main === module) {
  run({ confirm: process.argv.includes('--confirm') })
    .then(() => process.exit(0))
    .catch((e) => { console.error('O2C-ROLLBACK ERROR:', e.message); process.exit(1); });
}

module.exports = { run };
