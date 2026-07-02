/**
 * Warehouse Operations — Phase 1/2/3
 * Stock Issues (main → branch), Production Orders, FIFO/WAC costing, Batch/Expiry.
 *
 * All mutations post to GL automatically with period-lock checks.
 */
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const gl = require('../lib/glPosting');
// v7.1 — keep the denormalized inv_items.stock rollup in sync after any
// per-warehouse mutation (lot disposal etc.), same discipline as sales/purchases.
const { recomputeInvItemStock } = require('../lib/stockRecompute');
// v7.4 — RBAC. MGR = managerial (approve / cancel / reverse / dispose);
// BACKOFFICE = any authenticated back-office role EXCEPT cashier (the
// widely-distributed front-line credential and the documented fraud vector).
const requireRole = require('../middleware/auth').requireRole;
const MGR = requireRole('admin', 'manager');
const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');
// Phase 0 — canonical transfer lifecycle + cumulative-receipt math (shared
// with tests/warehouseTransfer.test.js so the route and the contract test
// can never drift apart).
const TR = require('../lib/warehouseTransfer');
// Phase 3A — unified API contract (canonical error codes + mutation envelope).
const TC = require('../lib/transferContract');
// Phase 4B — lot ledger (FEFO allocation + invariant) for tracked items.
const L = require('../lib/lotLedger');
// Read the auto-increment seq of a just-recorded inventory_movements row.
async function _seqOf(conn, movId) { const [r] = await conn.query('SELECT seq FROM inventory_movements WHERE id=? LIMIT 1', [movId]); return r.length ? Number(r[0].seq) : null; }

// ─── Helpers ──────────────────────────────────────────────────────────

// Phase 0 §5 — the actor of every state change is the AUTHENTICATED user from
// the JWT (req.user), never a spoofable name sent in the request body. The
// global /api gate in server.js sets req.user for every /api/erp route, so
// this is always populated for an authenticated request.
function _actor(req) {
  return (req.user && (req.user.username || req.user.name)) || '';
}

function _ymd(d) {
  d = d || new Date();
  return d.getFullYear().toString() +
    String(d.getMonth()+1).padStart(2,'0') +
    String(d.getDate()).padStart(2,'0');
}

async function _nextSerial(counterTable, ymd) {
  await db.query(
    `INSERT INTO ${counterTable} (ymd, last_serial) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE last_serial = last_serial + 1`,
    [ymd]);
  const [rows] = await db.query(
    `SELECT last_serial FROM ${counterTable} WHERE ymd = ?`, [ymd]);
  return rows[0] ? rows[0].last_serial : 1;
}

// Compute WAC cost when adding qty at cost to existing stock
function _newWAC(oldQty, oldCost, addQty, addCost) {
  const totalQty = Number(oldQty) + Number(addQty);
  if (totalQty <= 0) return Number(addCost) || 0;
  const oldVal = Number(oldQty) * Number(oldCost);
  const addVal = Number(addQty) * Number(addCost);
  return Number(((oldVal + addVal) / totalQty).toFixed(4));
}

// Get effective unit cost for an item in a warehouse (WAC → fallback inv_items.cost)
async function _getEffectiveCost(itemId, warehouseId) {
  if (warehouseId) {
    const [rows] = await db.query(
      'SELECT avg_cost, qty FROM warehouse_stock WHERE item_id=? AND warehouse_id=? LIMIT 1',
      [itemId, warehouseId]);
    if (rows.length && Number(rows[0].avg_cost) > 0) return Number(rows[0].avg_cost);
  }
  const [fallback] = await db.query('SELECT cost FROM inv_items WHERE id = ? LIMIT 1', [itemId]);
  return fallback.length ? Number(fallback[0].cost || 0) : 0;
}

// Record cost history row
// v7.4 — accepts an optional `conn` so it can run INSIDE a caller's
// transaction (production release/complete). Falls back to the pool for
// every legacy caller that passes no connection.
async function _recordCostHistory(itemId, warehouseId, oldCost, newCost, oldQty, newQty, triggerType, refId, changedBy, conn) {
  const q = conn || db;
  try {
    await q.query(
      `INSERT INTO item_cost_history
       (id, item_id, warehouse_id, method, old_cost, new_cost, old_qty, new_qty, trigger_type, reference_id, changed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['CH-' + Date.now() + '-' + Math.random().toString(36).slice(2,7),
       itemId, warehouseId || null, 'WAC', oldCost || 0, newCost || 0,
       oldQty || 0, newQty || 0, triggerType, refId || null, changedBy || '']);
  } catch(e) { /* best effort */ }
}

// Update warehouse_stock with new qty + recompute WAC if adding stock
// v7.4 — optional trailing `conn` runs every write on the caller's
// transaction connection so the stock move + ledger + GL are atomic.
async function _applyStockMovement(warehouseId, itemId, qtyDelta, unitCost, triggerType, refId, changedBy, conn) {
  const q = conn || db;
  // v7.5 — FOR UPDATE: every caller now runs inside a transaction, so the
  // WAC read-compute-write is serialized per row (two concurrent movements
  // can no longer both read a stale avg_cost and corrupt the valuation).
  // On a bare pool connection (autocommit) the lock is statement-scoped —
  // harmless.
  const [rows] = await q.query(
    'SELECT qty, avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1 FOR UPDATE',
    [warehouseId, itemId]);
  const oldQty = rows.length ? Number(rows[0].qty) : 0;
  const oldCost = rows.length ? Number(rows[0].avg_cost) : 0;
  let newCost = oldCost;
  // WAC only recomputed when adding inventory (positive qtyDelta)
  if (Number(qtyDelta) > 0 && Number(unitCost) > 0) {
    newCost = _newWAC(oldQty, oldCost || unitCost, qtyDelta, unitCost);
  }
  // v7.1 — ATOMIC qty delta via upsert on UNIQUE(warehouse_id,item_id), instead
  // of writing an absolute newQty computed from a (possibly stale) prior read.
  // Two concurrent movements on the same row can no longer lose a quantity
  // update — the qty is always exact. avg_cost/last_cost are still set from the
  // WAC read (cost is an approximation; qty is the figure that must never drift).
  // Mirrors the deductWarehouseStock pattern. Allows negative balances.
  const _wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  await q.query(
    `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost, last_updated)
     VALUES (?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE qty = qty + ?, avg_cost = ?, last_cost = ?, last_updated = NOW()`,
    [_wsId, warehouseId, itemId, Number(qtyDelta), newCost, unitCost || oldCost,
     Number(qtyDelta), newCost, unitCost || oldCost]);
  const newQty = oldQty + Number(qtyDelta);
  await _recordCostHistory(itemId, warehouseId, oldCost, newCost, oldQty, newQty, triggerType, refId, changedBy, conn);
  return { oldQty, oldCost, newQty, newCost };
}

// ─── Phase 3A — transfer contract: idempotency, audit, version, envelope ──
// All ADDITIVE: the legacy HTML UI keeps working because errors still carry a
// human `error` and successes still carry the legacy keys (id/issueNumber/…).

// Idempotency-Key (create/issue/receive). Phase 3A.1 — RESERVATION pattern:
//   1. _idemBegin INSERTs a reservation row keyed by a hash of
//      (operation | document | user | client-key). The UNIQUE PK is the race
//      guard — only ONE concurrent request with the same composite key wins.
//   2. On a duplicate key: same client-key but a DIFFERENT request payload →
//      IDEMPOTENCY_CONFLICT; a COMPLETED reservation → replay the stored result;
//      an in-progress one → conflict (the original is still running).
//   3. The owner runs the work, then _idemComplete stores the response; a
//      FAILURE calls _idemAbort to DELETE the reservation so a transient failure
//      is never cached as a permanent success and a retry can proceed.
// Retention/cleanup: the 24h sweep in server.js reclaims stale rows.
function _idemKey(req) {
  const k = (req.get && (req.get('Idempotency-Key') || req.get('X-Idempotency-Key'))) || '';
  return k ? String(k).slice(0, 120) : '';
}
function _isDupErr(e) { return !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /duplicate entry/i.test(e.message || '')); }
function _stableStringify(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(_stableStringify).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + _stableStringify(o[k])).join(',') + '}';
}
function _bodyHash(body) { try { return crypto.createHash('sha256').update(_stableStringify(body || {})).digest('hex'); } catch (_) { return ''; } }
function _idemId(scope, docId, username, key) {
  return 'tx:' + crypto.createHash('sha1').update([scope, docId || '', username || '', key].join('|')).digest('hex');
}
// Returns one of:
//   { mode:'none' }                          — no key supplied; proceed normally
//   { mode:'proceed', idemId }               — reservation taken; do the work
//   { mode:'replay', statusCode, body }      — completed before; replay it
//   { mode:'conflict' }                      — same key+different payload / in-progress
async function _idemBegin(scope, docId, key, req) {
  if (!key) return { mode: 'none' };
  const username = _actor(req);
  const idemId = _idemId(scope, docId, username, key);
  const hash = _bodyHash(req.body);
  try {
    await db.query(
      'INSERT INTO idempotency_keys (id, username, endpoint, request_hash, status_code) VALUES (?,?,?,?,NULL)',
      [idemId, username, scope, hash]);
    return { mode: 'proceed', idemId };
  } catch (e) {
    if (!_isDupErr(e)) return { mode: 'proceed', idemId }; // table/other issue → never block the op
    let row = null;
    try { const [rows] = await db.query('SELECT request_hash, response_json, status_code FROM idempotency_keys WHERE id=? LIMIT 1', [idemId]); row = rows[0]; } catch (_) {}
    if (!row) return { mode: 'proceed', idemId };
    if (row.request_hash && hash && row.request_hash !== hash) return { mode: 'conflict' }; // same key, different payload
    if (row.status_code != null && row.response_json != null) {
      let body = null; try { body = JSON.parse(row.response_json); } catch (_) {}
      return { mode: 'replay', statusCode: Number(row.status_code) || 200, body };
    }
    return { mode: 'conflict' }; // reserved but not yet completed → original in flight
  }
}
async function _idemComplete(idemId, statusCode, body) {
  if (!idemId) return;
  try { await db.query('UPDATE idempotency_keys SET response_json=?, status_code=? WHERE id=?', [JSON.stringify(body), statusCode, idemId]); } catch (_) {}
}
async function _idemAbort(idemId) {
  if (!idemId) return;
  // Only delete a still-in-progress reservation (never a completed result).
  try { await db.query('DELETE FROM idempotency_keys WHERE id=? AND status_code IS NULL', [idemId]); } catch (_) {}
}

// Optimistic-concurrency token from the client (body.expectedVersion or
// If-Match header). null → no check (legacy path keeps the status-only guard).
function _expectedVersion(req) {
  const raw = (req.body && req.body.expectedVersion != null)
    ? req.body.expectedVersion
    : (req.get && req.get('If-Match'));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// Append-only audit row — pass the tx `conn` so it commits atomically with the
// state change; falls back to the pool for the non-transactional transitions.
async function _audit(conn, issueId, action, fromStatus, toStatus, actor, note, payload) {
  const q = conn || db;
  try {
    await q.query(
      'INSERT INTO stock_issue_events (id, issue_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?)',
      ['EV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), issueId, action,
       fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500),
       payload ? JSON.stringify(payload).slice(0, 8000) : null]);
  } catch (_) { /* audit is best-effort, never blocks the transaction's intent */ }
  return { issueId, action, fromStatus: fromStatus || null, toStatus: toStatus || null, actor: actor || '', at: new Date().toISOString() };
}

// Unified success body (mutation envelope §5 + legacy keys) — WITHOUT sending.
// Idempotent handlers store this BEFORE responding so a fast retry replays it.
function _envelope(parts, legacy) {
  return Object.assign({}, TC.mutationEnvelope(parts), legacy || {});
}
// Build + send in one step (non-idempotent handlers).
function _ok(res, parts, legacy, statusCode) {
  const body = _envelope(parts, legacy);
  res.status(statusCode || 200).json(body);
  return body;
}
// Unified error: canonical code + matching HTTP status; keeps human `error`.
function _fail(res, codeOrErr, message) {
  const code = TC.isCanonical(codeOrErr) ? codeOrErr : TC.mapError(codeOrErr);
  const msg = message || (codeOrErr && codeOrErr.message) || code;
  return res.status(TC.httpFor(code)).json(TC.errorBody(code, msg));
}
// Catch-block router: a scope-guard that already answered → swallow; a 404 stays
// 404; a thrown DOMAIN error (has `.code` or a non-500 `.status`) → canonical
// code; anything else is a genuine server fault → 500 (never mislabelled 422).
function _catch(res, e) {
  if (e && e._guarded) return;
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found' });
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: (e && e.message) || 'error' });
  return _fail(res, e, e && e.message);
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1 — WAREHOUSES HIERARCHY
// ═══════════════════════════════════════════════════════════════════════

// List warehouses with hierarchy info
router.get('/warehouses/hierarchy', async (req, res) => {
  try {
    const sc = req.whScopeClause('w.id');
    const [rows] = await db.query(`
      SELECT w.*,
             p.name AS parent_name, p.code AS parent_code,
             (SELECT COUNT(*) FROM warehouses WHERE parent_warehouse_id = w.id) AS child_count
      FROM warehouses w
      LEFT JOIN warehouses p ON p.id = w.parent_warehouse_id
      WHERE w.is_active = 1` + sc.sql + `
      ORDER BY COALESCE(w.parent_warehouse_id, w.id), w.is_main DESC, w.name
    `, sc.params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set a warehouse as "main" for a brand
router.post('/warehouses/:id/set-main', async (req, res) => {
  try {
    const id = req.params.id;
    if (!req.guardWh(res, id)) return;
    const [rows] = await db.query('SELECT brand_id FROM warehouses WHERE id=?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'warehouse not found' });
    const brandId = rows[0].brand_id;
    if (brandId) {
      // Unset any other main for this brand
      await db.query('UPDATE warehouses SET is_main=0 WHERE brand_id=? AND id<>?', [brandId, id]);
    }
    await db.query('UPDATE warehouses SET is_main=1, parent_warehouse_id=NULL WHERE id=?', [id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// V5.9.3 — Demote a warehouse from main → sub.  Optional ?parentId to
//   link it to a different main.  If no other main exists for the brand,
//   the warehouse becomes a free-standing sub (no parent).
router.post('/warehouses/:id/unset-main', async (req, res) => {
  try {
    const id = req.params.id;
    if (!req.guardWh(res, id)) return;
    const { parentId } = req.body || {};
    if (!req.guardWh(res, parentId)) return;
    const [rows] = await db.query('SELECT brand_id, is_main FROM warehouses WHERE id=?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'warehouse not found' });
    if (parentId) {
      const [p] = await db.query('SELECT id FROM warehouses WHERE id=?', [parentId]);
      if (!p.length) return res.status(404).json({ error: 'parent not found' });
      await db.query('UPDATE warehouses SET is_main=0, parent_warehouse_id=? WHERE id=?', [parentId, id]);
    } else {
      await db.query('UPDATE warehouses SET is_main=0, parent_warehouse_id=NULL WHERE id=?', [id]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Link a sub-warehouse to a parent (main)
router.post('/warehouses/:id/set-parent', async (req, res) => {
  try {
    const id = req.params.id;
    if (!req.guardWh(res, id)) return;
    const { parentId } = req.body;
    if (!req.guardWh(res, parentId)) return;
    if (!parentId) {
      await db.query('UPDATE warehouses SET parent_warehouse_id=NULL WHERE id=?', [id]);
    } else {
      // Prevent circular references
      if (parentId === id) return res.status(400).json({ error: 'cannot set self as parent' });
      const [p] = await db.query('SELECT id, is_main FROM warehouses WHERE id=?', [parentId]);
      if (!p.length) return res.status(404).json({ error: 'parent not found' });
      await db.query('UPDATE warehouses SET parent_warehouse_id=?, is_main=0 WHERE id=?', [parentId, id]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1 — STOCK ISSUES (main warehouse → branch warehouses)
// ═══════════════════════════════════════════════════════════════════════

// List stock issues
// V5.9.9 — added LEFT JOINs against `users` so the report shows the actual
// human names of the creator / approver / issuer / receiver / reverser. The
// row stores plain usernames (e.g. "ahmed"), but the UI wants display names
// (e.g. "أحمد عدلان") — COALESCE(full_name, username) gives us a graceful
// fallback for accounts that haven't filled out full_name yet.
router.get('/stock-issues', async (req, res) => {
  try {
    const { status, fromWh, toWh, brandId, dateFrom, dateTo } = req.query;
    let sql = `
      SELECT si.*,
             wf.name AS from_warehouse_name, wf.code AS from_warehouse_code,
             wt.name AS to_warehouse_name, wt.code AS to_warehouse_code,
             b.name AS brand_name, br.name AS branch_name,
             COALESCE(uc.full_name, uc.username, si.created_by)  AS created_by_name,
             COALESCE(ua.full_name, ua.username, si.approved_by) AS approved_by_name,
             COALESCE(ui.full_name, ui.username, si.issued_by)   AS issued_by_name,
             COALESCE(ur.full_name, ur.username, si.received_by) AS received_by_name,
             COALESCE(uv.full_name, uv.username, si.reversed_by) AS reversed_by_name,
             (SELECT COUNT(*) FROM stock_issue_items WHERE issue_id=si.id) AS line_count,
             /* v5.10.40 — aggregate qty totals so the list view can flag
                partial-receipt rows without an extra round-trip per issue. */
             (SELECT COALESCE(SUM(qty_issued),0)   FROM stock_issue_items WHERE issue_id=si.id) AS qty_issued_total,
             (SELECT COALESCE(SUM(qty_received),0) FROM stock_issue_items WHERE issue_id=si.id) AS qty_received_total
      FROM stock_issues si
      LEFT JOIN warehouses wf ON wf.id = si.from_warehouse_id
      LEFT JOIN warehouses wt ON wt.id = si.to_warehouse_id
      LEFT JOIN brands b ON b.id = si.brand_id
      LEFT JOIN branches br ON br.id = si.branch_id
      LEFT JOIN users uc ON uc.username = si.created_by
      LEFT JOIN users ua ON ua.username = si.approved_by
      LEFT JOIN users ui ON ui.username = si.issued_by
      LEFT JOIN users ur ON ur.username = si.received_by
      LEFT JOIN users uv ON uv.username = si.reversed_by
      WHERE 1=1`;
    const params = [];
    if (status)   { sql += ' AND si.status = ?'; params.push(status); }
    if (fromWh)   { sql += ' AND si.from_warehouse_id = ?'; params.push(fromWh); }
    if (toWh)     { sql += ' AND si.to_warehouse_id = ?'; params.push(toWh); }
    if (brandId)  { sql += ' AND si.brand_id = ?'; params.push(brandId); }
    if (dateFrom) { sql += ' AND si.issue_date >= ?'; params.push(dateFrom); }
    if (dateTo)   { sql += ' AND si.issue_date <= ?'; params.push(dateTo); }
    // Scope: restrict to issues touching an accessible warehouse on EITHER end.
    const sf = req.whScopeClause('si.from_warehouse_id'), st = req.whScopeClause('si.to_warehouse_id');
    if (sf.sql) {
      sql += ' AND (' + sf.sql.replace(/^\s*AND\s+/i, '') + ' OR ' + st.sql.replace(/^\s*AND\s+/i, '') + ')';
      params.push(...sf.params, ...st.params);
    }
    sql += ' ORDER BY si.created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get single stock issue with items
// V5.9.9 — same actor-name enrichment as the list endpoint so the detail-view
// timeline can show "بواسطة: أحمد عدلان" under each step instead of "ahmed".
router.get('/stock-issues/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT si.*,
             wf.name AS from_warehouse_name, wf.code AS from_warehouse_code,
             wt.name AS to_warehouse_name, wt.code AS to_warehouse_code,
             COALESCE(uc.full_name, uc.username, si.created_by)  AS created_by_name,
             COALESCE(ua.full_name, ua.username, si.approved_by) AS approved_by_name,
             COALESCE(ui.full_name, ui.username, si.issued_by)   AS issued_by_name,
             COALESCE(ur.full_name, ur.username, si.received_by) AS received_by_name,
             COALESCE(uv.full_name, uv.username, si.reversed_by) AS reversed_by_name
      FROM stock_issues si
      LEFT JOIN warehouses wf ON wf.id = si.from_warehouse_id
      LEFT JOIN warehouses wt ON wt.id = si.to_warehouse_id
      LEFT JOIN users uc ON uc.username = si.created_by
      LEFT JOIN users ua ON ua.username = si.approved_by
      LEFT JOIN users ui ON ui.username = si.issued_by
      LEFT JOIN users ur ON ur.username = si.received_by
      LEFT JOIN users uv ON uv.username = si.reversed_by
      WHERE si.id=?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (!req.guardTransfer(res, rows[0].from_warehouse_id, rows[0].to_warehouse_id)) return;
    const [items] = await db.query(`
      SELECT sii.*, i.name AS item_name, i.unit AS item_unit
      FROM stock_issue_items sii
      LEFT JOIN inv_items i ON i.id = sii.item_id
      WHERE sii.issue_id=?
      ORDER BY sii.id`, [req.params.id]);
    res.json({ ...rows[0], items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create stock issue (draft)
router.post('/stock-issues', async (req, res) => {
  let _idemId = null;
  try {
    const { fromWarehouseId, toWarehouseId, brandId, branchId, issueDate, notes, items } = req.body;
    // Phase 0 §5 — creator identity comes from the JWT, not the body.
    const createdBy = _actor(req);
    // Phase 3A.1 — idempotency reservation (create has no document id yet).
    const idemKey = _idemKey(req);
    const idem = await _idemBegin('transfer:create', null, idemKey, req);
    if (idem.mode === 'replay') return res.status(idem.statusCode).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب مكرر بنفس المفتاح (محتوى مختلف أو قيد المعالجة)');
    _idemId = idem.idemId;
    if (!fromWarehouseId || !toWarehouseId) return _fail(res, 'VALIDATION_ERROR', 'from/to warehouse required');
    if (!req.guardTransfer(res, fromWarehouseId, toWarehouseId)) return;
    // v5.10.40 — Reject same-warehouse "transfers". Every ERP (SAP, Oracle,
    // Odoo) treats this as invalid because it has no business meaning and
    // would create offsetting movements at the same warehouse.
    if (String(fromWarehouseId) === String(toWarehouseId)) {
      return _fail(res, 'VALIDATION_ERROR', 'لا يمكن أن يكون المستودع المصدر هو نفسه المستودع الوجهة. اختر مستودعَين مختلفَين.');
    }
    if (!items || !items.length) return _fail(res, 'VALIDATION_ERROR', 'items required');

    // v7.5 — both warehouses must actually exist: a typo/phantom id used to
    // ride into stock_issues and surface later as a misleading
    // "insufficient stock" at issue time.
    const [whRows] = await db.query(
      'SELECT id FROM warehouses WHERE id IN (?, ?)', [fromWarehouseId, toWarehouseId]);
    const whFound = whRows.map(w => String(w.id));
    if (whFound.indexOf(String(fromWarehouseId)) < 0 || whFound.indexOf(String(toWarehouseId)) < 0) {
      return _fail(res, 'VALIDATION_ERROR', 'مستودع غير موجود — تحقق من المصدر والوجهة');
    }

    const ymd = _ymd();
    const serial = await _nextSerial('stock_issue_counter', ymd);
    const issueNumber = 'ISS-' + ymd + '-' + String(serial).padStart(4,'0');
    const id = 'SI-' + Date.now();

    let total = 0;
    const enriched = [];
    for (const it of items) {
      const cost = await _getEffectiveCost(it.itemId, fromWarehouseId);
      const lineTotal = Number(it.qtyRequested || 0) * cost;
      total += lineTotal;
      enriched.push({ ...it, unitCost: cost, lineTotal });
    }

    await db.query(
      `INSERT INTO stock_issues
       (id, issue_number, from_warehouse_id, to_warehouse_id, brand_id, branch_id,
        issue_date, status, total_cost, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, issueNumber, fromWarehouseId, toWarehouseId, brandId || null, branchId || null,
       issueDate || new Date().toISOString().slice(0,10), 'draft', total,
       notes || '', createdBy || '']);

    for (const it of enriched) {
      await db.query(
        `INSERT INTO stock_issue_items
         (id, issue_id, item_id, qty_requested, unit_cost, line_total, notes)
         VALUES (?,?,?,?,?,?,?)`,
        ['SII-' + Date.now() + '-' + Math.random().toString(36).slice(2,8),
         id, it.itemId, Number(it.qtyRequested) || 0,
         it.unitCost, it.lineTotal, it.notes || '']);
    }

    // Phase 3A — audit + unified envelope (legacy keys kept). Draft starts at v1.
    const auditEvent = await _audit(null, id, 'create', null, 'draft', createdBy, notes || '',
      { from: fromWarehouseId, to: toWarehouseId, lines: enriched.length });
    const body = _envelope({
      data: { id, issueNumber, status: 'draft', totalCost: total },
      documentNumber: issueNumber, status: 'draft', version: 1, affectedStock: [], auditEvent,
    }, { id, issueNumber, totalCost: total });
    await _idemComplete(_idemId, 200, body);
    res.json(body);
  } catch(e) { if (_idemId) await _idemAbort(_idemId).catch(() => {}); _catch(res, e); }
});

