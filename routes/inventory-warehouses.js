/**
 * Warehouse management (CRUD) — Phase W6.
 *
 * Mounted at /api/inventory/v2/warehouses (server.js mounts it AFTER the
 * global /api auth gate + middleware/warehouseScope.loadWarehouseScope, the
 * same chain as routes/inventory-transactions.js).
 *
 * Conventions cloned from routes/inventory-transactions.js:
 *   • unified envelope + canonical error codes from lib/inventoryTxContract,
 *   • _err/_fail/_catch helpers, requireRole MGR=('admin','manager') and
 *     ADMIN=('admin'),
 *   • append-only audit rows in inv_tx_events (doc_type='warehouse',
 *     doc_id=warehouse id) written inside the SAME transaction,
 *   • db.withTransaction with full rollback for every mutation,
 *   • warehouse scope: req.whScopeClause('w.id') scopes the list,
 *     req.guardWh guards every /:id route (generic 403, never reveals
 *     whether the id exists).
 *
 * Optimistic concurrency — the warehouses table has NO version column and
 * schema changes belong to server.js (outside this file's ownership). So:
 *   • field edits (PATCH) are last-write-wins by design (low-contention
 *     master data; the audit trail records every write),
 *   • STATE transitions are protected with conditional writes:
 *     activate/deactivate use `WHERE is_active=?` and DELETE re-checks the
 *     row inside the transaction — a concurrent flip surfaces as a 409
 *     VERSION_CONFLICT instead of silently double-applying.
 *
 * Code uniqueness — the schema has no UNIQUE(code) index, so uniqueness is
 * enforced app-side with a re-check inside the mutation transaction
 * (best-effort under concurrency, exact in practice) → 409 DUPLICATE_CODE.
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const C = require('../lib/inventoryTxContract');
const requireRole = require('../middleware/auth').requireRole;

const MGR = requireRole('admin', 'manager');
const ADMIN = requireRole('admin');

// ENUM('branch','main','production','waste','raw','finished') on warehouses.type.
const TYPES = ['branch', 'main', 'production', 'waste', 'raw', 'finished'];

// ── Generic helpers (mirrors inventory-transactions.js) ─────────────────────
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function _fail(res, codeOrErr, message) {
  const code = C.isCanonical(codeOrErr) ? codeOrErr : C.mapError(codeOrErr);
  const msg = message || (codeOrErr && codeOrErr.message) || code;
  return res.status(C.httpFor(code)).json(C.errorBody(code, msg));
}
function _catch(res, e) {
  if (e && e._guarded) return;
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found' });
  // DUPLICATE_CODE is domain-specific (not one of the canonical tx codes):
  // a taken warehouse code is a 409 conflict, mirroring BARCODE_TAKEN.
  if (e && e.code === 'DUPLICATE_CODE') return res.status(409).json({ success: false, code: 'DUPLICATE_CODE', error: e.message });
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: (e && e.message) || 'error' });
  return _fail(res, e, e && e.message);
}
function _envelope(parts, legacy) { return Object.assign({}, C.mutationEnvelope(parts), legacy || {}); }
function _ok(res, parts, legacy, statusCode) { const body = _envelope(parts, legacy); res.status(statusCode || 200).json(body); return body; }

// Audit row (doc_type='warehouse'), written on the SAME connection as the
// mutation so it commits/rolls back atomically. Best-effort like the tx routes.
async function _audit(conn, docId, action, fromStatus, toStatus, actor, note, payload) {
  const q = conn || db;
  try {
    await q.query(
      'INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
      ['EV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), 'warehouse', docId, action, fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500), payload ? JSON.stringify(payload).slice(0, 8000) : null]
    );
  } catch (_) { /* audit best-effort */ }
  return { docType: 'warehouse', docId, action, fromStatus: fromStatus || null, toStatus: toStatus || null, actor: actor || '', at: new Date().toISOString() };
}

async function _loadWarehouse(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM warehouses WHERE id=? LIMIT 1' + (conn ? ' FOR UPDATE' : ''), [id]);
  return rows[0] || null;
}

