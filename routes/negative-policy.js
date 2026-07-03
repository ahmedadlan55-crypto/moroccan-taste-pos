'use strict';
/**
 * ─── Negative-stock policy settings (Phase W2b) ─────────────────────────────
 *
 * GET  /api/inventory/v2/negative-policy                 → list all rows
 * GET  /api/inventory/v2/negative-policy/effective?...   → computed decision
 * PUT  /api/inventory/v2/negative-policy                 → upsert one row
 *
 * Governed by the ordinary RBAC + expectedVersion + Audit pattern (mirrors
 * routes/inventory-items.js rules PUT). The BEHAVIOR (whether the guard runs
 * at issue time) is separate and gated by NEGATIVE_STOCK_POLICY_ENABLED; this
 * router only manages the stored configuration + reports the effective policy.
 */
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const C = require('../lib/inventoryTxContract');
const NSP = require('../lib/negativeStockPolicy');

function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _role(req) { return String((req.user && req.user.role) || '').toLowerCase(); }
function _isDev(req) { return !!(req.user && req.user.isDeveloper); }
function _isAdmin(req) { return _role(req) === 'admin' || _isDev(req); }
function _fail(res, code, msg) { return res.status(C.httpFor(code)).json(C.errorBody(code, msg)); }
function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function _expectedVersion(req) {
  const raw = (req.body && req.body.expectedVersion != null) ? req.body.expectedVersion : (req.get && req.get('If-Match'));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// GET / — list every configured row (global/warehouse/item) with names.
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT p.*, w.name AS warehouse_name, i.name AS item_name " +
      "FROM negative_stock_policy p " +
      "LEFT JOIN warehouses w ON w.id=p.warehouse_id " +
      "LEFT JOIN inv_items i ON i.id=p.item_id " +
      "ORDER BY FIELD(p.scope,'global','warehouse','item'), p.warehouse_id, p.item_id");
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id, scope: r.scope, warehouseId: r.warehouse_id, warehouseName: r.warehouse_name,
        itemId: r.item_id, itemName: r.item_name, policy: r.policy,
        maxNegativeQty: Number(r.max_negative_qty), requireReason: !!r.require_reason,
        isEnabled: !!r.is_enabled, version: Number(r.version), updatedBy: r.updated_by, updatedAt: r.updated_at,
      })),
      allowEnabled: NSP.ALLOW_ENABLED(), policyEnabled: NSP.POLICY_ENABLED(),
    });
  } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR', error: e.message }); }
});

// GET /effective — resolve the effective policy for a (warehouse,item) pair.
router.get('/effective', async (req, res) => {
  try {
    const warehouseId = req.query.warehouseId || null;
    const itemId = req.query.itemId || null;
    const [[g]] = await db.query("SELECT * FROM negative_stock_policy WHERE scope='global' AND warehouse_id IS NULL AND item_id IS NULL AND is_enabled=1 LIMIT 1").catch(() => [[]]);
    let wh = null, it = null, item = { tracking_mode: 'none' };
    if (warehouseId) { const [r] = await db.query("SELECT * FROM negative_stock_policy WHERE scope='warehouse' AND warehouse_id=? AND item_id IS NULL AND is_enabled=1 LIMIT 1", [warehouseId]); wh = r[0] || null; }
    if (warehouseId && itemId) { const [r] = await db.query("SELECT * FROM negative_stock_policy WHERE scope='item' AND warehouse_id=? AND item_id=? AND is_enabled=1 LIMIT 1", [warehouseId, itemId]); it = r[0] || null; }
    if (itemId) { const [r] = await db.query('SELECT tracking_mode FROM inv_items WHERE id=? LIMIT 1', [itemId]); if (r[0]) item = r[0]; }
    const resolved = NSP.resolvePolicy({ item, globalCfg: g || null, whCfg: wh, itemCfg: it });
    res.json({
      success: true,
      data: {
        effectivePolicy: resolved.effectivePolicy,
        effectiveMaxNegative: resolved.effectiveMaxNegative === Infinity ? null : resolved.effectiveMaxNegative,
        reason: resolved.reason, allowGated: resolved.allowGated,
        trackingMode: item.tracking_mode || 'none',
        levels: { global: g ? g.policy : null, warehouse: wh ? wh.policy : null, item: it ? it.policy : null },
      },
    });
  } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR', error: e.message }); }
});

