const router = require('express').Router();
const acctDate = require('../lib/accountingDate');
const db = require('../db/connection');
const { recomputeInvItemStock, recomputeMenuStock, reconcileAllStock, deductWarehouseStock } = require('../lib/stockRecompute');
const { nextDocNumber } = require('../lib/docNumber'); // v7.1 — ADJ-… numbering
// Phase 0 (Contracts & Safety) — managerial RBAC for posting/deleting stock
// documents, plus the shared adjustment/stocktake lifecycle guards.
const MGR = require('../middleware/auth').requireRole('admin', 'manager');
// G-INV — fine-grained capability guards (permissions_v3 ∪ overrides, admin
// bypass, fails closed). Every write route below now names the capability it
// needs; cashier-facing POS flows use the g-inv seeded capabilities
// (db/migrations/capability-seeds/g-inv.json) so the POS keeps working.
const requireCapability = require('../middleware/requireCapability');
const { hasCapability } = require('../middleware/requireCapability');
const ADJ = require('../lib/inventoryAdjustment');
const STK = require('../lib/stocktakeWorkflow');
// Phase 2A — pure helpers backing the read-only warehouse-v2 endpoints
// (warehouses-summary, dashboard-summary, grid). Shared with tests.
const INV = require('../lib/inventoryReporting');
// Phase 2A.2 — warehouse access control (req.guardWh / req.whScopeClause are
// attached by middleware/warehouseScope, mounted in server.js before this
// router). Imported here only to report the enforcement flag in /access-scope.
const WH_SCOPE = require('../middleware/warehouseScope');

// Phase 5A (RC) — legacy stock writers cannot capture lot identity/expiry, so a
// TRACKED item's quantity must never change through them (the invariant
// Σ(lot balances)=warehouse_stock would silently break). Mirrors the
// purchases.js PO-receive gate (WRITER_NOT_LOT_AWARE). Returns true when the
// request was rejected (caller must `return`). Untracked items unaffected.
async function _blockTrackedLegacy(q, itemIds, res) {
  const ids = (Array.isArray(itemIds) ? itemIds : [itemIds]).filter(Boolean);
  if (!ids.length) return false;
  const [rows] = await (q || db).query(
    "SELECT id, name FROM inv_items WHERE tracking_mode <> 'none' AND id IN (" + ids.map(() => '?').join(',') + ')', ids);
  if (!rows.length) return false;
  res.status(422).json({
    success: false, code: 'WRITER_NOT_LOT_AWARE',
    error: 'الصنف "' + rows[0].name + '" يخضع لتتبع الدفعات — استخدم مستندات warehouse-v2 (استلام/صرف/تعديل/جرد) بدلاً من المسار القديم حتى لا يختل رصيد الدفعات.',
  });
  return true;
}

// Server-authoritative capability map (mirrors the frontend permissions.ts
// matrix so the UI never shows a dead button). RBAC remains the real boundary.
const _CAP_MATRIX = {
  'warehouse.view':       ['admin', 'manager', 'employee', 'custody', 'cashier', 'auditor'],
  'warehouse.create':     ['admin', 'manager'],
  'warehouse.deactivate': ['admin', 'manager'],
  'transfer.create':      ['admin', 'manager', 'employee', 'custody'],
  'transfer.approve':     ['admin', 'manager'],
  'transfer.issue':       ['admin', 'manager', 'employee', 'custody'],
  'transfer.receive':     ['admin', 'manager', 'employee', 'custody'],
  'transfer.reverse':     ['admin', 'manager'],
  'stocktake.create':     ['admin', 'manager', 'employee', 'custody'],
  'stocktake.approve':    ['admin', 'manager'],
  'adjustment.create':    ['admin', 'manager', 'employee', 'custody'],
  'adjustment.approve':   ['admin', 'manager'],
  'waste.create':         ['admin', 'manager', 'employee', 'custody'],
  'document.reverse':     ['admin', 'manager'],
  'settings.edit':        ['admin', 'manager'],
};
function _capabilitiesFor(user) {
  const role = String((user && user.role) || '').toLowerCase() || 'cashier';
  const isDev = !!(user && (user.isDeveloper === true || user.isDeveloper === 1 || user.isDeveloper === '1'));
  const caps = {};
  Object.keys(_CAP_MATRIX).forEach((action) => {
    caps[action] = isDev || _CAP_MATRIX[action].indexOf(role) !== -1;
  });
  return caps;
}

async function _reportCapabilitiesFor(user) {
  const ids = ['finance.reports.view', 'procurement.reports'];
  const resolved = await Promise.all(ids.map(async (id) => {
    try { return [id, await hasCapability(user, id)]; }
    catch (_) { return [id, false]; }
  }));
  return Object.fromEntries(resolved);
}

// Phase 0 §5 / G-INV M2 — actor identity comes STRICTLY from the authenticated
// JWT (req.user); the global /api gate sets req.user for every /api/inventory
// route. The old body-username fallback let any caller spoof the recorded
// actor on stocktakes/adjustments/audit rows and is deleted.
function _actor(req) {
  return (req.user && (req.user.username || req.user.name)) || '';
}

// v5.10.25 — Idempotent migration: add deleted_at column to inv_items so
// the new "إدارة مواد المخزون" catalog page can soft-delete + restore.
// Runs once per server lifetime; subsequent calls are a no-op.
let _catalogColumnEnsured = false;
async function _ensureCatalogSoftDeleteColumn() {
  if (_catalogColumnEnsured) return;
  try {
    const [cols] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inv_items' AND COLUMN_NAME = 'deleted_at'");
    if (!cols.length) {
      await db.query("ALTER TABLE inv_items ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL");
      console.log('[inventory] v5.10.25 added inv_items.deleted_at column');
    }
    _catalogColumnEnsured = true;
  } catch (e) {
    console.warn('[inventory] v5.10.25 deleted_at migration skipped:', e.message);
  }
}
// v5.10.29 — Idempotent schema migrations for the inventory + accounting
// dimensions that the code relies on but the seed schema doesn't always
// declare. Each runs once per server lifetime; subsequent calls are a
// no-op. Errors are warned but never fatal — they let stale deploys keep
// working until the operator updates the schema.
let _v51029MigrationsRan = false;
async function _ensureColumn(table, column, definition) {
  const [cols] = await db.query(
    "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
    [table, column]);
  if (!cols.length) {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
    console.log(`[inventory v5.10.29] added ${table}.${column}`);
  }
}
async function _ensureIndex(table, indexName, columns) {
  const [idx] = await db.query(
    "SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1",
    [table, indexName]);
  if (!idx.length) {
    await db.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` (${columns})`);
    console.log(`[inventory v5.10.29] created index ${indexName} on ${table}(${columns})`);
  }
}
async function _ensureTable(name, ddl) {
  const [t] = await db.query(
    "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1",
    [name]);
  if (!t.length) {
    await db.query(ddl);
    console.log(`[inventory v5.10.29] created table ${name}`);
  }
}
async function _runV51029Migrations() {
  if (_v51029MigrationsRan) return;
  try {
    // (1) inventory_movements.warehouse_id — code assumes this exists
    //     (warehouse-aware reports + per-cashier deduction). On older
    //     deploys the seed schema lacks it; add NULLABLE so historic rows
    //     stay valid.
    await _ensureColumn('inventory_movements', 'warehouse_id',
      'warehouse_id VARCHAR(50) NULL DEFAULT NULL');
    await _ensureIndex('inventory_movements', 'idx_invmov_wh_date',
      'warehouse_id, movement_date');

    // (2) gl_entries dimensions — accounting dimension columns the
    //     glPosting service writes to, but core schema only carries the
    //     basic columns. Without them, dimension reports return blanks.
    await _ensureColumn('gl_entries', 'warehouse_id',  'warehouse_id  VARCHAR(50) NULL DEFAULT NULL');
    await _ensureColumn('gl_entries', 'branch_id',     'branch_id     VARCHAR(50) NULL DEFAULT NULL');
    await _ensureColumn('gl_entries', 'cost_center_id','cost_center_id VARCHAR(50) NULL DEFAULT NULL');
    await _ensureColumn('gl_entries', 'brand_id',      'brand_id      VARCHAR(50) NULL DEFAULT NULL');
    await _ensureIndex('gl_entries', 'idx_gle_dim_warehouse', 'warehouse_id');
    await _ensureIndex('gl_entries', 'idx_gle_dim_branch',    'branch_id');
    await _ensureIndex('gl_entries', 'idx_gle_dim_costctr',   'cost_center_id');
    await _ensureIndex('gl_entries', 'idx_gle_dim_brand',     'brand_id');

    // (3) cost_centers master — referenced by budgets/AP/AR but never
    //     created in the seed. Minimal hierarchy + branch link.
    await _ensureTable('cost_centers', `
      CREATE TABLE cost_centers (
        id          VARCHAR(50) PRIMARY KEY,
        code        VARCHAR(50) UNIQUE,
        name_ar     VARCHAR(200) NOT NULL,
        name_en     VARCHAR(200),
        branch_id   VARCHAR(50) NULL,
        parent_id   VARCHAR(50) NULL,
        is_active   BOOLEAN DEFAULT TRUE,
        notes       TEXT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by  VARCHAR(80),
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    _v51029MigrationsRan = true;
  } catch (e) {
    console.warn('[inventory v5.10.29] migration warning:', e.message);
  }
}

// Best-effort: trigger on first request that touches the catalog
router.use(async (req, res, next) => {
  if (!_catalogColumnEnsured) await _ensureCatalogSoftDeleteColumn();
  if (!_v51029MigrationsRan)  await _runV51029Migrations();
  next();
});

// v5.10.28 — Shared helpers for the catalog hardening pass.
// ---------------------------------------------------------------
// _validateItemPayload(): rejects negative cost / convRate<=0 / blank name.
// Returns null on success or { status, error } on failure.
function _validateItemPayload(b, opts) {
  opts = opts || {};
  const isUpdate = !!opts.update;
  if (!isUpdate || b.name !== undefined) {
    const nm = (b.name == null ? '' : String(b.name)).trim();
    if (!nm) return { status: 400, error: 'name-required' };
    if (nm.length > 200) return { status: 400, error: 'name-too-long' };
  }
  if (b.cost !== undefined && b.cost !== '' && b.cost !== null) {
    const c = Number(b.cost);
    if (!isFinite(c) || c < 0) return { status: 400, error: 'cost-must-be-nonneg-number' };
  }
  if (b.convRate !== undefined && b.convRate !== '' && b.convRate !== null) {
    const cr = Number(b.convRate);
    if (!isFinite(cr) || cr <= 0) return { status: 400, error: 'convRate-must-be-positive' };
  }
  if (b.minStock !== undefined && b.minStock !== '' && b.minStock !== null) {
    const m = Number(b.minStock);
    if (!isFinite(m) || m < 0) return { status: 400, error: 'minStock-must-be-nonneg' };
  }
  if (b.qty !== undefined && b.qty !== '' && b.qty !== null) {
    const q = Number(b.qty);
    if (!isFinite(q) || q < 0) return { status: 400, error: 'qty-must-be-nonneg' };
  }
  return null;
}

// _checkDuplicateName(): returns id of an existing active item with the same
// (name, brand_id) pair, or null. Excludes the supplied id so updates don't
// flag themselves. Brand is part of the key — same name across brands is OK.
async function _checkDuplicateName(conn, name, brandId, excludeId) {
  const c = conn || db;
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const params = [trimmed];
  let sql = 'SELECT id FROM inv_items WHERE deleted_at IS NULL AND TRIM(name) = ?';
  if (brandId) { sql += ' AND brand_id = ?'; params.push(brandId); }
  else         { sql += ' AND (brand_id IS NULL OR brand_id = "")'; }
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  sql += ' LIMIT 1';
  const [rows] = await c.query(sql, params);
  return rows.length ? rows[0].id : null;
}

// _audit(): write a row to audit_log. Best-effort — never throws.
// action: e.g. 'inv_item.create', 'inv_item.update', 'inv_item.soft_delete',
// 'inv_item.restore', 'inv_item.hard_delete'.
async function _audit(connOrDb, req, action, recordId, oldVal, newVal) {
  try {
    const c = connOrDb || db;
    // G-INV M2 — audit actor from the JWT only (body fallback was spoofable).
    const username = (req && req.user && req.user.username) || 'system';
    const userId   = (req && req.user && req.user.id) || null;
    const ip       = (req && (req.ip || (req.headers && req.headers['x-forwarded-for']) || '')) || '';
    const ua       = (req && req.headers && req.headers['user-agent']) || '';
    const id = 'AUD-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
    const oldStr = oldVal == null ? null : (typeof oldVal === 'string' ? oldVal : JSON.stringify(oldVal));
    const newStr = newVal == null ? null : (typeof newVal === 'string' ? newVal : JSON.stringify(newVal));
    await c.query(
      `INSERT INTO audit_log (id, user_id, username, action, table_name, record_id, old_value, new_value, ip_address, device_info)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, userId, username, action, 'inv_items', recordId || null, oldStr, newStr, String(ip).slice(0,50), String(ua).slice(0,500)]
    );
  } catch (e) {
    // Audit must never break the main flow.
    if (process.env.NODE_ENV !== 'production') console.warn('[inventory audit]', action, e.message);
  }
}

// _fetchItemSnapshot(): small helper for before/after audit values.
async function _fetchItemSnapshot(connOrDb, id) {
  try {
    const c = connOrDb || db;
    const [rows] = await c.query(
      'SELECT id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active, brand_id, deleted_at FROM inv_items WHERE id = ?', [id]);
    return rows[0] || null;
  } catch (_) { return null; }
}

// V5.9.1 — Backfill helper.  Ensures EVERY active inv_item has at least one
//   warehouse_stock row so the warehouse-aware UI never hides items.
//   The previous V5.9.0 version skipped items with stock=0, which made
//   146 of the user's 159 items disappear from the warehouse view.
//   Now: items with stock=0 still get a row (qty=0) — they're visible
//   in their default warehouse so the user can transfer/adjust into them.
//   Idempotent: only inserts where no row exists yet.
async function _ensureWarehouseStockBackfilled() {
  try {
    // Find ALL active items with NO row in warehouse_stock — regardless of stock value
    const [orphans] = await db.query(`
      SELECT i.id, i.name, i.brand_id, i.stock
      FROM inv_items i
      LEFT JOIN warehouse_stock ws ON ws.item_id = i.id
      WHERE i.active = 1 AND ws.id IS NULL
    `);
    if (!orphans.length) return { backfilled: 0 };
    // Pick a default warehouse PER brand: prefer is_main=1, else first by code.
    //   If still nothing, pick the global oldest warehouse (e.g., "أوكتين").
    const [allWh] = await db.query(`SELECT id, name, brand_id, is_main FROM warehouses WHERE is_active=1 ORDER BY (is_main=1) DESC, code ASC`);
    if (!allWh.length) return { backfilled: 0, error: 'no warehouses' };
    const byBrand = {};
    allWh.forEach(w => { if (!byBrand[w.brand_id || ''] || w.is_main) byBrand[w.brand_id || ''] = w; });
    const fallback = allWh[0];  // global oldest if brand has no warehouse
    let n = 0;
    for (const it of orphans) {
      const wh = byBrand[it.brand_id || ''] || fallback;
      const id = 'WS-BF-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      await db.query(
        'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE qty = VALUES(qty)',
        [id, wh.id, it.id, Number(it.stock) || 0]
      );
      n++;
    }
    console.log('[inventory] V5.9.1 backfilled warehouse_stock for', n, 'items (incl. zero-stock)');
    return { backfilled: n };
  } catch (e) {
    console.warn('[inventory] backfill skipped:', e.message);
    return { error: e.message };
  }
}

// Manual backfill trigger (admin only — one-time)
router.post('/warehouse-stock/backfill', requireCapability('inventory.edit'), async (req, res) => {
  res.json(await _ensureWarehouseStockBackfilled());
});

// v5.10.23 — Cleanup endpoint that REMOVES the legacy "ghost" warehouse_stock
// rows: rows where qty=0 AND there is NO movement history for that
// (warehouse, item) pair. Such rows are leftovers from the old auto-
// backfill that injected the entire brand catalog into every warehouse,
// which made every warehouse view look identical (the user complaint
// "warehouses are not truly independent").
//
// GET  → dry-run, returns the list of rows that WOULD be deleted
// POST → actually deletes them
async function _findEmptyGhostRows() {
  try {
    const [rows] = await db.query(`
      SELECT ws.id, ws.warehouse_id, ws.item_id, w.name AS warehouse_name, i.name AS item_name
      FROM warehouse_stock ws
      JOIN warehouses w ON w.id = ws.warehouse_id
      JOIN inv_items   i ON i.id = ws.item_id
      WHERE COALESCE(ws.qty, 0) <= 0
        AND NOT EXISTS(
          SELECT 1 FROM inventory_movements im
          WHERE im.item_id = ws.item_id AND im.warehouse_id = ws.warehouse_id
        )
    `);
    return rows;
  } catch (e) {
    return { _error: e.message };
  }
}

router.get('/warehouse-stock/cleanup-ghosts', async (req, res) => {
  const ghosts = await _findEmptyGhostRows();
  if (ghosts && ghosts._error) return res.json({ success: false, error: ghosts._error });
  res.json({
    success: true,
    dryRun: true,
    count: ghosts.length,
    sample: ghosts.slice(0, 20).map(r => ({
      itemId: r.item_id, itemName: r.item_name,
      warehouseId: r.warehouse_id, warehouseName: r.warehouse_name
    }))
  });
});