// Edit a DRAFT in place (Phase 3A.1) — a REAL update, never delete+recreate.
// Replaces the header fields + line items inside ONE transaction; preserves
// id / issue_number / created_by / created_at; bumps version once; performs NO
// stock movement and NO GL. expectedVersion is mandatory (optimistic lock).
router.patch('/stock-issues/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const actor = _actor(req);
    const { fromWarehouseId, toWarehouseId, issueDate, notes, items } = req.body || {};
    const expectedVersion = _expectedVersion(req);
    if (expectedVersion == null) return _fail(res, 'VALIDATION_ERROR', 'expectedVersion مطلوب لتعديل المسودة');
    if (!fromWarehouseId || !toWarehouseId) return _fail(res, 'VALIDATION_ERROR', 'from/to warehouse required');
    if (String(fromWarehouseId) === String(toWarehouseId)) return _fail(res, 'VALIDATION_ERROR', 'المصدر والوجهة يجب أن يكونا مختلفين');
    if (!Array.isArray(items) || !items.length) return _fail(res, 'VALIDATION_ERROR', 'items required');
    // Validate lines: positive qty, no duplicate itemId.
    const seen = new Set();
    for (const it of items) {
      if (!it || !it.itemId) return _fail(res, 'VALIDATION_ERROR', 'صنف غير صالح');
      if (seen.has(String(it.itemId))) return _fail(res, 'VALIDATION_ERROR', 'صنف مكرر في القائمة: ' + it.itemId);
      seen.add(String(it.itemId));
      if (!(Number(it.qtyRequested) > 0)) return _fail(res, 'VALIDATION_ERROR', 'الكمية يجب أن تكون أكبر من صفر');
    }
    const [rows] = await db.query('SELECT status, version, issue_number, from_warehouse_id, to_warehouse_id FROM stock_issues WHERE id=?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'not found' });
    const cur = rows[0];
    if (cur.status !== 'draft') return _fail(res, 'INVALID_STATE_TRANSITION', 'لا يمكن تعديل إلا المسودة (draft). الحالة الحالية: ' + cur.status);
    // Scope on the NEW source + destination (both ends).
    if (!req.guardTransfer(res, fromWarehouseId, toWarehouseId)) return;
    const [whRows] = await db.query('SELECT id FROM warehouses WHERE id IN (?,?)', [fromWarehouseId, toWarehouseId]);
    const whFound = whRows.map((w) => String(w.id));
    if (whFound.indexOf(String(fromWarehouseId)) < 0 || whFound.indexOf(String(toWarehouseId)) < 0) return _fail(res, 'VALIDATION_ERROR', 'مستودع غير موجود — تحقق من المصدر والوجهة');

    // Re-price lines (draft only — no stock/GL movement).
    let total = 0; const enriched = [];
    for (const it of items) {
      const cost = await _getEffectiveCost(it.itemId, fromWarehouseId);
      const lineTotal = Number(it.qtyRequested || 0) * cost;
      total += lineTotal;
      enriched.push({ itemId: it.itemId, qtyRequested: Number(it.qtyRequested) || 0, notes: it.notes || '', unitCost: cost, lineTotal });
    }

    const out = await db.withTransaction(async (conn) => {
      // Conditional, version-guarded header UPDATE — preserves id / issue_number
      // / created_by / created_at (never written). A concurrent edit with the
      // same expectedVersion loses here (affectedRows=0 → VERSION_CONFLICT).
      const [upd] = await conn.query(
        `UPDATE stock_issues SET from_warehouse_id=?, to_warehouse_id=?, issue_date=?, notes=?, total_cost=?, version=version+1
         WHERE id=? AND status='draft' AND version=?`,
        [fromWarehouseId, toWarehouseId, issueDate || new Date().toISOString().slice(0, 10), notes || '', total, id, expectedVersion]);
      if (!upd || upd.affectedRows !== 1) { const e = new Error('تغيّرت المسودة منذ آخر تحميل — أعد التحميل وحاول مجددًا'); e.status = 409; e.code = 'state_changed'; throw e; }
      // Replace the line items atomically.
      await conn.query('DELETE FROM stock_issue_items WHERE issue_id=?', [id]);
      for (const it of enriched) {
        await conn.query(
          `INSERT INTO stock_issue_items (id, issue_id, item_id, qty_requested, unit_cost, line_total, notes) VALUES (?,?,?,?,?,?,?)`,
          ['SII-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), id, it.itemId, it.qtyRequested, it.unitCost, it.lineTotal, it.notes]);
      }
      const auditEvent = await _audit(conn, id, 'edit', 'draft', 'draft', actor, notes || '',
        { from: fromWarehouseId, to: toWarehouseId, lines: enriched.length, totalCost: total });
      return { newVersion: (Number(cur.version) || 1) + 1, auditEvent };
    });

    _ok(res, {
      data: { id, issueNumber: cur.issue_number, status: 'draft', totalCost: total },
      documentNumber: cur.issue_number, status: 'draft', version: out.newVersion, affectedStock: [], auditEvent: out.auditEvent,
    }, { success: true, id, issueNumber: cur.issue_number, totalCost: total });
  } catch(e) { _catch(res, e); }
});

// Approve stock issue
router.post('/stock-issues/:id/approve', MGR, async (req, res) => {
  try {
    const id = req.params.id;
    // Phase 0 §5 — approver identity from the JWT, never the body.
    const approvedBy = _actor(req);
    const expectedVersion = _expectedVersion(req);
    const [rows] = await db.query('SELECT status, version, issue_number, from_warehouse_id, to_warehouse_id FROM stock_issues WHERE id=?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'not found' });
    if (!req.guardTransfer(res, rows[0].from_warehouse_id, rows[0].to_warehouse_id)) return;
    if (rows[0].status !== 'draft') return _fail(res, 'INVALID_STATE_TRANSITION', 'لا يمكن اعتماد إلا المسودة (draft). الحالة الحالية: ' + rows[0].status);
    // v7.5 — state-guarded UPDATE + affectedRows: a concurrent double-tap loses
    // here with 409. Phase 3A — also bump `version` and honour an optional
    // `expectedVersion` (legacy clients omit it → only the status guard applies).
    const [updRes] = await db.query(
      `UPDATE stock_issues SET status='approved', approved_by=?, approved_at=NOW(), version = version + 1
       WHERE id=? AND status='draft' AND (? IS NULL OR version = ?)`,
      [approvedBy, id, expectedVersion, expectedVersion]);
    if (!updRes || updRes.affectedRows !== 1) {
      return _fail(res, 'VERSION_CONFLICT', 'تغيّرت حالة أمر الصرف — أعد التحميل وحاول مجدداً');
    }
    const newVersion = (Number(rows[0].version) || 1) + 1;
    const auditEvent = await _audit(null, id, 'approve', 'draft', 'approved', approvedBy, '', null);
    _ok(res, { data: { id, status: 'approved' }, documentNumber: rows[0].issue_number, status: 'approved', version: newVersion, affectedStock: [], auditEvent }, { success: true });
  } catch(e) { _catch(res, e); }
});

// Issue (decrement source warehouse + post GL)
router.post('/stock-issues/:id/issue', BACKOFFICE, async (req, res) => {
  let _idemId = null;
  try {
    const id = req.params.id;
    // Phase 0 §5 — issuer identity from the JWT, never the body.
    const issuedBy = _actor(req);
    const [hdrRows] = await db.query('SELECT * FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'not found' });
    const hdr = hdrRows[0];
    if (!req.guardTransfer(res, hdr.from_warehouse_id, hdr.to_warehouse_id)) return;
    // Phase 3A.1 — idempotency reservation (bound to this document). Checked
    // AFTER the scope guard and BEFORE the state check.
    const idemKey = _idemKey(req);
    const idem = await _idemBegin('transfer:issue', id, idemKey, req);
    if (idem.mode === 'replay') return res.status(idem.statusCode).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب مكرر بنفس المفتاح (محتوى مختلف أو قيد المعالجة)');
    _idemId = idem.idemId;
    const expectedVersion = _expectedVersion(req);
    // Phase 0 §3 — a draft can NEVER be issued. The approval step is the
    // control that makes the value/stock move auditable, so issuing is only
    // allowed from `approved`.
    if (!TR.canIssue(hdr.status)) {
      return _fail(res, 'INVALID_STATE_TRANSITION', 'لا يمكن صرف الإذن إلا بعد اعتماده (الحالة يجب أن تكون "approved"). الحالة الحالية: ' + hdr.status);
    }

    const [items] = await db.query('SELECT * FROM stock_issue_items WHERE issue_id=?', [id]);
    if (!items.length) return _fail(res, 'VALIDATION_ERROR', 'no items');

    const issueNow = new Date();

    // v7.4 — atomic issue: source-stock deduction + ledger rows + GL (Dr Branch
    // Inventory / Cr Main Inventory) + status flip all commit together. GL is
    // now FATAL (rolls back the stock move) instead of console.warn-swallowed,
    // and availability is re-checked inside the transaction.
    const out = await db.withTransaction(async (conn) => {
      for (const it of items) {
        const [stk] = await conn.query(
          'SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?',
          [hdr.from_warehouse_id, it.item_id]);
        const available = stk.length ? Number(stk[0].qty) : 0;
        if (available < Number(it.qty_requested)) {
          const e = new Error(`insufficient stock for item ${it.item_id}: available ${available}, required ${it.qty_requested}`);
          e.status = 400; throw e;
        }
      }

      let totalCost = 0;
      const affectedStock = [];
      for (const it of items) {
        const qty = Number(it.qty_requested);
        const mv = await _applyStockMovement(hdr.from_warehouse_id, it.item_id, -qty, Number(it.unit_cost),
                                  'stock_issue_out', id, issuedBy, conn);
        affectedStock.push({ warehouseId: hdr.from_warehouse_id, itemId: it.item_id, delta: -qty, newQty: mv.newQty });
        const lineTotal = qty * Number(it.unit_cost);
        totalCost += lineTotal;
        await conn.query(
          `UPDATE stock_issue_items SET qty_issued=?, line_total=? WHERE id=?`,
          [qty, lineTotal, it.id]);
        // Ledger entry: "تحويل صادر" (transferOut in /live-report bucket()).
        const movId = 'MOV-SI-OUT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        try {
          await conn.query(
            'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [movId, issueNow, it.item_id, it.item_name || '', 'out', qty,
             'تحويل صادر', issuedBy, 'STOCK_ISSUE: ' + (hdr.issue_number || id),
             hdr.from_warehouse_id, 'transfer', id]);
        } catch(e) {
          await conn.query(
            'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [movId, issueNow, it.item_id, it.item_name || '', 'out', qty,
             'تحويل صادر', issuedBy, 'STOCK_ISSUE: ' + (hdr.issue_number || id),
             hdr.from_warehouse_id]);
        }
        // Phase 4B — tracked item: FEFO-allocate the issued qty from the source +
        // record the in-transit lot allocation; re-check the source invariant.
        const lmode = await L.getTrackingMode(conn, it.item_id);
        if (L.isTracked(lmode)) {
          const seq = await _seqOf(conn, movId);
          await L.transferIssue(conn, { transferId: id, sourceWh: hdr.from_warehouse_id, destWh: hdr.to_warehouse_id, itemId: it.item_id, qty, trackingMode: lmode, movementSeq: seq, movementId: movId, actor: issuedBy, occurredAt: issueNow });
          await L.assertInvariant(conn, hdr.from_warehouse_id, it.item_id);
        }
      }

      // GL: Dr Branch Inventory / Cr Main Inventory — fatal when there's value.
      let glId = null;
      if (totalCost > 0.005) {
        const glRes = await gl.postJournal(conn, {
          referenceType: 'stock_issue',
          referenceId: id,
          description: `إذن صرف ${hdr.issue_number}: من ${hdr.from_warehouse_id} إلى ${hdr.to_warehouse_id}`,
          postedBy: issuedBy,
          entries: [
            { accountCode: gl.CORE_ACCOUNTS.BRANCH_INVENTORY.code, debit: totalCost, credit: 0,
              brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: hdr.to_warehouse_id },
            { accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: 0, credit: totalCost,
              brandId: hdr.brand_id, warehouseId: hdr.from_warehouse_id }
          ]
        });
        if (!glRes || !glRes.success) {
          const e = new Error('فشل ترحيل قيد إذن الصرف: ' + ((glRes && glRes.error) || 'خطأ غير معروف'));
          e.status = 400; throw e;
        }
        glId = glRes.journalId;
      }

      // Phase 0 — state-guarded flip: a concurrent double-issue (both racing
      // past the read above) loses here with affectedRows=0 and rolls its own
      // stock deduction + GL back, instead of issuing the same goods twice.
      const [flipRes] = await conn.query(
        `UPDATE stock_issues
         SET status='issued', issued_by=?, issued_at=NOW(), total_cost=?, gl_journal_id=?, version = version + 1
         WHERE id=? AND status='approved' AND (? IS NULL OR version = ?)`,
        [issuedBy, totalCost, glId, id, expectedVersion, expectedVersion]);
      if (!flipRes || flipRes.affectedRows !== 1) {
        const e = new Error('تغيّرت حالة أمر الصرف (صرف مكرر؟) — أعد التحميل وحاول مجدداً');
        e.status = 409; e.code = 'state_changed'; throw e;
      }
      const auditEvent = await _audit(conn, id, 'issue', 'approved', 'issued', issuedBy, '', { totalCost, glId });
      return { totalCost, glId, affectedStock, newVersion: (Number(hdr.version) || 1) + 1, auditEvent };
    });

    const body = _envelope({
      data: { id, status: 'issued', totalCost: out.totalCost, glJournalId: out.glId },
      documentNumber: hdr.issue_number, status: 'issued', version: out.newVersion,
      affectedStock: out.affectedStock, auditEvent: out.auditEvent,
    }, { success: true, totalCost: out.totalCost, glJournalId: out.glId });
    await _idemComplete(_idemId, 200, body);
    res.json(body);
  } catch(e) { if (_idemId) await _idemAbort(_idemId).catch(() => {}); _catch(res, e); }
});

