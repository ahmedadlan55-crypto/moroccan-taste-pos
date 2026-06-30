/**
 * Independent inventory transactions — Phase 3B.
 *
 * Three FULLY-SEPARATE document types under /api/inventory/v2:
 *   • receipts     — stock IN to a warehouse (not a purchase / no supplier).
 *   • issues       — stock OUT to an expense / department / cost-center.
 *   • adjustments  — countedQty recount → server-computed delta.
 *
 * Each shares ONE hardened lifecycle (mirrors the transfers hardening):
 *   draft → approved → posted → reversed   (+ cancel before posting, delete draft)
 * Every transition: actor from JWT, RBAC, warehouse scope, expectedVersion
 * (conditional UPDATE → VERSION_CONFLICT), optional Idempotency-Key, audit
 * event, unified error envelope, ONE db.withTransaction with full rollback.
 *
 * Posting is the ONLY step that moves stock + posts GL. posted_unit_cost is
 * frozen per line so a reverse restores the EXACT original valuation. Movements
 * carry a doc-type-specific reference_type (inv_receipt / inv_issue /
 * inv_adjustment) so a transfer can never be double-counted as a receipt/issue.
 *
 * Legacy is untouched: stock_issues (transfers), stock_adjustments (delta model)
 * and /api/inventory/adjustments keep working byte-for-byte.
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const gl = require('../lib/glPosting');
const E = require('../lib/inventoryTxEngine');
const C = require('../lib/inventoryTxContract');
const IDEM = require('../lib/idempotencyStore');
const { recomputeInvItemStock } = require('../lib/stockRecompute');
const requireRole = require('../middleware/auth').requireRole;

const MGR = requireRole('admin', 'manager');
const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');

// Maker–Checker (adjustments): the creator may not approve their own document.
// On by default; INV_MAKER_CHECKER=0/off disables. Admins always bypass.
const MAKER_CHECKER = !/^(0|false|off|no)$/i.test(String(process.env.INV_MAKER_CHECKER || '').trim());
// A large adjustment requires reference_evidence. Threshold in currency value.
const EVIDENCE_THRESHOLD = (() => { const n = Number(process.env.INV_ADJ_EVIDENCE_THRESHOLD); return Number.isFinite(n) && n > 0 ? n : 1000; })();

// ── Doc-type configuration ──────────────────────────────────────────────────
const DOCS = {
  receipt: { table: 'inv_receipts', items: 'inv_receipt_items', fk: 'receipt_id', numberCol: 'receipt_number', dateCol: 'receipt_date', docType: 'receipt', prefix: 'RCV', refType: 'inv_receipt' },
  issue: { table: 'inv_issues', items: 'inv_issue_items', fk: 'issue_id', numberCol: 'issue_number', dateCol: 'issue_date', docType: 'issue', prefix: 'ISU', refType: 'inv_issue' },
  adjustment: { table: 'inv_adjustments', items: 'inv_adjustment_items', fk: 'adjustment_id', numberCol: 'adjustment_number', dateCol: 'adjustment_date', docType: 'adjustment', prefix: 'ADV', refType: 'inv_adjustment' },
};

// ── Generic helpers ─────────────────────────────────────────────────────────
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _isAdmin(req) { return String((req.user && req.user.role) || '').toLowerCase() === 'admin' || (req.user && req.user.isDeveloper); }
function _ymd(d) { d = d || new Date(); return d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function _today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// mysql2 returns DATE columns as JS Date objects; GL posting expects a
// 'YYYY-MM-DD' string. Normalize before building any journal spec.
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

// Atomic per-(doc_type, day) number on the SAME connection (LAST_INSERT_ID is
// connection-scoped → no duplicate numbers under concurrency). UNIQUE *_number
// is the absolute guard.
async function _nextNumber(conn, cfg) {
  const ymd = _ymd();
  await conn.query('INSERT INTO inv_tx_counter (doc_type, ymd, last_serial) VALUES (?,?,LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_serial = LAST_INSERT_ID(last_serial + 1)', [cfg.docType, ymd]);
  const [r] = await conn.query('SELECT LAST_INSERT_ID() AS s');
  const serial = Number(r[0] && r[0].s) || 1;
  return cfg.prefix + '-' + ymd + '-' + String(serial).padStart(4, '0');
}

async function _audit(conn, cfg, docId, action, fromStatus, toStatus, actor, note, payload) {
  const q = conn || db;
  try {
    await q.query(
      'INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
      ['EV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), cfg.docType, docId, action, fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500), payload ? JSON.stringify(payload).slice(0, 8000) : null]
    );
  } catch (_) { /* audit best-effort */ }
  return { docType: cfg.docType, docId, action, fromStatus: fromStatus || null, toStatus: toStatus || null, actor: actor || '', at: new Date().toISOString() };
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

async function _loadWarehouse(id) {
  const [rows] = await db.query('SELECT id, code, name, type, is_main, brand_id, branch_id FROM warehouses WHERE id=? LIMIT 1', [id]);
  return rows[0] || null;
}
async function _loadDoc(cfg, id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM ' + cfg.table + ' WHERE id=? LIMIT 1' + (conn ? ' FOR UPDATE' : ''), [id]);
  return rows[0] || null;
}
async function _loadLines(cfg, id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM ' + cfg.items + ' WHERE ' + cfg.fk + '=? ORDER BY id', [id]);
  return rows;
}

