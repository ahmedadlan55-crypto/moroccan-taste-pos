/**
 * Phase 4B — purchase_lots → inventory_lots migration (dry-run + reconciliation).
 *
 * SAFE, idempotent, resumable. For each TRACKED item it reconciles, per warehouse,
 *   SUM(purchase_lots.qty_remaining)  vs  warehouse_stock.qty
 * and only IMPORTS lots for groups that MATCH (Σ purchase_lots = stock). A group
 * that does NOT match (production / transfers added stock with no purchase_lot, or
 * legacy lots with a NULL warehouse) is flagged `unverified` and needs a stocktake
 * to establish real lot balances — it is NEVER auto-reconciled.
 *
 * The migration NEVER mutates warehouse_stock. Imported lots carry is_imported=1 and
 * an import marker movement (reference_type='lot_import', reference_id='PLOT-<id>')
 * so re-running skips already-imported purchase_lots (idempotent + resumable).
 *
 *   node scripts/migrate-purchase-lots.js            # dry-run (report only)
 *   node scripts/migrate-purchase-lots.js --apply    # import the matching groups
 *   node scripts/migrate-purchase-lots.js --item=ID  # restrict to one item
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const db = require('../db/connection');

function r3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function _id(p) { return p + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7); }

async function _alreadyImported(conn, plId) {
  const [r] = await conn.query("SELECT 1 FROM inventory_lot_movements WHERE reference_type='lot_import' AND reference_id=? LIMIT 1", ['PLOT-' + plId]);
  return r.length > 0;
}

// Reconcile (read-only) → report groups; optionally apply the matching ones.
async function migrate(opts) {
  const o = opts || {};
  const apply = !!o.apply;
  const conn = o.conn || db;
  const report = { dryRun: !apply, items: [], imported: 0, importedLots: 0, flagged: 0, skipped: 0 };

  const itemWhere = o.itemId ? ' AND id=?' : '';
  const [items] = await conn.query("SELECT id, name, tracking_mode FROM inv_items WHERE tracking_mode IN ('lot','expiry')" + itemWhere, o.itemId ? [o.itemId] : []);

  for (const it of items) {
    // purchase_lots with remaining qty, grouped per warehouse.
    const [pls] = await conn.query(
      "SELECT id, COALESCE(warehouse_id,'') AS warehouse_id, qty_remaining, unit_cost, batch_number, DATE_FORMAT(expiry_date,'%Y-%m-%d') AS expiry_date, purchase_id " +
      'FROM purchase_lots WHERE inv_item_id=? AND qty_remaining > 0 ORDER BY warehouse_id, id', [it.id]);
    if (!pls.length) continue;
    const byWh = new Map();
    for (const pl of pls) { if (!byWh.has(pl.warehouse_id)) byWh.set(pl.warehouse_id, []); byWh.get(pl.warehouse_id).push(pl); }

    for (const [wh, lots] of byWh) {
      const lotSum = r3(lots.reduce((s, p) => s + Number(p.qty_remaining), 0));
      if (!wh) { report.items.push({ itemId: it.id, itemName: it.name, warehouseId: null, lotSum, stockQty: null, status: 'unverified', reason: 'لا يوجد مستودع على الدفعة (legacy) — يلزم جرد', lots: lots.length }); report.flagged++; continue; }
      const [[ws]] = await conn.query('SELECT COALESCE(qty,0) AS q FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1', [wh, it.id]);
      const stockQty = r3(ws ? ws.q : 0);
      const match = Math.abs(lotSum - stockQty) < 0.001;
      const group = { itemId: it.id, itemName: it.name, warehouseId: wh, lotSum, stockQty, status: match ? 'importable' : 'unverified', lots: lots.length };
      if (!match) { group.reason = 'مجموع الدفعات ≠ رصيد المستودع (إنتاج/تحويلات؟) — يلزم جرد'; report.flagged++; report.items.push(group); continue; }

      if (apply) {
        let importedHere = 0;
        for (const pl of lots) {
          if (await _alreadyImported(conn, pl.id)) { report.skipped++; continue; }
          const lotNumber = (pl.batch_number && String(pl.batch_number).trim()) || ('PLOT-' + pl.id);
          const norm = String(lotNumber).trim().toUpperCase();
          let [ex] = await conn.query('SELECT id FROM inventory_lots WHERE item_id=? AND lot_norm=? LIMIT 1', [it.id, norm]);
          let lotId;
          if (ex.length) { lotId = ex[0].id; }
          else {
            lotId = _id('LOT');
            await conn.query("INSERT INTO inventory_lots (id,item_id,lot_number,lot_norm,expiry_date,lifecycle_status,source_type,source_id,unit_cost,is_imported,version,created_by) VALUES (?,?,?,?,?, 'active','purchase',?,?,1,1,'migration')",
              [lotId, it.id, String(lotNumber).slice(0, 120), norm, pl.expiry_date || null, pl.purchase_id || ('PL-' + pl.id), r3(pl.unit_cost)]);
          }
          // balance += qty_remaining (upsert)
          const [u] = await conn.query('UPDATE warehouse_lot_balances SET qty = qty + ? WHERE warehouse_id=? AND lot_id=?', [r3(pl.qty_remaining), wh, lotId]);
          if (!u.affectedRows) await conn.query('INSERT INTO warehouse_lot_balances (id,warehouse_id,lot_id,item_id,qty) VALUES (?,?,?,?,?)', [_id('WLB'), wh, lotId, it.id, r3(pl.qty_remaining)]);
          await conn.query("INSERT INTO inventory_lot_movements (id,lot_id,warehouse_id,item_id,signed_qty,reference_type,reference_id,reason,actor,occurred_at) VALUES (?,?,?,?,?,'lot_import',?,?, 'migration', NOW())",
            [_id('ILM'), lotId, wh, it.id, r3(pl.qty_remaining), 'PLOT-' + pl.id, 'ترحيل purchase_lots']);
          importedHere++; report.importedLots++;
        }
        group.importedLots = importedHere;
        if (importedHere) report.imported++;
      }
      report.items.push(group);
    }
  }
  return report;
}

module.exports = { migrate };

// CLI
if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const itemArg = process.argv.find((a) => a.startsWith('--item='));
  const itemId = itemArg ? itemArg.split('=')[1] : null;
  (async () => {
    const rep = await migrate({ apply, itemId });
    console.log('\n═══ purchase_lots → inventory_lots ' + (apply ? '(APPLY)' : '(DRY-RUN)') + ' ═══\n');
    for (const g of rep.items) {
      const tag = g.status === 'importable' ? '✅ importable' : '⚠️  ' + g.status;
      console.log(`  ${tag}  item=${g.itemId} wh=${g.warehouseId || '—'} lotSum=${g.lotSum} stock=${g.stockQty == null ? '—' : g.stockQty}` + (g.reason ? '  · ' + g.reason : '') + (g.importedLots != null ? `  (imported ${g.importedLots})` : ''));
    }
    console.log(`\n  groups=${rep.items.length}  importable=${rep.items.filter((x) => x.status === 'importable').length}  flagged=${rep.flagged}  importedLots=${rep.importedLots}  skipped=${rep.skipped}`);
    console.log(apply ? '\n  Applied. Re-run is idempotent (already-imported lots are skipped).\n' : '\n  Dry-run only — no changes. Re-run with --apply to import the matching groups.\n');
    try { await db.end(); } catch (_) {}
    process.exit(0);
  })().catch((e) => { console.error('migration error', e && e.stack || e); process.exit(1); });
}
