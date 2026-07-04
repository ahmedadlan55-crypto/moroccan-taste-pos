/**
 * Professional stocktake & reconciliation — Phase 3C.
 *
 * The single professional stocktake source going forward, at
 *   /api/inventory/v2/stocktakes
 * Lifecycle:
 *   draft → counting → submitted → approved → posted
 *     • request-recount: submitted → counting (reason)
 *     • cancel: draft|counting|submitted|approved → cancelled (before posting)
 *     • delete: draft only
 *
 * It writes NO stock / movements / GL itself. At post it hands each line's
 * variance to the SAFE 3B Adjustment Engine (lib/inventoryTxPosters →
 * lib/inventoryTxEngine), which creates a real posted inv_adjustments document
 * and applies the variance to the CURRENT balance. So there is ONE inventory-
 * writing engine and no double-counting (movements carry reference_type
 * 'inv_adjustment'; the stocktake stores the adjustment_id + gl_journal_id).
 *
 * Reconciliation model (lib/stocktakeReconcile):
 *   snapshot_qty + snapshot_at  — frozen when counting STARTS (item list frozen too)
 *   theoretical_qty = snapshot_qty + Σ movements in (snapshot_at, counted_at]
 *   variance        = counted_qty − theoretical_qty
 * counted_qty NULL = not counted (excluded at post, never zeroed); 0 = counted-empty.
 *
 * Legacy stocktake-pro (/api/stocktake-pro) + legacy /api/inventory/stocktakes
 * and their tables are NOT touched.
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const E = require('../lib/inventoryTxEngine');
const C = require('../lib/inventoryTxContract');
const REC = require('../lib/stocktakeReconcile');
const IDEM = require('../lib/idempotencyStore');
const POST = require('../lib/inventoryTxPosters');
const L = require('../lib/lotLedger');
const IU = require('../lib/itemUnits');
const requireRole = require('../middleware/auth').requireRole;

const MGR = requireRole('admin', 'manager');
const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');

// Maker–Checker: the creator may not approve their own stocktake. On by default;
// STOCKTAKE_MAKER_CHECKER=0/off disables. Admins always bypass.
const MAKER_CHECKER = !/^(0|false|off|no)$/i.test(String(process.env.STOCKTAKE_MAKER_CHECKER || '').trim());
function _envNum(name, dflt) { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : dflt; }
const VAR_QTY_THRESHOLD = _envNum('STOCKTAKE_VARIANCE_QTY_THRESHOLD', 0);     // 0 = no qty gate
const VAR_VALUE_THRESHOLD = _envNum('STOCKTAKE_VARIANCE_VALUE_THRESHOLD', 0); // 0 = no value gate
const EVIDENCE_THRESHOLD = _envNum('STOCKTAKE_EVIDENCE_THRESHOLD', 1000);

const STK_STATUSES = ['draft', 'counting', 'submitted', 'approved', 'posted', 'cancelled'];
const SORT_WL = ['created_at', 'stocktake_date', 'status', 'stocktake_number', 'total_variance_value'];

// ── helpers (mirror routes/inventory-transactions.js) ───────────────────────
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _isAdmin(req) { return String((req.user && req.user.role) || '').toLowerCase() === 'admin' || (req.user && req.user.isDeveloper); }
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
function _fail(res, codeOrErr, message) {
  const code = C.isCanonical(codeOrErr) ? codeOrErr : C.mapError(codeOrErr);
  const msg = message || (codeOrErr && codeOrErr.message) || code;
  return res.status(C.httpFor(code)).json(C.errorBody(code, msg));
}
function _catch(res, e) {
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found' });
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: (e && e.message) || 'error' });
  return _fail(res, e, e && e.message);
}
function _ok(res, parts, legacy, statusCode) {
  const body = Object.assign({}, C.mutationEnvelope(parts), legacy || {});
  res.status(statusCode || 200).json(body);
  return body;
}
async function _audit(conn, docId, action, fromStatus, toStatus, actor, note, payload) {
  const q = conn || db;
  try {
    await q.query(
      'INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
      ['EV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), 'stocktake', docId, action, fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500), payload ? JSON.stringify(payload).slice(0, 8000) : null]
    );
  } catch (_) { /* best-effort */ }
  return { docType: 'stocktake', docId, action, fromStatus: fromStatus || null, toStatus: toStatus || null, actor: actor || '', at: new Date().toISOString() };
}
async function _loadWarehouse(id) {
  const [rows] = await db.query('SELECT id, code, name, type, is_main, brand_id, branch_id FROM warehouses WHERE id=? LIMIT 1', [id]);
  return rows[0] || null;
}
async function _loadDoc(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM inv_stocktakes WHERE id=? LIMIT 1' + (conn ? ' FOR UPDATE' : ''), [id]);
  return rows[0] || null;
}
async function _loadLines(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM inv_stocktake_items WHERE stocktake_id=? ORDER BY item_name, id', [id]);
  return rows;
}