// PUT / — upsert one policy row (admin; allow → developer). expectedVersion + audit.
router.put('/', async (req, res) => {
  try {
    if (!_isAdmin(req)) return _fail(res, 'PERMISSION_DENIED', 'هذه العملية تتطلب صلاحية إدارية');
    const b = req.body || {};
    const scope = String(b.scope || '').toLowerCase();
    if (!['global', 'warehouse', 'item'].includes(scope)) return _fail(res, 'VALIDATION_ERROR', "scope يجب أن يكون global أو warehouse أو item");
    const policy = String(b.policy || '').toLowerCase();
    if (!['block', 'controlled', 'allow'].includes(policy)) return _fail(res, 'VALIDATION_ERROR', 'policy غير صحيحة');
    if (policy === 'allow' && !_isDev(req)) return _fail(res, 'ALLOW_REQUIRES_DEVELOPER', 'سياسة allow تتطلب صلاحية developer');
    const warehouseId = scope === 'global' ? null : (b.warehouseId || null);
    const itemId = scope === 'item' ? (b.itemId || null) : null;
    if (scope !== 'global' && !warehouseId) return _fail(res, 'VALIDATION_ERROR', 'warehouseId مطلوب لهذا النطاق');
    if (scope === 'item' && !itemId) return _fail(res, 'VALIDATION_ERROR', 'itemId مطلوب لنطاق الصنف');
    const maxNeg = Number(b.maxNegativeQty);
    if (!Number.isFinite(maxNeg) || maxNeg < 0) return _fail(res, 'VALIDATION_ERROR', 'الحد الأقصى للعجز يجب أن يكون رقمًا ≥ 0');
    const requireReason = b.requireReason === false ? 0 : 1;
    const isEnabled = b.isEnabled === false ? 0 : 1;
    const expected = _expectedVersion(req);

    // A tracked item can never carry a non-block policy (BR-1).
    if (scope === 'item' && policy !== 'block') {
      const [it] = await db.query('SELECT tracking_mode FROM inv_items WHERE id=? LIMIT 1', [itemId]);
      if (it[0] && it[0].tracking_mode && it[0].tracking_mode !== 'none') {
        return _fail(res, 'POLICY_NOT_ALLOWED_FOR_TRACKED', 'الأصناف المتتبَّعة (دفعات/صلاحية) تُمنع دائمًا — لا يمكن ضبط سياسة غير block');
      }
    }

    const actor = _actor(req);
    const out = await db.withTransaction(async (conn) => {
      const [ex] = await conn.query('SELECT * FROM negative_stock_policy WHERE scope=? AND (warehouse_id <=> ?) AND (item_id <=> ?) LIMIT 1 FOR UPDATE', [scope, warehouseId, itemId]);
      let before = null;
      if (ex.length) {
        before = { policy: ex[0].policy, maxNegativeQty: Number(ex[0].max_negative_qty), isEnabled: !!ex[0].is_enabled };
        if (expected != null && Number(ex[0].version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّرت السياسة منذ آخر تحميل — أعد التحميل');
        await conn.query('UPDATE negative_stock_policy SET policy=?, max_negative_qty=?, require_reason=?, is_enabled=?, updated_by=?, version=version+1 WHERE id=?',
          [policy, maxNeg, requireReason, isEnabled, actor, ex[0].id]);
      } else {
        await conn.query('INSERT INTO negative_stock_policy (id, scope, warehouse_id, item_id, policy, max_negative_qty, require_reason, is_enabled, created_by, updated_by, version) VALUES (?,?,?,?,?,?,?,?,?,?,1)',
          ['NSP-' + crypto.randomBytes(6).toString('hex'), scope, warehouseId, itemId, policy, maxNeg, requireReason, isEnabled, actor, actor]);
      }
      const [now] = await conn.query('SELECT id, version FROM negative_stock_policy WHERE scope=? AND (warehouse_id <=> ?) AND (item_id <=> ?) LIMIT 1', [scope, warehouseId, itemId]);
      // Audit into the shared inv_tx_events stream.
      try {
        await conn.query(
          'INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
          ['EV-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), 'negative_policy', now[0].id, 'policy_changed', before ? before.policy : null, policy, actor,
           'تغيير سياسة المخزون السالب (' + scope + ')', JSON.stringify({ scope, warehouseId, itemId, before, after: { policy, maxNegativeQty: maxNeg, isEnabled: !!isEnabled } }).slice(0, 8000)]);
      } catch (_) {}
      return { id: now[0].id, version: Number(now[0].version) || 1 };
    });
    return res.status(200).json({ success: true, data: { id: out.id, scope, warehouseId, itemId }, status: 'saved', version: out.version });
  } catch (e) {
    if (e && e.code) return _fail(res, e.code, e.message);
    return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: e.message });
  }
});

