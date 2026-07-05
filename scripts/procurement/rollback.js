#!/usr/bin/env node
/**
 * scripts/procurement/rollback.js — guarded rollback of the P2P additions.
 *
 * The PRIMARY rollback is operational: set PROCUREMENT_P2P_ENABLE=0 — the module
 * unmounts, the legacy writers resume untouched, and the additive schema is inert.
 *
 * This script is the LAST-RESORT hard rollback: it DROPs only the NEW tables and
 * removes the procurement migration markers, and ONLY when `procurement_events`
 * is empty (i.e. no P2P documents were ever created). It refuses otherwise. The
 * evolved columns on existing tables + the GRNI account are left in place
 * (harmless, additive). Requires --confirm.
 *
 * Usage: node scripts/procurement/rollback.js --confirm
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));

const NEW_TABLES = ['payment_allocations', 'supplier_invoice_matches', 'purchase_return_lines', 'purchase_returns', 'procurement_events'];

async function main({ confirm }) {
  console.log('\n=== Procurement rollback (guarded) ===');
  const [[ev]] = await db.query("SELECT COUNT(*) c FROM procurement_events").catch(() => [[{ c: 0 }]]);
  if (Number(ev.c) > 0) {
    console.error(`REFUSING: procurement_events has ${ev.c} rows — P2P documents exist. Use PROCUREMENT_P2P_ENABLE=0 to disable instead of dropping data.`);
    await db.end();
    process.exit(2);
  }
  if (!confirm) {
    console.log('Dry-run. procurement_events is empty → safe to hard-rollback.');
    console.log('Would DROP:', NEW_TABLES.join(', '));
    console.log('Would clear _procurement_migrations markers (evolved columns + GRNI account kept).');
    console.log('Re-run with --confirm to execute.');
    await db.end();
    return;
  }
  await db.query('DROP VIEW IF EXISTS v_supplier_ap_balance');
  for (const t of NEW_TABLES) { await db.query(`DROP TABLE IF EXISTS \`${t}\``); console.log(`  dropped ${t}`); }
  await db.query("DELETE FROM _procurement_migrations WHERE version IN ('P0013','P0014','P0015')").catch(() => {});
  console.log('=== rollback complete (additive columns + GRNI account retained) ===');
  await db.end();
}

if (require.main === module) {
  main({ confirm: process.argv.includes('--confirm') }).catch((e) => { console.error('ROLLBACK ERROR:', e.message); process.exit(1); });
}
module.exports = { main };
