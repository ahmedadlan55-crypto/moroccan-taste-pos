/**
 * Phase 5A (RC) — preflight reconciliation test.
 *
 *  A) Runs the preflight against the current DB → 0 BLOCKERs (clean baseline),
 *     every check is well-formed.
 *  B) Injects a KNOWN drift (negative lot balance + stock≠lot) → the specific
 *     BLOCKER checks fire and blockers > 0; then cleans up.
 *  C) Empty-DB friendliness: a stub DB that reports "no such table" → every
 *     check is SKIPPED and blockers === 0 (a fresh empty DB never blocks).
 *
 * Report-only: the only writes are the test's own injected rows (removed in
 * finally). Run: node tests/integration/preflight.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const db = require('../../db/connection');
const { runPreflight } = require('../../scripts/warehouse-v2-preflight');

let _pass = 0, _fail = 0;
function check(name, cond, extra) {
  if (cond) { _pass++; console.log('  ✅', name); }
  else { _fail++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

const ITEM = 'PF-DRIFT-ITEM', LOT = 'PF-DRIFT-LOT', WH = 'PF-DRIFT-WH';

async function cleanup() {
  for (const [sql, p] of [
    ['DELETE FROM warehouse_lot_balances WHERE lot_id=?', [LOT]],
    ['DELETE FROM inventory_lots WHERE id=?', [LOT]],
    ['DELETE FROM warehouse_stock WHERE item_id=? AND warehouse_id=?', [ITEM, WH]],
    ['DELETE FROM inv_items WHERE id=?', [ITEM]],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
  ]) { try { await db.query(sql, p); } catch (_) {} }
}

(async () => {
  console.log('\n═══ RC preflight reconciliation ═══\n');
  let exit = 0;
  try {
    // A) clean baseline
    const base = await runPreflight({ db });
    check('A) baseline preflight → 0 BLOCKERs', base.blockers === 0, { blockers: base.blockers, summary: base.summary });
    check('A) every check has a valid severity + count', base.checks.every((c) => ['BLOCKER', 'WARNING', 'INFO'].includes(c.severity) && typeof c.count === 'number'));
    check('A) report carries a summary + timestamp', !!base.summary && typeof base.generatedAt === 'string');

    // B) inject a KNOWN drift (negative lot balance + stock≠lot for a tracked item)
    await cleanup();
    await db.query("INSERT INTO warehouses (id, code, name, type, is_active) VALUES (?,?,?, 'branch', 1)", [WH, 'PFW', 'مستودع اختبار الانحراف']);
    await db.query("INSERT INTO inv_items (id, name, unit, cost, active, tracking_mode) VALUES (?,?,?,0,1,'expiry')", [ITEM, 'صنف اختبار الانحراف', 'كجم']);
    await db.query("INSERT INTO inventory_lots (id, item_id, lot_number, lot_norm, lifecycle_status, version, created_by) VALUES (?,?,?,?, 'active', 1, 'preflight-test')", [LOT, ITEM, 'PFLOT-1', 'PFLOT-1']);
    await db.query('INSERT INTO warehouse_lot_balances (id, warehouse_id, lot_id, item_id, qty) VALUES (?,?,?,?,?)', ['PFB-1', WH, LOT, ITEM, -5]);
    await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost) VALUES (?,?,?,?,0)', ['PFS-1', WH, ITEM, 10]);

    const drift = await runPreflight({ db });
    const byId = Object.fromEntries(drift.checks.map((c) => [c.id, c]));
    check('B) negative_lot_balance BLOCKER fires', byId.negative_lot_balance && byId.negative_lot_balance.count > 0, byId.negative_lot_balance);
    check('B) lot_stock_drift BLOCKER fires', byId.lot_stock_drift && byId.lot_stock_drift.count > 0, byId.lot_stock_drift);
    check('B) overall blockers > 0 (would FAIL the gate)', drift.blockers > 0, { blockers: drift.blockers });

    // C) empty-DB friendliness — a stub that reports "no such table" → all skipped
    const stub = { query: async () => { const e = new Error("Table 'x' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; } };
    const empty = await runPreflight({ db: stub });
    // totals_snapshot is intentionally resilient (swallows errors → all-zero INFO); every OTHER check skips.
    check('C) empty DB → all data checks SKIPPED', empty.checks.filter((c) => c.id !== 'totals_snapshot').every((c) => c.skipped === true), empty.summary);
    check('C) empty DB → 0 BLOCKERs', empty.blockers === 0, { blockers: empty.blockers });
  } catch (e) {
    console.error('  ❌ unexpected error:', e.message); _fail++;
  } finally {
    await cleanup();
  }

  console.log('\n═══ ' + _pass + ' passed, ' + _fail + ' failed ═══\n');
  try { if (db.pool && db.pool.end) await db.pool.end(); } catch (_) {}
  process.exit(_fail ? 1 : 0);
})();
