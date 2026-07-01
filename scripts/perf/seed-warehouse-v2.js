'use strict';
/**
 * ─── warehouse-v2 PERFORMANCE seed (synthetic, deterministic, idempotent) ────
 *
 * Seeds the FULL-spec volume for the RC performance suite:
 *   10 warehouses · 10,000 items (40% lot-tracked) · ~50,000 stock rows ·
 *   ~50,000 lots + balances (reconciled: Σ lot = stock for every tracked row,
 *   so the invariant holds and preflight stays at 0 blockers) · 100,000 stock
 *   movements · ~3,000 draft documents (receipts/issues/adjustments) + lines.
 *
 * Synthetic only (PERF-* ids). Deterministic LCG (no Math.random) so reruns are
 * identical. Idempotent: skips if already seeded. Intended for a DEDICATED perf
 * DB (DB_NAME=...perf) — never the production schema.
 */
const SCALE = {
  WAREHOUSES: 10, ITEMS: 10000, TRACKED_FRACTION: 0.4,
  WH_PER_ITEM: 5, LOTS_PER_TRACKED_STOCK: 2.5, MOVEMENTS: 100000,
  DOCS_PER_TYPE: 1000, LINES_PER_DOC: 2,
};

// Deterministic PRNG
let _s = 1234567;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

async function batch(db, head, rows, nCols, per) {
  per = per || 2000;
  const one = '(' + Array(nCols).fill('?').join(',') + ')';
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const flat = [];
    for (const r of chunk) flat.push.apply(flat, r);
    await db.query(head + ' VALUES ' + chunk.map(() => one).join(','), flat);
  }
}