// ── Deficit report: «عجز مخزني يجب تسويته» ──────────────────────────────────
const CSV = require('../lib/csvExport');
async function _loadDeficits(req) {
  const status = String(req.query.status || 'open').toLowerCase();
  const wh = req.query.warehouseId || null;
  const where = [];
  const args = [];
  if (status === 'open') { where.push("d.status IN ('open','partial')"); }
  else if (['partial', 'covered', 'adjusted'].includes(status)) { where.push('d.status=?'); args.push(status); }
  else if (status !== 'all') { where.push("d.status IN ('open','partial')"); }
  if (wh) { where.push('d.warehouse_id=?'); args.push(wh); }
  // scope: restrict to the caller's warehouses when enforcement is active.
  if (req.whScopeClause) { const c = req.whScopeClause('d.warehouse_id'); if (c.sql) { where.push(c.sql); args.push(...c.params); } }
  const sql = 'SELECT d.*, w.name AS warehouse_name, i.name AS item_name FROM stock_deficits d ' +
    'LEFT JOIN warehouses w ON w.id=d.warehouse_id LEFT JOIN inv_items i ON i.id=d.item_id ' +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY d.created_at DESC';
  const [rows] = await db.query(sql, args);
  return rows;
}
router.get('/deficits', async (req, res) => {
  try {
    const rows = await _loadDeficits(req);
    res.json({
      success: true,
      data: rows.map((d) => ({
        id: d.id, warehouseId: d.warehouse_id, warehouseName: d.warehouse_name,
        itemId: d.item_id, itemName: d.item_name, originDocType: d.origin_doc_type, originDocId: d.origin_doc_id,
        deficitQty: Number(d.deficit_qty), remainingQty: Number(d.remaining_qty), unitCostAtIssue: Number(d.unit_cost_at_issue),
        reason: d.reason, status: d.status, createdBy: d.created_by, createdAt: d.created_at, closedAt: d.closed_at,
      })),
      total: rows.length,
    });
  } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR', error: e.message }); }
});
router.get('/deficits/export', async (req, res) => {
  try {
    const rows = await _loadDeficits(req);
    const headers = ['id', 'warehouse', 'item', 'deficit_qty', 'remaining_qty', 'unit_cost', 'reason', 'status', 'created_by', 'created_at'];
    const csv = CSV.toCsv(headers, rows.map((d) => [d.id, d.warehouse_name || d.warehouse_id, d.item_name || d.item_id, Number(d.deficit_qty), Number(d.remaining_qty), Number(d.unit_cost_at_issue), d.reason, d.status, d.created_by, d.created_at]));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="stock-deficits.csv"');
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR', error: e.message }); }
});

module.exports = router;
