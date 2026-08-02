/**
 * routes/production-batches.js — ONE production document covering SEVERAL
 * INDEPENDENT products.
 *
 * Mounted at /api/inventory/v2/production-batches.
 *
 * WHAT THIS REPLACES
 *
 * routes/warehouse-ops.js POST /production-orders used to accept an `items`
 * array and loop it with unwrapped `db.query` INSERTs: no transaction, three
 * silent `continue`s past bad input, and a `{ success: true }` response that
 * named neither the orders it skipped nor the fact that it had skipped any.
 * That branch now returns 410 and points here.
 *
 * THE DISTINCTION THIS DESIGN TURNS ON — and it is the whole point:
 *
 *   production_batch   N INDEPENDENT products. Each child is a real
 *                      production_order with its OWN bom + version, its OWN
 *                      quantity, its OWN source and output warehouse, its OWN
 *                      wip_balance and its OWN cost. A batch NEVER pools cost
 *                      across children — it is a document grouping, not a cost
 *                      object.
 *
 *   bom_outputs        the opposite case: outputs that genuinely come out of
 *                      ONE pool of consumed material (co-products, by-products)
 *                      and MUST share it. Those live inside a SINGLE order and
 *                      are allocated by lib/recipeEngine.allocateJointCost.
 *
 * Averaging unrelated products into one cost bucket is the error the two-table
 * split exists to prevent.
 *
 * ATOMICITY: create, approve and cancel are all-or-nothing across every child,
 * inside ONE db.withTransaction. There is no partial success anywhere; a
 * request that cannot be satisfied in full is refused in full, naming every
 * offending line. `posting_state` records a run that did not finish, so a crash
 * is observable instead of being reported as success.
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const P = require('../lib/productionEngine');
const R = require('../lib/recipeEngine');
const C = require('../lib/inventoryTxContract');
const E = require('../lib/inventoryTxEngine');
const IDEM = require('../lib/idempotencyStore');
const requireRole = require('../middleware/auth').requireRole;

const MGR = requireRole('admin', 'manager');
const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');
const MAKER_CHECKER = !/^(0|false|off|no)$/i.test(String(process.env.INV_MAKER_CHECKER || '').trim());
const MAX_CHILDREN = 100;

function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _role(req) { return String((req.user && req.user.role) || '').toLowerCase(); }
function _isAdmin(req) { return _role(req) === 'admin' || (req.user && req.user.isDeveloper); }
function _ymd() { const d = new Date(); return d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function _today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function _err(code, msg, detail) { const e = new Error(msg || code); e.code = code; if (detail) e.detail = detail; return e; }
function _fail(req, res, codeOrErr, message) {
  const code = C.isCanonical(codeOrErr) ? codeOrErr : C.mapError(codeOrErr);
  const msg = message || (codeOrErr && codeOrErr.message) || code;
  const body = C.errorBody(code, msg);
  body.requestId = req.requestId || null;
  if (codeOrErr && codeOrErr.detail) body.detail = codeOrErr.detail;
  return res.status(C.httpFor(code)).json(body);
}
function _catch(req, res, e) {
  if (e && e._guarded) return;
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found', requestId: req.requestId || null });
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) {
    console.error('[production-batches]', req.requestId || '-', (e && e.stack) || e);
    return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'خطأ داخلي في الخادم', requestId: req.requestId || null });
  }
  return _fail(req, res, e, e && e.message);
}
function _expectedVersion(req) {
  const raw = (req.body && req.body.expectedVersion != null) ? req.body.expectedVersion : (req.get && req.get('If-Match'));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function _nextBatchNumber(conn) {
  const ymd = _ymd();
  await conn.query(
    'INSERT INTO production_batch_counter (ymd, last_serial) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_serial = LAST_INSERT_ID(last_serial + 1)', [ymd]);
  const [r] = await conn.query('SELECT LAST_INSERT_ID() AS s');
  return 'PBT-' + ymd + '-' + String(Number(r[0] && r[0].s) || 1).padStart(4, '0');
}
async function _nextOrderNumber(conn) {
  const ymd = _ymd();
  await conn.query(
    'INSERT INTO production_counter (ymd, last_serial) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_serial = LAST_INSERT_ID(last_serial + 1)', [ymd]);
  const [r] = await conn.query('SELECT LAST_INSERT_ID() AS s');
  return 'PRD-' + ymd + '-' + String(Number(r[0] && r[0].s) || 1).padStart(4, '0');
}

async function _audit(conn, batchId, action, fromStatus, toStatus, actor, note, payload) {
  // FAIL-CLOSED, on the caller's transaction — same contract as the production
  // route's _audit. A batch must never post with no timeline row.
  await conn.query(
    'INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
    ['EV-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), 'production_batch', batchId, action,
     fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500),
     payload ? JSON.stringify(payload).slice(0, 8000) : null]);
  return { docType: 'production_batch', docId: batchId, action, fromStatus: fromStatus || null, toStatus: toStatus || null, actor: actor || '', at: new Date().toISOString() };
}

/**
 * Expand ONE child's BOM. Duplicate components are collapsed exactly as in
 * routes/inventory-production.js `_expandBom` — a plan with two rows for one
 * component is silently single-valued at issue time and loses material.
 */
