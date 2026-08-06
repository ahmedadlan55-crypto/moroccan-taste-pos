'use strict';
/*
 * scripts/purge-procurement.js — erase ALL purchasing and goods-receipt data,
 * and unwind the stock and ledger effects those documents created.
 *
 * WHAT IT REMOVES
 *   Requisitions, purchase orders and their lines, goods receipts and their
 *   lines, supplier invoices/matches, purchase returns, payment allocations,
 *   procurement events, purchase lots, and the legacy `purchases` table.
 *
 * WHAT IT UNWINDS (the half that is easy to forget)
 *   A goods receipt ADDS quantity to warehouse_stock, moves inv_items.cost,
 *   and writes an inventory_movements row. Deleting the paperwork without
 *   reversing those leaves the warehouse reporting stock nobody bought. The
 *   unwind is ATTRIBUTED, never guessed: procurement stamps its movements with
 *   reference_type, so the exact quantity it added to each (item, warehouse) is
 *   a SUM over those rows. Sales, transfers, production and stocktakes carry
 *   other reference types and are never touched.
 *
 * IRREVERSIBLE. There is no undo. Take a database backup first.
 *
 *   node scripts/purge-procurement.js            # dry-run report
 *   node scripts/purge-procurement.js --apply    # delete
 */
require('dotenv').config();
const db = require('../db/connection');
const { planPurge, applyPurge } = require('../lib/procurementPurge');

const APPLY = process.argv.includes('--apply');
const pad = (s, w) => String(s).padEnd(w);

(async () => {
  const plan = await planPurge(db);

  console.log('═══ purge-procurement (' + (APPLY ? 'APPLY' : 'DRY-RUN') + ') ═══\n');
  console.log('  ' + pad('TABLE', 30) + 'ROWS');
  for (const t of plan.tables) {
    console.log('  ' + pad(t.table, 30) + (t.missing ? '— (table absent)' : t.rows));
  }
  console.log('\n  ' + pad('inventory_movements (procurement)', 30) + plan.movements);
  console.log('  ' + pad('gl_journals (procurement)', 30) + plan.glJournals);
  console.log('  ' + pad('stock rows to unwind', 30) + plan.stockUnwind.length);

  if (plan.stockUnwind.length) {
    console.log('\n  STOCK COMING BACK OUT (item · warehouse · qty):');
    for (const s of plan.stockUnwind.slice(0, 25)) {
      console.log('  ' + pad(s.itemId, 24) + pad(s.warehouseId || '—', 24) + s.netQty);
    }
    if (plan.stockUnwind.length > 25) console.log('  … and ' + (plan.stockUnwind.length - 25) + ' more');
  }

  console.log('\n═══ TOTAL: ' + plan.docRows + ' document row(s) ═══');

  if (plan.empty) {
    console.log('\nNothing to purge — there is no procurement data.');
    await db.end();
    return;
  }
  if (!APPLY) {
    console.log('\nDRY-RUN — nothing deleted. This is IRREVERSIBLE; take a backup, then re-run with --apply.');
    await db.end();
    return;
  }

  const removed = await applyPurge(db, plan);
  console.log('\nDeleted:');
  for (const k of Object.keys(removed)) console.log('  ' + pad(k, 30) + removed[k]);

  try {
    await db.query(
      'INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at) ' +
      "VALUES (?, 'procurement_purge', 'procurement', 'ALL', ?, NOW())",
      ['purge-procurement', JSON.stringify({ removed, stockUnwound: plan.stockUnwind.length })]);
  } catch (e) {
    console.error('audit log write failed (the purge DID run):', e.message);
  }

  console.log('\nStock rollups recomputed from warehouse_stock.');
  await db.end();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