async function _codeTaken(q, code, excludeId) {
  const [rows] = await q.query(
    'SELECT id FROM warehouses WHERE code=?' + (excludeId ? ' AND id<>?' : '') + ' LIMIT 1',
    excludeId ? [code, excludeId] : [code]
  );
  return rows.length > 0;
}

function _str(v, max) { return v == null ? null : String(v).trim().slice(0, max || 200) || null; }
function _bool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

// ── Stats (clone of routes/inventory.js _warehousesSummary valuation) ──────
// Warehouse WAC wins; falls back to the item's global cost when unknown:
// COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0).
async function _statsRows(warehouseId, req) {
  const params = [];
  const where = [];
  if (warehouseId) { where.push('w.id = ?'); params.push(warehouseId); }
  const sc = req && req.whScopeClause ? req.whScopeClause('w.id') : { sql: '', params: [] };
  if (sc.sql) { where.push(sc.sql.replace(/^\s*AND\s+/i, '')); params.push(...sc.params); }
  // B3 — filter warehouses still missing an English name (completion workflow).
  if (req && String(req.query.missingNameEn) === '1') where.push("(w.name_en IS NULL OR w.name_en = '')");
  const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
  const [rows] = await db.query(
    `SELECT w.id, w.code, w.name, w.name_en, w.type, w.branch_id, w.brand_id, w.cost_center_id,
            w.location, w.manager, w.description, w.is_main, w.is_active, w.created_at,
            COUNT(DISTINCT ws.item_id) AS item_count,
            COALESCE(SUM(ws.qty), 0) AS total_qty,
            COALESCE(SUM(ws.qty * COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0)), 0) AS total_value,
            COALESCE(SUM(CASE WHEN ws.qty > 0 AND i.min_stock > 0 AND ws.qty <= i.min_stock THEN 1 ELSE 0 END), 0) AS low_count,
            COALESCE(SUM(CASE WHEN ws.item_id IS NOT NULL AND ws.qty = 0 THEN 1 ELSE 0 END), 0) AS out_count,
            COALESCE(SUM(CASE WHEN ws.qty < 0 THEN 1 ELSE 0 END), 0) AS negative_count
       FROM warehouses w
       LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
       LEFT JOIN inv_items i ON i.id = ws.item_id
       ${whereSql}
      GROUP BY w.id, w.code, w.name, w.name_en, w.type, w.branch_id, w.brand_id, w.cost_center_id,
               w.location, w.manager, w.description, w.is_main, w.is_active, w.created_at
      ORDER BY w.is_active DESC, w.is_main DESC, w.code`,
    params
  );

  // Movement count + last movement per warehouse — ONE extra query (no N+1).
  const mvMap = {};
  try {
    const mp = [];
    const mwhere = [];
    if (warehouseId) { mwhere.push('warehouse_id = ?'); mp.push(warehouseId); }
    const msc = req && req.whScopeClause ? req.whScopeClause('warehouse_id') : { sql: '', params: [] };
    if (msc.sql) { mwhere.push(msc.sql.replace(/^\s*AND\s+/i, '')); mp.push(...msc.params); }
    let mq = 'SELECT warehouse_id, COUNT(*) AS movement_count, MAX(movement_date) AS last_movement FROM inventory_movements';
    if (mwhere.length) mq += ' WHERE ' + mwhere.join(' AND ');
    mq += ' GROUP BY warehouse_id';
    const [mrows] = await db.query(mq, mp);
    mrows.forEach((r) => { mvMap[String(r.warehouse_id)] = { count: Number(r.movement_count) || 0, last: r.last_movement || null }; });
  } catch (_) { /* movements table variant — counts stay 0 */ }

  // Brand / branch display names — two tiny lookups (avoids collation-fragile
  // cross-table JOINs on legacy databases).
  const brandMap = {}, branchMap = {};
  try { const [b] = await db.query('SELECT id, name FROM brands'); b.forEach((r) => { brandMap[String(r.id)] = r.name; }); } catch (_) {}
  try { const [b] = await db.query('SELECT id, name FROM branches'); b.forEach((r) => { branchMap[String(r.id)] = r.name; }); } catch (_) {}

  return rows.map((r) => {
    const mv = mvMap[String(r.id)] || { count: 0, last: null };
    return {
      id: String(r.id),
      code: r.code || '',
      name: r.name || '',
      nameEn: r.name_en || '',
      type: r.type || 'branch',
      brandId: r.brand_id || null,
      brandName: r.brand_id ? (brandMap[String(r.brand_id)] || null) : null,
      branchId: r.branch_id || null,
      branchName: r.branch_id ? (branchMap[String(r.branch_id)] || null) : null,
      costCenterId: r.cost_center_id || null,
      location: r.location || '',
      manager: r.manager || '',
      description: r.description || '',
      isMain: !!Number(r.is_main),
      isActive: !!Number(r.is_active),
      createdAt: r.created_at || null,
      itemCount: Number(r.item_count) || 0,
      totalQty: Number(r.total_qty) || 0,
      totalValue: Number(r.total_value) || 0,
      lowCount: Number(r.low_count) || 0,
      outCount: Number(r.out_count) || 0,
      negativeCount: Number(r.negative_count) || 0,
      movementCount: mv.count,
      lastMovementAt: mv.last,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// READ
// ════════════════════════════════════════════════════════════════════════════

// GET / — every warehouse in scope + computed stats (items, qty, value at
// warehouse WAC, alert counters, movement count/last) + grand totals.
router.get('/', async (req, res) => {
  try {
    const warehouses = await _statsRows(null, req);
    const totals = warehouses.reduce((t, w) => {
      t.warehouseCount += 1;
      if (w.isActive) t.activeCount += 1;
      t.itemCount += w.itemCount;
      t.totalQty += w.totalQty;
      t.totalValue += w.totalValue;
      t.movementCount += w.movementCount;
      return t;
    }, { warehouseCount: 0, activeCount: 0, itemCount: 0, totalQty: 0, totalValue: 0, movementCount: 0 });
    res.json({ success: true, data: warehouses, totals });
  } catch (e) { _catch(res, e); }
});

// GET /options — reference lists for the create/edit form (brands + branches +
// the type enum). Read-only; any authenticated user.
router.get('/options', async (req, res) => {
  try {
    let brands = [], branches = [];
    try { const [r] = await db.query('SELECT id, name FROM brands WHERE is_active=1 ORDER BY name'); brands = r.map((x) => ({ id: String(x.id), name: x.name || String(x.id) })); } catch (_) {}
    try { const [r] = await db.query('SELECT id, name FROM branches WHERE is_active=1 ORDER BY name'); branches = r.map((x) => ({ id: String(x.id), name: x.name || String(x.id) })); } catch (_) {}
    res.json({ success: true, data: { brands, branches, types: TYPES } });
  } catch (e) { _catch(res, e); }
});

// GET /:id — warehouse detail + stats + latest 50 movements + scope
// assignments (user_warehouse_access → users) + audit timeline.
router.get('/:id', async (req, res) => {
  try {
    // Scope guard FIRST — an out-of-scope id must be indistinguishable from a
    // non-existent one (guard answers a generic 403 before any existence read).
    if (req.guardWh && !req.guardWh(res, req.params.id)) return;
    const rows = await _statsRows(req.params.id, null);
    if (!rows.length) { const e = new Error('المستودع غير موجود'); e.status = 404; throw e; }
    const warehouse = rows[0];

    const [movements] = await db.query(
      'SELECT id, movement_date, item_id, item_name, type, qty, reason, username, notes, reference_type, reference_id ' +
      'FROM inventory_movements WHERE warehouse_id=? ORDER BY movement_date DESC, seq DESC LIMIT 50',
      [req.params.id]
    );

    let assignments = [];
    try {
      const [arows] = await db.query(
        'SELECT a.user_id, a.created_at, a.created_by, u.username, u.full_name, u.role ' +
        'FROM user_warehouse_access a JOIN users u ON u.id = a.user_id WHERE a.warehouse_id=? ORDER BY u.username',
        [req.params.id]
      );
      assignments = arows.map((r) => ({
        userId: Number(r.user_id),
        username: r.username || '',
        fullName: r.full_name || '',
        role: r.role || '',
        createdAt: r.created_at || null,
        createdBy: r.created_by || '',
      }));
    } catch (_) { /* access table absent on stale deploys */ }

    let timeline = [];
    try {
      const [ev] = await db.query(
        "SELECT id, action, from_status, to_status, actor, note, created_at FROM inv_tx_events WHERE doc_type='warehouse' AND doc_id=? ORDER BY created_at DESC, id DESC LIMIT 50",
        [req.params.id]
      );
      timeline = ev;
    } catch (_) {}

    res.json({
      success: true,
      data: warehouse,
      movements: movements.map((m) => ({
        id: String(m.id),
        date: m.movement_date || null,
        itemId: m.item_id || '',
        itemName: m.item_name || '',
        type: m.type || '',
        qty: Number(m.qty) || 0,
        reason: m.reason || '',
        username: m.username || '',
        notes: m.notes || '',
        referenceType: m.reference_type || '',
        referenceId: m.reference_id || '',
      })),
      assignments,
      timeline,
    });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE / UPDATE
// ════════════════════════════════════════════════════════════════════════════

// Validate + normalize the create/patch body. `existing` = current row for
// PATCH (fields not sent keep their value); null for POST (name+code required).
function _buildFields(body, existing) {
  const out = {};
  const b = body || {};

  if (b.name !== undefined || !existing) {
    const name = _str(b.name, 200);
    if (!name) throw _err('VALIDATION_ERROR', 'اسم المستودع مطلوب');
    out.name = name;
  }
  // B3 — English name: mandatory on CREATE (bilingual master data), settable on
  // UPDATE (existing rows completed via the missing-English-name filter).
  if (b.nameEn !== undefined || b.name_en !== undefined || !existing) {
    const nameEn = _str(b.nameEn != null ? b.nameEn : b.name_en, 200);
    if (!existing && !nameEn) throw _err('VALIDATION_ERROR', 'الاسم بالإنجليزية مطلوب للمستودعات الجديدة');
    out.name_en = nameEn || null;
  }
  if (b.code !== undefined || !existing) {
    const code = _str(b.code, 20);
    if (!code) throw _err('VALIDATION_ERROR', 'كود المستودع مطلوب');
    if (!/^[A-Za-z0-9_.\-]+$/.test(code)) throw _err('VALIDATION_ERROR', 'كود المستودع يقبل حروفًا وأرقامًا وشرطات فقط (بدون مسافات)');
    out.code = code.toUpperCase();
  }
  if (b.type !== undefined || !existing) {
    const type = String(b.type || 'branch').toLowerCase().trim();
    if (TYPES.indexOf(type) === -1) throw _err('VALIDATION_ERROR', 'نوع المستودع غير صالح — القيم المسموحة: ' + TYPES.join('، '));
    out.type = type;
  }
  if (b.brandId !== undefined || b.brand_id !== undefined) out.brand_id = _str(b.brandId != null ? b.brandId : b.brand_id, 50);
  if (b.branchId !== undefined || b.branch_id !== undefined) out.branch_id = _str(b.branchId != null ? b.branchId : b.branch_id, 50);
  if (b.costCenterId !== undefined || b.cost_center_id !== undefined) out.cost_center_id = _str(b.costCenterId != null ? b.costCenterId : b.cost_center_id, 50);
  if (b.location !== undefined) out.location = _str(b.location, 200);
  if (b.manager !== undefined) out.manager = _str(b.manager, 100);
  if (b.description !== undefined) out.description = _str(b.description, 500);
  if (b.isMain !== undefined || b.is_main !== undefined) out.is_main = _bool(b.isMain != null ? b.isMain : b.is_main) ? 1 : 0;
  return out;
}

// Referential sanity for brand/branch (only when a non-null id is provided).
async function _assertRefs(fields) {
  if (fields.brand_id) {
    try {
      const [r] = await db.query('SELECT id FROM brands WHERE id=? LIMIT 1', [fields.brand_id]);
      if (!r.length) throw _err('VALIDATION_ERROR', 'العلامة التجارية غير موجودة: ' + fields.brand_id);
    } catch (e) { if (e.code === 'VALIDATION_ERROR') throw e; /* brands table absent → skip */ }
  }
  if (fields.branch_id) {
    try {
      const [r] = await db.query('SELECT id FROM branches WHERE id=? LIMIT 1', [fields.branch_id]);
      if (!r.length) throw _err('VALIDATION_ERROR', 'الفرع غير موجود: ' + fields.branch_id);
    } catch (e) { if (e.code === 'VALIDATION_ERROR') throw e; /* branches table absent → skip */ }
  }
}

// POST / (MGR) — create { name, code, type, brandId?, branchId?, isMain?,
// location?, manager?, description?, costCenterId? }. 409 DUPLICATE_CODE.
router.post('/', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const fields = _buildFields(req.body, null);
    await _assertRefs(fields);

    const out = await db.withTransaction(async (conn) => {
      if (await _codeTaken(conn, fields.code)) throw _err('DUPLICATE_CODE', 'كود المستودع "' + fields.code + '" مستخدم بالفعل — اختر كودًا آخر');
      const id = 'WH-' + crypto.randomBytes(5).toString('hex');
      const cols = ['id', 'is_active'];
      const vals = [id, 1];
      for (const k of Object.keys(fields)) { cols.push(k); vals.push(fields[k]); }
      await conn.query('INSERT INTO warehouses (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')', vals);
      const auditEvent = await _audit(conn, id, 'create', null, 'active', actor, 'إنشاء مستودع', { fields });
      return { id, auditEvent };
    });

    return _ok(res, { data: { id: out.id }, documentNumber: fields.code, status: 'active', auditEvent: out.auditEvent }, { id: out.id }, 201);
  } catch (e) { _catch(res, e); }
});

// PATCH /:id (MGR) — update name/code/type/brand/branch/location/manager/
// isMain/description. Last-write-wins (no version column — see header note);
// every write is audited with the changed fields.
router.patch('/:id', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    if (req.guardWh && !req.guardWh(res, id)) return;
    const existing = await _loadWarehouse(id);
    if (!existing) { const e = new Error('المستودع غير موجود'); e.status = 404; throw e; }

    const fields = _buildFields(req.body, existing);
    if (!Object.keys(fields).length) return _fail(res, 'VALIDATION_ERROR', 'لا توجد حقول للتعديل');
    await _assertRefs(fields);

    const out = await db.withTransaction(async (conn) => {
      if (fields.code && await _codeTaken(conn, fields.code, id)) throw _err('DUPLICATE_CODE', 'كود المستودع "' + fields.code + '" مستخدم بالفعل — اختر كودًا آخر');
      const setCols = Object.keys(fields).map((k) => k + '=?');
      const setVals = Object.keys(fields).map((k) => fields[k]);
      const [r] = await conn.query('UPDATE warehouses SET ' + setCols.join(', ') + ' WHERE id=?', setVals.concat([id]));
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تعذّر تحديث المستودع — أعد التحميل');
      const changed = {};
      for (const k of Object.keys(fields)) changed[k] = { from: existing[k] != null ? existing[k] : null, to: fields[k] };
      const auditEvent = await _audit(conn, id, 'update', null, null, actor, 'تعديل بيانات المستودع', { changed });
      return { auditEvent };
    });

    return _ok(res, { data: { id }, documentNumber: fields.code || existing.code, status: Number(existing.is_active) ? 'active' : 'inactive', auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// ACTIVATE / DEACTIVATE — conditional `WHERE is_active=?` (the optimistic-
// concurrency guard for state transitions; a concurrent flip → 409).
// ════════════════════════════════════════════════════════════════════════════

router.post('/:id/activate', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    if (req.guardWh && !req.guardWh(res, id)) return;
    const existing = await _loadWarehouse(id);
    if (!existing) { const e = new Error('المستودع غير موجود'); e.status = 404; throw e; }

    const out = await db.withTransaction(async (conn) => {
      const [r] = await conn.query('UPDATE warehouses SET is_active=1 WHERE id=? AND is_active=0', [id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'المستودع نشط بالفعل أو تغيّرت حالته — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'activate', 'inactive', 'active', actor, req.body && req.body.note, null);
      return { auditEvent };
    });

    return _ok(res, { data: { id }, documentNumber: existing.code, status: 'active', auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// Deactivate is blocked while ANY warehouse_stock row has qty<>0 — the stock
// must be transferred / issued / adjusted to zero first (422 with the count).
router.post('/:id/deactivate', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    if (req.guardWh && !req.guardWh(res, id)) return;
    const existing = await _loadWarehouse(id);
    if (!existing) { const e = new Error('المستودع غير موجود'); e.status = 404; throw e; }

    const out = await db.withTransaction(async (conn) => {
      const [s] = await conn.query('SELECT COUNT(*) AS n FROM warehouse_stock WHERE warehouse_id=? AND qty<>0 FOR UPDATE', [id]);
      const n = Number(s[0] && s[0].n) || 0;
      if (n > 0) {
        const e = _err('VALIDATION_ERROR', 'لا يمكن تعطيل المستودع — يوجد ' + n + ' صنف برصيد غير صفري. حوّل أو اصرف أو سوِّ الأرصدة أولًا ثم أعد المحاولة');
        e.detail = { nonZeroStockRows: n };
        throw e;
      }
      const [r] = await conn.query('UPDATE warehouses SET is_active=0 WHERE id=? AND is_active=1', [id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'المستودع معطّل بالفعل أو تغيّرت حالته — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'deactivate', 'active', 'inactive', actor, req.body && req.body.note, null);
      return { auditEvent };
    });

    return _ok(res, { data: { id }, documentNumber: existing.code, status: 'inactive', auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE (admin only) — HARD delete, allowed ONLY for a warehouse with zero
// warehouse_stock rows AND zero inventory_movements rows (i.e. never used).
// Anything with history must be deactivated instead (422).
// ════════════════════════════════════════════════════════════════════════════
router.delete('/:id', ADMIN, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    if (req.guardWh && !req.guardWh(res, id)) return;
    const existing = await _loadWarehouse(id);
    if (!existing) { const e = new Error('المستودع غير موجود'); e.status = 404; throw e; }

    await db.withTransaction(async (conn) => {
      const [s] = await conn.query('SELECT COUNT(*) AS n FROM warehouse_stock WHERE warehouse_id=?', [id]);
      const [m] = await conn.query('SELECT COUNT(*) AS n FROM inventory_movements WHERE warehouse_id=?', [id]);
      const stockRows = Number(s[0] && s[0].n) || 0;
      const movementRows = Number(m[0] && m[0].n) || 0;
      if (stockRows > 0 || movementRows > 0) {
        const e = _err('VALIDATION_ERROR', 'لا يمكن الحذف الصلب — يوجد رصيد/حركات؛ عطّل المستودع بدلًا من ذلك');
        e.detail = { stockRows, movementRows };
        throw e;
      }
      // Scope grants for the warehouse go with it (FK is best-effort in this schema).
      try { await conn.query('DELETE FROM user_warehouse_access WHERE warehouse_id=?', [id]); } catch (_) {}
      const [r] = await conn.query('DELETE FROM warehouses WHERE id=?', [id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المستودع أثناء الحذف — أعد التحميل');
      // The audit row OUTLIVES the warehouse (append-only timeline by doc_id).
      await _audit(conn, id, 'delete', Number(existing.is_active) ? 'active' : 'inactive', null, actor, 'حذف صلب لمستودع غير مستخدم', { code: existing.code, name: existing.name });
    });

    return res.json({ success: true, code: null, data: { id }, status: 'deleted' });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// SCOPE ASSIGNMENTS (admin only) — read/replace user_warehouse_access rows.
// ════════════════════════════════════════════════════════════════════════════

// GET /:id/scope-assignments → current assignments + the assignable user list
// (active users; admins/developers have IMPLICIT global access and need no row).
router.get('/:id/scope-assignments', ADMIN, async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await _loadWarehouse(id);
    if (!existing) { const e = new Error('المستودع غير موجود'); e.status = 404; throw e; }

    const [arows] = await db.query(
      'SELECT a.user_id, a.created_at, a.created_by, u.username, u.full_name, u.role ' +
      'FROM user_warehouse_access a JOIN users u ON u.id = a.user_id WHERE a.warehouse_id=? ORDER BY u.username',
      [id]
    );
    const assignedIds = new Set(arows.map((r) => Number(r.user_id)));
    const [urows] = await db.query('SELECT id, username, full_name, role FROM users WHERE active=1 ORDER BY username');

    res.json({
      success: true,
      data: {
        warehouseId: String(id),
        assignments: arows.map((r) => ({
          userId: Number(r.user_id),
          username: r.username || '',
          fullName: r.full_name || '',
          role: r.role || '',
          createdAt: r.created_at || null,
          createdBy: r.created_by || '',
        })),
        users: urows.map((u) => ({
          id: Number(u.id),
          username: u.username || '',
          fullName: u.full_name || '',
          role: u.role || '',
          hasAccess: assignedIds.has(Number(u.id)),
        })),
      },
    });
  } catch (e) { _catch(res, e); }
});

// PUT /:id/scope-assignments { userIds: number[] } → REPLACE the warehouse's
// access rows atomically. Audited with added/removed ids.
router.put('/:id/scope-assignments', ADMIN, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const existing = await _loadWarehouse(id);
    if (!existing) { const e = new Error('المستودع غير موجود'); e.status = 404; throw e; }

    const raw = req.body && req.body.userIds;
    if (!Array.isArray(raw)) return _fail(res, 'VALIDATION_ERROR', 'userIds مطلوب — مصفوفة معرّفات مستخدمين');
    const userIds = [];
    const seen = new Set();
    for (const v of raw) {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return _fail(res, 'VALIDATION_ERROR', 'معرّف مستخدم غير صالح: ' + v);
      if (!seen.has(n)) { seen.add(n); userIds.push(n); }
    }
    if (userIds.length) {
      const [found] = await db.query('SELECT id FROM users WHERE id IN (?)', [userIds]);
      if (found.length !== userIds.length) {
        const ok = new Set(found.map((r) => Number(r.id)));
        const missing = userIds.filter((n) => !ok.has(n));
        return _fail(res, 'VALIDATION_ERROR', 'مستخدمون غير موجودين: ' + missing.join('، '));
      }
    }

    const out = await db.withTransaction(async (conn) => {
      const [prev] = await conn.query('SELECT user_id FROM user_warehouse_access WHERE warehouse_id=? FOR UPDATE', [id]);
      const before = prev.map((r) => Number(r.user_id));
      await conn.query('DELETE FROM user_warehouse_access WHERE warehouse_id=?', [id]);
      for (const uid of userIds) {
        await conn.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)', [uid, id, actor]);
      }
      const added = userIds.filter((n) => before.indexOf(n) === -1);
      const removed = before.filter((n) => userIds.indexOf(n) === -1);
      const auditEvent = await _audit(conn, id, 'scope_assign', null, null, actor, 'تحديث صلاحيات الوصول للمستودع', { userIds, added, removed });
      return { auditEvent };
    });

    return _ok(res, { data: { id, userIds }, documentNumber: existing.code, status: Number(existing.is_active) ? 'active' : 'inactive', auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

module.exports = router;