// Validate the items array shape shared by all docs: non-empty + no dup itemId.
function _validateItems(items, qtyField, allowZero) {
  if (!Array.isArray(items) || items.length === 0) throw _err('VALIDATION_ERROR', 'يجب إدخال سطر واحد على الأقل');
  const seen = new Set();
  for (const it of items) {
    const id = it && (it.itemId || it.item_id);
    if (!id) throw _err('VALIDATION_ERROR', 'صنف غير معرّف في أحد السطور');
    if (seen.has(id)) throw _err('VALIDATION_ERROR', 'تكرار الصنف ' + id + ' في السطور');
    seen.add(id);
    const qty = Number(it[qtyField]);
    if (!Number.isFinite(qty)) throw _err('VALIDATION_ERROR', 'كمية غير صحيحة للصنف ' + id);
    if (allowZero ? qty < 0 : qty <= 0) throw _err('VALIDATION_ERROR', 'الكمية يجب أن تكون موجبة للصنف ' + id);
  }
}

async function _itemMeta(itemId) {
  const [r] = await db.query('SELECT id, name, unit FROM inv_items WHERE id=? LIMIT 1', [itemId]);
  return r[0] || { id: itemId, name: '', unit: '' };
}

// ── Build draft lines per doc type (also used by PATCH) ─────────────────────
// Returns { lines:[{itemId,itemName,unit,...}], totalCost, totalValue, header:{} }
async function _buildReceipt(body, warehouse) {
  _validateItems(body.items, 'qty', false);
  const lines = [];
  let total = 0;
  for (const it of body.items) {
    const itemId = it.itemId || it.item_id;
    const qty = Number(it.qty);
    const unitCost = Number(it.unitCost != null ? it.unitCost : it.unit_cost);
    if (!Number.isFinite(unitCost) || unitCost <= 0) throw _err('COST_REQUIRED', 'تكلفة الوحدة مطلوبة وموجبة للصنف ' + itemId);
    const meta = await _itemMeta(itemId);
    const lineTotal = E.round2(qty * unitCost);
    total += lineTotal;
    lines.push({ itemId, itemName: meta.name, unit: meta.unit, qty, unitCost: E.round4(unitCost), lineTotal });
  }
  total = E.round2(total);
  return { lines, totalCost: total, totalValue: total, header: { source_ref: (body.sourceRef || body.source_ref || '').toString().slice(0, 200) || null } };
}

async function _buildIssue(body, warehouse) {
  if (!String(body.reason || '').trim()) throw _err('REASON_REQUIRED', 'سبب الصرف إلزامي');
  _validateItems(body.items, 'qty', false);
  const lines = [];
  let total = 0;
  for (const it of body.items) {
    const itemId = it.itemId || it.item_id;
    const qty = Number(it.qty);
    const meta = await _itemMeta(itemId);
    // Estimate the line at the current WAC; the authoritative cost is frozen at post.
    const est = await E.getEffectiveCost(db, itemId, warehouse.id);
    const lineTotal = E.round2(qty * est);
    total += lineTotal;
    lines.push({ itemId, itemName: meta.name, unit: meta.unit, qty, unitCost: E.round4(est), lineTotal });
  }
  total = E.round2(total);
  return {
    lines, totalCost: total, totalValue: total,
    header: {
      reason: String(body.reason).trim().slice(0, 200),
      recipient: (body.recipient || '').toString().slice(0, 200) || null,
      expense_account_code: (body.expenseAccountCode || body.expense_account_code || '').toString().slice(0, 20) || null,
    },
  };
}

async function _buildAdjustment(body, warehouse) {
  if (!String(body.reason || '').trim()) throw _err('REASON_REQUIRED', 'سبب التعديل إلزامي');
  _validateItems(body.items, 'countedQty', true);
  const lines = [];
  let totalDeltaValue = 0;
  let absValue = 0;
  for (const it of body.items) {
    const itemId = it.itemId || it.item_id;
    const counted = Number(it.countedQty != null ? it.countedQty : it.counted_qty);
    const meta = await _itemMeta(itemId);
    // Snapshot the system qty NOW; delta is computed in the backend (client delta ignored).
    const snap = await E.readStock(db, warehouse.id, itemId);
    const systemQty = snap.qty;
    const delta = E.round2(counted - systemQty);
    const cost = await E.getEffectiveCost(db, itemId, warehouse.id);
    const deltaValue = E.round2(delta * cost);
    totalDeltaValue += deltaValue;
    absValue += Math.abs(deltaValue);
    lines.push({ itemId, itemName: meta.name, unit: meta.unit, systemQtySnapshot: systemQty, countedQty: counted, delta, unitCost: E.round4(cost), deltaValue });
  }
  const evidence = (body.referenceEvidence || body.reference_evidence || '').toString().slice(0, 500) || null;
  if (E.round2(absValue) >= EVIDENCE_THRESHOLD && !evidence) {
    throw _err('EVIDENCE_REQUIRED', 'تعديل كبير (' + E.round2(absValue) + ') يتطلب مرجعًا/إثباتًا (reference_evidence)');
  }
  return { lines, totalCost: 0, totalValue: E.round2(totalDeltaValue), header: { reason: String(body.reason).trim().slice(0, 200), reference_evidence: evidence, total_delta_value: E.round2(totalDeltaValue) } };
}

const BUILDERS = { receipt: _buildReceipt, issue: _buildIssue, adjustment: _buildAdjustment };

