/**
 * Lots / Expiry / FEFO / Traceability API — Phase 4B.
 *
 * Read + lifecycle surface over the lot ledger, under
 *   /api/inventory/v2/{lots,expiry,lot-allocation,lot-integrity}
 *
 *   GET    /lots                 list (filters + scope + pagination)
 *   POST   /lots                 create a lot manually (Idempotency-Key)
 *   GET    /lots/:id             detail (+ per-warehouse balances + expiry class)
 *   PATCH  /lots/:id             edit notes/expiry/manufacture — item/lotNumber/
 *                                expiry change BLOCKED after any movement
 *   GET    /lots/:id/movements   lot ledger rows
 *   GET    /lots/:id/trace       source → warehouses → movements → recall impact
 *   POST   /lots/:id/quarantine|/release|/recall   lifecycle (MGR + reason + version)
 *   GET    /expiry (+ /summary)  classified by Asia/Riyadh date-only buckets
 *   GET    /lot-allocation/suggest   FEFO preview for (warehouse,item,qty)
 *   GET    /lot-integrity (+ /export)  Σ(lot)=warehouse_stock drift, scoped
 *
 * Reuses the inventory-tx contract + idempotency + warehouse scope + audit
 * (inv_tx_events doc_type='lot') + csvExport (formula-guard) + expiryPolicy + lotLedger.
 */
'use strict';
const router = require('express').Router();
const db = require('../db/connection');
const C = require('../lib/inventoryTxContract');
const IDEM = require('../lib/idempotencyStore');
const CSV = require('../lib/csvExport');
const EXP = require('../lib/expiryPolicy');
const L = require('../lib/lotLedger');
const requireRole = require('../middleware/auth').requireRole;

const MGR = requireRole('admin', 'manager');
const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');