// State guards (stocktake-specific — distinct from the 3B receipt/issue/adjustment machine).
function canEditHeader(s) { return s === 'draft'; }
function canStart(s) { return s === 'draft'; }
function canCount(s) { return s === 'counting'; }
function canSubmit(s) { return s === 'counting'; }
function canRequestRecount(s) { return s === 'submitted'; }
function canApprove(s) { return s === 'submitted'; }
function canPost(s) { return s === 'approved'; }
function canCancel(s) { return ['draft', 'counting', 'submitted', 'approved'].indexOf(s) !== -1; }
function canDelete(s) { return s === 'draft'; }

// Current movement high-water-mark (monotonic). NULL (no movements) → 0.
async function _maxSeq(conn) {
  const [r] = await (conn || db).query('SELECT COALESCE(MAX(seq),0) AS s FROM inventory_movements');
  return Number(r[0] && r[0].s) || 0;
}
// Net stock movement for an item inside the MOVEMENT-SEQUENCE window
// (seq > snapshotSeq AND seq <= countedSeq), signed (in=+, out=−). This replaces
// the fragile 1-second movement_date window — seq is a monotonic AUTO_INCREMENT,
// so movements colliding on the same second (or recorded concurrently) are still
// ordered deterministically.
async function _netMovements(conn, warehouseId, itemId, snapshotSeq, countedSeq) {
  const [r] = await (conn || db).query(
    "SELECT COALESCE(SUM(CASE WHEN type='in' THEN qty ELSE -qty END),0) AS net " +
    'FROM inventory_movements WHERE warehouse_id=? AND item_id=? AND seq > ? AND seq <= ?',
    [warehouseId, itemId, Number(snapshotSeq) || 0, Number(countedSeq) || 0]
  );
  return Number(r[0] && r[0].net) || 0;
}

// Recompute the header roll-ups (counted/variance lines + total variance value).
async function _recountAggregates(conn, id) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS total, ' +
    ' SUM(counted_qty IS NOT NULL) AS counted, ' +
    ' SUM(counted_qty IS NOT NULL AND ABS(variance) > 0.0001) AS varied, ' +
    ' COALESCE(SUM(CASE WHEN counted_qty IS NOT NULL THEN variance_value ELSE 0 END),0) AS varval ' +
    'FROM inv_stocktake_items WHERE stocktake_id=?', [id]
  );
  const row = r[0] || {};
  await conn.query('UPDATE inv_stocktakes SET total_lines=?, counted_lines=?, variance_lines=?, total_variance_value=? WHERE id=?',
    [Number(row.total) || 0, Number(row.counted) || 0, Number(row.varied) || 0, E.round2(row.varval), id]);
  return { total: Number(row.total) || 0, counted: Number(row.counted) || 0, varied: Number(row.varied) || 0, totalVarianceValue: E.round2(row.varval) };
}