// Receive (increment destination warehouse)
// Phase 0 §4 — CUMULATIVE partial receipt. `items[].qtyReceived` is the
// quantity arriving in THIS shipment (a delta), accumulated onto whatever was
// received before. The header rests on `partially_received` until every line
// is fully received, then flips to `received`. Per-line over-receipt is
// validated against the REMAINING quantity (issued − already received), not
// the issued total, so two partial receipts can never exceed what was issued.
router.post('/stock-issues/:id/receive', BACKOFFICE, async (req, res) => {
  let _idemId = null;
  try {
    const id = req.params.id;
    // Phase 0 §5 — receiver identity from the JWT, never the body.
    const receivedBy = _actor(req);
    const { items } = req.body || {};  // items optional — omit = receive all remaining

    // v7.5 — items=[] (truthy but EMPTY) used to skip validation and silently
    // fall back to a FULL receipt. Reject it: omit the field for "receive all
    // remaining", or send per-line qtys.
    if (Array.isArray(items) && items.length === 0) {
      return _fail(res, 'VALIDATION_ERROR', 'قائمة الأصناف فارغة — احذف الحقل لاستلام كل المتبقي أو أرسل كمية لكل سطر');
    }
    // Phase 3A.1 — idempotency reservation: a retried receive with the same key
    // never double-counts the cumulative quantity.
    const idemKey = _idemKey(req);
    const idem = await _idemBegin('transfer:receive', id, idemKey, req);
    if (idem.mode === 'replay') return res.status(idem.statusCode).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب مكرر بنفس المفتاح (محتوى مختلف أو قيد المعالجة)');
    _idemId = idem.idemId;
    const expectedVersion = _expectedVersion(req);
    // delta-to-receive-now, keyed by line id (only when items provided).
    const deltaMap = {};
    const hasItemsArg = Array.isArray(items);
    if (hasItemsArg) items.forEach(it => { deltaMap[it.id] = Number(it.qtyReceived); });

    const receiveNow = new Date();
    // Everything authoritative happens INSIDE the transaction with the header
    // row locked FOR UPDATE, so two concurrent receives on the same transfer
    // serialize: the cumulative read-modify-write of qty_received is safe, and
    // every stock increment + ledger row + status flip commit or roll back as
    // one unit. No GL here — the value already moved to Branch Inventory at
    // issue time.
    const out = await db.withTransaction(async (conn) => {
      const [hdrRows] = await conn.query('SELECT * FROM stock_issues WHERE id=? FOR UPDATE', [id]);
      if (!hdrRows.length) { const e = new Error('not found'); e.status = 404; throw e; }
      const hdr = hdrRows[0];
      if (!req.guardTransfer(res, hdr.from_warehouse_id, hdr.to_warehouse_id)) {
        // Guard already wrote the 403 — abort the txn and skip the duplicate send.
        const e = new Error('forbidden'); e._guarded = true; throw e;
      }
      if (!TR.canReceive(hdr.status)) {
        const e = new Error('لا يمكن الاستلام إلا بعد الصرف (issued أو partially_received). الحالة الحالية: ' + hdr.status);
        e.status = 400; e.code = 'RECEIVE_INVALID_STATE'; throw e;
      }

      const [dbItems] = await conn.query('SELECT * FROM stock_issue_items WHERE issue_id=? FOR UPDATE', [id]);

      // Validate every requested delta against the line's REMAINING quantity
      // BEFORE any side effect (rolls back nothing on rejection).
      const plan = []; // { line, delta, newQtyReceived }
      let totalDelta = 0;
      for (const it of dbItems) {
        const qtyIssued = Number(it.qty_issued) || 0;
        const prev = Number(it.qty_received) || 0;
        // When items omitted → receive all remaining for every line. When items
        // provided → only the listed lines get a delta; the rest get 0.
        const delta = hasItemsArg
          ? (deltaMap.hasOwnProperty(it.id) ? Number(deltaMap[it.id]) || 0 : 0)
          : (qtyIssued - prev);
        let calc;
        try {
          calc = TR.computeLineReceipt({ qtyIssued, qtyReceivedSoFar: prev, qtyReceiveNow: delta });
        } catch (ce) {
          const e = new Error(ce.message + ' (سطر ' + it.id + ')');
          e.status = 400; e.code = ce.code; e.lineId = it.id;
          throw e;
        }
        totalDelta += calc.applied;
        plan.push({ line: it, delta: calc.applied, newQtyReceived: calc.newQtyReceived });
      }

      if (totalDelta <= TR.EPS) {
        const e = new Error('لا توجد كمية للاستلام — حدّد كمية واحدة على الأقل.');
        e.status = 400; e.code = 'NOTHING_TO_RECEIVE'; throw e;
      }

      const affectedStock = [];
      for (const p of plan) {
        if (p.delta <= TR.EPS) continue;
        const it = p.line;
        const mv = await _applyStockMovement(hdr.to_warehouse_id, it.item_id, p.delta, Number(it.unit_cost),
                                  'stock_issue_in', id, receivedBy, conn);
        affectedStock.push({ warehouseId: hdr.to_warehouse_id, itemId: it.item_id, delta: p.delta, newQty: mv.newQty });
        // Cumulative — set the new running total, not an overwrite of the delta.
        await conn.query('UPDATE stock_issue_items SET qty_received=? WHERE id=?', [p.newQtyReceived, it.id]);
        // Ledger entry — destination side, same reference_id as the 'out' row.
        const movId = 'MOV-SI-IN-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        try {
          await conn.query(
            'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [movId, receiveNow, it.item_id, it.item_name || '', 'in', p.delta,
             'تحويل وارد', receivedBy, 'STOCK_ISSUE: ' + (hdr.issue_number || id),
             hdr.to_warehouse_id, 'transfer', id]);
        } catch(e) {
          await conn.query(
            'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [movId, receiveNow, it.item_id, it.item_name || '', 'in', p.delta,
             'تحويل وارد', receivedBy, 'STOCK_ISSUE: ' + (hdr.issue_number || id),
             hdr.to_warehouse_id]);
        }
        // Phase 4B — tracked item: add the SAME in-transit lots to the destination
        // (partial-safe), preserving lot identity + expiry; re-check the invariant.
        const lmode = await L.getTrackingMode(conn, it.item_id);
        if (L.isTracked(lmode)) {
          const seq = await _seqOf(conn, movId);
          await L.transferReceive(conn, { transferId: id, destWh: hdr.to_warehouse_id, itemId: it.item_id, qty: p.delta, movementSeq: seq, movementId: movId, actor: receivedBy, occurredAt: receiveNow });
          await L.assertInvariant(conn, hdr.to_warehouse_id, it.item_id);
        }
      }

      // Header status from the NEW cumulative line totals: fully received →
      // 'received', otherwise → 'partially_received'.
      const nextStatus = TR.computeNextReceiveStatus(
        plan.map(p => ({ qtyIssued: Number(p.line.qty_issued) || 0, qtyReceived: p.newQtyReceived }))
      );
      // received_at is only stamped on the FINAL receipt; partial receipts keep
      // it null so the inbox 7-day cutoff doesn't hide an open transfer.
      const [flipRes] = await conn.query(
        `UPDATE stock_issues
         SET status=?, received_by=?,
             received_at = CASE WHEN ? = 'received' THEN NOW() ELSE received_at END,
             version = version + 1
         WHERE id=? AND status IN ('issued','partially_received') AND (? IS NULL OR version = ?)`,
        [nextStatus, receivedBy, nextStatus, id, expectedVersion, expectedVersion]);
      if (!flipRes || flipRes.affectedRows !== 1) {
        const e = new Error('تغيّرت حالة أمر الصرف (استلام متزامن؟) — أعد التحميل وحاول مجدداً');
        e.status = 409; e.code = 'state_changed'; throw e;
      }
      const auditEvent = await _audit(conn, id, 'receive', hdr.status, nextStatus, receivedBy, '', { delta: totalDelta });
      return { status: nextStatus, affectedStock, newVersion: (Number(hdr.version) || 1) + 1, auditEvent, issueNumber: hdr.issue_number };
    });

    const body = _envelope({
      data: { id, status: out.status, fullyReceived: out.status === 'received' },
      documentNumber: out.issueNumber, status: out.status, version: out.newVersion,
      affectedStock: out.affectedStock, auditEvent: out.auditEvent,
    }, { success: true, status: out.status, fullyReceived: out.status === 'received' });
    await _idemComplete(_idemId, 200, body);
    res.json(body);
  } catch(e) { if (_idemId) await _idemAbort(_idemId).catch(() => {}); _catch(res, e); }
});

