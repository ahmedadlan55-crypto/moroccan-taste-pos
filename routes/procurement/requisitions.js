/**
 * routes/procurement/requisitions.js — Purchase Requisitions (PR) subsystem.
 *
 * A requisition is the INTERNAL request that precedes a purchase order: a
 * department asks for items (draft → submitted → approved), and an approver
 * converts an approved requisition into a real Purchase Order (status
 * 'converted' + po_id). Mounted at /api/procurement/requisitions inside the
 * PROCUREMENT_P2P_ENABLE-gated procurement router.
 *
 * Conventions mirror the sibling routers (orders.js / suppliers.js):
 *   • same db pool + db.withTransaction (bounded deadlock retry)
 *   • middleware/requireCapability for every endpoint
 *   • lib/procurement/http envelope helpers + lib/procurement/errors.err
 *   • lib/procurement/calculations for ALL money/VAT/totals math (never trust
 *     the client) and lib/procurement/numbering for the PO number on convert
 *   • lib/docNumber for the atomic, race-free PR-YYYYMMDD-#### requisition number
 *
 * The approve + convert flips are wrapped in a transaction with
 * `SELECT … FOR UPDATE` so two concurrent approvals resolve to a SINGLE
 * approval (the loser sees the new status and gets INVALID_STATE_TRANSITION).
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const { err } = require('../../lib/procurement/errors');
const calc = require('../../lib/procurement/calculations');
const cfg = require('../../lib/procurement/config');
const { nextNumber } = require('../../lib/procurement/numbering');
const { nextDocNumber } = require('../../lib/docNumber');
const events = require('../../lib/procurement/events');

const CAP_MANAGE = 'purchasing.requisitions.manage';
const CAP_APPROVE = 'purchasing.requisitions.approve';
const CAP_VIEW = 'procurement.view';

// ── who may READ a requisition ───────────────────────────────────────────────
// `procurement.view` gates the WHOLE procurement module (orders, receipts,
// supplier invoices, payments, GL, dashboard). The RBAC seed below deliberately
// hands CAP_MANAGE — the right to FILE a requisition — to back-office roles
// (employee / custody) that must never read supplier invoices or payments, so
// they never receive `procurement.view`. The result was a role that could POST a
// requisition (201) and then get 403 from the very list it belongs in: «عند طلب
// نواقص لا تظهر ضمن الطلبات».
//
// Widening `procurement.view` to those roles would open AP; instead the two
// requisition READS accept EITHER capability. That is not an escalation —
// CAP_MANAGE already permits creating and editing these same rows — and the
// warehouse-scope predicate below still decides WHICH rows come back.
function requireAnyCapability(...caps) {
  return async function (req, res, next) {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    for (const cap of caps) {
      let allowed = false;
      try { allowed = await requireCapability.hasCapability(req.user, cap); } catch (_) { allowed = false; }
      if (allowed) return next();
    }
    return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لهذه العملية' });
  };
}
const CAN_READ = () => requireAnyCapability(CAP_VIEW, CAP_MANAGE);

// ── warehouse attribution + read visibility ──────────────────────────────────
// The caller's resolved warehouse scope ({ all, warehouseIds }) as attached by
// middleware/warehouseScope. Tolerates its absence (older mounts / unit tests).
function _scopeOf(req) {
  const s = req && req.warehouseScope;
  return {
    all: !!(s && s.all),
    warehouseIds: s && Array.isArray(s.warehouseIds) ? s.warehouseIds.map(String) : [],
  };
}

/**
 * Resolve the warehouse a new requisition belongs to.
 *
 * An explicit warehouseId wins. Otherwise, when the caller can reach EXACTLY
 * ONE warehouse the attribution is unambiguous, so the requisition is stamped
 * with it rather than stored as NULL — a NULL warehouse_id matches no `IN (…)`
 * list, which is what made a scoped user's own request vanish from their list.
 *
 * A global caller (all warehouses) and a caller with several warehouses stay
 * NULL on purpose: a company-wide request ("office supplies") legitimately has
 * no warehouse, and guessing one would file it against the wrong stock. Those
 * rows are covered by the creator clause in _visibilityClause instead.
 */