// Lines whose |variance value| crosses the evidence threshold need reference_evidence.
async function _largeVarianceWithoutEvidence(conn, doc) {
  if (!EVIDENCE_THRESHOLD) return false;
  if (String(doc.reference_evidence || '').trim()) return false;
  const [r] = await conn.query('SELECT COUNT(*) AS n FROM inv_stocktake_items WHERE stocktake_id=? AND counted_qty IS NOT NULL AND ABS(variance_value) >= ?', [doc.id, EVIDENCE_THRESHOLD]);
  return (Number(r[0] && r[0].n) || 0) > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// READ
// ════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const p = C.parseListQuery(req.query, SORT_WL, STK_STATUSES);
    const sc = req.whScopeClause ? req.whScopeClause('t.warehouse_id') : { sql: '', params: [] };
    const where = ['1=1']; const params = [];
    if (p.status) { where.push('t.status=?'); params.push(p.status); }
    if (p.warehouseId) { where.push('t.warehouse_id=?'); params.push(p.warehouseId); }
    if (p.dateFrom) { where.push('t.stocktake_date >= ?'); params.push(p.dateFrom); }
    if (p.dateTo) { where.push('t.stocktake_date <= ?'); params.push(p.dateTo); }
    if (p.q) { where.push('(t.stocktake_number LIKE ? OR t.reason LIKE ? OR t.notes LIKE ?)'); params.push('%' + p.q + '%', '%' + p.q + '%', '%' + p.q + '%'); }
    const whereSql = ' WHERE ' + where.join(' AND ') + (sc.sql || '');
    const allParams = params.concat(sc.params || []);
    const [rows] = await db.query(
      'SELECT t.*, w.name AS warehouse_name, w.code AS warehouse_code FROM inv_stocktakes t LEFT JOIN warehouses w ON w.id=t.warehouse_id' +
      whereSql + ' ORDER BY t.' + p.sort + ' ' + p.dir + ' LIMIT ? OFFSET ?', allParams.concat([p.pageSize, p.offset])
    );
    const [cnt] = await db.query('SELECT COUNT(*) AS total FROM inv_stocktakes t' + whereSql, allParams);
    const [kpi] = await db.query(
      "SELECT SUM(status='draft') AS draft, SUM(status='counting') AS counting, SUM(status='submitted') AS submitted," +
      " SUM(status='approved') AS approved, SUM(status='posted') AS posted, SUM(status='cancelled') AS cancelled," +
      ' COALESCE(SUM(CASE WHEN status=\'posted\' THEN ABS(total_variance_value) ELSE 0 END),0) AS posted_var_value,' +
      ' COALESCE(SUM(variance_lines),0) AS variance_lines FROM inv_stocktakes t' + whereSql, allParams
    );
    const total = Number(cnt[0].total) || 0; const k = kpi[0] || {};
    res.json({
      data: rows,
      pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) },
      kpis: {
        draft: Number(k.draft) || 0, counting: Number(k.counting) || 0, submitted: Number(k.submitted) || 0,
        approved: Number(k.approved) || 0, posted: Number(k.posted) || 0, cancelled: Number(k.cancelled) || 0,
        varianceLines: Number(k.variance_lines) || 0, postedVarianceValue: Number(k.posted_var_value) || 0,
      },
      filters: { status: p.status, warehouseId: p.warehouseId, dateFrom: p.dateFrom, dateTo: p.dateTo, q: p.q, sort: p.sort, dir: p.dir },
    });
  } catch (e) { _catch(res, e); }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await _loadDoc(req.params.id);
    if (!doc) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    const lines = await _loadLines(doc.id);
    const [events] = await db.query('SELECT * FROM inv_tx_events WHERE doc_type=? AND doc_id=? ORDER BY created_at ASC, id ASC', ['stocktake', doc.id]);
    let movements = [], journals = [];
    if (doc.adjustment_id) {
      const [mv] = await db.query('SELECT * FROM inventory_movements WHERE reference_id=? ORDER BY movement_date ASC, id ASC', [doc.adjustment_id]);
      movements = mv;
    }
    if (doc.gl_journal_id) {
      const [jr] = await db.query('SELECT id, journal_number, journal_date, total_debit, total_credit, reference_type FROM gl_journals WHERE id=?', [doc.gl_journal_id]);
      if (jr.length) {
        const [entries] = await db.query('SELECT journal_id, account_code, account_name, debit, credit FROM gl_entries WHERE journal_id=? ORDER BY id', [doc.gl_journal_id]);
        journals = jr.map((j) => Object.assign({}, j, { entries: entries.filter((en) => en.journal_id === j.id) }));
      }
    }
    // currentSeq lets the counting workspace stamp each count's observedSeq, so an
    // offline count that synced after later movements is flagged for recount.
    const currentSeq = await _maxSeq();
    res.json({ data: doc, lines, timeline: events, movements, journals, currentSeq });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE draft (scope config only; the item list is frozen at /start)
// ════════════════════════════════════════════════════════════════════════════
router.post('/', BACKOFFICE, async (req, res) => {
  let idemId = null;
  try {
    const actor = _actor(req);
    const b = req.body || {};
    const warehouseId = b.warehouseId || b.warehouse_id;
    if (!warehouseId) return _fail(res, 'VALIDATION_ERROR', 'المستودع مطلوب');
    if (req.guardWh && !req.guardWh(res, warehouseId)) return;
    const warehouse = await _loadWarehouse(warehouseId);
    if (!warehouse) return _fail(res, 'VALIDATION_ERROR', 'المستودع غير موجود');
    const scopeType = ['full', 'category', 'items'].indexOf(String(b.scopeType || '')) !== -1 ? String(b.scopeType) : 'full';
    const countMethod = ['full', 'cycle', 'spot'].indexOf(String(b.countMethod || '')) !== -1 ? String(b.countMethod) : 'full';
    if (scopeType === 'category' && !String(b.categoryId || '').trim()) return _fail(res, 'VALIDATION_ERROR', 'الفئة مطلوبة لجرد حسب الفئة');
    const itemIds = Array.isArray(b.itemIds) ? b.itemIds.map((x) => String(x)).filter(Boolean) : [];
    if (scopeType === 'items' && itemIds.length === 0) return _fail(res, 'VALIDATION_ERROR', 'حدّد صنفًا واحدًا على الأقل لجرد أصناف محددة');

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'stk:create', '', key, actor, b);
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب إنشاء مكرر بمحتوى مختلف أو قيد التنفيذ');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const out = await db.withTransaction(async (conn) => {
      const number = await POST.nextDocNumber(conn, 'stocktake', 'STK');
      const id = 'STK-' + crypto.randomBytes(6).toString('hex');
      await conn.query(
        'INSERT INTO inv_stocktakes (id, stocktake_number, warehouse_id, brand_id, branch_id, cost_center_id, stocktake_date, status, scope_type, category_id, include_zero, blind_count, count_method, variance_qty_threshold, variance_value_threshold, evidence_threshold, reason, reference_evidence, notes, created_by, version) ' +
        "VALUES (?,?,?,?,?,?,?, 'draft', ?,?,?,?,?,?,?,?,?,?,?,?, 1)",
        [id, number, warehouse.id, warehouse.brand_id || null, warehouse.branch_id || null, (b.costCenterId || null),
          (b.stocktakeDate || _today()), scopeType, scopeType === 'category' ? String(b.categoryId) : null,
          b.includeZero ? 1 : 0, b.blindCount ? 1 : 0,
          countMethod,
          Number.isFinite(Number(b.varianceQtyThreshold)) ? Number(b.varianceQtyThreshold) : VAR_QTY_THRESHOLD,
          Number.isFinite(Number(b.varianceValueThreshold)) ? Number(b.varianceValueThreshold) : VAR_VALUE_THRESHOLD,
          Number.isFinite(Number(b.evidenceThreshold)) ? Number(b.evidenceThreshold) : EVIDENCE_THRESHOLD,
          String(b.reason || '').slice(0, 200) || null, String(b.referenceEvidence || '').slice(0, 500) || null,
          String(b.notes || '').slice(0, 2000) || null, actor]
      );
      // Stash the chosen item list for scope=items so /start can freeze it.
      if (scopeType === 'items') await _audit(conn, id, 'scope', null, 'draft', actor, 'أصناف محددة', { itemIds });
      const auditEvent = await _audit(conn, id, 'create', null, 'draft', actor, 'إنشاء محضر جرد', { scopeType });
      return { id, number, auditEvent };
    });

    const body = Object.assign({}, C.mutationEnvelope({ data: { id: out.id }, documentNumber: out.number, status: 'draft', version: 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }), { id: out.id, number: out.number });
    if (idemId) await IDEM.complete(db, idemId, 201, body);
    return res.status(201).json(body);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH draft (scope / settings; version-guarded; draft only)
