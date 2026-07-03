/**
 * Production Orders V2 — Phase P1 (warehouse final completion).
 *
 * Mounted at /api/inventory/v2/production-orders (inherits scope middleware,
 * v2 metrics/rate-limit/canary from the path prefix — server.js).
 *
 * Lifecycle (lib/productionEngine.js — V2 statuses disjoint from legacy):
 *   draft → approved → in_progress → completed → closed        (+ reversed)
 *   draft|approved → cancelled (only BEFORE any materials issue)
 *   delete: draft only. "partially completed" is DERIVED (in_progress + output>0).
 *
 * Every mutation follows the routes/inventory-transactions.js contract:
 * actor from JWT, RBAC, warehouse scope on source AND output, expectedVersion
 * (conditional UPDATE → VERSION_CONFLICT), Idempotency-Key, inv_tx_events
 * audit (doc_type='production'), unified envelope, ONE db.withTransaction.
 *
 * Stock/lots/GL per event:
 *   issue-materials  → −stock@WAC (frozen) / FEFO lots / Dr WIP Cr inventory
 *   record-output    → +FG stock (WAC via engine) / output lot / Dr FG (+Dr
 *                      WASTE_FINISHED for waste) Cr WIP
 *   close            → residual WIP → PRODUCTION_VARIANCE 5420
 *   reverse          → exact-lot restoration + per-journal reversing entries
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const gl = require('../lib/glPosting');
const E = require('../lib/inventoryTxEngine');
const P = require('../lib/productionEngine');
const C = require('../lib/inventoryTxContract');
const IDEM = require('../lib/idempotencyStore');
const L = require('../lib/lotLedger');
const { recomputeInvItemStock } = require('../lib/stockRecompute');
const requireRole = require('../middleware/auth').requireRole;

const MGR = requireRole('admin', 'manager');
const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');

const MAKER_CHECKER = !/^(0|false|off|no)$/i.test(String(process.env.INV_MAKER_CHECKER || '').trim());
const ALL_STATUSES = P.V2_STATUSES.concat(P.LEGACY_STATUSES);

// ── Generic helpers (contract-identical with inventory-transactions.js) ─────
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _role(req) { return String((req.user && req.user.role) || '').toLowerCase(); }
function _isAdmin(req) { return _role(req) === 'admin' || (req.user && req.user.isDeveloper); }
function _isMgr(req) { return _isAdmin(req) || _role(req) === 'manager'; }
function _ymd(d) { d = d || new Date(); return d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function _today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function _dateStr(d) {
  if (!d) return _today();
  if (d instanceof Date) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return String(d).slice(0, 10);
}
function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function _expectedVersion(req) {
  const raw = (req.body && req.body.expectedVersion != null) ? req.body.expectedVersion : (req.get && req.get('If-Match'));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
function _envelope(parts, legacy) { return Object.assign({}, C.mutationEnvelope(parts), legacy || {}); }
function _ok(res, parts, legacy, statusCode) { const body = _envelope(parts, legacy); res.status(statusCode || 200).json(body); return body; }
function _fail(res, codeOrErr, message) {
  const code = C.isCanonical(codeOrErr) ? codeOrErr : C.mapError(codeOrErr);
  const msg = message || (codeOrErr && codeOrErr.message) || code;
  return res.status(C.httpFor(code)).json(C.errorBody(code, msg));
}
function _catch(res, e) {
  if (e && e._guarded) return;
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found' });
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: (e && e.message) || 'error' });
  return _fail(res, e, e && e.message);
}

// Atomic per-day serial on the SAME connection (shared with the legacy counter
// table so PRD- numbers never collide between the two write paths).
async function _nextNumber(conn) {
  const ymd = _ymd();
  await conn.query('INSERT INTO production_counter (ymd, last_serial) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_serial = LAST_INSERT_ID(last_serial + 1)', [ymd]);
  const [r] = await conn.query('SELECT LAST_INSERT_ID() AS s');
  return 'PRD-' + ymd + '-' + String(Number(r[0] && r[0].s) || 1).padStart(4, '0');
}

async function _audit(conn, docId, action, fromStatus, toStatus, actor, note, payload) {
  const q = conn || db;
  try {
    await q.query(
      'INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
      ['EV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), 'production', docId, action, fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500), payload ? JSON.stringify(payload).slice(0, 8000) : null]
    );
  } catch (_) { /* audit best-effort */ }
  return { docType: 'production', docId, action, fromStatus: fromStatus || null, toStatus: toStatus || null, actor: actor || '', at: new Date().toISOString() };
}

async function _loadWarehouse(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT id, code, name, type, is_main, brand_id, branch_id FROM warehouses WHERE id=? LIMIT 1', [id]);
  return rows[0] || null;
}
async function _loadOrder(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM production_orders WHERE id=? LIMIT 1' + (conn ? ' FOR UPDATE' : ''), [id]);
  return rows[0] || null;
}
async function _seqOf(conn, movementId) {
  const [r] = await conn.query('SELECT seq FROM inventory_movements WHERE id=? LIMIT 1', [movementId]);
  return r.length ? Number(r[0].seq) : null;
}
async function _issueEventCount(id, conn) {
  const q = conn || db;
  const [r] = await q.query('SELECT COUNT(*) AS c FROM production_issue_events WHERE production_order_id=?', [id]);
  return Number(r[0].c) || 0;
}
// Resolve the produced item's display name (BOM products may live in inv_items or menu).
async function _productName(q, productId) {
  try {
    const [r] = await q.query('SELECT name FROM inv_items WHERE id=? UNION ALL SELECT name FROM menu WHERE id=? LIMIT 1', [productId, productId]);
    return r.length ? r[0].name : '';
  } catch (_) { return ''; }
}

// BOM expansion (same math as legacy create: qty × batches × (1 + waste_pct)).
async function _expandBom(q, bomId, qtyPlanned, warehouseId) {
  const [bomRows] = await q.query('SELECT id, product_id, yield_quantity, yield_unit FROM bom WHERE id=? AND is_active=1', [bomId]);
  if (!bomRows.length) throw _err('VALIDATION_ERROR', 'الوصفة (BOM) غير موجودة أو غير نشطة: ' + bomId);
  const bom = bomRows[0];
  const yieldQ = Number(bom.yield_quantity) || 1;
  const batches = Number(qtyPlanned) / yieldQ;
  const [lines] = await q.query('SELECT * FROM bom_lines WHERE bom_id=?', [bomId]);
  if (!lines.length) throw _err('VALIDATION_ERROR', 'الوصفة بلا مكوّنات — أضف مكوّنات أولًا');
  const out = [];
  for (const l of lines) {
    const waste = Number(l.waste_pct || 0) / 100;
    const qty = P.round4(Number(l.quantity) * batches * (1 + waste));
    const unitCost = await E.getEffectiveCost(q, l.component_item_id, warehouseId);
    out.push({ itemId: l.component_item_id, qty, unitCost: P.round4(unitCost), lineTotal: P.round2(qty * unitCost) });
  }
  return { bom, batches, lines: out };
}