function _resolveWarehouseId(req, supplied) {
  const wid = supplied == null || String(supplied).trim() === '' ? null : String(supplied).trim();
  if (wid) return wid;
  const s = _scopeOf(req);
  return (!s.all && s.warehouseIds.length === 1) ? s.warehouseIds[0] : null;
}

/**
 * Complete the branch ⇄ warehouse pair from whichever side was given.
 *
 * A branch owns exactly one warehouse (branches.warehouse_id). A request
 * filed "for the Riyadh branch" therefore already names its warehouse, and
 * one filed against a warehouse names the branch that owns it. Leaving
 * either half NULL was how the same request could be visible under one
 * filter and absent under the other — same document, two answers.
 *
 * Only fills in what is MISSING; an explicit value is never overwritten,
 * and a warehouse shared by several branches (or none) leaves the branch
 * NULL rather than guessing.
 */
async function _completeAttribution(conn, branchId, warehouseId) {
  let b = branchId == null || String(branchId).trim() === '' ? null : String(branchId).trim();
  let w = warehouseId == null || String(warehouseId).trim() === '' ? null : String(warehouseId).trim();
  if (b && !w) {
    const [rows] = await conn.query('SELECT warehouse_id FROM branches WHERE id = ? LIMIT 1', [b]);
    if (rows.length && rows[0].warehouse_id) w = String(rows[0].warehouse_id);
  } else if (w && !b) {
    const [rows] = await conn.query('SELECT id FROM branches WHERE warehouse_id = ? LIMIT 2', [w]);
    if (rows.length === 1) b = String(rows[0].id);
  }
  return { branchId: b, warehouseId: w };
}

/**
 * The predicate that decides which requisitions a caller may READ.
 *
 *   warehouse_id IN (…granted…)  OR  (warehouse_id IS NULL AND created_by = me)
 *
 * The second branch is what makes «the person who filed it can always see it»
 * true even for a request that legitimately carries no warehouse. It is
 * deliberately NOT a bare `OR warehouse_id IS NULL`: that would hand every
 * scoped user every other department's unassigned requisitions. Gaining sight
 * of a row you yourself created is not a widening of anyone's access.
 *
 * `created_by` — not `requested_by` — is the identity, because created_by is
 * stamped from the JWT (H.actorOf) while requested_by is settable from the
 * request body and would therefore be forgeable.
 *
 * Returns an empty clause when scope enforcement is off, so the unscoped
 * behaviour is byte-for-byte what it was.
 */
function _visibilityClause(req, alias) {
  const sc = H.scopeClause(req, `${alias}.warehouse_id`);
  if (!sc.sql) return { sql: '', params: [] };
  const scoped = sc.sql.replace(/^\s*AND\s*/i, '');
  const actor = H.actorOf(req);
  if (!actor) return { sql: scoped, params: sc.params.slice() };
  return {
    sql: `(${scoped} OR (${alias}.warehouse_id IS NULL AND ${alias}.created_by = ?))`,
    params: sc.params.concat([actor]),
  };
}

const SORTABLE = {
  reqNumber: 'r.req_number', createdAt: 'r.created_at',
  neededDate: 'r.needed_date', status: 'r.status',
};
const LIST_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'converted'];