// ════════════════════════════════════════════════════════════════════════════
router.patch('/:id', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id; const b = req.body || {};
    const expected = _expectedVersion(req);
    if (expected == null) return _fail(res, 'VALIDATION_ERROR', 'expectedVersion مطلوب للتعديل');
    const doc = await _loadDoc(id);
    if (!doc) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    if (!canEditHeader(doc.status)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن تعديل محضر حالته "' + doc.status + '" — المسودة فقط');
    const out = await db.withTransaction(async (conn) => {
      const sets = ['reason=?', 'notes=?', 'include_zero=?', 'blind_count=?', 'reference_evidence=?', 'version=version+1'];
      const vals = [
        b.reason != null ? String(b.reason).slice(0, 200) : doc.reason,
        b.notes != null ? String(b.notes).slice(0, 2000) : doc.notes,
        b.includeZero != null ? (b.includeZero ? 1 : 0) : doc.include_zero,
        b.blindCount != null ? (b.blindCount ? 1 : 0) : doc.blind_count,
        b.referenceEvidence != null ? String(b.referenceEvidence).slice(0, 500) : doc.reference_evidence,
      ];
      const [r] = await conn.query('UPDATE inv_stocktakes SET ' + sets.join(', ') + " WHERE id=? AND status='draft' AND version=?", vals.concat([id, expected]));
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت المسودة منذ آخر تحميل — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'edit', 'draft', 'draft', actor, 'تعديل إعدادات الجرد', null);
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: doc.stocktake_number, status: 'draft', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// START — snapshot + freeze the item list (draft → counting)
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/start', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id;
    const expected = _expectedVersion(req);
    const pre = await _loadDoc(id);
    if (!pre) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, pre.warehouse_id)) return;
    if (!canStart(pre.status)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن بدء العد لمحضر حالته "' + pre.status + '"');

    const out = await db.withTransaction(async (conn) => {
      const doc = await _loadDoc(id, conn); // FOR UPDATE (also fixes the REPEATABLE-READ snapshot)
      if (!doc || doc.status !== 'draft') throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر — أعد التحميل');
      if (expected != null && Number(doc.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار المحضر — أعد التحميل');

      // The snapshot high-water-mark: every movement with seq <= snapshotSeq is
      // already reflected in the snapshot_qty we freeze below (consistent under the
      // txn's snapshot, fixed at the _loadDoc read above); movements with a higher
      // seq are counted later via the (snapshotSeq, countedSeq] window.
      const snapshotSeq = await _maxSeq(conn);

      // Resolve the frozen candidate list per scope.
      let itemIds = null;
      if (doc.scope_type === 'items') {
        const [ev] = await conn.query("SELECT payload_json FROM inv_tx_events WHERE doc_type='stocktake' AND doc_id=? AND action='scope' ORDER BY id DESC LIMIT 1", [id]);
        try { itemIds = ev.length ? (JSON.parse(ev[0].payload_json).itemIds || []) : []; } catch (_) { itemIds = []; }
        if (!itemIds.length) throw _err('VALIDATION_ERROR', 'لا توجد أصناف محددة لهذا الجرد');
      }
      const where = ['it.active=1'];
      const params = [doc.warehouse_id];
      if (doc.scope_type === 'category') { where.push('it.category=?'); params.push(doc.category_id); }
      if (doc.scope_type === 'items') { where.push('it.id IN (?)'); params.push(itemIds); }
      if (!(doc.include_zero === 1 || doc.include_zero === true)) where.push('COALESCE(ws.qty,0) <> 0');
      const [cands] = await conn.query(
        'SELECT it.id, it.name, it.unit, it.category, COALESCE(ws.qty,0) AS qty, COALESCE(ws.avg_cost, it.cost, 0) AS cost ' +
        'FROM inv_items it LEFT JOIN warehouse_stock ws ON ws.item_id=it.id AND ws.warehouse_id=? ' +
        'WHERE ' + where.join(' AND ') + ' ORDER BY it.name', params
      );
      // Pessimistically lock the scoped warehouse_stock rows so an in-flight
      // movement on a counted item cannot commit between freezing snapshot_qty and
      // capturing snapshot_seq — it blocks at its own applyStockMovement FOR UPDATE
      // until start commits, then lands with seq > snapshotSeq.
      if (cands.length) {
        await conn.query('SELECT id FROM warehouse_stock WHERE warehouse_id=? AND item_id IN (?) FOR UPDATE', [doc.warehouse_id, cands.map((c) => c.id)]);
      }
      // Freeze the list (snapshot qty + cost), counted_qty NULL = not counted yet.
      for (const c of cands) {
        const lid = 'STI-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        await conn.query(
          'INSERT INTO inv_stocktake_items (id, stocktake_id, item_id, item_name, unit, category_id, snapshot_qty, counted_qty, theoretical_qty, unit_cost) VALUES (?,?,?,?,?,?,?,NULL,?,?)',
          [lid, id, c.id, c.name || '', c.unit || '', c.category || null, REC.round3(c.qty), REC.round3(c.qty), E.round4(c.cost)]
        );
      }
      const [u] = await conn.query("UPDATE inv_stocktakes SET status='counting', snapshot_at=NOW(), snapshot_seq=?, total_lines=?, version=version+1 WHERE id=? AND status='draft' AND version=?", [snapshotSeq, cands.length, id, doc.version]);
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر أثناء بدء العد');
      const auditEvent = await _audit(conn, id, 'start', 'draft', 'counting', actor, 'بدء العد — تجميد ' + cands.length + ' صنفًا', { lines: cands.length });
      return { lines: cands.length, version: Number(doc.version) + 1, auditEvent };
    });
    return _ok(res, { data: { id, lines: out.lines }, documentNumber: pre.stocktake_number, status: 'counting', version: out.version, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id, lines: out.lines });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// PUT counts — autosave target (counting only). Recomputes theoretical/variance.
// ════════════════════════════════════════════════════════════════════════════
router.put('/:id/counts', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id;
    const counts = Array.isArray(req.body && req.body.counts) ? req.body.counts : null;
    if (!counts) return _fail(res, 'VALIDATION_ERROR', 'counts مطلوبة (مصفوفة)');
    const doc = await _loadDoc(id);
    if (!doc) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    if (!canCount(doc.status)) throw _err('VERSION_CONFLICT', 'لا يمكن حفظ العد — حالة المحضر "' + doc.status + '" (ربما قُدّم أو أُعيد) — أعد التحميل');

    const out = await db.withTransaction(async (conn) => {
      // The window upper bound for THIS batch — the current movement high-water-mark.
      const countedSeq = await _maxSeq(conn);
      const conflicts = [];
      let applied = 0;
      for (const c of counts) {
        const lineId = c.lineId || c.id;
        const itemId = c.itemId || c.item_id;
        const [lr] = await conn.query('SELECT * FROM inv_stocktake_items WHERE stocktake_id=? AND ' + (lineId ? 'id=?' : 'item_id=?') + ' LIMIT 1 FOR UPDATE', [id, lineId || itemId]);
        if (!lr.length) continue;
        const line = lr[0];
        // Phase U — the count may be entered in a major unit or as a composite
        // (major+minor). Resolve → base (frozen factor). NULL semantics preserved:
        // no countedQty AND no major/minor pair ⇒ uncounted (NULL), NOT counted-zero.
        const hasComposite = c.majorQty != null || c.minorQty != null;
        const hasEntered = !(c.countedQty === null || c.countedQty === undefined || c.countedQty === '');
        let counted = null, uom = null;
        if (hasEntered || hasComposite) {
          uom = await IU.resolveLineBase(conn, line.item_id, {
            enteredUnitId: c.enteredUnitId, enteredUnitCode: c.enteredUnitCode,
            enteredQty: c.countedQty, majorQty: c.majorQty, minorQty: c.minorQty, baseQty: c.baseQty,
          }, 'stocktake');
          counted = uom.baseQty;
        }
        if (counted === null) {
          await conn.query('UPDATE inv_stocktake_items SET counted_qty=NULL, counted_at=NULL, counted_seq=0, variance=0, variance_value=0, variance_pct=0, is_flagged=0, entered_qty=NULL, entered_unit_id=NULL, entered_unit_code=NULL, conversion_factor_snapshot=NULL, base_qty=NULL, notes=?, reason_code=?, counted_by=? WHERE id=?',
            [c.notes != null ? String(c.notes).slice(0, 400) : line.notes, c.reasonCode != null ? String(c.reasonCode).slice(0, 40) : line.reason_code, actor, line.id]);
          applied++;
          continue;
        }
        if (counted < 0) throw _err('VALIDATION_ERROR', 'الكمية المجرودة لا يمكن أن تكون سالبة (' + (line.item_name || itemId) + ')');
        // Offline-stale guard: when a count was buffered OFFLINE the device sends the
        // movement high-water-mark it saw at count time (observedSeq). If ANY movement
        // landed for this item between then and now, the physical count predates those
        // movements → it is NOT applied silently; it's returned for recount.
        const observedSeq = (c.observedSeq != null && Number.isFinite(Number(c.observedSeq))) ? Number(c.observedSeq) : null;
        if (observedSeq != null && observedSeq < countedSeq) {
          const [mv] = await conn.query('SELECT 1 FROM inventory_movements WHERE warehouse_id=? AND item_id=? AND seq > ? AND seq <= ? LIMIT 1', [doc.warehouse_id, line.item_id, observedSeq, countedSeq]);
          if (mv.length) { conflicts.push({ lineId: line.id, itemId: line.item_id, itemName: line.item_name, code: 'STALE_COUNT', message: 'حدثت حركات على الصنف منذ العد دون اتصال — يلزم إعادة عدّ هذا السطر' }); continue; }
        }
        const net = await _netMovements(conn, doc.warehouse_id, line.item_id, doc.snapshot_seq, countedSeq);
        const r = REC.reconcileLine({ snapshotQty: line.snapshot_qty, netMovements: net, countedQty: counted, unitCost: line.unit_cost, thresholdPct: 10 });
        await conn.query(
          'UPDATE inv_stocktake_items SET counted_qty=?, counted_at=NOW(), counted_seq=?, net_movements=?, theoretical_qty=?, variance=?, variance_value=?, variance_pct=?, is_flagged=?, entered_qty=?, entered_unit_id=?, entered_unit_code=?, conversion_factor_snapshot=?, base_qty=?, notes=?, reason_code=?, counted_by=? WHERE id=?',
          [REC.round3(counted), countedSeq, REC.round3(net), r.theoreticalQty, r.variance, r.varianceValue, r.variancePct, r.isFlagged ? 1 : 0,
            uom.enteredQty, uom.enteredUnitId, uom.enteredUnitCode, uom.conversionFactorSnapshot, uom.baseQty,
            c.notes != null ? String(c.notes).slice(0, 400) : line.notes, c.reasonCode != null ? String(c.reasonCode).slice(0, 40) : line.reason_code, actor, line.id]
        );
        // Phase 4B — tracked item: capture the per-lot counts (Σ must equal the
        // line count). An entry with no lotId/lotNumber is an "unknown lot" found.
        const lmode = await L.getTrackingMode(conn, line.item_id);
        if (L.isTracked(lmode) && Array.isArray(c.lots)) {
          let sum = 0;
          for (const lt of c.lots) { const q = Number(lt.qty); if (!Number.isFinite(q) || q < 0) throw _err('VALIDATION_ERROR', 'كمية دفعة غير صالحة في عدّ الصنف ' + (line.item_name || itemId)); sum += q; }
          if (REC.round3(sum) !== REC.round3(counted)) throw _err('VALIDATION_ERROR', 'مجموع كميات الدفعات (' + REC.round3(sum) + ') لا يساوي الكمية المجرودة (' + REC.round3(counted) + ') للصنف ' + (line.item_name || itemId));
          await conn.query('DELETE FROM inv_stocktake_lot_items WHERE stocktake_id=? AND item_id=?', [id, line.item_id]);
          for (const lt of c.lots) {
            await conn.query('INSERT INTO inv_stocktake_lot_items (id, stocktake_id, item_id, lot_id, lot_number, expiry_date, counted_qty, counted_seq) VALUES (?,?,?,?,?,?,?,?)',
              ['STLI-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), id, line.item_id, lt.lotId || null, lt.lotNumber || null, lt.expiryDate || null, REC.round3(Number(lt.qty)), countedSeq]);
          }
        }
        applied++;
      }
      const aggregates = await _recountAggregates(conn, id);
      return { aggregates, conflicts, applied };
    });
    return res.json({ success: true, data: { id }, status: 'counting', aggregates: out.aggregates, conflicts: out.conflicts, applied: out.applied });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// SUBMIT (counting → submitted) — evidence gate for large variances
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/submit', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id;
    const expected = _expectedVersion(req);
    const doc = await _loadDoc(id);
    if (!doc) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    if (!canSubmit(doc.status)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن تقديم محضر حالته "' + doc.status + '"');
    const out = await db.withTransaction(async (conn) => {
      await _recountAggregates(conn, id);
      const fresh = await _loadDoc(id, conn);
      if (await _largeVarianceWithoutEvidence(conn, fresh)) throw _err('VALIDATION_ERROR', 'يوجد فرق كبير يتطلب سببًا/دليلًا (reference_evidence) قبل التقديم');
      const [r] = await conn.query("UPDATE inv_stocktakes SET status='submitted', submitted_by=?, submitted_at=NOW(), version=version+1 WHERE id=? AND status='counting'" + (expected != null ? ' AND version=?' : ''), expected != null ? [actor, id, expected] : [actor, id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'submit', 'counting', 'submitted', actor, req.body && req.body.note, null);
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: doc.stocktake_number, status: 'submitted', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// REQUEST RECOUNT (submitted → counting) — reason required
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/request-recount', MGR, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id;
    const expected = _expectedVersion(req);
    const reason = String((req.body && (req.body.reason || req.body.note)) || '').trim();
    if (!reason) return _fail(res, 'VALIDATION_ERROR', 'سبب إعادة العد إلزامي');
    const doc = await _loadDoc(id);
    if (!doc) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    if (!canRequestRecount(doc.status)) throw _err('INVALID_STATE_TRANSITION', 'إعادة العد متاحة فقط لمحضر مُقدَّم (submitted)');
    const out = await db.withTransaction(async (conn) => {
      const [r] = await conn.query("UPDATE inv_stocktakes SET status='counting', recount_by=?, recount_at=NOW(), recount_reason=?, version=version+1 WHERE id=? AND status='submitted'" + (expected != null ? ' AND version=?' : ''), expected != null ? [actor, reason.slice(0, 500), id, expected] : [actor, reason.slice(0, 500), id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'request-recount', 'submitted', 'counting', actor, reason, null);
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: doc.stocktake_number, status: 'counting', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// APPROVE (submitted → approved) — Maker–Checker + evidence gate
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/approve', MGR, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id;
    const expected = _expectedVersion(req);
    const doc = await _loadDoc(id);
    if (!doc) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    if (!canApprove(doc.status)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن اعتماد محضر حالته "' + doc.status + '"');
    if (MAKER_CHECKER && !_isAdmin(req) && doc.created_by && doc.created_by === actor) {
      return _fail(res, 'PERMISSION_DENIED', 'لا يمكن لمُنشئ الجرد اعتماده بنفسه (Maker–Checker)');
    }
    const out = await db.withTransaction(async (conn) => {
      const fresh = await _loadDoc(id, conn);
      if (await _largeVarianceWithoutEvidence(conn, fresh)) throw _err('VALIDATION_ERROR', 'فرق كبير يتطلب دليلًا (reference_evidence) قبل الاعتماد');
      const [r] = await conn.query("UPDATE inv_stocktakes SET status='approved', approved_by=?, approved_at=NOW(), version=version+1 WHERE id=? AND status='submitted'" + (expected != null ? ' AND version=?' : ''), expected != null ? [actor, id, expected] : [actor, id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'approve', 'submitted', 'approved', actor, req.body && req.body.note, null);
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: doc.stocktake_number, status: 'approved', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// POST (approved → posted) — the bridge: variance → Adjustment Engine. Atomic.
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/post', BACKOFFICE, async (req, res) => {
  let idemId = null;
  try {
    const actor = _actor(req); const id = req.params.id;
    const expected = _expectedVersion(req);
    const pre = await _loadDoc(id);
    if (!pre) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, pre.warehouse_id)) return;
    if (!canPost(pre.status)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن ترحيل محضر حالته "' + pre.status + '" — يجب اعتماده أولًا');

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'stk:post', id, key, actor, req.body || {});
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب ترحيل مكرر');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const out = await db.withTransaction(async (conn) => {
      const doc = await _loadDoc(id, conn); // FOR UPDATE
      if (!doc) throw _err('VALIDATION_ERROR', 'المحضر غير موجود');
      if (doc.status !== 'approved') throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر — أعد التحميل');
      if (expected != null && Number(doc.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر إصدار المحضر — أعد التحميل');
      const warehouse = await _loadWarehouse(doc.warehouse_id);
      const lines = await _loadLines(id, conn);

      // Build adjustment lines: ONLY counted lines with a non-zero variance. The
      // variance was fixed at count time; here we lock the CURRENT balance and let
      // the Adjustment Engine apply that variance on top of post-count movements.
      const adjLines = [];
      for (const ln of lines) {
        if (ln.counted_qty === null || ln.counted_qty === undefined) continue; // uncounted → never zeroed
        const variance = Number(ln.variance);
        if (!Number.isFinite(variance) || Math.abs(variance) < 1e-9) continue;
        const cur = await E.readStock(conn, doc.warehouse_id, ln.item_id, true); // FOR UPDATE lock
        adjLines.push({ itemId: ln.item_id, itemName: ln.item_name, unit: ln.unit, currentQty: cur.qty, variance, notes: ln.reason_code || '' });
      }

      let adj = { adjustmentId: null, adjustmentNumber: null, journalId: null, affectedStock: [], movementIds: [], netValue: 0 };
      if (adjLines.length) {
        adj = await POST.createAndPostAdjustment(conn, {
          warehouse, reason: 'تسوية جرد ' + doc.stocktake_number, referenceEvidence: doc.reference_evidence,
          notes: 'محضر جرد ' + doc.stocktake_number, costCenterId: doc.cost_center_id, dateStr: _dateStr(doc.stocktake_date), lines: adjLines,
        }, actor);
      }

      // Phase 4B — reconcile lot balances for every COUNTED tracked item (runs even
      // when the item-level variance was zero, since the lot composition may differ).
      // warehouse_stock is now the counted total; set each lot to its counted value.
      for (const ln of lines) {
        if (ln.counted_qty === null || ln.counted_qty === undefined) continue;
        const lmode = await L.getTrackingMode(conn, ln.item_id);
        if (!L.isTracked(lmode)) continue;
        const [lotRows] = await conn.query("SELECT lot_id, lot_number, DATE_FORMAT(expiry_date,'%Y-%m-%d') AS expiry_date, counted_qty FROM inv_stocktake_lot_items WHERE stocktake_id=? AND item_id=?", [id, ln.item_id]);
        if (!lotRows.length) throw _err('LOT_REQUIRED', 'الصنف المُتتبع "' + ln.item_name + '" يجب عدّه حسب الدفعة قبل ترحيل الجرد');
        const countedLots = lotRows.map((r) => ({ lotId: r.lot_id || null, lotNumber: r.lot_number || null, expiryDate: r.expiry_date || null, qty: Number(r.counted_qty) }));
        await L.reconcileStocktakeLots(conn, { warehouseId: doc.warehouse_id, itemId: ln.item_id, countedLots, referenceId: id, actor, occurredAt: new Date() });
      }

      const [u] = await conn.query(
        "UPDATE inv_stocktakes SET status='posted', posted_by=?, posted_at=NOW(), adjustment_id=?, adjustment_number=?, gl_journal_id=?, total_variance_value=?, version=version+1 WHERE id=? AND status='approved' AND version=?",
        [actor, adj.adjustmentId, adj.adjustmentNumber, adj.journalId, E.round2(adj.netValue), id, doc.version]
      );
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر أثناء الترحيل');
      const auditEvent = await _audit(conn, id, 'post', 'approved', 'posted', actor, req.body && req.body.note, { adjustmentId: adj.adjustmentId, journalId: adj.journalId, varianceLines: adjLines.length });
      return { adj, version: Number(doc.version) + 1, auditEvent };
    });

    const body = Object.assign({}, C.mutationEnvelope({
      data: { id, adjustmentId: out.adj.adjustmentId, adjustmentNumber: out.adj.adjustmentNumber }, documentNumber: pre.stocktake_number, status: 'posted', version: out.version,
      affectedStock: out.adj.affectedStock, affectedValue: out.adj.netValue, movementIds: out.adj.movementIds, journalId: out.adj.journalId, auditEvent: out.auditEvent,
    }), { id, adjustmentId: out.adj.adjustmentId });
    if (idemId) await IDEM.complete(db, idemId, 200, body);
    return res.status(200).json(body);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CANCEL (before posting) + DELETE (draft only)
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/cancel', MGR, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id;
    const expected = _expectedVersion(req);
    const reason = String((req.body && (req.body.reason || req.body.note)) || '').trim();
    const doc = await _loadDoc(id);
    if (!doc) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    if (!canCancel(doc.status)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن إلغاء محضر حالته "' + doc.status + '" — الإلغاء قبل الترحيل فقط');
    const out = await db.withTransaction(async (conn) => {
      const [r] = await conn.query("UPDATE inv_stocktakes SET status='cancelled', cancelled_by=?, cancelled_at=NOW(), cancel_reason=?, version=version+1 WHERE id=? AND status IN ('draft','counting','submitted','approved')" + (expected != null ? ' AND version=?' : ''), expected != null ? [actor, reason.slice(0, 500), id, expected] : [actor, reason.slice(0, 500), id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'cancel', doc.status, 'cancelled', actor, reason, null);
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: doc.stocktake_number, status: 'cancelled', version: Number(doc.version) + 1, affectedStock: [], affectedValue: 0, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

router.delete('/:id', MGR, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id;
    const doc = await _loadDoc(id);
    if (!doc) { const e = new Error('محضر الجرد غير موجود'); e.status = 404; throw e; }
    if (req.guardWh && !req.guardWh(res, doc.warehouse_id)) return;
    if (!canDelete(doc.status)) throw _err('INVALID_STATE_TRANSITION', 'لا يمكن حذف محضر حالته "' + doc.status + '" — المسودة فقط');
    await db.withTransaction(async (conn) => {
      const [r] = await conn.query("DELETE FROM inv_stocktakes WHERE id=? AND status='draft'", [id]);
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة المحضر — لا يمكن الحذف');
      await conn.query('DELETE FROM inv_stocktake_items WHERE stocktake_id=?', [id]);
      await _audit(conn, id, 'delete', 'draft', null, actor, 'حذف مسودة جرد', null);
    });
    return res.json({ success: true, code: null, data: { id }, status: 'deleted' });
  } catch (e) { _catch(res, e); }
});

module.exports = router;