function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function _expectedVersion(req) { const raw = (req.body && req.body.expectedVersion != null) ? req.body.expectedVersion : (req.get && req.get('If-Match')); const n = parseInt(raw, 10); return Number.isFinite(n) ? n : null; }
function _fail(res, codeOrErr, message) { const code = C.isCanonical(codeOrErr) ? codeOrErr : C.mapError(codeOrErr); return res.status(C.httpFor(code)).json(C.errorBody(code, message || (codeOrErr && codeOrErr.message) || code)); }
function _catch(res, e) {
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found' });
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: (e && e.message) || 'error' });
  return _fail(res, e, e && e.message);
}
async function _audit(conn, lotId, action, fromStatus, toStatus, actor, note, payload) {
  try {
    await (conn || db).query('INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
      ['EV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), 'lot', lotId, action, fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500), payload ? JSON.stringify(payload).slice(0, 8000) : null]);
  } catch (_) { /* best effort */ }
  return { docType: 'lot', docId: lotId, action, actor: actor || '', at: new Date().toISOString() };
}
function _int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function _page(q) { let page = _int(q.page, 1); if (page < 1) page = 1; let ps = _int(q.pageSize, 25); if (ps < 1) ps = 1; if (ps > 200) ps = 200; return { page, pageSize: ps, offset: (page - 1) * ps }; }
const RISK = ['expired', 'critical', 'warning', 'safe', 'none'];
const STATUSES = ['active', 'quarantined', 'recalled', 'closed'];
const REPORT_SNAPSHOT_LIMIT = 5000;
function _snapshotTooLarge(res, total) {
  return res.status(413).json({
    code: 'REPORT_TOO_LARGE',
    error: 'تجاوز التقرير الحد الأقصى (' + REPORT_SNAPSHOT_LIMIT + ' صف). ضيّق الفلاتر ثم أعد المحاولة.',
    total: Number(total) || 0,
    limit: REPORT_SNAPSHOT_LIMIT,
  });
}

// Decorate a lot row with the Asia/Riyadh date-only expiry classification.
function _decorate(r, now) {
  const expiry = r.expiry_date || null;
  return {
    id: r.id, itemId: r.item_id, itemName: r.item_name || '', lotNumber: r.lot_number,
    manufactureDate: r.manufacture_date || null, expiryDate: expiry, expiryClass: EXP.classify(expiry, now),
    daysToExpiry: EXP.daysUntil(expiry, now), lifecycleStatus: r.lifecycle_status, unitCost: Number(r.unit_cost) || 0,
    totalQty: Number(r.total_qty || 0), isImported: !!Number(r.is_imported), version: Number(r.version) || 1,
    sourceType: r.source_type || null, sourceId: r.source_id || null, createdAt: r.created_at, notes: r.notes || null,
  };
}

function _expiryRiskSql(rawRisk) {
  const risk = String(rawRisk || '');
  const th = EXP.thresholds();
  if (risk === 'expired') return { sql: 'l.expiry_date < CURDATE()', params: [] };
  if (risk === 'critical') return { sql: 'l.expiry_date >= CURDATE() AND l.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)', params: [th.critical] };
  if (risk === 'warning') return { sql: 'l.expiry_date > DATE_ADD(CURDATE(), INTERVAL ? DAY) AND l.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)', params: [th.critical, th.warning] };
  if (risk === 'safe') return { sql: 'l.expiry_date > DATE_ADD(CURDATE(), INTERVAL ? DAY)', params: [th.warning] };
  if (risk === 'none') return { sql: 'l.expiry_date IS NULL', params: [] };
  return null;
}

// ── GET /lots ───────────────────────────────────────────────────────────────
router.get('/lots', async (req, res) => {
  try {
    const q = req.query || {};
    const { page, pageSize, offset } = _page(q);
    const snapshot = String(q.snapshot || '') === '1';
    const sc = req.whScopeClause ? req.whScopeClause('b.warehouse_id') : { sql: '', params: [] };
    const where = ['1=1']; const params = [];
    if (q.itemId) { where.push('l.item_id=?'); params.push(String(q.itemId)); }
    if (STATUSES.indexOf(String(q.status)) !== -1) { where.push('l.lifecycle_status=?'); params.push(String(q.status)); }
    if (q.q) { where.push('(l.lot_number LIKE ? OR ii.name LIKE ?)'); params.push('%' + q.q + '%', '%' + q.q + '%'); }
    const riskSql = _expiryRiskSql(q.risk);
    if (riskSql) { where.push(riskSql.sql); params.push(...riskSql.params); }
    const whParam = q.warehouseId ? String(q.warehouseId) : null;
    const balExpr = 'SELECT COALESCE(SUM(b.qty),0) FROM warehouse_lot_balances b WHERE b.lot_id=l.id' + (whParam ? ' AND b.warehouse_id=?' : '') + (sc.sql || '');
    const balParams = (whParam ? [whParam] : []).concat(sc.params || []);
    const base = 'FROM inventory_lots l JOIN inv_items ii ON ii.id=l.item_id WHERE ' + where.join(' AND ');
    const [[cnt]] = await db.query('SELECT COUNT(*) AS n ' + base, params);
    const [rows] = await db.query(
      'SELECT l.*, ii.name AS item_name, (' + balExpr + ') AS total_qty ' + base + ' ORDER BY (l.expiry_date IS NULL), l.expiry_date, l.lot_number LIMIT ?' + (snapshot ? '' : ' OFFSET ?'),
      snapshot ? balParams.concat(params, [REPORT_SNAPSHOT_LIMIT + 1]) : balParams.concat(params, [pageSize, offset])
    );
    const now = new Date();
    const data = rows.map((r) => _decorate(r, now));
    const total = snapshot ? data.length : (Number(cnt.n) || 0);
    if (snapshot && total > REPORT_SNAPSHOT_LIMIT) return _snapshotTooLarge(res, total);
    res.json({ data, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });
  } catch (e) { _catch(res, e); }
});

// ── POST /lots (manual create) ───────────────────────────────────────────────
router.post('/lots', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req); const b = req.body || {};
    const itemId = String(b.itemId || b.item_id || '').trim();
    const lotNumber = String(b.lotNumber || b.lot_number || '').trim();
    if (!itemId) throw _err('VALIDATION_ERROR', 'الصنف مطلوب');
    if (!lotNumber) throw _err('LOT_REQUIRED', 'رقم الدفعة مطلوب');
    const [it] = await db.query('SELECT id, tracking_mode FROM inv_items WHERE id=? LIMIT 1', [itemId]);
    if (!it.length) throw _err('VALIDATION_ERROR', 'الصنف غير موجود');
    if (it[0].tracking_mode === 'expiry' && !EXP.ymd(b.expiryDate)) throw _err('VALIDATION_ERROR', 'تاريخ الصلاحية مطلوب لصنف يخضع لتتبع الصلاحية');
    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'lot:create', itemId + ':' + L.lotNorm(lotNumber), key, actor, b);
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب إنشاء دفعة مكرر');
    const norm = L.lotNorm(lotNumber);
    const [dup] = await db.query('SELECT id FROM inventory_lots WHERE item_id=? AND lot_norm=? LIMIT 1', [itemId, norm]);
    if (dup.length) throw _err('VALIDATION_ERROR', 'رقم الدفعة مستخدم بالفعل لهذا الصنف');
    const id = 'LOT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    await db.query(
      "INSERT INTO inventory_lots (id, item_id, lot_number, lot_norm, manufacture_date, expiry_date, lifecycle_status, source_type, unit_cost, notes, version, created_by) VALUES (?,?,?,?,?,?, 'active','manual',?,?,1,?)",
      [id, itemId, lotNumber.slice(0, 120), norm, EXP.ymd(b.manufactureDate), EXP.ymd(b.expiryDate), Number(b.unitCost) || 0, String(b.notes || '').slice(0, 500) || null, actor]
    );
    const auditEvent = await _audit(db, id, 'create', null, 'active', actor, 'إنشاء دفعة', { lotNumber });
    const body = Object.assign({}, C.mutationEnvelope({ data: { id }, documentNumber: lotNumber, status: 'active', version: 1, auditEvent }), { id });
    if (idem.mode === 'proceed') await IDEM.complete(db, idem.idemId, 201, body);
    res.status(201).json(body);
  } catch (e) { _catch(res, e); }
});