function genId() { return 'PR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function lineId() { return 'PRL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function poGenId() { return 'PO-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function poLineId() { return 'POL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

// ── one-time schema + capability seed (idempotent, self-provisioning) ─────────
// Mirrors the additive/idempotent style of db/migrations/procurement/schema.js.
// Requisitions are a NET-NEW subsystem, so the two tables and the two RBAC caps
// are created here rather than in the central migration (which this file may not
// touch). Awaited by every handler via ensureReady() so a query never races the
// DDL; also kicked off at require-time so the tables usually exist before the
// first request lands.
let _ready = null;
function ensureReady() {
  if (!_ready) _ready = _provision().catch((e) => { _ready = null; throw e; });
  return _ready;
}
async function _provision() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_requisitions (
      id VARCHAR(50) PRIMARY KEY,
      req_number VARCHAR(30) UNIQUE,
      branch_id VARCHAR(50) NULL,
      warehouse_id VARCHAR(50) NULL,
      requested_by VARCHAR(100) NULL,
      status ENUM('draft','submitted','approved','rejected','converted') NOT NULL DEFAULT 'draft',
      version INT NOT NULL DEFAULT 1,
      needed_date DATE NULL,
      notes TEXT NULL,
      created_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      submitted_by VARCHAR(100) NULL,
      submitted_at DATETIME NULL,
      approved_by VARCHAR(100) NULL,
      approved_at DATETIME NULL,
      rejected_by VARCHAR(100) NULL,
      rejected_at DATETIME NULL,
      reject_reason VARCHAR(400) NULL,
      po_id VARCHAR(50) NULL,
      INDEX idx_pr_status_branch (status, branch_id),
      INDEX idx_pr_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_requisition_lines (
      id VARCHAR(50) PRIMARY KEY,
      requisition_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NULL,
      item_name VARCHAR(200) NULL,
      quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
      unit VARCHAR(50) NULL,
      estimated_price DECIMAL(18,4) NOT NULL DEFAULT 0,
      notes VARCHAR(400) NULL,
      INDEX idx_prl_req (requisition_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // RBAC seed — make the two NEW caps usable for non-admin roles (admin already
  // bypasses in requireCapability). Tolerant: a missing permissions table must
  // never block the subsystem.
  try {
    const seed = [
      [CAP_MANAGE, 'إدارة طلبات الشراء', 'Manage purchase requisitions', 0, 25],
      [CAP_APPROVE, 'اعتماد طلبات الشراء', 'Approve purchase requisitions', 1, 26],
    ];
    for (const [id, ar, en, sensitive, order] of seed) {
      await db.query(
        `INSERT IGNORE INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive, sort_order)
         VALUES (?, 'procurement', ?, ?, ?, ?)`, [id, ar, en, sensitive, order]);
    }
    // admin + manager get both; back-office roles get manage only (mirrors the
    // frontend ROLE_GRANTS: manage=BACKOFFICE, approve=MGR).
    const grants = [
      ['admin', CAP_MANAGE], ['admin', CAP_APPROVE],
      ['manager', CAP_MANAGE], ['manager', CAP_APPROVE],
      ['employee', CAP_MANAGE], ['custody', CAP_MANAGE], ['purchasing', CAP_MANAGE],
    ];
    for (const [role, id] of grants) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)', [role, id]);
    }
  } catch (_) { /* permissions seed is best-effort */ }
  return true;
}
ensureReady().catch(() => { /* re-attempted lazily on first request */ });

// ── shared line validation/normalization ─────────────────────────────────────
function _normLines(rawLines) {
  const arr = Array.isArray(rawLines) ? rawLines : [];
  if (!arr.length) throw err('VALIDATION_ERROR', 'طلب الشراء يتطلب سطرًا واحدًا على الأقل');
  return arr.map((l) => {
    const quantity = Number(l.quantity != null ? l.quantity : l.qty);
    if (!Number.isFinite(quantity) || quantity <= 0) throw err('VALIDATION_ERROR', 'الكمية يجب أن تكون أكبر من صفر');
    const estimatedPrice = Number(l.estimatedPrice != null ? l.estimatedPrice : (l.estimated_price != null ? l.estimated_price : 0)) || 0;
    if (estimatedPrice < 0) throw err('VALIDATION_ERROR', 'السعر التقديري لا يمكن أن يكون سالبًا');
    const itemId = l.itemId || l.item_id || null;
    if (!itemId) throw err('VALIDATION_ERROR', 'المادة مطلوبة في كل سطر');
    return {
      itemId,
      itemName: l.itemName || l.item_name || '',
      quantity: calc.qty(quantity),
      unit: l.unit || null,
      estimatedPrice: calc.money(estimatedPrice),
      notes: l.notes || null,
    };
  });
}

async function _insertLines(conn, requisitionId, lines) {
  for (const l of lines) {
    await conn.query(
      `INSERT INTO purchase_requisition_lines
        (id, requisition_id, item_id, item_name, quantity, unit, estimated_price, notes)
       VALUES (?,?,?,?,?,?,?,?)`,
      [lineId(), requisitionId, l.itemId, l.itemName, l.quantity, l.unit, l.estimatedPrice, l.notes]);
  }
}

function _hydrate(row, lines) {
  const estimatedTotal = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.estimated_price), 0);
  return Object.assign({}, row, { lines, estimatedTotal: calc.money(estimatedTotal) });
}

