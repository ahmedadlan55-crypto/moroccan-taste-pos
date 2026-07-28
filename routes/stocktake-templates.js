'use strict';
/**
 * routes/stocktake-templates.js — نماذج الجرد المحفوظة (saved stocktake templates).
 *
 * THE OWNER'S ASK
 *   «امكانيا انشاء وحفظ نموذج جرد بحيث يمكنني اختياره والتعديل عليه بحيث اضع
 *    فيه المواد التي احتاج جردها دوريا»
 *   — a NAMED, reusable set of items he counts periodically: create it, pick it,
 *   edit it, reuse it. Nothing like this existed anywhere in the repo (verified by
 *   grep across routes/ and the whole tree for stocktake_template / count_template
 *   / item_preset / saved_list — zero hits), so this file is greenfield.
 *
 * WHY SERVER-BACKED AND NOT localStorage
 *   A localStorage template dies with the tablet. The owner runs several tills and
 *   swaps hardware; «نموذج جرد» is store master data, not a device preference.
 *
 * WHAT A TEMPLATE IS — AND IS NOT
 *   It is ONLY: a name, an ORDERED list of inv_items ids, and an optional warehouse
 *   scope. It is a shopping list of *what to count*, nothing else.
 *
 *   IT CARRIES NO QUANTITIES. Not a counted qty, not a "last counted" qty, not a
 *   system qty. BLIND COUNT is a hard product contract on this surface (see the
 *   header of routes/inventory-stocktakes.js and the blind-count assertions in
 *   frontend/pos/src/components/__tests__/StocktakeDialog.test.tsx:156) — a
 *   template row that whispered "last time this was 40" would leak exactly the
 *   number blind counting exists to hide. There is deliberately no column for it.
 *
 * SCOPE — MATCHED TO inv_stocktakes, NOT INVENTED
 *   inv_stocktakes (server.js, "inv_stocktakes" DDL) scopes a document by
 *   warehouse_id NOT NULL, and DERIVES brand_id / branch_id from that warehouse row
 *   (routes/inventory-stocktakes.js POST '/' — `warehouse.brand_id`,
 *   `warehouse.branch_id`). This file does exactly the same derivation.
 *
 *   The ONE difference, on purpose: warehouse_id here is NULLABLE.
 *     • warehouse_id = NULL  → a company-wide template, usable from any till.
 *     • warehouse_id = 'WH-x' → pinned to that warehouse.
 *   A document must name the warehouse it counts; a *checklist* need not. The POS
 *   never picks a warehouse by hand — it resolves one at submit time
 *   (frontend/pos/src/lib/api.ts resolveStocktakeWarehouseId), so forcing a
 *   warehouse onto the template would make every template the owner saves on one
 *   till invisible on the next. NULL is the useful default and the list endpoint
 *   always returns global templates alongside the scoped ones.
 *
 * PERMISSIONS — MIRRORED, NOT INVENTED
 *   read + create + edit : requireCapability('inventory.stocktake.create')
 *       the SAME gate the v2 count-entry routes use (routes/inventory-
 *       stocktakes.js:50 `STK_COUNT`), already seeded to include `cashier`
 *       (db/migrations/capability-seeds/g-inv.json). A user who cannot run a
 *       stocktake has no use for a stocktake template.
 *   edit / delete SOMEONE ELSE'S : admin | manager only.
 *       Dual-path ("owner OR manager") cannot be expressed by a single
 *       requireCapability middleware, so the check is inline — the identical
 *       shape routes/inventory.js DELETE /shortage-requests/:id already uses for
 *       "a cashier may cancel their OWN request, an approver may cancel any".
 *       The manager predicate mirrors `MGR = requireRole('admin','manager')`
 *       (routes/inventory-stocktakes.js:42): ROLE ONLY. An isDeveloper flag does
 *       not widen it — same stance middleware/posPortalScope.js takes.
 *
 *   Warehouse ACL: every read is filtered through req.whScopeClause and every
 *   write through req.guardWh (middleware/warehouseScope, mounted on
 *   /api/inventory in server.js) — the same guards inventory-stocktakes.js uses.
 *
 * IDENTITY comes from the verified JWT (req.user.username) and NOWHERE else —
 *   never from the query string or the body. See memory: `?username=admin`
 *   once authenticated with no token at all (fixed in 043af77).
 *
 * RESPONSE ENVELOPE — { success, data }
 *   Deliberately the routes/saved-views.js envelope, not the
 *   C.mutationEnvelope({status, version, affectedStock, …}) shape used by
 *   inventory-stocktakes.js. That envelope describes a DOCUMENT with a lifecycle
 *   and a stock effect; a template has neither. saved-views is the exact analog
 *   (a named, reusable, user-created bundle) and this file matches it key for key
 *   so a client that already unwraps `.data` needs no new special case.
 *   A client that forgets to unwrap `{success,data}` has already caused a
 *   production outage in this repo — the shape is pinned by the integration test.
 *
 * ENDPOINTS (mount-relative; full paths are /api/inventory/stocktake-templates…)
 *   GET    /            ?warehouseId=  → { success, data: [Template] }
 *   GET    /:id                        → { success, data:  Template  }
 *   POST   /                           → 201 { success, data: Template }
 *   PUT    /:id                        → { success, data: Template }   (partial)
 *   DELETE /:id                        → { success: true, data: { id } }
 *
 * CASHIER REACHABILITY
 *   middleware/posPortalScope.js is DENY-BY-DEFAULT for role 'cashier'. All five
 *   verbs above are added to its ALLOW list in this same change — spelled out
 *   per-verb, because listing a PUT as a POST there once silently 403'd every
 *   stocktake count autosave (that incident is documented at posPortalScope.js
 *   :121-126). Without those entries this whole feature 403s at the till.
 *
 * TABLES (created at boot by server.js runMigrations → createTableIfMissing,
 *   the pattern every other table here uses):
 *     inv_stocktake_templates        header
 *     inv_stocktake_template_items   ordered item rows (sort_order)
 */