async function _expandBom(conn, bomId, qtyPlanned, warehouseId) {
  const [bomRows] = await conn.query(
    "SELECT id, product_id, product_source, version, yield_quantity, yield_unit FROM bom WHERE id=? AND (is_active=1 OR status='active')", [bomId]);
  if (!bomRows.length) throw _err('VALIDATION_ERROR', 'الوصفة (BOM) غير موجودة أو غير نشطة: ' + bomId);
  const bom = bomRows[0];
  const yieldQ = Number(bom.yield_quantity) || 1;
  const batches = Number(qtyPlanned) / yieldQ;
  const [lines] = await conn.query('SELECT * FROM bom_lines WHERE bom_id=? ORDER BY line_no, id', [bomId]);
  if (!lines.length) throw _err('VALIDATION_ERROR', 'الوصفة بلا مكوّنات: ' + bomId);
  const byItem = new Map(); const order = [];
  for (const l of lines) {
    const net = Number(l.base_quantity != null ? l.base_quantity : l.quantity);
    const qty = P.round4(net * batches * (1 + (Number(l.waste_pct) || 0) / 100));
    if (byItem.has(l.component_item_id)) byItem.get(l.component_item_id).qty = P.round4(byItem.get(l.component_item_id).qty + qty);
    else { byItem.set(l.component_item_id, { itemId: l.component_item_id, qty }); order.push(l.component_item_id); }
  }
  const out = [];
  for (const id of order) {
    const r = byItem.get(id);
    const unitCost = await E.getEffectiveCost(conn, id, warehouseId);
    out.push({ itemId: id, qty: r.qty, unitCost: P.round4(unitCost), lineTotal: P.round2(r.qty * unitCost) });
  }
  return { bom, batches, lines: out };
}