// ── POST / — create a draft requisition ──────────────────────────────────────
router.post('/', requireCapability(CAP_MANAGE), async (req, res) => {
  try {
    await ensureReady();
    const b = req.body || {};
    const lines = _normLines(b.lines || b.items);
    const actor = H.actorOf(req);
    // An explicitly-named warehouse must be one the caller may touch (the same
    // rule receipts.js applies), otherwise a scoped user could file a request
    // against foreign stock — and then not be able to read it back.
    if (b.warehouseId && typeof req.guardWh === 'function' && !req.guardWh(res, b.warehouseId)) return;
    // What the caller actually NAMED — not the single-warehouse default,
    // which is a fallback and must not outrank the branch.
    const explicitWarehouseId = b.warehouseId == null || String(b.warehouseId).trim() === '' ? null : String(b.warehouseId).trim();

    const out = await db.withTransaction(async (conn) => {
      // The branch names its warehouse and vice versa — fill the missing half
      // so the request is found under EITHER filter. Order matters: the
      // branch is consulted BEFORE the "caller has one warehouse" default,
      // otherwise a single-warehouse user filing for another branch would be
      // silently filed against their own stock instead of being refused.
      const attr = await _completeAttribution(conn, b.branchId, explicitWarehouseId);
      if (!attr.warehouseId) attr.warehouseId = _resolveWarehouseId(req, null);
      // The scope guard above checked the explicit value. A DERIVED warehouse
      // has to clear the same guard, or naming a branch becomes a way around
      // warehouse scope.
      if (attr.warehouseId && attr.warehouseId !== explicitWarehouseId && typeof req.guardWh === 'function' && !req.guardWh(res, attr.warehouseId)) {
        // guardWh has already answered 403; abort the transaction without
        // answering again.
        const e = new Error('scope refused'); e.responded = true; throw e;
      }
      const warehouseId = attr.warehouseId;
      const id = genId();
      const number = await nextDocNumber(conn, 'PR');
      await conn.query(
        `INSERT INTO purchase_requisitions
          (id, req_number, branch_id, warehouse_id, requested_by, status, version, needed_date, notes, created_by)
         VALUES (?,?,?,?,?,'draft',1,?,?,?)`,
        [id, number, attr.branchId, warehouseId, b.requestedBy || actor || null,
         b.neededDate || null, b.notes || null, actor || null]);
      await _insertLines(conn, id, lines);
      return { id, number };
    });

    return H.sendOk(res, { data: { id: out.id }, documentNumber: out.number, status: 'draft', version: 1 }, 201);
  } catch (e) { if (e && e.responded) return; return H.sendErr(res, e); }
});