async function _loadLot(id, conn) { const [r] = await (conn || db).query("SELECT l.*, ii.name AS item_name FROM inventory_lots l JOIN inv_items ii ON ii.id=l.item_id WHERE l.id=? LIMIT 1" + (conn ? ' FOR UPDATE' : ''), [id]); return r[0] || null; }
async function _lotHasMovements(id, conn) { const [r] = await (conn || db).query('SELECT 1 FROM inventory_lot_movements WHERE lot_id=? LIMIT 1', [id]); return r.length > 0; }

// ── GET /lots/:id ────────────────────────────────────────────────────────────
router.get('/lots/:id', async (req, res) => {
  try {
    const lot = await _loadLot(req.params.id);
    if (!lot) { const e = new Error('الدفعة غير موجودة'); e.status = 404; throw e; }
    const sc = req.whScopeClause ? req.whScopeClause('b.warehouse_id') : { sql: '', params: [] };
    const [bal] = await db.query('SELECT b.warehouse_id, w.name AS warehouse_name, b.qty FROM warehouse_lot_balances b LEFT JOIN warehouses w ON w.id=b.warehouse_id WHERE b.lot_id=?' + (sc.sql || '') + ' ORDER BY b.warehouse_id', [req.params.id].concat(sc.params || []));
    const total = bal.reduce((s, r) => s + Number(r.qty), 0);
    const now = new Date();
    res.json({ data: _decorate(Object.assign({}, lot, { total_qty: total }), now), distribution: bal.map((r) => ({ warehouseId: r.warehouse_id, warehouseName: r.warehouse_name || r.warehouse_id, qty: Number(r.qty) })) });
  } catch (e) { _catch(res, e); }
});

// ── PATCH /lots/:id ──────────────────────────────────────────────────────────
router.patch('/lots/:id', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id; const b = req.body || {}; const expected = _expectedVersion(req);
    const out = await db.withTransaction(async (conn) => {
      const lot = await _loadLot(id, conn);
      if (!lot) throw _err('VALIDATION_ERROR', 'الدفعة غير موجودة');
      if (expected != null && Number(lot.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار الدفعة — أعد التحميل');
      const moved = await _lotHasMovements(id, conn);
      const sets = []; const params = [];
      // notes are always editable; expiry/manufacture only BEFORE any movement.
      if (b.notes !== undefined) { sets.push('notes=?'); params.push(String(b.notes || '').slice(0, 500) || null); }
      if (b.expiryDate !== undefined || b.manufactureDate !== undefined) {
        if (moved) throw _err('TRACKING_MODE_LOCKED', 'لا يمكن تعديل تاريخ الدفعة بعد وجود حركات — يتطلب إجراءً إداريًا مدققًا');
        if (b.expiryDate !== undefined) { sets.push('expiry_date=?'); params.push(EXP.ymd(b.expiryDate)); }
        if (b.manufactureDate !== undefined) { sets.push('manufacture_date=?'); params.push(EXP.ymd(b.manufactureDate)); }
      }
      if ((b.lotNumber !== undefined && L.lotNorm(b.lotNumber) !== lot.lot_norm) || (b.itemId !== undefined && b.itemId !== lot.item_id)) {
        throw _err('TRACKING_MODE_LOCKED', 'لا يمكن تغيير الصنف أو رقم الدفعة' + (moved ? ' بعد وجود حركات' : ''));
      }
      if (!sets.length) throw _err('VALIDATION_ERROR', 'لا يوجد تغيير صالح');
      sets.push('version=version+1');
      const [u] = await conn.query('UPDATE inventory_lots SET ' + sets.join(', ') + ' WHERE id=? AND version=?', params.concat([id, lot.version]));
      if (!u.affectedRows) throw _err('VERSION_CONFLICT', 'تغيّر إصدار الدفعة أثناء التعديل');
      const auditEvent = await _audit(conn, id, 'edit', lot.lifecycle_status, lot.lifecycle_status, actor, b.reason, null);
      return { version: Number(lot.version) + 1, auditEvent };
    });
    res.json(Object.assign({}, C.mutationEnvelope({ data: { id }, status: 'active', version: out.version, auditEvent: out.auditEvent }), { id }));
  } catch (e) { _catch(res, e); }
});