router.post('/warehouse-stock/cleanup-ghosts', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const ghosts = await _findEmptyGhostRows();
    if (ghosts && ghosts._error) return res.json({ success: false, error: ghosts._error });
    if (!ghosts.length) return res.json({ success: true, deleted: 0 });
    const ids = ghosts.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await db.query(
      `DELETE FROM warehouse_stock WHERE id IN (${placeholders})`, ids
    );
    res.json({ success: true, deleted: result.affectedRows || 0 });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// v5.10.19 — Reconcile inv_items.stock and menu.stock against
// SUM(warehouse_stock.qty). Use this once after deploying the
// warehouse-isolation fix to repair any historical drift, and any time you
// suspect the rollups are out of sync with per-warehouse balances.
//
// GET /api/inventory/reconcile-stock?dryRun=1   → returns the drift list
//                                                  without writing anything
// POST /api/inventory/reconcile-stock           → recomputes both rollups
router.get('/reconcile-stock', async (req, res) => {
  try {
    const result = await reconcileAllStock(db, { reportDrift: true });
    res.json({ success: true, dryRun: true, ...result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/reconcile-stock', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const result = await reconcileAllStock(db, { reportDrift: true });
    res.json({ success: true, dryRun: false, ...result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// v5.10.24 — Brand cards summary. Each card now reflects the SUM of its
// warehouses' real numbers (using the same v5.10.23 "real presence" rule:
// qty > 0 OR movement history) — guaranteeing the brand card == the sum
// of the warehouse cards inside, no more "خداع بصري" between the two
// levels. Also acts as a lazy-loading endpoint: a single small payload
// per brand instead of the entire global items list.
router.get('/brands-summary', async (req, res) => {
  try {
    // Per-warehouse stats — same logic as /warehouses-by-brand. We then
    // group by brand_id on the JS side. SUMs match what the inner cards
    // show, so totals are consistent end-to-end.
    const bsc = req.whScopeClause('w.id');
    const [whRows] = await db.query(`
      SELECT w.id AS warehouse_id, w.brand_id, w.is_active,
             (SELECT COUNT(DISTINCT i.id) FROM inv_items i
               WHERE i.active = 1 AND i.deleted_at IS NULL
                 AND (
                   EXISTS(SELECT 1 FROM warehouse_stock ws2 WHERE ws2.item_id = i.id AND ws2.warehouse_id = w.id AND ws2.qty > 0)
                   OR EXISTS(SELECT 1 FROM inventory_movements im WHERE im.item_id = i.id AND im.warehouse_id = w.id)
                 )) AS item_count,
             COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * i.cost ELSE 0 END), 0) AS total_value,
             SUM(CASE WHEN ws.qty > 0 AND ws.qty <= i.min_stock AND i.min_stock > 0 THEN 1 ELSE 0 END) AS low_count,
             SUM(CASE WHEN ws.first_added_date IS NOT NULL AND ws.qty <= 0 THEN 1 ELSE 0 END) AS out_count
      FROM warehouses w
      LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
      LEFT JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL
      WHERE w.is_active = 1` + bsc.sql + `
      GROUP BY w.id`, bsc.params);

    // Roll up per-brand. itemCount sums per-warehouse counts (so brand
    // total = warehouse cards added together — what the user expects
    // visually). Items present in 2 warehouses count twice; that's the
    // intentional read of "stock entries across the brand."
    const byBrand = {};
    whRows.forEach(w => {
      const bid = w.brand_id || '__none__';
      if (!byBrand[bid]) byBrand[bid] = { itemCount: 0, totalValue: 0, lowCount: 0, outCount: 0, warehouseCount: 0 };
      byBrand[bid].itemCount     += Number(w.item_count)   || 0;
      byBrand[bid].totalValue    += Number(w.total_value)  || 0;
      byBrand[bid].lowCount      += Number(w.low_count)    || 0;
      byBrand[bid].outCount      += Number(w.out_count)    || 0;
      byBrand[bid].warehouseCount++;
    });

    const [brands] = await db.query(`SELECT id, name, code, logo FROM brands ORDER BY name`);
    const enriched = brands.map(b => Object.assign({}, b, byBrand[b.id] || {
      itemCount: 0, totalValue: 0, lowCount: 0, outCount: 0, warehouseCount: 0
    }));

    res.json({
      brands: enriched,
      unbranded: byBrand['__none__'] || null,
      totals: {
        items:           enriched.reduce((s, b) => s + (b.itemCount || 0),    (byBrand['__none__'] && byBrand['__none__'].itemCount)    || 0),
        value:           enriched.reduce((s, b) => s + (b.totalValue || 0),   (byBrand['__none__'] && byBrand['__none__'].totalValue)   || 0),
        low:             enriched.reduce((s, b) => s + (b.lowCount || 0),     (byBrand['__none__'] && byBrand['__none__'].lowCount)     || 0),
        warehouseCount:  enriched.reduce((s, b) => s + (b.warehouseCount || 0), (byBrand['__none__'] && byBrand['__none__'].warehouseCount) || 0)
      }
    });
  } catch (e) {
    console.error('[brands-summary]', e);
    res.json({ brands: [], unbranded: null, totals: { items: 0, value: 0, low: 0, warehouseCount: 0 }, error: e.message });
  }
});

// V5.9.0 — Warehouses for a brand, with per-warehouse inventory stats.
// Used by the new "Warehouse Picker" view that sits between the Brand
// Picker and the 6-icon Hub. Each card needs: itemCount, totalValue,
// lowCount, lastActivity.
//
// v5.10.32 — FIX 159-bug: count only items that actually carry stock
// in this warehouse (qty > 0), not items that ever touched it. The
// previous "EVER touched" semantics produced phantom counts where every
// warehouse showed the same number of items because old movement rows
// were enough to qualify.
//
// outCount semantics also tightened: items that the warehouse has
// historically stocked (first_added_date IS NOT NULL) but currently
// have qty = 0 — the meaningful "depleted-but-known" set.
//
// Adds optional ?fromDate&toDate for the lastActivity (the date filter
// only restricts the activity computation, not the stock counts which
// are point-in-time current).
router.get('/warehouses-by-brand', async (req, res) => {
  try {
    const { brandId, fromDate, toDate } = req.query;
    let sql = `
      SELECT w.id, w.name, w.code, w.brand_id, b.name AS brand_name, w.is_main, w.is_active,
             (SELECT COUNT(DISTINCT i.id) FROM inv_items i
                INNER JOIN warehouse_stock ws2
                   ON ws2.item_id = i.id AND ws2.warehouse_id = w.id
               WHERE i.active = 1 AND i.deleted_at IS NULL AND ws2.qty > 0) AS item_count,
             (SELECT COUNT(DISTINCT i.id) FROM inv_items i
                INNER JOIN warehouse_stock ws3
                   ON ws3.item_id = i.id AND ws3.warehouse_id = w.id
               WHERE i.active = 1 AND i.deleted_at IS NULL
                 AND ws3.first_added_date IS NOT NULL
                 AND ws3.qty <= 0) AS out_count_real,
             COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * i.cost ELSE 0 END), 0) AS total_value,
             SUM(CASE WHEN ws.qty > 0 AND ws.qty <= i.min_stock AND i.min_stock > 0 THEN 1 ELSE 0 END) AS low_count
      FROM warehouses w
      LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id AND ws.qty > 0
      LEFT JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL
      LEFT JOIN brands b ON b.id = w.brand_id
      WHERE w.is_active = 1`;
    const params = [];
    if (brandId && brandId !== '__all__') {
      sql += ' AND w.brand_id = ?';
      params.push(brandId);
    }
    const wsc = req.whScopeClause('w.id');
    if (wsc.sql) { sql += wsc.sql; params.push(...wsc.params); }
    sql += ' GROUP BY w.id ORDER BY (w.is_main=1) DESC, w.code ASC';
    const [rows] = await db.query(sql, params);

    // Last-activity per warehouse (date-bounded if requested)
    const movWhere = ['warehouse_id IS NOT NULL'];
    const movParams = [];
    if (fromDate) { movWhere.push('DATE(movement_date) >= ?'); movParams.push(fromDate); }
    if (toDate)   { movWhere.push('DATE(movement_date) <= ?'); movParams.push(toDate); }
    const [lastMov] = await db.query(
      'SELECT warehouse_id, MAX(movement_date) AS last_activity, COUNT(*) AS movement_count ' +
      '  FROM inventory_movements WHERE ' + movWhere.join(' AND ') + ' GROUP BY warehouse_id',
      movParams);
    const activityMap = {};
    const movementCountMap = {};
    lastMov.forEach(m => {
      activityMap[m.warehouse_id] = m.last_activity;
      movementCountMap[m.warehouse_id] = Number(m.movement_count) || 0;
    });
    res.json(rows.map(w => ({
      id: w.id, name: w.name, code: w.code,
      brandId: w.brand_id, brandName: w.brand_name || '',
      isMain: !!w.is_main,
      itemCount: Number(w.item_count) || 0,
      totalValue: Number(w.total_value) || 0,
      lowCount: Number(w.low_count) || 0,
      outCount: Number(w.out_count_real) || 0,
      lastActivity: activityMap[w.id] || null,
      movementCount: movementCountMap[w.id] || 0
    })));
  } catch (e) { res.json({ error: e.message, warehouses: [] }); }
});

// v5.10.32 — Single endpoint that returns all six counters used by the
// section-cards hub (الجرد، المخزون الفعلي، مواد المخزون، طلبات النواقص،
// التحويلات، تعديل كمية) for a single warehouse OR brand. Replaces the
// scattered /api/getAllStocktakes + /api/getAllAdjustments + ad-hoc
// queries in _invHubLoadBadges so every card finally shows accurate,
// scoped, date-filterable numbers.
//
// Query params:
//   warehouseId     — required if scope is single warehouse
//   brandId         — required if scope is brand-wide (no warehouseId)
//   fromDate, toDate — optional; constrain movement-based counts
//
// Response:
//   {
//     scope: { kind, warehouseId?, brandId?, name },
//     items:       { total, lowCount, outCount, totalValue },
//     live:        { movementCount, distinctItems, valueIn, valueOut, netValueChange, lastActivity },
//     stocktake:   { count, lastDate, totalVariance },
//     adjustments: { count, pending, approved, totalCost },
//     transfers:   { incoming, outgoing, draftCount, completedCount },
//     shortage:    { pendingCount, fulfilledCount }
//   }
router.get('/warehouse-card-stats', async (req, res) => {
  try {
    const { warehouseId, brandId, fromDate, toDate } = req.query;
    if (!warehouseId && !brandId) {
      return res.status(400).json({ success:false, error:'warehouseId-or-brandId-required' });
    }
    // Guard BEFORE the existence lookup so a forbidden warehouse is
    // indistinguishable from a non-existent one (rule 9).
    if (warehouseId && !req.guardWh(res, warehouseId)) return;

    // Resolve scope label
    let scope;
    if (warehouseId) {
      const [w] = await db.query('SELECT id, name, code, brand_id FROM warehouses WHERE id = ?', [warehouseId]);
      if (!w.length) return res.status(404).json({ success:false, error:'warehouse-not-found' });
      scope = { kind:'warehouse', warehouseId: w[0].id, name: w[0].name, code: w[0].code, brandId: w[0].brand_id || null };
    } else {
      const [b] = await db.query('SELECT id, name FROM brands WHERE id = ?', [brandId]);
      scope = { kind:'brand', brandId, name: b.length ? b[0].name : brandId };
    }

    // Helper: scope predicate for movement-based queries
    const movFilter = warehouseId
      ? { sql: 'm.warehouse_id = ?', params: [warehouseId] }
      : { sql: 'EXISTS(SELECT 1 FROM warehouses w WHERE w.id = m.warehouse_id AND w.brand_id = ?)', params: [brandId] };
    const dateConds = [];
    const dateParams = [];
    if (fromDate) { dateConds.push('DATE(m.movement_date) >= ?'); dateParams.push(fromDate); }
    if (toDate)   { dateConds.push('DATE(m.movement_date) <= ?'); dateParams.push(toDate); }
    const dateClause = dateConds.length ? (' AND ' + dateConds.join(' AND ')) : '';

    // (1) Items panel — point-in-time, NOT date-bounded
    let itemsTotal = 0, itemsLow = 0, itemsOut = 0, itemsValue = 0;
    if (warehouseId) {
      const [r] = await db.query(`
        SELECT COUNT(DISTINCT i.id) AS total,
               COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * i.cost ELSE 0 END), 0) AS total_value,
               SUM(CASE WHEN ws.qty > 0 AND ws.qty <= i.min_stock AND i.min_stock > 0 THEN 1 ELSE 0 END) AS low_count,
               SUM(CASE WHEN ws.qty <= 0 AND ws.first_added_date IS NOT NULL THEN 1 ELSE 0 END) AS out_count
          FROM warehouse_stock ws
          JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL
         WHERE ws.warehouse_id = ?`, [warehouseId]);
      const row = r[0] || {};
      itemsTotal = Number(row.total) || 0;
      itemsLow   = Number(row.low_count) || 0;
      itemsOut   = Number(row.out_count) || 0;
      itemsValue = Number(row.total_value) || 0;
    } else {
      // brand-wide: aggregate across warehouses of this brand
      const [r] = await db.query(`
        SELECT COUNT(DISTINCT i.id) AS total,
               COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * i.cost ELSE 0 END), 0) AS total_value,
               SUM(CASE WHEN ws.qty > 0 AND ws.qty <= i.min_stock AND i.min_stock > 0 THEN 1 ELSE 0 END) AS low_count,
               SUM(CASE WHEN ws.qty <= 0 AND ws.first_added_date IS NOT NULL THEN 1 ELSE 0 END) AS out_count
          FROM warehouse_stock ws
          JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL
          JOIN warehouses w ON w.id = ws.warehouse_id
         WHERE w.brand_id = ?`, [brandId]);
      const row = r[0] || {};
      itemsTotal = Number(row.total) || 0;
      itemsLow   = Number(row.low_count) || 0;
      itemsOut   = Number(row.out_count) || 0;
      itemsValue = Number(row.total_value) || 0;
    }

    // (2) Live (movement) panel — date-bounded
    let live = { movementCount: 0, distinctItems: 0, valueIn: 0, valueOut: 0, netValueChange: 0, lastActivity: null };
    try {
      const [r] = await db.query(
        `SELECT COUNT(*) AS movement_count,
                COUNT(DISTINCT m.item_id) AS distinct_items,
                MAX(m.movement_date) AS last_activity,
                SUM(CASE WHEN m.type='in'  THEN m.qty * COALESCE(i.cost,0) ELSE 0 END) AS value_in,
                SUM(CASE WHEN m.type='out' THEN m.qty * COALESCE(i.cost,0) ELSE 0 END) AS value_out
           FROM inventory_movements m
           LEFT JOIN inv_items i ON i.id = m.item_id
          WHERE ` + movFilter.sql + dateClause,
        movFilter.params.concat(dateParams));
      const row = r[0] || {};
      live.movementCount   = Number(row.movement_count) || 0;
      live.distinctItems   = Number(row.distinct_items) || 0;
      live.valueIn         = Number(row.value_in) || 0;
      live.valueOut        = Number(row.value_out) || 0;
      live.netValueChange  = live.valueIn - live.valueOut;
      live.lastActivity    = row.last_activity || null;
    } catch(_){}

    // (3) Stocktake panel
    let stocktake = { count: 0, lastDate: null, totalVariance: 0, pending: 0 };
    try {
      const stWhere = [];
      const stParams = [];
      if (warehouseId) { stWhere.push('s.warehouse_id = ?'); stParams.push(warehouseId); }
      else { stWhere.push('EXISTS(SELECT 1 FROM warehouses w WHERE w.id = s.warehouse_id AND w.brand_id = ?)'); stParams.push(brandId); }
      if (fromDate) { stWhere.push('DATE(s.stocktake_date) >= ?'); stParams.push(fromDate); }
      if (toDate)   { stWhere.push('DATE(s.stocktake_date) <= ?'); stParams.push(toDate); }
      const [r] = await db.query(
        'SELECT COUNT(*) AS cnt, MAX(s.stocktake_date) AS last_date, ' +
        '       SUM(s.total_variance) AS total_var, ' +
        "       SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END) AS pending_cnt " +
        '  FROM stocktakes s WHERE ' + stWhere.join(' AND '),
        stParams);
      const row = r[0] || {};
      stocktake.count         = Number(row.cnt) || 0;
      stocktake.lastDate      = row.last_date || null;
      stocktake.totalVariance = Number(row.total_var) || 0;
      stocktake.pending       = Number(row.pending_cnt) || 0;
    } catch(_){}

    // (4) Adjustments panel
    let adjustments = { count: 0, pending: 0, approved: 0, totalCost: 0 };
    try {
      const aWhere = [];
      const aParams = [];
      if (warehouseId) { aWhere.push('a.warehouse_id = ?'); aParams.push(warehouseId); }
      else { aWhere.push('EXISTS(SELECT 1 FROM warehouses w WHERE w.id = a.warehouse_id AND w.brand_id = ?)'); aParams.push(brandId); }
      if (fromDate) { aWhere.push('DATE(a.adjustment_date) >= ?'); aParams.push(fromDate); }
      if (toDate)   { aWhere.push('DATE(a.adjustment_date) <= ?'); aParams.push(toDate); }
      const [r] = await db.query(
        'SELECT COUNT(*) AS cnt, ' +
        "       SUM(CASE WHEN a.status='pending'  THEN 1 ELSE 0 END) AS pending_cnt, " +
        "       SUM(CASE WHEN a.status='approved' THEN 1 ELSE 0 END) AS approved_cnt, " +
        '       SUM(a.total_cost) AS total_cost ' +
        '  FROM stock_adjustments a WHERE ' + aWhere.join(' AND '),
        aParams);
      const row = r[0] || {};
      adjustments.count     = Number(row.cnt) || 0;
      adjustments.pending   = Number(row.pending_cnt) || 0;
      adjustments.approved  = Number(row.approved_cnt) || 0;
      adjustments.totalCost = Number(row.total_cost) || 0;
    } catch(_){}

    // (5) Transfers panel — incoming + outgoing
    let transfers = { incoming: 0, outgoing: 0, draftCount: 0, completedCount: 0 };
    try {
      const tWhere = [];
      const tParams = [];
      if (warehouseId) {
        tWhere.push('(t.from_warehouse_id = ? OR t.to_warehouse_id = ?)');
        tParams.push(warehouseId, warehouseId);
      } else {
        tWhere.push('EXISTS(SELECT 1 FROM warehouses w WHERE (w.id = t.from_warehouse_id OR w.id = t.to_warehouse_id) AND w.brand_id = ?)');
        tParams.push(brandId);
      }
      if (fromDate) { tWhere.push('DATE(t.transfer_date) >= ?'); tParams.push(fromDate); }
      if (toDate)   { tWhere.push('DATE(t.transfer_date) <= ?'); tParams.push(toDate); }
      const sqlBase = 'FROM warehouse_transfers t WHERE ' + tWhere.join(' AND ');
      const [r] = await db.query(
        'SELECT ' +
          (warehouseId
            ? 'SUM(CASE WHEN t.to_warehouse_id = ? THEN 1 ELSE 0 END) AS incoming, ' +
              'SUM(CASE WHEN t.from_warehouse_id = ? THEN 1 ELSE 0 END) AS outgoing, '
            : 'COUNT(*) AS incoming, 0 AS outgoing, ') +
          "SUM(CASE WHEN t.status='draft' THEN 1 ELSE 0 END) AS draft_cnt, " +
          "SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed_cnt " +
        sqlBase,
        warehouseId ? [warehouseId, warehouseId].concat(tParams) : tParams);
      const row = r[0] || {};
      transfers.incoming        = Number(row.incoming) || 0;
      transfers.outgoing        = Number(row.outgoing) || 0;
      transfers.draftCount      = Number(row.draft_cnt) || 0;
      transfers.completedCount  = Number(row.completed_cnt) || 0;
    } catch(_){}

    // (6) Shortage panel — best-effort, the table may not exist on stale deploys
    let shortage = { pendingCount: 0, fulfilledCount: 0 };
    try {
      const sWhere = [];
      const sParams = [];
      if (warehouseId) { sWhere.push('warehouse_id = ?'); sParams.push(warehouseId); }
      else if (brandId) { sWhere.push('EXISTS(SELECT 1 FROM warehouses w WHERE w.id = warehouse_id AND w.brand_id = ?)'); sParams.push(brandId); }
      if (fromDate) { sWhere.push('DATE(request_date) >= ?'); sParams.push(fromDate); }
      if (toDate)   { sWhere.push('DATE(request_date) <= ?'); sParams.push(toDate); }
      const whereSql = sWhere.length ? (' WHERE ' + sWhere.join(' AND ')) : '';
      const [r] = await db.query(
        'SELECT ' +
          "SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending_cnt, " +
          "SUM(CASE WHEN status='fulfilled' THEN 1 ELSE 0 END) AS fulfilled_cnt " +
        'FROM shortage_requests' + whereSql,
        sParams);
      const row = r[0] || {};
      shortage.pendingCount   = Number(row.pending_cnt) || 0;
      shortage.fulfilledCount = Number(row.fulfilled_cnt) || 0;
    } catch(_){ /* table missing on older deploys */ }

    res.json({
      success: true,
      scope,
      items: { total: itemsTotal, lowCount: itemsLow, outCount: itemsOut, totalValue: itemsValue },
      live, stocktake, adjustments, transfers, shortage
    });
  } catch (e) {
    res.status(500).json({ success:false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2A — READ-ONLY endpoints for the React warehouse-v2 app.
//   These ADD nothing destructive: pure SELECTs, no writes, no change to any
//   existing endpoint. They fill three gaps the legacy endpoints could not
//   serve without N+1 calls or with a misleading global cost:
//     • warehouses-summary — every warehouse's value/qty/alerts in ONE query
//       (warehouse-card-stats is single-warehouse only → N+1).
//     • dashboard-summary  — the whole command-center payload in one call.
//     • grid               — a paginated, sortable, filterable inventory grid
//       valued at the WAREHOUSE WAC (warehouse_stock.avg_cost), not the global
//       inv_items.cost the legacy reports use.
//   All value math uses COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0) so the
//   warehouse WAC wins and only falls back to the global cost when unknown.
// ═══════════════════════════════════════════════════════════════════════

// Shared per-warehouse aggregation (one GROUP BY + one last-movement query).
// `req` (optional) carries the warehouse scope: when enforced, only the
// caller's warehouses are aggregated (rules 1 & 5 — totals exclude forbidden
// warehouses), so this is safe to expose unscoped (?warehouseId omitted).
async function _warehousesSummary(conn, warehouseId, req) {
  const params = [];
  const where = [];
  if (warehouseId) { where.push('w.id = ?'); params.push(warehouseId); }
  const sc = req && req.whScopeClause ? req.whScopeClause('w.id') : { sql: '', params: [] };
  if (sc.sql) { where.push(sc.sql.replace(/^\s*AND\s+/i, '')); params.push(...sc.params); }
  const whereWh = where.length ? (' WHERE ' + where.join(' AND ')) : '';
  const [rows] = await conn.query(
    // Every aggregate is gated on `i.id IS NOT NULL` (i.e. the item passed the
    // active/non-deleted filter on the JOIN) so the totals count ONLY active
    // items — matching item_count and the /grid endpoint exactly. Without this
    // gate, an inactive/deleted item's leftover warehouse_stock would inflate
    // total_qty/value while never appearing in item_count or the grid.
    `SELECT w.id, w.name, w.code, w.type, w.location, w.manager, w.is_active,
            COUNT(DISTINCT i.id) AS item_count,
            COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0 THEN ws.qty ELSE 0 END), 0) AS total_qty,
            COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0
                              THEN ws.qty * COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0)
                              ELSE 0 END), 0) AS total_value,
            SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0 AND i.min_stock > 0 AND ws.qty <= i.min_stock THEN 1 ELSE 0 END) AS low_count,
            SUM(CASE WHEN i.id IS NOT NULL AND ws.qty = 0 AND ws.first_added_date IS NOT NULL THEN 1 ELSE 0 END) AS out_count,
            SUM(CASE WHEN i.id IS NOT NULL AND ws.qty < 0 THEN 1 ELSE 0 END) AS negative_count
       FROM warehouses w
       LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
       LEFT JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL
       ${whereWh}
      GROUP BY w.id, w.name, w.code, w.type, w.location, w.manager, w.is_active
      ORDER BY w.is_main DESC, w.code`, params);

  // Last movement per warehouse — one extra query, NOT per-warehouse N+1.
  const lastMap = {};
  try {
    const lp = [];
    const lwhere = [];
    if (warehouseId) { lwhere.push('warehouse_id = ?'); lp.push(warehouseId); }
    const lsc = req && req.whScopeClause ? req.whScopeClause('warehouse_id') : { sql: '', params: [] };
    if (lsc.sql) { lwhere.push(lsc.sql.replace(/^\s*AND\s+/i, '')); lp.push(...lsc.params); }
    let lq = 'SELECT warehouse_id, MAX(movement_date) AS last_movement FROM inventory_movements';
    if (lwhere.length) lq += ' WHERE ' + lwhere.join(' AND ');
    lq += ' GROUP BY warehouse_id';
    const [lrows] = await conn.query(lq, lp);
    lrows.forEach(r => { lastMap[String(r.warehouse_id)] = r.last_movement; });
  } catch (_) { /* movements table variant — last movement stays null */ }

  const warehouses = rows.map(r => {
    const dto = INV.mapWarehouseRow(r);
    dto.lastMovementAt = lastMap[dto.id] || null;
    return dto;
  });
  return { warehouses, totals: INV.summarizeWarehouses(warehouses) };
}

// GET /api/inventory/warehouses-summary?warehouseId=
//   Every (or one) warehouse with value/qty/alerts + grand totals.
router.get('/warehouses-summary', async (req, res) => {
  try {
    const warehouseId = req.query.warehouseId || null;
    if (warehouseId && !req.guardWh(res, warehouseId)) return;
    const data = await _warehousesSummary(db, warehouseId, req);
    res.json({ success: true, scope: { warehouseId: warehouseId || null }, ...data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/inventory/dashboard-summary?warehouseId=
//   The whole command-center payload in ONE call (no N+1).
router.get('/dashboard-summary', async (req, res) => {
  try {
    const warehouseId = req.query.warehouseId || null;
    if (warehouseId && !req.guardWh(res, warehouseId)) return;
    const wh = await _warehousesSummary(db, warehouseId, req);
    const t = wh.totals;
    const kpis = {
      inventoryValue: t.totalValue,
      itemCount: t.itemCount,
      lowCount: t.lowCount,
      outCount: t.outCount,
      negativeCount: t.negativeCount,
      activeWarehouses: t.activeCount,
    };

    // Transfers — pending vs in-transit from stock_issues (scoped by from/to).
    let transfers = { pending: 0, inTransit: 0, byStatus: {} };
    try {
      const tp = [];
      const tconds = [];
      if (warehouseId) {
        tconds.push('(from_warehouse_id = ? OR to_warehouse_id = ?)'); tp.push(warehouseId, warehouseId);
      } else {
        const sf = req.whScopeClause('from_warehouse_id');
        const st = req.whScopeClause('to_warehouse_id');
        if (sf.sql) {
          tconds.push('(' + sf.sql.replace(/^\s*AND\s+/i, '') + ' OR ' + st.sql.replace(/^\s*AND\s+/i, '') + ')');
          tp.push(...sf.params, ...st.params);
        }
      }
      let tq = 'SELECT status, COUNT(*) AS n FROM stock_issues';
      if (tconds.length) tq += ' WHERE ' + tconds.join(' AND ');
      tq += ' GROUP BY status';
      const [trows] = await db.query(tq, tp);
      transfers = INV.transferCounts(trows);
    } catch (_) { /* stock_issues absent on stale deploys */ }

    // Recent movements (top 8), scoped.
    let recentMovements = [];
    try {
      const mp = [];
      const mconds = [];
      if (warehouseId) { mconds.push('m.warehouse_id = ?'); mp.push(warehouseId); }
      else { const sm = req.whScopeClause('m.warehouse_id'); if (sm.sql) { mconds.push(sm.sql.replace(/^\s*AND\s+/i, '')); mp.push(...sm.params); } }
      let mq = 'SELECT m.id, m.movement_date, m.item_id, m.item_name, m.type, m.qty, m.reason, ' +
               '       m.warehouse_id, w.name AS warehouse_name ' +
               '  FROM inventory_movements m LEFT JOIN warehouses w ON w.id = m.warehouse_id';
      if (mconds.length) mq += ' WHERE ' + mconds.join(' AND ');
      mq += ' ORDER BY m.movement_date DESC, m.id DESC LIMIT 8';
      const [mrows] = await db.query(mq, mp);
      recentMovements = mrows.map(m => ({
        id: m.id, date: m.movement_date, itemId: m.item_id, itemName: m.item_name,
        type: m.type, qty: Number(m.qty) || 0, reason: m.reason,
        warehouseId: m.warehouse_id || '', warehouseName: m.warehouse_name || ''
      }));
    } catch (_) {}

    // Expiry within 30 days — best effort (purchase_lots may be absent).
    let expiry = { available: false, count: 0, atRiskValue: 0, days: 30 };
    try {
      const ep = [];
      let eqx = 'SELECT COUNT(*) AS cnt, COALESCE(SUM(pl.qty_remaining * pl.unit_cost),0) AS at_risk ' +
                '  FROM purchase_lots pl ' +
                ' WHERE pl.expiry_date IS NOT NULL AND pl.qty_remaining > 0 ' +
                '   AND pl.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)';
      if (warehouseId) { eqx += ' AND pl.warehouse_id = ?'; ep.push(warehouseId); }
      else { const se = req.whScopeClause('pl.warehouse_id'); if (se.sql) { eqx += se.sql; ep.push(...se.params); } }
      const [erows] = await db.query(eqx, ep);
      expiry = { available: true, count: Number(erows[0].cnt) || 0, atRiskValue: Number(erows[0].at_risk) || 0, days: 30 };
    } catch (_) { /* purchase_lots absent */ }

    res.json({
      success: true,
      scope: { warehouseId: warehouseId || null },
      kpis, transfers, warehouses: wh.warehouses, recentMovements, expiry,
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/inventory/grid?warehouseId=&q=&category=&status=&page=&pageSize=&sort=&dir=
//   Paginated inventory grid valued at warehouse WAC. Sort columns are
//   WHITELISTED in lib/inventoryReporting.normalizeGridQuery (no SQL injection).
router.get('/grid', async (req, res) => {
  try {
    const opt = INV.normalizeGridQuery(req.query);
    if (opt.warehouseId && !req.guardWh(res, opt.warehouseId)) return;
    const where = ['i.active = 1', 'i.deleted_at IS NULL'];
    const params = [];
    if (opt.warehouseId) { where.push('ws.warehouse_id = ?'); params.push(opt.warehouseId); }
    // Scope: restrict rows (and therefore the count/pagination total) to the
    // caller's warehouses when no explicit warehouse is requested (rules 3 & 5).
    const gsc = req.whScopeClause('ws.warehouse_id');
    if (gsc.sql) { where.push(gsc.sql.replace(/^\s*AND\s+/i, '')); params.push(...gsc.params); }
    if (opt.category)    { where.push('i.category = ?'); params.push(opt.category); }
    if (opt.q)           { where.push('(i.name LIKE ? OR i.id LIKE ?)'); params.push('%' + opt.q + '%', '%' + opt.q + '%'); }
    const statusSql = INV.statusFilterSql(opt.status);
    if (statusSql) where.push(statusSql);

    const whereSql = ' WHERE ' + where.join(' AND ');
    const fromSql =
      ' FROM warehouse_stock ws ' +
      ' JOIN inv_items i ON i.id = ws.item_id ' +
      ' JOIN warehouses w ON w.id = ws.warehouse_id';

    const [cntRows] = await db.query('SELECT COUNT(*) AS total' + fromSql + whereSql, params);
    const total = Number((cntRows[0] || {}).total) || 0;

    const selectSql =
      'SELECT i.id AS item_id, i.name, i.category, i.unit, i.min_stock, i.cost AS global_cost, ' +
      '       ws.qty, ws.avg_cost, ' +
      '       w.id AS warehouse_id, w.name AS warehouse_name, w.code AS warehouse_code, ' +
      '       COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0) AS eff_cost, ' +
      '       (CASE WHEN ws.qty > 0 THEN ws.qty * COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0) ELSE 0 END) AS line_value, ' +
      '       (SELECT MAX(im.movement_date) FROM inventory_movements im ' +
      '          WHERE im.item_id = i.id AND im.warehouse_id = ws.warehouse_id) AS last_movement';
    // opt.sortColumn + opt.dir are whitelisted constants — safe to interpolate.
    const orderSql = ' ORDER BY ' + opt.sortColumn + ' ' + opt.dir + ', i.name ASC';
    const [rows] = await db.query(
      selectSql + fromSql + whereSql + orderSql + ' LIMIT ? OFFSET ?',
      params.concat([opt.limit, opt.offset]));

    res.json({
      success: true,
      rows: rows.map(INV.mapGridRow),
      total,
      page: opt.page,
      pageSize: opt.pageSize,
      totalPages: Math.max(1, Math.ceil(total / opt.pageSize)),
      sort: opt.sort,
      dir: opt.dir,
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/inventory/categories?warehouseId=
//   Distinct categories (optionally limited to items present in one warehouse)
//   — powers the inventory grid's category filter.
router.get('/categories', async (req, res) => {
  try {
    const { warehouseId } = req.query;
    let sql, params = [];
    if (warehouseId) {
      if (!req.guardWh(res, warehouseId)) return;
      sql = `SELECT DISTINCT i.category AS category
               FROM inv_items i
               JOIN warehouse_stock ws ON ws.item_id = i.id AND ws.warehouse_id = ?
              WHERE i.active = 1 AND i.deleted_at IS NULL AND i.category IS NOT NULL AND i.category <> ''
              ORDER BY i.category`;
      params = [warehouseId];
    } else {
      // No explicit warehouse → when enforced, limit categories to items present
      // in the caller's warehouses (rule 5); otherwise the legacy global list.
      const csc = req.whScopeClause('ws.warehouse_id');
      if (csc.sql) {
        sql = `SELECT DISTINCT i.category AS category
                 FROM inv_items i
                 JOIN warehouse_stock ws ON ws.item_id = i.id
                WHERE i.active = 1 AND i.deleted_at IS NULL AND i.category IS NOT NULL AND i.category <> ''`
              + csc.sql + ` ORDER BY i.category`;
        params = csc.params.slice();
      } else {
        sql = `SELECT DISTINCT category FROM inv_items
                WHERE active = 1 AND deleted_at IS NULL AND category IS NOT NULL AND category <> ''
                ORDER BY category`;
      }
    }
    const [rows] = await db.query(sql, params);
    res.json({ success: true, categories: rows.map(r => String(r.category)) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/inventory/access-scope
//   Phase 2A.2 — the React app's bootstrap for warehouse access control. Returns
//   ONLY the caller's accessible warehouses (never lists a forbidden one) plus
//   the role capability map. req.warehouseScope is set by the scope middleware.
router.get('/access-scope', async (req, res) => {
  try {
    const scope = req.warehouseScope || { all: true, warehouseIds: [] };
    let warehouses = [];
    if (scope.all) {
      const [rows] = await db.query(
        "SELECT id, name, code, type, branch_id, is_active FROM warehouses WHERE is_active = 1 ORDER BY is_main DESC, code");
      warehouses = rows;
    } else if (scope.warehouseIds.length) {
      const ph = scope.warehouseIds.map(() => '?').join(',');
      const [rows] = await db.query(
        "SELECT id, name, code, type, branch_id, is_active FROM warehouses WHERE id IN (" + ph + ") ORDER BY is_main DESC, code",
        scope.warehouseIds);
      warehouses = rows;
    }
    const reportCapabilities = await _reportCapabilitiesFor(req.user);
    res.json({
      success: true,
      enforced: WH_SCOPE.isEnforced(),
      role: String((req.user && req.user.role) || '').toLowerCase() || 'cashier',
      allWarehousesAccess: !!scope.all,
      accessibleWarehouses: warehouses.map(w => ({
        id: w.id, name: w.name, code: w.code, type: w.type,
        branchId: w.branch_id || '', isActive: w.is_active === 1 || w.is_active === true,
      })),
      capabilities: { ..._capabilitiesFor(req.user), ...reportCapabilities },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// V5.9.1 — Items, optionally expanded per-warehouse.
//   Default: ?brandId → one row per item, global stock (legacy back-compat).
//   ?warehouseId       → one row per item visible in this brand, with the
//                        warehouse's stock (qty=0 if not stocked there yet).
//                        Items WITHOUT a warehouse_stock entry are returned
//                        with qty=0 so the user can see what's available to
//                        transfer/stock — they don't disappear.
//   ?expandWarehouses=1 → one row per (item × warehouse_stock entry).
// v7.4 (F1) — Low-stock & out-of-stock report. The dashboards already compute a
// low_count but never listed WHICH items; this returns the actual at/under-min
// lines so managers can reorder proactively, with a suggested reorder qty/value.
// Optional ?warehouseId= and ?brandId= filters.
router.get('/low-stock', async (req, res) => {
  try {
    const { warehouseId, brandId } = req.query;
    const where = ['i.active = 1', 'i.deleted_at IS NULL', 'i.min_stock > 0', 'ws.qty <= i.min_stock'];
    const params = [];
    if (warehouseId) { if (!req.guardWh(res, warehouseId)) return; where.push('ws.warehouse_id = ?'); params.push(warehouseId); }
    if (brandId)     { where.push('i.brand_id = ?');      params.push(brandId); }
    const lsc = req.whScopeClause('ws.warehouse_id');
    if (lsc.sql) { where.push(lsc.sql.replace(/^\s*AND\s+/i, '')); params.push(...lsc.params); }
    const [rows] = await db.query(
      `SELECT i.id AS item_id, i.name, i.category, i.unit,
              ws.warehouse_id, w.name AS warehouse_name,
              ws.qty, i.min_stock, i.cost,
              GREATEST(i.min_stock - ws.qty, 0) AS reorder_qty,
              CASE WHEN ws.qty <= 0 THEN 'out' ELSE 'low' END AS severity
         FROM warehouse_stock ws
         JOIN inv_items i  ON i.id = ws.item_id
         LEFT JOIN warehouses w ON w.id = ws.warehouse_id
        WHERE ${where.join(' AND ')}
        ORDER BY (ws.qty <= 0) DESC, (i.min_stock - ws.qty) DESC
        LIMIT 500`, params);
    const items = rows.map(r => ({
      itemId: r.item_id, name: r.name, category: r.category, unit: r.unit,
      warehouseId: r.warehouse_id, warehouseName: r.warehouse_name,
      qty: Number(r.qty), minStock: Number(r.min_stock), cost: Number(r.cost),
      reorderQty: Number(r.reorder_qty),
      reorderValue: Math.round(Number(r.reorder_qty) * Number(r.cost) * 100) / 100,
      severity: r.severity
    }));
    res.json({
      success: true,
      count: items.length,
      outCount: items.filter(i => i.severity === 'out').length,
      lowCount: items.filter(i => i.severity === 'low').length,
      totalReorderValue: Math.round(items.reduce((s, i) => s + i.reorderValue, 0) * 100) / 100,
      items
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/items', async (req, res) => {
  try {
    // v5.10.6 — DISABLED auto-backfill on read. The previous behavior
    // auto-inserted every brand item into the brand's main warehouse on
    // every GET, which made the main warehouse appear to hold the entire
    // brand catalog even when only 2 items had actually been transferred
    // there (root cause of the bug the user reported).
    //
    // Items now only appear in a warehouse when explicitly added via
    // POST /inventory/warehouses/:id/items, transferred via stock-issues,
    // or counted via stocktakes. Use POST /inventory/admin/backfill-stock
    // for a one-shot manual rebuild if needed.
    const { brandId, warehouseId, expandWarehouses } = req.query;

    if (warehouseId) {
      if (!req.guardWh(res, warehouseId)) return;
      // v5.10.12 — Each warehouse is an independent entity. It shows
      // ONLY items that have touched it via either:
      //   (a) a warehouse_stock row (registered)
      //   (b) any inventory_movements record (transferred / counted /
      //       consumed historically — shown with qty=0 if depleted)
      // The brand catalog is intentionally NOT auto-included anymore:
      // the user explicitly asked for "transfer 2 → main warehouse
      // shows 2", not "main warehouse shows all 159 brand items".
      let sql = `
        SELECT i.*, b.name AS brand_name,
               w.id AS wh_id, w.name AS wh_name, w.code AS wh_code,
               COALESCE(ws.qty, 0)         AS wh_stock,
               COALESCE(ws.avg_cost, 0)    AS wh_avg_cost,
               COALESCE(ws.last_cost, 0)   AS wh_last_cost,
               ws.added_at                 AS wh_added_at,
               ws.first_added_date         AS wh_first_added,
               ws.last_updated             AS wh_last_updated,
               (ws.id IS NOT NULL)         AS is_registered,
               EXISTS(SELECT 1 FROM inventory_movements im
                      WHERE im.item_id = i.id AND im.warehouse_id = w.id) AS has_history
        FROM inv_items i
        JOIN warehouses w ON w.id = ?
        LEFT JOIN warehouse_stock ws
               ON ws.item_id = i.id AND ws.warehouse_id = w.id
        LEFT JOIN brands b ON b.id = i.brand_id
        WHERE i.active = 1
          AND (i.deleted_at IS NULL)
          AND (
            -- v5.10.23 — TRUE per-warehouse independence: an item belongs to
            -- this warehouse only if it has REAL presence here. A
            -- warehouse_stock row alone is no longer enough (legacy backfills
            -- left ghost qty=0 rows that made every warehouse look identical).
            -- Real presence = NON-ZERO stock (positive OR negative deficit) OR
            -- any movement history. v7.1 — was qty > 0, which HID negative
            -- balances (a real shortage in an over-sold/empty warehouse). Using
            -- <> 0 surfaces deficits while still suppressing ghost qty=0 rows.
            --
            -- v7.2 forIssue mode: stock-issue pickers need ALL registered items
            -- regardless of current qty (items with qty=0 are valid to issue since
            -- we support negative stock). Use ws.id IS NOT NULL instead of <> 0
            -- so depleted-but-registered items appear in the picker.
            ${req.query.forIssue === '1' ? 'ws.id IS NOT NULL' : 'ws.qty <> 0'}
            OR EXISTS(SELECT 1 FROM inventory_movements im2
                      WHERE im2.item_id = i.id AND im2.warehouse_id = w.id)
          )`;
      const params = [warehouseId];
      if (brandId) { sql += ' AND i.brand_id = ?'; params.push(brandId); }
      sql += ' ORDER BY i.category, i.name';
      const [rows] = await db.query(sql, params);
      return res.json(rows.map(i => ({
        id: i.id, name: i.name, category: i.category,
        // v5.16.0 — 'raw' (default) or 'semi' for semi-finished products.
        kind: i.kind || 'raw',
        cost: Number(i.cost),
        stock: Number(i.wh_stock) || 0,
        globalStock: Number(i.stock) || 0,
        minStock: Number(i.min_stock),
        unit: i.unit, bigUnit: i.big_unit, convRate: Number(i.conv_rate), active: i.active,
        brandId: i.brand_id || '', brand_id: i.brand_id || '',
        brandName: i.brand_name || '',
        warehouseId: i.wh_id || warehouseId,
        warehouseName: i.wh_name || '',
        warehouseCode: i.wh_code || '',
        // v5.10.6 historical context
        whAvgCost: Number(i.wh_avg_cost) || 0,
        whLastCost: Number(i.wh_last_cost) || 0,
        addedAt: i.wh_added_at || null,
        firstAddedDate: i.wh_first_added || null,
        lastUpdated: i.wh_last_updated || null,
        // v5.10.10 — true if a warehouse_stock row exists; false means
        // it's a candidate brand item not yet registered in this warehouse
        isRegistered: !!Number(i.is_registered),
        // v5.10.11 — true if any movement record exists for this
        // (item, warehouse) pair. Lets the UI show a different badge
        // for "had history but no longer registered" (transferred and
        // consumed) vs "candidate from brand catalog".
        hasHistory: !!Number(i.has_history)
      })));
    }

    if (expandWarehouses === '1') {
      // One row per (item × warehouse_stock entry).  Items with NO entry
      //   get one fallback row (warehouse=null, qty=0) so they're visible.
      let sql = `
        SELECT i.*, b.name AS brand_name,
               w.id AS wh_id, w.name AS wh_name, w.code AS wh_code,
               COALESCE(ws.qty, 0) AS wh_stock
        FROM inv_items i
        LEFT JOIN brands b ON b.id = i.brand_id
        LEFT JOIN warehouse_stock ws ON ws.item_id = i.id
        LEFT JOIN warehouses w ON w.id = ws.warehouse_id
        WHERE i.active = 1`;
      const params = [];
      if (brandId) { sql += ' AND i.brand_id = ?'; params.push(brandId); }
      sql += ' ORDER BY i.category, i.name, w.code';
      const [rows] = await db.query(sql, params);
      return res.json(rows.map(i => ({
        id: i.id, name: i.name, category: i.category,
        kind: i.kind || 'raw',  // v5.16.0
        cost: Number(i.cost),
        stock: Number(i.wh_stock) || 0,
        globalStock: Number(i.stock) || 0,
        minStock: Number(i.min_stock),
        unit: i.unit, bigUnit: i.big_unit, convRate: Number(i.conv_rate), active: i.active,
        brandId: i.brand_id || '', brand_id: i.brand_id || '',
        brandName: i.brand_name || '',
        warehouseId: i.wh_id || '',
        warehouseName: i.wh_name || '',
        warehouseCode: i.wh_code || ''
      })));
    }

    // Legacy: one row per item, global stock
    let sql = 'SELECT i.*, b.name AS brand_name FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id';
    const params = [];
    if (brandId) { sql += ' WHERE i.brand_id = ?'; params.push(brandId); }
    sql += ' ORDER BY i.category, i.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(i => ({
      id: i.id, name: i.name, category: i.category,
      kind: i.kind || 'raw',  // v5.16.0
      cost: Number(i.cost), stock: Number(i.stock), minStock: Number(i.min_stock),
      unit: i.unit, bigUnit: i.big_unit, convRate: Number(i.conv_rate), active: i.active,
      brandId: i.brand_id || '', brand_id: i.brand_id || '', brandName: i.brand_name || ''
    })));
  } catch (e) {
    // G-INV M3 — a DB failure is a 500, not a silent empty list.
    console.error('[inventory /items]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// V5.9.0 — Per-item warehouse distribution (drill-down popup data).
//   GET /inventory/items/:itemId/warehouses → which warehouses have this
//   item, with the qty in each.
router.get('/items/:itemId/warehouses', async (req, res) => {
  try {
    // Scope: a forbidden warehouse must never appear in an item's distribution
    // (rule 9). When not enforced, dsc.sql is '' → legacy full distribution.
    const dsc = req.whScopeClause('w.id');
    const [rows] = await db.query(`
      SELECT w.id, w.name, w.code, w.is_main,
             b.name AS brand_name,
             COALESCE(ws.qty, 0) AS qty,
             i.cost
      FROM warehouse_stock ws
      JOIN warehouses w ON w.id = ws.warehouse_id
      JOIN inv_items i ON i.id = ws.item_id
      LEFT JOIN brands b ON b.id = w.brand_id
      WHERE ws.item_id = ? AND w.is_active = 1` + dsc.sql + `
      ORDER BY (w.is_main=1) DESC, w.code ASC`, [req.params.itemId].concat(dsc.params));
    res.json(rows.map(r => ({
      warehouseId: r.id, warehouseName: r.name, warehouseCode: r.code,
      isMain: !!r.is_main,
      brandName: r.brand_name || '',
      qty: Number(r.qty) || 0,
      value: (Number(r.qty) || 0) * (Number(r.cost) || 0)
    })));
  } catch (e) {
    // G-INV M3 — a DB failure is a 500, not a silent empty distribution.
    console.error('[inventory /items/:itemId/warehouses]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Save inventory item (insert or update)
// v5.10.28 — Hardened:
//   • New items REQUIRE a warehouseId (closes the gap commit 92dd8be left
//     in the frontend only). Without it we'd create orphan inv_items rows
//     with no warehouse_stock counterpart.
//   • Returns proper 4xx codes instead of 200 + {success:false}.
//   • Validates numeric ranges (cost>=0, convRate>0, minStock>=0).
//   • Rejects duplicate (name, brand_id) pairs with 409 Conflict.
//   • Writes an audit_log row for every successful insert/update.
// v5.16.0 — One-shot migration: copy every semi-finished menu item into
// inv_items with kind='semi'. Mirrors current menu.stock to warehouse_stock
// at the menu item's production_warehouse_id (if set). Safe to call
// multiple times — existing inv_items rows with the generated id are
// skipped. Lets the admin pull legacy semis into the unified inventory
// model without re-creating them by hand.
router.post('/items/import-semi-from-menu', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const [semis] = await db.query(`
      SELECT id, name, category, cost, stock, brand_id,
             production_unit, production_warehouse_id, min_stock_alert
      FROM menu
      WHERE is_semi_finished = 1 AND COALESCE(active, 1) = 1
    `);
    let imported = 0, skipped = 0;
    for (const s of semis) {
      const baseId = String(s.id || '').replace(/^MENU-?/i, '');
      const invId = 'INV-SEMI-' + baseId;
      const [exists] = await db.query('SELECT id FROM inv_items WHERE id = ?', [invId]);
      if (exists.length) { skipped++; continue; }
      await db.query(`
        INSERT INTO inv_items
          (id, name, kind, category, cost, stock, min_stock, unit, brand_id, active)
        VALUES (?, ?, 'semi', ?, ?, ?, ?, ?, ?, 1)
      `, [
        invId,
        s.name,
        s.category || 'غير تامّ',
        Number(s.cost) || 0,
        Number(s.stock) || 0,
        Number(s.min_stock_alert) || 0,
        s.production_unit || 'pcs',
        s.brand_id || null
      ]);
      // Mirror current global stock into warehouse_stock at the menu's
      // production warehouse so the item shows up in the correct place
      // immediately. If no production_warehouse_id is set, the item
      // appears in inv_items but stock stays at 0 per warehouse — admin
      // can transfer it in later via stock-issues.
      if (s.production_warehouse_id && Number(s.stock) > 0) {
        const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const today  = nowIso.slice(0, 10);
        try {
          await db.query(`
            INSERT INTO warehouse_stock
              (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE qty = VALUES(qty), last_updated = VALUES(last_updated)
          `, [wsId, s.production_warehouse_id, invId, Number(s.stock),
              nowIso, today, (req.user && req.user.username) || 'system', nowIso]);
        } catch (e) { /* warehouse_stock row may already exist with a different id */ }
      }
      imported++;
    }
    res.json({ success: true, imported, skipped });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/items', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const b = req.body || {};
    const { id, name, category, cost, stock, minStock, unit, bigUnit, convRate, active, brandId, warehouseId, kind } = b;
    const isUpdate = !!id;
    // v5.16.0 — whitelist the kind value. 'raw' is the default for new
    // items so existing flows continue to work unchanged.
    const safeKind = (kind === 'semi') ? 'semi' : 'raw';

    const v = _validateItemPayload(b, { update: isUpdate });
    if (v) return res.status(v.status).json({ success: false, error: v.error });

    const brandIdVal = brandId || null;

    if (isUpdate) {
      // Update path — record must exist
      const before = await _fetchItemSnapshot(null, id);
      if (!before) return res.status(404).json({ success: false, error: 'item-not-found' });

      if (name !== undefined) {
        const dup = await _checkDuplicateName(null, name, brandIdVal !== null ? brandIdVal : before.brand_id, id);
        if (dup) return res.status(409).json({ success: false, error: 'duplicate-name', conflictId: dup });
      }

      await db.query(
        `UPDATE inv_items SET name=?, category=?, cost=?, stock=?, min_stock=?, unit=?, big_unit=?, conv_rate=?, active=?, brand_id=?, kind=? WHERE id=?`,
        [name != null ? name : before.name,
         category !== undefined ? (category || '') : before.category,
         cost !== undefined ? Number(cost) : Number(before.cost),
         stock !== undefined ? Number(stock) : Number(before.stock),
         minStock !== undefined ? Number(minStock) : Number(before.min_stock),
         unit || before.unit || 'حبة',
         bigUnit !== undefined ? (bigUnit || null) : before.big_unit,
         convRate !== undefined ? Number(convRate) : Number(before.conv_rate),
         active !== undefined ? active !== false : !!before.active,
         brandIdVal !== null ? brandIdVal : before.brand_id,
         kind !== undefined ? safeKind : (before.kind || 'raw'),
         id]
      );
      const after = await _fetchItemSnapshot(null, id);
      _audit(null, req, 'inv_item.update', id, before, after);
      return res.json({ success: true, id });
    }

    // Insert path — warehouse is mandatory (commit 92dd8be).
    if (!warehouseId) {
      return res.status(400).json({
        success: false,
        error: 'warehouse-required',
        hint: 'New materials must be registered to a specific warehouse. Use POST /api/inventory/warehouses/:warehouseId/items.'
      });
    }

    // Verify the warehouse exists before creating an orphan record.
    const [whs] = await db.query('SELECT id, brand_id FROM warehouses WHERE id = ?', [warehouseId]);
    if (!whs.length) return res.status(404).json({ success: false, error: 'warehouse-not-found' });

    const effectiveBrand = brandIdVal !== null ? brandIdVal : (whs[0].brand_id || null);
    const dup = await _checkDuplicateName(null, name, effectiveBrand, null);
    if (dup) return res.status(409).json({ success: false, error: 'duplicate-name', conflictId: dup });

    const newId = id || ('INV-' + Date.now() + '-' + Math.random().toString(36).slice(2,5));
    try {
      await db.withTransaction(async (conn) => {
        await conn.query(
          `INSERT INTO inv_items (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active, brand_id, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [newId, String(name).trim(), category || '', Number(cost) || 0, Number(stock) || 0, Number(minStock) || 0,
           unit || 'حبة', bigUnit || null, Number(convRate) || 1, active !== false, effectiveBrand, safeKind]
        );
        // Stock row at qty=0 so the item is visible in the warehouse view.
        const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2,5);
        const nowIso = new Date().toISOString().slice(0,19).replace('T',' ');
        const today  = nowIso.slice(0,10);
        await conn.query(
          `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated)
           VALUES (?,?,?,?,?,?,?,?)`,
          [wsId, warehouseId, newId, 0, nowIso, today, _actor(req) || 'system', nowIso]
        );
        await _audit(conn, req, 'inv_item.create', newId, null, { id: newId, name, brandId: effectiveBrand, warehouseId, kind: safeKind });
      });
    } catch (txErr) {
      // Fallback: best-effort sequential if the transaction helper failed
      // (older deploys / pool exhausted). We accept potential inconsistency
      // here rather than failing outright.
      try {
        await db.query(
          `INSERT INTO inv_items (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active, brand_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [newId, String(name).trim(), category || '', Number(cost) || 0, Number(stock) || 0, Number(minStock) || 0,
           unit || 'حبة', bigUnit || null, Number(convRate) || 1, active !== false, effectiveBrand]
        );
        _audit(null, req, 'inv_item.create', newId, null, { id: newId, name, brandId: effectiveBrand, warehouseId, fallback: true });
      } catch (e2) {
        return res.status(500).json({ success: false, error: e2.message });
      }
    }

    res.status(201).json({ success: true, id: newId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.65 — PATCH /items/:id/kind: flip an inventory item between
// 'raw' (purchased material) and 'semi' (produced material, i.e. has
// a BOM/recipe). Used by the "وصفة" button on the inventory catalog
// to auto-toggle the kind when a recipe is saved or unlinked.
//
// Guards (industry convention, mirrors Foodics + SAP + NetSuite + Odoo):
//   • To set kind='semi', the item MUST have an active BOM with
//     product_source='inv'. Without that, the inventory becomes
//     internally inconsistent (semi item with no recipe = unusable
//     in production orders). Returns 400 if the precondition fails.
//   • To revert kind='raw', there must be NO open production orders
//     (status IN planned/released/in_progress) targeting this item.
//     Otherwise the in-flight order would suddenly point at a "raw"
//     product that production can't produce. Returns 409 if blocked.
//
// Audit: each successful flip writes a row to audit_log with the
// before/after kind for traceability.
router.patch('/items/:id/kind', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const id   = req.params.id;
    const body = req.body || {};
    const safe = (body.kind === 'semi') ? 'semi' : 'raw';

    // Read current kind for audit + early-exit if no change.
    const [curRows] = await db.query(
      'SELECT id, name, COALESCE(kind, \'raw\') AS kind FROM inv_items WHERE id = ?',
      [id]);
    if (!curRows.length) {
      return res.status(404).json({ success: false, error: 'item-not-found' });
    }
    const before = curRows[0].kind;
    if (before === safe) {
      return res.json({ success: true, kind: safe, unchanged: true });
    }

    // Guard: semi requires an active BOM tied to this inv item.
    if (safe === 'semi') {
      const [boms] = await db.query(
        `SELECT id FROM bom
         WHERE product_id = ? AND COALESCE(product_source, 'inv') = 'inv'
               AND COALESCE(is_active, 1) = 1
         LIMIT 1`,
        [id]);
      if (!boms.length) {
        return res.status(400).json({
          success: false,
          error: 'kind-semi-requires-active-bom',
          message: 'لا يُمكِن تَحويل الصنف إلى نصف مُصنَّع بدون وصفة نَشطة. احفظ الوصفة أولاً.'
        });
      }
    }

    // Guard: raw requires no open production orders.
    if (safe === 'raw') {
      try {
        const [open] = await db.query(
          `SELECT id, order_number, status FROM production_orders
           WHERE product_id = ? AND status IN ('planned','released','in_progress')
           LIMIT 5`,
          [id]);
        if (open.length) {
          return res.status(409).json({
            success: false,
            error: 'open-production-orders-exist',
            message: 'يَتعذَّر إعادة الصنف إلى مادة خام — توجد أوامر إنتاج مفتوحة عليه.',
            openOrders: open.map(o => ({ id: o.id, number: o.order_number, status: o.status }))
          });
        }
      } catch (_) {
        // production_orders may not exist in older deploys — non-fatal.
      }
    }

    await db.query('UPDATE inv_items SET kind = ? WHERE id = ?', [safe, id]);
    _audit(null, req, 'inv_item.kind_change', id,
      { kind: before, name: curRows[0].name },
      { kind: safe,   name: curRows[0].name });

    res.json({ success: true, kind: safe, before: before });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.6 — Warehouse-aware "add raw material to warehouse" endpoint.
// Body: { itemId? | name, category, brandId, unit, bigUnit, convRate, cost,
//         qty, qtyUnit ('big'|'small'), addedAt (YYYY-MM-DD), minStock,
//         username }
//
// Behavior:
//   1. If itemId is provided and exists → reuse that inv_item.
//      Else create a new inv_items row from the supplied master fields.
//   2. Convert qty from supplied unit to small units (× convRate when 'big').
//   3. UPSERT warehouse_stock for (warehouseId, itemId): if already there,
//      INCREMENT qty (treats this as a purchase/inflow, not a reset).
//      Stamp first_added_date the first time the row is created so the
//      historical opening date is preserved even if the user backdates.
//   4. Log an inventory_movements row with movement_date = addedAt so
//      the new "warehouse ledger by date" report respects the timeline.
//   5. Recompute global inv_items.stock as Σ warehouse_stock.qty across
//      all warehouses (keeps the legacy global counter consistent).
router.post('/warehouses/:warehouseId/items', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const warehouseId = req.params.warehouseId;
    if (!req.guardWh(res, warehouseId)) return;
    const b = req.body || {};
    const username = _actor(req) || 'system';

    // Validate warehouse exists
    const [whs] = await db.query('SELECT id, name, brand_id FROM warehouses WHERE id = ?', [warehouseId]);
    if (!whs.length) return res.status(404).json({ success:false, error:'warehouse-not-found' });
    const wh = whs[0];

    // v5.10.28 — Tightened payload validation up front.
    const v = _validateItemPayload(b, { update: !!b.itemId });
    if (v) return res.status(v.status).json({ success:false, error: v.error });

    // Either itemId for an existing item OR a fresh master record
    let itemId = b.itemId || null;
    let isNewItem = false;
    if (itemId) {
      const [exists] = await db.query('SELECT id FROM inv_items WHERE id = ?', [itemId]);
      if (!exists.length) itemId = null;
    }
    if (!itemId) {
      if (!b.name) return res.status(400).json({ success:false, error:'name-required-for-new-item' });
      // v5.10.28 — Reject duplicate name within the same brand.
      const brandIdVal = b.brandId || wh.brand_id || null;
      const dup = await _checkDuplicateName(null, b.name, brandIdVal, null);
      if (dup) return res.status(409).json({ success:false, error:'duplicate-name', conflictId: dup });
      itemId = b.id || 'INV-' + Date.now() + '-' + Math.random().toString(36).slice(2,5);
      isNewItem = true;
    }

    const cRate = Number(b.convRate) || 1;
    const bigCost = Number(b.cost) || 0;
    const smallCost = (b.qtyUnit === 'big' || cRate > 1) ? (bigCost / cRate) : bigCost;
    const brandIdVal = b.brandId || wh.brand_id || null;
    const qtyRaw = Number(b.qty) || 0;
    const qtySmall = (b.qtyUnit === 'big') ? qtyRaw * cRate : qtyRaw;
    const addedAt = b.addedAt ? new Date(b.addedAt) : new Date();
    const addedAtIso = addedAt.toISOString().slice(0,19).replace('T',' ');
    const firstAddedDate = b.addedAt ? b.addedAt : addedAt.toISOString().slice(0,10);

    // RC — a tracked item's qty must not change via the legacy register path
    // (new items are created untracked, so only existing items can be tracked).
    if (!isNewItem && qtySmall !== 0 && (await _blockTrackedLegacy(db, itemId, res))) return;

    // v5.10.28 — Wrap the four-step write in a transaction so a partial
    // failure (e.g. movements insert) cannot leave warehouse_stock and
    // inv_items inconsistent. Falls back to best-effort sequential if
    // the transaction helper is unavailable on the deploy.
    const runWrites = async (conn) => {
      const c = conn || db;

      // 1. Master record (insert if new)
      if (isNewItem) {
        await c.query(
          `INSERT INTO inv_items
            (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active, brand_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [itemId, String(b.name).trim(), b.category || '', smallCost, 0, Number(b.minStock)||0,
           b.unit || 'حبة', b.bigUnit || null, cRate, true, brandIdVal]);
      }

      // 2. UPSERT warehouse_stock — increment if existing, preserve first_added_date.
      const [existing] = await c.query(
        'SELECT id, qty, first_added_date FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?',
        [warehouseId, itemId]);
      if (existing.length) {
        const newQty = Number(existing[0].qty) + qtySmall;
        await c.query(
          `UPDATE warehouse_stock SET qty = ?, last_updated = ?,
                                      first_added_date = COALESCE(first_added_date, ?)
           WHERE id = ?`,
          [newQty, addedAtIso, firstAddedDate, existing[0].id]);
      } else {
        const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2,5);
        await c.query(
          `INSERT INTO warehouse_stock
            (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated)
           VALUES (?,?,?,?,?,?,?,?)`,
          [wsId, warehouseId, itemId, qtySmall, addedAtIso, firstAddedDate, username, addedAtIso]);
      }

      // 3. Movement log (only for actual inflows)
      if (qtySmall > 0) {
        const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2,5);
        const [iname] = await c.query('SELECT name FROM inv_items WHERE id = ?', [itemId]);
        try {
          await c.query(
            `INSERT INTO inventory_movements
              (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [movId, addedAtIso, itemId, iname.length?iname[0].name:'', 'in', qtySmall,
             'إضافة للمستودع', username, 'WH: ' + wh.name, warehouseId]);
        } catch (e) {
          // Older deploys may have a different movements schema — non-fatal,
          // but inside a tx we still let it through (the catch above swallows
          // schema errors specifically; other failures bubble up).
        }
      }

      // 4. Recompute global stock — non-fatal.
      try {
        await c.query(
          `UPDATE inv_items i SET i.stock =
             (SELECT COALESCE(SUM(ws.qty),0) FROM warehouse_stock ws WHERE ws.item_id = i.id)
           WHERE i.id = ?`, [itemId]);
      } catch (e) { /* permission or older mysql; non-fatal */ }
    };

    let usedTx = false;
    try {
      if (typeof db.withTransaction === 'function') {
        await db.withTransaction(runWrites);
        usedTx = true;
      } else {
        await runWrites(null);
      }
    } catch (txErr) {
      // Fallback: try sequential (no rollback). If this also fails, surface 500.
      try { await runWrites(null); }
      catch (e2) {
        console.error('[POST /warehouses/:id/items] tx + fallback failed:', txErr.message, e2.message);
        return res.status(500).json({ success:false, error: e2.message });
      }
    }

    _audit(null, req, isNewItem ? 'inv_item.create' : 'inv_item.stock_in', itemId, null,
      { warehouseId, qtySmall, firstAddedDate, isNewItem, viaTransaction: usedTx });

    res.json({ success:true, itemId, warehouseId, qtySmall, firstAddedDate });
  } catch (e) {
    console.error('[POST /warehouses/:id/items]', e);
    res.status(500).json({ success:false, error: e.message });
  }
});

// v5.10.6 — Remove an item from a single warehouse (without deleting the
// inv_item master record). Used by the warehouse view's "remove" action.
router.delete('/warehouses/:warehouseId/items/:itemId', requireCapability('inventory.edit'), async (req, res) => {
  try {
    if (!req.guardWh(res, req.params.warehouseId)) return;
    await db.query('DELETE FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?',
                   [req.params.warehouseId, req.params.itemId]);
    res.json({ success:true });
  } catch (e) { res.json({ success:false, error: e.message }); }
});

// v5.10.13 — list brand items NOT yet in this warehouse.
// Used by the "غير منقولة" picker so the user can register them in bulk.
//   GET /api/inventory/warehouses/:warehouseId/missing-items?brandId=X
//   Optional brandId — when omitted, defaults to the warehouse's brand_id.
//   Filters out: items already in warehouse_stock here, items with any
//   inventory_movements record for this warehouse.
router.get('/warehouses/:warehouseId/missing-items', async (req, res) => {
  try {
    const warehouseId = req.params.warehouseId;
    if (!req.guardWh(res, warehouseId)) return;
    const [whs] = await db.query('SELECT id, name, brand_id FROM warehouses WHERE id = ?', [warehouseId]);
    if (!whs.length) return res.status(404).json({ success:false, error:'warehouse-not-found' });
    const brandId = req.query.brandId || whs[0].brand_id || null;

    // Brand catalog (active items)
    let sql = 'SELECT i.id, i.name, i.category, i.unit, i.big_unit AS bigUnit, ' +
              '       i.conv_rate AS convRate, i.cost, i.min_stock AS minStock, ' +
              '       i.brand_id, b.name AS brand_name ' +
              'FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id ' +
              'WHERE i.active = 1';
    const params = [];
    if (brandId) { sql += ' AND i.brand_id = ?'; params.push(brandId); }
    sql += ' AND i.id NOT IN (' +
              ' SELECT ws.item_id FROM warehouse_stock ws WHERE ws.warehouse_id = ?' +
              ' UNION ' +
              ' SELECT DISTINCT im.item_id FROM inventory_movements im WHERE im.warehouse_id = ?' +
            ') ORDER BY i.category, i.name';
    params.push(warehouseId, warehouseId);
    const [rows] = await db.query(sql, params);
    res.json({
      success: true,
      warehouseId, warehouseName: whs[0].name,
      brandId: brandId || null,
      count: rows.length,
      items: rows.map(r => ({
        id: r.id, name: r.name, category: r.category || '',
        unit: r.unit || 'حبة', bigUnit: r.bigUnit || '',
        convRate: Number(r.convRate) || 1,
        cost: Number(r.cost) || 0,
        minStock: Number(r.minStock) || 0,
        brandId: r.brand_id || '', brandName: r.brand_name || ''
      }))
    });
  } catch(e) { console.error('[missing-items]', e); res.json({ success:false, error: e.message }); }
});

// v5.10.13 — bulk-register items into a warehouse with qty=0.
//   POST /api/inventory/warehouses/:warehouseId/register-bulk
//   body: { itemIds:[], firstAddedDate?, username? }
//   Creates a warehouse_stock(qty=0, first_added_date=...) row for each
//   itemId that doesn't already have one. Idempotent — silently skips
//   items already registered.
router.post('/warehouses/:warehouseId/register-bulk', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const warehouseId = req.params.warehouseId;
    if (!req.guardWh(res, warehouseId)) return;
    const b = req.body || {};
    const itemIds = Array.isArray(b.itemIds) ? b.itemIds.filter(Boolean) : [];
    if (!itemIds.length) return res.json({ success:false, error:'no-items' });

    const [whs] = await db.query('SELECT id FROM warehouses WHERE id = ?', [warehouseId]);
    if (!whs.length) return res.status(404).json({ success:false, error:'warehouse-not-found' });

    const firstAddedDate = b.firstAddedDate
      ? new Date(b.firstAddedDate).toISOString().slice(0,10)
      : new Date().toISOString().slice(0,10);
    const username = _actor(req) || 'system';

    let registered = 0, skipped = 0;
    for (const itemId of itemIds) {
      const [exists] = await db.query(
        'SELECT id FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?',
        [warehouseId, itemId]);
      if (exists.length) { skipped++; continue; }
      const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2,5);
      try {
        await db.query(
          'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated) ' +
          'VALUES (?,?,?,?,?,?,?,?)',
          [wsId, warehouseId, itemId, 0, new Date(), firstAddedDate, username, new Date()]);
        registered++;
      } catch(e) {
        // Race / duplicate key — count as skipped, not as failure
        skipped++;
      }
    }
    res.json({ success:true, registered, skipped, total: itemIds.length });
  } catch(e) { console.error('[register-bulk]', e); res.json({ success:false, error: e.message }); }
});

// v5.10.6 — Admin cleanup: removes warehouse_stock rows that look like
// auto-backfill artifacts (qty=0, no first_added_date, and no movement
// log referencing the (warehouse, item) pair). Idempotent + safe — only
// targets ghost entries the system created on its own.
async function _cleanupGhostWarehouseStock(dbConn) {
  const conn = dbConn || db;
  // Schema guard — bail out if first_added_date column doesn't exist yet
  // (e.g. boot order on a brand-new deploy where migrations haven't run).
  try {
    const [cols] = await conn.query("SHOW COLUMNS FROM warehouse_stock LIKE 'first_added_date'");
    if (!cols.length) return { ok:false, reason:'column-not-ready', scanned:0, removed:0 };
  } catch(_) { return { ok:false, reason:'table-missing', scanned:0, removed:0 }; }

  const [ghosts] = await conn.query(`
    SELECT ws.id, ws.warehouse_id, ws.item_id
    FROM warehouse_stock ws
    WHERE COALESCE(ws.qty, 0) = 0
      AND ws.first_added_date IS NULL
  `);
  let removed = 0;
  for (const g of ghosts) {
    const [movs] = await conn.query(
      `SELECT id FROM inventory_movements WHERE item_id = ? AND warehouse_id = ? LIMIT 1`,
      [g.item_id, g.warehouse_id]);
    if (movs.length) continue;  // legitimate empty — leave it
    await conn.query('DELETE FROM warehouse_stock WHERE id = ?', [g.id]);
    removed++;
  }
  return { ok:true, scanned: ghosts.length, removed };
}
// Expose helper for server.js boot migration
router._cleanupGhostWarehouseStock = _cleanupGhostWarehouseStock;

router.post('/admin/cleanup-ghost-warehouse-stock', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const r = await _cleanupGhostWarehouseStock(db);
    res.json({ success:!!r.ok, scanned:r.scanned||0, removed:r.removed||0, reason:r.reason||null });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// Delete inventory item
// v5.10.25 — Soft-delete: marks deleted_at instead of physically removing.
// v5.10.28 — Adds audit trail + proper 404 / 409 status codes.
router.delete('/items/:id', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const id = req.params.id;
    const before = await _fetchItemSnapshot(null, id);
    if (!before) return res.status(404).json({ success: false, error: 'item-not-found' });

    if (req.query.hard === '1') {
      await db.query('DELETE FROM inv_items WHERE id = ?', [id]);
      _audit(null, req, 'inv_item.hard_delete', id, before, null);
      return res.json({ success: true, hardDeleted: true });
    }
    if (before.deleted_at) {
      return res.status(409).json({ success: false, error: 'already-deleted' });
    }
    const [result] = await db.query(
      'UPDATE inv_items SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
      [id]
    );
    _audit(null, req, 'inv_item.soft_delete', id, before, { deleted_at: 'NOW' });
    res.json({ success: true, softDeleted: true, affected: result.affectedRows || 0 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.25 — Restore a soft-deleted item back into the active catalog.
// v5.10.28 — Adds audit trail + 404 / 409 codes.
router.post('/items/:id/restore', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const id = req.params.id;
    const before = await _fetchItemSnapshot(null, id);
    if (!before) return res.status(404).json({ success: false, error: 'item-not-found' });
    if (!before.deleted_at) return res.status(409).json({ success: false, error: 'not-deleted' });

    const [result] = await db.query(
      'UPDATE inv_items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL',
      [id]
    );
    _audit(null, req, 'inv_item.restore', id, before, { deleted_at: null });
    res.json({ success: true, restored: result.affectedRows || 0 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.28 — Bulk soft-delete: ids in body. Wrapped in a transaction so
// partial failure leaves no half-applied state. Returns per-id outcomes
// so the UI can show a meaningful summary.
router.post('/items/bulk-delete', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'ids-required' });
    if (ids.length > 500) return res.status(400).json({ success: false, error: 'too-many-ids' });

    const ph = ids.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT id, name, brand_id, deleted_at FROM inv_items WHERE id IN (${ph})`, ids);
    const found = new Map(rows.map(r => [r.id, r]));

    const eligible = ids.filter(id => found.has(id) && !found.get(id).deleted_at);
    let affected = 0;
    if (eligible.length) {
      const eph = eligible.map(() => '?').join(',');
      const runner = async (conn) => {
        const c = conn || db;
        const [r] = await c.query(
          `UPDATE inv_items SET deleted_at = NOW() WHERE id IN (${eph}) AND deleted_at IS NULL`,
          eligible);
        affected = r.affectedRows || 0;
        for (const id of eligible) {
          await _audit(c, req, 'inv_item.soft_delete', id, found.get(id), { deleted_at: 'NOW', bulk: true });
        }
      };
      try {
        if (typeof db.withTransaction === 'function') await db.withTransaction(runner);
        else await runner(null);
      } catch (e) {
        try { await runner(null); } catch (_) { return res.status(500).json({ success: false, error: e.message }); }
      }
    }

    res.json({
      success: true,
      requested: ids.length,
      affected,
      missing: ids.filter(id => !found.has(id)),
      alreadyDeleted: ids.filter(id => found.has(id) && found.get(id).deleted_at)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.28 — Bulk restore: mirror of bulk-delete.
router.post('/items/bulk-restore', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'ids-required' });
    if (ids.length > 500) return res.status(400).json({ success: false, error: 'too-many-ids' });

    const ph = ids.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT id, name, brand_id, deleted_at FROM inv_items WHERE id IN (${ph})`, ids);
    const found = new Map(rows.map(r => [r.id, r]));
    const eligible = ids.filter(id => found.has(id) && found.get(id).deleted_at);

    let affected = 0;
    if (eligible.length) {
      const eph = eligible.map(() => '?').join(',');
      const runner = async (conn) => {
        const c = conn || db;
        const [r] = await c.query(
          `UPDATE inv_items SET deleted_at = NULL WHERE id IN (${eph}) AND deleted_at IS NOT NULL`,
          eligible);
        affected = r.affectedRows || 0;
        for (const id of eligible) {
          await _audit(c, req, 'inv_item.restore', id, found.get(id), { deleted_at: null, bulk: true });
        }
      };
      try {
        if (typeof db.withTransaction === 'function') await db.withTransaction(runner);
        else await runner(null);
      } catch (e) {
        try { await runner(null); } catch (_) { return res.status(500).json({ success: false, error: e.message }); }
      }
    }

    res.json({
      success: true,
      requested: ids.length,
      affected,
      missing: ids.filter(id => !found.has(id)),
      alreadyActive: ids.filter(id => found.has(id) && !found.get(id).deleted_at)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.25 — Catalog endpoint for the new "إدارة مواد المخزون" section.
// Returns ALL items (across all warehouses, all brands) with metadata
// only — NO warehouse_stock joins or aggregation. This is the master
// definition list, what the user manages globally.
//
// v5.10.28 — Adds pagination + sorting + total count.
//   New params: ?paginated=1, ?limit (default 50, max 500), ?offset,
//               ?sort (whitelist: name|cost|category|created_at|min_stock|deleted_at),
//               ?order (asc|desc).
//   When ?paginated=1 → returns { items, total, limit, offset }.
//   Otherwise → returns array (back-compat for older clients).
router.get('/catalog', async (req, res) => {
  try {
    const { onlyDeleted, brandId, warehouseId, q, paginated, kind } = req.query;
    const SORT_WHITELIST = {
      id:         'i.id',
      name:       'i.name',
      brand:      'b.name',
      brandName:  'b.name',
      cost:       'i.cost',
      category:   'i.category',
      created_at: 'i.created_at',
      createdAt:  'i.created_at',
      min_stock:  'i.min_stock',
      minStock:   'i.min_stock',
      deleted_at: 'i.deleted_at',
      deletedAt:  'i.deleted_at'
    };
    const sortKey  = SORT_WHITELIST[req.query.sort] || null;
    const sortOrd  = (String(req.query.order || '').toLowerCase() === 'desc') ? 'DESC' : 'ASC';
    const limit    = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset   = Math.max(Number(req.query.offset) || 0, 0);

    const where = [];
    const params = [];
    if (onlyDeleted === '1') where.push('i.deleted_at IS NOT NULL');
    else                     where.push('i.deleted_at IS NULL');
    if (brandId) { where.push('i.brand_id = ?'); params.push(brandId); }
    if (warehouseId) {
      where.push('(EXISTS(SELECT 1 FROM warehouse_stock ws WHERE ws.item_id = i.id AND ws.warehouse_id = ?) ' +
                 'OR EXISTS(SELECT 1 FROM inventory_movements im WHERE im.item_id = i.id AND im.warehouse_id = ?))');
      params.push(warehouseId, warehouseId);
    }
    if (q) {
      where.push('(i.name LIKE ? OR i.id LIKE ? OR i.category LIKE ?)');
      params.push('%'+q+'%', '%'+q+'%', '%'+q+'%');
    }
    // v5.16.0 — filter by kind (raw / semi)
    if (kind === 'raw' || kind === 'semi') {
      where.push('COALESCE(i.kind, \'raw\') = ?');
      params.push(kind);
    }
    const whereSql = 'WHERE ' + where.join(' AND ');

    const orderSql = sortKey
      ? ` ORDER BY ${sortKey} ${sortOrd}, i.id ASC`
      : ` ORDER BY ${onlyDeleted === '1' ? 'i.deleted_at DESC' : 'i.category, i.name'}`;

    const baseSelect =
      'SELECT i.id, i.name, i.category, i.brand_id, b.name AS brand_name, ' +
      '       i.unit, i.big_unit, i.conv_rate, i.cost, i.min_stock, ' +
      '       i.stock AS global_stock, i.active, i.created_at, i.deleted_at, ' +
      '       COALESCE(i.kind, \'raw\') AS kind, ' +  // v5.16.0
      // v5.10.65 — surface bom_id + has_recipe so the catalog UI knows
      // whether to render the recipe button as "ADD" or "EDIT", and to
      // pre-open the existing BOM in edit mode without an extra round-trip.
      '       (SELECT bom.id FROM bom WHERE bom.product_id = i.id ' +
      '              AND COALESCE(bom.product_source, \'inv\') = \'inv\' ' +
      '              AND COALESCE(bom.is_active, 1) = 1 LIMIT 1) AS bom_id ' +
      'FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id ';

    const wantsPaginated = paginated === '1' || req.query.limit != null || req.query.offset != null;

    if (wantsPaginated) {
      const [countRows] = await db.query(
        'SELECT COUNT(*) AS total FROM inv_items i ' + whereSql, params);
      const total = Number((countRows[0] || {}).total) || 0;

      const [rows] = await db.query(
        baseSelect + whereSql + orderSql + ' LIMIT ? OFFSET ?',
        params.concat([limit, offset]));

      const mapped = rows.map(_mapCatalogRow);
      await _attachWarehouseDistribution(mapped);
      return res.json({
        items: mapped,
        total, limit, offset,
        sort: req.query.sort || null,
        order: sortKey ? sortOrd.toLowerCase() : null
      });
    }

    // Back-compat: array shape, capped at 500 to protect memory.
    const [rows] = await db.query(baseSelect + whereSql + orderSql + ' LIMIT 500', params);
    const mapped = rows.map(_mapCatalogRow);
    await _attachWarehouseDistribution(mapped);
    res.json(mapped);
  } catch (e) {
    res.status(500).json({ error: e.message, items: [] });
  }
});

function _mapCatalogRow(i) {
  return {
    id: i.id, name: i.name, category: i.category || '',
    kind: i.kind || 'raw',  // v5.16.0 — 'raw' or 'semi'
    brandId: i.brand_id || '', brandName: i.brand_name || '',
    unit: i.unit || '', bigUnit: i.big_unit || '',
    convRate: Number(i.conv_rate) || 1, cost: Number(i.cost) || 0,
    minStock: Number(i.min_stock) || 0, globalStock: Number(i.global_stock) || 0,
    active: !!i.active, createdAt: i.created_at,
    deletedAt: i.deleted_at,
    // v5.10.65 — surface recipe state for the catalog UI's recipe button.
    bomId: i.bom_id || null,
    hasRecipe: !!i.bom_id,
    warehouses: []  // populated by _attachWarehouseDistribution
  };
}

// v5.10.29 — For each catalog row, attach the list of warehouses that hold
// this item (with their qty). Powers the "المستودعات" column in the catalog
// table so the user can see, at a glance, where each material is stocked.
// Single grouped query, not N+1.
async function _attachWarehouseDistribution(items) {
  if (!items || !items.length) return;
  const ids = items.map(it => it.id);
  const ph = ids.map(() => '?').join(',');
  let rows = [];
  try {
    [rows] = await db.query(
      'SELECT ws.item_id, ws.warehouse_id, ws.qty, w.name AS warehouse_name, w.code AS warehouse_code ' +
      'FROM warehouse_stock ws LEFT JOIN warehouses w ON w.id = ws.warehouse_id ' +
      'WHERE ws.item_id IN (' + ph + ') AND ws.qty > 0 ' +
      'ORDER BY ws.qty DESC',
      ids);
  } catch (_) { return; /* table missing on stale deploy */ }
  const byItem = {};
  for (const r of rows) {
    const id = r.item_id;
    if (!byItem[id]) byItem[id] = [];
    byItem[id].push({
      warehouseId: r.warehouse_id,
      warehouseName: r.warehouse_name || r.warehouse_code || r.warehouse_id,
      warehouseCode: r.warehouse_code || '',
      qty: Number(r.qty) || 0
    });
  }
  for (const it of items) it.warehouses = byItem[it.id] || [];
}

// v5.10.25 — Catalog summary KPIs (one row, computed). Powers the
// "إدارة مواد المخزون" KPI strip.
router.get('/catalog/summary', async (req, res) => {
  try {
    const { warehouseId } = req.query;
    let whCondition = '';
    const params = [];
    if (warehouseId) {
      whCondition = ' AND (EXISTS(SELECT 1 FROM warehouse_stock ws WHERE ws.item_id = inv_items.id AND ws.warehouse_id = ?) ' +
                    'OR EXISTS(SELECT 1 FROM inventory_movements im WHERE im.item_id = inv_items.id AND im.warehouse_id = ?))';
      params.push(warehouseId, warehouseId);
    }
    const [rows] = await db.query(
      "SELECT " +
      "  SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active_count, " +
      "  SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_count, " +
      "  COUNT(DISTINCT CASE WHEN deleted_at IS NULL THEN brand_id END) AS brand_count, " +
      "  COUNT(DISTINCT CASE WHEN deleted_at IS NULL THEN category END) AS category_count " +
      "FROM inv_items WHERE 1=1" + whCondition, params
    );
    const r = rows[0] || {};
    res.json({
      activeCount:   Number(r.active_count)   || 0,
      deletedCount:  Number(r.deleted_count)  || 0,
      brandCount:    Number(r.brand_count)    || 0,
      categoryCount: Number(r.category_count) || 0
    });
  } catch (e) {
    res.json({ activeCount: 0, deletedCount: 0, brandCount: 0, categoryCount: 0, error: e.message });
  }
});

// Bulk import inventory items
router.post('/items/import', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.json({ success: false, error: 'No items provided' });

    let imported = 0;
    let updated = 0;

    for (const item of items) {
      const id = item.id || 'INV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      const [existing] = await db.query('SELECT id FROM inv_items WHERE id = ? OR name = ?', [id, item.name]);

      if (existing.length) {
        await db.query(
          `UPDATE inv_items SET name=?, category=?, cost=?, stock=?, min_stock=?, unit=?, big_unit=?, conv_rate=?, kind=?, brand_id=? WHERE id=?`,
          [item.name, item.category || '', item.cost || 0, item.stock || 0, item.minStock || 0,
           item.unit || 'حبة', item.bigUnit || null, item.convRate || 1,
           item.kind || 'raw', item.brandId || null, existing[0].id]
        );
        updated++;
      } else {
        await db.query(
          `INSERT INTO inv_items (id, name, category, cost, stock, min_stock, unit, big_unit, conv_rate, active, kind, brand_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, item.name, item.category || '', item.cost || 0, item.stock || 0, item.minStock || 0,
           item.unit || 'حبة', item.bigUnit || null, item.convRate || 1, true,
           item.kind || 'raw', item.brandId || null]
        );
        imported++;
      }
    }

    res.json({ success: true, imported, updated, total: items.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get inventory movements
// v5.10.19 — added warehouseId scoping so movements list no longer mixes
// warehouses by default. Also returns warehouse_id + warehouse_name on each
// row so the UI can render a "المستودع" column.
// v5.10.29 — Adds ?fromDate&toDate aliases (back-compat with startDate/endDate),
// configurable ?limit (default 200, cap 2000) + ?offset, and ?paginated=1 for
// the new shape { items, total, limit, offset } so the UI can paginate freely.
router.get('/movements', async (req, res) => {
  try {
    const where = ['1=1'];
    const params = [];
    const from = req.query.fromDate || req.query.startDate;
    const to   = req.query.toDate   || req.query.endDate;
    if (from)                  { where.push('DATE(m.movement_date) >= ?'); params.push(from); }
    if (to)                    { where.push('DATE(m.movement_date) <= ?'); params.push(to); }
    if (req.query.itemId)      { where.push('m.item_id = ?');               params.push(req.query.itemId); }
    if (req.query.type)        { where.push('m.type = ?');                  params.push(req.query.type); }
    if (req.query.warehouseId) { where.push('m.warehouse_id = ?');          params.push(req.query.warehouseId); }
    if (req.query.q)           { where.push('(m.item_name LIKE ? OR m.reason LIKE ? OR m.notes LIKE ?)');
                                 params.push('%'+req.query.q+'%','%'+req.query.q+'%','%'+req.query.q+'%'); }
    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    const msc = req.whScopeClause('m.warehouse_id');
    if (msc.sql) { where.push(msc.sql.replace(/^\s*AND\s+/i, '')); params.push(...msc.params); }

    const whereSql = ' WHERE ' + where.join(' AND ');
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 2000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const wantsPaginated = req.query.paginated === '1' || req.query.limit != null || req.query.offset != null;

    const baseSelect =
      'SELECT m.*, w.name AS warehouse_name, w.code AS warehouse_code ' +
      'FROM inventory_movements m LEFT JOIN warehouses w ON w.id = m.warehouse_id';
    const order = ' ORDER BY m.movement_date DESC, m.id DESC';

    const [rows] = await db.query(
      baseSelect + whereSql + order + ' LIMIT ? OFFSET ?',
      params.concat([limit, offset]));
    const items = rows.map(m => ({
      id: m.id, date: m.movement_date, itemId: m.item_id, itemName: m.item_name,
      type: m.type, qty: Number(m.qty), reason: m.reason, username: m.username, notes: m.notes,
      warehouseId: m.warehouse_id || '',
      warehouseName: m.warehouse_name || '',
      warehouseCode: m.warehouse_code || ''
    }));

    if (wantsPaginated) {
      const [countRows] = await db.query(
        'SELECT COUNT(*) AS total FROM inventory_movements m' + whereSql, params);
      return res.json({
        items, total: Number((countRows[0]||{}).total) || 0,
        limit, offset
      });
    }
    res.json(items);
  } catch (e) {
    // G-INV M3 — a DB failure is a 500, not a silent empty movements list.
    console.error('[inventory /movements]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stock update (in/out movement)
router.post('/stock-update', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const { itemId, itemName, type, qty, reason, notes } = req.body;
    let { warehouseId, branchId } = req.body;
    const username = _actor(req); // G-INV M2 — movement actor from the JWT only

    // V3 spec rule: stock movements MUST have warehouse_id + branch_id
    // (يمنع: إنشاء حركات مخزون بدون مستودع وفرع محددين)
    // Try to auto-fill from the requesting user's defaults before rejecting.
    if ((!warehouseId || !branchId) && req.user) {
      try {
        const [u] = await db.query('SELECT branch_id, default_warehouse_id FROM users WHERE username = ? LIMIT 1', [req.user.username || username]);
        if (u.length) {
          branchId = branchId || u[0].branch_id;
          warehouseId = warehouseId || u[0].default_warehouse_id;
        }
      } catch(e) {}
    }
    if (!warehouseId) {
      return res.json({ success: false, error: 'لا يمكن إنشاء حركة مخزون بدون تحديد المستودع. حدّد مستودعاً افتراضياً للمستخدم أو أرسل warehouseId صراحةً.' });
    }
    if (warehouseId && !req.guardWh(res, warehouseId)) return;

    // RC — tracked items must move through warehouse-v2 documents (lot ledger).
    if (await _blockTrackedLegacy(db, itemId, res)) return;

    const now = new Date();
    const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);

    // Insert movement record (with warehouse_id — column already exists)
    try {
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [movId, now, itemId, itemName || '', type, qty, reason || '', username || '', notes || '', warehouseId]
      );
    } catch(e) {
      // Fallback for very old schema without warehouse_id column
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes) VALUES (?,?,?,?,?,?,?,?,?)',
        [movId, now, itemId, itemName || '', type, qty, reason || '', username || '', notes || '']
      );
    }

    // v5.10.19 — warehouse_stock is the source of truth. We write the
    // per-warehouse delta first, then recompute inv_items.stock as a
    // SUM(warehouse_stock.qty) rollup so totals stay consistent across
    // warehouses without overwriting any other warehouse's balance.
    const delta = (type === 'in') ? Number(qty) : -Number(qty);
    if (warehouseId) {
      try {
        const wsId = 'WS-' + warehouseId + '-' + itemId;
        // v7.1 — allow negative (no GREATEST clamp) so shortages stay visible.
        await db.query(
          `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)`,
          [wsId, warehouseId, itemId, delta]
        );
        await recomputeInvItemStock(db, itemId);
      } catch(e) { /* warehouse_stock missing on very old deploy — fall through */ }
    } else {
      // Legacy fallback: no warehouse context — direct global write.
      if (type === 'in') {
        await db.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?', [qty, itemId]);
      } else {
        await db.query('UPDATE inv_items SET stock = stock - ? WHERE id = ?', [qty, itemId]);
      }
    }

    res.json({ success: true, movementId: movId, warehouseId: warehouseId, branchId: branchId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get live inventory (current stock with movements summary). Optional ?brandId= filter.
router.get('/live', async (req, res) => {
  try {
    const { brandId } = req.query;
    let sql = 'SELECT i.*, b.name AS brand_name FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.active = 1';
    const params = [];
    if (brandId) { sql += ' AND i.brand_id = ?'; params.push(brandId); }
    sql += ' ORDER BY i.category, i.name';
    const [items] = await db.query(sql, params);

    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    const lsc = req.whScopeClause('warehouse_id');
    // Aggregate inventory movements per item: total purchased (in) and total consumed (out)
    const [movRows] = await db.query(
      "SELECT item_id, type, SUM(qty) AS totalQty FROM inventory_movements WHERE 1=1" + lsc.sql + " GROUP BY item_id, type",
      [...lsc.params]
    );
    const movMap = {};
    movRows.forEach(r => {
      const id = r.item_id;
      if (!movMap[id]) movMap[id] = { in: 0, out: 0 };
      if (r.type === 'in') movMap[id].in = Number(r.totalQty) || 0;
      else if (r.type === 'out') movMap[id].out = Number(r.totalQty) || 0;
    });

    const result = items.map(i => {
      const m = movMap[i.id] || { in: 0, out: 0 };
      const currentStock = Number(i.stock) || 0;
      const initialStock = currentStock + m.out - m.in;
      // Determine status for UI convenience
      let status = 'جيد';
      if (currentStock <= 0) status = 'نفد';
      else if (currentStock <= (Number(i.min_stock) || 0)) status = 'منخفض';
      return {
        id: i.id,
        name: i.name,
        category: i.category || '',
        unit: i.unit || 'حبة',
        bigUnit: i.big_unit || '',
        convRate: Number(i.conv_rate) || 1,
        initialStock: initialStock,
        purchasedQty: m.in,
        consumedQty: m.out,
        currentStock: currentStock,
        minStock: Number(i.min_stock) || 0,
        cost: Number(i.cost) || 0,
        status: status,
        brandId: i.brand_id || '',
        brand_id: i.brand_id || '',
        brandName: i.brand_name || ''
      };
    });
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// V5.8.1 — Period-aware live inventory report.
// Returns each item with full breakdown for a date range:
//   • openingStock  — stock as of startDate
//   • purchasedQty  — sum of 'in' movements where reason ~ purchase/receive in period
//   • consumedQty   — sum of 'out' movements where reason ~ sales/production
//   • adjustedQty   — net adjustments in period (negative if shortages)
//   • transferIn    — sum of 'in' transfer movements
//   • transferOut   — sum of 'out' transfer movements
//   • closingStock  — stock as of endDate (= opening + net movements)
//   • value         — closingStock × unit cost
// Query params: brandId?, warehouseId?, category?, startDate, endDate, q?(search)
// v5.10.6 — Warehouse Ledger by Date (دفتر أستاذ المستودع)
//
// Body: ?warehouseId=&from=&to=&itemId= (all optional)
// Returns: { warehouse, items: [ { itemId, name, unit, opening, in, out,
//                                   closing, lines: [...], firstAddedDate } ] }
//
// `opening` is computed as: warehouse_stock.qty as of `from` (today's qty
// minus all movements between `from` and now). `in` and `out` aggregate
// inventory_movements between [from, to] inclusive. `closing` = opening
// + in − out. The lines array carries each movement so the frontend can
// render a per-item drill-down. If from is omitted, opening is 0 (full
// history from start of time).
router.get('/warehouse-ledger', async (req, res) => {
  try {
    const { warehouseId, from, to, itemId } = req.query;
    if (!warehouseId) return res.json({ success:false, error:'warehouseId required' });
    if (!req.guardWh(res, warehouseId)) return;

    const [wh] = await db.query('SELECT id, name, code FROM warehouses WHERE id = ?', [warehouseId]);
    if (!wh.length) return res.json({ success:false, error:'warehouse-not-found' });

    // Items that have ever been in this warehouse (warehouse_stock OR movements)
    let itemFilterSql = '';
    const itemFilterParams = [];
    if (itemId) { itemFilterSql = ' AND i.id = ?'; itemFilterParams.push(itemId); }

    // v5.15.2 — UNION raw materials (inv_items) with semi-finished
    // products (menu where is_semi_finished=1 + production_warehouse_id
    // matches). Lets the warehouse ledger surface semi-finished items
    // like "cold drink base" that previously were invisible here.
    const [items] = await db.query(`
      SELECT i.id, i.name, i.unit, i.cost,
             'raw' AS item_type,
             ws.qty AS current_qty,
             ws.first_added_date AS first_added
      FROM inv_items i
      LEFT JOIN warehouse_stock ws
             ON ws.item_id = i.id AND ws.warehouse_id = ?
      LEFT JOIN inventory_movements mvt
             ON mvt.item_id = i.id AND mvt.warehouse_id = ?
      WHERE (ws.id IS NOT NULL OR mvt.id IS NOT NULL)
            ${itemFilterSql}
      GROUP BY i.id, i.name, i.unit, i.cost, ws.qty, ws.first_added_date

      UNION ALL

      SELECT m.id, m.name, COALESCE(m.production_unit, 'pcs') AS unit,
             COALESCE(m.cost, 0) AS cost,
             'semi' AS item_type,
             COALESCE(m.stock, 0) AS current_qty,
             m.created_at AS first_added
      FROM menu m
      WHERE m.is_semi_finished = 1
        AND m.active = 1
        AND m.production_warehouse_id = ?
        ${itemId ? 'AND m.id = ?' : ''}

      ORDER BY name`,
      itemId
        ? [warehouseId, warehouseId, ...itemFilterParams, warehouseId, itemId]
        : [warehouseId, warehouseId, ...itemFilterParams, warehouseId]
    );

    const dateFilter = [];
    const dateParams = [];
    if (from) { dateFilter.push('DATE(movement_date) >= ?'); dateParams.push(from); }
    if (to)   { dateFilter.push('DATE(movement_date) <= ?'); dateParams.push(to); }
    const dateClause = dateFilter.length ? (' AND ' + dateFilter.join(' AND ')) : '';

    const result = [];
    for (const it of items) {
      // Movements WITHIN [from..to] for this (item, warehouse)
      const [lines] = await db.query(
        `SELECT id, movement_date, type, qty, reason, username, notes
           FROM inventory_movements
          WHERE item_id = ? AND warehouse_id = ? ${dateClause}
          ORDER BY movement_date ASC`,
        [it.id, warehouseId, ...dateParams]);

      // Movements BEFORE `from` to back-compute opening from current_qty
      let opening = Number(it.current_qty) || 0;
      if (from) {
        const [pre] = await db.query(
          `SELECT type, COALESCE(SUM(qty),0) AS s
             FROM inventory_movements
            WHERE item_id = ? AND warehouse_id = ? AND DATE(movement_date) >= ?
            GROUP BY type`, [it.id, warehouseId, from]);
        // current_qty - (in - out) since `from` = opening
        let inSince = 0, outSince = 0;
        pre.forEach(r => { if (r.type==='in') inSince = Number(r.s); else outSince = Number(r.s); });
        opening = Number(it.current_qty) - (inSince - outSince);
      } else {
        opening = 0;  // full history view → start from zero
      }

      let inQty = 0, outQty = 0;
      lines.forEach(l => {
        if (l.type === 'in')  inQty  += Number(l.qty);
        else                  outQty += Number(l.qty);
      });

      // v5.10.29 — replay each movement from the opening balance to expose
      // a per-row running balance + value, the way an accounting ledger
      // expects. Also tag the line with a structured ref so the UI can
      // drill down (sale, transfer, stocktake, manual movement).
      const unitCost = Number(it.cost) || 0;
      let running = Number(opening) || 0;
      const enrichedLines = lines.map(function(l){
        const q = Number(l.qty) || 0;
        if (l.type === 'in') running += q;
        else                 running -= q;
        const refType = _classifyMovementRef(l.reason, l.notes);
        return {
          id: l.id,
          date: l.movement_date,
          type: l.type,
          qty: q,
          reason: l.reason || '',
          user:   l.username || '',
          notes:  l.notes || '',
          runningBalance: running,
          value: q * unitCost,                 // value of THIS line
          runningValue: running * unitCost,    // running ledger value
          refType: refType.type,
          refNumber: refType.number || ''
        };
      });

      result.push({
        itemId: it.id, name: it.name, unit: it.unit || '',
        cost: unitCost,
        firstAddedDate: it.first_added || null,
        opening,
        openingValue: (Number(opening) || 0) * unitCost,
        in: inQty, out: outQty,
        closing: opening + inQty - outQty,
        closingValue: (opening + inQty - outQty) * unitCost,
        lines: enrichedLines
      });
    }

    // v5.10.29 — period summary across all items in the warehouse, so the
    // UI can render a header strip showing total movement and value flow.
    const summary = result.reduce(function(acc, it){
      acc.totalIn        += it.in;
      acc.totalOut       += it.out;
      acc.openingValue   += it.openingValue;
      acc.closingValue   += it.closingValue;
      acc.itemsCount     += 1;
      acc.linesCount     += it.lines.length;
      return acc;
    }, { totalIn: 0, totalOut: 0, openingValue: 0, closingValue: 0, itemsCount: 0, linesCount: 0 });
    summary.netChange      = summary.totalIn - summary.totalOut;
    summary.netChangeValue = summary.closingValue - summary.openingValue;

    res.json({
      success: true,
      warehouse: { id: wh[0].id, name: wh[0].name, code: wh[0].code },
      from: from || null, to: to || null,
      summary,
      items: result
    });
  } catch(e) {
    console.error('[warehouse-ledger]', e);
    res.json({ success:false, error: e.message });
  }
});

// v5.10.31 — Chronological flat-list of every movement for a warehouse.
// Unlike /warehouse-ledger (grouped by item), this returns one row per
// movement across ALL items in time order, making it the canonical
// "everything that happened in this warehouse" view. Server-side
// pagination + every filter the UI needs.
//
// Query params:
//   warehouseId (required)
//   from, to            (optional — omit either side to mean "since
//                        beginning" / "until forever")
//   itemId              (filter to one item)
//   type                ('in' | 'out')
//   refType             ('sale' | 'transfer' | 'stocktake' | 'adjustment'
//                        | 'purchase' | 'waste' | 'opening' | 'manual')
//   user                (filter by username)
//   q                   (free-text on item_name / reason / notes)
//   limit (default 200, cap 5000), offset, paginated=1
//
// Response: { success, warehouse, summary, items: [...] }
//   each item: { id, date, itemId, itemName, type, qty, value, runningBalance,
//                runningValue, reason, refType, refNumber, user, notes, unitCost }
//   summary:   { total, totalIn, totalOut, valueIn, valueOut, netChange,
//                netValueChange, byRefType: { sale:N, transfer:N, ... },
//                byType: { in:N, out:N }, distinctItems, distinctUsers,
//                topItems: [{ itemId, itemName, count, qty }] }
router.get('/warehouse-ledger/all-movements', async (req, res) => {
  try {
    const warehouseId = req.query.warehouseId;
    if (!warehouseId) return res.status(400).json({ success:false, error:'warehouseId-required' });

    const [whs] = await db.query('SELECT id, name, code FROM warehouses WHERE id = ?', [warehouseId]);
    if (!whs.length) return res.status(404).json({ success:false, error:'warehouse-not-found' });
    const wh = whs[0];

    const where = ['m.warehouse_id = ?'];
    const params = [warehouseId];
    if (req.query.from)   { where.push('DATE(m.movement_date) >= ?'); params.push(req.query.from); }
    if (req.query.to)     { where.push('DATE(m.movement_date) <= ?'); params.push(req.query.to); }
    if (req.query.itemId) { where.push('m.item_id = ?');               params.push(req.query.itemId); }
    if (req.query.type)   { where.push('m.type = ?');                  params.push(req.query.type); }
    if (req.query.user)   { where.push('m.username = ?');              params.push(req.query.user); }
    if (req.query.q) {
      where.push('(m.item_name LIKE ? OR m.reason LIKE ? OR m.notes LIKE ?)');
      const pat = '%' + req.query.q + '%';
      params.push(pat, pat, pat);
    }
    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    const msc = req.whScopeClause('m.warehouse_id');
    if (msc.sql) { where.push(msc.sql.replace(/^\s*AND\s+/i, '')); params.push(...msc.params); }

    // refType is heuristic on reason/notes — apply post-fetch since the
    // classifier is JS. We push the SQL filter into the dataset.
    const reqRefType = req.query.refType || null;

    const limit  = Math.max(1, Math.min(Number(req.query.limit) || 200, 5000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const wantsPaginated = req.query.paginated === '1' || req.query.limit != null || req.query.offset != null;

    const whereSql = ' WHERE ' + where.join(' AND ');

    // Total count for pagination — note: refType is post-filter so the
    // reported total is accurate only when refType isn't set. When it is
    // set we can't easily count without scanning, so we cap at the page
    // and report a "filtered" hint.
    let totalRaw = 0;
    if (wantsPaginated) {
      const [c] = await db.query(
        'SELECT COUNT(*) AS total FROM inventory_movements m' + whereSql, params);
      totalRaw = Number((c[0] || {}).total) || 0;
    }

    // We need running per-item balance, so we fetch chronologically but
    // also need per-item qty up to (and including) each row. The clean
    // way: fetch all rows (or page) and replay.
    // For correctness of running balance ON THIS PAGE we need to know the
    // running per-item up to `offset`. We compute it once per item with a
    // single grouped query.
    const orderForward  = ' ORDER BY m.movement_date ASC, m.id ASC';
    const orderBackward = ' ORDER BY m.movement_date DESC, m.id DESC';

    // Page the user sees: most recent first
    const [rows] = await db.query(
      'SELECT m.*, COALESCE(i.cost, 0) AS unit_cost ' +
      'FROM inventory_movements m LEFT JOIN inv_items i ON i.id = m.item_id' +
      whereSql + orderBackward + ' LIMIT ? OFFSET ?',
      params.concat([limit, offset]));

    // For running balance we need: starting qty per item (= sum of qty
    // BEFORE the earliest row on this page). We compute that with one
    // bulk query for items that appear on the page.
    const distinctItemIds = Array.from(new Set(rows.map(r => r.item_id))).filter(Boolean);
    const runningStartByItem = {};
    if (distinctItemIds.length) {
      // Find the earliest row's date on the page
      let earliestDate = null;
      for (const r of rows) {
        if (!earliestDate || new Date(r.movement_date) < new Date(earliestDate)) {
          earliestDate = r.movement_date;
        }
      }
      // Sum qty for THIS warehouse, item IN (...), where movement_date
      // < earliest page row date, broken down by type.
      const ph = distinctItemIds.map(() => '?').join(',');
      const [agg] = await db.query(
        `SELECT item_id, type, COALESCE(SUM(qty), 0) AS s
           FROM inventory_movements
          WHERE warehouse_id = ? AND item_id IN (${ph}) AND movement_date < ?
          GROUP BY item_id, type`,
        [warehouseId].concat(distinctItemIds).concat([earliestDate]));
      const acc = {};
      for (const a of agg) {
        if (!acc[a.item_id]) acc[a.item_id] = 0;
        acc[a.item_id] += (a.type === 'in' ? Number(a.s) : -Number(a.s));
      }
      Object.assign(runningStartByItem, acc);
    }

    // Now replay the page in chronological order to compute per-row running.
    // Page came back DESC; sort ASC for replay, then re-reverse for display.
    const asc = rows.slice().sort(function(a, b){
      var d = new Date(a.movement_date) - new Date(b.movement_date);
      if (d !== 0) return d;
      return String(a.id).localeCompare(String(b.id));
    });
    const perItemRunning = Object.assign({}, runningStartByItem);
    const enrichedAsc = asc.map(function(r){
      var qty = Number(r.qty) || 0;
      var cost = Number(r.unit_cost) || 0;
      perItemRunning[r.item_id] = (perItemRunning[r.item_id] || 0) + (r.type === 'in' ? qty : -qty);
      var refMatch = _classifyMovementRef(r.reason, r.notes);
      return {
        id: r.id,
        date: r.movement_date,
        itemId: r.item_id,
        itemName: r.item_name,
        type: r.type,
        qty: qty,
        signedQty: r.type === 'out' ? -qty : qty,
        unitCost: cost,
        value: qty * cost,
        runningBalance: perItemRunning[r.item_id],
        runningValue: perItemRunning[r.item_id] * cost,
        reason: r.reason || '',
        refType: refMatch.type,
        refNumber: refMatch.number || '',
        user: r.username || '',
        notes: r.notes || ''
      };
    });
    // Apply refType filter post-classification (if any)
    const itemsAsc = reqRefType
      ? enrichedAsc.filter(x => x.refType === reqRefType)
      : enrichedAsc;

    const items = itemsAsc.slice().reverse();

    // Summary across the FULL filter (not just the page) — one query
    const [aggAll] = await db.query(
      `SELECT m.type, COALESCE(i.cost,0) AS unit_cost, m.reason, m.notes,
              m.username, m.item_id, m.item_name, m.qty
         FROM inventory_movements m LEFT JOIN inv_items i ON i.id = m.item_id` +
      whereSql + ' LIMIT 50000', params);
    const byType = { in: 0, out: 0 };
    const byRef  = { sale:0, transfer:0, stocktake:0, adjustment:0, purchase:0, waste:0, opening:0, manual:0 };
    let totalIn = 0, totalOut = 0, valueIn = 0, valueOut = 0;
    const userSet = {}, itemSet = {};
    const itemActivity = {}; // for top movers
    for (const r of aggAll) {
      const refKind = _classifyMovementRef(r.reason, r.notes).type;
      if (reqRefType && refKind !== reqRefType) continue;
      const q = Number(r.qty) || 0;
      const v = q * (Number(r.unit_cost) || 0);
      byType[r.type === 'in' ? 'in' : 'out']++;
      if (byRef[refKind] != null) byRef[refKind]++;
      if (r.type === 'in')  { totalIn  += q; valueIn  += v; }
      else                  { totalOut += q; valueOut += v; }
      if (r.username) userSet[r.username] = true;
      if (r.item_id)  itemSet[r.item_id] = true;
      if (r.item_id) {
        if (!itemActivity[r.item_id]) {
          itemActivity[r.item_id] = { itemId: r.item_id, itemName: r.item_name || r.item_id, count: 0, qty: 0 };
        }
        itemActivity[r.item_id].count++;
        itemActivity[r.item_id].qty += q;
      }
    }
    const topItems = Object.values(itemActivity)
      .sort(function(a, b){ return b.count - a.count; })
      .slice(0, 5);

    const summary = {
      total: items.length,
      totalRaw: totalRaw,
      totalIn, totalOut,
      valueIn, valueOut,
      netChange: totalIn - totalOut,
      netValueChange: valueIn - valueOut,
      byType, byRefType: byRef,
      distinctItems: Object.keys(itemSet).length,
      distinctUsers: Object.keys(userSet).length,
      topItems
    };

    if (wantsPaginated) {
      return res.json({
        success: true,
        warehouse: { id: wh.id, name: wh.name, code: wh.code },
        from: req.query.from || null, to: req.query.to || null,
        summary,
        items,
        limit, offset
      });
    }
    res.json({
      success: true,
      warehouse: { id: wh.id, name: wh.name, code: wh.code },
      from: req.query.from || null, to: req.query.to || null,
      summary,
      items
    });
  } catch (e) {
    console.error('[warehouse-ledger/all-movements]', e);
    res.status(500).json({ success:false, error: e.message });
  }
});

// v5.10.31 — Drill-down: detail of a specific inventory movement, with
// the source document hydrated when possible (sale invoice with items,
// transfer with from/to, stocktake variance). Returns whatever lookup
// matches the refType — gracefully degrades to just the movement row.
router.get('/warehouse-ledger/movement/:id', async (req, res) => {
  try {
    const movId = req.params.id;
    const [rows] = await db.query(
      'SELECT m.*, w.name AS warehouse_name, w.code AS warehouse_code, ' +
      '       COALESCE(i.cost, 0) AS unit_cost, i.unit, i.big_unit ' +
      '  FROM inventory_movements m ' +
      '  LEFT JOIN warehouses w ON w.id = m.warehouse_id ' +
      '  LEFT JOIN inv_items i  ON i.id = m.item_id ' +
      ' WHERE m.id = ? LIMIT 1', [movId]);
    if (!rows.length) return res.status(404).json({ success:false, error:'movement-not-found' });
    const m = rows[0];
    if (!req.guardWh(res, m.warehouse_id)) return;

    const ref = _classifyMovementRef(m.reason, m.notes);
    const detail = {
      id: m.id,
      date: m.movement_date,
      itemId: m.item_id,
      itemName: m.item_name,
      unit: m.unit || '',
      bigUnit: m.big_unit || '',
      type: m.type,
      qty: Number(m.qty) || 0,
      unitCost: Number(m.unit_cost) || 0,
      value: (Number(m.qty) || 0) * (Number(m.unit_cost) || 0),
      reason: m.reason || '',
      notes: m.notes || '',
      user: m.username || '',
      warehouseId: m.warehouse_id || '',
      warehouseName: m.warehouse_name || '',
      warehouseCode: m.warehouse_code || '',
      refType: ref.type,
      refNumber: ref.number || '',
      source: null
    };

    // Try to hydrate the source document
    try {
      if (ref.type === 'sale' && m.notes) {
        // notes was stamped with the orderId by sales.js
        const orderId = String(m.notes).split(/\s|\//)[0];
        const [s] = await db.query(
          'SELECT id, order_date, total_final, payment_method, username FROM sales WHERE id = ?', [orderId]);
        if (s.length) {
          const [si] = await db.query(
            'SELECT item_name, qty, price, total FROM sales_items WHERE order_id = ?', [orderId]);
          detail.source = {
            kind: 'sale',
            orderId: s[0].id, orderDate: s[0].order_date,
            total: Number(s[0].total_final) || 0,
            paymentMethod: s[0].payment_method || '',
            cashier: s[0].username || '',
            items: si.map(r => ({
              name: r.item_name, qty: Number(r.qty) || 0,
              price: Number(r.price) || 0, total: Number(r.total) || 0
            }))
          };
        }
      } else if (ref.type === 'transfer' && ref.number) {
        const [t] = await db.query(
          'SELECT t.*, fw.name AS from_name, tw.name AS to_name ' +
          '  FROM warehouse_transfers t ' +
          '  LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id ' +
          '  LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id ' +
          ' WHERE t.transfer_number = ? OR t.id = ? LIMIT 1', [ref.number, ref.number]);
        if (t.length) {
          detail.source = {
            kind: 'transfer',
            transferId: t[0].id,
            transferNumber: t[0].transfer_number,
            transferDate: t[0].transfer_date,
            fromWarehouseId: t[0].from_warehouse_id,
            fromWarehouseName: t[0].from_name || '',
            toWarehouseId: t[0].to_warehouse_id,
            toWarehouseName: t[0].to_name || '',
            status: t[0].status,
            notes: t[0].notes || '',
            items: JSON.parse(t[0].items_json || '[]')
          };
        }
      } else if (ref.type === 'stocktake' && ref.number) {
        const [st] = await db.query(
          'SELECT * FROM stocktakes WHERE id = ? LIMIT 1', [ref.number]);
        if (st.length) {
          detail.source = {
            kind: 'stocktake',
            stocktakeId: st[0].id,
            stocktakeDate: st[0].stocktake_date,
            username: st[0].username,
            notes: st[0].notes || '',
            itemsCount: Number(st[0].items_count) || 0,
            totalVariance: Number(st[0].total_variance) || 0
          };
        }
      } else if (ref.type === 'adjustment' && ref.number) {
        const [a] = await db.query(
          'SELECT * FROM stock_adjustments WHERE id = ? LIMIT 1', [ref.number]);
        if (a.length) {
          detail.source = {
            kind: 'adjustment',
            adjustmentId: a[0].id,
            adjustmentDate: a[0].adjustment_date,
            reason: a[0].reason,
            reasonNotes: a[0].reason_notes || '',
            username: a[0].username,
            status: a[0].status,
            totalCost: Number(a[0].total_cost) || 0
          };
        }
      }
    } catch (_) { /* best effort — fall back to the bare movement detail */ }

    res.json({ success: true, movement: detail });
  } catch (e) {
    res.status(500).json({ success:false, error: e.message });
  }
});

// v5.10.29 — Heuristic classifier mapping a movement's reason/notes to a
// structured reference type so the warehouse-ledger UI can render proper
// links (and so reports can group by reference type).
function _classifyMovementRef(reason, notes) {
  const txt = ((reason || '') + ' ' + (notes || '')).trim();
  if (/مبيعات|sale/i.test(txt))                   return { type: 'sale' };
  if (/تحويل|transfer/i.test(txt)) {
    const m = txt.match(/(WT-\d+|TR-\d+)/);
    return { type: 'transfer', number: m ? m[1] : '' };
  }
  if (/(جرد|stocktake)/i.test(txt)) {
    const m = txt.match(/(ST-\d+)/);
    return { type: 'stocktake', number: m ? m[1] : '' };
  }
  if (/(تعديل|adjustment|ADJ)/i.test(txt)) {
    const m = txt.match(/(ADJ-\d+)/);
    return { type: 'adjustment', number: m ? m[1] : '' };
  }
  if (/شراء|توريد|purchase|GRN/i.test(txt)) {
    const m = txt.match(/(PO-\d+|GRN-\d+)/);
    return { type: 'purchase', number: m ? m[1] : '' };
  }
  if (/تالف|هدر|waste|damage/i.test(txt)) return { type: 'waste' };
  if (/إضافة للمستودع|opening/i.test(txt)) return { type: 'opening' };
  return { type: 'manual' };
}

router.get('/live-report', async (req, res) => {
  try {
    const { brandId, warehouseId, category, startDate, endDate, q } = req.query;
    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    // Default period: last 30 days
    const endD   = endDate   ? new Date(endDate)   : new Date();
    const startD = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    // Normalize endD to end-of-day so movements on endDate are included
    endD.setHours(23, 59, 59, 999);

    // v5.10.8 — when scoped to a warehouse, surface its name + code in
    // the response so the frontend can show a banner above the table.
    let scopedWarehouse = null;
    if (warehouseId) {
      try {
        const [whs] = await db.query('SELECT id, name, code FROM warehouses WHERE id = ?', [warehouseId]);
        if (whs.length) scopedWarehouse = { id: whs[0].id, name: whs[0].name, code: whs[0].code };
      } catch(_) {}
    }

    let sql = 'SELECT i.*, b.name AS brand_name FROM inv_items i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.active = 1 AND i.deleted_at IS NULL';
    const params = [];
    if (brandId)   { sql += ' AND i.brand_id = ?'; params.push(brandId); }
    if (category)  { sql += ' AND i.category = ?'; params.push(category); }
    if (q)         { sql += ' AND (i.name LIKE ? OR i.id LIKE ?)'; params.push('%'+q+'%', '%'+q+'%'); }
    // v5.10.23 — TRUE per-warehouse independence: when scoped to one
    // warehouse, only show items that have real presence here (qty > 0
    // OR any movement history). Backfilled ghost rows (qty=0, no movements)
    // no longer leak the entire brand catalog into every warehouse view.
    if (warehouseId) {
      sql += ` AND (
        EXISTS(SELECT 1 FROM warehouse_stock ws
               WHERE ws.item_id = i.id AND ws.warehouse_id = ? AND ws.qty > 0)
        OR EXISTS(SELECT 1 FROM inventory_movements im
                  WHERE im.item_id = i.id AND im.warehouse_id = ?)
      )`;
      params.push(warehouseId, warehouseId);
    }
    sql += ' ORDER BY i.category, i.name';
    const [items] = await db.query(sql, params);

    if (!items.length) return res.json({ items: [], totals: _zeroTotals(), period: { startDate: startD, endDate: endD } });

    const itemIds = items.map(r => r.id);
    const placeholders = itemIds.map(() => '?').join(',');
    const lrsc = req.whScopeClause('warehouse_id');
    const whClause = (warehouseId ? ' AND warehouse_id = ?' : '') + lrsc.sql;
    const whParam  = (warehouseId ? [warehouseId] : []).concat(lrsc.params);

    // 1) All movements for these items AFTER startD (regardless of endD).
    //    Purpose: opening = current_stock − sum(net) of all movements after startD.
    //    closing = current_stock − sum(net) of all movements after endD.
    const [allRows] = await db.query(
      'SELECT item_id, type, SUM(qty) AS q FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') AND movement_date > ? ' + whClause +
      ' GROUP BY item_id, type',
      [...itemIds, startD, ...whParam]
    );
    const [postEndRows] = await db.query(
      'SELECT item_id, type, SUM(qty) AS q FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') AND movement_date > ? ' + whClause +
      ' GROUP BY item_id, type',
      [...itemIds, endD, ...whParam]
    );
    const [periodRows] = await db.query(
      'SELECT item_id, type, reason, SUM(qty) AS q FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') AND movement_date >= ? AND movement_date <= ? ' + whClause +
      ' GROUP BY item_id, type, reason',
      [...itemIds, startD, endD, ...whParam]
    );

    // V5.8.2 — PRO ANALYTICS: last movement date per item (any type) and
    //   daily in/out totals for the period (for the trend chart).
    const [lastMovRows] = await db.query(
      'SELECT item_id, MAX(movement_date) AS last_dt FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') ' + whClause +
      ' GROUP BY item_id',
      [...itemIds, ...whParam]
    );
    const [dailyTrend] = await db.query(
      'SELECT DATE(movement_date) AS day, type, SUM(qty) AS q FROM inventory_movements ' +
      'WHERE item_id IN (' + placeholders + ') AND movement_date >= ? AND movement_date <= ? ' + whClause +
      ' GROUP BY DATE(movement_date), type ORDER BY day',
      [...itemIds, startD, endD, ...whParam]
    );

    // Index helpers
    const netSinceStart = {}; // item_id → net (in - out) since startD
    allRows.forEach(r => {
      const sign = r.type === 'in' ? 1 : -1;
      netSinceStart[r.item_id] = (netSinceStart[r.item_id] || 0) + sign * Number(r.q || 0);
    });
    const netSinceEnd = {};   // item_id → net (in - out) after endD (used to compute closing)
    postEndRows.forEach(r => {
      const sign = r.type === 'in' ? 1 : -1;
      netSinceEnd[r.item_id] = (netSinceEnd[r.item_id] || 0) + sign * Number(r.q || 0);
    });

    // V5.8.9 — Cost-accountant bucketing.  Each movement reason maps to a
    //   distinct GL/management category so the report mirrors how a real
    //   cost accountant would analyze stock movement:
    //     purchases    → 1200 Inventory (debit)
    //     production   → 1300 WIP / charge to recipe cost (consumption)
    //     sales        → 5300 Cost of Goods Sold (direct sale)
    //     damaged      → 5310 Abnormal Loss / Spoilage
    //     adjustments  → 5320 Inventory Variance (admin/settlement)
    //     stocktake    → variance from physical count (also 5320)
    //     transferIn   → in from another warehouse (no GL impact at company level)
    //     transferOut  → out to another warehouse
    //   `consumed` (legacy) is kept as a SUM of production+sales+damage so
    //   existing UI that reads `consumedQty` keeps working.
    const byItem = {};
    function bucket(reason, type) {
      // CHECK MOST-SPECIFIC FIRST so e.g. "تالف" doesn't fall into "تسويات"
      // مبيعات comes BEFORE production so "مبيعات (نصف مصنع)" is treated as
      // a sale (its dominant intent) rather than production/WIP.
      if (/تالف|spoil|damage|broken/i.test(reason))                return 'damaged';
      if (/مشتريات|استلام|purchase|receive/i.test(reason))         return 'purchases';
      if (/مبيعات|sale/i.test(reason))                             return 'sales';
      if (/إنتاج|انتاج|production|نصف مصنع|semi/i.test(reason))    return 'production';
      if (/إداري|اداري|admin/i.test(reason))                       return 'adjustments';
      if (/تسويات|settlement|adjust/i.test(reason))                return 'adjustments';
      if (/تحويل|transfer/i.test(reason))                          return type === 'in' ? 'transferIn' : 'transferOut';
      if (/جرد|stocktake|variance/i.test(reason))                  return 'stocktake';
      // Unknown reason: treat by type
      return type === 'in' ? 'purchases' : 'sales';
    }
    periodRows.forEach(r => {
      if (!byItem[r.item_id]) byItem[r.item_id] = {
        purchases: 0, production: 0, sales: 0, damaged: 0,
        adjustments: 0, transferIn: 0, transferOut: 0, stocktake: 0
      };
      const b = bucket(r.reason, r.type);
      byItem[r.item_id][b] = (byItem[r.item_id][b] || 0) + Number(r.q || 0);
    });

    // V5.8.2 — Pro analytics: index last-movement + period length for aging.
    const lastMovMap = {};
    lastMovRows.forEach(r => { lastMovMap[r.item_id] = r.last_dt ? new Date(r.last_dt) : null; });
    const periodDays = Math.max(1, Math.ceil((endD - startD) / (24 * 3600 * 1000)));
    const SLOW_DAYS = 60;  // Items with no movement in 60+ days are "slow-moving"

    // v5.10.19 — When scoped to one warehouse, "current stock" must come
    // from warehouse_stock for THAT warehouse, not from inv_items.stock
    // (which is the sum across all warehouses). Without this, the live
    // report's opening/closing/value columns mixed the global rollup with
    // per-warehouse movement deltas — producing the figures the user saw
    // as "warehouses are mixed."
    const whStockMap = {};
    if (warehouseId && itemIds.length) {
      try {
        const [whRows] = await db.query(
          'SELECT item_id, qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id IN (' + placeholders + ')',
          [warehouseId, ...itemIds]
        );
        whRows.forEach(r => { whStockMap[r.item_id] = Number(r.qty) || 0; });
      } catch (_) { /* schema diff — fall back to global stock */ }
    }

    // Compute the per-item summary
    const totals = _zeroTotals();
    const result = items.map(i => {
      // Warehouse-scoped reports must read warehouse_stock; un-scoped
      // reports keep using the inv_items.stock rollup.
      const cur = warehouseId
        ? (whStockMap[i.id] !== undefined ? whStockMap[i.id] : 0)
        : (Number(i.stock) || 0);
      const opening = cur - (netSinceStart[i.id] || 0);
      const closing = cur - (netSinceEnd[i.id]   || 0);
      const b = byItem[i.id] || {
        purchases: 0, production: 0, sales: 0, damaged: 0,
        adjustments: 0, transferIn: 0, transferOut: 0, stocktake: 0
      };
      // V5.8.9 — legacy `consumed` = production + sales (everything that hits COGS/WIP)
      const consumed = b.production + b.sales;
      const cost = Number(i.cost) || 0;
      const value = closing * cost;
      let status = 'جيد';
      if (closing <= 0) status = 'نفد';
      else if (closing <= (Number(i.min_stock) || 0)) status = 'منخفض';

      // V5.8.2 — pro fields
      const lastMov = lastMovMap[i.id] || null;
      const daysSinceLastMov = lastMov ? Math.floor((Date.now() - lastMov.getTime()) / (24 * 3600 * 1000)) : null;
      const isSlowMoving = (daysSinceLastMov === null) || (daysSinceLastMov >= SLOW_DAYS);
      const isNegative   = closing < 0;
      // Reorder suggestion based on sales+production rate (true demand)
      const dailyConsumption = consumed / periodDays;
      const suggestedReorder = Math.max(0,
        Math.ceil(dailyConsumption * 14) - Math.max(0, closing)
      );
      const avgInventory = (opening + closing) / 2;
      const turnover = avgInventory > 0 ? (consumed / avgInventory) : 0;

      totals.openingValue     += opening * cost;
      totals.purchasesValue   += b.purchases * cost;
      totals.consumedValue    += consumed * cost;          // legacy total
      totals.productionValue  += b.production * cost;       // V5.8.9
      totals.salesValue       += b.sales * cost;            // V5.8.9
      totals.damagedValue     += b.damaged * cost;          // V5.8.9
      totals.adjustValue      += b.adjustments * cost;
      totals.closingValue     += value;
      totals.itemCount++;
      if (status === 'منخفض') totals.lowCount++;
      if (status === 'نفد')   totals.outCount++;
      if (isNegative)         totals.negativeCount++;
      if (isSlowMoving && closing > 0) totals.slowMovingCount++;
      if (suggestedReorder > 0)        totals.reorderCount++;
      if (b.damaged > 0)               totals.damagedCount++;

      return {
        id: i.id,
        name: i.name,
        category: i.category || '',
        unit: i.unit || 'حبة',
        bigUnit: i.big_unit || '',
        convRate: Number(i.conv_rate) || 1,
        cost: cost,
        minStock: Number(i.min_stock) || 0,
        brandId: i.brand_id || '',
        brandName: i.brand_name || '',
        openingStock: opening,
        purchasedQty: b.purchases,
        consumedQty:  consumed,         // legacy field (= production + sales)
        productionQty: b.production,    // V5.8.9 — separate
        salesQty:     b.sales,          // V5.8.9 — separate
        damagedQty:   b.damaged,        // V5.8.9 — separate
        adjustedQty:  b.adjustments,
        transferIn:   b.transferIn,
        transferOut:  b.transferOut,
        stocktakeQty: b.stocktake,
        closingStock: closing,
        value: value,
        status: status,
        lastMovementDate: lastMov,
        daysSinceLastMov: daysSinceLastMov,
        isSlowMoving: isSlowMoving && closing > 0,
        isNegative: isNegative,
        suggestedReorder: suggestedReorder,
        turnover: Math.round(turnover * 100) / 100,
        abcClass: ''
      };
    });

    // V5.8.2 — ABC classification (Pareto). Sort by value desc, mark first
    //   80% of cumulative value as A, next 15% as B, last 5% as C.
    const sortedByValue = result.slice().sort((a, b) => b.value - a.value);
    const totalValue = sortedByValue.reduce((s, x) => s + (x.value || 0), 0);
    let cumulative = 0;
    sortedByValue.forEach(x => {
      cumulative += x.value || 0;
      const pct = totalValue > 0 ? (cumulative / totalValue) : 0;
      x.abcClass = pct <= 0.80 ? 'A' : pct <= 0.95 ? 'B' : 'C';
    });
    // Aggregate ABC totals
    totals.abcA = sortedByValue.filter(x => x.abcClass === 'A').length;
    totals.abcB = sortedByValue.filter(x => x.abcClass === 'B').length;
    totals.abcC = sortedByValue.filter(x => x.abcClass === 'C').length;
    totals.abcAValue = sortedByValue.filter(x => x.abcClass === 'A').reduce((s, x) => s + (x.value || 0), 0);
    totals.abcBValue = sortedByValue.filter(x => x.abcClass === 'B').reduce((s, x) => s + (x.value || 0), 0);
    totals.abcCValue = sortedByValue.filter(x => x.abcClass === 'C').reduce((s, x) => s + (x.value || 0), 0);

    // V5.8.2 — Stock turnover (overall): consumption value / avg inventory value.
    totals.turnover = totals.openingValue > 0
      ? Math.round((totals.consumedValue / ((totals.openingValue + totals.closingValue) / 2 || 1)) * 100) / 100
      : 0;

    // V5.8.2 — Build a daily trend series for the period (in vs out).
    //   Returns an array of { day: 'YYYY-MM-DD', inQty, outQty, inValue, outValue }
    //   Quantities are summed; values use a weighted-average cost across all items.
    const avgCost = items.reduce((s, x) => s + (Number(x.cost) || 0), 0) / Math.max(1, items.length);
    const trendByDay = {};
    dailyTrend.forEach(r => {
      const day = r.day instanceof Date
        ? r.day.toISOString().slice(0, 10)
        : String(r.day).slice(0, 10);
      if (!trendByDay[day]) trendByDay[day] = { day, inQty: 0, outQty: 0, inValue: 0, outValue: 0 };
      const q = Number(r.q) || 0;
      if (r.type === 'in') {
        trendByDay[day].inQty += q;
        trendByDay[day].inValue += q * avgCost;
      } else {
        trendByDay[day].outQty += q;
        trendByDay[day].outValue += q * avgCost;
      }
    });
    // Fill missing days with zero (so the chart x-axis is continuous)
    const trend = [];
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      trend.push(trendByDay[key] || { day: key, inQty: 0, outQty: 0, inValue: 0, outValue: 0 });
    }

    res.json({
      items: result,
      totals: totals,
      trend: trend,
      period: { startDate: startD, endDate: endD, days: periodDays },
      scopedWarehouse: scopedWarehouse  // v5.10.8 — name+code when filter applied
    });
  } catch (e) {
    res.json({ error: e.message, items: [], totals: _zeroTotals(), trend: [] });
  }
});

function _zeroTotals() {
  return {
    itemCount: 0,
    lowCount: 0,
    outCount: 0,
    negativeCount:    0,
    slowMovingCount:  0,
    reorderCount:     0,
    damagedCount:     0,        // V5.8.9 — items with any damage in period
    openingValue:   0,
    purchasesValue: 0,
    consumedValue:  0,           // legacy: production + sales
    productionValue: 0,          // V5.8.9
    salesValue:     0,           // V5.8.9
    damagedValue:   0,           // V5.8.9 — abnormal loss expense
    adjustValue:    0,           // admin + settlement only
    closingValue:   0,
    abcA: 0, abcB: 0, abcC: 0,
    abcAValue: 0, abcBValue: 0, abcCValue: 0,
    turnover: 0
  };
}

// v5.10.8 — Per-item movement detail for the drill-down popup.
//
// Backwards compatible with V5.8.1 — adds:
//   • ?op=purchases|production|sales|damaged|adjustments|transferIn|
//        transferOut|stocktake|all (default: all). Server-side bucket
//        match identical to /live-report so the user sees only the
//        movements that contributed to the column they clicked.
//   • ?warehouseId — restricts to a single warehouse (matches the
//        scoped report).
//   • Each row carries warehouseName + (for transfers) fromWarehouseName
//        and toWarehouseName resolved from the warehouse_transfers blob
//        when reference_type='transfer' & reference_id is set.
//   • Reverse chronological order (DESC) — already enforced.
router.get('/live-report/:itemId/movements', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { startDate, endDate, op, warehouseId } = req.query;
    const opFilter = (op || 'all').toLowerCase();
    const endD   = endDate   ? new Date(endDate)   : new Date();
    const startD = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    endD.setHours(23, 59, 59, 999);

    // Match the /live-report bucketing rules (same regex set, same
    // priority order) so when the user clicks a cell, the rows match.
    // Order: damaged → purchases → SALES → production → ... so
    // "مبيعات (نصف مصنع)" lands in 'sales' (its dominant intent).
    function bucket(reason, type) {
      if (/تالف|spoil|damage|broken/i.test(reason))                return 'damaged';
      if (/مشتريات|استلام|purchase|receive/i.test(reason))         return 'purchases';
      if (/مبيعات|sale/i.test(reason))                             return 'sales';
      if (/إنتاج|انتاج|production|نصف مصنع|semi/i.test(reason))    return 'production';
      if (/إداري|اداري|admin/i.test(reason))                       return 'adjustments';
      if (/تسويات|settlement|adjust/i.test(reason))                return 'adjustments';
      if (/تحويل|transfer/i.test(reason))                          return type === 'in' ? 'transferIn' : 'transferOut';
      if (/جرد|stocktake|variance/i.test(reason))                  return 'stocktake';
      return type === 'in' ? 'purchases' : 'sales';
    }

    const params = [itemId, startD, endD];
    let sql =
      'SELECT m.id, m.movement_date, m.type, m.qty, m.reason, m.username, m.notes, ' +
      '       m.warehouse_id, m.reference_type, m.reference_id, ' +
      '       w.name AS warehouse_name, w.code AS warehouse_code ' +
      'FROM inventory_movements m ' +
      'LEFT JOIN warehouses w ON w.id = m.warehouse_id ' +
      'WHERE m.item_id = ? AND m.movement_date BETWEEN ? AND ?';
    if (warehouseId) { sql += ' AND m.warehouse_id = ?'; params.push(warehouseId); }
    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    const msc = req.whScopeClause('m.warehouse_id');
    if (msc.sql) { sql += msc.sql; params.push(...msc.params); }
    sql += ' ORDER BY m.movement_date DESC LIMIT 500';
    const [rows] = await db.query(sql, params);

    // Resolve transfer-pair details (from/to warehouse) for any movement
    // that references a warehouse_transfers row.
    const transferIds = rows
      .filter(r => r.reference_type === 'transfer' && r.reference_id)
      .map(r => r.reference_id);
    let transferMap = {};
    if (transferIds.length) {
      const placeholders = transferIds.map(() => '?').join(',');
      try {
        const [trs] = await db.query(
          'SELECT t.id, t.transfer_number, t.transfer_date, t.from_warehouse_id, t.to_warehouse_id, ' +
          '       wf.name AS from_name, wf.code AS from_code, ' +
          '       wt.name AS to_name,   wt.code AS to_code ' +
          'FROM warehouse_transfers t ' +
          'LEFT JOIN warehouses wf ON wf.id = t.from_warehouse_id ' +
          'LEFT JOIN warehouses wt ON wt.id = t.to_warehouse_id ' +
          'WHERE t.id IN (' + placeholders + ')',
          transferIds);
        trs.forEach(t => { transferMap[t.id] = t; });
      } catch(_) { /* table may not exist on older deploys */ }
    }

    // Resolve production-order date for production-related movements.
    const productionIds = rows
      .filter(r => r.reference_type === 'production' && r.reference_id)
      .map(r => r.reference_id);
    let productionMap = {};
    if (productionIds.length) {
      const placeholders = productionIds.map(() => '?').join(',');
      try {
        const [pos] = await db.query(
          'SELECT id, code, status, created_at FROM production_orders WHERE id IN (' + placeholders + ')',
          productionIds);
        pos.forEach(p => { productionMap[p.id] = p; });
      } catch(_) { /* table may not exist */ }
    }

    let mapped = rows.map(r => {
      const opBucket = bucket(r.reason || '', r.type);
      const out = {
        id: r.id,
        date: r.movement_date,
        type: r.type,
        qty:  Number(r.qty) || 0,
        reason: r.reason || '',
        username: r.username || '',
        notes: r.notes || '',
        op: opBucket,
        warehouseId: r.warehouse_id || '',
        warehouseName: r.warehouse_name || '',
        warehouseCode: r.warehouse_code || '',
        referenceType: r.reference_type || '',
        referenceId:   r.reference_id   || ''
      };
      if (out.referenceType === 'transfer' && transferMap[out.referenceId]) {
        const t = transferMap[out.referenceId];
        out.transferNumber  = t.transfer_number || '';
        out.transferDate    = t.transfer_date   || null;
        out.fromWarehouseId = t.from_warehouse_id || '';
        out.toWarehouseId   = t.to_warehouse_id   || '';
        out.fromWarehouseName = t.from_name || '';
        out.toWarehouseName   = t.to_name   || '';
      }
      if (out.referenceType === 'production' && productionMap[out.referenceId]) {
        const p = productionMap[out.referenceId];
        out.productionCode = p.code || '';
        out.productionDate = p.created_at || null;
      }
      return out;
    });

    if (opFilter !== 'all') {
      mapped = mapped.filter(r => r.op === opFilter);
    }
    res.json(mapped);
  } catch (e) {
    // G-INV M3 — was console.error + empty list; a DB failure is now a 500.
    console.error('[live-report movements]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.18 — Diagnostic: explain why an inventory item shows zero sales-movements
//
// For each sale in [startDate, endDate] containing a menu item that COULD have
// consumed this inv_item, returns a row with:
//   - orderId, orderDate, menuName, menuId, qty (sold)
//   - status: one of
//       'recorded'             — inventory_movements has a row for :itemId tied to this order
//       'different_warehouse'  — movement recorded but on a different warehouse_id
//       'skipped_semi'         — menu has consumes_semi_id; the semi was deducted, not :itemId
//       'no_recipe'            — menu has no legacy recipe and no active BOM
//       'recipe_excludes_item' — menu has a recipe/BOM but it doesn't reference :itemId
//       'unknown'              — fallback (data inconsistency)
//   - hint: short Arabic message for UI display
//
// Used by the empty-state in _invLiveShowDrillModal so the user gets a
// meaningful explanation instead of a blank "no transactions" message.
router.get('/live-report/:itemId/sales-trace', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { startDate, endDate, warehouseId } = req.query;
    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    const stsc = req.whScopeClause('m.warehouse_id');
    const endD   = endDate   ? new Date(endDate)   : new Date();
    const startD = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    endD.setHours(23, 59, 59, 999);

    // 1) Find every menu row potentially linked to :itemId.
    //    Three ways a menu can reference an inv_item:
    //      a) m.consumes_semi_id = :itemId  (the inv_item IS the semi)
    //      b) legacy recipe table has a row (menu_id, inv_item_id=:itemId)
    //      c) modern bom_lines (via menu.bom_id, b.is_active=1) has component_item_id=:itemId
    let candidateRows = [];
    try {
      const [rows] = await db.query(
        `SELECT m.id, m.name, m.consumes_semi_id,
                COALESCE(m.production_method, 'made_at_branch') AS production_method,
                m.bom_id,
                EXISTS(SELECT 1 FROM recipe r WHERE r.menu_id = m.id AND r.inv_item_id = ?) AS in_legacy,
                EXISTS(SELECT 1 FROM bom b JOIN bom_lines bl ON bl.bom_id = b.id
                       WHERE b.id = m.bom_id AND b.is_active = 1 AND bl.component_item_id = ?) AS in_bom,
                (SELECT COUNT(*) FROM recipe r WHERE r.menu_id = m.id) AS legacy_total,
                EXISTS(SELECT 1 FROM bom b WHERE b.id = m.bom_id AND b.is_active = 1) AS has_active_bom
         FROM menu m
         WHERE m.consumes_semi_id = ?
            OR EXISTS(SELECT 1 FROM recipe r WHERE r.menu_id = m.id AND r.inv_item_id = ?)
            OR EXISTS(SELECT 1 FROM bom b JOIN bom_lines bl ON bl.bom_id = b.id
                      WHERE b.id = m.bom_id AND b.is_active = 1 AND bl.component_item_id = ?)`,
        [itemId, itemId, itemId, itemId, itemId]);
      candidateRows = rows;
    } catch (_) {
      // bom/bom_lines tables may not exist on older deploys; fall back to legacy + semi only
      try {
        const [rows] = await db.query(
          `SELECT m.id, m.name, m.consumes_semi_id,
                  COALESCE(m.production_method, 'made_at_branch') AS production_method,
                  NULL AS bom_id,
                  EXISTS(SELECT 1 FROM recipe r WHERE r.menu_id = m.id AND r.inv_item_id = ?) AS in_legacy,
                  0 AS in_bom,
                  (SELECT COUNT(*) FROM recipe r WHERE r.menu_id = m.id) AS legacy_total,
                  0 AS has_active_bom
           FROM menu m
           WHERE m.consumes_semi_id = ?
              OR EXISTS(SELECT 1 FROM recipe r WHERE r.menu_id = m.id AND r.inv_item_id = ?)`,
          [itemId, itemId, itemId]);
        candidateRows = rows;
      } catch (e2) { return res.json({ candidates: [], sales: [], reason: 'schema_unavailable' }); }
    }

    if (!candidateRows.length) {
      return res.json({
        candidates: [],
        sales: [],
        reason: 'no_menu_uses_item',
        hint: 'لا يوجد أي منتج في القائمة يستهلك هذا الصنف عبر وصفة أو نصف-مصنع.'
      });
    }

    // Index by name for joining sales_items (which only stores item_name)
    const candidateByName = {};
    candidateRows.forEach(r => { candidateByName[r.name] = r; });
    const candidateNames = Object.keys(candidateByName);

    // 2) Pull every sales_items row in period whose item_name matches a candidate.
    let salesRows = [];
    if (candidateNames.length) {
      const placeholders = candidateNames.map(() => '?').join(',');
      try {
        const [rows] = await db.query(
          `SELECT order_id, order_date, item_name, qty
           FROM sales_items
           WHERE order_date BETWEEN ? AND ?
             AND item_name IN (${placeholders})
           ORDER BY order_date DESC
           LIMIT 200`,
          [startD, endD, ...candidateNames]);
        salesRows = rows;
      } catch (_) { salesRows = []; }
    }

    if (!salesRows.length) {
      return res.json({
        candidates: candidateRows,
        sales: [],
        reason: 'no_sales_in_period',
        hint: 'لم يُبَع أي منتج مرتبط بهذا الصنف خلال هذه الفترة.'
      });
    }

    // 3) Pull every inventory_movements row whose notes contain one of the order_ids.
    //    notes for raw-recipe path = orderId (exactly), for semi path = orderId + ' / ' + item.name.
    const orderIds = [...new Set(salesRows.map(r => r.order_id))];
    let movementRows = [];
    if (orderIds.length) {
      const orClauses = orderIds.map(() => 'm.notes LIKE ?').join(' OR ');
      const orParams = orderIds.map(id => '%' + id + '%');
      try {
        const [rows] = await db.query(
          `SELECT m.id, m.movement_date, m.item_id, m.qty, m.reason, m.warehouse_id, m.notes
           FROM inventory_movements m
           WHERE m.movement_date BETWEEN ? AND ?
             AND (${orClauses})` + stsc.sql,
          [startD, endD, ...orParams, ...stsc.params]);
        movementRows = rows;
      } catch (_) { movementRows = []; }
    }

    // Index movements by orderId → array of rows (an order may emit many movements)
    const movsByOrder = {};
    movementRows.forEach(m => {
      orderIds.forEach(oid => {
        if ((m.notes || '').indexOf(oid) >= 0) {
          if (!movsByOrder[oid]) movsByOrder[oid] = [];
          movsByOrder[oid].push(m);
        }
      });
    });

    // 4) Classify each sale.
    const sales = salesRows.map(s => {
      const cand = candidateByName[s.item_name];
      const movs = movsByOrder[s.order_id] || [];
      const movForItem = movs.find(m => m.item_id === itemId);
      const movForSemi = cand.consumes_semi_id
        ? movs.find(m => m.item_id === cand.consumes_semi_id)
        : null;

      let status, hint;
      if (movForItem) {
        if (warehouseId && movForItem.warehouse_id && movForItem.warehouse_id !== warehouseId) {
          status = 'different_warehouse';
          hint = 'الحركة مسجلة لكن في مستودع آخر — أزل فلتر المستودع لرؤيتها.';
        } else {
          status = 'recorded';
          hint = 'الحركة مسجلة فعلاً (يجب أن تظهر في تبويب المبيعات).';
        }
      } else if (cand.consumes_semi_id && movForSemi) {
        status = 'skipped_semi';
        hint = 'تم استهلاك نصف-مصنع بدلاً من هذا الصنف الخام — افحص حركات نصف-المصنع نفسه.';
      } else if (cand.consumes_semi_id) {
        status = 'skipped_semi';
        hint = 'هذا المنتج يستهلك نصف-مصنع وليس الصنف الخام — لذا لم تُسجَّل حركة لهذا الصنف.';
      } else if (!Number(cand.legacy_total) && !Number(cand.has_active_bom)) {
        status = 'no_recipe';
        hint = 'منتج "' + s.item_name + '" مُباع بدون أي وصفة فعّالة، لذا لم يُخصم أي مكوّن.';
      } else if (!Number(cand.in_legacy) && !Number(cand.in_bom)) {
        status = 'recipe_excludes_item';
        hint = 'وصفة "' + s.item_name + '" لا تتضمّن هذا الصنف بعد — راجع إعداد الوصفة.';
      } else {
        status = 'unknown';
        hint = 'حالة غير مفسَّرة — تحقق من سجلات الخادم.';
      }

      return {
        orderId: s.order_id,
        orderDate: s.order_date,
        menuName: s.item_name,
        menuId: cand.id,
        qty: Number(s.qty) || 0,
        consumesSemiId: cand.consumes_semi_id || null,
        productionMethod: cand.production_method,
        status,
        hint
      };
    });

    // Aggregate top-level reason — pick the most common status across sales
    const counts = {};
    sales.forEach(s => { counts[s.status] = (counts[s.status] || 0) + 1; });
    const topStatus = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'unknown';
    const topHint = sales.find(s => s.status === topStatus)?.hint || '';

    res.json({
      candidates: candidateRows,
      sales,
      reason: topStatus,
      hint: topHint,
      counts
    });
  } catch (e) {
    console.error('[live-report sales-trace]', e);
    res.json({ candidates: [], sales: [], reason: 'error', error: e.message });
  }
});

// ─── Stocktakes ───

// Submit a new stocktake: adjusts stock + records movements + persists the report
// G-INV — inventory.stocktake.create is seeded for cashier too (the POS
// stocktake screen posts here); see db/migrations/capability-seeds/g-inv.json.
router.post('/stocktakes', requireCapability('inventory.stocktake.create'), async (req, res) => {
  try {
    // v5.10.6 — accept user-supplied countDate so opening-balance
    // counts can be backdated to the actual physical-count date.
    // Falls back to "now" for live counts.
    const { items, notes, brandId, countDate } = req.body;
    let { warehouseId, branchId } = req.body;
    // Phase 0 §5 / G-INV M2 — count author STRICTLY from the JWT (the body
    // fallback was spoofable and is deleted; every caller is authenticated).
    const username = _actor(req);
    if (!items || !items.length) return res.json({ success: false, error: 'No items' });

    // RC — tracked items are counted via warehouse-v2 stocktakes (per-lot counting);
    // the legacy count-set write would bypass the lot ledger entirely.
    if (await _blockTrackedLegacy(db, items.map((x) => x && (x.id || x.itemId)), res)) return;

    // v5.10.35 — Resolve warehouse_id + branch_id from the user's profile
    // when the client didn't supply them (cashier POS sessions whose
    // state.warehouseId is empty would otherwise insert NULL — invisible
    // from any per-warehouse admin filter). This is the root cause of the
    // owner's complaint: "branch cashier did stocktakes but they don't
    // show in Octane".
    if ((!warehouseId || !branchId) && req.user) {
      try {
        const [u] = await db.query(
          'SELECT u.branch_id, u.default_warehouse_id, b.warehouse_id AS branch_warehouse_id ' +
          'FROM users u LEFT JOIN branches b ON b.id = u.branch_id ' +
          'WHERE u.username = ? LIMIT 1',
          [req.user.username || username]);
        if (u.length) {
          branchId    = branchId    || u[0].branch_id || null;
          warehouseId = warehouseId || u[0].default_warehouse_id || u[0].branch_warehouse_id || null;
        }
      } catch(_) { /* legacy schema — keep whatever client sent */ }
    }
    // Final guard: if STILL no warehouse, refuse the submission rather
    // than silently insert a NULL row that no admin filter will surface.
    if (!warehouseId) {
      return res.json({
        success: false,
        error: 'تعذّر تحديد المستودع: المستخدم ليس له default_warehouse_id ولا branch_id مرتبط بمستودع، والكاشير لم يُرسل warehouseId. حدّد المستودع من إعدادات المستخدم أو من واجهة الكاشير قبل الجرد.'
      });
    }
    // Scope: the resolved target warehouse must be in the caller's scope.
    if (!req.guardWh(res, warehouseId)) return;

    const now = countDate ? new Date(countDate) : new Date();
    const stId = 'ST-' + Date.now();
    let adjustedCount = 0;
    let totalVariance = 0;
    let totalGainCost = 0;    // surplus (diff > 0) at avg cost
    let totalLossCost = 0;    // shortage (diff < 0) at avg cost

    // Insert header with warehouse + branch reference
    await db.query(
      'INSERT INTO stocktakes (id, stocktake_date, username, notes, status, items_count, total_variance, warehouse_id, branch_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [stId, now, username || '', notes || '', 'completed', 0, 0, warehouseId, branchId || null]
    );

    // V5.8.5 — counted-but-matched items are RECORDED in stocktake_items
    //   for the audit trail (so a "no-variance" stocktake still writes a
    //   complete report) but skip the stock/movement/GL side-effects.
    let countedCount = 0;
    for (const item of items) {
      const itemId = item.id;
      const sysQty = Number(item.sys || item.systemQty) || 0;
      const actQty = Number(item.actual || item.actualQty) || 0;
      const diff = Number(item.diff) || (actQty - sysQty);

      // Get item info (needed for the audit row regardless of variance)
      const [inv] = await db.query('SELECT name, unit, COALESCE(cost,0) AS avg_cost FROM inv_items WHERE id = ?', [itemId]);
      const invName = inv.length ? inv[0].name : '';
      const invUnit = inv.length ? (inv[0].unit || '') : '';
      const invCost = inv.length ? (Number(inv[0].avg_cost) || 0) : 0;

      // Always record the line — proof that this item was reviewed.
      await db.query(
        'INSERT INTO stocktake_items (stocktake_id, inv_item_id, inv_item_name, unit, system_qty, actual_qty, variance) VALUES (?,?,?,?,?,?,?)',
        [stId, itemId, invName, invUnit, sysQty, actQty, diff]
      );
      countedCount++;

      // Skip the side-effects for items with no variance
      if (Math.abs(diff) < 0.001) continue;

      const varianceCost = Math.abs(diff) * invCost;
      if (diff > 0) totalGainCost += varianceCost;
      else          totalLossCost += varianceCost;

      // v5.10.19 — Stock writes are now warehouse-scoped: the user's count
      // applies ONLY to the warehouse they're counting; other warehouses'
      // stock is preserved. inv_items.stock becomes a derived rollup
      // (= SUM(warehouse_stock.qty)). Previous behavior overwrote the
      // global field with one warehouse's count, destroying others' data.
      if (warehouseId) {
        const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE qty = ?',
          [wsId, warehouseId, itemId, actQty, actQty]
        );
        await recomputeInvItemStock(db, itemId);
      } else {
        // Legacy fallback: no warehouse scope — overwrite global directly.
        await db.query('UPDATE inv_items SET stock = ? WHERE id = ?', [actQty, itemId]);
      }

      // Record movement with warehouse reference
      const movType = diff > 0 ? 'in' : 'out';
      const movQty = Math.abs(diff);
      const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [movId, now, itemId, invName, movType, movQty, 'جرد', username || '', 'ST: ' + stId, warehouseId || null]
      );

      totalVariance += diff;
      adjustedCount++;
    }

    // V5.8.5 — items_count = total counted (incl. matched), total_variance = sum of diffs.
    //   That way the audit list shows "12 صنف، 0 تباين" for a clean monthly check.
    await db.query(
      'UPDATE stocktakes SET items_count = ?, total_variance = ? WHERE id = ?',
      [countedCount, totalVariance, stId]
    );

    // Recompute menu costs since inventory changed
    try {
      const { recomputeAllMenuCosts } = require('./pricing-utils');
      await recomputeAllMenuCosts();
    } catch (e) {}

    // ═══ AUTO GL POSTING — Stock Count Variance ═══
    // Surplus: Dr Inventory / Cr Stock Gain (revenue)
    // Shortage: Dr Stock Variance Expense / Cr Inventory
    // We post ONE consolidated journal with both legs if both directions exist.
    let postingWarning = null;
    if (totalGainCost > 0 || totalLossCost > 0) {
      try {
        const gl = require('../lib/glPosting');
        const entries = [];
        if (totalGainCost > 0) {
          const g = Math.round(totalGainCost * 100) / 100;
          entries.push({ accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: g, credit: 0,
            description: 'Inventory surplus (stocktake)',
            branchId: branchId || null, brandId: brandId || null, warehouseId: warehouseId || null });
          entries.push({ accountCode: gl.CORE_ACCOUNTS.STOCK_GAIN.code, debit: 0, credit: g,
            description: 'Stock count gain',
            branchId: branchId || null, brandId: brandId || null });
        }
        if (totalLossCost > 0) {
          const l = Math.round(totalLossCost * 100) / 100;
          entries.push({ accountCode: gl.CORE_ACCOUNTS.STOCK_VARIANCE.code, debit: l, credit: 0,
            description: 'Inventory shortage (stocktake)',
            branchId: branchId || null, brandId: brandId || null });
          entries.push({ accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: 0, credit: l,
            description: 'Inventory reduction (stocktake)',
            branchId: branchId || null, brandId: brandId || null, warehouseId: warehouseId || null });
        }
        const post = await gl.postJournal(db, {
          journalDate: acctDate.journalDate(now),
          description: 'Stock count variance — ' + stId,
          referenceType: 'Stocktake',
          referenceId: stId,
          entries,
          postedBy: username || ''
        });
        if (!post.success) postingWarning = post.error;
      } catch(e) { postingWarning = e.message; }
    }

    res.json({
      success: true, stocktakeId: stId, adjustedCount,
      totalGainCost: Math.round(totalGainCost * 100) / 100,
      totalLossCost: Math.round(totalLossCost * 100) / 100,
      postingWarning
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get all stocktakes (list)
// v5.10.19 — accepts ?warehouseId= to scope the list to one warehouse, and
// joins warehouses so each row carries warehouse name/code for UI grouping.
// v5.10.29 — fromDate/toDate aliases + ?limit/?offset/?paginated=1.
router.get('/stocktakes', async (req, res) => {
  try {
    const where = [];
    const params = [];
    const from = req.query.fromDate || req.query.startDate;
    const to   = req.query.toDate   || req.query.endDate;
    // v5.10.39 — Tighter "match this warehouse" filter. Was previously
    // "warehouse_id = X OR IS NULL" (v5.10.37) which dumped EVERY orphan
    // into EVERY warehouse view — owner found that confusing. The fix
    // now matches:
    //   • Direct: stocktake.warehouse_id = X, OR
    //   • Implicit: stocktake.warehouse_id IS NULL but its branch.
    //     warehouse_id = X (i.e. the cashier worked at a branch tied
    //     to this warehouse but the row didn't save warehouse_id)
    // Orphans whose branch ALSO doesn't link to this warehouse stay
    // hidden; admin can find them via the "كل المستودعات" toggle.
    if (req.query.warehouseId) {
      where.push('(s.warehouse_id = ? OR (s.warehouse_id IS NULL AND br.warehouse_id = ?))');
      params.push(req.query.warehouseId, req.query.warehouseId);
    }
    // v5.10.32 — branchId filter so each branch's own list is fetchable
    // server-side. The owner wants to see "stocktakes done by branch X"
    // distinctly from the warehouse-level filter.
    if (req.query.branchId)    { where.push('s.branch_id = ?');            params.push(req.query.branchId); }
    if (from)                  { where.push('DATE(s.stocktake_date) >= ?'); params.push(from); }
    if (to)                    { where.push('DATE(s.stocktake_date) <= ?'); params.push(to); }
    if (req.query.status)      { where.push('s.status = ?');                params.push(req.query.status); }
    if (req.query.username)    { where.push('s.username = ?');              params.push(req.query.username); }
    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    const ssc = req.whScopeClause('s.warehouse_id');
    if (ssc.sql) { where.push(ssc.sql.replace(/^\s*AND\s+/i, '')); params.push(...ssc.params); }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

    const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 2000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const wantsPaginated = req.query.paginated === '1' || req.query.limit != null || req.query.offset != null;

    // v5.10.32 — JOIN branches so each row carries branch context the
    // UI can render in its own column.
    // v5.10.38 — Also JOIN through the branch to its linked warehouse so
    // we can fall back to the branch's warehouse name when the stocktake
    // row itself has warehouse_id=NULL. Pre-v5.10.35 cashier submissions
    // saved warehouse_id=NULL but had a valid branch_id; without this
    // fallback the UI showed "—" for the warehouse and the owner couldn't
    // tell where the cashier was working.
    const baseSelect =
      'SELECT s.*, ' +
      '       COALESCE(w.name, br_w.name) AS warehouse_name, ' +
      '       COALESCE(w.code, br_w.code) AS warehouse_code, ' +
      '       br.name AS branch_name, br.code AS branch_code, ' +
      '       (s.warehouse_id IS NULL AND br_w.id IS NOT NULL) AS warehouse_via_branch ' +
      'FROM stocktakes s ' +
      'LEFT JOIN warehouses w ON w.id = s.warehouse_id ' +
      'LEFT JOIN branches br ON br.id = s.branch_id ' +
      'LEFT JOIN warehouses br_w ON br_w.id = br.warehouse_id';
    const order = ' ORDER BY s.stocktake_date DESC, s.id DESC';

    let rows;
    try {
      [rows] = await db.query(baseSelect + whereSql + order + ' LIMIT ? OFFSET ?',
        params.concat([limit, offset]));
    } catch (_) {
      // Fallback for very old schemas without branches table or s.branch_id
      const legacySelect =
        'SELECT s.*, w.name AS warehouse_name, w.code AS warehouse_code, ' +
        '       NULL AS branch_name, NULL AS branch_code, 0 AS warehouse_via_branch ' +
        'FROM stocktakes s LEFT JOIN warehouses w ON w.id = s.warehouse_id';
      [rows] = await db.query(legacySelect + whereSql + order + ' LIMIT ? OFFSET ?',
        params.concat([limit, offset]));
    }
    const items = rows.map(s => ({
      id: s.id, date: s.stocktake_date, username: s.username, notes: s.notes,
      status: s.status, itemsCount: s.items_count, totalVariance: Number(s.total_variance),
      warehouseId: s.warehouse_id || '',
      warehouseName: s.warehouse_name || '',
      warehouseCode: s.warehouse_code || '',
      // v5.10.38 — flag rows whose warehouse name was derived from the
      // branch instead of saved directly on the stocktake. UI can show
      // this with a subtle hint ("from branch") so admins know it's an
      // orphan they may want to reassign.
      warehouseViaBranch: !!s.warehouse_via_branch,
      // v5.10.32 — surface branch context so the UI can show it
      branchId:   s.branch_id   || '',
      branchName: s.branch_name || '',
      branchCode: s.branch_code || ''
    }));

    if (wantsPaginated) {
      const [countRows] = await db.query('SELECT COUNT(*) AS total FROM stocktakes s' + whereSql, params);
      return res.json({ items, total: Number((countRows[0]||{}).total) || 0, limit, offset });
    }
    res.json(items);
  } catch (e) {
    // G-INV M3 — a DB failure is a 500, not a silent empty stocktake list.
    console.error('[inventory /stocktakes list]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get stocktake detail
router.get('/stocktakes/:id', async (req, res) => {
  try {
    const [headers] = await db.query('SELECT * FROM stocktakes WHERE id = ?', [req.params.id]);
    if (!headers.length) return res.json({ error: 'Not found' });
    const st = headers[0];
    if (!req.guardWh(res, st.warehouse_id)) return;
    const [items] = await db.query('SELECT si.*, COALESCE(inv.cost, 0) AS unit_cost FROM stocktake_items si LEFT JOIN inv_items inv ON si.inv_item_id = inv.id WHERE si.stocktake_id = ? ORDER BY si.id', [req.params.id]);
    var totalVarianceCost = 0;
    var mappedItems = items.map(i => {
      var variance = Number(i.variance);
      var unitCost = Number(i.unit_cost) || 0;
      var varianceCost = variance * unitCost; // negative = deficit
      totalVarianceCost += varianceCost;
      return {
        invItemId: i.inv_item_id, invItemName: i.inv_item_name, unit: i.unit,
        systemQty: Number(i.system_qty), actualQty: Number(i.actual_qty), variance: variance,
        unitCost: unitCost, varianceCost: varianceCost
      };
    });
    res.json({
      id: st.id, date: st.stocktake_date, username: st.username, notes: st.notes,
      status: st.status, itemsCount: st.items_count, totalVariance: Number(st.total_variance),
      totalVarianceCost: totalVarianceCost,
      items: mappedItems
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Delete stocktake — Phase 0 §6/§7/§8: managers only; a POSTED count (legacy
// 'completed' or stocktake-pro 'approved') can NEVER be deleted — it already
// moved stock + GL. Correct it with a new count/adjustment, not a delete.
// (The old route deleted any row with no auth and orphaned its items.)
router.delete('/stocktakes/:id', MGR, requireCapability('inventory.edit'), async (req, res) => {
  try {
    // Scope: guard on the stocktake's warehouse before any delete logic.
    try {
      const [wq] = await db.query('SELECT warehouse_id FROM stocktakes WHERE id = ?', [req.params.id]);
      if (wq.length && !req.guardWh(res, wq[0].warehouse_id)) return;
    } catch (_) {}
    let eff;
    try {
      const [st] = await db.query(
        'SELECT COALESCE(workflow_status, status) AS eff FROM stocktakes WHERE id = ?', [req.params.id]);
      if (!st.length) return res.json({ success: false, error: 'Not found' });
      eff = st[0].eff;
    } catch (_) {
      // Ultra-legacy schema without workflow_status — fall back to status.
      const [st] = await db.query('SELECT status AS eff FROM stocktakes WHERE id = ?', [req.params.id]);
      if (!st.length) return res.json({ success: false, error: 'Not found' });
      eff = st[0].eff;
    }
    if (!STK.canDelete(eff)) {
      return res.json({ success: false, code: 'STK_POSTED_NO_DELETE',
        error: 'لا يمكن حذف محضر جرد مُرحّل — صحّح الفرق بجرد/تسوية جديدة بدل الحذف.' });
    }
    await db.withTransaction(async (conn) => {
      await conn.query('DELETE FROM stocktake_items WHERE stocktake_id = ?', [req.params.id]);
      await conn.query('DELETE FROM stocktakes WHERE id = ?', [req.params.id]);
    });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── Stock Adjustments (تعديل كمية) ───

const REASON_LABELS = { damaged: 'تالف', admin: 'إداري', settlement: 'تسويات' };

// Create adjustment (draft — needs approval)
// G-INV — draft creation only (no stock/GL until the MGR approve below);
// inventory.adjustment.create mirrors the legacy matrix (employee/custody yes,
// cashier no) — see db/migrations/capability-seeds/g-inv.json.
router.post('/adjustments', requireCapability('inventory.adjustment.create'), async (req, res) => {
  try {
    const { items, reason, reasonNotes } = req.body;
    let { warehouseId, branchId } = req.body;
    // Phase 0 §5 / G-INV M2 — adjustment author STRICTLY from the JWT (the
    // spoofable body fallback is deleted).
    const username = _actor(req);
    if (!items || !items.length) return res.json({ success: false, error: 'No items' });

    // v5.10.39 — Resolve warehouseId + branchId from the user's profile
    // when the client didn't send them (parity with v5.10.35 stocktake
    // fix). The adjustment row keeps warehouse_id as a real FK so the
    // movement entry written at approval time can be scoped to a
    // warehouse — fixes the bug where adjustments had warehouse_id=NULL
    // and showed "—" in the admin view.
    if ((!warehouseId || !branchId) && req.user) {
      try {
        const [u] = await db.query(
          'SELECT u.branch_id, u.default_warehouse_id, b.warehouse_id AS branch_warehouse_id ' +
          'FROM users u LEFT JOIN branches b ON b.id = u.branch_id ' +
          'WHERE u.username = ? LIMIT 1',
          [req.user.username || username]);
        if (u.length) {
          branchId    = branchId    || u[0].branch_id || null;
          warehouseId = warehouseId || u[0].default_warehouse_id || u[0].branch_warehouse_id || null;
        }
      } catch(_) {}
    }
    // Scope: if a target warehouse is set (explicit or resolved), it must be in
    // the caller's scope.
    if (warehouseId && !req.guardWh(res, warehouseId)) return;

    const now = new Date();
    const adjId = 'ADJ-' + Date.now();
    // v7.1 — sequential human-readable document number (ADJ-YYYYMMDD-NNNN)
    let adjNumber = '';
    try { adjNumber = await nextDocNumber(db, 'ADJ'); } catch(_) { adjNumber = ''; }
    let totalCost = 0;

    // Insert header first (FK). Best-effort warehouse_id/branch_id +
    // adjustment_number columns — if the schema is older and lacks them,
    // fall back to the legacy column set.
    try {
      await db.query(
        'INSERT INTO stock_adjustments (id, adjustment_number, adjustment_date, reason, reason_notes, username, status, items_count, total_cost, warehouse_id, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [adjId, adjNumber || null, now, reason || 'damaged', reasonNotes || '', username || '', 'pending', 0, 0, warehouseId || null, branchId || null]
      );
    } catch (_) {
      await db.query(
        'INSERT INTO stock_adjustments (id, adjustment_date, reason, reason_notes, username, status, items_count, total_cost) VALUES (?,?,?,?,?,?,?,?)',
        [adjId, now, reason || 'damaged', reasonNotes || '', username || '', 'pending', 0, 0]
      );
    }

    for (const item of items) {
      const [inv] = await db.query('SELECT id, name, unit, stock, cost, conv_rate FROM inv_items WHERE id = ?', [item.id]);
      if (!inv.length) continue;
      const r = inv[0];
      const qty = Number(item.qty) || 0;
      if (qty <= 0) continue;
      const unitCost = Number(r.cost) || 0; // per small unit
      const lineCost = qty * unitCost;
      const stockBefore = Number(r.stock) || 0;
      const stockAfter = stockBefore - qty;

      await db.query(
        'INSERT INTO stock_adjustment_items (adjustment_id, inv_item_id, inv_item_name, unit, qty, unit_cost, total_cost, stock_before, stock_after) VALUES (?,?,?,?,?,?,?,?,?)',
        [adjId, r.id, r.name, r.unit || '', qty, unitCost, lineCost, stockBefore, stockAfter < 0 ? 0 : stockAfter]
      );
      totalCost += lineCost;
    }

    await db.query('UPDATE stock_adjustments SET items_count = ?, total_cost = ? WHERE id = ?',
      [items.length, totalCost, adjId]);

    res.json({ success: true, adjustmentId: adjId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Approve adjustment — actually deducts stock.
// Phase 0 — managers only (§6); actor from the JWT (§5); only a `pending`
// draft can be approved, no double-post (§6); and the stock deduction +
// ledger rows + a balanced GL journal + the status flip all commit inside
// ONE transaction (§9). GL failure is FATAL (rolls the whole approval back)
// except on a deploy whose GL tables don't exist yet.
router.post('/adjustments/:id/approve', MGR, requireCapability('inventory.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const username = _actor(req);
    const now = new Date();

    const [adj] = await db.query('SELECT * FROM stock_adjustments WHERE id = ?', [id]);
    if (!adj.length) return res.json({ success: false, error: 'Not found' });
    // Scope: the adjustment's own warehouse must be in the approver's scope.
    if (!req.guardWh(res, adj[0].warehouse_id)) return;
    // §6 — only a pending adjustment can be approved (never re-post an
    // already-approved one).
    if (!ADJ.canApprove(adj[0].status)) {
      return res.json({ success: false, code: 'ADJ_NOT_PENDING',
        error: 'لا يمكن اعتماد تعديل ليس في حالة "بانتظار" (pending). الحالة الحالية: ' + adj[0].status });
    }

    const [items] = await db.query('SELECT * FROM stock_adjustment_items WHERE adjustment_id = ?', [id]);
    const adjWarehouseId = adj[0].warehouse_id || null;
    const gl = require('../lib/glPosting');
    // Damaged goods hit the waste expense; admin/settlement corrections hit
    // the inventory-variance expense.
    const expenseCode = (adj[0].reason === 'damaged')
      ? gl.CORE_ACCOUNTS.WASTE_EXPENSE.code
      : gl.CORE_ACCOUNTS.STOCK_VARIANCE.code;

    await db.withTransaction(async (conn) => {
      let glValue = 0;
      for (const item of items) {
        // §9 — every write runs on the transaction connection.
        if (adjWarehouseId) {
          // v7.1 — atomic upsert-deduct: allows negative AND creates the row if
          // the item has none in this warehouse, so an over-deduction is never a
          // silent 0-rows loss — the true shortage is recorded.
          await deductWarehouseStock(conn, adjWarehouseId, item.inv_item_id, item.qty);
          try { await recomputeInvItemStock(conn, item.inv_item_id); } catch(_) {}
        } else {
          await conn.query('UPDATE inv_items SET stock = stock - ? WHERE id = ?', [item.qty, item.inv_item_id]);
        }

        glValue += Number(item.total_cost) || (Number(item.qty) * Number(item.unit_cost)) || 0;

        // v5.10.39 — movement WITH warehouse_id + reference_type/id so the
        // warehouse ledger can trace each row back to its ADJ- source.
        const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await conn.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [movId, now, item.inv_item_id, item.inv_item_name, 'out', item.qty,
           REASON_LABELS[adj[0].reason] || 'تعديل كمية', username, 'ADJ: ' + id,
           adjWarehouseId, 'adjustment', id]
        );
      }

      // §9 — balanced GL journal: Dr expense (waste/variance) / Cr Inventory.
      glValue = Math.round(glValue * 100) / 100;
      if (glValue > 0.005) {
        const glRes = await gl.postJournal(conn, {
          // Post into the adjustment's OWN business date (not the approval
          // wall-clock), so a back-dated adjustment lands in its real period.
          journalDate: acctDate.toAccountingDate(adj[0].adjustment_date || now),
          referenceType: 'adjustment',
          referenceId: id,
          description: 'تعديل مخزون (' + (REASON_LABELS[adj[0].reason] || adj[0].reason) + ') — ' + id,
          postedBy: username,
          entries: [
            { accountCode: expenseCode, debit: glValue, credit: 0,
              branchId: adj[0].branch_id || null, warehouseId: adjWarehouseId },
            { accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: 0, credit: glValue,
              branchId: adj[0].branch_id || null, warehouseId: adjWarehouseId }
          ]
        });
        if (!glRes || !glRes.success) {
          const perr = (glRes && glRes.error) || 'unknown';
          if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(perr)) {
            console.warn('[adjustment approve ' + id + '] GL skipped — gl tables absent:', perr);
          } else {
            throw new Error('فشل ترحيل قيد التعديل: ' + perr);
          }
        }
      }

      // §6 — state-guarded flip: a concurrent double-approve loses here and
      // rolls its own stock deduction + GL back.
      const [flip] = await conn.query(
        'UPDATE stock_adjustments SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ? AND status = "pending"',
        [username, now, id]
      );
      if (!flip || flip.affectedRows !== 1) {
        const e = new Error('تغيّرت حالة التعديل (اعتماد متزامن؟) — أعد التحميل');
        e.code = 'STATE_CHANGED'; throw e;
      }
    });

    // Recompute menu costs (best effort, after commit).
    try { const { recomputeAllMenuCosts } = require('./pricing-utils'); await recomputeAllMenuCosts(); } catch(e) {}

    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message, code: e.code }); }
});

// List adjustments
// v5.10.20 — accepts ?warehouseId, ?startDate, ?endDate, ?status, ?reason
// so the unified filter bar in the adjustments tab can scope server-side.
// Also returns warehouse_name when adjustments table has warehouse_id.
// v5.10.29 — fromDate/toDate aliases + ?limit/?offset/?paginated=1.
router.get('/adjustments', async (req, res) => {
  try {
    const where = [];
    const params = [];
    const from = req.query.fromDate || req.query.startDate;
    const to   = req.query.toDate   || req.query.endDate;
    // v5.10.39 — Same tighter rule as /stocktakes: match direct or
    // resolved-via-branch. Orphans not linked to this warehouse via
    // either path stay hidden until the show-all toggle is used.
    if (req.query.warehouseId) {
      where.push('(a.warehouse_id = ? OR (a.warehouse_id IS NULL AND br.warehouse_id = ?))');
      params.push(req.query.warehouseId, req.query.warehouseId);
    }
    // v5.10.32 — branchId filter for per-branch admin views.
    if (req.query.branchId)    { where.push('a.branch_id = ?');              params.push(req.query.branchId); }
    if (from)                  { where.push('DATE(a.adjustment_date) >= ?'); params.push(from); }
    if (to)                    { where.push('DATE(a.adjustment_date) <= ?'); params.push(to); }
    if (req.query.status)      { where.push('a.status = ?');                 params.push(req.query.status); }
    if (req.query.reason)      { where.push('a.reason = ?');                 params.push(req.query.reason); }
    if (req.query.username)    { where.push('a.username = ?');               params.push(req.query.username); }
    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    const asc = req.whScopeClause('a.warehouse_id');
    if (asc.sql) { where.push(asc.sql.replace(/^\s*AND\s+/i, '')); params.push(...asc.params); }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

    const limit  = Math.max(1, Math.min(Number(req.query.limit) || 200, 2000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const wantsPaginated = req.query.paginated === '1' || req.query.limit != null || req.query.offset != null;

    // v5.10.32 — JOIN branches so each row carries branch context.
    // v5.10.38 — fall back to branch.warehouse_id when a.warehouse_id
    // is NULL, same pattern as /stocktakes.
    const baseSelect =
      'SELECT a.*, ' +
      '       COALESCE(w.name, br_w.name) AS warehouse_name, ' +
      '       COALESCE(w.code, br_w.code) AS warehouse_code, ' +
      '       br.name AS branch_name, br.code AS branch_code, ' +
      '       (a.warehouse_id IS NULL AND br_w.id IS NOT NULL) AS warehouse_via_branch ' +
      'FROM stock_adjustments a ' +
      'LEFT JOIN warehouses w ON w.id = a.warehouse_id ' +
      'LEFT JOIN branches br ON br.id = a.branch_id ' +
      'LEFT JOIN warehouses br_w ON br_w.id = br.warehouse_id';
    const order = ' ORDER BY a.adjustment_date DESC, a.id DESC';

    let rows;
    let total = null;
    try {
      [rows] = await db.query(baseSelect + whereSql + order + ' LIMIT ? OFFSET ?',
        params.concat([limit, offset]));
      if (wantsPaginated) {
        const [c] = await db.query('SELECT COUNT(*) AS total FROM stock_adjustments a' + whereSql, params);
        total = Number((c[0]||{}).total) || 0;
      }
    } catch (_) {
      // Fallback for very old schemas without warehouse_id on stock_adjustments
      [rows] = await db.query('SELECT * FROM stock_adjustments ORDER BY adjustment_date DESC LIMIT ?', [limit]);
      rows = rows.map(r => Object.assign({}, r, {
        warehouse_name: null, warehouse_code: null, warehouse_via_branch: 0,
        branch_name: null, branch_code: null
      }));
    }
    const items = rows.map(a => ({
      id: a.id, date: a.adjustment_date, reason: a.reason,
      reasonLabel: REASON_LABELS[a.reason] || a.reason,
      reasonNotes: a.reason_notes, username: a.username,
      status: a.status, itemsCount: a.items_count,
      totalCost: Number(a.total_cost), approvedBy: a.approved_by, approvedAt: a.approved_at,
      warehouseId: a.warehouse_id || '',
      warehouseName: a.warehouse_name || '',
      warehouseCode: a.warehouse_code || '',
      warehouseViaBranch: !!a.warehouse_via_branch,
      // v5.10.32 — branch context surfaced on each row
      branchId:   a.branch_id   || '',
      branchName: a.branch_name || '',
      branchCode: a.branch_code || ''
    }));
    if (wantsPaginated) return res.json({ items, total: total || items.length, limit, offset });
    res.json(items);
  } catch (e) {
    // G-INV M3 — a DB failure is a 500, not a silent empty adjustments list.
    console.error('[inventory /adjustments list]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Detail
router.get('/adjustments/:id', async (req, res) => {
  try {
    const [headers] = await db.query('SELECT * FROM stock_adjustments WHERE id = ?', [req.params.id]);
    if (!headers.length) return res.json({ error: 'Not found' });
    const a = headers[0];
    if (!req.guardWh(res, a.warehouse_id)) return;
    const [items] = await db.query('SELECT * FROM stock_adjustment_items WHERE adjustment_id = ?', [req.params.id]);
    res.json({
      id: a.id, date: a.adjustment_date, reason: a.reason,
      reasonLabel: REASON_LABELS[a.reason] || a.reason,
      reasonNotes: a.reason_notes, username: a.username,
      status: a.status, itemsCount: a.items_count,
      totalCost: Number(a.total_cost), approvedBy: a.approved_by, approvedAt: a.approved_at,
      items: items.map(i => ({
        invItemId: i.inv_item_id, invItemName: i.inv_item_name, unit: i.unit,
        qty: Number(i.qty), unitCost: Number(i.unit_cost), totalCost: Number(i.total_cost),
        stockBefore: Number(i.stock_before), stockAfter: Number(i.stock_after)
      }))
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Delete adjustment — Phase 0 §6/§7: managers only; a POSTED (approved)
// adjustment can NEVER be hard-deleted — it already moved stock + GL, so the
// only correction is a documented reversal. Backend enforces this; the old
// "developer-only, checked on frontend" comment was not a security boundary.
router.delete('/adjustments/:id', MGR, requireCapability('inventory.edit'), async (req, res) => {
  try {
    const [adj] = await db.query('SELECT status, warehouse_id FROM stock_adjustments WHERE id = ?', [req.params.id]);
    if (!adj.length) return res.json({ success: false, error: 'Not found' });
    if (!req.guardWh(res, adj[0].warehouse_id)) return;
    if (!ADJ.canDelete(adj[0].status)) {
      return res.json({ success: false, code: 'ADJ_POSTED_NO_DELETE',
        error: 'لا يمكن حذف تعديل معتمد — استخدم عكسًا موثقًا بدل الحذف للحفاظ على سجل التدقيق.' });
    }
    // Cascade the line items (no FK CASCADE configured) inside one transaction.
    await db.withTransaction(async (conn) => {
      await conn.query('DELETE FROM stock_adjustment_items WHERE adjustment_id = ?', [req.params.id]);
      await conn.query('DELETE FROM stock_adjustments WHERE id = ?', [req.params.id]);
    });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// BRANCH RECEIVE (استلام المواد بالفرع)
// ═══════════════════════════════════════

// Submit receive request (cashier enters actual quantities)
// G-INV — inventory.requisition.create is seeded for cashier (this is the
// branch receive flow the cashier UI drives); the mutating approve below
// stays manager-level.
router.post('/receive-request', requireCapability('inventory.requisition.create'), async (req, res) => {
  try {
    const { purchaseId, items } = req.body;
    const username = _actor(req); // G-INV M2 — receiver identity from the JWT only
    if (!purchaseId || !items || !items.length) return res.json({ success: false, error: 'بيانات ناقصة' });

    // Per-user warehouse access: derive the purchase's warehouse and guard.
    try {
      const [pwh] = await db.query('SELECT warehouse_id FROM purchases WHERE id = ?', [purchaseId]);
      if (pwh.length && !req.guardWh(res, pwh[0].warehouse_id)) return;
    } catch(_) { /* legacy schema without warehouse_id — skip guard */ }

    // Save received items to the purchase
    await db.query(
      'UPDATE purchases SET received_items_json = ?, receive_status = "pending", received_by = ? WHERE id = ?',
      [JSON.stringify(items), username || '', purchaseId]
    );
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Get pending receive requests
router.get('/receive-requests', async (req, res) => {
  try {
    const rrsc = req.whScopeClause('p.warehouse_id');
    const [rows] = await db.query(
      `SELECT p.id, p.supplier_name, p.total_price, p.items_json, p.received_items_json, p.received_by, p.po_id, p.receive_status,
              po.po_number, po.supplier_name AS po_supplier
       FROM purchases p LEFT JOIN purchase_orders po ON p.po_id = po.id
       WHERE p.receive_status = 'pending'` + rrsc.sql + `
       ORDER BY p.purchase_date DESC`,
      [...rrsc.params]
    );
    res.json(rows.map(r => ({
      id: r.id, supplierName: r.supplier_name || r.po_supplier || '', totalPrice: Number(r.total_price),
      items: JSON.parse(r.items_json || '[]'), receivedItems: JSON.parse(r.received_items_json || '[]'),
      receivedBy: r.received_by, poId: r.po_id, poNumber: r.po_number || '', receiveStatus: r.receive_status
    })));
  } catch(e) {
    // G-INV M3 — a DB failure is a 500, not a silent empty receive queue.
    console.error('[inventory /receive-requests]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Approve receive — updates stock + creates GL journal
// v7.6 — GL posting rewritten onto gl.postJournal with CORE_ACCOUNTS. The old
// hand-rolled block targeted the pre-v5.11.8 chart: it debited '112%' as
// "inventory" (112 is Accounts Receivable in the current template — inventory
// lives under 113, core code 1200) and looked up Input VAT at '1430'/'213%'
// (Output-VAT's parent) instead of core 1290. Journal shape now matches
// purchases POST /receive/:id: Dr 1200 INVENTORY (+ Dr 1290 INPUT_VAT when
// VAT applies) / Cr 2100 AP — or Cash/Bank by payment method. The whole
// approve is ONE transaction (stock, movements, status flips, journal commit
// or roll back together); GL failure is FATAL except on deploys whose GL
// tables don't exist yet. FOR UPDATE serializes a double-approve.
router.post('/receive-approve/:id', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const username = _actor(req); // G-INV M2 — approver identity from the JWT only
    // The approve UI sends only {username} (now ignored) and this flow has always treated
    // prices as VAT-inclusive, so default true; callers may opt out with an
    // explicit includesVAT:false (same flag as purchases receive).
    const includesVAT = req.body.includesVAT !== false;

    // Per-user warehouse access: guard on the purchase's warehouse before
    // entering the (mutating) transaction so a denial is a clean 403.
    try {
      const [pwh] = await db.query('SELECT warehouse_id FROM purchases WHERE id = ?', [req.params.id]);
      if (pwh.length && !req.guardWh(res, pwh[0].warehouse_id)) return;
    } catch(_) { /* legacy schema without warehouse_id — skip guard */ }

    // RC — tracked items cannot be received via the legacy approve path (it has
    // no lot capture); use the warehouse-v2 receipt instead. Checked BEFORE the
    // transaction so a rejection creates no partial stock or movement.
    try {
      const [pr] = await db.query('SELECT received_items_json FROM purchases WHERE id = ?', [req.params.id]);
      const ri = pr.length ? JSON.parse(pr[0].received_items_json || '[]') : [];
      if (await _blockTrackedLegacy(db, ri.map((x) => x && (x.invItemId || x.id)), res)) return;
    } catch(_) { /* unparsable legacy payload — the transaction below validates it */ }

    const out = await db.withTransaction(async (conn) => {
      const db = conn;

      const [purchases] = await db.query('SELECT * FROM purchases WHERE id = ? AND receive_status = "pending" FOR UPDATE', [req.params.id]);
      if (!purchases.length) throw new Error('طلب الاستلام غير موجود أو تم اعتماده بالفعل');

      const purchase = purchases[0];
      const receivedItems = JSON.parse(purchase.received_items_json || '[]');
      if (!receivedItems.length) throw new Error('لا توجد مواد مستلمة');

      const now = new Date();
      let totalNet = 0, totalVat = 0;

      // Process each received item — update stock
      for (const item of receivedItems) {
        const qty = Number(item.receivedQty) || 0;
        if (qty <= 0) continue;

        const [invRows] = await db.query('SELECT * FROM inv_items WHERE id = ?', [item.invItemId || item.id]);
        if (!invRows.length) continue;
        const inv = invRows[0];

        const unitPrice = Number(item.unitPrice) || Number(inv.cost) || 0;
        const netPrice = includesVAT ? unitPrice / 1.15 : unitPrice;
        const vatAmount = unitPrice - netPrice;

        // WAC
        const stockBefore = Number(inv.stock) || 0;
        const currentCost = Number(inv.cost) || 0;
        let newCost = stockBefore === 0 ? netPrice : ((stockBefore * currentCost) + (qty * netPrice)) / (stockBefore + qty);

        // v7.1 — warehouse-aware receive: add to warehouse_stock for the purchase's
        // warehouse (atomic upsert) + recompute the global rollup, so the received
        // qty is visible per-branch and inv_items.stock stays = SUM(warehouse_stock).
        // Falls back to the legacy global write only when no warehouse is stamped.
        const rcvWh = purchase.warehouse_id || null;
        if (rcvWh) {
          await db.query(
            'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost, last_updated) VALUES (?,?,?,?,?,?,NOW()) ' +
            'ON DUPLICATE KEY UPDATE qty = qty + ?, avg_cost = ?, last_cost = ?, last_updated = NOW()',
            ['WS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), rcvWh, inv.id, qty, newCost, netPrice, qty, newCost, netPrice]);
          await recomputeInvItemStock(db, inv.id);
          await db.query('UPDATE inv_items SET cost = ? WHERE id = ?', [newCost, inv.id]);
        } else {
          await db.query('UPDATE inv_items SET stock = stock + ?, cost = ? WHERE id = ?', [qty, newCost, inv.id]);
        }

        // Record movement (with warehouse_id so the per-warehouse ledger shows it)
        const movId = 'MOV-RCV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [movId, now, inv.id, inv.name, 'in', qty, 'استلام نقص', username || '', 'PUR:' + req.params.id, rcvWh]
        );

        totalNet += netPrice * qty;
        totalVat += vatAmount * qty;
      }

      // Record differences in PO notes
      const originalItems = JSON.parse(purchase.items_json || '[]');
      let diffNotes = '';
      receivedItems.forEach(function(ri) {
        const orig = originalItems.find(function(o) { return (o.id||o.itemId) === (ri.invItemId||ri.id); });
        const ordered = orig ? (Number(orig.qty)||0) : 0;
        const received = Number(ri.receivedQty) || 0;
        const diff = received - ordered;
        if (diff !== 0) {
          diffNotes += (ri.invItemName||ri.name||'') + ' — Ordered ' + ordered + ' — Received ' + received + ' — Diff ' + (diff>0?'+':'') + diff + '\n';
        }
      });

      // Check if partial or full receive
      const allReceived = receivedItems.every(function(ri) {
        const orig = originalItems.find(function(o) { return (o.id||o.itemId) === (ri.invItemId||ri.id); });
        return (Number(ri.receivedQty)||0) >= (orig ? Number(orig.qty)||0 : 0);
      });

      // Update purchase status
      await db.query('UPDATE purchases SET status = "received", receive_status = "approved", receive_approved_by = ? WHERE id = ?', [username || '', req.params.id]);
      if (purchase.po_id) {
        const poStatus = allReceived ? 'received' : 'partially_received';
        await db.query('UPDATE purchase_orders SET status = ? WHERE id = ?', [poStatus, purchase.po_id]);
        // Save differences in PO notes
        if (diffNotes) {
          await db.query('UPDATE purchase_orders SET notes = CONCAT(COALESCE(notes,""), ?) WHERE id = ?', ['\n--- فروقات الاستلام ---\n' + diffNotes, purchase.po_id]);
        }
      }

      // Update linked shortage request status
      if (purchase.po_id) {
        const shrStatus = allReceived ? 'fully_received' : 'partially_received';
        await db.query("UPDATE shortage_requests SET status = ? WHERE po_id = ?", [shrStatus, purchase.po_id]);
      }

      // ─── GL: Dr INVENTORY (net) [+ Dr INPUT_VAT] / Cr Cash|Bank|AP ───
      // Same pattern as purchases receive: credit routed by payment_method
      // ('آجل' default → AP). referenceType 'PurchaseReceipt' so the purchases
      // revert flow finds and reverses this journal too.
      const gl = require('../lib/glPosting');
      const _r2 = v => Math.round((Number(v) || 0) * 100) / 100;
      const glNet = _r2(totalNet);
      const glVat = _r2(totalVat);
      let journalNumber = '';
      if (glNet > 0.005) {
        const pm = String(purchase.payment_method || '').toLowerCase();
        let creditCode = gl.CORE_ACCOUNTS.AP.code;
        if (/cash|نقد|كاش/.test(pm)) creditCode = gl.CORE_ACCOUNTS.CASH.code;
        else if (/transfer|تحويل|بنك|bank/.test(pm)) creditCode = gl.CORE_ACCOUNTS.BANK.code;

        const desc = 'استلام مواد — ' + (purchase.supplier_name || '');
        const entries = [{
          accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: glNet, credit: 0,
          description: desc,
          warehouseId: purchase.warehouse_id || null,
          brandId: purchase.brand_id || null, branchId: purchase.branch_id || null
        }];
        if (glVat > 0) {
          entries.push({
            accountCode: gl.CORE_ACCOUNTS.INPUT_VAT.code, debit: glVat, credit: 0,
            description: 'ضريبة مدخلات — ' + desc,
            brandId: purchase.brand_id || null, branchId: purchase.branch_id || null
          });
        }
        entries.push({
          accountCode: creditCode, debit: 0, credit: _r2(glNet + glVat),
          description: 'مقابل ' + desc,
          brandId: purchase.brand_id || null, branchId: purchase.branch_id || null
        });

        const post = await gl.postJournal(db, {
          journalDate: acctDate.journalDate(now),
          description: desc,
          referenceType: 'PurchaseReceipt',
          referenceId: req.params.id,
          entries,
          postedBy: username || ''
        });
        if (!post || !post.success) {
          const perr = (post && post.error) || 'unknown';
          if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(perr)) {
            console.warn('[receive-approve ' + req.params.id + '] GL skipped — gl tables absent:', perr);
          } else {
            throw new Error('GL_POSTING_FAILED: ' + perr);
          }
        } else {
          journalNumber = post.journalNumber || '';
        }
      }

      return { journalNumber, totalNet: glNet, totalVat: glVat, totalGross: _r2(glNet + glVat) };
    });

    res.json({ success: true, journalNumber: out.journalNumber, totalNet: out.totalNet, totalVat: out.totalVat, totalGross: out.totalGross });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// SHORTAGE REQUESTS (طلبات النواقص)
// ═══════════════════════════════════════

// close2/requisitions-fix — ownership gate for shortage requests. A non-approver
// (plain cashier) may only see/act on the requests THEY created; a holder of
// purchasing.requisitions.approve (the approve/reject/convert capability) keeps
// full warehouse-scoped visibility. hasCapability fails closed; admin bypasses.
async function _shrIsApprover(req) {
  try { return await requireCapability.hasCapability(req.user, 'purchasing.requisitions.approve'); }
  catch (_) { return false; }
}

// Create shortage request (from cashier)
// G-INV — inventory.requisition.create is seeded for cashier (this is the POS
// shortage-request screen); see db/migrations/capability-seeds/g-inv.json.
router.post('/shortage-requests', requireCapability('inventory.requisition.create'), async (req, res) => {
  try {
    const { items, notes, branchId, brandId } = req.body;
    let { warehouseId } = req.body;
    const username = _actor(req); // G-INV M2 — requester identity from the JWT only
    if (!items || !items.length) return res.json({ success: false, error: 'أضف مادة واحدة على الأقل' });

    // Auto-resolve brand/branch AND warehouse from the requester's HR profile when
    // the client didn't supply them. close2 Fix 1 — warehouse_id must NEVER become a
    // silent NULL (invisible to every per-warehouse admin filter); this mirrors the
    // stocktake route's resolution (users.default_warehouse_id → branches.warehouse_id).
    let resolvedBrandId = brandId || null;
    let resolvedBranchId = branchId || null;
    if ((!resolvedBrandId || !resolvedBranchId || !warehouseId) && username) {
      try {
        const [u] = await db.query(
          'SELECT u.brand_id, u.branch_id, u.default_warehouse_id, b.warehouse_id AS branch_warehouse_id ' +
          'FROM users u LEFT JOIN branches b ON b.id = u.branch_id ' +
          'WHERE u.username = ? LIMIT 1',
          [username]);
        if (u.length) {
          resolvedBrandId  = resolvedBrandId  || u[0].brand_id  || null;
          resolvedBranchId = resolvedBranchId || u[0].branch_id || null;
          warehouseId = warehouseId || u[0].default_warehouse_id || u[0].branch_warehouse_id || null;
        }
      } catch (_) { /* legacy schema — keep whatever the client sent */ }
    }

    // close2 Fix 1 — refuse rather than insert a NULL warehouse (matches the
    // stocktake route's 422 style). Runs BEFORE guardWh so the message is precise.
    if (!warehouseId) {
      return res.status(422).json({ code: 'VALIDATION_ERROR', error: 'تعذّر تحديد المستودع — تحقق من إعدادات حسابك' });
    }
    // Scope: the resolved target warehouse must be in the caller's scope.
    if (!req.guardWh(res, warehouseId)) return;

    // close2 Fix 3+4 — header + all lines in ONE transaction, with a race-free
    // document number from the atomic doc_counters (nextDocNumber) instead of the
    // old last-row/MAX+1 read. A mid-request failure rolls the header back too, so a
    // header with zero lines can never persist. id is collision-resistant (random
    // suffix) so N truly-parallel creates never clash on the primary key either.
    const requestDate = new Date();
    const out = await db.withTransaction(async (conn) => {
      const requestNumber = await nextDocNumber(conn, 'SHR', requestDate);
      const id = 'SHR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      await conn.query(
        'INSERT INTO shortage_requests (id, request_number, request_date, username, notes, total_items, branch_id, warehouse_id, brand_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, requestNumber, requestDate, username || '', notes || '', items.length, resolvedBranchId, warehouseId, resolvedBrandId]
      );
      for (const item of items) {
        const itemId = 'SHRI-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        await conn.query(
          'INSERT INTO shortage_items (id, request_id, inv_item_id, inv_item_name, unit, current_qty, min_qty, requested_qty, unit_price) VALUES (?,?,?,?,?,?,?,?,?)',
          [itemId, id, item.invItemId || '', item.invItemName || '', item.unit || '', item.currentQty || 0, item.minQty || 0, item.requestedQty || 0, item.unitPrice || 0]
        );
      }
      return { id, requestNumber };
    });

    res.json({ success: true, id: out.id, requestNumber: out.requestNumber, brandId: resolvedBrandId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get shortage requests (brand-aware)
// v5.10.20 — added startDate/endDate filters so the unified filter bar can
// scope the list server-side instead of fetching everything every time.
router.get('/shortage-requests', async (req, res) => {
  try {
    const { brandId, status, branchId, startDate, endDate } = req.query;
    let sql = `SELECT r.*, b.name AS brand_name, br.name AS branch_name
               FROM shortage_requests r
               LEFT JOIN brands b ON b.id = r.brand_id
               LEFT JOIN branches br ON br.id = r.branch_id
               WHERE 1=1`;
    const params = [];
    if (brandId)   { sql += ' AND r.brand_id = ?';            params.push(brandId); }
    if (status)    { sql += ' AND r.status = ?';              params.push(status); }
    if (branchId)  { sql += ' AND r.branch_id = ?';           params.push(branchId); }
    if (startDate) { sql += ' AND DATE(r.request_date) >= ?'; params.push(startDate); }
    if (endDate)   { sql += ' AND DATE(r.request_date) <= ?'; params.push(endDate); }
    // close2 Fix 2 — a non-approver sees ONLY their own requests (server-enforced,
    // not merely the client-side filter in RequisitionsDialog). Approvers keep the
    // full warehouse-scoped list.
    if (!(await _shrIsApprover(req))) { sql += ' AND r.username = ?'; params.push(_actor(req)); }
    if (req.query.warehouseId && !req.guardWh(res, req.query.warehouseId)) return;
    const ssc = req.whScopeClause('r.warehouse_id');
    if (ssc.sql) { sql += ssc.sql; params.push(...ssc.params); }
    sql += ' ORDER BY r.created_at DESC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, requestNumber: r.request_number, requestDate: r.request_date,
      username: r.username, notes: r.notes, status: r.status,
      supplyMode: r.supply_mode, totalItems: r.total_items,
      approvedBy: r.approved_by, approvedAt: r.approved_at, poId: r.po_id,
      brandId: r.brand_id || '', brand_id: r.brand_id || '', brandName: r.brand_name || '',
      branchId: r.branch_id || '', branchName: r.branch_name || ''
    })));
  } catch (e) {
    // G-INV M3 — a DB failure is a 500, not a silent empty shortage list.
    console.error('[inventory /shortage-requests list]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get single shortage request with items
router.get('/shortage-requests/:id', async (req, res) => {
  try {
    const [reqs] = await db.query('SELECT * FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!reqs.length) return res.json({ error: 'Not found' });
    const r = reqs[0];
    if (!req.guardWh(res, r.warehouse_id)) return;
    // close2 Fix 2 — a non-approver may only view their OWN request.
    if (r.username !== _actor(req) && !(await _shrIsApprover(req))) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED' });
    }
    const [items] = await db.query('SELECT * FROM shortage_items WHERE request_id = ?', [req.params.id]);
    res.json({
      id: r.id, requestNumber: r.request_number, requestDate: r.request_date,
      username: r.username, notes: r.notes, status: r.status,
      supplyMode: r.supply_mode, totalItems: r.total_items,
      approvedBy: r.approved_by, poId: r.po_id,
      items: items.map(i => ({
        id: i.id, invItemId: i.inv_item_id, invItemName: i.inv_item_name,
        unit: i.unit, currentQty: Number(i.current_qty), minQty: Number(i.min_qty),
        requestedQty: Number(i.requested_qty), unitPrice: Number(i.unit_price)
      }))
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Approve shortage request
router.post('/shortage-requests/:id/approve', requireCapability('purchasing.requisitions.approve'), async (req, res) => {
  try {
    const { supplyMode } = req.body;
    const username = _actor(req); // G-INV M2 — approver identity from the JWT only
    const [sr] = await db.query('SELECT warehouse_id FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!sr.length) return res.json({ success: false, error: 'الطلب غير موجود' });
    if (!req.guardWh(res, sr[0].warehouse_id)) return;
    await db.query('UPDATE shortage_requests SET status = "approved", approved_by = ?, approved_at = ?, supply_mode = ? WHERE id = ?',
      [username || '', new Date(), supplyMode || 'parent_company', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Reject shortage request
router.post('/shortage-requests/:id/reject', requireCapability('purchasing.requisitions.approve'), async (req, res) => {
  try {
    const { reason } = req.body;
    const username = _actor(req); // G-INV M2 — actor from the JWT only
    const [sr] = await db.query('SELECT warehouse_id FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!sr.length) return res.json({ success: false, error: 'الطلب غير موجود' });
    if (!req.guardWh(res, sr[0].warehouse_id)) return;
    const rejectNote = '\n[رفض: ' + (reason || 'بدون سبب') + ']';
    await db.query('UPDATE shortage_requests SET status = "rejected", approved_by = ?, approved_at = ?, notes = CONCAT(COALESCE(notes,""), ?) WHERE id = ?',
      [username || '', new Date(), rejectNote, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update pending shortage request (branch manager can edit before approval)
router.put('/shortage-requests/:id', requireCapability('inventory.requisition.create'), async (req, res) => {
  try {
    const { items, notes } = req.body;
    const [reqs] = await db.query('SELECT status, warehouse_id, username FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!reqs.length) return res.json({ success: false, error: 'الطلب غير موجود' });
    if (!req.guardWh(res, reqs[0].warehouse_id)) return;
    // close2 Fix 2 — a non-approver may only edit their OWN request.
    if (reqs[0].username !== _actor(req) && !(await _shrIsApprover(req))) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED' });
    }
    if (reqs[0].status !== 'pending') return res.json({ success: false, error: 'فقط الطلبات المعلقة يمكن تعديلها' });
    if (!items || !items.length) return res.json({ success: false, error: 'أضف مادة واحدة على الأقل' });

    // Delete old items and insert new ones
    await db.query('DELETE FROM shortage_items WHERE request_id = ?', [req.params.id]);
    for (const item of items) {
      const itemId = 'SHRI-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO shortage_items (id, request_id, inv_item_id, inv_item_name, unit, current_qty, min_qty, requested_qty, unit_price) VALUES (?,?,?,?,?,?,?,?,?)',
        [itemId, req.params.id, item.invItemId||'', item.invItemName||'', item.unit||'', item.currentQty||0, item.minQty||0, item.requestedQty||0, item.unitPrice||0]
      );
    }
    await db.query('UPDATE shortage_requests SET notes = ?, total_items = ? WHERE id = ?', [notes||'', items.length, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Delete shortage request. close2 Fix 2 — authorization is dual-path so a cashier
// can cancel their OWN request (the POS "حذف" button) while an approver (holder of
// purchasing.requisitions.approve) can delete ANY request in their warehouse scope.
// No single requireCapability middleware can express "owner OR approver", so the
// check is inline; unauthenticated callers are already blocked by the global /api
// JWT gate (req.user is always set here).
router.delete('/shortage-requests/:id', async (req, res) => {
  try {
    const [sr] = await db.query('SELECT warehouse_id, username FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!sr.length) return res.json({ success: false, error: 'الطلب غير موجود' });
    if (!req.guardWh(res, sr[0].warehouse_id)) return;
    if (!(await _shrIsApprover(req))) {
      // Non-approver: must be the creator AND hold the requester capability.
      const canCreate = await requireCapability.hasCapability(req.user, 'inventory.requisition.create');
      if (!canCreate || sr[0].username !== _actor(req)) {
        return res.status(403).json({ success: false, code: 'PERMISSION_DENIED' });
      }
    }
    await db.query('DELETE FROM shortage_items WHERE request_id = ?', [req.params.id]);
    await db.query('DELETE FROM shortage_requests WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Convert shortage to Purchase Order
router.post('/shortage-requests/:id/convert-to-po', requireCapability('purchasing.requisitions.approve'), async (req, res) => {
  try {
    const { supplierId, supplierName } = req.body;
    const username = _actor(req); // G-INV M2 — actor from the JWT only
    const [reqs] = await db.query('SELECT * FROM shortage_requests WHERE id = ?', [req.params.id]);
    if (!reqs.length) return res.json({ success: false, error: 'الطلب غير موجود' });
    const r = reqs[0];
    if (r.status !== 'approved') return res.json({ success: false, error: 'الطلب يجب أن يكون معتمداً أولاً' });

    const [items] = await db.query('SELECT * FROM shortage_items WHERE request_id = ?', [req.params.id]);

    // ─── V3 spec: auto-fill brand/branch/warehouse from the shortage request ───
    // Allow override via req.body if admin wants to redirect to a different warehouse
    const targetBrandId  = req.body.brandId  || r.brand_id  || null;
    const targetBranchId = req.body.branchId || r.branch_id || null;
    let targetWarehouseId = req.body.warehouseId || null;
    // If no explicit warehouse given, derive from the requesting branch
    if (!targetWarehouseId && targetBranchId) {
      try {
        const [br] = await db.query('SELECT warehouse_id FROM branches WHERE id = ?', [targetBranchId]);
        if (br.length && br[0].warehouse_id) targetWarehouseId = br[0].warehouse_id;
      } catch(e) {}
    }

    // Create PO
    const poId = 'PO-' + Date.now();
    const [lastPO] = await db.query('SELECT po_number FROM purchase_orders ORDER BY created_at DESC LIMIT 1');
    let poNum = 1;
    if (lastPO.length && lastPO[0].po_number) {
      const m = lastPO[0].po_number.match(/(\d+)/);
      if (m) poNum = parseInt(m[1]) + 1;
    }
    const poNumber = 'PO-' + String(poNum).padStart(5, '0');

    let totalBeforeVat = 0;
    const poLines = items.map(i => {
      const qty = Number(i.requested_qty) || 0;
      const price = Number(i.unit_price) || 0;
      const lineTotal = qty * price;
      totalBeforeVat += lineTotal;
      return { itemId: i.inv_item_id, itemName: i.inv_item_name, unit: i.unit, qty, unitPrice: price, total: lineTotal };
    });

    const vatAmount = totalBeforeVat * 0.15;
    const totalAfterVat = totalBeforeVat + vatAmount;

    // Try inserting with brand_id/branch_id (V3); fall back to legacy columns if those
    // columns don't exist on a very old deploy.
    try {
      await db.query(
        `INSERT INTO purchase_orders (id, po_number, supplier_id, supplier_name, po_date, expected_date, notes, status, total_before_vat, vat_amount, total_after_vat, created_by, brand_id, branch_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [poId, poNumber, supplierId || '', supplierName || '', new Date(), new Date(Date.now() + 7*86400000),
         'من طلب نقص: ' + r.request_number, 'draft', totalBeforeVat, vatAmount, totalAfterVat, username || '',
         targetBrandId, targetBranchId]
      );
    } catch (e) {
      await db.query(
        `INSERT INTO purchase_orders (id, po_number, supplier_id, supplier_name, po_date, expected_date, notes, status, total_before_vat, vat_amount, total_after_vat, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [poId, poNumber, supplierId || '', supplierName || '', new Date(), new Date(Date.now() + 7*86400000),
         'من طلب نقص: ' + r.request_number, 'draft', totalBeforeVat, vatAmount, totalAfterVat, username || '']
      );
    }

    for (const line of poLines) {
      const lineId = 'POL-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO po_lines (id, po_id, item_id, item_name, unit, qty, unit_price, vat_rate, vat_amount, total) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [lineId, poId, line.itemId, line.itemName, line.unit, line.qty, line.unitPrice, 15, line.total * 0.15, line.total * 1.15]
      );
    }

    // Update shortage request
    await db.query('UPDATE shortage_requests SET status = "converted", po_id = ? WHERE id = ?', [poId, req.params.id]);

    res.json({
      success: true, poId, poNumber,
      brandId: targetBrandId, branchId: targetBranchId, warehouseId: targetWarehouseId
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