// ── GET / — paginated list (filters: status, branchId, q) ────────────────────
router.get('/', CAN_READ(), async (req, res) => {
  try {
    await ensureReady();
    const p = H.listParams(req, Object.keys(SORTABLE), LIST_STATUSES);
    const where = [], params = [];
    if (p.status) { where.push('r.status = ?'); params.push(p.status); }
    if (req.query.branchId) { where.push('r.branch_id = ?'); params.push(String(req.query.branchId)); }
    if (req.query.warehouseId) { where.push('r.warehouse_id = ?'); params.push(String(req.query.warehouseId)); }
    // `mine=1` — the requester's own view. A branch user opening the screen
    // wants "what did I ask for and where is it", not the company's queue.
    if (String(req.query.mine || '') === '1') { where.push('r.created_by = ?'); params.push(H.actorOf(req) || ''); }
    if (p.q) { where.push('(r.req_number LIKE ? OR r.notes LIKE ?)'); params.push('%' + p.q + '%', '%' + p.q + '%'); }
    if (req.query.dateFrom) { where.push('r.needed_date >= ?'); params.push(String(req.query.dateFrom)); }
    if (req.query.dateTo) { where.push('r.needed_date <= ?'); params.push(String(req.query.dateTo)); }
    const vis = _visibilityClause(req, 'r');
    if (vis.sql) { where.push(vis.sql); params.push(...vis.params); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = H.orderBy(p.sort, p.dir, SORTABLE, 'r.created_at');

    const [rows] = await db.query(
      `SELECT r.id, r.req_number, r.branch_id, r.warehouse_id, r.requested_by, r.status, r.version,
              r.needed_date, r.notes, r.created_by, r.created_at,
              r.submitted_by, r.submitted_at, r.approved_by, r.approved_at,
              r.rejected_by, r.rejected_at, r.reject_reason, r.po_id,
              br.name AS branch_name, w.name AS warehouse_name,
              po.po_number, po.status AS po_status,
              (SELECT COUNT(*) FROM purchase_requisition_lines l WHERE l.requisition_id = r.id) AS line_count,
              (SELECT COALESCE(SUM(l.quantity * l.estimated_price), 0) FROM purchase_requisition_lines l WHERE l.requisition_id = r.id) AS estimated_total
         FROM purchase_requisitions r
         LEFT JOIN branches br ON br.id = r.branch_id
         LEFT JOIN warehouses w ON w.id = r.warehouse_id
         LEFT JOIN purchase_orders po ON po.id = r.po_id
         ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM purchase_requisitions r ${whereSql}`, params);
    return H.sendData(res, rows.map((x) => Object.assign({}, x, { estimated_total: calc.money(x.estimated_total) })), {
      pagination: { page: p.page, pageSize: p.pageSize, total: Number(cnt[0].total), totalPages: Math.ceil(cnt[0].total / p.pageSize) },
    });
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET /:id — header + lines ────────────────────────────────────────────────
// Same visibility predicate as the list, so opening a row from the list always
// works and an out-of-scope id answers the SAME 404 a never-issued id gets
// (a 403 would confirm the requisition exists).
router.get('/:id', CAN_READ(), async (req, res) => {
  try {
    await ensureReady();
    const vis = _visibilityClause(req, 'r');
    const [rows] = await db.query(
      `SELECT r.*, br.name AS branch_name, w.name AS warehouse_name, po.po_number, po.status AS po_status
         FROM purchase_requisitions r
         LEFT JOIN branches br ON br.id = r.branch_id
         LEFT JOIN warehouses w ON w.id = r.warehouse_id
         LEFT JOIN purchase_orders po ON po.id = r.po_id
        WHERE r.id = ?${vis.sql ? ' AND ' + vis.sql : ''}`,
      [req.params.id].concat(vis.params));
    if (!rows.length) throw err('NOT_FOUND', 'طلب الشراء غير موجود');
    const [lines] = await db.query('SELECT * FROM purchase_requisition_lines WHERE requisition_id = ? ORDER BY id', [req.params.id]);
    return H.sendData(res, _hydrate(rows[0], lines));
  } catch (e) { return H.sendErr(res, e); }
});

// ── PUT /:id — edit while draft or submitted ─────────────────────────────────
router.put('/:id', requireCapability(CAP_MANAGE), async (req, res) => {
  try {
    await ensureReady();
    const b = req.body || {};
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM purchase_requisitions WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'طلب الشراء غير موجود');
      if (!['draft', 'submitted'].includes(rows[0].status)) {
        throw err('INVALID_STATE_TRANSITION', 'لا يمكن تعديل طلب شراء بعد اعتماده أو رفضه أو تحويله');
      }
      if (b.lines || b.items) {
        const lines = _normLines(b.lines || b.items);
        await conn.query('DELETE FROM purchase_requisition_lines WHERE requisition_id = ?', [req.params.id]);
        await _insertLines(conn, req.params.id, lines);
      }
      // Re-complete the pair from whatever the caller sent, so editing the
      // branch alone re-derives the warehouse and vice versa.
      if (Object.prototype.hasOwnProperty.call(b, 'branchId') || Object.prototype.hasOwnProperty.call(b, 'warehouseId')) {
        const attr = await _completeAttribution(conn,
          Object.prototype.hasOwnProperty.call(b, 'branchId') ? b.branchId : rows[0].branch_id,
          Object.prototype.hasOwnProperty.call(b, 'warehouseId') ? b.warehouseId : rows[0].warehouse_id);
        b.branchId = attr.branchId; b.warehouseId = attr.warehouseId;
      }
      const sets = [], sp = [];
      for (const [k, col] of [['branchId', 'branch_id'], ['warehouseId', 'warehouse_id'],
        ['requestedBy', 'requested_by'], ['neededDate', 'needed_date'], ['notes', 'notes']]) {
        if (Object.prototype.hasOwnProperty.call(b, k)) { sets.push(`${col} = ?`); sp.push(b[k]); }
      }
      sets.push('version = version + 1');
      sp.push(req.params.id);
      await conn.query(`UPDATE purchase_requisitions SET ${sets.join(', ')} WHERE id = ?`, sp);
      const [o] = await conn.query('SELECT version, status FROM purchase_requisitions WHERE id = ?', [req.params.id]);
      return o[0];
    });
    return H.sendOk(res, { data: { id: req.params.id }, status: out.status, version: out.version });
  } catch (e) { return H.sendErr(res, e); }
});

// ── generic guarded status flip (transaction + SELECT … FOR UPDATE) ──────────
// The row is locked, the from-status is asserted INSIDE the lock, then the flip
// is applied — so two racing callers can never both succeed (the loser observes
// the new status and gets INVALID_STATE_TRANSITION).
async function _flip(id, { from, to, extraSets = {}, actorCols = {}, actor }) {
  return db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM purchase_requisitions WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) throw err('NOT_FOUND', 'طلب الشراء غير موجود');
    const cur = rows[0];
    const allowed = Array.isArray(from) ? from : [from];
    if (!allowed.includes(cur.status)) {
      throw err('INVALID_STATE_TRANSITION', `لا يمكن الانتقال من الحالة «${cur.status}» إلى «${to}»`);
    }
    const sets = ['status = ?', 'version = version + 1'];
    const params = [to];
    if (actorCols.by) { sets.push(`${actorCols.by} = ?`); params.push(actor || null); }
    if (actorCols.at) { sets.push(`${actorCols.at} = NOW()`); }
    for (const [col, val] of Object.entries(extraSets)) { sets.push(`${col} = ?`); params.push(val); }
    params.push(id);
    await conn.query(`UPDATE purchase_requisitions SET ${sets.join(', ')} WHERE id = ?`, params);
    const [o] = await conn.query('SELECT req_number, status, version FROM purchase_requisitions WHERE id = ?', [id]);
    return o[0];
  });
}