// ── GET /lots/:id/movements ──────────────────────────────────────────────────
router.get('/lots/:id/movements', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT m.*, w.name AS warehouse_name FROM inventory_lot_movements m LEFT JOIN warehouses w ON w.id=m.warehouse_id WHERE m.lot_id=? ORDER BY m.occurred_at, m.id', [req.params.id]);
    res.json({ data: rows.map((r) => ({ id: r.id, warehouseId: r.warehouse_id, warehouseName: r.warehouse_name || r.warehouse_id, signedQty: Number(r.signed_qty), referenceType: r.reference_type, referenceId: r.reference_id, reason: r.reason, actor: r.actor, occurredAt: r.occurred_at })) });
  } catch (e) { _catch(res, e); }
});

// ── GET /lots/:id/trace ──────────────────────────────────────────────────────
router.get('/lots/:id/trace', async (req, res) => {
  try {
    const lot = await _loadLot(req.params.id);
    if (!lot) { const e = new Error('الدفعة غير موجودة'); e.status = 404; throw e; }
    const now = new Date();
    const [bal] = await db.query('SELECT b.warehouse_id, w.name AS warehouse_name, b.qty FROM warehouse_lot_balances b LEFT JOIN warehouses w ON w.id=b.warehouse_id WHERE b.lot_id=?', [req.params.id]);
    const [mv] = await db.query('SELECT m.*, w.name AS warehouse_name FROM inventory_lot_movements m LEFT JOIN warehouses w ON w.id=m.warehouse_id WHERE m.lot_id=? ORDER BY m.occurred_at, m.id', [req.params.id]);
    // recall impact: distinct downstream documents this lot flowed into (out movements).
    const impacted = {};
    for (const m of mv) { if (Number(m.signed_qty) < 0 && m.reference_type) { const k = m.reference_type + ':' + (m.reference_id || ''); impacted[k] = { referenceType: m.reference_type, referenceId: m.reference_id, qty: (impacted[k] ? impacted[k].qty : 0) + Math.abs(Number(m.signed_qty)) }; } }
    res.json({
      lot: _decorate(Object.assign({}, lot, { total_qty: bal.reduce((s, r) => s + Number(r.qty), 0) }), now),
      source: { type: lot.source_type, id: lot.source_id },
      warehouses: bal.map((r) => ({ warehouseId: r.warehouse_id, warehouseName: r.warehouse_name || r.warehouse_id, qty: Number(r.qty) })),
      timeline: mv.map((m) => ({ warehouseId: m.warehouse_id, warehouseName: m.warehouse_name || m.warehouse_id, signedQty: Number(m.signed_qty), referenceType: m.reference_type, referenceId: m.reference_id, reason: m.reason, actor: m.actor, at: m.occurred_at })),
      recallImpact: Object.values(impacted),
    });
  } catch (e) { _catch(res, e); }
});