// ════════════════════════════════════════════════════════════════════════════
// LIST
// ════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const p = C.parseListQuery(req.query, ['created_at', 'batch_date', 'status', 'batch_number'],
      ['draft', 'approved', 'in_progress', 'completed', 'closed', 'cancelled', 'reversed']);
    const where = ['1=1']; const params = [];
    if (p.status) { where.push('b.status=?'); params.push(p.status); }
    if (p.dateFrom) { where.push('b.batch_date >= ?'); params.push(p.dateFrom); }
    if (p.dateTo) { where.push('b.batch_date <= ?'); params.push(p.dateTo); }
    if (p.q) { where.push('b.batch_number LIKE ?'); params.push('%' + p.q + '%'); }
    if (p.warehouseId) { where.push('(b.warehouse_id=? OR b.output_warehouse_id=?)'); params.push(p.warehouseId, p.warehouseId); }
    // Scope on EITHER end, matching the production list.
    const scSrc = req.whScopeClause ? req.whScopeClause('b.warehouse_id') : { sql: '', params: [] };
    const scOut = req.whScopeClause ? req.whScopeClause('b.output_warehouse_id') : { sql: '', params: [] };
    const sc = (!scSrc.sql || !scOut.sql) ? { sql: '', params: [] } : {
      sql: ' AND ((1=1' + scSrc.sql + ') OR (b.output_warehouse_id IS NOT NULL AND 1=1' + scOut.sql + '))',
      params: (scSrc.params || []).concat(scOut.params || []),
    };
    const whereSql = ' WHERE ' + where.join(' AND ') + (sc.sql || '');
    const allParams = params.concat(sc.params || []);
    const [rows] = await db.query(
      `SELECT b.*, w.name AS warehouse_name, wo.name AS output_warehouse_name,
              (SELECT COUNT(*) FROM production_orders po WHERE po.batch_id=b.id) AS children,
              (SELECT COALESCE(SUM(po.total_cost),0) FROM production_orders po WHERE po.batch_id=b.id) AS total_cost,
              (SELECT COALESCE(SUM(po.wip_balance),0) FROM production_orders po WHERE po.batch_id=b.id) AS wip_balance
         FROM production_batches b
         LEFT JOIN warehouses w ON w.id=b.warehouse_id
         LEFT JOIN warehouses wo ON wo.id=b.output_warehouse_id
       ${whereSql} ORDER BY b.${p.sort} ${p.dir} LIMIT ? OFFSET ?`,
      allParams.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query('SELECT COUNT(*) AS total FROM production_batches b' + whereSql, allParams);
    const total = Number(cnt[0].total) || 0;
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id, batchNumber: r.batch_number, batchDate: r.batch_date, status: r.status,
        warehouseId: r.warehouse_id, warehouseName: r.warehouse_name || '',
        outputWarehouseId: r.output_warehouse_id, outputWarehouseName: r.output_warehouse_name || '',
        childCount: Number(r.children) || 0, version: Number(r.version) || 1,
        postingState: r.posting_state, postingError: r.posting_error || null,
        totalCost: P.round2(r.total_cost), wipBalance: P.round2(r.wip_balance),
        createdBy: r.created_by, createdAt: r.created_at, approvedBy: r.approved_by, approvedAt: r.approved_at,
        notes: r.notes || '',
      })),
      pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) },
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// DETAIL
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM production_batches WHERE id=? LIMIT 1', [req.params.id]);
    if (!rows.length) { const e = new Error('سند الإنتاج غير موجود'); e.status = 404; throw e; }
    const b = rows[0];
    if (req.guardWh && !req.guardWh(res, b.warehouse_id)) return;
    if (req.guardWh && b.output_warehouse_id && b.output_warehouse_id !== b.warehouse_id && !req.guardWh(res, b.output_warehouse_id)) return;
    const [children] = await db.query(
      `SELECT po.*, COALESCE(i.name, m.name, po.product_id) AS product_name,
              COALESCE(i.name_en, m.name_en, '') AS product_name_en,
              w.name AS warehouse_name, wo.name AS output_warehouse_name
         FROM production_orders po
         LEFT JOIN inv_items i ON i.id=po.product_id
         LEFT JOIN menu m ON m.id=po.product_id
         LEFT JOIN warehouses w ON w.id=po.warehouse_id
         LEFT JOIN warehouses wo ON wo.id=po.output_warehouse_id
        WHERE po.batch_id=? ORDER BY po.batch_line_no, po.id`, [b.id]);
    const [events] = await db.query(
      "SELECT * FROM inv_tx_events WHERE doc_type='production_batch' AND doc_id=? ORDER BY created_at ASC, id ASC", [b.id]);
    // Consolidated material demand across every child, with per-product
    // attribution — the same number the create screen previews.
    const [materials] = await db.query(
      `SELECT pc.item_id, i.name AS item_name, COALESCE(i.name_en,'') AS item_name_en, i.unit,
              pc.warehouse_id, SUM(pc.qty_planned) AS required, SUM(pc.qty_actual) AS issued,
              MAX(pc.unit_cost) AS unit_cost, COALESCE(ws.qty,0) AS available
         FROM production_consumption pc
         JOIN production_orders po ON po.id = pc.production_order_id
         LEFT JOIN inv_items i ON i.id = pc.item_id
         LEFT JOIN warehouse_stock ws ON ws.item_id=pc.item_id AND ws.warehouse_id=pc.warehouse_id
        WHERE po.batch_id=?
        GROUP BY pc.item_id, i.name, i.name_en, i.unit, pc.warehouse_id, ws.qty
        ORDER BY i.name`, [b.id]);
    const [attribution] = await db.query(
      `SELECT pc.item_id, po.id AS order_id, po.order_number,
              COALESCE(i2.name, m2.name, po.product_id) AS product_name, pc.qty_planned
         FROM production_consumption pc
         JOIN production_orders po ON po.id = pc.production_order_id
         LEFT JOIN inv_items i2 ON i2.id=po.product_id
         LEFT JOIN menu m2 ON m2.id=po.product_id
        WHERE po.batch_id=?`, [b.id]);
    res.json({
      success: true,
      data: {
        id: b.id, batchNumber: b.batch_number, batchDate: b.batch_date, status: b.status,
        warehouseId: b.warehouse_id, outputWarehouseId: b.output_warehouse_id,
        brandId: b.brand_id, branchId: b.branch_id, notes: b.notes || '',
        version: Number(b.version) || 1, postingState: b.posting_state, postingError: b.posting_error || null,
        childCount: Number(b.child_count) || children.length,
        createdBy: b.created_by, createdAt: b.created_at,
        approvedBy: b.approved_by, approvedAt: b.approved_at,
        cancelledBy: b.cancelled_by, cancelledAt: b.cancelled_at, cancelReason: b.cancel_reason,
      },
      children: children.map((c) => ({
        id: c.id, orderNumber: c.order_number, lineNo: Number(c.batch_line_no) || 0,
        bomId: c.bom_id, bomVersion: c.bom_version == null ? null : Number(c.bom_version),
        productId: c.product_id, productName: c.product_name, productNameEn: c.product_name_en,
        qtyPlanned: Number(c.qty_planned), qtyProduced: Number(c.qty_produced), qtyWaste: Number(c.qty_waste),
        status: c.status, warehouseId: c.warehouse_id, warehouseName: c.warehouse_name || '',
        outputWarehouseId: c.output_warehouse_id, outputWarehouseName: c.output_warehouse_name || '',
        // Each child carries its OWN WIP and cost — a batch never pools them.
        wipBalance: P.round2(c.wip_balance), totalCost: P.round2(c.total_cost), unitCost: P.round4(c.unit_cost),
        allowedScrapPct: c.allowed_scrap_pct == null ? null : Number(c.allowed_scrap_pct),
        batchNumber: c.batch_number, version: Number(c.version) || 1,
      })),
      materials: materials.map((m) => ({
        itemId: m.item_id, itemName: m.item_name || m.item_id, itemNameEn: m.item_name_en || '',
        unit: m.unit || '', warehouseId: m.warehouse_id,
        required: P.round4(m.required), issued: P.round4(m.issued),
        remaining: P.round4(Number(m.required) - Number(m.issued)),
        available: Number(m.available) || 0,
        shortage: P.round4(Math.max(0, Number(m.required) - Number(m.issued) - (Number(m.available) || 0))),
        unitCost: P.round4(m.unit_cost),
        attribution: attribution.filter((a) => a.item_id === m.item_id).map((a) => ({
          orderId: a.order_id, orderNumber: a.order_number, productName: a.product_name, qty: P.round4(a.qty_planned),
        })),
      })),
      timeline: events,
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// PREVIEW — consolidated materials for a proposed batch, BEFORE it exists
// ════════════════════════════════════════════════════════════════════════════
router.post('/preview', async (req, res) => {
  try {
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return _fail(req, res, 'VALIDATION_ERROR', 'أضف منتجًا واحدًا على الأقل');
    if (items.length > MAX_CHILDREN) return _fail(req, res, 'VALIDATION_ERROR', 'عدد المنتجات يتجاوز الحد (' + MAX_CHILDREN + ')');
    const defaultWh = b.warehouseId || b.warehouse_id;
    const perProduct = [];
    const consolidated = new Map();
    // Validate EVERY line first and report ALL failures at once — the retired
    // legacy path dropped bad lines silently, one at a time.
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const wh = it.warehouseId || defaultWh;
      if (!it.bomId) { errors.push({ line: i, code: 'BOM_REQUIRED', message: 'الوصفة مطلوبة' }); continue; }
      if (!(Number(it.qtyPlanned) > 0)) { errors.push({ line: i, code: 'QTY_INVALID', message: 'الكمية يجب أن تكون موجبة' }); continue; }
      if (!wh) { errors.push({ line: i, code: 'WAREHOUSE_REQUIRED', message: 'مستودع المواد مطلوب' }); continue; }
      let expanded;
      try { expanded = await _expandBom(db, it.bomId, Number(it.qtyPlanned), wh); }
      catch (e) { errors.push({ line: i, code: e.code || 'VALIDATION_ERROR', message: e.message }); continue; }
      perProduct.push({ line: i, bomId: it.bomId, productId: expanded.bom.product_id, qtyPlanned: Number(it.qtyPlanned), warehouseId: wh, lines: expanded.lines });
      for (const l of expanded.lines) {
        const key = l.itemId + '|' + wh;
        if (!consolidated.has(key)) consolidated.set(key, { itemId: l.itemId, warehouseId: wh, required: 0, unitCost: l.unitCost, attribution: [] });
        const c = consolidated.get(key);
        c.required = P.round4(c.required + l.qty);
        c.attribution.push({ line: i, bomId: it.bomId, productId: expanded.bom.product_id, qty: l.qty });
      }
    }
    if (errors.length) return _fail(req, res, _err('VALIDATION_ERROR', 'بعض السطور غير صالحة', errors));

    const keys = Array.from(consolidated.values());
    const itemIds = Array.from(new Set(keys.map((k) => k.itemId)));
    const meta = new Map();
    if (itemIds.length) {
      const [rows] = await db.query("SELECT id, name, COALESCE(name_en,'') AS name_en, unit, COALESCE(tracking_mode,'none') AS tracking_mode FROM inv_items WHERE id IN (?)", [itemIds]);
      for (const r of rows) meta.set(r.id, r);
    }
    const stock = new Map();
    for (const k of keys) {
      const [ws] = await db.query('SELECT COALESCE(qty,0) AS qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1', [k.warehouseId, k.itemId]);
      stock.set(k.itemId + '|' + k.warehouseId, ws.length ? Number(ws[0].qty) : 0);
    }
    const materials = keys.map((k) => {
      const m = meta.get(k.itemId) || {};
      const available = stock.get(k.itemId + '|' + k.warehouseId) || 0;
      return {
        itemId: k.itemId, itemName: m.name || k.itemId, itemNameEn: m.name_en || '',
        unit: m.unit || '', trackingMode: m.tracking_mode || 'none', warehouseId: k.warehouseId,
        required: k.required, available, delta: P.round4(available - k.required),
        status: available >= k.required ? 'ok' : 'short',
        unitCost: k.unitCost, lineCost: P.round2(k.required * k.unitCost),
        // Per-product attribution: WHICH child needs how much of this material.
        attribution: k.attribution,
      };
    }).sort((a, b2) => a.delta - b2.delta);

    const shortageCount = materials.filter((m) => m.status === 'short').length;
    res.json({
      success: true,
      data: {
        products: perProduct.map((p) => ({
          line: p.line, bomId: p.bomId, productId: p.productId, qtyPlanned: p.qtyPlanned,
          warehouseId: p.warehouseId, materialCost: P.round2(p.lines.reduce((s, l) => s + l.lineTotal, 0)),
        })),
        materials,
        summary: {
          productCount: perProduct.length, materialCount: materials.length,
          shortageCount, allAvailable: shortageCount === 0,
          totalMaterialCost: P.round2(materials.reduce((s, m) => s + m.lineCost, 0)),
        },
      },
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE — ATOMIC across every child
// ════════════════════════════════════════════════════════════════════════════
router.post('/', BACKOFFICE, async (req, res) => {
  let idemId = null;
  try {
    const actor = _actor(req);
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return _fail(req, res, 'VALIDATION_ERROR', 'أضف منتجًا واحدًا على الأقل');
    if (items.length > MAX_CHILDREN) return _fail(req, res, 'VALIDATION_ERROR', 'عدد المنتجات يتجاوز الحد (' + MAX_CHILDREN + ')');
    const defaultWh = b.warehouseId || b.warehouse_id;
    const defaultOutWh = b.outputWarehouseId || b.output_warehouse_id || defaultWh;
    if (!defaultWh) return _fail(req, res, 'VALIDATION_ERROR', 'مستودع المواد مطلوب');

    // Guard EVERY warehouse the batch will touch, before anything is written.
    const touched = new Set([defaultWh, defaultOutWh]);
    for (const it of items) {
      if (it.warehouseId) touched.add(it.warehouseId);
      if (it.outputWarehouseId) touched.add(it.outputWarehouseId);
    }
    for (const wh of touched) {
      if (req.guardWh && !req.guardWh(res, wh)) return;
    }

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'prodbatch:create', '', key, actor, b);
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(req, res, 'IDEMPOTENCY_CONFLICT', 'طلب مكرر بمحتوى مختلف أو قيد التنفيذ');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const out = await db.withTransaction(async (conn) => {
      // VALIDATE EVERY LINE FIRST. The retired legacy path validated as it went
      // and `continue`d past failures, so the caller learned nothing about what
      // was dropped. Here the whole request is refused, naming every bad line.
      const errors = [];
      const prepared = [];
      const whIds = Array.from(touched);
      const [whRows] = await conn.query('SELECT id, brand_id, branch_id FROM warehouses WHERE id IN (?)', [whIds]);
      const whMap = new Map(whRows.map((w) => [w.id, w]));
      for (const wh of whIds) if (!whMap.has(wh)) errors.push({ line: -1, code: 'WAREHOUSE_NOT_FOUND', message: 'مستودع غير موجود: ' + wh });

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const wh = it.warehouseId || defaultWh;
        const outWh = it.outputWarehouseId || defaultOutWh || wh;
        if (!it.bomId) { errors.push({ line: i, code: 'BOM_REQUIRED', message: 'الوصفة مطلوبة' }); continue; }
        if (!(Number(it.qtyPlanned) > 0)) { errors.push({ line: i, code: 'QTY_INVALID', message: 'الكمية يجب أن تكون موجبة' }); continue; }
        let expanded;
        try { expanded = await _expandBom(conn, it.bomId, Number(it.qtyPlanned), wh); }
        catch (e) { errors.push({ line: i, code: e.code || 'VALIDATION_ERROR', message: e.message, bomId: it.bomId }); continue; }
        // NULL, not 0 — 0 is an explicit zero-scrap policy (see 0027).
        const scrap = (it.allowedScrapPct != null && it.allowedScrapPct !== '' && Number.isFinite(Number(it.allowedScrapPct)))
          ? Number(it.allowedScrapPct) : null;
        prepared.push({ line: i, item: it, wh, outWh, expanded, scrap });
      }
      if (errors.length) throw _err('VALIDATION_ERROR', 'بعض السطور غير صالحة — لم يُنشأ أي أمر', errors);

      const batchId = 'PBT-' + crypto.randomBytes(6).toString('hex');
      const batchNumber = await _nextBatchNumber(conn);
      const srcWh = whMap.get(defaultWh) || {};
      await conn.query(
        `INSERT INTO production_batches
           (id, batch_number, batch_date, status, warehouse_id, output_warehouse_id, brand_id, branch_id,
            notes, version, posting_state, child_count, created_by)
         VALUES (?,?,?, 'draft', ?,?,?,?,?,1,'idle',?,?)`,
        [batchId, batchNumber, b.batchDate || _today(), defaultWh, defaultOutWh,
         srcWh.brand_id || null, srcWh.branch_id || null,
         (b.notes || '').toString().slice(0, 2000) || null, prepared.length, actor]);

      const children = [];
      for (const p of prepared) {
        const orderNumber = await _nextOrderNumber(conn);
        const orderId = 'POV2-' + crypto.randomBytes(6).toString('hex');
        const cw = whMap.get(p.wh) || {};
        await conn.query(
          `INSERT INTO production_orders
             (id, order_number, bom_id, bom_version, product_id, warehouse_id, output_warehouse_id,
              brand_id, branch_id, qty_planned, status, source, version, notes, created_by, planned_date,
              priority, allowed_scrap_pct, batch_number, batch_id, batch_line_no)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'draft','v2',1, ?,?,?,?,?,?,?,?)`,
          [orderId, orderNumber, p.item.bomId, Number(p.expanded.bom.version) || null, p.expanded.bom.product_id,
           p.wh, p.outWh, cw.brand_id || null, cw.branch_id || null, Number(p.item.qtyPlanned),
           (p.item.notes || '').toString().slice(0, 2000) || null, actor, b.batchDate || _today(),
           (typeof p.item.priority === 'string' && p.item.priority) ? p.item.priority.slice(0, 20) : 'normal',
           p.scrap,
           (typeof p.item.batchNumber === 'string' && p.item.batchNumber.trim()) ? p.item.batchNumber.trim().slice(0, 80) : null,
           batchId, p.line]);
        for (const l of p.expanded.lines) {
          await conn.query(
            `INSERT INTO production_consumption (id, production_order_id, item_id, warehouse_id, qty_planned, qty_actual, unit_cost, total_cost)
             VALUES (?,?,?,?,?,0,?,0)`,
            ['PCC-' + crypto.randomBytes(6).toString('hex'), orderId, l.itemId, p.wh, l.qty, l.unitCost]);
        }
        children.push({ id: orderId, orderNumber, line: p.line, productId: p.expanded.bom.product_id, qtyPlanned: Number(p.item.qtyPlanned) });
      }

      const auditEvent = await _audit(conn, batchId, 'create', null, 'draft', actor, b.notes || '', {
        childCount: children.length, orders: children.map((c) => c.orderNumber),
      });
      return { batchId, batchNumber, children, auditEvent };
    });

    const body = C.mutationEnvelope({
      data: { id: out.batchId, batchNumber: out.batchNumber, children: out.children },
      documentNumber: out.batchNumber, status: 'draft', version: 1,
      affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent,
    });
    body.requestId = req.requestId || null;
    if (idemId) await IDEM.complete(db, idemId, 201, body);
    return res.status(201).json(body);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(req, res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// APPROVE — atomic across every child, or nothing
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/approve', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM production_batches WHERE id=? FOR UPDATE', [id]);
      if (!rows.length) { const e = new Error('سند الإنتاج غير موجود'); e.status = 404; throw e; }
      const batch = rows[0];
      if (batch.status !== 'draft') throw _err('INVALID_STATE_TRANSITION', 'لا يمكن اعتماد سند حالته "' + batch.status + '"');
      if (expected != null && Number(batch.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر السند — أعد التحميل');
      if (MAKER_CHECKER && !_isAdmin(req) && batch.created_by && batch.created_by === actor) {
        throw _err('PERMISSION_DENIED', 'لا يمكن لمُنشئ السند اعتماده بنفسه (Maker–Checker)');
      }
      const [children] = await conn.query("SELECT * FROM production_orders WHERE batch_id=? FOR UPDATE", [id]);
      if (!children.length) throw _err('VALIDATION_ERROR', 'السند بلا أوامر — لا شيء لاعتماده');
      // Every child must be approvable. Refusing the whole batch is the point:
      // the retired path approved what it could and reported success.
      const bad = children.filter((c) => c.status !== 'draft');
      if (bad.length) {
        throw _err('INVALID_STATE_TRANSITION', 'بعض الأوامر ليست مسودات — لم يُعتمد أي منها',
          bad.map((c) => ({ orderNumber: c.order_number, status: c.status })));
      }
      // `posting_state` marks a run in flight, so a crash mid-approve is
      // observable at rest rather than looking like a completed draft.
      await conn.query("UPDATE production_batches SET posting_state='approving' WHERE id=?", [id]);
      for (const c of children) {
        const [u] = await conn.query(
          "UPDATE production_orders SET status='approved', approved_by=?, approved_at=NOW(), version=version+1 WHERE id=? AND status='draft' AND source='v2' AND version=?",
          [actor, c.id, c.version]);
        if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّر أمر الإنتاج ' + c.order_number + ' أثناء الاعتماد — أُلغي اعتماد السند بالكامل');
      }
      const [ub] = await conn.query(
        "UPDATE production_batches SET status='approved', approved_by=?, approved_at=NOW(), posting_state='idle', posting_error=NULL, version=version+1 WHERE id=? AND status='draft'" + (expected != null ? ' AND version=?' : ''),
        expected != null ? [actor, id, expected] : [actor, id]);
      if (!ub || ub.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة السند — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'approve', 'draft', 'approved', actor, req.body && req.body.note, {
        childCount: children.length, orders: children.map((c) => c.order_number),
      });
      return { version: Number(batch.version) + 1, childCount: children.length, auditEvent };
    });
    const body = C.mutationEnvelope({
      data: { id, approvedChildren: out.childCount }, documentNumber: id, status: 'approved',
      version: out.version, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent,
    });
    body.requestId = req.requestId || null;
    res.json(body);
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CANCEL — draft|approved only, and only while NO child has issued material
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/cancel', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const reason = String((req.body && (req.body.reason || req.body.note)) || '').trim();
    if (!reason) return _fail(req, res, 'VALIDATION_ERROR', 'سبب الإلغاء إلزامي');
    const expected = _expectedVersion(req);
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM production_batches WHERE id=? FOR UPDATE', [id]);
      if (!rows.length) { const e = new Error('سند الإنتاج غير موجود'); e.status = 404; throw e; }
      const batch = rows[0];
      if (batch.status !== 'draft' && batch.status !== 'approved') {
        throw _err('INVALID_STATE_TRANSITION', 'لا يمكن إلغاء سند حالته "' + batch.status + '" — استخدم العكس على الأوامر');
      }
      if (expected != null && Number(batch.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر السند — أعد التحميل');
      const [children] = await conn.query('SELECT * FROM production_orders WHERE batch_id=? FOR UPDATE', [id]);
      const [issued] = await conn.query(
        `SELECT DISTINCT po.order_number FROM production_orders po
           JOIN production_issue_events pie ON pie.production_order_id = po.id
          WHERE po.batch_id=?`, [id]);
      if (issued.length) {
        throw _err('INVALID_STATE_TRANSITION', 'صدرت مواد لبعض الأوامر — لا يمكن إلغاء السند؛ استخدم العكس (reverse) على تلك الأوامر',
          issued.map((r) => r.order_number));
      }
      for (const c of children) {
        const [u] = await conn.query(
          "UPDATE production_orders SET status='cancelled', cancelled_by=?, cancelled_at=NOW(), cancel_reason=?, version=version+1 WHERE id=? AND status IN ('draft','approved') AND source='v2' AND version=?",
          [actor, reason.slice(0, 500), c.id, c.version]);
        if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّر أمر الإنتاج ' + c.order_number + ' أثناء الإلغاء');
      }
      const [ub] = await conn.query(
        "UPDATE production_batches SET status='cancelled', cancelled_by=?, cancelled_at=NOW(), cancel_reason=?, version=version+1 WHERE id=? AND status IN ('draft','approved')",
        [actor, reason.slice(0, 500), id]);
      if (!ub || ub.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة السند — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'cancel', batch.status, 'cancelled', actor, reason, { childCount: children.length });
      return { version: Number(batch.version) + 1, auditEvent };
    });
    const body = C.mutationEnvelope({
      data: { id }, documentNumber: id, status: 'cancelled', version: out.version,
      affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent,
    });
    body.requestId = req.requestId || null;
    res.json(body);
  } catch (e) { _catch(req, res, e); }
});

module.exports = router;