// Cancel stock issue
router.post('/stock-issues/:id/cancel', MGR, async (req, res) => {
  try {
    const id = req.params.id;
    const actor = _actor(req);
    const reason = String((req.body && req.body.reason) || '').trim();
    const expectedVersion = _expectedVersion(req);
    const [hdrRows] = await db.query('SELECT status, version, issue_number, from_warehouse_id, to_warehouse_id FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'not found' });
    if (!req.guardTransfer(res, hdrRows[0].from_warehouse_id, hdrRows[0].to_warehouse_id)) return;
    if (!TR.canCancel(hdrRows[0].status))
      return _fail(res, 'INVALID_STATE_TRANSITION', 'لا يمكن الإلغاء إلا للمسودة أو المعتمد — استخدم الإرجاع بعد الصرف. الحالة الحالية: ' + hdrRows[0].status);
    // v7.5 — state-guarded cancel (only draft/approved) + affectedRows check.
    // Phase 3A — version bump + optional expectedVersion guard.
    const [cRes] = await db.query(
      `UPDATE stock_issues SET status='cancelled', version = version + 1
       WHERE id=? AND status IN ('draft','approved') AND (? IS NULL OR version = ?)`,
      [id, expectedVersion, expectedVersion]);
    if (!cRes || cRes.affectedRows !== 1) {
      return _fail(res, 'VERSION_CONFLICT', 'تغيّرت حالة أمر الصرف — أعد التحميل');
    }
    const auditEvent = await _audit(null, id, 'cancel', hdrRows[0].status, 'cancelled', actor, reason, null);
    _ok(res, { data: { id, status: 'cancelled' }, documentNumber: hdrRows[0].issue_number, status: 'cancelled', version: (Number(hdrRows[0].version) || 1) + 1, affectedStock: [], auditEvent }, { success: true });
  } catch(e) { _catch(res, e); }
});

// V5.9.7 — Reverse an already-issued/received stock issue. This is the
// "إرجاع إذن الصرف" the user asked for: it puts the qty back into the source
// warehouse, takes it out of the destination warehouse (if it was received),
// and posts a reversing GL journal mirroring the original posting. The
// underlying stock_issue row keeps its line totals (audit trail) but moves
// to status='reversed' with reversed_by / reversed_at / reverse_reason set.
router.post('/stock-issues/:id/reverse', MGR, async (req, res) => {
  try {
    const id = req.params.id;
    const { reason } = req.body || {};
    // Phase 0 §5 — reverser identity from the JWT, never the body.
    const reversedBy = _actor(req);
    // v5.10.40 — Reason is now MANDATORY for reversal (audit-trail
    // compliance: every accounting reversal must carry justification).
    // Trim to avoid whitespace-only inputs.
    const reasonText = String(reason || '').trim();
    const expectedVersion = _expectedVersion(req);
    if (!reasonText) {
      return _fail(res, 'VALIDATION_ERROR', 'سبب الإرجاع مطلوب — اشرح لماذا تُرجِع هذا الإذن لإكمال سجل التدقيق.');
    }
    const [hdrRows] = await db.query('SELECT * FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'not found' });
    const hdr = hdrRows[0];
    if (!req.guardTransfer(res, hdr.from_warehouse_id, hdr.to_warehouse_id)) return;
    // Phase 0 — partially_received transfers are reversible too.
    if (!TR.canReverse(hdr.status))
      return _fail(res, 'INVALID_STATE_TRANSITION', 'يمكن إرجاع الإذن فقط بعد الصرف أو الاستلام (issued / partially_received / received). الحالة الحالية: ' + hdr.status);

    const [items] = await db.query('SELECT * FROM stock_issue_items WHERE issue_id=?', [id]);
    if (!items.length) return _fail(res, 'VALIDATION_ERROR', 'no items');

    // Reverse the stock movements:
    //   1. PUT BACK what we took from the source (positive delta on the from-warehouse).
    //   2. TAKE BACK whatever was physically received at the destination
    //      (qty_received > 0 — covers both full and partial receipts).
    //
    // We use the original unit_cost stored on each line so the reversal lands
    // at the same valuation the issue posted at — keeps weighted-average sane.
    // v5.10.40 — Also write inventory_movements rows for the reversal so the
    // ledger shows the round-trip (transfer → reverse) clearly.
    const reverseNow = new Date();
    // v7.5 — the reversal is now ONE transaction: both warehouse deltas, the
    // ledger rows, the reversing GL journal and the status flip commit or
    // roll back together (this was the last non-atomic money path in the
    // module — _applyStockMovement used to run on the bare pool here). GL
    // failure is FATAL, mirroring the sibling /issue endpoint; the single
    // exemption is a deploy whose GL tables don't exist yet.
    const out = await db.withTransaction(async (conn) => {
      let totalCost = 0;
      const affectedStock = [];
      for (const it of items) {
        const qtyIssued   = Number(it.qty_issued)   || 0;
        const qtyReceived = Number(it.qty_received) || 0;
        const unitCost    = Number(it.unit_cost)    || 0;
        if (qtyIssued > 0) {
          const mvIn = await _applyStockMovement(hdr.from_warehouse_id, it.item_id, qtyIssued, unitCost,
                                    'stock_issue_reverse', id, reversedBy, conn);
          affectedStock.push({ warehouseId: hdr.from_warehouse_id, itemId: it.item_id, delta: qtyIssued, newQty: mvIn.newQty });
          totalCost += qtyIssued * unitCost;
          // Ledger entry — 'in' to source (returning the goods)
          try {
            const movId = 'MOV-SI-REV-IN-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
            await conn.query(
              'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) ' +
              'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
              [movId, reverseNow, it.item_id, it.item_name || '', 'in', qtyIssued,
               'إرجاع تحويل', reversedBy,
               'REVERSE: ' + (hdr.issue_number || id) + ' · ' + reasonText.slice(0, 200),
               hdr.from_warehouse_id, 'transfer_reverse', id]);
          } catch(_) {}
        }
        if (qtyReceived > 0) {
          const mvOut = await _applyStockMovement(hdr.to_warehouse_id, it.item_id, -qtyReceived, unitCost,
                                    'stock_issue_reverse', id, reversedBy, conn);
          affectedStock.push({ warehouseId: hdr.to_warehouse_id, itemId: it.item_id, delta: -qtyReceived, newQty: mvOut.newQty });
          // Ledger entry — 'out' from destination (taking the goods back)
          try {
            const movId = 'MOV-SI-REV-OUT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
            await conn.query(
              'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) ' +
              'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
              [movId, reverseNow, it.item_id, it.item_name || '', 'out', qtyReceived,
               'إرجاع تحويل', reversedBy,
               'REVERSE: ' + (hdr.issue_number || id) + ' · ' + reasonText.slice(0, 200),
               hdr.to_warehouse_id, 'transfer_reverse', id]);
          } catch(_) {}
        }
        // Phase 4B — restore the EXACT transferred lots: issued back to source,
        // received removed from the destination; re-check both invariants.
        const lmode = await L.getTrackingMode(conn, it.item_id);
        if (L.isTracked(lmode)) {
          await L.transferReverse(conn, { transferId: id, sourceWh: hdr.from_warehouse_id, destWh: hdr.to_warehouse_id, itemId: it.item_id, movementSeq: null, movementId: null, actor: reversedBy, occurredAt: reverseNow });
          if (qtyIssued > 0) await L.assertInvariant(conn, hdr.from_warehouse_id, it.item_id);
          if (qtyReceived > 0) await L.assertInvariant(conn, hdr.to_warehouse_id, it.item_id);
        }
      }

      // Post a reversing GL journal — debit Main Inventory, credit Branch
      // Inventory (mirror of the original /issue endpoint above).
      let reverseGlId = null;
      if (totalCost > 0.005) {
        const result = await gl.postJournal(conn, {
          referenceType: 'stock_issue_reverse',
          referenceId: id,
          description: `إرجاع إذن صرف ${hdr.issue_number}: ` + reasonText,
          postedBy: reversedBy,
          entries: [
            {
              accountCode: gl.CORE_ACCOUNTS.INVENTORY.code,
              debit: totalCost, credit: 0,
              brandId: hdr.brand_id,
              warehouseId: hdr.from_warehouse_id
            },
            {
              accountCode: gl.CORE_ACCOUNTS.BRANCH_INVENTORY.code,
              debit: 0, credit: totalCost,
              brandId: hdr.brand_id, branchId: hdr.branch_id,
              warehouseId: hdr.to_warehouse_id
            }
          ]
        });
        if (!result || !result.success) {
          const perr = (result && result.error) || 'unknown';
          if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(perr)) {
            console.warn('[stock-issue reverse ' + id + '] GL skipped — gl tables absent:', perr);
          } else {
            const e = new Error('GL_POSTING_FAILED: ' + perr); e.status = 400; throw e;
          }
        } else {
          reverseGlId = result.journalId;
        }
      }

      // State-guarded flip — a concurrent double-reverse rolls everything back.
      const fromStatus = hdr.status;
      const [flipRes] = await conn.query(
        `UPDATE stock_issues
         SET status='reversed', reversed_by=?, reversed_at=NOW(),
             reverse_reason=?, reverse_gl_journal_id=?, version = version + 1
         WHERE id=? AND status IN ('issued','partially_received','received') AND (? IS NULL OR version = ?)`,
        [reversedBy, reasonText.slice(0, 500), reverseGlId, id, expectedVersion, expectedVersion]);
      if (!flipRes || flipRes.affectedRows !== 1) {
        const e = new Error('تغيّرت حالة الإذن (إرجاع مكرر؟) — أعد التحميل');
        e.status = 409; e.code = 'state_changed'; throw e;
      }
      const auditEvent = await _audit(conn, id, 'reverse', fromStatus, 'reversed', reversedBy, reasonText, { reverseGlId, totalCost });
      return { reverseGlId, totalCost, affectedStock, newVersion: (Number(hdr.version) || 1) + 1, auditEvent };
    });

    _ok(res, {
      data: { id, status: 'reversed', reverseGlJournalId: out.reverseGlId, totalCost: out.totalCost },
      documentNumber: hdr.issue_number, status: 'reversed', version: out.newVersion,
      affectedStock: out.affectedStock, auditEvent: out.auditEvent,
    }, { success: true, reverseGlJournalId: out.reverseGlId, totalCost: out.totalCost });
  } catch(e) {
    console.error('[stock-issue reverse] error:', e);
    _catch(res, e);
  }
});

// V5.9.9 — Hard-delete a stock issue. Only allowed on drafts so the audit
// trail of any approved/issued/received/cancelled/reversed row stays intact.
// Cascade-delete the line items first (no FK CASCADE configured).
router.delete('/stock-issues/:id', MGR, async (req, res) => {
  try {
    const id = req.params.id;
    const actor = _actor(req);
    const [hdrRows] = await db.query('SELECT status, issue_number, from_warehouse_id, to_warehouse_id FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'not found' });
    if (!req.guardTransfer(res, hdrRows[0].from_warehouse_id, hdrRows[0].to_warehouse_id)) return;
    if (hdrRows[0].status !== 'draft') {
      return _fail(res, 'INVALID_STATE_TRANSITION', 'يمكن حذف الإذن فقط عندما يكون مسودة — استخدم الإلغاء أو الإرجاع. الحالة الحالية: ' + hdrRows[0].status);
    }
    // Audit the deletion BEFORE removing the row (the event row outlives it).
    const auditEvent = await _audit(null, id, 'delete', 'draft', null, actor, '', { issueNumber: hdrRows[0].issue_number });
    await db.query('DELETE FROM stock_issue_items WHERE issue_id=?', [id]);
    await db.query('DELETE FROM stock_issues WHERE id=?', [id]);
    _ok(res, { data: { id, status: 'deleted' }, documentNumber: hdrRows[0].issue_number, status: 'deleted', version: null, affectedStock: [], auditEvent }, { success: true });
  } catch(e) {
    console.error('[stock-issue delete] error:', e);
    _catch(res, e);
  }
});

// V5.9.9 — Branch-scoped inbox of incoming transfers.
//   The destination branch sees `issued` (pending receive) and recently-
//   completed `received` rows in their شاشة النواقص. Resolves the
//   destination branch via warehouses.branch_id when the row's
//   stock_issues.branch_id is null.
//
//   Audience: branch users — admin can pass ?branchId or ?warehouseId to
//   inspect any branch's inbox. Without those params we expect the caller
//   to be authenticated and we fall back to the JWT branch_id.
router.get('/incoming-transfers', async (req, res) => {
  try {
    const { branchId, warehouseId, status } = req.query;
    const userBranch = (req.user && (req.user.branch_id || req.user.branchId)) || '';
    const filterBranch = branchId || userBranch;
    const filterWh     = warehouseId || '';

    if (!filterBranch && !filterWh) {
      // Empty inbox is the right answer for a user with no branch context —
      // never silently leak every branch's transfers.
      return res.json([]);
    }

    let sql = `
      SELECT si.*,
             wf.name AS from_warehouse_name, wf.code AS from_warehouse_code,
             wt.name AS to_warehouse_name,   wt.code AS to_warehouse_code,
             wt.branch_id AS to_branch_id,
             b.name AS brand_name,
             COALESCE(brn.name, brwh.name) AS branch_name,
             COALESCE(uc.full_name, uc.username, si.created_by)  AS created_by_name,
             COALESCE(ua.full_name, ua.username, si.approved_by) AS approved_by_name,
             COALESCE(ui.full_name, ui.username, si.issued_by)   AS issued_by_name,
             (SELECT COUNT(*) FROM stock_issue_items WHERE issue_id=si.id) AS line_count
      FROM stock_issues si
      LEFT JOIN warehouses wf ON wf.id = si.from_warehouse_id
      LEFT JOIN warehouses wt ON wt.id = si.to_warehouse_id
      LEFT JOIN brands b      ON b.id  = si.brand_id
      LEFT JOIN branches brn  ON brn.id = si.branch_id
      LEFT JOIN branches brwh ON brwh.id = wt.branch_id
      LEFT JOIN users uc ON uc.username = si.created_by
      LEFT JOIN users ua ON ua.username = si.approved_by
      LEFT JOIN users ui ON ui.username = si.issued_by
      WHERE si.status IN ('issued','partially_received','received')`;
    const params = [];
    if (filterWh) {
      sql += ' AND si.to_warehouse_id = ?';
      params.push(filterWh);
    } else {
      // Match either the row's explicit branch_id OR the destination
      // warehouse's branch_id — both should resolve to the same branch.
      sql += ' AND (si.branch_id = ? OR wt.branch_id = ?)';
      params.push(filterBranch, filterBranch);
    }
    if (status) { sql += ' AND si.status = ?'; params.push(status); }
    // Scope: restrict the inbox to destination warehouses the caller may access.
    const sc = req.whScopeClause('si.to_warehouse_id');
    if (sc.sql) { sql += sc.sql; params.push(...sc.params); }
    // Hide `received` rows older than 7 days so the inbox doesn't grow forever.
    // Keep open transfers (issued / partially_received) always visible; only
    // age out fully-received rows after 7 days.
    sql += " AND (si.status IN ('issued','partially_received') OR si.received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))";
    sql += ' ORDER BY si.issued_at DESC, si.created_at DESC LIMIT 100';

    const [rows] = await db.query(sql, params);

    // Eagerly attach line items so the receive modal opens with no extra
    // round-trip. Small data — 100 rows × ~10 items max.
    const ids = rows.map(r => r.id);
    let itemsByIssue = {};
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const [allItems] = await db.query(
        `SELECT sii.*, i.name AS item_name, i.unit AS item_unit
         FROM stock_issue_items sii
         LEFT JOIN inv_items i ON i.id = sii.item_id
         WHERE sii.issue_id IN (${placeholders})
         ORDER BY sii.issue_id, sii.id`, ids);
      allItems.forEach(it => {
        if (!itemsByIssue[it.issue_id]) itemsByIssue[it.issue_id] = [];
        itemsByIssue[it.issue_id].push(it);
      });
    }
    rows.forEach(r => { r.items = itemsByIssue[r.id] || []; });

    res.json(rows);
  } catch(e) {
    console.error('[incoming-transfers] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2 — PRODUCTION ORDERS
// ═══════════════════════════════════════════════════════════════════════

router.get('/production-orders', async (req, res) => {
  try {
    const { status, warehouseId, dateFrom, dateTo, brandId, branchId } = req.query;
    let sql = `
      SELECT po.*,
             b.product_id AS bom_product_id,
             i.name AS product_name, i.unit AS product_unit,
             w.name AS warehouse_name, w.code AS warehouse_code,
             wo.name AS output_warehouse_name,
             br.name AS brand_name,
             bn.name AS branch_name
      FROM production_orders po
      LEFT JOIN bom b ON b.id = po.bom_id
      LEFT JOIN inv_items i ON i.id = po.product_id
      LEFT JOIN warehouses w ON w.id = po.warehouse_id
      LEFT JOIN warehouses wo ON wo.id = po.output_warehouse_id
      LEFT JOIN brands br ON br.id = po.brand_id
      LEFT JOIN branches bn ON bn.id = po.branch_id
      WHERE 1=1`;
    const params = [];
    if (status)      { sql += ' AND po.status=?'; params.push(status); }
    if (warehouseId) { sql += ' AND po.warehouse_id=?'; params.push(warehouseId); }
    if (brandId)     { sql += ' AND po.brand_id=?';  params.push(brandId); }
    if (branchId)    { sql += ' AND po.branch_id=?'; params.push(branchId); }
    if (dateFrom)    { sql += ' AND po.planned_date >= ?'; params.push(dateFrom); }
    if (dateTo)      { sql += ' AND po.planned_date <= ?'; params.push(dateTo); }
    sql += ' ORDER BY po.created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/production-orders/:id', async (req, res) => {
  try {
    const [hdrRows] = await db.query(`
      SELECT po.*, i.name AS product_name, i.unit AS product_unit,
             w.name AS warehouse_name
      FROM production_orders po
      LEFT JOIN inv_items i ON i.id = po.product_id
      LEFT JOIN warehouses w ON w.id = po.warehouse_id
      WHERE po.id=?`, [req.params.id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    const [consumption] = await db.query(`
      SELECT pc.*, i.name AS item_name, i.unit AS item_unit
      FROM production_consumption pc
      LEFT JOIN inv_items i ON i.id = pc.item_id
      WHERE pc.production_order_id=?`, [req.params.id]);
    const [output] = await db.query(`
      SELECT po.*, i.name AS item_name, i.unit AS item_unit
      FROM production_output po
      LEFT JOIN inv_items i ON i.id = po.item_id
      WHERE po.production_order_id=?`, [req.params.id]);
    res.json({ ...hdrRows[0], consumption, output });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// v7.7 — Materials availability for an EXISTING order (read-only).
// Compares each pre-populated planned consumption row against live warehouse
// stock. Mirrors the availability check the RELEASE transaction enforces
// (warehouse-ops.js release loop), so the preview matches what release will do.
router.get('/production-orders/:id/availability', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT pc.item_id, i.name AS item_name, i.unit AS item_unit,
             pc.qty_planned AS required, pc.unit_cost, pc.warehouse_id,
             COALESCE(ws.qty,0) AS available
      FROM production_consumption pc
      LEFT JOIN inv_items i ON i.id = pc.item_id
      LEFT JOIN warehouse_stock ws ON ws.item_id = pc.item_id AND ws.warehouse_id = pc.warehouse_id
      WHERE pc.production_order_id = ?`, [req.params.id]);
    const items = rows.map(r => {
      const required = Number(r.required) || 0;
      const available = Number(r.available) || 0;
      const unitCost = Number(r.unit_cost) || 0;
      const delta = available - required;
      return {
        itemId: r.item_id, itemName: r.item_name || r.item_id, itemUnit: r.item_unit || '',
        required, available, delta, unitCost, lineCost: required * unitCost,
        warehouseId: r.warehouse_id, status: (delta >= 0 ? 'ok' : 'short')
      };
    });
    items.sort((a, b) => a.delta - b.delta);
    const shortageCount = items.filter(x => x.status === 'short').length;
    const reservedValue = items.reduce((s, x) => s + x.lineCost, 0);
    res.json({ items, summary: { shortageCount, allAvailable: shortageCount === 0, itemCount: items.length, reservedValue } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// v7.7 — Materials availability PREVIEW before an order exists (read-only).
// Reuses the create-time expansion math (batches × line × (1+waste%)) then
// LEFT JOINs live stock, so the create wizard's "materials" step works up front.
router.post('/production-orders/preview-availability', async (req, res) => {
  try {
    const { bomId, qtyPlanned, warehouseId } = req.body;
    if (!bomId) return res.status(400).json({ error: 'bomId required' });
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId required' });
    const qtyPlan = Number(qtyPlanned) || 0;
    if (qtyPlan <= 0) return res.status(400).json({ error: 'qtyPlanned must be positive' });

    const [bomRows] = await db.query('SELECT id, yield_quantity FROM bom WHERE id=? AND is_active=1', [bomId]);
    if (!bomRows.length) return res.status(404).json({ error: 'bom not found or inactive' });
    const yieldQ = Number(bomRows[0].yield_quantity) || 1;
    const batches = qtyPlan / yieldQ;
    const [lines] = await db.query('SELECT * FROM bom_lines WHERE bom_id=?', [bomId]);
    if (!lines.length) return res.status(400).json({ error: 'bom has no components' });

    const items = [];
    for (const l of lines) {
      const qtyBase = Number(l.quantity) * batches;
      const waste = Number(l.waste_pct || 0) / 100;
      const required = qtyBase * (1 + waste);
      const unitCost = await _getEffectiveCost(l.component_item_id, warehouseId);
      const [stk] = await db.query(
        'SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1',
        [warehouseId, l.component_item_id]);
      const available = stk.length ? Number(stk[0].qty) : 0;
      const [it] = await db.query('SELECT name, unit FROM inv_items WHERE id=? LIMIT 1', [l.component_item_id]);
      const delta = available - required;
      items.push({
        itemId: l.component_item_id,
        itemName: it.length ? it[0].name : l.component_item_id,
        itemUnit: it.length ? (it[0].unit || '') : '',
        required, available, delta, unitCost, lineCost: required * unitCost,
        status: (delta >= 0 ? 'ok' : 'short')
      });
    }
    items.sort((a, b) => a.delta - b.delta);
    const shortageCount = items.filter(x => x.status === 'short').length;
    const reservedValue = items.reduce((s, x) => s + x.lineCost, 0);
    res.json({ items, summary: { shortageCount, allAvailable: shortageCount === 0, itemCount: items.length, reservedValue, batches } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create production order from BOM
router.post('/production-orders', async (req, res) => {
  try {
    // ── Multi-item batch (new format: items array) ──────────────────────────
    if (req.body.items && Array.isArray(req.body.items) && req.body.items.length > 0) {
      const { warehouseId, outputWarehouseId, plannedDate, brandId, branchId,
              notes, createdBy, priority, costBreakdown } = req.body;
      if (!warehouseId) return res.status(400).json({ error: 'warehouseId required' });
      const whIds = [warehouseId];
      if (outputWarehouseId && String(outputWarehouseId) !== String(warehouseId)) whIds.push(outputWarehouseId);
      const [whRows] = await db.query('SELECT id FROM warehouses WHERE id IN (?)', [whIds]);
      if (whRows.length !== whIds.length)
        return res.status(400).json({ error: 'مستودع غير موجود — تحقق من مستودع المواد ومستودع الإخراج', code: 'warehouse-not-found' });
      let _cbJson = null;
      try { _cbJson = costBreakdown ? JSON.stringify(costBreakdown) : null; } catch(_) {}
      const _priority = (typeof priority === 'string' && priority) ? priority.slice(0,20) : 'normal';
      const orders = [];
      for (const item of req.body.items) {
        const { bomId: itemBomId, qtyPlanned: itemQty, allowedScrapPct: itemScrap, batchNumber: itemBatch } = item;
        if (!itemBomId || !itemQty || Number(itemQty) <= 0) continue;
        const [bomRows] = await db.query('SELECT id,product_id,yield_quantity FROM bom WHERE id=? AND is_active=1', [itemBomId]);
        if (!bomRows.length) continue;
        const bom = bomRows[0];
        const [lines] = await db.query('SELECT * FROM bom_lines WHERE bom_id=?', [itemBomId]);
        if (!lines.length) continue;
        const ymd = _ymd();
        const serial = await _nextSerial('production_counter', ymd);
        const orderNumber = 'PRD-' + ymd + '-' + String(serial).padStart(4,'0');
        const id = 'PO-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
        const qtyPlan = Number(itemQty);
        const batches = qtyPlan / (Number(bom.yield_quantity) || 1);
        const _scrapPct = (itemScrap != null && !isNaN(Number(itemScrap))) ? Number(itemScrap) : 0;
        const _batchNo  = (typeof itemBatch === 'string' && itemBatch.trim()) ? itemBatch.trim().slice(0,80) : null;
        await db.query(
          `INSERT INTO production_orders
           (id,order_number,bom_id,product_id,warehouse_id,output_warehouse_id,brand_id,branch_id,
            qty_planned,status,notes,created_by,planned_date,priority,allowed_scrap_pct,batch_number,cost_breakdown)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, orderNumber, itemBomId, bom.product_id, warehouseId, outputWarehouseId || warehouseId,
           brandId||null, branchId||null, qtyPlan, 'planned', notes||'', createdBy||'',
           plannedDate || new Date().toISOString().slice(0,10),
           _priority, _scrapPct, _batchNo, _cbJson]);
        for (const l of lines) {
          const qtyBase = Number(l.quantity) * batches;
          const waste   = Number(l.waste_pct || 0) / 100;
          const qtyW    = qtyBase * (1 + waste);
          const unitCost = await _getEffectiveCost(l.component_item_id, warehouseId);
          await db.query(
            `INSERT INTO production_consumption
             (id,production_order_id,item_id,warehouse_id,qty_planned,unit_cost,total_cost)
             VALUES (?,?,?,?,?,?,?)`,
            ['PCC-'+Date.now()+'-'+Math.random().toString(36).slice(2,7),
             id, l.component_item_id, warehouseId, qtyW, unitCost, qtyW*unitCost]);
        }
        orders.push({ id, orderNumber });
      }
      if (!orders.length)
        return res.status(400).json({ error: 'لم يُنشأ أي أمر — تحقق من صحة BOMs والكميات' });
      return res.json({ success: true, orders, count: orders.length, orderNumber: orders[0].orderNumber });
    }
    // ── Legacy single-item (backward compat) ───────────────────────────────
    const { bomId, warehouseId, outputWarehouseId, qtyPlanned, plannedDate, brandId, branchId, notes, createdBy,
            priority, allowedScrapPct, batchNumber, costBreakdown } = req.body;
    if (!bomId) return res.status(400).json({ error: 'bomId required' });
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId (raw materials source) required' });
    if (!qtyPlanned || Number(qtyPlanned) <= 0) return res.status(400).json({ error: 'qtyPlanned must be positive' });

    // v7.5 — the warehouses must exist: a phantom id used to ride into
    // production_orders/production_consumption and fail confusingly later.
    {
      const whIds = [warehouseId];
      if (outputWarehouseId && String(outputWarehouseId) !== String(warehouseId)) whIds.push(outputWarehouseId);
      const [whRows] = await db.query('SELECT id FROM warehouses WHERE id IN (?)', [whIds]);
      if (whRows.length !== whIds.length) {
        return res.status(400).json({ error: 'مستودع غير موجود — تحقق من مستودع المواد ومستودع الإخراج', code: 'warehouse-not-found' });
      }
    }

    const [bomRows] = await db.query(
      'SELECT id, product_id, yield_quantity FROM bom WHERE id=? AND is_active=1', [bomId]);
    if (!bomRows.length) return res.status(404).json({ error: 'bom not found or inactive' });
    const bom = bomRows[0];
    const [lines] = await db.query('SELECT * FROM bom_lines WHERE bom_id=?', [bomId]);
    if (!lines.length) return res.status(400).json({ error: 'bom has no components' });

    const ymd = _ymd();
    const serial = await _nextSerial('production_counter', ymd);
    const orderNumber = 'PRD-' + ymd + '-' + String(serial).padStart(4,'0');
    const id = 'PO-' + Date.now();
    const qtyPlan = Number(qtyPlanned);
    const yieldQ = Number(bom.yield_quantity) || 1;
    const batches = qtyPlan / yieldQ;  // how many BOM runs

    // v7.7 — optional create-wizard metadata (all columns are nullable/defaulted)
    let _cbJson = null;
    if (costBreakdown != null) {
      try { _cbJson = (typeof costBreakdown === 'string') ? costBreakdown : JSON.stringify(costBreakdown); } catch(_) { _cbJson = null; }
    }
    const _priority = (typeof priority === 'string' && priority) ? priority.slice(0,20) : 'normal';
    const _scrapPct = (allowedScrapPct != null && !isNaN(Number(allowedScrapPct))) ? Number(allowedScrapPct) : 0;
    const _batchNo  = (typeof batchNumber === 'string' && batchNumber.trim()) ? batchNumber.trim().slice(0,80) : null;

    await db.query(
      `INSERT INTO production_orders
       (id, order_number, bom_id, product_id, warehouse_id, output_warehouse_id, brand_id, branch_id,
        qty_planned, status, notes, created_by, planned_date,
        priority, allowed_scrap_pct, batch_number, cost_breakdown)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, orderNumber, bomId, bom.product_id, warehouseId, outputWarehouseId || warehouseId,
       brandId || null, branchId || null, qtyPlan, 'planned', notes || '', createdBy || '',
       plannedDate || new Date().toISOString().slice(0,10),
       _priority, _scrapPct, _batchNo, _cbJson]);

    // Pre-populate planned consumption rows
    for (const l of lines) {
      const qtyBase = Number(l.quantity) * batches;
      const waste = Number(l.waste_pct || 0) / 100;
      const qtyWithWaste = qtyBase * (1 + waste);
      const unitCost = await _getEffectiveCost(l.component_item_id, warehouseId);
      await db.query(
        `INSERT INTO production_consumption
         (id, production_order_id, item_id, warehouse_id, qty_planned, unit_cost, total_cost)
         VALUES (?,?,?,?,?,?,?)`,
        ['PCC-' + Date.now() + '-' + Math.random().toString(36).slice(2,7),
         id, l.component_item_id, warehouseId, qtyWithWaste, unitCost, qtyWithWaste * unitCost]);
    }

    res.json({ success: true, id, orderNumber });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Release — consume raw materials, post to WIP
router.post('/production-orders/:id/release', BACKOFFICE, async (req, res) => {
  try {
    const id = req.params.id;
    const { releasedBy, laborCost, overheadCost, costBreakdown } = req.body;
    const [hdrRows] = await db.query('SELECT * FROM production_orders WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    const hdr = hdrRows[0];
    if (hdr.status !== 'planned') return res.status(400).json({ error: 'only planned can be released' });
    // v7.7 — optional descriptive cost breakdown (display only; scalars below drive GL)
    let _relCbJson;
    if (costBreakdown != null) {
      try { _relCbJson = (typeof costBreakdown === 'string') ? costBreakdown : JSON.stringify(costBreakdown); } catch(_) { _relCbJson = undefined; }
    }

    const [cons] = await db.query('SELECT * FROM production_consumption WHERE production_order_id=?', [id]);
    if (!cons.length) return res.status(400).json({ error: 'no consumption lines' });

    const labor = Number(laborCost) || 0;
    const overhead = Number(overheadCost) || 0;
    const releaseNow = new Date();

    // v7.4 — the ENTIRE release is now ATOMIC: stock deduction + consumption
    // rows + ledger movements + GL journal + status flip all commit together
    // or not at all. Critically, a GL failure now ROLLS BACK the stock
    // movement instead of being swallowed (console.warn) — so inventory can
    // never drift away from the ledger. Availability is re-checked inside the
    // transaction for a consistent snapshot.
    const out = await db.withTransaction(async (conn) => {
      for (const c of cons) {
        const [stk] = await conn.query(
          'SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?',
          [c.warehouse_id, c.item_id]);
        const avail = stk.length ? Number(stk[0].qty) : 0;
        if (avail < Number(c.qty_planned)) {
          const e = new Error(`insufficient stock for ${c.item_id}: avail ${avail}, need ${c.qty_planned}`);
          e.status = 400; throw e;
        }
      }

      let materialsCost = 0;
      const glLines = [];
      for (const c of cons) {
        const qty = Number(c.qty_planned);
        const unitCost = Number(c.unit_cost);
        const lineTotal = qty * unitCost;
        materialsCost += lineTotal;
        await _applyStockMovement(c.warehouse_id, c.item_id, -qty, unitCost,
                                  'production_release', id, releasedBy || '', conn);
        await conn.query(
          `UPDATE production_consumption SET qty_actual=?, total_cost=?, consumed_at=NOW() WHERE id=?`,
          [qty, lineTotal, c.id]);
        // Inventory movement: consumed-for-production (reason "إنتاج" so the
        // /live-report bucket() classifies it as a production movement).
        let _itnm = '';
        try { const [itName] = await conn.query('SELECT name FROM inv_items WHERE id = ?', [c.item_id]); _itnm = itName.length ? itName[0].name : ''; } catch(_) {}
        const movId = 'MOV-PROD-OUT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        try {
          await conn.query(
            'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [movId, releaseNow, c.item_id, _itnm, 'out', qty,
             'إنتاج', releasedBy || '', 'PRODUCTION: ' + (hdr.order_number || id),
             c.warehouse_id, 'production', id]);
        } catch(e) {
          await conn.query(
            'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [movId, releaseNow, c.item_id, _itnm, 'out', qty, 'إنتاج', releasedBy || '',
             'PRODUCTION: ' + (hdr.order_number || id), c.warehouse_id]);
        }
        // Phase 4B — tracked component: FEFO-consume + record genealogy + invariant.
        const lmode = await L.getTrackingMode(conn, c.item_id);
        if (L.isTracked(lmode)) {
          const seq = await _seqOf(conn, movId);
          const alloc = await L.allocateOutbound(conn, { warehouseId: c.warehouse_id, itemId: c.item_id, qty, trackingMode: lmode, movementSeq: seq, movementId: movId, referenceType: 'production_consume', referenceId: id, reason: 'استهلاك إنتاج', actor: releasedBy || '', occurredAt: releaseNow });
          for (const a of alloc.allocations) {
            await conn.query('INSERT INTO work_order_lot_consumption (id, work_order_id, component_item_id, lot_id, warehouse_id, qty) VALUES (?,?,?,?,?,?)', ['WOLC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), id, c.item_id, a.lotId, c.warehouse_id, a.qty]);
          }
          await L.assertInvariant(conn, c.warehouse_id, c.item_id);
        }
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.WIP.code, debit: lineTotal, credit: 0,
                       brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: c.warehouse_id });
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: 0, credit: lineTotal,
                       brandId: hdr.brand_id, warehouseId: c.warehouse_id });
      }

      if (labor > 0) {
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.WIP.code, debit: labor, credit: 0,
                       brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: hdr.warehouse_id });
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.LABOR_APPLIED.code, debit: 0, credit: labor,
                       brandId: hdr.brand_id });
      }
      if (overhead > 0) {
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.WIP.code, debit: overhead, credit: 0,
                       brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: hdr.warehouse_id });
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.OVERHEAD_APPLIED.code, debit: 0, credit: overhead,
                       brandId: hdr.brand_id });
      }

      // GL is fatal ONLY when there is a non-zero journal to post — a genuine
      // zero-cost release (all materials cost 0, no labor/overhead) posts no
      // journal and is allowed, preserving prior behavior.
      let glId = null;
      const totalCost = materialsCost + labor + overhead;
      if (totalCost > 0.005) {
        const glRes = await gl.postJournal(conn, {
          referenceType: 'production_release',
          referenceId: id,
          description: `إطلاق أمر إنتاج ${hdr.order_number}`,
          postedBy: releasedBy || '',
          entries: glLines
        });
        if (!glRes || !glRes.success) {
          const e = new Error('فشل ترحيل قيد إطلاق الإنتاج: ' + ((glRes && glRes.error) || 'خطأ غير معروف'));
          e.status = 400; throw e;
        }
        glId = glRes.journalId;
      }

      // v7.5 — state-guarded flip: two concurrent releases both passing the
      // pre-transaction status read would double-consume materials; the
      // WHERE status='planned' + affectedRows check rolls the loser back.
      const [relRes] = await conn.query(
        `UPDATE production_orders
         SET status='released', released_by=?, released_at=NOW(),
             materials_cost=?, labor_cost=?, overhead_cost=?, total_cost=?, gl_release_id=?` +
             (_relCbJson !== undefined ? ', cost_breakdown=?' : '') +
        ` WHERE id=? AND status='planned'`,
        _relCbJson !== undefined
          ? [releasedBy || '', materialsCost, labor, overhead, totalCost, glId, _relCbJson, id]
          : [releasedBy || '', materialsCost, labor, overhead, totalCost, glId, id]);
      if (!relRes || relRes.affectedRows !== 1) {
        const e = new Error('سبق إطلاق هذا الأمر (طلب متزامن؟) — أعد التحميل');
        e.status = 409; throw e;
      }

      return { materialsCost, totalCost, glId };
    });

    res.json({ success: true, materialsCost: out.materialsCost, laborCost: labor, overheadCost: overhead, totalCost: out.totalCost, glJournalId: out.glId });
  } catch(e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Complete — transfer WIP to Finished Goods
router.post('/production-orders/:id/complete', BACKOFFICE, async (req, res) => {
  try {
    const id = req.params.id;
    const { completedBy, qtyProduced, qtyScrap, batchNumber, expiryDate } = req.body;
    const [hdrRows] = await db.query('SELECT * FROM production_orders WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    const hdr = hdrRows[0];
    if (hdr.status !== 'released') return res.status(400).json({ error: 'only released can be completed' });

    const qtyOut = Number(qtyProduced);
    const qtyScrapped = Number(qtyScrap) || 0;
    if (qtyOut <= 0) return res.status(400).json({ error: 'qtyProduced must be positive' });

    const wipTotal = Number(hdr.total_cost) || 0;
    // Unit cost = total WIP / produced qty (scrap is absorbed — standard accounting)
    const unitCost = qtyOut > 0 ? (wipTotal / qtyOut) : 0;
    const outputWh = hdr.output_warehouse_id || hdr.warehouse_id;
    const completeNow = new Date();

    // v7.4 — atomic completion: finished-goods stock + ledger + output row +
    // GL (Dr Finished Goods / Cr WIP) + status flip all commit together. A GL
    // failure now rolls back the finished-goods movement (no ledger drift).
    const out = await db.withTransaction(async (conn) => {
      // Add finished goods to inventory (WAC updated automatically)
      await _applyStockMovement(outputWh, hdr.product_id, qtyOut, unitCost,
                                'production_complete', id, completedBy || '', conn);

      // Inventory movement: production output ('in' to the output warehouse,
      // reason "إنتاج" so the destination ledger shows the finished good).
      let _prodNm = '';
      try { const [prodName] = await conn.query('SELECT name FROM inv_items WHERE id = ? UNION ALL SELECT name FROM menu WHERE id = ?', [hdr.product_id, hdr.product_id]); _prodNm = prodName.length ? prodName[0].name : ''; } catch(_) {}
      const movId = 'MOV-PROD-IN-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      try {
        await conn.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [movId, completeNow, hdr.product_id, _prodNm, 'in', qtyOut,
           'إنتاج', completedBy || '', 'PRODUCTION: ' + (hdr.order_number || id),
           outputWh, 'production', id]);
      } catch(e) {
        await conn.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [movId, completeNow, hdr.product_id, _prodNm, 'in', qtyOut, 'إنتاج', completedBy || '',
           'PRODUCTION: ' + (hdr.order_number || id), outputWh]);
      }

      // Record output row
      await conn.query(
        `INSERT INTO production_output
         (id, production_order_id, item_id, warehouse_id, qty, unit_cost, total_cost,
          batch_number, expiry_date, produced_at)
         VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
        ['POUT-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
         id, hdr.product_id, outputWh, qtyOut, unitCost, wipTotal,
         batchNumber || null, expiryDate || null]);

      // Phase 4B — tracked finished good: create the output lot from batch/expiry,
      // link it to the consumed component lots (backward genealogy), check invariant.
      const _fgMode = await L.getTrackingMode(conn, hdr.product_id);
      if (L.isTracked(_fgMode)) {
        if (!String(batchNumber || '').trim()) { const e = new Error('رقم الدفعة/التشغيلة مطلوب لمنتَج نهائي يخضع لتتبع الدفعات'); e.status = 400; e.code = 'LOT_REQUIRED'; throw e; }
        const seq = await _seqOf(conn, movId);
        const rcv = await L.receiveInbound(conn, { warehouseId: outputWh, itemId: hdr.product_id, qty: qtyOut, lot: { lotNumber: batchNumber, expiryDate: expiryDate || null, unitCost, sourceType: 'production', sourceId: id }, trackingMode: _fgMode, movementSeq: seq, movementId: movId, referenceType: 'production_output', referenceId: id, reason: 'إنتاج', actor: completedBy || '', occurredAt: completeNow });
        const [comp] = await conn.query('SELECT lot_id, qty FROM work_order_lot_consumption WHERE work_order_id=?', [id]);
        for (const cl of comp) {
          await conn.query('INSERT INTO production_output_lots (id, work_order_id, output_lot_id, component_lot_id, qty) VALUES (?,?,?,?,?)', ['POL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), id, rcv.lotId, cl.lot_id, cl.qty]);
        }
        await L.assertInvariant(conn, outputWh, hdr.product_id);
      }

      // GL: Dr Finished Goods / Cr WIP — fatal only when there is value to move.
      let glId = null;
      if (wipTotal > 0.005) {
        const glRes = await gl.postJournal(conn, {
          referenceType: 'production_complete',
          referenceId: id,
          description: `إكمال إنتاج ${hdr.order_number} — كمية ${qtyOut}`,
          postedBy: completedBy || '',
          entries: [
            { accountCode: gl.CORE_ACCOUNTS.FINISHED_GOODS.code, debit: wipTotal, credit: 0,
              brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: outputWh },
            { accountCode: gl.CORE_ACCOUNTS.WIP.code, debit: 0, credit: wipTotal,
              brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: hdr.warehouse_id }
          ]
        });
        if (!glRes || !glRes.success) {
          const e = new Error('فشل ترحيل قيد إكمال الإنتاج: ' + ((glRes && glRes.error) || 'خطأ غير معروف'));
          e.status = 400; throw e;
        }
        glId = glRes.journalId;
      }

      // v7.4 (G2) — yield % = produced / planned (informational; never blocks).
      const _plannedQ = Number(hdr.qty_planned) || 0;
      const _yieldPct = _plannedQ > 0 ? Math.round((qtyOut / _plannedQ) * 10000) / 100 : null;
      // v7.5 — state-guarded flip (mirror of release): a concurrent double-
      // complete rolls back instead of double-moving WIP → Finished Goods.
      const [cmpRes] = await conn.query(
        `UPDATE production_orders
         SET status='completed', completed_by=?, completed_at=NOW(),
             qty_produced=?, qty_scrap=?, unit_cost=?, yield_pct=?, gl_complete_id=?
         WHERE id=? AND status='released'`,
        [completedBy || '', qtyOut, qtyScrapped, unitCost, _yieldPct, glId, id]);
      if (!cmpRes || cmpRes.affectedRows !== 1) {
        const e = new Error('سبق إكمال هذا الأمر (طلب متزامن؟) — أعد التحميل');
        e.status = 409; throw e;
      }

      return { glId, yieldPct: _yieldPct };
    });

    res.json({ success: true, qtyProduced: qtyOut, unitCost, totalCost: wipTotal, yieldPct: out.yieldPct, glJournalId: out.glId });
  } catch(e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Cancel
router.post('/production-orders/:id/cancel', MGR, async (req, res) => {
  try {
    const id = req.params.id;
    const [r] = await db.query('SELECT status FROM production_orders WHERE id=?', [id]);
    if (!r.length) return res.status(404).json({ error: 'not found' });
    if (r[0].status !== 'planned') return res.status(400).json({ error: 'only planned can be cancelled' });
    await db.query(`UPDATE production_orders SET status='cancelled' WHERE id=?`, [id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// v7.4 (F2) — Reverse a RELEASED production order. Closes the operational gap
// where a mistakenly-released order (or an aborted production run) had no undo:
// previously only 'planned' orders could be cancelled, trapping consumed stock.
// This atomically PUTS BACK the consumed raw materials, posts a reversing GL
// journal (Dr Inventory / Cr WIP for materials; Dr Labor/Overhead-Applied /
// Cr WIP for the applied costs), and sets the order to 'cancelled'. Completed
// orders are NOT reversible here (finished goods may already be sold) — they
// require an explicit inventory/GL adjustment instead.
router.post('/production-orders/:id/reverse', MGR, async (req, res) => {
  try {
    const id = req.params.id;
    const { reversedBy, reason } = req.body || {};
    const reasonText = String(reason || '').trim();
    if (!reasonText) {
      return res.status(400).json({ error: 'سبب الإرجاع مطلوب لإكمال سجل التدقيق.', code: 'REASON_REQUIRED' });
    }
    const [hdrRows] = await db.query('SELECT * FROM production_orders WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    const hdr = hdrRows[0];
    if (hdr.status !== 'released') {
      return res.status(400).json({ error: 'يمكن إرجاع أمر الإنتاج فقط وهو في حالة "مُطلَق" (released). الأوامر المكتملة تتطلب تسوية يدوية.' });
    }
    const [cons] = await db.query('SELECT * FROM production_consumption WHERE production_order_id=?', [id]);

    const out = await db.withTransaction(async (conn) => {
      const reverseNow = new Date();
      const glLines = [];
      let materialsCost = 0;
      for (const c of cons) {
        const qty = Number(c.qty_actual != null ? c.qty_actual : c.qty_planned) || 0;
        if (qty <= 0) continue;
        const unitCost = Number(c.unit_cost) || 0;
        const lineTotal = qty * unitCost;
        materialsCost += lineTotal;
        // Put the raw material back into the consuming warehouse.
        await _applyStockMovement(c.warehouse_id, c.item_id, qty, unitCost,
                                  'production_reverse', id, reversedBy || '', conn);
        const movId = 'MOV-PROD-REV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        try {
          await conn.query(
            'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [movId, reverseNow, c.item_id, '', 'in', qty, 'إرجاع إنتاج', reversedBy || '',
             'REVERSE PRODUCTION: ' + (hdr.order_number || id) + ' · ' + reasonText.slice(0, 150),
             c.warehouse_id, 'production_reverse', id]);
        } catch(e) {
          await conn.query(
            'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [movId, reverseNow, c.item_id, '', 'in', qty, 'إرجاع إنتاج', reversedBy || '',
             'REVERSE PRODUCTION: ' + (hdr.order_number || id), c.warehouse_id]);
        }
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: lineTotal, credit: 0,
                       brandId: hdr.brand_id, warehouseId: c.warehouse_id });
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.WIP.code, debit: 0, credit: lineTotal,
                       brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: c.warehouse_id });
      }
      // Phase 4B — restore the EXACT consumed component lots (once for the order),
      // then re-check the invariant for every tracked component+warehouse.
      {
        const [tc] = await conn.query('SELECT DISTINCT warehouse_id, component_item_id FROM work_order_lot_consumption WHERE work_order_id=?', [id]);
        if (tc.length) {
          await L.reverseAllocation(conn, { referenceType: 'production_consume', referenceId: id, movementSeq: null, movementId: null, actor: reversedBy || '', occurredAt: reverseNow });
          for (const t of tc) await L.assertInvariant(conn, t.warehouse_id, t.component_item_id);
        }
      }
      // Reverse the applied labor + overhead back out of WIP.
      const labor = Number(hdr.labor_cost) || 0;
      const overhead = Number(hdr.overhead_cost) || 0;
      if (labor > 0) {
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.LABOR_APPLIED.code, debit: labor, credit: 0, brandId: hdr.brand_id });
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.WIP.code, debit: 0, credit: labor,
                       brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: hdr.warehouse_id });
      }
      if (overhead > 0) {
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.OVERHEAD_APPLIED.code, debit: overhead, credit: 0, brandId: hdr.brand_id });
        glLines.push({ accountCode: gl.CORE_ACCOUNTS.WIP.code, debit: 0, credit: overhead,
                       brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: hdr.warehouse_id });
      }

      let glId = null;
      if ((materialsCost + labor + overhead) > 0.005) {
        const glRes = await gl.postJournal(conn, {
          referenceType: 'production_reverse',
          referenceId: id,
          description: `إرجاع أمر إنتاج ${hdr.order_number} — ${reasonText.slice(0, 120)}`,
          postedBy: reversedBy || '',
          entries: glLines
        });
        if (!glRes || !glRes.success) {
          const e = new Error('فشل ترحيل قيد إرجاع الإنتاج: ' + ((glRes && glRes.error) || 'خطأ غير معروف'));
          e.status = 400; throw e;
        }
        glId = glRes.journalId;
      }

      // Roll the consumption rows back to "not consumed" and cancel the order.
      await conn.query('UPDATE production_consumption SET qty_actual=0, total_cost=0, consumed_at=NULL WHERE production_order_id=?', [id]);
      await conn.query(`UPDATE production_orders SET status='cancelled' WHERE id=?`, [id]);
      return { glId, materialsCost };
    });

    res.json({ success: true, reversed: true, materialsRestored: out.materialsCost, glJournalId: out.glId });
  } catch(e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3 — COST & BATCH TRACKING
// ═══════════════════════════════════════════════════════════════════════

// Cost history for an item
router.get('/cost-history/:itemId', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ch.*, w.name AS warehouse_name
      FROM item_cost_history ch
      LEFT JOIN warehouses w ON w.id = ch.warehouse_id
      WHERE ch.item_id = ?
      ORDER BY ch.changed_at DESC
      LIMIT 200`, [req.params.itemId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Expiry alerts — v5.10.33 enterprise overhaul
//
// Lists every batch (purchase_lots row) that has an expiry_date and a
// remaining qty, with rich filters, accurate per-batch days-remaining,
// summary KPIs and pagination.
//
// Bug fix: previous version queried pl.item_id but the column is named
// inv_item_id, so the JOIN to inv_items returned NULLs — the table was
// effectively unusable. Switched to pl.inv_item_id throughout.
//
// Query params:
//   days        — alert window in days (default 30; ignored when
//                 fromDate/toDate are set)
//   fromDate    — filter expiry_date >= fromDate
//   toDate      — filter expiry_date <= toDate
//   warehouseId — single warehouse filter
//   brandId     — filter by item.brand_id
//   category    — filter by inv_items.category
//   q           — free-text search across item name + batch number
//   status      — bucket filter: expired | critical (<7) | soon (<30) |
//                 monitor (<90) | safe (>=90)
//   includeSafe — '1' to include batches > days threshold (otherwise capped)
//   limit, offset, paginated=1
//
// Response (paginated):
//   { items: [...], summary: {...}, total, limit, offset, days }
// Response (legacy non-paginated): array of items (back-compat).
router.get('/expiry-alerts', async (req, res) => {
  try {
    const days       = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
    const fromDate   = req.query.fromDate || null;
    const toDate     = req.query.toDate   || null;
    const warehouseId= req.query.warehouseId || null;
    const brandId    = req.query.brandId   || null;
    const category   = req.query.category  || null;
    const q          = req.query.q         || null;
    const status     = req.query.status    || null;
    const includeSafe= req.query.includeSafe === '1';

    const where = ['pl.expiry_date IS NOT NULL', 'pl.qty_remaining > 0'];
    const params = [];

    if (fromDate) { where.push('pl.expiry_date >= ?'); params.push(fromDate); }
    if (toDate)   { where.push('pl.expiry_date <= ?'); params.push(toDate); }
    if (!fromDate && !toDate && !includeSafe) {
      where.push('pl.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)');
      params.push(days);
    }
    if (warehouseId) { where.push('pl.warehouse_id = ?'); params.push(warehouseId); }
    if (brandId)     { where.push('i.brand_id = ?');      params.push(brandId); }
    if (category)    { where.push('i.category = ?');      params.push(category); }
    if (q) {
      where.push('(i.name LIKE ? OR pl.batch_number LIKE ?)');
      params.push('%' + q + '%', '%' + q + '%');
    }
    if (status === 'expired')  where.push('DATEDIFF(pl.expiry_date, CURDATE()) < 0');
    if (status === 'critical') where.push('DATEDIFF(pl.expiry_date, CURDATE()) BETWEEN 0 AND 6');
    if (status === 'soon')     where.push('DATEDIFF(pl.expiry_date, CURDATE()) BETWEEN 7 AND 29');
    if (status === 'monitor')  where.push('DATEDIFF(pl.expiry_date, CURDATE()) BETWEEN 30 AND 89');
    if (status === 'safe')     where.push('DATEDIFF(pl.expiry_date, CURDATE()) >= 90');

    const whereSql = ' WHERE ' + where.join(' AND ');

    const limit  = Math.max(1, Math.min(Number(req.query.limit) || 500, 2000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const wantsPaginated = req.query.paginated === '1' || req.query.limit != null || req.query.offset != null;

    const baseSelect =
      'SELECT pl.*, ' +
      '       i.name AS item_name, i.unit AS item_unit, i.category, i.brand_id, ' +
      '       b.name AS brand_name, ' +
      '       w.name AS warehouse_name, w.code AS warehouse_code, ' +
      '       DATEDIFF(pl.expiry_date, CURDATE()) AS days_remaining, ' +
      '       (pl.qty_remaining * pl.unit_cost) AS at_risk_value ' +
      '  FROM purchase_lots pl ' +
      '  LEFT JOIN inv_items i ON i.id = pl.inv_item_id ' +
      '  LEFT JOIN brands     b ON b.id = i.brand_id ' +
      '  LEFT JOIN warehouses w ON w.id = pl.warehouse_id';

    const orderSql = ' ORDER BY pl.expiry_date ASC, pl.id ASC';

    const [rows] = await db.query(
      baseSelect + whereSql + orderSql + ' LIMIT ? OFFSET ?',
      params.concat([limit, offset]));

    // Map response — keep legacy keys (item_name, days_remaining, etc.)
    // and add camelCase enriched fields the new UI uses.
    const items = rows.map(function(r){
      const d = Number(r.days_remaining);
      let bucket = 'safe';
      if (d < 0) bucket = 'expired';
      else if (d < 7) bucket = 'critical';
      else if (d < 30) bucket = 'soon';
      else if (d < 90) bucket = 'monitor';
      return Object.assign({}, r, {
        item_id:        r.inv_item_id,
        bucket:         bucket,
        atRiskValue:    Number(r.at_risk_value) || 0,
        qtyRemaining:   Number(r.qty_remaining) || 0,
        unitCost:       Number(r.unit_cost) || 0,
        warehouseId:    r.warehouse_id || '',
        warehouseName:  r.warehouse_name || '',
        warehouseCode:  r.warehouse_code || '',
        brandName:      r.brand_name || '',
        category:       r.category || '',
        unit:           r.item_unit || ''
      });
    });

    if (!wantsPaginated) {
      // Legacy back-compat: array shape, no summary
      return res.json(items);
    }

    // Compute summary across the FULL filter (no LIMIT) — separate query for accuracy
    const [summaryRows] = await db.query(
      'SELECT ' +
        'COUNT(*) AS total_count, ' +
        'SUM(CASE WHEN DATEDIFF(pl.expiry_date, CURDATE()) < 0 THEN 1 ELSE 0 END) AS expired_count, ' +
        'SUM(CASE WHEN DATEDIFF(pl.expiry_date, CURDATE()) BETWEEN 0 AND 6 THEN 1 ELSE 0 END) AS critical_count, ' +
        'SUM(CASE WHEN DATEDIFF(pl.expiry_date, CURDATE()) BETWEEN 7 AND 29 THEN 1 ELSE 0 END) AS soon_count, ' +
        'SUM(CASE WHEN DATEDIFF(pl.expiry_date, CURDATE()) BETWEEN 30 AND 89 THEN 1 ELSE 0 END) AS monitor_count, ' +
        'SUM(CASE WHEN DATEDIFF(pl.expiry_date, CURDATE()) >= 90 THEN 1 ELSE 0 END) AS safe_count, ' +
        'SUM(pl.qty_remaining * pl.unit_cost) AS at_risk_value, ' +
        'SUM(CASE WHEN DATEDIFF(pl.expiry_date, CURDATE()) < 0 THEN pl.qty_remaining * pl.unit_cost ELSE 0 END) AS expired_value, ' +
        'COUNT(DISTINCT pl.inv_item_id) AS distinct_items, ' +
        'COUNT(DISTINCT pl.warehouse_id) AS distinct_warehouses ' +
      'FROM purchase_lots pl ' +
      'LEFT JOIN inv_items i ON i.id = pl.inv_item_id' + whereSql,
      params);
    const sRow = summaryRows[0] || {};

    res.json({
      success: true,
      items,
      summary: {
        total:        Number(sRow.total_count)       || 0,
        expired:      Number(sRow.expired_count)     || 0,
        critical:     Number(sRow.critical_count)    || 0,
        soon:         Number(sRow.soon_count)        || 0,
        monitor:      Number(sRow.monitor_count)     || 0,
        safe:         Number(sRow.safe_count)        || 0,
        atRiskValue:  Number(sRow.at_risk_value)     || 0,
        expiredValue: Number(sRow.expired_value)     || 0,
        distinctItems:      Number(sRow.distinct_items)      || 0,
        distinctWarehouses: Number(sRow.distinct_warehouses) || 0
      },
      total: Number(sRow.total_count) || items.length,
      limit, offset,
      days
    });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

// v5.10.33 — Timeline: monthly distribution of expiring batches for the
// next 12 months. Used by the timeline strip in the expiry UI.
router.get('/expiry-alerts/timeline', async (req, res) => {
  try {
    const where = ['pl.expiry_date IS NOT NULL', 'pl.qty_remaining > 0'];
    const params = [];
    if (req.query.warehouseId) { where.push('pl.warehouse_id = ?'); params.push(req.query.warehouseId); }
    if (req.query.brandId)     { where.push('i.brand_id = ?');      params.push(req.query.brandId); }
    if (req.query.category)    { where.push('i.category = ?');      params.push(req.query.category); }
    const whereSql = ' WHERE ' + where.join(' AND ');
    const [rows] = await db.query(
      'SELECT DATE_FORMAT(pl.expiry_date, \'%Y-%m\') AS month, ' +
      '       COUNT(*) AS batch_count, ' +
      '       SUM(pl.qty_remaining * pl.unit_cost) AS value, ' +
      '       SUM(CASE WHEN pl.expiry_date < CURDATE() THEN 1 ELSE 0 END) AS expired_count ' +
      '  FROM purchase_lots pl LEFT JOIN inv_items i ON i.id = pl.inv_item_id' +
      whereSql +
      ' GROUP BY DATE_FORMAT(pl.expiry_date, \'%Y-%m\') ' +
      ' ORDER BY month ASC LIMIT 24',
      params);
    res.json({
      success: true,
      buckets: rows.map(r => ({
        month: r.month,
        batchCount: Number(r.batch_count) || 0,
        value: Number(r.value) || 0,
        expiredCount: Number(r.expired_count) || 0
      }))
    });
  } catch (e) { res.status(500).json({ success:false, error: e.message }); }
});

// v5.10.33 — Dispose a batch (mark as wasted/destroyed). Sets qty_remaining
// to 0, writes an inventory_movements row (type='out', reason='تالف
// صلاحية'), and optionally posts a GL waste entry.
// Wrapped in a transaction so partial failure can never leave the batch
// half-disposed.
router.post('/expiry-alerts/:lotId/dispose', MGR, async (req, res) => {
  try {
    const lotId = req.params.lotId;
    const username = (req.user && req.user.username) || (req.body && req.body.username) || 'system';
    const reason   = (req.body && req.body.reason) || 'تالف صلاحية';
    const notes    = (req.body && req.body.notes)  || '';

    const [lots] = await db.query(
      'SELECT pl.*, i.name AS item_name FROM purchase_lots pl ' +
      'LEFT JOIN inv_items i ON i.id = pl.inv_item_id WHERE pl.id = ?', [lotId]);
    if (!lots.length) return res.status(404).json({ success:false, error:'lot-not-found' });
    const lot = lots[0];
    if (Number(lot.qty_remaining) <= 0) {
      return res.status(409).json({ success:false, error:'lot-already-empty' });
    }

    const lotQty    = Number(lot.qty_remaining) || 0;
    const itemId    = lot.inv_item_id;
    const itemName  = lot.item_name || itemId;
    // v7.5 — legacy lots may carry no warehouse (only stamped since v7.5
    // receive); allow the caller to supply it explicitly, otherwise refuse —
    // the old behaviour SKIPPED the stock decrement while still posting GL,
    // leaving stock inflated and the journal without a warehouse dimension.
    const warehouse = lot.warehouse_id || (req.body && req.body.warehouseId) || null;
    if (!warehouse) {
      return res.status(400).json({
        success: false, code: 'warehouse-id-required',
        error: 'هذا اللوط بلا مستودع مسجّل — أرسل warehouseId في الطلب لتحديد مستودع الإتلاف'
      });
    }
    const cost      = Number(lot.unit_cost) || 0;
    const nowIso    = new Date().toISOString().slice(0,19).replace('T',' ');

    let disposed = { qty: 0, value: 0 };
    const runner = async (conn) => {
      const c = conn || db;
      // v7.5 — cap the disposal at what is PHYSICALLY on hand: the lot's
      // qty_remaining is nominal (sales decrement warehouse_stock, not lots),
      // so disposing the full lot used to drive stock negative and overstate
      // the waste expense in GL. FOR UPDATE serializes concurrent disposals.
      const [wsRows] = await c.query(
        'SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1 FOR UPDATE',
        [warehouse, itemId]);
      const onHand = wsRows.length ? Math.max(0, Number(wsRows[0].qty) || 0) : 0;
      const qty = Math.min(lotQty, onHand);
      const value = Math.round(qty * cost * 100) / 100;
      disposed = { qty, value };

      // 1. Zero the lot — even when qty < lotQty: the residual was already
      //    consumed elsewhere, so the lot record was stale either way.
      await c.query('UPDATE purchase_lots SET qty_remaining = 0 WHERE id = ?', [lotId]);

      if (qty > 0) {
        // 2. Decrement warehouse_stock by the ACTUAL disposed qty
        await c.query(
          'UPDATE warehouse_stock SET qty = qty - ? WHERE warehouse_id = ? AND item_id = ?',
          [qty, warehouse, itemId]);
        // v7.1 — sync the global rollup so inv_items.stock = SUM(warehouse_stock).
        try { await recomputeInvItemStock(c, itemId); } catch (_) {}

        // 3. Movement log
        const movId = 'MOV-EXP-' + Date.now() + '-' + Math.random().toString(36).slice(2,5);
        await c.query(
          `INSERT INTO inventory_movements
            (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [movId, nowIso, itemId, itemName, 'out', qty, reason, username,
           notes || ('Lot #' + lotId + ' · batch ' + (lot.batch_number || '—')), warehouse]);

        // 4. v7.4 — GL: Dr Waste (expired) / Cr Inventory at the DISPOSED value.
        //    FATAL inside the transaction so a disposed lot can never reduce
        //    stock without a matching expense journal (GL ↔ inventory lockstep).
        if (value > 0.005) {
          const glRes = await gl.postJournal(c, {
            referenceType: 'waste_disposal',
            referenceId: lotId,
            description: 'إتلاف مخزون منتهي الصلاحية — ' + itemName,
            postedBy: username,
            entries: [
              { accountCode: gl.CORE_ACCOUNTS.WASTE_EXPIRED.code, debit: value, credit: 0, warehouseId: warehouse },
              { accountCode: gl.CORE_ACCOUNTS.INVENTORY.code,    debit: 0,     credit: value, warehouseId: warehouse }
            ]
          });
          if (!glRes || !glRes.success) {
            throw new Error('فشل ترحيل قيد الإتلاف: ' + ((glRes && glRes.error) || 'خطأ غير معروف'));
          }
        }
      }
    };

    try {
      if (typeof db.withTransaction === 'function') await db.withTransaction(runner);
      else await runner(null);
    } catch (txErr) {
      // v7.4 — never re-run the runner without a transaction (that would
      // double-decrement). The tx already rolled back atomically — surface it.
      return res.status(500).json({ success:false, error: txErr.message });
    }

    res.json({
      success: true, lotId, qty: disposed.qty, value: disposed.value, itemName,
      capped: disposed.qty < lotQty
        ? 'سُقفت الكمية على الرصيد الفعلي بالمستودع (' + disposed.qty + ' من ' + lotQty + ')'
        : undefined
    });
  } catch (e) { res.status(500).json({ success:false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────
// v5.10.33 — Additional inventory reports for full visibility
// ────────────────────────────────────────────────────────────────────

// ABC analysis (Pareto). Classifies items by their cumulative share of
// inventory value: A = top 70%, B = next 20% (70-90%), C = remaining
// 10%. Optional date window restricts the consumption-based revenue
// signal; the value side is always current stock value.
//   ?warehouseId=X&fromDate=Y&toDate=Z
router.get('/abc-analysis', async (req, res) => {
  try {
    const { warehouseId } = req.query;
    const fromDate = req.query.fromDate || null;
    const toDate   = req.query.toDate   || null;

    // Item × warehouse current value
    const where = ['ws.qty > 0', 'i.active = 1', 'i.deleted_at IS NULL'];
    const params = [];
    if (warehouseId) { where.push('ws.warehouse_id = ?'); params.push(warehouseId); }
    const [stockRows] = await db.query(
      `SELECT i.id AS item_id, i.name AS item_name, i.unit, i.category, i.brand_id,
              b.name AS brand_name,
              SUM(ws.qty) AS total_qty,
              SUM(ws.qty * COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0)) AS total_value
         FROM warehouse_stock ws
         JOIN inv_items i ON i.id = ws.item_id
         LEFT JOIN brands b ON b.id = i.brand_id
        WHERE ` + where.join(' AND ') + `
        GROUP BY i.id, i.name, i.unit, i.category, i.brand_id, b.name
        HAVING total_value > 0`,
      params);

    // Optional consumption signal (movements out) for the same period
    const movWhere = ["m.type = 'out'"];
    const movParams = [];
    if (warehouseId) { movWhere.push('m.warehouse_id = ?'); movParams.push(warehouseId); }
    if (fromDate)    { movWhere.push('DATE(m.movement_date) >= ?'); movParams.push(fromDate); }
    if (toDate)      { movWhere.push('DATE(m.movement_date) <= ?'); movParams.push(toDate); }
    const [consRows] = await db.query(
      'SELECT m.item_id, SUM(m.qty) AS consumed_qty, ' +
      '       SUM(m.qty * COALESCE(i.cost, 0)) AS consumed_value ' +
      '  FROM inventory_movements m LEFT JOIN inv_items i ON i.id = m.item_id ' +
      ' WHERE ' + movWhere.join(' AND ') +
      ' GROUP BY m.item_id',
      movParams);
    const consMap = {};
    consRows.forEach(c => { consMap[c.item_id] = { qty: Number(c.consumed_qty)||0, value: Number(c.consumed_value)||0 }; });

    // Sort by total_value desc, compute cumulative %, assign A/B/C
    const items = stockRows.map(r => ({
      itemId: r.item_id,
      itemName: r.item_name,
      unit: r.unit || '',
      category: r.category || '',
      brandId: r.brand_id || '',
      brandName: r.brand_name || '',
      totalQty: Number(r.total_qty) || 0,
      totalValue: Number(r.total_value) || 0,
      consumedQty:   (consMap[r.item_id] && consMap[r.item_id].qty)   || 0,
      consumedValue: (consMap[r.item_id] && consMap[r.item_id].value) || 0
    })).sort((a,b) => b.totalValue - a.totalValue);

    const grandTotal = items.reduce((s, x) => s + x.totalValue, 0) || 1;
    let cum = 0;
    items.forEach(x => {
      cum += x.totalValue;
      const pctCum = (cum / grandTotal) * 100;
      x.pctOfTotal = (x.totalValue / grandTotal) * 100;
      x.cumulativePct = pctCum;
      x.abcClass = pctCum <= 70 ? 'A' : (pctCum <= 90 ? 'B' : 'C');
    });

    const summary = items.reduce((s, x) => {
      s[x.abcClass].count++;
      s[x.abcClass].value += x.totalValue;
      s.total++;
      s.totalValue += x.totalValue;
      return s;
    }, {
      A: { count:0, value:0 }, B: { count:0, value:0 }, C: { count:0, value:0 },
      total: 0, totalValue: 0
    });

    res.json({ success: true, items, summary });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Reorder alerts: items at or below their min_stock, OR projected to
// run out within N days based on recent consumption rate.
//   ?warehouseId=X&projectionDays=14
router.get('/reorder-alerts', async (req, res) => {
  try {
    const { warehouseId } = req.query;
    const projectionDays = Math.max(1, Math.min(Number(req.query.projectionDays) || 14, 90));
    // Lookback for daily consumption rate
    const lookback = 30;

    const where = ['ws.qty >= 0', 'i.active = 1', 'i.deleted_at IS NULL'];
    const params = [];
    if (warehouseId) { where.push('ws.warehouse_id = ?'); params.push(warehouseId); }

    const [rows] = await db.query(
      `SELECT i.id AS item_id, i.name AS item_name, i.unit, i.category, i.brand_id,
              b.name AS brand_name, i.min_stock, i.cost,
              ws.warehouse_id, w.name AS warehouse_name, w.code AS warehouse_code,
              ws.qty AS current_qty,
              (SELECT COALESCE(SUM(m.qty),0) / ? FROM inventory_movements m
                WHERE m.item_id = i.id AND m.type='out'
                  AND m.warehouse_id = ws.warehouse_id
                  AND m.movement_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)) AS daily_rate
         FROM warehouse_stock ws
         JOIN inv_items i ON i.id = ws.item_id
         LEFT JOIN brands b ON b.id = i.brand_id
         LEFT JOIN warehouses w ON w.id = ws.warehouse_id
        WHERE ` + where.join(' AND '),
      [lookback, lookback].concat(params));

    const items = rows.map(r => {
      const cur     = Number(r.current_qty) || 0;
      const min     = Number(r.min_stock) || 0;
      const rate    = Number(r.daily_rate) || 0;
      const days    = rate > 0 ? Math.floor(cur / rate) : (cur > 0 ? 9999 : 0);
      const projShortage = rate > 0 && (cur - rate * projectionDays) <= min;
      const isOut       = cur <= 0;
      const isLow       = cur > 0 && cur <= min;
      const status = isOut ? 'out' : isLow ? 'low' : projShortage ? 'projected' : 'ok';
      return {
        itemId: r.item_id, itemName: r.item_name, unit: r.unit || '',
        category: r.category || '', brandId: r.brand_id || '', brandName: r.brand_name || '',
        warehouseId: r.warehouse_id, warehouseName: r.warehouse_name || '', warehouseCode: r.warehouse_code || '',
        currentQty: cur, minStock: min, cost: Number(r.cost) || 0,
        dailyRate: rate, daysOfStock: days, projectedShortage: projShortage,
        suggestedOrder: Math.max(0, min * 2 - cur), // simple suggestion: bring up to 2× min
        suggestedOrderValue: Math.max(0, min * 2 - cur) * (Number(r.cost) || 0),
        status: status
      };
    }).filter(x => x.status !== 'ok');

    items.sort((a, b) => {
      const order = { out: 0, low: 1, projected: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return a.daysOfStock - b.daysOfStock;
    });

    const summary = items.reduce((s, x) => {
      if (x.status === 'out') s.out++;
      else if (x.status === 'low') s.low++;
      else if (x.status === 'projected') s.projected++;
      s.totalSuggestedValue += x.suggestedOrderValue;
      return s;
    }, { out:0, low:0, projected:0, totalSuggestedValue:0, total: items.length });

    res.json({ success: true, items, summary, projectionDays });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Days-of-stock-on-hand for every active item: current_qty ÷ daily_rate.
//   ?warehouseId=X
router.get('/days-of-stock', async (req, res) => {
  try {
    const { warehouseId } = req.query;
    const lookback = Math.max(7, Math.min(Number(req.query.lookback) || 30, 365));

    const where = ['i.active = 1', 'i.deleted_at IS NULL'];
    const params = [];
    if (warehouseId) { where.push('ws.warehouse_id = ?'); params.push(warehouseId); }

    const [rows] = await db.query(
      `SELECT i.id AS item_id, i.name AS item_name, i.unit, i.category,
              ws.warehouse_id, w.name AS warehouse_name,
              ws.qty AS current_qty,
              (SELECT COALESCE(SUM(m.qty),0) / ? FROM inventory_movements m
                WHERE m.item_id = i.id AND m.type='out'
                  AND m.warehouse_id = ws.warehouse_id
                  AND m.movement_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)) AS daily_rate
         FROM warehouse_stock ws
         JOIN inv_items i ON i.id = ws.item_id
         LEFT JOIN warehouses w ON w.id = ws.warehouse_id
        WHERE ` + where.join(' AND ') + `
          AND ws.qty > 0`,
      [lookback, lookback].concat(params));

    const items = rows.map(r => {
      const cur = Number(r.current_qty) || 0;
      const rate = Number(r.daily_rate) || 0;
      const days = rate > 0 ? Math.floor(cur / rate) : 9999;
      let zone = 'safe';
      if (rate <= 0)        zone = 'no-movement';
      else if (days < 7)    zone = 'critical';
      else if (days < 14)   zone = 'low';
      else if (days < 30)   zone = 'fair';
      else if (days >= 180) zone = 'overstock';
      return {
        itemId: r.item_id, itemName: r.item_name, unit: r.unit || '', category: r.category || '',
        warehouseId: r.warehouse_id, warehouseName: r.warehouse_name || '',
        currentQty: cur, dailyRate: rate, daysOfStock: days === 9999 ? null : days,
        zone: zone
      };
    });
    items.sort((a, b) => (a.daysOfStock == null ? 99999 : a.daysOfStock) - (b.daysOfStock == null ? 99999 : b.daysOfStock));

    res.json({ success: true, items, lookback });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stocktake history summary: every stocktake with metadata + variance trend.
//   ?warehouseId=X&fromDate=Y&toDate=Z
router.get('/stocktake-history', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.warehouseId) { where.push('s.warehouse_id = ?'); params.push(req.query.warehouseId); }
    if (req.query.fromDate)    { where.push('DATE(s.stocktake_date) >= ?'); params.push(req.query.fromDate); }
    if (req.query.toDate)      { where.push('DATE(s.stocktake_date) <= ?'); params.push(req.query.toDate); }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

    const [rows] = await db.query(
      'SELECT s.*, w.name AS warehouse_name, w.code AS warehouse_code, ' +
      '       (SELECT COUNT(*) FROM stocktake_items si WHERE si.stocktake_id = s.id) AS items_n, ' +
      '       (SELECT COALESCE(SUM(ABS(si.variance) * COALESCE(inv.cost,0)), 0) ' +
      '          FROM stocktake_items si LEFT JOIN inv_items inv ON inv.id = si.inv_item_id ' +
      '         WHERE si.stocktake_id = s.id) AS abs_variance_cost ' +
      '  FROM stocktakes s LEFT JOIN warehouses w ON w.id = s.warehouse_id' +
      whereSql + ' ORDER BY s.stocktake_date DESC LIMIT 500',
      params);

    const items = rows.map(r => ({
      id: r.id,
      date: r.stocktake_date,
      username: r.username,
      notes: r.notes || '',
      status: r.status || 'completed',
      warehouseId: r.warehouse_id || '',
      warehouseName: r.warehouse_name || '',
      warehouseCode: r.warehouse_code || '',
      itemsCount: Number(r.items_n) || 0,
      totalVariance: Number(r.total_variance) || 0,
      absVarianceCost: Number(r.abs_variance_cost) || 0
    }));

    // Aggregate stats
    const summary = items.reduce((s, x) => {
      s.totalCount++;
      s.totalItems += x.itemsCount;
      s.totalVarianceCost += x.totalVariance;
      s.totalAbsVarianceCost += x.absVarianceCost;
      return s;
    }, { totalCount: 0, totalItems: 0, totalVarianceCost: 0, totalAbsVarianceCost: 0 });
    summary.avgVariancePerStocktake = summary.totalCount ? (summary.totalAbsVarianceCost / summary.totalCount) : 0;

    res.json({ success: true, items, summary });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Inventory turnover report
router.get('/inventory-turnover', async (req, res) => {
  try {
    const { dateFrom, dateTo, warehouseId } = req.query;
    const df = dateFrom || new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
    const dt = dateTo || new Date().toISOString().slice(0,10);

    let whFilter = '';
    const whP = [];
    if (warehouseId) { whFilter = ' AND pc.warehouse_id=?'; whP.push(warehouseId); }

    // Consumption during period (production + issues + sales estimates)
    const [rows] = await db.query(`
      SELECT i.id AS item_id, i.name AS item_name, i.unit,
             COALESCE(SUM(pc.qty_actual * pc.unit_cost), 0) AS cogs,
             COALESCE(SUM(pc.qty_actual), 0) AS total_consumed,
             (SELECT SUM(ws.qty * ws.avg_cost) FROM warehouse_stock ws WHERE ws.item_id = i.id) AS current_value,
             (SELECT SUM(ws.qty) FROM warehouse_stock ws WHERE ws.item_id = i.id) AS current_qty
      FROM inv_items i
      LEFT JOIN production_consumption pc ON pc.item_id = i.id
         AND pc.consumed_at BETWEEN ? AND ?
         ${whFilter}
      GROUP BY i.id, i.name, i.unit
      HAVING current_qty > 0 OR cogs > 0
      ORDER BY cogs DESC
      LIMIT 500`, [df, dt + ' 23:59:59', ...whP]);

    const report = rows.map(r => {
      const avgInv = Number(r.current_value) || 0;
      const cogs = Number(r.cogs) || 0;
      const turnover = avgInv > 0 ? (cogs / avgInv) : 0;
      const days = turnover > 0 ? Math.round(365 / turnover) : null;
      return { ...r, turnover_ratio: Number(turnover.toFixed(3)), days_to_sell: days };
    });
    res.json({ from: df, to: dt, items: report });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Slow-moving items — no movement in N days
router.get('/slow-moving', async (req, res) => {
  try {
    const days = Number(req.query.days) || 60;
    const [rows] = await db.query(`
      SELECT ws.warehouse_id, w.name AS warehouse_name,
             ws.item_id, i.name AS item_name, i.unit,
             ws.qty, ws.avg_cost,
             (ws.qty * ws.avg_cost) AS stock_value,
             ws.last_updated,
             DATEDIFF(CURDATE(), DATE(ws.last_updated)) AS days_since_movement
      FROM warehouse_stock ws
      LEFT JOIN warehouses w ON w.id = ws.warehouse_id
      LEFT JOIN inv_items i ON i.id = ws.item_id
      WHERE ws.qty > 0
        AND (ws.last_updated IS NULL OR ws.last_updated < DATE_SUB(NOW(), INTERVAL ? DAY))
      ORDER BY days_since_movement DESC, stock_value DESC
      LIMIT 500`, [days]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Valuation by warehouse (for reconciliation with GL)
router.get('/valuation-by-warehouse', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT w.id AS warehouse_id, w.name AS warehouse_name, w.code AS warehouse_code,
             w.is_main, w.parent_warehouse_id, p.name AS parent_name,
             COUNT(DISTINCT ws.item_id) AS item_count,
             COALESCE(SUM(ws.qty), 0) AS total_qty,
             COALESCE(SUM(ws.qty * ws.avg_cost), 0) AS total_value
      FROM warehouses w
      LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
      LEFT JOIN warehouses p ON p.id = w.parent_warehouse_id
      WHERE w.is_active = 1
      GROUP BY w.id, w.name, w.code, w.is_main, w.parent_warehouse_id, p.name
      ORDER BY w.is_main DESC, w.name`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