// ── POST /:id/submit — draft → submitted ─────────────────────────────────────
router.post('/:id/submit', requireCapability(CAP_MANAGE), async (req, res) => {
  try {
    await ensureReady();
    const r = await _flip(req.params.id, {
      from: 'draft', to: 'submitted',
      actorCols: { by: 'submitted_by', at: 'submitted_at' }, actor: H.actorOf(req),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.req_number, status: r.status, version: r.version });
  } catch (e) { return H.sendErr(res, e); }
});

// ── POST /:id/approve — submitted → approved (double-approve safe) ────────────
router.post('/:id/approve', requireCapability(CAP_APPROVE), async (req, res) => {
  try {
    await ensureReady();
    const r = await _flip(req.params.id, {
      from: 'submitted', to: 'approved',
      actorCols: { by: 'approved_by', at: 'approved_at' }, actor: H.actorOf(req),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.req_number, status: r.status, version: r.version });
  } catch (e) { return H.sendErr(res, e); }
});

// ── POST /:id/reject — submitted → rejected (reason required) ─────────────────
router.post('/:id/reject', requireCapability(CAP_APPROVE), async (req, res) => {
  try {
    await ensureReady();
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3) throw err('VALIDATION_ERROR', 'سبب الرفض مطلوب (3 أحرف على الأقل)');
    const r = await _flip(req.params.id, {
      from: 'submitted', to: 'rejected',
      actorCols: { by: 'rejected_by', at: 'rejected_at' }, actor: H.actorOf(req),
      extraSets: { reject_reason: reason },
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.req_number, status: r.status, version: r.version });
  } catch (e) { return H.sendErr(res, e); }
});