const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const requireCapability = require('../middleware/requireCapability');

// The same capability that gates v2 stocktake count entry
// (routes/inventory-stocktakes.js:50). Seeded for cashier in g-inv.json.
const STK_COUNT = requireCapability('inventory.stocktake.create');

const NAME_MAX = 120;
// A count sheet the owner works through by hand. 500 is far above the ~159-item
// production catalog (routes/inventory.js:1124) and still bounds the payload.
const MAX_ITEMS = 500;

// ── tiny helpers ────────────────────────────────────────────────────────────
/** Actor identity — verified JWT only. Never req.query / req.body. */
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }

/**
 * Mirrors MGR = requireRole('admin','manager') at routes/inventory-stocktakes.js:42.
 * ROLE ONLY — an isDeveloper flag on a non-manager row is a data-entry mistake,
 * not a reason to widen authority (middleware/posPortalScope.js takes the same line).
 */
function _isManager(req) {
  const role = String((req.user && req.user.role) || '').toLowerCase();
  return role === 'admin' || role === 'manager';
}

function _ok(res, data, statusCode) {
  return res.status(statusCode || 200).json({ success: true, data });
}
function _fail(res, statusCode, code, error) {
  return res.status(statusCode).json({ success: false, code, error });
}
function _serverError(res, e, msg) {
  console.error('[stocktake-templates]', (e && e.stack) || e);
  return _fail(res, 500, 'SERVER_ERROR', msg);
}

function _genId() { return 'STKT-' + crypto.randomBytes(8).toString('hex'); }
function _genItemId() { return 'STKTI-' + crypto.randomBytes(8).toString('hex'); }

function _str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

/** '' / undefined / null all collapse to NULL = "any warehouse". */
function _normWarehouseId(v) {
  const s = _str(v, 50);
  return s ? s : null;
}

// ── row mapping ─────────────────────────────────────────────────────────────
/**
 * One item row. `name` prefers the LIVE inv_items name so a renamed material
 * shows its current name; the snapshot columns are the fallback for an item that
 * has since been hard-deleted. NO QUANTITY FIELD EXISTS HERE BY DESIGN (blind count).
 */
function _mapItem(r) {
  const live = r.live_name != null;
  const isDeleted = r.deleted_at != null;
  return {
    itemId: r.item_id,
    name: r.live_name != null ? r.live_name : (r.snapshot_name || r.item_id),
    nameEn: r.live_name_en || '',
    unit: (r.live_unit != null ? r.live_unit : r.snapshot_unit) || '',
    bigUnit: r.big_unit || '',
    convRate: r.conv_rate != null ? Number(r.conv_rate) : 1,
    sortOrder: Number(r.sort_order) || 0,
    // The default branch of GET /api/inventory/items (routes/inventory.js:1229)
    // applies NO active/deleted_at filter, so the picker CAN put an inactive or
    // soft-deleted row into a template. Say so explicitly instead of pretending.
    active: live && !isDeleted && !!Number(r.active),
    missing: !live,
  };
}