async function _insertConsumption(conn, orderId, warehouseId, expanded) {
  for (const l of expanded.lines) {
    await conn.query(
      'INSERT INTO production_consumption (id, production_order_id, item_id, warehouse_id, qty_planned, qty_actual, unit_cost, total_cost) VALUES (?,?,?,?,?,0,?,0)',
      ['PCC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), orderId, l.itemId, warehouseId, l.qty, l.unitCost]
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// READ — BOM picker (wizard step 1)
// ════════════════════════════════════════════════════════════════════════════
router.get('/boms', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 120);
    const params = [];
    let where = 'b.is_active=1';
    if (q) { where += ' AND (COALESCE(i.name, m.name) LIKE ? OR b.product_id LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
    const [rows] = await db.query(
      `SELECT b.id, b.product_id, b.version, b.yield_quantity, b.yield_unit,
              COALESCE(i.name, m.name, b.product_id) AS product_name,
              COALESCE(i.unit, m.unit, '') AS product_unit,
              COALESCE(i.tracking_mode, 'none') AS tracking_mode,
              (SELECT COUNT(*) FROM bom_lines bl WHERE bl.bom_id=b.id) AS line_count
       FROM bom b
       LEFT JOIN inv_items i ON i.id=b.product_id
       LEFT JOIN menu m ON m.id=b.product_id
       WHERE ${where}
       ORDER BY product_name LIMIT 300`, params);
    res.json({ data: rows });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// Availability PREVIEW (wizard, before the order exists)
// ════════════════════════════════════════════════════════════════════════════
router.post('/preview-availability', async (req, res) => {
  try {
    const { bomId, qtyPlanned, warehouseId } = req.body || {};
    if (!bomId || !warehouseId) return _fail(res, 'VALIDATION_ERROR', 'bomId وwarehouseId مطلوبان');
    if (!(Number(qtyPlanned) > 0)) return _fail(res, 'VALIDATION_ERROR', 'الكمية المخططة يجب أن تكون موجبة');
    if (req.guardWh && !req.guardWh(res, warehouseId)) return;
    const expanded = await _expandBom(db, bomId, Number(qtyPlanned), warehouseId);
    const items = [];
    for (const l of expanded.lines) {
      const snap = await E.readStock(db, warehouseId, l.itemId);
      const [meta] = await db.query('SELECT name, unit, tracking_mode FROM inv_items WHERE id=? LIMIT 1', [l.itemId]);
      const m = meta[0] || {};
      let fefoQty = null;
      if (L.isTracked(m.tracking_mode)) {
        const lots = await L.loadBalances(db, warehouseId, l.itemId);
        const plan = L.planFefo(lots, l.qty, {});
        fefoQty = P.round4(l.qty - (plan.shortfall || 0));
      }
      const delta = P.round4(snap.qty - l.qty);
      items.push({
        itemId: l.itemId, itemName: m.name || l.itemId, itemUnit: m.unit || '',
        trackingMode: m.tracking_mode || 'none',
        required: l.qty, available: snap.qty, delta, unitCost: l.unitCost,
        lineCost: l.lineTotal, fefoAvailable: fefoQty,
        status: delta >= 0 ? 'ok' : 'short',
      });
    }
    items.sort((a, b) => a.delta - b.delta);
    const shortageCount = items.filter((x) => x.status === 'short').length;
    res.json({
      items,
      summary: {
        shortageCount, allAvailable: shortageCount === 0, itemCount: items.length,
        reservedValue: P.round2(items.reduce((s, x) => s + x.lineCost, 0)), batches: expanded.batches,
      },
      bom: { id: expanded.bom.id, productId: expanded.bom.product_id, yieldQuantity: Number(expanded.bom.yield_quantity) || 1 },
    });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// LIST + KPIs
// ════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const p = C.parseListQuery(req.query, ['created_at', 'planned_date', 'status', 'order_number', 'qty_planned'], ALL_STATUSES);
    const sc = req.whScopeClause ? req.whScopeClause('po.warehouse_id') : { sql: '', params: [] };
    const where = ['1=1'];
    const params = [];
    if (p.status) { where.push('po.status=?'); params.push(p.status); }
    if (p.warehouseId) { where.push('(po.warehouse_id=? OR po.output_warehouse_id=?)'); params.push(p.warehouseId, p.warehouseId); }
    if (req.query.productId) { where.push('po.product_id=?'); params.push(String(req.query.productId)); }
    if (req.query.source === 'v2' || req.query.source === 'legacy') { where.push('po.source=?'); params.push(req.query.source); }
    if (p.dateFrom) { where.push('po.planned_date >= ?'); params.push(p.dateFrom); }
    if (p.dateTo) { where.push('po.planned_date <= ?'); params.push(p.dateTo); }
    if (p.q) { where.push('(po.order_number LIKE ? OR po.batch_number LIKE ?)'); params.push('%' + p.q + '%', '%' + p.q + '%'); }
    const whereSql = ' WHERE ' + where.join(' AND ') + (sc.sql || '');
    const allParams = params.concat(sc.params || []);
    const [rows] = await db.query(
      `SELECT po.id, po.order_number, po.bom_id, po.product_id, po.status, po.source, po.version,
              po.qty_planned, po.qty_produced, po.qty_waste, po.qty_scrap, po.wip_balance,
              po.materials_cost, po.labor_cost, po.overhead_cost, po.total_cost, po.unit_cost, po.yield_pct,
              po.warehouse_id, po.output_warehouse_id, po.planned_date, po.priority, po.batch_number,
              po.created_by, po.created_at, po.approved_by, po.completed_at,
              COALESCE(i.name, m.name, po.product_id) AS product_name,
              COALESCE(i.unit, m.unit, '') AS product_unit,
              w.name AS warehouse_name, wo.name AS output_warehouse_name
       FROM production_orders po
       LEFT JOIN inv_items i ON i.id=po.product_id
       LEFT JOIN menu m ON m.id=po.product_id
       LEFT JOIN warehouses w ON w.id=po.warehouse_id
       LEFT JOIN warehouses wo ON wo.id=po.output_warehouse_id
       ${whereSql} ORDER BY po.${p.sort} ${p.dir} LIMIT ? OFFSET ?`,
      allParams.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query('SELECT COUNT(*) AS total FROM production_orders po' + whereSql, allParams);
    const [kpi] = await db.query(
      `SELECT SUM(po.status='draft') AS draft, SUM(po.status='approved') AS approved,
              SUM(po.status='in_progress') AS in_progress,
              SUM(po.status='in_progress' AND po.qty_produced>0) AS partially_completed,
              SUM(po.status='completed') AS completed, SUM(po.status='closed') AS closed,
              SUM(po.status='cancelled') AS cancelled, SUM(po.status='reversed') AS reversed,
              SUM(po.status IN ('planned','released')) AS legacy_active,
              SUM(CASE WHEN po.status IN ('in_progress','completed') THEN po.wip_balance ELSE 0 END) AS wip_value,
              SUM(CASE WHEN po.status IN ('completed','closed') THEN po.qty_produced*po.unit_cost ELSE 0 END) AS produced_value
       FROM production_orders po` + whereSql, allParams);
    const total = Number(cnt[0].total) || 0;
    const k = kpi[0] || {};
    res.json({
      data: rows.map((r) => Object.assign(r, { partially_completed: P.isPartiallyCompleted(r.status, r.qty_produced) })),
      pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) },
      kpis: {
        draft: Number(k.draft) || 0, approved: Number(k.approved) || 0,
        inProgress: Number(k.in_progress) || 0, partiallyCompleted: Number(k.partially_completed) || 0,
        completed: Number(k.completed) || 0, closed: Number(k.closed) || 0,
        cancelled: Number(k.cancelled) || 0, reversed: Number(k.reversed) || 0,
        legacyActive: Number(k.legacy_active) || 0,
        wipValue: P.round2(k.wip_value), producedValue: P.round2(k.produced_value),
      },
      filters: { status: p.status, warehouseId: p.warehouseId, dateFrom: p.dateFrom, dateTo: p.dateTo, q: p.q, sort: p.sort, dir: p.dir },
    });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// DETAIL — header + plan + issue/output events + lots + timeline + journals
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const doc = await _loadOrder(req.params.id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    doc.product_name = await _productName(db, doc.product_id);
    doc.product_tracking_mode = await L.getTrackingMode(db, doc.product_id);
    const [wh] = await db.query('SELECT id, name FROM warehouses WHERE id IN (?, ?)', [doc.warehouse_id, doc.output_warehouse_id || doc.warehouse_id]);
    doc.warehouse_name = (wh.find((w) => w.id === doc.warehouse_id) || {}).name || '';
    doc.output_warehouse_name = (wh.find((w) => w.id === (doc.output_warehouse_id || doc.warehouse_id)) || {}).name || '';
    doc.partially_completed = P.isPartiallyCompleted(doc.status, doc.qty_produced);

    const [plan] = await db.query(
      `SELECT pc.*, i.name AS item_name, i.unit AS item_unit, COALESCE(i.tracking_mode,'none') AS tracking_mode,
              COALESCE(ws.qty,0) AS available
       FROM production_consumption pc
       LEFT JOIN inv_items i ON i.id=pc.item_id
       LEFT JOIN warehouse_stock ws ON ws.item_id=pc.item_id AND ws.warehouse_id=pc.warehouse_id
       WHERE pc.production_order_id=? ORDER BY i.name`, [doc.id]);
    const [issueEvents] = await db.query('SELECT * FROM production_issue_events WHERE production_order_id=? ORDER BY event_no', [doc.id]);
    const [issueLines] = await db.query(
      `SELECT pil.*, i.name AS item_name, i.unit AS item_unit FROM production_issue_lines pil
       LEFT JOIN inv_items i ON i.id=pil.item_id WHERE pil.production_order_id=? ORDER BY pil.id`, [doc.id]);
    const [outputs] = await db.query('SELECT * FROM production_output WHERE production_order_id=? ORDER BY produced_at, id', [doc.id]);
    const eventIds = issueEvents.map((e) => e.id).concat(outputs.map((o) => o.id));
    let lotMovements = [];
    if (eventIds.length) {
      const [lm] = await db.query(
        `SELECT lm.*, wl.lot_number, wl.expiry_date FROM inventory_lot_movements lm
         LEFT JOIN inventory_lots wl ON wl.id=lm.lot_id
         WHERE lm.reference_type IN ('prod_issue','prod_output','prod_issue_reverse','prod_output_reverse')
           AND lm.reference_id IN (?) ORDER BY lm.id`, [eventIds]);
      lotMovements = lm;
    }
    const [genealogy] = await db.query(
      `SELECT pol.*, wl1.lot_number AS output_lot_number, wl2.lot_number AS component_lot_number
       FROM production_output_lots pol
       LEFT JOIN inventory_lots wl1 ON wl1.id=pol.output_lot_id
       LEFT JOIN inventory_lots wl2 ON wl2.id=pol.component_lot_id
       WHERE pol.work_order_id=? ORDER BY pol.created_at`, [doc.id]);
    const [events] = await db.query("SELECT * FROM inv_tx_events WHERE doc_type='production' AND doc_id=? ORDER BY created_at ASC, id ASC", [doc.id]);
    const [movements] = await db.query(
      `SELECT * FROM inventory_movements WHERE (reference_type IN ('prod_issue','prod_output','prod_issue_reverse','prod_output_reverse') AND reference_id IN (?))
       OR (reference_type IN ('production','production_reverse') AND reference_id=?) ORDER BY movement_date ASC, seq ASC`,
      [eventIds.length ? eventIds : ['—'], doc.id]);
    let reverseIds = [];
    try { reverseIds = JSON.parse(doc.reverse_gl_ids || '[]') || []; } catch (_) { reverseIds = []; }
    const journalIds = issueEvents.map((e) => e.gl_journal_id)
      .concat(outputs.map((o) => o.gl_journal_id))
      .concat([doc.gl_release_id, doc.gl_complete_id, doc.gl_close_id])
      .concat(reverseIds)
      .filter(Boolean);
    let journals = [];
    if (journalIds.length) {
      const [jr] = await db.query('SELECT j.id, j.journal_number, j.journal_date, j.total_debit, j.total_credit, j.reference_type FROM gl_journals j WHERE j.id IN (?)', [journalIds]);
      if (jr.length) {
        const [entries] = await db.query('SELECT journal_id, account_code, account_name, debit, credit FROM gl_entries WHERE journal_id IN (?) ORDER BY journal_id, id', [journalIds]);
        journals = jr.map((j) => Object.assign({}, j, { entries: entries.filter((e) => e.journal_id === j.id) }));
      }
    }
    res.json({
      data: doc,
      plan: plan.map((r) => Object.assign(r, { remaining: P.round4(Number(r.qty_planned) - Number(r.qty_actual)) })),
      issueEvents: issueEvents.map((ev) => Object.assign(ev, { lines: issueLines.filter((l) => l.issue_event_id === ev.id) })),
      outputs, lotMovements, genealogy, timeline: events, movements, journals,
    });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE draft
// ════════════════════════════════════════════════════════════════════════════
router.post('/', BACKOFFICE, async (req, res) => {
  let idemId = null;
  try {
    const actor = _actor(req);
    const b = req.body || {};
    const warehouseId = b.warehouseId || b.warehouse_id;
    const outputWarehouseId = (b.outputWarehouseId || b.output_warehouse_id || warehouseId);
    const qtyPlanned = Number(b.qtyPlanned != null ? b.qtyPlanned : b.qty_planned);
    if (!b.bomId) return _fail(res, 'VALIDATION_ERROR', 'الوصفة (bomId) مطلوبة');
    if (!warehouseId) return _fail(res, 'VALIDATION_ERROR', 'مستودع المواد مطلوب');
    if (!(qtyPlanned > 0)) return _fail(res, 'VALIDATION_ERROR', 'الكمية المخططة يجب أن تكون موجبة');
    if (req.guardWh && !req.guardWh(res, warehouseId)) return;
    if (req.guardWh && !req.guardWh(res, outputWarehouseId)) return;
    const srcWh = await _loadWarehouse(warehouseId);
    if (!srcWh) return _fail(res, 'VALIDATION_ERROR', 'مستودع المواد غير موجود');
    const outWh = outputWarehouseId === warehouseId ? srcWh : await _loadWarehouse(outputWarehouseId);
    if (!outWh) return _fail(res, 'VALIDATION_ERROR', 'مستودع الإخراج غير موجود');

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'prod:create', '', key, actor, b);
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب مكرر بمحتوى مختلف أو قيد التنفيذ');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const expanded = await _expandBom(db, b.bomId, qtyPlanned, warehouseId);
    const scrapPct = (b.allowedScrapPct != null && Number.isFinite(Number(b.allowedScrapPct))) ? Number(b.allowedScrapPct) : 0;
    const priority = (typeof b.priority === 'string' && b.priority) ? b.priority.slice(0, 20) : 'normal';
    const batchNo = (typeof b.batchNumber === 'string' && b.batchNumber.trim()) ? b.batchNumber.trim().slice(0, 80) : null;

    const out = await db.withTransaction(async (conn) => {
      const number = await _nextNumber(conn);
      const id = 'POV2-' + crypto.randomBytes(6).toString('hex');
      await conn.query(
        `INSERT INTO production_orders
         (id, order_number, bom_id, product_id, warehouse_id, output_warehouse_id, brand_id, branch_id,
          qty_planned, status, source, version, notes, created_by, planned_date, priority, allowed_scrap_pct, batch_number)
         VALUES (?,?,?,?,?,?,?,?,?,'draft','v2',1,?,?,?,?,?,?)`,
        [id, number, b.bomId, expanded.bom.product_id, warehouseId, outputWarehouseId,
         srcWh.brand_id || null, srcWh.branch_id || null, qtyPlanned,
         (b.notes || '').toString().slice(0, 2000) || null, actor,
         b.plannedDate || _today(), priority, scrapPct, batchNo]);
      await _insertConsumption(conn, id, warehouseId, expanded);
      const auditEvent = await _audit(conn, id, 'create', null, 'draft', actor, 'إنشاء مسودة أمر إنتاج', { lineCount: expanded.lines.length, qtyPlanned });
      return { id, number, auditEvent };
    });

    const body = _envelope({ data: { id: out.id }, documentNumber: out.number, status: 'draft', version: 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id: out.id, number: out.number });
    if (idemId) await IDEM.complete(db, idemId, 201, body);
    return res.status(201).json(body);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH draft (re-expands the plan; version-guarded)
// ════════════════════════════════════════════════════════════════════════════
router.patch('/:id', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    if (expected == null) return _fail(res, 'VALIDATION_ERROR', 'expectedVersion مطلوب للتعديل');
    const doc = await _loadOrder(id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(doc);
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    P.assertCanEdit(doc.status);
    const b = req.body || {};
    const bomId = b.bomId || doc.bom_id;
    const qtyPlanned = Number(b.qtyPlanned != null ? b.qtyPlanned : doc.qty_planned);
    const warehouseId = b.warehouseId || doc.warehouse_id;
    const outputWarehouseId = b.outputWarehouseId || doc.output_warehouse_id || warehouseId;
    if (!(qtyPlanned > 0)) return _fail(res, 'VALIDATION_ERROR', 'الكمية المخططة يجب أن تكون موجبة');
    if (req.guardWh && !req.guardWh(res, warehouseId)) return;
    if (req.guardWh && !req.guardWh(res, outputWarehouseId)) return;
    if (!(await _loadWarehouse(warehouseId))) return _fail(res, 'VALIDATION_ERROR', 'مستودع المواد غير موجود');
    if (!(await _loadWarehouse(outputWarehouseId))) return _fail(res, 'VALIDATION_ERROR', 'مستودع الإخراج غير موجود');
    const expanded = await _expandBom(db, bomId, qtyPlanned, warehouseId);
    const scrapPct = (b.allowedScrapPct != null && Number.isFinite(Number(b.allowedScrapPct))) ? Number(b.allowedScrapPct) : Number(doc.allowed_scrap_pct) || 0;

    const out = await db.withTransaction(async (conn) => {
      const [r] = await conn.query(
        `UPDATE production_orders SET bom_id=?, product_id=?, qty_planned=?, warehouse_id=?, output_warehouse_id=?,
           planned_date=?, priority=?, allowed_scrap_pct=?, batch_number=?, notes=?, version=version+1
         WHERE id=? AND status='draft' AND source='v2' AND version=?`,
        [bomId, expanded.bom.product_id, qtyPlanned, warehouseId, outputWarehouseId,
         b.plannedDate || doc.planned_date || _today(),
         (typeof b.priority === 'string' && b.priority) ? b.priority.slice(0, 20) : doc.priority,
         scrapPct,
         (b.batchNumber != null ? String(b.batchNumber).trim().slice(0, 80) || null : doc.batch_number),
         (b.notes != null ? String(b.notes).slice(0, 2000) : doc.notes),
         id, expected]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت المسودة منذ آخر تحميل — أعد التحميل');
      await conn.query('DELETE FROM production_consumption WHERE production_order_id=?', [id]);
      await _insertConsumption(conn, id, warehouseId, expanded);
      const auditEvent = await _audit(conn, id, 'edit', 'draft', 'draft', actor, 'تعديل مسودة', { lineCount: expanded.lines.length, qtyPlanned });
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: doc.order_number, status: 'draft', version: expected + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id, number: doc.order_number });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// APPROVE — Maker–Checker (creator may not approve their own order)
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/approve', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    const doc = await _loadOrder(id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(doc);
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    P.assertCanApprove(doc.status);
    if (MAKER_CHECKER && !_isAdmin(req) && doc.created_by && doc.created_by === actor) {
      return _fail(res, 'PERMISSION_DENIED', 'لا يمكن لمُنشئ أمر الإنتاج اعتماده بنفسه (Maker–Checker)');
    }
    const out = await db.withTransaction(async (conn) => {
      const [r] = await conn.query(
        "UPDATE production_orders SET status='approved', approved_by=?, approved_at=NOW(), version=version+1 WHERE id=? AND status='draft' AND source='v2'" + (expected != null ? ' AND version=?' : ''),
        expected != null ? [actor, id, expected] : [actor, id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'approve', 'draft', 'approved', actor, req.body && req.body.note, null);
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: doc.order_number, status: 'approved', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// ISSUE MATERIALS — partial, repeatable; FEFO for tracked; Dr WIP / Cr inventory
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/issue-materials', BACKOFFICE, async (req, res) => {
  let idemId = null;
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    const b = req.body || {};
    const pre = await _loadOrder(id);
    if (!pre) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(pre);
    if (req.guardWh && !req.guardWh(res, pre.warehouse_id)) return;
    P.assertCanIssue(pre.status);
    if (!Array.isArray(b.lines) || !b.lines.length) return _fail(res, 'VALIDATION_ERROR', 'حدّد سطرًا واحدًا على الأقل للإصدار');
    const laborCost = Number(b.laborCost) || 0;
    const overheadCost = Number(b.overheadCost) || 0;
    if (laborCost < 0 || overheadCost < 0) return _fail(res, 'VALIDATION_ERROR', 'تكاليف العمالة/غير المباشرة لا تكون سالبة');

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'prod:issue', id, key, actor, b);
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب إصدار مكرر');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const NSP = require('../lib/negativeStockPolicy');
    const policyOn = NSP.POLICY_ENABLED();

    const out = await db.withTransaction(async (conn) => {
      const doc = await _loadOrder(id, conn); // FOR UPDATE
      if (!doc) throw _err('VALIDATION_ERROR', 'أمر الإنتاج غير موجود');
      P.assertV2(doc);
      P.assertCanIssue(doc.status);
      if (expected != null && Number(doc.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار الأمر — أعد التحميل');
      const srcWh = await _loadWarehouse(doc.warehouse_id, conn);

      const [planRows] = await conn.query('SELECT * FROM production_consumption WHERE production_order_id=? FOR UPDATE', [id]);
      const plan = new Map(planRows.map((r) => [r.item_id, r]));
      const seen = new Set();
      const tol = P.overIssueTolerance();
      for (const ln of b.lines) {
        const itemId = ln.itemId || ln.item_id;
        const qty = Number(ln.qty);
        if (!itemId || seen.has(itemId)) throw _err('VALIDATION_ERROR', 'صنف مكرر أو غير معرّف في السطور');
        seen.add(itemId);
        if (!(qty > 0)) throw _err('VALIDATION_ERROR', 'كمية الإصدار يجب أن تكون موجبة للصنف ' + itemId);
        const pl = plan.get(itemId);
        if (!pl) throw _err('VALIDATION_ERROR', 'الصنف ' + itemId + ' ليس ضمن خطة مواد هذا الأمر');
        const chk = P.checkOverIssue(pl.qty_planned, pl.qty_actual, qty, tol);
        if (!chk.ok) {
          const allow = b.allowOverIssue === true && _isMgr(req) && String(b.reason || '').trim();
          if (!allow) {
            const e = _err('OVER_ISSUE', 'الإصدار التراكمي للصنف ' + itemId + ' يتجاوز المخطط + السماحية (' + chk.cap + ') — يتطلب تجاوز مدير مع سبب');
            e.detail = { itemId, cap: chk.cap, after: chk.after };
            throw e;
          }
        }
      }
      // Pre-check stock when the negative policy is OFF (legacy behavior);
      // when ON the per-line engine guard decides (tracked always blocks).
      if (!policyOn) {
        for (const ln of b.lines) {
          const qty = Number(ln.qty);
          const cur = await E.readStock(conn, doc.warehouse_id, ln.itemId || ln.item_id, true);
          if (cur.qty < qty) throw _err('INSUFFICIENT_STOCK', 'الرصيد المتاح (' + cur.qty + ') لا يكفي لإصدار ' + qty + ' من الصنف ' + (ln.itemId || ln.item_id));
        }
      }

      const eventNo = (await _issueEventCount(id, conn)) + 1;
      const eventId = 'PIE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const now = new Date();
      const affectedStock = [];
      const movementIds = [];
      let materialsCost = 0;
      for (const ln of b.lines) {
        const itemId = ln.itemId || ln.item_id;
        const qty = Number(ln.qty);
        const mode = await L.getTrackingMode(conn, itemId);
        const cost = await E.getEffectiveCost(conn, itemId, doc.warehouse_id);
        const guardOpts = policyOn ? { negativeGuard: {
          strict: true,
          user: { role: _role(req), username: actor, isDeveloper: !!(req.user && req.user.isDeveloper) },
          reason: b.reason || 'إصدار مواد إنتاج',
          acknowledgeNegative: !!(b.acknowledgeNegative === true),
          makerChecker: MAKER_CHECKER ? { creator: doc.created_by, poster: actor } : null,
          docType: 'prod_issue', docId: eventId,
        } } : undefined;
        const mv = await E.applyStockMovement(conn, doc.warehouse_id, itemId, -qty, cost, 'prod_issue', eventId, actor, guardOpts);
        let itemName = '';
        try { const [im] = await conn.query('SELECT name FROM inv_items WHERE id=? LIMIT 1', [itemId]); itemName = im.length ? im[0].name : ''; } catch (_) {}
        const mid = await E.recordMovement(conn, { warehouseId: doc.warehouse_id, itemId, itemName, type: 'out', qty, reason: 'إنتاج', username: actor, notes: 'PRODUCTION: ' + doc.order_number + ' · حدث ' + eventNo, referenceType: 'prod_issue', referenceId: eventId });
        movementIds.push(mid);
        affectedStock.push({ warehouseId: doc.warehouse_id, itemId, delta: -qty, newQty: mv.newQty });
        if (L.isTracked(mode)) {
          const seq = await _seqOf(conn, mid);
          const manual = Array.isArray(ln.lotAllocations) && ln.lotAllocations.length
            ? ln.lotAllocations.map((a) => ({ lotId: String(a.lotId || a.lot_id || ''), qty: Number(a.qty) }))
            : null;
          if (manual) {
            const sum = manual.reduce((s, a) => s + a.qty, 0);
            if (P.round2(sum) !== P.round2(qty)) throw _err('VALIDATION_ERROR', 'مجموع التخصيص اليدوي لا يساوي كمية الإصدار للصنف ' + itemId);
          }
          const alloc = await L.allocateOutbound(conn, { warehouseId: doc.warehouse_id, itemId, qty, trackingMode: mode, movementSeq: seq, movementId: mid, referenceType: 'prod_issue', referenceId: eventId, reason: 'استهلاك إنتاج', actor, occurredAt: now, manualAllocations: manual });
          for (const a of alloc.allocations) {
            await conn.query('INSERT INTO work_order_lot_consumption (id, work_order_id, component_item_id, lot_id, warehouse_id, qty) VALUES (?,?,?,?,?,?)',
              ['WOLC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), id, itemId, a.lotId, doc.warehouse_id, a.qty]);
          }
          await L.assertInvariant(conn, doc.warehouse_id, itemId);
        }
        const lineTotal = P.round2(qty * cost);
        materialsCost += lineTotal;
        await conn.query(
          'INSERT INTO production_issue_lines (id, issue_event_id, production_order_id, item_id, warehouse_id, qty, unit_cost, line_total) VALUES (?,?,?,?,?,?,?,?)',
          ['PIL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), eventId, id, itemId, doc.warehouse_id, qty, P.round4(cost), lineTotal]);
        const pl = plan.get(itemId);
        await conn.query(
          'UPDATE production_consumption SET qty_actual=qty_actual+?, total_cost=total_cost+?, unit_cost=?, consumed_at=NOW() WHERE id=?',
          [qty, lineTotal, P.round4(cost), pl.id]);
        try { await recomputeInvItemStock(conn, itemId); } catch (_) {}
      }
      materialsCost = P.round2(materialsCost);
      const eventTotal = P.round2(materialsCost + laborCost + overheadCost);

      let journalId = null;
      if (eventTotal > 0.005) {
        const spec = P.glProdIssue({
          materialsCost, laborCost, overheadCost,
          inventoryCode: E.inventoryAccountFor(srcWh),
          warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id,
          journalDate: _today(), postedBy: actor, referenceId: eventId,
          description: 'إصدار مواد إنتاج ' + doc.order_number + ' — حدث ' + eventNo,
        });
        const j = await gl.postJournal(conn, spec);
        if (!j || !j.success) throw _err('GL_POSTING_FAILED', (j && j.error) || 'فشل ترحيل قيد إصدار المواد');
        journalId = j.journalId;
      }
      await conn.query(
        'INSERT INTO production_issue_events (id, production_order_id, event_no, materials_cost, labor_cost, overhead_cost, gl_journal_id, issued_by, issued_at, notes) VALUES (?,?,?,?,?,?,?,?,NOW(),?)',
        [eventId, id, eventNo, materialsCost, laborCost, overheadCost, journalId, actor, (b.notes || '').toString().slice(0, 500) || null]);

      const [u] = await conn.query(
        `UPDATE production_orders SET status='in_progress',
           materials_cost=materials_cost+?, labor_cost=labor_cost+?, overhead_cost=overhead_cost+?,
           total_cost=total_cost+?, wip_balance=wip_balance+?, version=version+1
         WHERE id=? AND status IN ('approved','in_progress') AND source='v2' AND version=?`,
        [materialsCost, laborCost, overheadCost, eventTotal, eventTotal, id, doc.version]);
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر أثناء الإصدار');
      const auditEvent = await _audit(conn, id, 'issue_materials', doc.status, 'in_progress', actor, b.reason || '', { eventId, eventNo, materialsCost, laborCost, overheadCost, lineCount: b.lines.length, journalId });
      return { affectedStock, movementIds, journalId, eventId, eventNo, eventTotal, version: Number(doc.version) + 1, auditEvent };
    });

    const body = _envelope({ data: { id, eventId: out.eventId, eventNo: out.eventNo }, documentNumber: pre.order_number, status: 'in_progress', version: out.version, affectedStock: out.affectedStock, affectedValue: out.eventTotal, movementIds: out.movementIds, journalId: out.journalId, auditEvent: out.auditEvent }, { id });
    if (idemId) await IDEM.complete(db, idemId, 200, body);
    return res.status(200).json(body);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// RECORD OUTPUT — partial, repeatable; good + waste; lot/expiry for tracked FG
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/record-output', BACKOFFICE, async (req, res) => {
  let idemId = null;
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    const b = req.body || {};
    const goodQty = Number(b.goodQty != null ? b.goodQty : b.qtyProduced) || 0;
    const wasteQty = Number(b.wasteQty != null ? b.wasteQty : b.qtyScrap) || 0;
    if (goodQty < 0 || wasteQty < 0) return _fail(res, 'VALIDATION_ERROR', 'الكميات لا تكون سالبة');
    if (goodQty + wasteQty <= 0) return _fail(res, 'VALIDATION_ERROR', 'حدّد كمية جيدة أو هدرًا (على الأقل واحدة موجبة)');
    if (wasteQty > 0 && !String(b.wasteReason || '').trim()) return _fail(res, 'REASON_REQUIRED', 'سبب الهدر إلزامي عند تسجيل هدر');
    const pre = await _loadOrder(id);
    if (!pre) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(pre);
    const outputWh = pre.output_warehouse_id || pre.warehouse_id;
    if (req.guardWh && !req.guardWh(res, outputWh)) return;
    P.assertCanOutput(pre.status);

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'prod:output', id, key, actor, b);
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب تسجيل مكرر');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const out = await db.withTransaction(async (conn) => {
      const doc = await _loadOrder(id, conn); // FOR UPDATE
      if (!doc) throw _err('VALIDATION_ERROR', 'أمر الإنتاج غير موجود');
      P.assertV2(doc);
      P.assertCanOutput(doc.status);
      if (expected != null && Number(doc.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار الأمر — أعد التحميل');
      const wip = Number(doc.wip_balance) || 0;
      if (wip <= 0.005) throw _err('VALIDATION_ERROR', 'لا يوجد رصيد WIP — أصدر موادًا قبل تسجيل الإنتاج');
      const chk = P.checkOverProduction(doc.qty_planned, doc.qty_produced, doc.qty_waste, goodQty, wasteQty);
      if (!chk.ok) {
        const e = _err('OVER_PRODUCTION', 'الإنتاج التراكمي يتجاوز المخطط + السماحية (' + chk.cap + ')');
        e.detail = { cap: chk.cap, after: chk.after };
        throw e;
      }
      if (P.wasteAllowanceExceeded(doc.qty_planned, doc.qty_waste, wasteQty, doc.allowed_scrap_pct) && !_isMgr(req)) {
        throw _err('WASTE_ALLOWANCE_EXCEEDED', 'الهدر التراكمي يتجاوز السماحية المحددة (' + doc.allowed_scrap_pct + '%) — يتطلب مديرًا');
      }
      const priced = P.priceOutputEvent({ wipBalance: wip, plannedQty: doc.qty_planned, producedSoFar: doc.qty_produced, wasteSoFar: doc.qty_waste, goodQty, wasteQty });
      const outWhRow = await _loadWarehouse(outputWh, conn);
      const fgMode = await L.getTrackingMode(conn, doc.product_id);
      const batchNumber = String(b.batchNumber || doc.batch_number || '').trim() || null;
      const expiryDate = b.expiryDate || null;
      if (L.isTracked(fgMode) && goodQty > 0) {
        if (!batchNumber) throw _err('LOT_REQUIRED', 'رقم الدفعة إلزامي — المنتج النهائي يخضع لتتبع الدفعات');
        if (fgMode === 'expiry' && !expiryDate) throw _err('VALIDATION_ERROR', 'تاريخ الصلاحية إلزامي للمنتج النهائي');
      }
      const now = new Date();
      const eventId = 'POE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const affectedStock = [];
      const movementIds = [];
      if (goodQty > 0) {
        const mv = await E.applyStockMovement(conn, outputWh, doc.product_id, goodQty, priced.fgUnitCost, 'prod_output', eventId, actor);
        const prodName = await _productName(conn, doc.product_id);
        const mid = await E.recordMovement(conn, { warehouseId: outputWh, itemId: doc.product_id, itemName: prodName, type: 'in', qty: goodQty, reason: 'إنتاج', username: actor, notes: 'PRODUCTION: ' + doc.order_number, referenceType: 'prod_output', referenceId: eventId });
        movementIds.push(mid);
        affectedStock.push({ warehouseId: outputWh, itemId: doc.product_id, delta: goodQty, newQty: mv.newQty });
        if (L.isTracked(fgMode)) {
          const seq = await _seqOf(conn, mid);
          const rcv = await L.receiveInbound(conn, { warehouseId: outputWh, itemId: doc.product_id, qty: goodQty, lot: { lotNumber: batchNumber, expiryDate, unitCost: priced.fgUnitCost, sourceType: 'production', sourceId: doc.id }, trackingMode: fgMode, movementSeq: seq, movementId: mid, referenceType: 'prod_output', referenceId: eventId, reason: 'إنتاج', actor, occurredAt: now });
          const [comp] = await conn.query('SELECT lot_id, qty FROM work_order_lot_consumption WHERE work_order_id=?', [id]);
          for (const cl of comp) {
            await conn.query('INSERT INTO production_output_lots (id, work_order_id, output_lot_id, component_lot_id, qty) VALUES (?,?,?,?,?)',
              ['POL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), id, rcv.lotId, cl.lot_id, cl.qty]);
          }
          await L.assertInvariant(conn, outputWh, doc.product_id);
        }
        try { await recomputeInvItemStock(conn, doc.product_id); } catch (_) {}
      }
      let journalId = null;
      if (priced.relief > 0.005) {
        const spec = P.glProdOutput({
          fgValue: priced.fgValue, wasteValue: priced.wasteValue,
          outputWarehouseId: outputWh, warehouseId: doc.warehouse_id,
          brandId: doc.brand_id, branchId: doc.branch_id,
          journalDate: _today(), postedBy: actor, referenceId: eventId,
          description: 'إنتاج ' + doc.order_number + ' — جيد ' + goodQty + (wasteQty > 0 ? ' / هدر ' + wasteQty : ''),
        });
        const j = await gl.postJournal(conn, spec);
        if (!j || !j.success) throw _err('GL_POSTING_FAILED', (j && j.error) || 'فشل ترحيل قيد الإنتاج');
        journalId = j.journalId;
      }
      await conn.query(
        `INSERT INTO production_output (id, production_order_id, item_id, warehouse_id, qty, unit_cost, total_cost, qty_waste, waste_cost, batch_number, expiry_date, produced_at, gl_journal_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?)`,
        [eventId, id, doc.product_id, outputWh, goodQty, priced.fgUnitCost, priced.fgValue, wasteQty, priced.wasteValue, batchNumber, expiryDate, journalId, actor]);
      // Cumulative FG unit cost = Σ good value / Σ good qty (never restated retroactively).
      const [sums] = await conn.query('SELECT COALESCE(SUM(qty),0) AS q, COALESCE(SUM(total_cost),0) AS v FROM production_output WHERE production_order_id=?', [id]);
      const totQ = Number(sums[0].q) || 0;
      const totV = Number(sums[0].v) || 0;
      const cumUnit = totQ > 0 ? P.round4(totV / totQ) : 0;
      const [u] = await conn.query(
        `UPDATE production_orders SET qty_produced=qty_produced+?, qty_waste=qty_waste+?, qty_scrap=qty_scrap+?,
           wip_balance=wip_balance-?, unit_cost=?, version=version+1
         WHERE id=? AND status='in_progress' AND source='v2' AND version=?`,
        [goodQty, wasteQty, wasteQty, priced.relief, cumUnit, id, doc.version]);
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر أثناء التسجيل');
      const auditEvent = await _audit(conn, id, 'record_output', 'in_progress', 'in_progress', actor, b.wasteReason || b.notes || '', { eventId, goodQty, wasteQty, fgValue: priced.fgValue, wasteValue: priced.wasteValue, unitCost: priced.fgUnitCost, journalId });
      return { affectedStock, movementIds, journalId, eventId, priced, version: Number(doc.version) + 1, auditEvent };
    });

    const body = _envelope({ data: { id, eventId: out.eventId, unitCost: out.priced.fgUnitCost, fgValue: out.priced.fgValue, wasteValue: out.priced.wasteValue }, documentNumber: pre.order_number, status: 'in_progress', version: out.version, affectedStock: out.affectedStock, affectedValue: out.priced.relief, movementIds: out.movementIds, journalId: out.journalId, auditEvent: out.auditEvent }, { id });
    if (idemId) await IDEM.complete(db, idemId, 200, body);
    return res.status(200).json(body);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// COMPLETE — no stock/GL; requires ≥1 output; short-close needs a reason
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/complete', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    const doc = await _loadOrder(id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(doc);
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    P.assertCanComplete(doc.status);
    const [oc] = await db.query('SELECT COUNT(*) AS c FROM production_output WHERE production_order_id=?', [id]);
    if (!Number(oc[0].c)) return _fail(res, 'NO_OUTPUT_RECORDED', 'لا يمكن إكمال أمر بلا أي حدث إنتاج مسجَّل');
    const produced = Number(doc.qty_produced) || 0;
    const planned = Number(doc.qty_planned) || 0;
    if (produced + Number(doc.qty_waste) < planned - 1e-9 && !String((req.body && req.body.reason) || '').trim()) {
      return _fail(res, 'REASON_REQUIRED', 'الإكمال بأقل من المخطط (إغلاق مبكر) يتطلب سببًا');
    }
    const yieldPct = planned > 0 ? Math.round((produced / planned) * 10000) / 100 : null;
    const out = await db.withTransaction(async (conn) => {
      const [r] = await conn.query(
        "UPDATE production_orders SET status='completed', completed_by=?, completed_at=NOW(), yield_pct=?, version=version+1 WHERE id=? AND status='in_progress' AND source='v2'" + (expected != null ? ' AND version=?' : ''),
        expected != null ? [actor, yieldPct, id, expected] : [actor, yieldPct, id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'complete', 'in_progress', 'completed', actor, (req.body && req.body.reason) || '', { yieldPct, produced, planned });
      return { auditEvent };
    });
    return _ok(res, { data: { id, yieldPct }, documentNumber: doc.order_number, status: 'completed', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CLOSE — flush WIP residual to PRODUCTION_VARIANCE 5420, lock the order
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/close', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    const pre = await _loadOrder(id);
    if (!pre) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(pre);
    if (req.guardWh && !req.guardWh(res, pre.warehouse_id)) return;
    P.assertCanClose(pre.status);
    const out = await db.withTransaction(async (conn) => {
      const doc = await _loadOrder(id, conn); // FOR UPDATE
      if (!doc || doc.status !== 'completed') throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر — أعد التحميل');
      if (expected != null && Number(doc.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار الأمر — أعد التحميل');
      const residual = P.round2(doc.wip_balance);
      let journalId = null;
      if (residual > 0.005) {
        const spec = P.glProdClose({
          variance: residual, warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id,
          journalDate: _today(), postedBy: actor, referenceId: id,
          description: 'إغلاق أمر إنتاج ' + doc.order_number + ' — فروقات ' + residual,
        });
        const j = await gl.postJournal(conn, spec);
        if (!j || !j.success) throw _err('GL_POSTING_FAILED', (j && j.error) || 'فشل ترحيل قيد الإغلاق');
        journalId = j.journalId;
      }
      const [u] = await conn.query(
        "UPDATE production_orders SET status='closed', closed_by=?, closed_at=NOW(), close_variance=?, gl_close_id=?, wip_balance=0, version=version+1 WHERE id=? AND status='completed' AND source='v2' AND version=?",
        [actor, residual, journalId, id, doc.version]);
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر أثناء الإغلاق');
      const auditEvent = await _audit(conn, id, 'close', 'completed', 'closed', actor, req.body && req.body.note, { variance: residual, journalId });
      return { journalId, residual, version: Number(doc.version) + 1, auditEvent };
    });
    return _ok(res, { data: { id, closeVariance: out.residual }, documentNumber: pre.order_number, status: 'closed', version: out.version, affectedStock: [], affectedValue: out.residual, journalId: out.journalId, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CANCEL — draft|approved only, and NEVER after a materials issue
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/cancel', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    const reason = String((req.body && (req.body.reason || req.body.note)) || '').trim();
    if (!reason) return _fail(res, 'VALIDATION_ERROR', 'سبب الإلغاء إلزامي');
    const doc = await _loadOrder(id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(doc);
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    const hasIssues = (await _issueEventCount(id)) > 0;
    P.assertCanCancel(doc.status, hasIssues);
    const out = await db.withTransaction(async (conn) => {
      const [r] = await conn.query(
        "UPDATE production_orders SET status='cancelled', cancelled_by=?, cancelled_at=NOW(), cancel_reason=?, version=version+1 WHERE id=? AND status IN ('draft','approved') AND source='v2'" + (expected != null ? ' AND version=?' : ''),
        expected != null ? [actor, reason.slice(0, 500), id, expected] : [actor, reason.slice(0, 500), id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'cancel', doc.status, 'cancelled', actor, reason, null);
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: doc.order_number, status: 'cancelled', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// REVERSE — undo ALL events: exact lots back, compensating stock, reversing GL
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/reverse', MGR, async (req, res) => {
  let idemId = null;
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const expected = _expectedVersion(req);
    const reason = String((req.body && (req.body.reason || req.body.note)) || '').trim();
    if (!reason) return _fail(res, 'VALIDATION_ERROR', 'سبب العكس إلزامي');
    const pre = await _loadOrder(id);
    if (!pre) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(pre);
    if (req.guardWh && !req.guardWh(res, pre.warehouse_id)) return;
    P.assertCanReverse(pre.status);

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'prod:reverse', id, key, actor, req.body || {});
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب عكس مكرر');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const out = await db.withTransaction(async (conn) => {
      const doc = await _loadOrder(id, conn); // FOR UPDATE
      if (!doc) throw _err('VALIDATION_ERROR', 'أمر الإنتاج غير موجود');
      P.assertV2(doc);
      P.assertCanReverse(doc.status);
      if (expected != null && Number(doc.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار الأمر — أعد التحميل');
      const fromStatus = doc.status;
      const outputWh = doc.output_warehouse_id || doc.warehouse_id;
      const srcWh = await _loadWarehouse(doc.warehouse_id, conn);
      const now = new Date();
      const affectedStock = [];
      const movementIds = [];
      const reverseJournalIds = [];
      const fgMode = await L.getTrackingMode(conn, doc.product_id);
      const prodName = await _productName(conn, doc.product_id);

      // 1) Undo OUTPUT events (newest first): FG stock must still be there.
      const [outputs] = await conn.query('SELECT * FROM production_output WHERE production_order_id=? ORDER BY produced_at DESC, id DESC', [id]);
      for (const ev of outputs) {
        const qty = Number(ev.qty) || 0;
        if (qty > 0) {
          const cur = await E.readStock(conn, outputWh, doc.product_id, true); // FOR UPDATE
          if (P.round4(cur.qty - qty) < -1e-9) throw _err('INSUFFICIENT_STOCK', 'لا يمكن عكس الأمر: المنتج النهائي استُهلك بعد الإنتاج (المتاح ' + cur.qty + ' < ' + qty + ')');
          const frozen = Number(ev.unit_cost) || 0;
          const mv = await E.applyStockMovement(conn, outputWh, doc.product_id, -qty, frozen, 'prod_output_reverse', ev.id, actor);
          const mid = await E.recordMovement(conn, { warehouseId: outputWh, itemId: doc.product_id, itemName: prodName, type: 'out', qty, reason: 'عكس إنتاج', username: actor, notes: 'REVERSE: ' + doc.order_number, referenceType: 'prod_output_reverse', referenceId: ev.id });
          movementIds.push(mid);
          affectedStock.push({ warehouseId: outputWh, itemId: doc.product_id, delta: -qty, newQty: mv.newQty });
          if (L.isTracked(fgMode)) {
            await L.reverseAllocation(conn, { referenceType: 'prod_output', referenceId: ev.id, movementSeq: null, movementId: null, actor, occurredAt: now });
            await L.assertInvariant(conn, outputWh, doc.product_id);
          }
        }
        // Reversing journal for this output event (from frozen values).
        if (ev.gl_journal_id) {
          const fwd = P.glProdOutput({
            fgValue: Number(ev.total_cost) || 0, wasteValue: Number(ev.waste_cost) || 0,
            outputWarehouseId: outputWh, warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id,
            journalDate: _today(), postedBy: actor, referenceId: ev.id, description: 'إنتاج ' + doc.order_number,
          });
          const rev = E.reverseSpec(fwd, { postedBy: actor, journalDate: _today(), description: 'عكس إنتاج ' + doc.order_number });
          const j = await gl.postJournal(conn, rev);
          if (!j || !j.success) throw _err('GL_POSTING_FAILED', (j && j.error) || 'فشل قيد عكس الإنتاج');
          reverseJournalIds.push(j.journalId);
        }
      }
      try { await recomputeInvItemStock(conn, doc.product_id); } catch (_) {}

      // 2) Undo ISSUE events: restore each line at its frozen cost + exact lots.
      const [issueEvents] = await conn.query('SELECT * FROM production_issue_events WHERE production_order_id=? ORDER BY event_no DESC', [id]);
      const trackedPairs = new Set();
      for (const ev of issueEvents) {
        const [lines] = await conn.query('SELECT * FROM production_issue_lines WHERE issue_event_id=?', [ev.id]);
        for (const ln of lines) {
          const qty = Number(ln.qty) || 0;
          const frozen = Number(ln.unit_cost) || 0;
          const mv = await E.applyStockMovement(conn, ln.warehouse_id, ln.item_id, qty, frozen, 'prod_issue_reverse', ev.id, actor);
          let itemName = '';
          try { const [im] = await conn.query('SELECT name FROM inv_items WHERE id=? LIMIT 1', [ln.item_id]); itemName = im.length ? im[0].name : ''; } catch (_) {}
          const mid = await E.recordMovement(conn, { warehouseId: ln.warehouse_id, itemId: ln.item_id, itemName, type: 'in', qty, reason: 'إرجاع إنتاج', username: actor, notes: 'REVERSE: ' + doc.order_number, referenceType: 'prod_issue_reverse', referenceId: ev.id });
          movementIds.push(mid);
          affectedStock.push({ warehouseId: ln.warehouse_id, itemId: ln.item_id, delta: qty, newQty: mv.newQty });
          if (L.isTracked(await L.getTrackingMode(conn, ln.item_id))) trackedPairs.add(ln.warehouse_id + '|' + ln.item_id);
          try { await recomputeInvItemStock(conn, ln.item_id); } catch (_) {}
        }
        if (lines.length) {
          await L.reverseAllocation(conn, { referenceType: 'prod_issue', referenceId: ev.id, movementSeq: null, movementId: null, actor, occurredAt: now });
        }
        if (ev.gl_journal_id) {
          const fwd = P.glProdIssue({
            materialsCost: Number(ev.materials_cost) || 0, laborCost: Number(ev.labor_cost) || 0, overheadCost: Number(ev.overhead_cost) || 0,
            inventoryCode: E.inventoryAccountFor(srcWh),
            warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id,
            journalDate: _today(), postedBy: actor, referenceId: ev.id, description: 'إصدار مواد ' + doc.order_number,
          });
          const rev = E.reverseSpec(fwd, { postedBy: actor, journalDate: _today(), description: 'عكس إصدار مواد ' + doc.order_number });
          const j = await gl.postJournal(conn, rev);
          if (!j || !j.success) throw _err('GL_POSTING_FAILED', (j && j.error) || 'فشل قيد عكس الإصدار');
          reverseJournalIds.push(j.journalId);
        }
      }
      for (const pair of trackedPairs) {
        const [wh, item] = pair.split('|');
        await L.assertInvariant(conn, wh, item);
      }

      // 3) Undo the CLOSE variance journal (closed orders only).
      if (doc.gl_close_id && Number(doc.close_variance) > 0.005) {
        const fwd = P.glProdClose({ variance: Number(doc.close_variance), warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id, journalDate: _today(), postedBy: actor, referenceId: id, description: 'إغلاق ' + doc.order_number });
        const rev = E.reverseSpec(fwd, { postedBy: actor, journalDate: _today(), description: 'عكس إغلاق ' + doc.order_number });
        const j = await gl.postJournal(conn, rev);
        if (!j || !j.success) throw _err('GL_POSTING_FAILED', (j && j.error) || 'فشل قيد عكس الإغلاق');
        reverseJournalIds.push(j.journalId);
      }

      // 4) Reset consumption aggregates (audit history stays in events/lines).
      await conn.query('UPDATE production_consumption SET qty_actual=0, total_cost=0, consumed_at=NULL WHERE production_order_id=?', [id]);
      const [u] = await conn.query(
        `UPDATE production_orders SET status='reversed', reversed_by=?, reversed_at=NOW(), reverse_reason=?, reverse_gl_ids=?, wip_balance=0, version=version+1
         WHERE id=? AND status IN ('in_progress','completed','closed') AND source='v2' AND version=?`,
        [actor, reason.slice(0, 500), JSON.stringify(reverseJournalIds), id, doc.version]);
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر أثناء العكس');
      const auditEvent = await _audit(conn, id, 'reverse', fromStatus, 'reversed', actor, reason, { journalIds: reverseJournalIds, movementCount: movementIds.length });
      return { affectedStock, movementIds, reverseJournalIds, version: Number(doc.version) + 1, auditEvent };
    });

    const body = _envelope({ data: { id, reverseJournalIds: out.reverseJournalIds }, documentNumber: pre.order_number, status: 'reversed', version: out.version, affectedStock: out.affectedStock, affectedValue: 0, movementIds: out.movementIds, journalId: out.reverseJournalIds[0] || null, auditEvent: out.auditEvent }, { id });
    if (idemId) await IDEM.complete(db, idemId, 200, body);
    return res.status(200).json(body);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE draft
// ════════════════════════════════════════════════════════════════════════════
router.delete('/:id', MGR, async (req, res) => {
  try {
    const actor = _actor(req);
    const id = req.params.id;
    const doc = await _loadOrder(id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    P.assertV2(doc);
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    P.assertCanDelete(doc.status);
    await db.withTransaction(async (conn) => {
      const [r] = await conn.query("DELETE FROM production_orders WHERE id=? AND status='draft' AND source='v2'", [id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الأمر — لا يمكن الحذف');
      await conn.query('DELETE FROM production_consumption WHERE production_order_id=?', [id]);
      await _audit(conn, id, 'delete', 'draft', null, actor, 'حذف مسودة', null);
    });
    return res.json({ success: true, code: null, data: { id }, status: 'deleted' });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// AVAILABILITY (existing order) — remaining plan vs live stock + FEFO
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id/availability', async (req, res) => {
  try {
    const doc = await _loadOrder(req.params.id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    const [rows] = await db.query(
      `SELECT pc.item_id, i.name AS item_name, i.unit AS item_unit, COALESCE(i.tracking_mode,'none') AS tracking_mode,
              pc.qty_planned, pc.qty_actual, pc.unit_cost, pc.warehouse_id, COALESCE(ws.qty,0) AS available
       FROM production_consumption pc
       LEFT JOIN inv_items i ON i.id=pc.item_id
       LEFT JOIN warehouse_stock ws ON ws.item_id=pc.item_id AND ws.warehouse_id=pc.warehouse_id
       WHERE pc.production_order_id=?`, [doc.id]);
    const items = [];
    for (const r of rows) {
      const remaining = P.round4(Number(r.qty_planned) - Number(r.qty_actual));
      const available = Number(r.available) || 0;
      let fefoQty = null;
      if (L.isTracked(r.tracking_mode) && remaining > 0) {
        const lots = await L.loadBalances(db, r.warehouse_id, r.item_id);
        const plan = L.planFefo(lots, remaining, {});
        fefoQty = P.round4(remaining - (plan.shortfall || 0));
      }
      const delta = P.round4(available - remaining);
      items.push({
        itemId: r.item_id, itemName: r.item_name || r.item_id, itemUnit: r.item_unit || '',
        trackingMode: r.tracking_mode,
        planned: Number(r.qty_planned), issued: Number(r.qty_actual), remaining,
        available, delta, unitCost: Number(r.unit_cost), fefoAvailable: fefoQty,
        status: remaining <= 0 ? 'done' : (delta >= 0 ? 'ok' : 'short'),
      });
    }
    items.sort((a, b) => a.delta - b.delta);
    const shortageCount = items.filter((x) => x.status === 'short').length;
    res.json({ items, summary: { shortageCount, allAvailable: shortageCount === 0, itemCount: items.length } });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// COST PREVIEW — WIP residual + projected next-event unit cost
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id/cost-preview', async (req, res) => {
  try {
    const doc = await _loadOrder(req.params.id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    const wip = Number(doc.wip_balance) || 0;
    const producedSoFar = (Number(doc.qty_produced) || 0) + (Number(doc.qty_waste) || 0);
    const remainingExpected = Math.max(P.round4(Number(doc.qty_planned) - producedSoFar), 0);
    const projectedUnitCost = remainingExpected > 0 ? P.round4(wip / remainingExpected) : null;
    const [lines] = await db.query(
      `SELECT pil.item_id, i.name AS item_name, SUM(pil.qty) AS issued_qty, SUM(pil.line_total) AS issued_value,
              MAX(pil.unit_cost) AS last_unit_cost
       FROM production_issue_lines pil LEFT JOIN inv_items i ON i.id=pil.item_id
       WHERE pil.production_order_id=? GROUP BY pil.item_id, i.name`, [doc.id]);
    res.json({
      data: {
        wipBalance: P.round2(wip),
        materialsCost: P.round2(doc.materials_cost), laborCost: P.round2(doc.labor_cost), overheadCost: P.round2(doc.overhead_cost),
        totalCost: P.round2(doc.total_cost),
        qtyProduced: Number(doc.qty_produced), qtyWaste: Number(doc.qty_waste),
        cumulativeUnitCost: Number(doc.unit_cost) || null,
        remainingExpected, projectedUnitCost,
        issuedLines: lines,
      },
    });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// VARIANCE REPORT — planned vs actual, yield, waste, residual variance
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id/variance-report', async (req, res) => {
  try {
    const doc = await _loadOrder(req.params.id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    const [components] = await db.query(
      `SELECT pc.item_id, i.name AS item_name, i.unit AS item_unit,
              pc.qty_planned, pc.qty_actual, pc.unit_cost, pc.total_cost
       FROM production_consumption pc LEFT JOIN inv_items i ON i.id=pc.item_id
       WHERE pc.production_order_id=? ORDER BY i.name`, [doc.id]);
    const [wsum] = await db.query('SELECT COALESCE(SUM(waste_cost),0) AS wv, COALESCE(SUM(total_cost),0) AS fgv FROM production_output WHERE production_order_id=?', [doc.id]);
    const rows = components.map((c) => {
      const qtyVar = P.round4(Number(c.qty_actual) - Number(c.qty_planned));
      const plannedValue = P.round2(Number(c.qty_planned) * Number(c.unit_cost));
      const actualValue = P.round2(Number(c.total_cost));
      return Object.assign(c, { qtyVariance: qtyVar, plannedValue, actualValue, valueVariance: P.round2(actualValue - plannedValue) });
    });
    res.json({
      data: {
        order: { id: doc.id, number: doc.order_number, status: doc.status },
        plannedQty: Number(doc.qty_planned), producedQty: Number(doc.qty_produced), wasteQty: Number(doc.qty_waste),
        yieldPct: doc.yield_pct != null ? Number(doc.yield_pct) : (Number(doc.qty_planned) > 0 ? P.round2((Number(doc.qty_produced) / Number(doc.qty_planned)) * 100) : null),
        components: rows,
        laborCost: P.round2(doc.labor_cost), overheadCost: P.round2(doc.overhead_cost),
        fgValue: P.round2(wsum[0].fgv), wasteValue: P.round2(wsum[0].wv),
        wipResidual: P.round2(doc.wip_balance), closeVariance: P.round2(doc.close_variance),
      },
    });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// PRINT payload — RTL print view data (header + plan + events + journals)
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id/print', async (req, res) => {
  try {
    const doc = await _loadOrder(req.params.id);
    if (!doc) { const e = new Error('أمر الإنتاج غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    doc.product_name = await _productName(db, doc.product_id);
    const [wh] = await db.query('SELECT id, name FROM warehouses WHERE id IN (?, ?)', [doc.warehouse_id, doc.output_warehouse_id || doc.warehouse_id]);
    const [plan] = await db.query(
      `SELECT pc.*, i.name AS item_name, i.unit AS item_unit FROM production_consumption pc
       LEFT JOIN inv_items i ON i.id=pc.item_id WHERE pc.production_order_id=? ORDER BY i.name`, [doc.id]);
    const [issueEvents] = await db.query('SELECT * FROM production_issue_events WHERE production_order_id=? ORDER BY event_no', [doc.id]);
    const [outputs] = await db.query('SELECT * FROM production_output WHERE production_order_id=? ORDER BY produced_at, id', [doc.id]);
    res.json({
      data: {
        header: doc,
        warehouseName: (wh.find((w) => w.id === doc.warehouse_id) || {}).name || '',
        outputWarehouseName: (wh.find((w) => w.id === (doc.output_warehouse_id || doc.warehouse_id)) || {}).name || '',
        plan, issueEvents, outputs,
        printedAt: new Date().toISOString(),
      },
    });
  } catch (e) { _catch(res, e); }
});

module.exports = router;
