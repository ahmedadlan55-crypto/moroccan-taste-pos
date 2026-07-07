#!/usr/bin/env node
/**
 * scripts/order-to-cash/reconcile.js — CLI wrapper over O2CReconciliationService.
 * Read-only. Prints every invariant + PASS/FAIL and exits non-zero on a hard
 * failure so it can gate a cutover.
 *
 *   node scripts/order-to-cash/reconcile.js
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));
const Reconcile = require('../../services/order-to-cash/O2CReconciliationService');

async function run() {
  const res = await Reconcile.run(db);
  console.log('=== Order-to-Cash reconciliation ===');
  for (const c of res.checks) {
    const mark = c.pass ? 'PASS' : (c.severity === 'warn' ? 'WARN' : 'FAIL');
    console.log(`  [${mark}] ${c.name} — ${c.detail}`);
  }
  console.log(`=== ${res.pass ? 'RECONCILE PASS' : 'RECONCILE FAIL'} ===`);
  await db.end();
  process.exit(res.pass ? 0 : 1);
}

if (require.main === module) {
  run().catch((e) => { console.error('O2C-RECONCILE ERROR:', e.message); process.exit(1); });
}

module.exports = { run };