function _mapRow(row, items, req) {
  const actor = _actor(req);
  const mine = String(row.created_by || '') === String(actor);
  const manager = _isManager(req);
  const list = (items || []).map(_mapItem);
  return {
    id: row.id,
    name: row.name,
    warehouseId: row.warehouse_id || null,
    branchId: row.branch_id || null,
    brandId: row.brand_id || null,
    itemIds: list.map((x) => x.itemId),
    items: list,
    itemCount: list.length,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedBy: row.updated_by || '',
    updatedAt: row.updated_at,
    // Precomputed so the UI can hide a button instead of discovering a 403.
    // Authoritative check still runs server-side on every mutation.
    canEdit: mine || manager,
    canDelete: mine || manager,
  };
}

// ── data access ─────────────────────────────────────────────────────────────
async function _loadHeader(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM inv_stocktake_templates WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

/** Item rows for N templates in ONE query → Map<templateId, rows[]>. */
async function _loadItemsFor(ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const [rows] = await db.query(
    'SELECT ti.template_id, ti.item_id, ti.sort_order,' +
    '       ti.item_name AS snapshot_name, ti.unit AS snapshot_unit,' +
    '       i.name AS live_name, i.name_en AS live_name_en, i.unit AS live_unit,' +
    '       i.big_unit, i.conv_rate, i.active, i.deleted_at' +
    '  FROM inv_stocktake_template_items ti' +
    '  LEFT JOIN inv_items i ON i.id = ti.item_id' +
    ' WHERE ti.template_id IN (' + ph + ')' +
    ' ORDER BY ti.template_id, ti.sort_order, ti.item_id',
    ids
  );
  for (const r of rows) {
    if (!out.has(r.template_id)) out.set(r.template_id, []);
    out.get(r.template_id).push(r);
  }
  return out;
}

async function _hydrate(req, row) {
  const map = await _loadItemsFor([row.id]);
  return _mapRow(row, map.get(row.id) || [], req);
}

/**
 * Validate + order + dedupe the incoming item ids, and snapshot name/unit.
 * Returns { ordered, byId } or { error, message }.
 */
async function _resolveItems(rawItemIds) {
  if (!Array.isArray(rawItemIds)) {
    return { error: 'VALIDATION_ERROR', message: 'itemIds يجب أن تكون مصفوفة' };
  }
  const seen = new Set();
  const ordered = [];
  for (const raw of rawItemIds) {
    const s = _str(raw, 50);
    if (!s || seen.has(s)) continue; // dedupe, keep FIRST position
    seen.add(s);
    ordered.push(s);
  }
  if (!ordered.length) return { error: 'VALIDATION_ERROR', message: 'حدّد صنفًا واحدًا على الأقل للنموذج' };
  if (ordered.length > MAX_ITEMS) {
    return { error: 'VALIDATION_ERROR', message: 'الحد الأقصى ' + MAX_ITEMS + ' صنفًا في النموذج الواحد' };
  }
  const ph = ordered.map(() => '?').join(',');
  const [rows] = await db.query('SELECT id, name, unit FROM inv_items WHERE id IN (' + ph + ')', ordered);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const missing = ordered.filter((id) => !byId.has(id));
  if (missing.length) {
    return { error: 'VALIDATION_ERROR', message: 'أصناف غير موجودة: ' + missing.slice(0, 5).join('، ') };
  }
  return { ordered, byId };
}

/**
 * Duplicate-name guard, case-insensitive, WITHIN THE SAME warehouse scope.
 * `<=>` is MySQL's NULL-safe equality so the global (warehouse_id IS NULL)
 * bucket is compared correctly — a plain `= ?` with NULL never matches.
 */
async function _nameTaken(name, warehouseId, excludeId) {
  const params = [name, warehouseId];
  let sql = 'SELECT id FROM inv_stocktake_templates WHERE LOWER(name) = LOWER(?) AND warehouse_id <=> ?';
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  const [rows] = await db.query(sql + ' LIMIT 1', params);
  return rows.length > 0;
}

/** Derive brand/branch from the warehouse exactly as inventory-stocktakes.js does. */
async function _loadWarehouse(id) {
  const [rows] = await db.query('SELECT id, brand_id, branch_id FROM warehouses WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function _writeItems(conn, templateId, ordered, byId) {
  await conn.query('DELETE FROM inv_stocktake_template_items WHERE template_id = ?', [templateId]);
  let i = 0;
  for (const itemId of ordered) {
    const src = byId.get(itemId) || {};
    await conn.query(
      'INSERT INTO inv_stocktake_template_items (id, template_id, item_id, item_name, unit, sort_order) VALUES (?,?,?,?,?,?)',
      [_genItemId(), templateId, itemId, _str(src.name, 200), _str(src.unit, 50), i++]
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LIST — GET /api/inventory/stocktake-templates?warehouseId=
// ════════════════════════════════════════════════════════════════════════════
// Returns the caller-visible templates WITH their items hydrated, so the till
// makes ONE call to fill the «اختر نموذج» picker and can cache the payload.
router.get('/', STK_COUNT, async (req, res) => {
  try {
    const where = ['1=1'];
    const params = [];

    const wanted = _normWarehouseId(req.query.warehouseId);
    if (wanted) {
      if (req.guardWh && !req.guardWh(res, wanted)) return; // writes the 403 itself
      // A global template is usable from ANY warehouse, so it is always included.
      where.push('(t.warehouse_id IS NULL OR t.warehouse_id = ?)');
      params.push(wanted);
    }

    // Warehouse ACL. scopeSqlClause emits `AND col IN (…)`, which silently drops
    // NULLs — that would hide every global template from a scoped user, so the
    // clause is re-wrapped with an explicit IS NULL branch.
    const sc = req.whScopeClause ? req.whScopeClause('t.warehouse_id') : { sql: '', params: [] };
    if (sc.sql) {
      where.push('(t.warehouse_id IS NULL OR ' + sc.sql.replace(/^\s*AND\s+/i, '') + ')');
      params.push(...(sc.params || []));
    }

    const [rows] = await db.query(
      'SELECT t.* FROM inv_stocktake_templates t WHERE ' + where.join(' AND ') +
      ' ORDER BY t.name ASC, t.created_at ASC LIMIT 200',
      params
    );
    const itemMap = await _loadItemsFor(rows.map((r) => r.id));
    return _ok(res, rows.map((r) => _mapRow(r, itemMap.get(r.id) || [], req)));
  } catch (e) {
    return _serverError(res, e, 'تعذر تحميل نماذج الجرد');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DETAIL — GET /api/inventory/stocktake-templates/:id
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id', STK_COUNT, async (req, res) => {
  try {
    const row = await _loadHeader(req.params.id);
    if (!row) return _fail(res, 404, 'NOT_FOUND', 'نموذج الجرد غير موجود');
    if (req.guardWh && !req.guardWh(res, row.warehouse_id)) return;
    return _ok(res, await _hydrate(req, row));
  } catch (e) {
    return _serverError(res, e, 'تعذر تحميل نموذج الجرد');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE — POST /api/inventory/stocktake-templates
//   body { name, itemIds: string[], warehouseId?: string|null }
// ════════════════════════════════════════════════════════════════════════════
router.post('/', STK_COUNT, async (req, res) => {
  try {
    const b = req.body || {};
    const actor = _actor(req);
    const name = _str(b.name, NAME_MAX);
    if (!name) return _fail(res, 400, 'VALIDATION_ERROR', 'اسم النموذج مطلوب');

    const warehouseId = _normWarehouseId(b.warehouseId != null ? b.warehouseId : b.warehouse_id);
    let brandId = null, branchId = null;
    if (warehouseId) {
      if (req.guardWh && !req.guardWh(res, warehouseId)) return;
      const wh = await _loadWarehouse(warehouseId);
      if (!wh) return _fail(res, 400, 'VALIDATION_ERROR', 'المستودع غير موجود');
      brandId = wh.brand_id || null;
      branchId = wh.branch_id || null;
    }

    const resolved = await _resolveItems(b.itemIds);
    if (resolved.error) return _fail(res, 400, resolved.error, resolved.message);

    if (await _nameTaken(name, warehouseId, null)) {
      return _fail(res, 409, 'DUPLICATE_NAME', 'يوجد نموذج جرد بنفس الاسم');
    }

    const id = _genId();
    await db.withTransaction(async (conn) => {
      await conn.query(
        'INSERT INTO inv_stocktake_templates (id, name, warehouse_id, brand_id, branch_id, created_by, updated_by) VALUES (?,?,?,?,?,?,?)',
        [id, name, warehouseId, brandId, branchId, actor, actor]
      );
      await _writeItems(conn, id, resolved.ordered, resolved.byId);
    });

    const row = await _loadHeader(id);
    return _ok(res, await _hydrate(req, row), 201);
  } catch (e) {
    return _serverError(res, e, 'تعذر إنشاء نموذج الجرد');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// UPDATE — PUT /api/inventory/stocktake-templates/:id
//   body { name?, itemIds?, warehouseId? }  — PARTIAL: an absent field is kept.
//   Own template → allowed. Someone else's → admin | manager only.
//
//   `warehouseId: null` is a MEANINGFUL value (promote to global) and is honoured;
//   omitting the key entirely keeps the current scope. `undefined` vs `null` is the
//   whole distinction, so it is tested explicitly.
// ════════════════════════════════════════════════════════════════════════════
router.put('/:id', STK_COUNT, async (req, res) => {
  try {
    const b = req.body || {};
    const actor = _actor(req);
    const row = await _loadHeader(req.params.id);
    if (!row) return _fail(res, 404, 'NOT_FOUND', 'نموذج الجرد غير موجود');
    if (req.guardWh && !req.guardWh(res, row.warehouse_id)) return;

    if (String(row.created_by || '') !== String(actor) && !_isManager(req)) {
      return _fail(res, 403, 'PERMISSION_DENIED', 'لا يمكنك تعديل نموذج أنشأه مستخدم آخر');
    }

    const name = b.name !== undefined ? _str(b.name, NAME_MAX) : row.name;
    if (!name) return _fail(res, 400, 'VALIDATION_ERROR', 'اسم النموذج مطلوب');

    let warehouseId = row.warehouse_id || null;
    let brandId = row.brand_id || null;
    let branchId = row.branch_id || null;
    const scopeChanging = Object.prototype.hasOwnProperty.call(b, 'warehouseId') ||
      Object.prototype.hasOwnProperty.call(b, 'warehouse_id');
    if (scopeChanging) {
      warehouseId = _normWarehouseId(b.warehouseId != null ? b.warehouseId : b.warehouse_id);
      brandId = null; branchId = null;
      if (warehouseId) {
        if (req.guardWh && !req.guardWh(res, warehouseId)) return;
        const wh = await _loadWarehouse(warehouseId);
        if (!wh) return _fail(res, 400, 'VALIDATION_ERROR', 'المستودع غير موجود');
        brandId = wh.brand_id || null;
        branchId = wh.branch_id || null;
      }
    }

    let resolved = null;
    if (b.itemIds !== undefined) {
      resolved = await _resolveItems(b.itemIds);
      if (resolved.error) return _fail(res, 400, resolved.error, resolved.message);
    }

    if (await _nameTaken(name, warehouseId, row.id)) {
      return _fail(res, 409, 'DUPLICATE_NAME', 'يوجد نموذج جرد بنفس الاسم');
    }

    await db.withTransaction(async (conn) => {
      await conn.query(
        'UPDATE inv_stocktake_templates SET name = ?, warehouse_id = ?, brand_id = ?, branch_id = ?, updated_by = ? WHERE id = ?',
        [name, warehouseId, brandId, branchId, actor, row.id]
      );
      if (resolved) await _writeItems(conn, row.id, resolved.ordered, resolved.byId);
    });

    const after = await _loadHeader(row.id);
    return _ok(res, await _hydrate(req, after));
  } catch (e) {
    return _serverError(res, e, 'تعذر تحديث نموذج الجرد');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE — DELETE /api/inventory/stocktake-templates/:id
//   Own template → allowed (the cashier cleans up their own list).
//   Someone else's → admin | manager only.
//   Same dual-path shape as routes/inventory.js DELETE /shortage-requests/:id.
// ════════════════════════════════════════════════════════════════════════════
router.delete('/:id', STK_COUNT, async (req, res) => {
  try {
    const actor = _actor(req);
    const row = await _loadHeader(req.params.id);
    if (!row) return _fail(res, 404, 'NOT_FOUND', 'نموذج الجرد غير موجود');
    if (req.guardWh && !req.guardWh(res, row.warehouse_id)) return;

    if (String(row.created_by || '') !== String(actor) && !_isManager(req)) {
      return _fail(res, 403, 'PERMISSION_DENIED', 'لا يمكنك حذف نموذج أنشأه مستخدم آخر');
    }

    await db.withTransaction(async (conn) => {
      await conn.query('DELETE FROM inv_stocktake_template_items WHERE template_id = ?', [row.id]);
      await conn.query('DELETE FROM inv_stocktake_templates WHERE id = ?', [row.id]);
    });
    return _ok(res, { id: row.id });
  } catch (e) {
    return _serverError(res, e, 'تعذر حذف نموذج الجرد');
  }
});

module.exports = router;