async function seed(opts) {
  opts = opts || {};
  const db = opts.db || require('../../db/connection');
  const S = Object.assign({}, SCALE, opts.scale || {});
  const log = opts.log || ((m) => console.log('  ' + m));
  _s = 1234567;

  const [[c]] = await db.query("SELECT COUNT(*) AS n FROM inv_items WHERE id LIKE 'PERF-ITEM-%'");
  const [[mv]] = await db.query("SELECT COUNT(*) AS n FROM inventory_movements WHERE id LIKE 'PM-%'");
  if (Number(c.n) >= S.ITEMS && Number(mv.n) >= S.MOVEMENTS) { log('already seeded (' + c.n + ' items, ' + mv.n + ' movements) — skipping'); return { skipped: true }; }

  const t0 = Date.now();
  // 1) warehouses
  const whs = [];
  for (let w = 0; w < S.WAREHOUSES; w++) whs.push('PERF-WH-' + w);
  await batch(db, 'INSERT IGNORE INTO warehouses (id, code, name, type, is_active)',
    whs.map((id, i) => [id, 'PW' + i, 'مستودع الأداء ' + i, 'branch', 1]), 5);
  log('warehouses: ' + whs.length);

  // 2) items (40% tracked)
  const items = [];
  const trackedItems = [];
  const itemRows = [];
  for (let k = 0; k < S.ITEMS; k++) {
    const id = 'PERF-ITEM-' + String(k).padStart(5, '0');
    const tracked = k < S.ITEMS * S.TRACKED_FRACTION;
    items.push(id); if (tracked) trackedItems.push(id);
    const sku = 'PSKU-' + String(k).padStart(6, '0');
    itemRows.push([id, 'صنف الأداء ' + k, 'كجم', 1 + ri(50), 1, tracked ? 'expiry' : 'none', 'raw', 1, sku, sku]);
  }
  await batch(db, 'INSERT IGNORE INTO inv_items (id, name, unit, cost, active, tracking_mode, kind, is_inventoried, sku, sku_norm)', itemRows, 10);
  log('items: ' + items.length + ' (' + trackedItems.length + ' tracked)');

  // 3) stock rows (each item in WH_PER_ITEM warehouses) + 4) lots/balances for tracked
  const stockRows = [], lotRows = [], balRows = [];
  let lotSeq = 0;
  for (let k = 0; k < items.length; k++) {
    const id = items[k];
    const tracked = k < trackedItems.length;
    // pick WH_PER_ITEM distinct warehouses
    const start = ri(S.WAREHOUSES);
    for (let j = 0; j < S.WH_PER_ITEM; j++) {
      const w = (start + j) % S.WAREHOUSES;
      const wh = 'PERF-WH-' + w;
      const qty = 10 + ri(490);
      stockRows.push(['PS-' + k + '-' + w, wh, id, qty, 1 + ri(50)]);
      if (tracked) {
        // split qty into 2-3 reconciled lots
        const nLots = 2 + (ri(10) < 5 ? 1 : 0);
        let remaining = qty;
        for (let l = 0; l < nLots; l++) {
          const part = (l === nLots - 1) ? remaining : Math.max(1, Math.floor(remaining / (nLots - l)));
          remaining -= part;
          const lotId = 'PL-' + (lotSeq++);
          const days = 10 + ri(400);
          const exp = new Date(Date.UTC(2026, 6, 1) + days * 86400000).toISOString().slice(0, 10);
          lotRows.push([lotId, id, 'PLOT-' + lotId, 'PLOT-' + lotId, exp, 'active', 1 + ri(50), 1, 'perf']);
          balRows.push(['PB-' + lotId, wh, lotId, id, part]);
          if (remaining <= 0) break;
        }
      }
    }
  }
  await batch(db, 'INSERT IGNORE INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost)', stockRows, 5);
  log('stock rows: ' + stockRows.length);
  await batch(db, 'INSERT IGNORE INTO inventory_lots (id, item_id, lot_number, lot_norm, expiry_date, lifecycle_status, unit_cost, version, created_by)', lotRows, 9);
  await batch(db, 'INSERT IGNORE INTO warehouse_lot_balances (id, warehouse_id, lot_id, item_id, qty)', balRows, 5);
  log('lots: ' + lotRows.length + ' · balances: ' + balRows.length);

  // 5) movements (log; no reconciliation needed)
  const movRows = [];
  for (let m = 0; m < S.MOVEMENTS; m++) {
    const k = ri(items.length);
    const w = ri(S.WAREHOUSES);
    movRows.push(['PM-' + m, new Date(Date.UTC(2026, 5, 1) + ri(2592000000)), items[k], 'صنف الأداء ' + k,
      (ri(2) ? 'in' : 'out'), 1 + ri(100), 'perf', 'بذرة أداء', 'PERF-WH-' + w, 'perf', 'PERF-' + m]);
  }
  await batch(db, 'INSERT IGNORE INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, username, notes, warehouse_id, reference_type, reference_id)', movRows, 11, 1500);
  log('movements: ' + movRows.length);

  // 6) draft documents (receipts/issues/adjustments) + lines — for list/detail perf
  const docDefs = [
    { tbl: 'inv_receipts', num: 'receipt_number', pre: 'PRC', fk: 'receipt_id', items: 'inv_receipt_items' },
    { tbl: 'inv_issues', num: 'issue_number', pre: 'PIS', fk: 'issue_id', items: 'inv_issue_items' },
    { tbl: 'inv_adjustments', num: 'adjustment_number', pre: 'PAD', fk: 'adjustment_id', items: 'inv_adjustment_items' },
  ];
  let docTotal = 0;
  for (const d of docDefs) {
    const hdr = [], lns = [];
    const dateCol = d.tbl === 'inv_receipts' ? 'receipt_date' : d.tbl === 'inv_issues' ? 'issue_date' : 'adjustment_date';
    for (let n = 0; n < S.DOCS_PER_TYPE; n++) {
      const id = d.pre + '-' + n;
      const wh = 'PERF-WH-' + ri(S.WAREHOUSES);
      hdr.push([id, d.pre + '-2026-' + String(n).padStart(5, '0'), wh, '2026-06-15', 'draft', 'بذرة أداء', 1, 'perf']);
      for (let li = 0; li < S.LINES_PER_DOC; li++) {
        const k = ri(items.length);
        if (d.tbl === 'inv_adjustments') lns.push([id + '-' + li, id, items[k], 'صنف ' + k, 'كجم', 10, 12, 2, 24]);
        else lns.push([id + '-' + li, id, items[k], 'صنف ' + k, 'كجم', 5 + ri(20), 1 + ri(20)]);
      }
    }
    await batch(db, 'INSERT IGNORE INTO ' + d.tbl + ' (id, ' + d.num + ', warehouse_id, ' + dateCol + ', status, reason, version, created_by)', hdr, 8);
    if (d.tbl === 'inv_adjustments')
      await batch(db, 'INSERT IGNORE INTO ' + d.items + ' (id, ' + d.fk + ', item_id, item_name, unit, system_qty_snapshot, counted_qty, delta, delta_value)', lns, 9);
    else
      await batch(db, 'INSERT IGNORE INTO ' + d.items + ' (id, ' + d.fk + ', item_id, item_name, unit, qty, unit_cost)', lns, 7);
    docTotal += hdr.length;
  }
  log('documents: ' + docTotal + ' (draft)');

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log('seed complete in ' + secs + 's');
  return {
    skipped: false, seconds: Number(secs),
    counts: { warehouses: whs.length, items: items.length, tracked: trackedItems.length, stock: stockRows.length, lots: lotRows.length, balances: balRows.length, movements: movRows.length, documents: docTotal },
    sampleLotId: lotRows.length ? lotRows[0][0] : null,
  };
}

if (require.main === module) {
  (async () => {
    try { require('dotenv').config(); } catch (_) {}
    const db = require('../../db/connection');
    console.log('\n═══ warehouse-v2 PERF seed (DB=' + (process.env.DB_NAME || '?') + ') ═══\n');
    const r = await seed({ db });
    console.log('\n' + JSON.stringify(r.counts || { skipped: r.skipped }, null, 0) + '\n');
    try { if (db.pool && db.pool.end) await db.pool.end(); } catch (_) {}
    process.exit(0);
  })().catch((e) => { console.error('SEED FAILED:', e); process.exit(1); });
}

module.exports = { seed, SCALE };