// ── lifecycle transitions: quarantine / release / recall ─────────────────────
function _lifecycleRoute(action, from, to) {
  return async (req, res) => {
    try {
      const actor = _actor(req); const id = req.params.id; const expected = _expectedVersion(req);
      const reason = String((req.body && req.body.reason) || '').trim();
      if (!reason) throw _err('VALIDATION_ERROR', 'السبب مطلوب');
      const key = IDEM.readKey(req);
      const idem = await IDEM.begin(db, 'lot:' + action, id, key, actor, req.body || {});
      if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
      if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب مكرر');
      const out = await db.withTransaction(async (conn) => {
        const lot = await _loadLot(id, conn);
        if (!lot) throw _err('VALIDATION_ERROR', 'الدفعة غير موجودة');
        if (expected != null && Number(lot.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار الدفعة — أعد التحميل');
        if (from && from.indexOf(lot.lifecycle_status) === -1) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن تنفيذ "' + action + '" على دفعة حالتها "' + lot.lifecycle_status + '"');
        const [u] = await conn.query('UPDATE inventory_lots SET lifecycle_status=?, version=version+1 WHERE id=? AND version=?', [to, id, lot.version]);
        if (!u.affectedRows) throw _err('VERSION_CONFLICT', 'تغيّر إصدار الدفعة أثناء التحديث');
        const auditEvent = await _audit(conn, id, action, lot.lifecycle_status, to, actor, reason, null);
        return { version: Number(lot.version) + 1, auditEvent, from: lot.lifecycle_status };
      });
      const body = Object.assign({}, C.mutationEnvelope({ data: { id }, status: to, version: out.version, auditEvent: out.auditEvent }), { id });
      if (idem.mode === 'proceed') await IDEM.complete(db, idem.idemId, 200, body);
      res.json(body);
    } catch (e) { _catch(res, e); }
  };
}
router.post('/lots/:id/quarantine', MGR, _lifecycleRoute('quarantine', ['active'], 'quarantined'));
router.post('/lots/:id/release', MGR, _lifecycleRoute('release', ['quarantined'], 'active'));
router.post('/lots/:id/recall', MGR, _lifecycleRoute('recall', ['active', 'quarantined'], 'recalled'));

// ── GET /expiry (+ /summary) ─────────────────────────────────────────────────
function _expiryWhere(req) {
  const sc = req.whScopeClause ? req.whScopeClause('b.warehouse_id') : { sql: '', params: [] };
  const where = ['b.qty > 0', "l.lifecycle_status <> 'closed'", 'l.expiry_date IS NOT NULL']; const params = [];
  if (req.query.warehouseId) { where.push('b.warehouse_id=?'); params.push(String(req.query.warehouseId)); }
  const levelSql = _expiryRiskSql(req.query.level);
  if (levelSql) { where.push(levelSql.sql); params.push(...levelSql.params); }
  return { sql: ' WHERE ' + where.join(' AND ') + (sc.sql || ''), params: params.concat(sc.params || []) };
}
router.get('/expiry', async (req, res) => {
  try {
    const w = _expiryWhere(req); const { page, pageSize, offset } = _page(req.query);
    const snapshot = String(req.query.snapshot || '') === '1';
    const from = ' FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id JOIN inv_items ii ON ii.id=l.item_id LEFT JOIN warehouses w ON w.id=b.warehouse_id' + w.sql;
    const [[countRow]] = await db.query('SELECT COUNT(*) AS n' + from, w.params);
    const [rows] = await db.query(
      "SELECT l.id, l.item_id, ii.name AS item_name, l.lot_number, DATE_FORMAT(l.expiry_date,'%Y-%m-%d') AS expiry_date, l.lifecycle_status, b.warehouse_id, w.name AS warehouse_name, b.qty " +
      from + ' ORDER BY l.expiry_date LIMIT ?' + (snapshot ? '' : ' OFFSET ?'),
      snapshot ? w.params.concat([REPORT_SNAPSHOT_LIMIT + 1]) : w.params.concat([pageSize, offset])
    );
    const now = new Date();
    const data = rows.map((r) => ({ lotId: r.id, itemId: r.item_id, itemName: r.item_name, lotNumber: r.lot_number, expiryDate: r.expiry_date, daysToExpiry: EXP.daysUntil(r.expiry_date, now), expiryClass: EXP.classify(r.expiry_date, now), lifecycleStatus: r.lifecycle_status, warehouseId: r.warehouse_id, warehouseName: r.warehouse_name || r.warehouse_id, qty: Number(r.qty) }));
    const total = snapshot ? data.length : (Number(countRow.n) || 0);
    if (snapshot && total > REPORT_SNAPSHOT_LIMIT) return _snapshotTooLarge(res, total);
    res.json({ data, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });
  } catch (e) { _catch(res, e); }
});
router.get('/expiry/summary', async (req, res) => {
  try {
    const w = _expiryWhere(req);
    const [rows] = await db.query("SELECT DATE_FORMAT(l.expiry_date,'%Y-%m-%d') AS expiry_date, b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id" + w.sql, w.params);
    const now = new Date(); const byClass = { expired: 0, critical: 0, warning: 0, safe: 0 }; let qtyExpired = 0;
    for (const r of rows) { const c = EXP.classify(r.expiry_date, now); if (byClass[c] !== undefined) byClass[c]++; if (c === 'expired') qtyExpired += Number(r.qty); }
    res.json({ data: { byClass, qtyExpired, total: rows.length } });
  } catch (e) { _catch(res, e); }
});

// ── GET /lot-allocation/suggest (FEFO preview) ───────────────────────────────
router.get('/lot-allocation/suggest', async (req, res) => {
  try {
    const warehouseId = String(req.query.warehouseId || ''); const itemId = String(req.query.itemId || ''); const qty = Number(req.query.qty);
    if (!warehouseId || !itemId || !Number.isFinite(qty) || qty <= 0) throw _err('VALIDATION_ERROR', 'warehouseId و itemId و qty مطلوبة');
    if (req.guardWh && !req.guardWh(res, warehouseId)) return;
    const mode = await L.getTrackingMode(db, itemId);
    if (!L.isTracked(mode)) return res.json({ data: { tracked: false, allocations: [], shortfall: 0 } });
    const balances = await L.loadBalances(db, warehouseId, itemId, false);
    const plan = L.planFefo(balances, qty, { mode, now: new Date() });
    const byId = new Map(balances.map((b) => [b.lotId, b]));
    res.json({ data: { tracked: true, allocations: plan.allocations.map((a) => ({ lotId: a.lotId, lotNumber: byId.get(a.lotId) ? byId.get(a.lotId).lotNumber : null, qty: a.qty, expiryDate: byId.get(a.lotId) ? byId.get(a.lotId).expiryDate : null })), shortfall: plan.shortfall, skipped: plan.skipped } });
  } catch (e) { _catch(res, e); }
});

// ── GET /lot-integrity (+ /export) ───────────────────────────────────────────
async function _integrityRows(req) {
  const sc = req.whScopeClause ? req.whScopeClause('ws.warehouse_id') : { sql: '', params: [] };
  const where = ['ii.tracking_mode <> \'none\'']; const params = [];
  if (req.query.warehouseId) { where.push('ws.warehouse_id=?'); params.push(String(req.query.warehouseId)); }
  const [rows] = await db.query(
    'SELECT ws.warehouse_id, w.name AS warehouse_name, ws.item_id, ii.name AS item_name, ws.qty AS stock_qty, ' +
    '(SELECT COALESCE(SUM(b.qty),0) FROM warehouse_lot_balances b WHERE b.warehouse_id=ws.warehouse_id AND b.item_id=ws.item_id) AS lot_qty ' +
    'FROM warehouse_stock ws JOIN inv_items ii ON ii.id=ws.item_id LEFT JOIN warehouses w ON w.id=ws.warehouse_id WHERE ' + where.join(' AND ') + (sc.sql || '') + ' ORDER BY ws.warehouse_id, ii.name',
    params.concat(sc.params || [])
  );
  return rows.map((r) => { const drift = Math.round((Number(r.stock_qty) - Number(r.lot_qty)) * 1000) / 1000; return { warehouseId: r.warehouse_id, warehouseName: r.warehouse_name || r.warehouse_id, itemId: r.item_id, itemName: r.item_name, stockQty: Number(r.stock_qty), lotQty: Number(r.lot_qty), drift, ok: Math.abs(drift) < 0.001 }; });
}
router.get('/lot-integrity', async (req, res) => {
  try {
    const rows = await _integrityRows(req);
    const onlyDrift = /^(1|true|yes)$/i.test(String(req.query.driftOnly || ''));
    const data = onlyDrift ? rows.filter((r) => !r.ok) : rows;
    res.json({ data, summary: { total: rows.length, drifting: rows.filter((r) => !r.ok).length } });
  } catch (e) { _catch(res, e); }
});
router.get('/lot-integrity/export', async (req, res) => {
  try {
    const rows = await _integrityRows(req);
    const csv = CSV.toCsv(['المستودع', 'الصنف', 'رصيد المستودع', 'مجموع الدفعات', 'الفرق', 'الحالة'],
      rows.map((r) => [r.warehouseName, r.itemName, r.stockQty, r.lotQty, r.drift, r.ok ? 'متطابق' : 'انحراف']));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lot-integrity.csv"');
    res.send(csv);
  } catch (e) { _catch(res, e); }
});

module.exports = router;