// Insert the per-doc line rows inside a txn.
async function _insertLines(conn, cfg, docId, lines) {
  for (const ln of lines) {
    const id = 'LN-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    if (cfg.docType === 'adjustment') {
      await conn.query(
        'INSERT INTO ' + cfg.items + ' (id, ' + cfg.fk + ', item_id, item_name, unit, system_qty_snapshot, counted_qty, delta, unit_cost, delta_value, posted_unit_cost, notes) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
        [id, docId, ln.itemId, ln.itemName || '', ln.unit || '', ln.systemQtySnapshot || 0, ln.countedQty || 0, ln.delta || 0, ln.unitCost || 0, ln.deltaValue || 0, (ln.notes || '').toString().slice(0, 400)]
      );
    } else {
      await conn.query(
        'INSERT INTO ' + cfg.items + ' (id, ' + cfg.fk + ', item_id, item_name, unit, qty, unit_cost, line_total, posted_unit_cost, notes) VALUES (?,?,?,?,?,?,?,?,0,?)',
        [id, docId, ln.itemId, ln.itemName || '', ln.unit || '', ln.qty || 0, ln.unitCost || 0, ln.lineTotal || 0, (ln.notes || '').toString().slice(0, 400)]
      );
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// READ — list (+KPIs) and detail (+timeline+movements+GL)
// ════════════════════════════════════════════════════════════════════════════
function _makeList(cfg) {
  const sortWl = ['created_at', cfg.dateCol, 'status', cfg.numberCol, 'total_value'];
  return async (req, res) => {
    try {
      const p = C.parseListQuery(req.query, sortWl, C.STATUSES);
      const sc = req.whScopeClause ? req.whScopeClause('t.warehouse_id') : { sql: '', params: [] };
      const where = ['1=1'];
      const params = [];
      if (p.status) { where.push('t.status=?'); params.push(p.status); }
      if (p.warehouseId) { where.push('t.warehouse_id=?'); params.push(p.warehouseId); }
      if (p.dateFrom) { where.push('t.' + cfg.dateCol + ' >= ?'); params.push(p.dateFrom); }
      if (p.dateTo) { where.push('t.' + cfg.dateCol + ' <= ?'); params.push(p.dateTo); }
      if (p.q) { where.push('(t.' + cfg.numberCol + ' LIKE ? OR t.notes LIKE ?)'); params.push('%' + p.q + '%', '%' + p.q + '%'); }
      const whereSql = ' WHERE ' + where.join(' AND ') + (sc.sql || '');
      const allParams = params.concat(sc.params || []);
      const [rows] = await db.query(
        'SELECT t.*, w.name AS warehouse_name, w.code AS warehouse_code FROM ' + cfg.table + ' t LEFT JOIN warehouses w ON w.id=t.warehouse_id' +
        whereSql + ' ORDER BY t.' + p.sort + ' ' + p.dir + ' LIMIT ? OFFSET ?',
        allParams.concat([p.pageSize, p.offset])
      );
      const [cnt] = await db.query('SELECT COUNT(*) AS total FROM ' + cfg.table + ' t' + whereSql, allParams);
      const [kpi] = await db.query(
        'SELECT ' +
        " SUM(status='draft') AS draft, SUM(status='approved') AS approved, SUM(status='posted') AS posted," +
        " SUM(status='cancelled') AS cancelled, SUM(status='reversed') AS reversed," +
        ' SUM(CASE WHEN status=\'posted\' THEN total_value ELSE 0 END) AS posted_value' +
        ' FROM ' + cfg.table + ' t' + whereSql, allParams
      );
      const total = Number(cnt[0].total) || 0;
      res.json({
        data: rows,
        pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) },
        kpis: {
          draft: Number(kpi[0].draft) || 0, approved: Number(kpi[0].approved) || 0, posted: Number(kpi[0].posted) || 0,
          cancelled: Number(kpi[0].cancelled) || 0, reversed: Number(kpi[0].reversed) || 0, postedValue: Number(kpi[0].posted_value) || 0,
        },
        filters: { status: p.status, warehouseId: p.warehouseId, dateFrom: p.dateFrom, dateTo: p.dateTo, q: p.q, sort: p.sort, dir: p.dir },
      });
    } catch (e) { _catch(res, e); }
  };
}