// ── POST /:id/convert-to-po — approved → converted (creates a draft PO) ───────
// Reuses the procurement financial engine (lib/procurement/calculations) and the
// atomic PO numbering (lib/procurement/numbering) — the SAME primitives orders.js
// uses — so no VAT/discount/totals math is duplicated. The requisition lock, the
// PO insert, and the status='converted' flip all happen in one transaction.
router.post('/:id/convert-to-po', requireCapability(CAP_APPROVE), async (req, res) => {
  try {
    await ensureReady();
    const b = req.body || {};
    if (!b.supplierId) throw err('VALIDATION_ERROR', 'المورد مطلوب لتحويل الطلب إلى أمر شراء');
    const standardRate = await cfg.standardVatRate(db);
    const actor = H.actorOf(req);
    // optional per-line price/vat overrides keyed by requisition line id
    const overrides = (b.lines && typeof b.lines === 'object' && !Array.isArray(b.lines)) ? b.lines
      : Array.isArray(b.lines) ? Object.fromEntries(b.lines.map((l) => [String(l.id || l.lineId), l])) : {};

    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM purchase_requisitions WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'طلب الشراء غير موجود');
      const reqRow = rows[0];
      if (reqRow.status !== 'approved') {
        throw err('INVALID_STATE_TRANSITION', 'يجب اعتماد الطلب قبل تحويله إلى أمر شراء');
      }

      // supplier must exist AND be active (same rule as orders.js)
      const [sup] = await conn.query('SELECT id, name, is_active FROM suppliers WHERE id = ? LIMIT 1', [b.supplierId]);
      if (!sup.length) throw err('VALIDATION_ERROR', 'المورد غير موجود');
      if (!Number(sup[0].is_active)) throw err('SUPPLIER_INACTIVE', 'المورد غير نشط ولا يقبل أوامر جديدة');

      const [reqLines] = await conn.query('SELECT * FROM purchase_requisition_lines WHERE requisition_id = ? ORDER BY id', [req.params.id]);
      if (!reqLines.length) throw err('VALIDATION_ERROR', 'لا يمكن تحويل طلب بلا سطور');

      // Requisition units are free-text (no UoM conversion) → factor = 1; the
      // estimated price becomes the PO unit price unless the approver overrides.
      const computed = reqLines.map((rl) => {
        const ov = overrides[String(rl.id)] || {};
        const unitPrice = ov.unitPrice != null ? Number(ov.unitPrice) : Number(rl.estimated_price);
        const c = calc.computeLine({
          enteredQty: Number(rl.quantity),
          factor: 1,
          unitPriceEntered: unitPrice,
          discount: ov.discount,
          vatRate: ov.vatRate,
          taxCode: ov.taxCode,
          inclusiveTax: ov.inclusiveTax,
        }, standardRate);
        return Object.assign(c, {
          itemId: rl.item_id, itemName: rl.item_name || '',
          enteredUnitCode: rl.unit || null,
        });
      });
      const totals = calc.computeTotals(computed);

      const poId = poGenId();
      const poNumber = await nextNumber(conn, 'po');
      const today = new Date().toISOString().slice(0, 10);
      await conn.query(
        `INSERT INTO purchase_orders
          (id, po_number, supplier_id, supplier_name, supplier_name_snapshot, po_date, expected_date, expected_date_snapshot,
           warehouse_id, brand_id, branch_id, cost_center_id, currency, status, version,
           total_before_vat, discount_amount, vat_amount, total_after_vat, notes, created_by, idempotency_key,
           requisition_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?,?,?,?,?,?,?)`,
        [poId, poNumber, sup[0].id, sup[0].name, sup[0].name,
         today, reqRow.needed_date || null, reqRow.needed_date || null,
         reqRow.warehouse_id || null, null, reqRow.branch_id || null, null, 'SAR',
         totals.subtotal, totals.discountAmount, totals.vatAmount, totals.total,
         `محوّل من طلب الشراء ${reqRow.req_number}`, actor, H.idemOf(req),
         // The back-reference. Notes carried the number as prose; prose is
         // not a foreign key and cannot be filtered or joined on.
         reqRow.id]);
      for (const l of computed) {
        await conn.query(
          `INSERT INTO po_lines
            (id, po_id, item_id, item_name, qty, unit_price, vat_rate, vat_amount, total, received_qty,
             unit, unit_type, conv_rate, entered_qty, entered_unit_id, entered_unit_code, conversion_factor_snapshot,
             base_qty, base_received_qty, unit_price_entered, base_unit_price, tax_code, inclusive_tax, discount, line_status)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'open')`,
          [poLineId(), poId, l.itemId, l.itemName, l.enteredQty, l.unitPriceEntered, l.vatRate, l.vatAmount, l.lineTotal,
           l.enteredUnitCode || '', 'entered', l.factor, l.enteredQty, null, l.enteredUnitCode, l.factor,
           l.baseQty, l.unitPriceEntered, l.baseUnitPrice, l.taxCode, l.inclusiveTax ? 1 : 0, l.discount]);
      }
      // domain event on the new PO (valid document_type) — mirrors orders.js
      try { await events.recordEvent(conn, { documentType: 'po', documentId: poId, action: 'create', toStatus: 'draft', actor, payload: { fromRequisition: reqRow.id } }); } catch (_) {}

      await conn.query(
        'UPDATE purchase_requisitions SET status = ?, po_id = ?, version = version + 1 WHERE id = ?',
        ['converted', poId, req.params.id]);
      return { poId, poNumber };
    });

    return H.sendOk(res, { data: { id: req.params.id, poId: out.poId }, documentNumber: out.poNumber, status: 'converted' }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

// ── DELETE /:id — draft only ─────────────────────────────────────────────────
router.delete('/:id', requireCapability(CAP_MANAGE), async (req, res) => {
  try {
    await ensureReady();
    await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT status FROM purchase_requisitions WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'طلب الشراء غير موجود');
      if (rows[0].status !== 'draft') throw err('INVALID_STATE_TRANSITION', 'لا يمكن حذف طلب شراء إلا وهو مسودة');
      await conn.query('DELETE FROM purchase_requisition_lines WHERE requisition_id = ?', [req.params.id]);
      await conn.query('DELETE FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    });
    return H.sendData(res, { id: req.params.id, deleted: true });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
