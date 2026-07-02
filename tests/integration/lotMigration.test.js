/**
 * Phase 4B — purchase_lots → inventory_lots migration test.
 *   • dry-run reports importable vs unverified groups and writes NOTHING.
 *   • apply imports ONLY the matching groups (Σ purchase_lots = warehouse_stock),
 *     flags mismatches/NULL-warehouse as unverified, NEVER touches warehouse_stock.
 *   • re-run is idempotent (already-imported lots are skipped).
 *
 * Run: node tests/integration/lotMigration.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const { spawn } = require('child_process');
const http = require('http');
const db = require('../../db/connection');
const { migrate } = require('../../scripts/migrate-purchase-lots');

const PORT = Number(process.env.LOTM_TEST_PORT || 3276);
const WH = 'WH-4BM';
const M1 = 'LOTM-1', M2 = 'LOTM-2', M3 = 'LOTM-3';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function dplus(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function ping() { return new Promise((r) => { const q = http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => { s.resume(); r(true); }); q.on('error', () => r(false)); q.setTimeout(1000, () => { q.destroy(); r(false); }); }); }
async function waitUp() { for (let i = 0; i < 90; i++) { if (await ping()) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function lotCount(item) { const [r] = await db.query('SELECT COUNT(*) n FROM inventory_lots WHERE item_id=?', [item]); return Number(r[0].n); }
async function balSum(item) { const [r] = await db.query('SELECT COALESCE(SUM(qty),0) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?', [WH, item]); return Number(r[0].s); }
async function stockQty(item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, item]); return r.length ? Number(r[0].qty) : 0; }

async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM inventory_lot_movements WHERE warehouse_id=?', [WH]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inventory_lots WHERE item_id IN (?,?,?)', [M1, M2, M3]],
    ['DELETE FROM purchase_lots WHERE inv_item_id IN (?,?,?)', [M1, M2, M3]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inv_items WHERE id IN (?,?,?)', [M1, M2, M3]],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, '4BM', 'مستودع الترحيل', 'main']);
  for (const it of [M1, M2, M3]) await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,1)", [it, 'صنف ' + it, 'خام', 'كجم', 5]);
}

(async () => {
  console.log('\n═══ purchase_lots → inventory_lots migration ═══\n');
  await seed();
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    await db.query("UPDATE inv_items SET tracking_mode='lot' WHERE id IN (?,?,?)", [M1, M2, M3]);
    // M1: 2 purchase_lots (30+20=50) match warehouse_stock 50 → IMPORTABLE.
    await db.query("INSERT INTO purchase_lots (inv_item_id,purchase_id,received_date,qty_received,qty_remaining,unit_cost,batch_number,expiry_date,warehouse_id) VALUES (?,?,NOW(),30,30,5,'B1',?,?)", [M1, 'P1', dplus(30), WH]);
    await db.query("INSERT INTO purchase_lots (inv_item_id,purchase_id,received_date,qty_received,qty_remaining,unit_cost,batch_number,expiry_date,warehouse_id) VALUES (?,?,NOW(),20,20,5,'B2',?,?)", [M1, 'P1', dplus(60), WH]);
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES ('WSM1',?,?,50,5)", [WH, M1]);
    // M2: purchase_lots 40 but warehouse_stock 60 (production added 20) → MISMATCH.
    await db.query("INSERT INTO purchase_lots (inv_item_id,purchase_id,received_date,qty_received,qty_remaining,unit_cost,batch_number,warehouse_id) VALUES (?,?,NOW(),40,40,5,'B3',?)", [M2, 'P2', WH]);
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES ('WSM2',?,?,60,5)", [WH, M2]);
    // M3: a purchase_lot with NULL warehouse → flagged (no warehouse).
    await db.query("INSERT INTO purchase_lots (inv_item_id,purchase_id,received_date,qty_received,qty_remaining,unit_cost,batch_number,warehouse_id) VALUES (?,?,NOW(),5,5,5,'B4',NULL)", [M3, 'P3']);
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES ('WSM3',?,?,5,5)", [WH, M3]);

    // ── DRY-RUN ──
    const dry = await migrate({ apply: false });
    const g1 = dry.items.find((g) => g.itemId === M1 && g.warehouseId === WH);
    const g2 = dry.items.find((g) => g.itemId === M2 && g.warehouseId === WH);
    const g3 = dry.items.find((g) => g.itemId === M3 && g.warehouseId === null);
    check('dry-run: M1 group importable (50==50)', g1 && g1.status === 'importable', g1);
    check('dry-run: M2 group unverified (40≠60)', g2 && g2.status === 'unverified', g2);
    check('dry-run: M3 NULL-warehouse flagged', g3 && g3.status === 'unverified', g3);
    check('dry-run wrote NOTHING (no inventory_lots)', (await lotCount(M1)) === 0 && (await lotCount(M2)) === 0, { m1: await lotCount(M1), m2: await lotCount(M2) });

    // ── APPLY ──
    const stockBefore = { m1: await stockQty(M1), m2: await stockQty(M2) };
    const app = await migrate({ apply: true });
    check('apply: imported M1 (2 lots)', app.importedLots === 2 && app.imported === 1, { lots: app.importedLots, items: app.imported });
    check('M1 → 2 inventory_lots + Σbalance 50', (await lotCount(M1)) === 2 && (await balSum(M1)) === 50, { lots: await lotCount(M1), bal: await balSum(M1) });
    check('M1 invariant: Σlot == stock (50)', (await balSum(M1)) === (await stockQty(M1)), { bal: await balSum(M1), stock: await stockQty(M1) });
    check('M2 NOT imported (mismatch left for stocktake)', (await lotCount(M2)) === 0 && (await balSum(M2)) === 0, { lots: await lotCount(M2), bal: await balSum(M2) });
    check('migration did NOT touch warehouse_stock', (await stockQty(M1)) === stockBefore.m1 && (await stockQty(M2)) === stockBefore.m2, { m1: await stockQty(M1), m2: await stockQty(M2) });

    // ── IDEMPOTENT RE-RUN ──
    const again = await migrate({ apply: true });
    check('re-run is idempotent (0 new imports, all skipped)', again.importedLots === 0 && again.skipped === 2, { imported: again.importedLots, skipped: again.skipped });
    check('M1 still exactly 2 lots after re-run', (await lotCount(M1)) === 2 && (await balSum(M1)) === 50, { lots: await lotCount(M1), bal: await balSum(M1) });

  } catch (e) { _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e); }
  finally { try { server.kill(); } catch (_) {} try { await cleanup(); } catch (_) {} }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