function _makeDetail(cfg) {
  return async (req, res) => {
    try {
      const doc = await _loadDoc(cfg, req.params.id);
      if (!doc) { const e = new Error('المستند غير موجود'); e.status = 404; throw e; }
      if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
      const lines = await _loadLines(cfg, doc.id);
      const [events] = await db.query('SELECT * FROM inv_tx_events WHERE doc_type=? AND doc_id=? ORDER BY created_at ASC, id ASC', [cfg.docType, doc.id]);
      const [movements] = await db.query('SELECT * FROM inventory_movements WHERE reference_type IN (?, ?) AND reference_id=? ORDER BY movement_date ASC, id ASC', [cfg.refType, cfg.refType + '_reverse', doc.id]);
      const journalIds = [doc.gl_journal_id, doc.reverse_gl_journal_id].filter(Boolean);
      let journals = [];
      if (journalIds.length) {
        const [jr] = await db.query('SELECT j.id, j.journal_number, j.journal_date, j.total_debit, j.total_credit, j.reference_type FROM gl_journals j WHERE j.id IN (?)', [journalIds]);
        journals = jr;
        if (jr.length) {
          const [entries] = await db.query('SELECT journal_id, account_code, account_name, debit, credit FROM gl_entries WHERE journal_id IN (?) ORDER BY journal_id, id', [journalIds]);
          journals = jr.map((j) => Object.assign({}, j, { entries: entries.filter((e) => e.journal_id === j.id) }));
        }
      }
      res.json({ data: doc, lines, timeline: events, movements, journals });
    } catch (e) { _catch(res, e); }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CREATE draft
// ════════════════════════════════════════════════════════════════════════════
function _makeCreate(cfg) {
  return async (req, res) => {
    let idemId = null;
    try {
      const actor = _actor(req);
      const warehouseId = req.body && (req.body.warehouseId || req.body.warehouse_id);
      if (!warehouseId) return _fail(res, 'VALIDATION_ERROR', 'المستودع مطلوب');
      if (req.guardWh && !req.guardWh(res, warehouseId)) return;
      const warehouse = await _loadWarehouse(warehouseId);
      if (!warehouse) return _fail(res, 'VALIDATION_ERROR', 'المستودع غير موجود');

      const key = IDEM.readKey(req);
      const idem = await IDEM.begin(db, 'inv:' + cfg.docType + ':create', '', key, actor, req.body);
      if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
      if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب مكرر بمحتوى مختلف أو قيد التنفيذ');
      if (idem.mode === 'proceed') idemId = idem.idemId;

      const built = await BUILDERS[cfg.docType](req.body, warehouse);
      const docDate = (req.body[cfg.dateCol] || req.body.date || _today());

      const out = await db.withTransaction(async (conn) => {
        const number = await _nextNumber(conn, cfg);
        const id = cfg.prefix + '-' + crypto.randomBytes(6).toString('hex');
        const h = built.header || {};
        const cols = ['id', cfg.numberCol, 'warehouse_id', 'brand_id', 'branch_id', 'cost_center_id', cfg.dateCol, 'status', 'total_cost', 'total_value', 'notes', 'created_by', 'version'];
        const vals = [id, number, warehouse.id, warehouse.brand_id || null, warehouse.branch_id || null, (req.body.costCenterId || req.body.cost_center_id || null), docDate, 'draft', built.totalCost, built.totalValue, (req.body.notes || '').toString().slice(0, 2000) || null, actor, 1];
        // doc-specific header columns
        for (const k of Object.keys(h)) { cols.push(k); vals.push(h[k]); }
        await conn.query('INSERT INTO ' + cfg.table + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')', vals);
        await _insertLines(conn, cfg, id, built.lines);
        const auditEvent = await _audit(conn, cfg, id, 'create', null, 'draft', actor, 'إنشاء مسودة', { lineCount: built.lines.length });
        return { id, number, auditEvent };
      });

      const body = _envelope({ data: { id: out.id }, documentNumber: out.number, status: 'draft', version: 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id: out.id, number: out.number });
      if (idemId) await IDEM.complete(db, idemId, 201, body);
      return res.status(201).json(body);
    } catch (e) {
      if (idemId) await IDEM.abort(db, idemId).catch(() => {});
      _catch(res, e);
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PATCH draft (keeps number; version-guarded; replaces lines)
// ════════════════════════════════════════════════════════════════════════════
function _makePatch(cfg) {
  return async (req, res) => {
    try {
      const actor = _actor(req);
      const id = req.params.id;
      const expected = _expectedVersion(req);
      if (expected == null) return _fail(res, 'VALIDATION_ERROR', 'expectedVersion مطلوب للتعديل');
      const doc = await _loadDoc(cfg, id);
      if (!doc) { const e = new Error('المستند غير موجود'); e.status = 404; throw e; }
      if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
      E.assertCanEdit(doc.status);
      const warehouse = await _loadWarehouse(doc.warehouse_id);
      if (!warehouse) return _fail(res, 'VALIDATION_ERROR', 'المستودع غير موجود');
      const built = await BUILDERS[cfg.docType](Object.assign({}, req.body, { warehouseId: doc.warehouse_id }), warehouse);

      const out = await db.withTransaction(async (conn) => {
        const h = built.header || {};
        const setCols = [cfg.dateCol + '=?', 'total_cost=?', 'total_value=?', 'notes=?', 'version=version+1'];
        const setVals = [(req.body[cfg.dateCol] || doc[cfg.dateCol] || _today()), built.totalCost, built.totalValue, (req.body.notes != null ? String(req.body.notes).slice(0, 2000) : doc.notes)];
        for (const k of Object.keys(h)) { setCols.push(k + '=?'); setVals.push(h[k]); }
        const [r] = await conn.query('UPDATE ' + cfg.table + ' SET ' + setCols.join(', ') + " WHERE id=? AND status='draft' AND version=?", setVals.concat([id, expected]));
        if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت المسودة منذ آخر تحميل — أعد التحميل');
        await conn.query('DELETE FROM ' + cfg.items + ' WHERE ' + cfg.fk + '=?', [id]);
        await _insertLines(conn, cfg, id, built.lines);
        const auditEvent = await _audit(conn, cfg, id, 'edit', 'draft', 'draft', actor, 'تعديل مسودة', { lineCount: built.lines.length });
        return { auditEvent };
      });

      return _ok(res, { data: { id }, documentNumber: doc[cfg.numberCol], status: 'draft', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id, number: doc[cfg.numberCol] });
    } catch (e) { _catch(res, e); }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// APPROVE (no stock movement) — Maker–Checker for adjustments
// ════════════════════════════════════════════════════════════════════════════
function _makeApprove(cfg) {
  return async (req, res) => {
    try {
      const actor = _actor(req);
      const id = req.params.id;
      const expected = _expectedVersion(req);
      const doc = await _loadDoc(cfg, id);
      if (!doc) { const e = new Error('المستند غير موجود'); e.status = 404; throw e; }
      if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
      E.assertCanApprove(doc.status);
      if (cfg.docType === 'adjustment' && MAKER_CHECKER && !_isAdmin(req) && doc.created_by && doc.created_by === actor) {
        return _fail(res, 'PERMISSION_DENIED', 'لا يمكن لمُنشئ التعديل اعتماده بنفسه (Maker–Checker)');
      }
      const out = await db.withTransaction(async (conn) => {
        const [r] = await conn.query(
          'UPDATE ' + cfg.table + " SET status='approved', approved_by=?, approved_at=NOW(), version=version+1 WHERE id=? AND status='draft'" + (expected != null ? ' AND version=?' : ''),
          expected != null ? [actor, id, expected] : [actor, id]
        );
        if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المستند — أعد التحميل');
        const auditEvent = await _audit(conn, cfg, id, 'approve', 'draft', 'approved', actor, req.body && req.body.note, null);
        return { auditEvent };
      });
      return _ok(res, { data: { id }, documentNumber: doc[cfg.numberCol], status: 'approved', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
    } catch (e) { _catch(res, e); }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// POST / execute — the ONLY step that moves stock + posts GL. Atomic.
// ════════════════════════════════════════════════════════════════════════════
async function _postReceipt(conn, cfg, doc, lines, actor) {
  const warehouse = await _loadWarehouse(doc.warehouse_id);
  const affectedStock = [];
  const movementIds = [];
  let amount = 0;
  for (const ln of lines) {
    const cost = Number(ln.unit_cost);
    const qty = Number(ln.qty);
    const mv = await E.applyStockMovement(conn, doc.warehouse_id, ln.item_id, qty, cost, 'inv_receipt', doc.id, actor);
    const mid = await E.recordMovement(conn, { warehouseId: doc.warehouse_id, itemId: ln.item_id, itemName: ln.item_name, type: 'in', qty, reason: 'استلام مستقل', username: actor, notes: doc[cfg.numberCol], referenceType: cfg.refType, referenceId: doc.id });
    movementIds.push(mid);
    affectedStock.push({ warehouseId: doc.warehouse_id, itemId: ln.item_id, delta: qty, newQty: mv.newQty });
    await conn.query('UPDATE ' + cfg.items + ' SET posted_unit_cost=? WHERE id=?', [cost, ln.id]);
    amount += qty * cost;
    try { await recomputeInvItemStock(conn, ln.item_id); } catch (_) {}
  }
  amount = E.round2(amount);
  const spec = E.glReceipt({ amount, warehouse, warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id, costCenterId: doc.cost_center_id, journalDate: _dateStr(doc[cfg.dateCol]), postedBy: actor, referenceId: doc.id, description: 'استلام مستقل ' + doc[cfg.numberCol] });
  return { affectedStock, movementIds, amount, spec };
}

async function _postIssue(conn, cfg, doc, lines, actor) {
  const warehouse = await _loadWarehouse(doc.warehouse_id);
  const affectedStock = [];
  const movementIds = [];
  let amount = 0;
  // Re-cost at current WAC + enforce the no-negative policy (lock rows first).
  for (const ln of lines) {
    const qty = Number(ln.qty);
    const cur = await E.readStock(conn, doc.warehouse_id, ln.item_id, true); // FOR UPDATE
    if (cur.qty < qty) throw _err('INSUFFICIENT_STOCK', 'الرصيد المتاح (' + cur.qty + ') لا يكفي لصرف ' + qty + ' من الصنف ' + ln.item_id);
  }
  for (const ln of lines) {
    const qty = Number(ln.qty);
    const cost = await E.getEffectiveCost(conn, ln.item_id, doc.warehouse_id);
    const mv = await E.applyStockMovement(conn, doc.warehouse_id, ln.item_id, -qty, cost, 'inv_issue', doc.id, actor);
    const mid = await E.recordMovement(conn, { warehouseId: doc.warehouse_id, itemId: ln.item_id, itemName: ln.item_name, type: 'out', qty, reason: 'صرف مستقل: ' + (doc.reason || ''), username: actor, notes: doc[cfg.numberCol], referenceType: cfg.refType, referenceId: doc.id });
    movementIds.push(mid);
    affectedStock.push({ warehouseId: doc.warehouse_id, itemId: ln.item_id, delta: -qty, newQty: mv.newQty });
    await conn.query('UPDATE ' + cfg.items + ' SET posted_unit_cost=?, unit_cost=?, line_total=? WHERE id=?', [cost, cost, E.round2(qty * cost), ln.id]);
    amount += qty * cost;
    try { await recomputeInvItemStock(conn, ln.item_id); } catch (_) {}
  }
  amount = E.round2(amount);
  const spec = E.glIssue({ amount, warehouse, warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id, costCenterId: doc.cost_center_id, expenseCode: doc.expense_account_code || null, journalDate: _dateStr(doc[cfg.dateCol]), postedBy: actor, referenceId: doc.id, description: 'صرف مستقل ' + doc[cfg.numberCol] });
  return { affectedStock, movementIds, amount, spec };
}

async function _postAdjustment(conn, cfg, doc, lines, actor) {
  const warehouse = await _loadWarehouse(doc.warehouse_id);
  const affectedStock = [];
  const movementIds = [];
  let posValue = 0, negValue = 0, netValue = 0;
  for (const ln of lines) {
    const snap = Number(ln.system_qty_snapshot);
    const cur = await E.readStock(conn, doc.warehouse_id, ln.item_id, true); // FOR UPDATE
    if (Math.abs(cur.qty - snap) > 1e-9) throw _err('QUANTITY_CONFLICT', 'تغيّر رصيد الصنف ' + ln.item_id + ' منذ الجرد (الآن ' + cur.qty + ' بدل ' + snap + ') — أعد الجرد');
    const delta = Number(ln.delta);
    if (Math.abs(delta) < 1e-9) { await conn.query('UPDATE ' + cfg.items + ' SET posted_unit_cost=? WHERE id=?', [Number(ln.unit_cost), ln.id]); continue; }
    const cost = await E.getEffectiveCost(conn, ln.item_id, doc.warehouse_id);
    const mv = await E.applyStockMovement(conn, doc.warehouse_id, ln.item_id, delta, cost, 'inv_adjustment', doc.id, actor);
    const mid = await E.recordMovement(conn, { warehouseId: doc.warehouse_id, itemId: ln.item_id, itemName: ln.item_name, type: delta > 0 ? 'in' : 'out', qty: Math.abs(delta), reason: 'تعديل مخزني: ' + (doc.reason || ''), username: actor, notes: doc[cfg.numberCol], referenceType: cfg.refType, referenceId: doc.id });
    movementIds.push(mid);
    affectedStock.push({ warehouseId: doc.warehouse_id, itemId: ln.item_id, delta, newQty: mv.newQty });
    const dval = E.round2(Math.abs(delta) * cost);
    if (delta > 0) posValue += dval; else negValue += dval;
    netValue += delta * cost;
    await conn.query('UPDATE ' + cfg.items + ' SET posted_unit_cost=?, unit_cost=?, delta_value=? WHERE id=?', [cost, cost, E.round2(delta * cost), ln.id]);
    try { await recomputeInvItemStock(conn, ln.item_id); } catch (_) {}
  }
  posValue = E.round2(posValue); negValue = E.round2(negValue);
  const spec = (posValue > 0 || negValue > 0)
    ? E.glAdjustmentNet({ posValue, negValue, warehouse, warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id, costCenterId: doc.cost_center_id, expenseCode: E.adjustmentExpenseCode(doc.reason), journalDate: _dateStr(doc[cfg.dateCol]), postedBy: actor, referenceId: doc.id, description: 'تعديل مخزني ' + doc[cfg.numberCol] })
    : null;
  return { affectedStock, movementIds, amount: E.round2(posValue + negValue), netValue: E.round2(netValue), spec };
}

const POSTERS = { receipt: _postReceipt, issue: _postIssue, adjustment: _postAdjustment };

function _makePost(cfg) {
  return async (req, res) => {
    let idemId = null;
    try {
      const actor = _actor(req);
      const id = req.params.id;
      const expected = _expectedVersion(req);
      const pre = await _loadDoc(cfg, id);
      if (!pre) { const e = new Error('المستند غير موجود'); e.status = 404; throw e; }
      if (req.guardWh && !req.guardWh(res, pre.warehouse_id)) return;
      E.assertCanPost(pre.status);

      const key = IDEM.readKey(req);
      const idem = await IDEM.begin(db, 'inv:' + cfg.docType + ':post', id, key, actor, req.body || {});
      if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
      if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب ترحيل مكرر');
      if (idem.mode === 'proceed') idemId = idem.idemId;

      const out = await db.withTransaction(async (conn) => {
        const doc = await _loadDoc(cfg, id, conn); // FOR UPDATE
        if (!doc) throw _err('VALIDATION_ERROR', 'المستند غير موجود');
        if (doc.status !== 'approved') throw _err('VERSION_CONFLICT', 'تغيّرت حالة المستند — أعد التحميل');
        if (expected != null && Number(doc.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار المستند — أعد التحميل');
        const lines = await _loadLines(cfg, id, conn);
        const r = await POSTERS[cfg.docType](conn, cfg, doc, lines, actor);
        let journalId = null;
        if (r.spec) {
          const j = await gl.postJournal(conn, r.spec);
          if (!j || !j.success) throw _err('GL_POSTING_FAILED', (j && j.error) || 'فشل ترحيل القيد المحاسبي');
          journalId = j.journalId;
        }
        const totalValue = cfg.docType === 'adjustment' ? E.round2(r.netValue) : r.amount;
        const [u] = await conn.query(
          'UPDATE ' + cfg.table + " SET status='posted', posted_by=?, posted_at=NOW(), gl_journal_id=?, total_cost=?, total_value=?, version=version+1 WHERE id=? AND status='approved' AND version=?",
          [actor, journalId, cfg.docType === 'adjustment' ? 0 : r.amount, totalValue, id, doc.version]
        );
        if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المستند أثناء الترحيل');
        const auditEvent = await _audit(conn, cfg, id, 'post', 'approved', 'posted', actor, req.body && req.body.note, { journalId, movementCount: r.movementIds.length, affectedValue: r.amount });
        return { affectedStock: r.affectedStock, movementIds: r.movementIds, affectedValue: r.amount, journalId, version: Number(doc.version) + 1, auditEvent };
      });

      const body = _envelope({ data: { id }, documentNumber: pre[cfg.numberCol], status: 'posted', version: out.version, affectedStock: out.affectedStock, affectedValue: out.affectedValue, movementIds: out.movementIds, journalId: out.journalId, auditEvent: out.auditEvent }, { id });
      if (idemId) await IDEM.complete(db, idemId, 200, body);
      return res.status(200).json(body);
    } catch (e) {
      if (idemId) await IDEM.abort(db, idemId).catch(() => {});
      _catch(res, e);
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// REVERSE — compensating movements + reversing journal, using the FROZEN cost.
// ════════════════════════════════════════════════════════════════════════════
async function _reverseDoc(conn, cfg, doc, lines, actor) {
  const warehouse = await _loadWarehouse(doc.warehouse_id);
  const affectedStock = [];
  const movementIds = [];
  let amount = 0, posValue = 0, negValue = 0, netValue = 0;
  for (const ln of lines) {
    const frozen = Number(ln.posted_unit_cost);
    if (cfg.docType === 'receipt') {
      const qty = Number(ln.qty);
      const mv = await E.applyStockMovement(conn, doc.warehouse_id, ln.item_id, -qty, frozen, 'inv_receipt_reverse', doc.id, actor);
      movementIds.push(await E.recordMovement(conn, { warehouseId: doc.warehouse_id, itemId: ln.item_id, itemName: ln.item_name, type: 'out', qty, reason: 'عكس استلام', username: actor, notes: doc[cfg.numberCol], referenceType: cfg.refType + '_reverse', referenceId: doc.id }));
      affectedStock.push({ warehouseId: doc.warehouse_id, itemId: ln.item_id, delta: -qty, newQty: mv.newQty });
      amount += qty * frozen;
    } else if (cfg.docType === 'issue') {
      const qty = Number(ln.qty);
      const mv = await E.applyStockMovement(conn, doc.warehouse_id, ln.item_id, qty, frozen, 'inv_issue_reverse', doc.id, actor);
      movementIds.push(await E.recordMovement(conn, { warehouseId: doc.warehouse_id, itemId: ln.item_id, itemName: ln.item_name, type: 'in', qty, reason: 'عكس صرف', username: actor, notes: doc[cfg.numberCol], referenceType: cfg.refType + '_reverse', referenceId: doc.id }));
      affectedStock.push({ warehouseId: doc.warehouse_id, itemId: ln.item_id, delta: qty, newQty: mv.newQty });
      amount += qty * frozen;
    } else { // adjustment — undo the original delta
      const delta = Number(ln.delta);
      if (Math.abs(delta) < 1e-9) continue;
      const mv = await E.applyStockMovement(conn, doc.warehouse_id, ln.item_id, -delta, frozen, 'inv_adjustment_reverse', doc.id, actor);
      movementIds.push(await E.recordMovement(conn, { warehouseId: doc.warehouse_id, itemId: ln.item_id, itemName: ln.item_name, type: -delta > 0 ? 'in' : 'out', qty: Math.abs(delta), reason: 'عكس تعديل', username: actor, notes: doc[cfg.numberCol], referenceType: cfg.refType + '_reverse', referenceId: doc.id }));
      affectedStock.push({ warehouseId: doc.warehouse_id, itemId: ln.item_id, delta: -delta, newQty: mv.newQty });
      const dval = E.round2(Math.abs(delta) * frozen);
      if (delta > 0) posValue += dval; else negValue += dval; // original direction
      netValue += delta * frozen;
    }
    try { await recomputeInvItemStock(conn, ln.item_id); } catch (_) {}
  }
  // Build the ORIGINAL forward spec from frozen costs, then swap it for the reverse.
  let forward = null;
  if (cfg.docType === 'receipt') forward = E.glReceipt({ amount: E.round2(amount), warehouse, warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id, costCenterId: doc.cost_center_id, journalDate: _today(), postedBy: actor, referenceId: doc.id, description: doc[cfg.numberCol] });
  else if (cfg.docType === 'issue') forward = E.glIssue({ amount: E.round2(amount), warehouse, warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id, costCenterId: doc.cost_center_id, expenseCode: doc.expense_account_code || null, journalDate: _today(), postedBy: actor, referenceId: doc.id, description: doc[cfg.numberCol] });
  else if (E.round2(posValue) > 0 || E.round2(negValue) > 0) forward = E.glAdjustmentNet({ posValue: E.round2(posValue), negValue: E.round2(negValue), warehouse, warehouseId: doc.warehouse_id, brandId: doc.brand_id, branchId: doc.branch_id, costCenterId: doc.cost_center_id, expenseCode: E.adjustmentExpenseCode(doc.reason), journalDate: _today(), postedBy: actor, referenceId: doc.id, description: doc[cfg.numberCol] });
  const spec = forward ? E.reverseSpec(forward, { postedBy: actor, journalDate: _today(), description: 'عكس ' + doc[cfg.numberCol] }) : null;
  const value = cfg.docType === 'adjustment' ? E.round2(netValue) : E.round2(amount);
  return { affectedStock, movementIds, amount: E.round2(amount), value, spec };
}

function _makeReverse(cfg) {
  return async (req, res) => {
    let idemId = null;
    try {
      const actor = _actor(req);
      const id = req.params.id;
      const expected = _expectedVersion(req);
      const reason = String((req.body && (req.body.reason || req.body.note)) || '').trim();
      if (!reason) return _fail(res, 'VALIDATION_ERROR', 'سبب العكس إلزامي');
      const pre = await _loadDoc(cfg, id);
      if (!pre) { const e = new Error('المستند غير موجود'); e.status = 404; throw e; }
      if (req.guardWh && !req.guardWh(res, pre.warehouse_id)) return;
      E.assertCanReverse(pre.status);

      const key = IDEM.readKey(req);
      const idem = await IDEM.begin(db, 'inv:' + cfg.docType + ':reverse', id, key, actor, req.body || {});
      if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
      if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب عكس مكرر');
      if (idem.mode === 'proceed') idemId = idem.idemId;

      const out = await db.withTransaction(async (conn) => {
        const doc = await _loadDoc(cfg, id, conn); // FOR UPDATE
        if (!doc || doc.status !== 'posted') throw _err('VERSION_CONFLICT', 'تغيّرت حالة المستند (عكس مكرر؟) — أعد التحميل');
        if (expected != null && Number(doc.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار المستند — أعد التحميل');
        const lines = await _loadLines(cfg, id, conn);
        const r = await _reverseDoc(conn, cfg, doc, lines, actor);
        let journalId = null;
        if (r.spec) {
          const j = await gl.postJournal(conn, r.spec);
          if (!j || !j.success) throw _err('GL_POSTING_FAILED', (j && j.error) || 'فشل ترحيل قيد العكس');
          journalId = j.journalId;
        }
        const [u] = await conn.query(
          'UPDATE ' + cfg.table + " SET status='reversed', reversed_by=?, reversed_at=NOW(), reverse_reason=?, reverse_gl_journal_id=?, version=version+1 WHERE id=? AND status='posted' AND version=?",
          [actor, reason.slice(0, 500), journalId, id, doc.version]
        );
        if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المستند أثناء العكس');
        const auditEvent = await _audit(conn, cfg, id, 'reverse', 'posted', 'reversed', actor, reason, { journalId, movementCount: r.movementIds.length });
        return { affectedStock: r.affectedStock, movementIds: r.movementIds, affectedValue: r.value, journalId, version: Number(doc.version) + 1, auditEvent };
      });

      const body = _envelope({ data: { id }, documentNumber: pre[cfg.numberCol], status: 'reversed', version: out.version, affectedStock: out.affectedStock, affectedValue: out.affectedValue, movementIds: out.movementIds, journalId: out.journalId, auditEvent: out.auditEvent }, { id });
      if (idemId) await IDEM.complete(db, idemId, 200, body);
      return res.status(200).json(body);
    } catch (e) {
      if (idemId) await IDEM.abort(db, idemId).catch(() => {});
      _catch(res, e);
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CANCEL (before posting) + DELETE (draft only)
// ════════════════════════════════════════════════════════════════════════════
function _makeCancel(cfg) {
  return async (req, res) => {
    try {
      const actor = _actor(req);
      const id = req.params.id;
      const expected = _expectedVersion(req);
      const reason = String((req.body && (req.body.reason || req.body.note)) || '').trim();
      const doc = await _loadDoc(cfg, id);
      if (!doc) { const e = new Error('المستند غير موجود'); e.status = 404; throw e; }
      if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
      E.assertCanCancel(doc.status);
      const out = await db.withTransaction(async (conn) => {
        const [r] = await conn.query(
          'UPDATE ' + cfg.table + " SET status='cancelled', cancelled_by=?, cancelled_at=NOW(), cancel_reason=?, version=version+1 WHERE id=? AND status IN ('draft','approved')" + (expected != null ? ' AND version=?' : ''),
          expected != null ? [actor, reason.slice(0, 500), id, expected] : [actor, reason.slice(0, 500), id]
        );
        if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المستند — أعد التحميل');
        const auditEvent = await _audit(conn, cfg, id, 'cancel', doc.status, 'cancelled', actor, reason, null);
        return { auditEvent };
      });
      return _ok(res, { data: { id }, documentNumber: doc[cfg.numberCol], status: 'cancelled', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
    } catch (e) { _catch(res, e); }
  };
}

function _makeDelete(cfg) {
  return async (req, res) => {
    try {
      const actor = _actor(req);
      const id = req.params.id;
      const doc = await _loadDoc(cfg, id);
      if (!doc) { const e = new Error('المستند غير موجود'); e.status = 404; throw e; }
      if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
      E.assertCanDelete(doc.status);
      await db.withTransaction(async (conn) => {
        const [r] = await conn.query('DELETE FROM ' + cfg.table + " WHERE id=? AND status='draft'", [id]);
        if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المستند — لا يمكن الحذف');
        await conn.query('DELETE FROM ' + cfg.items + ' WHERE ' + cfg.fk + '=?', [id]);
        await _audit(conn, cfg, id, 'delete', 'draft', null, actor, 'حذف مسودة', null);
      });
      return res.json({ success: true, code: null, data: { id }, status: 'deleted' });
    } catch (e) { _catch(res, e); }
  };
}

// ── Wire the three doc types ────────────────────────────────────────────────
for (const name of Object.keys(DOCS)) {
  const cfg = DOCS[name];
  const base = '/' + name + 's'; // /receipts /issues /adjustments
  router.get(base, _makeList(cfg));
  router.get(base + '/:id', _makeDetail(cfg));
  router.post(base, BACKOFFICE, _makeCreate(cfg));
  router.patch(base + '/:id', BACKOFFICE, _makePatch(cfg));
  router.post(base + '/:id/approve', MGR, _makeApprove(cfg));
  router.post(base + '/:id/post', BACKOFFICE, _makePost(cfg));
  router.post(base + '/:id/cancel', MGR, _makeCancel(cfg));
  router.post(base + '/:id/reverse', MGR, _makeReverse(cfg));
  router.delete(base + '/:id', MGR, _makeDelete(cfg));
}

module.exports = router;
