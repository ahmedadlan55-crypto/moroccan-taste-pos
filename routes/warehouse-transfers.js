/**
 * Warehouse Transfers — Phase 3A scoped READ router (READ-ONLY).
 *
 * Mounted under /api/inventory so the Phase 2A.2 scope middleware
 * (req.guardWh / req.guardTransfer / req.whScopeClause / req.warehouseScope) is
 * available. These endpoints feed the React /transfers grid + detail/timeline.
 * The legacy /api/erp/stock-issues GET endpoints (bare array/object) are left
 * UNTOUCHED — the old HTML UI keeps using them.
 *
 *   GET /transfers          → paginated + sorted envelope + status KPI totals
 *   GET /transfers/:id       → header + lines + version + audit timeline +
 *                              related inventory_movements + GL journal refs
 *
 * A transfer is visible when EITHER end (source/destination) is in the user's
 * allowed warehouse set. No mutations.
 */
'use strict';

const router = require('express').Router();
const db = require('../db/connection');
const TC = require('../lib/transferContract');

function _generatedAt() { return new Date().toISOString(); }
function _scopeInfo(req) {
  const s = req.warehouseScope || { all: true };
  return { allWarehousesAccess: !!s.all, warehouseId: req.query.warehouseId || null };
}

// Scope on transfers: keep rows where the source OR the destination is allowed.
function _scopeWhereTransfers(req, where, params) {
  const sf = req.whScopeClause ? req.whScopeClause('si.from_warehouse_id') : { sql: '', params: [] };
  const st = req.whScopeClause ? req.whScopeClause('si.to_warehouse_id') : { sql: '', params: [] };
  if (sf.sql) {
    where.push('(' + sf.sql.replace(/^\s*AND\s+/i, '') + ' OR ' + st.sql.replace(/^\s*AND\s+/i, '') + ')');
    params.push(...sf.params, ...st.params);
  }
}

// ── GET /transfers — list + KPI totals ──────────────────────────────────────
router.get('/transfers', async (req, res) => {
  try {
    const f = TC.parseListQuery(req.query);
    // An explicit ?warehouseId narrows to transfers touching that warehouse —
    // reject outright if the caller cannot access it (no existence leak).
    if (f.warehouseId && !req.guardWh(res, f.warehouseId)) return;

    const where = ['1=1'];
    const params = [];
    _scopeWhereTransfers(req, where, params);
    if (f.status) { where.push('si.status = ?'); params.push(f.status); }
    if (f.fromWarehouseId) { where.push('si.from_warehouse_id = ?'); params.push(f.fromWarehouseId); }
    if (f.toWarehouseId) { where.push('si.to_warehouse_id = ?'); params.push(f.toWarehouseId); }
    if (f.warehouseId) { where.push('(si.from_warehouse_id = ? OR si.to_warehouse_id = ?)'); params.push(f.warehouseId, f.warehouseId); }
    if (f.dateFrom) { where.push('si.issue_date >= ?'); params.push(f.dateFrom); }
    if (f.dateTo) { where.push('si.issue_date <= ?'); params.push(f.dateTo); }
    if (f.q) { where.push('(si.issue_number LIKE ? OR wf.name LIKE ? OR wt.name LIKE ?)'); const like = '%' + f.q + '%'; params.push(like, like, like); }
    const joins = ' LEFT JOIN warehouses wf ON wf.id = si.from_warehouse_id LEFT JOIN warehouses wt ON wt.id = si.to_warehouse_id';
    const whereSql = ' WHERE ' + where.join(' AND ');

    // Full-set count + status KPI totals + in-transit remaining (NOT page-bound).
    const [[cnt]] = await db.query('SELECT COUNT(*) AS n FROM stock_issues si' + joins + whereSql, params);
    const total = Number(cnt.n) || 0;
    const [statusRows] = await db.query('SELECT si.status, COUNT(*) AS n FROM stock_issues si' + joins + whereSql + ' GROUP BY si.status', params);
    const byStatus = {};
    for (const r of statusRows) byStatus[r.status] = Number(r.n) || 0;
    const [[rem]] = await db.query(
      'SELECT COALESCE(SUM(GREATEST(sii.qty_issued - sii.qty_received, 0)), 0) AS remaining ' +
      'FROM stock_issue_items sii JOIN stock_issues si ON si.id = sii.issue_id' + joins + whereSql +
      " AND si.status IN ('issued','partially_received')", params);

    // The page of rows.
    const [rows] = await db.query(
      `SELECT si.id, si.issue_number, si.status, si.version, si.issue_date, si.created_at,
              si.from_warehouse_id, si.to_warehouse_id, si.total_cost,
              wf.name AS from_warehouse_name, wt.name AS to_warehouse_name,
              (SELECT COUNT(*) FROM stock_issue_items WHERE issue_id = si.id) AS line_count,
              (SELECT COALESCE(SUM(GREATEST(qty_issued - qty_received, 0)), 0) FROM stock_issue_items WHERE issue_id = si.id) AS remaining_qty
         FROM stock_issues si${joins}${whereSql}
        ORDER BY si.${f.sort} ${f.dir}
        LIMIT ? OFFSET ?`, params.concat([f.pageSize, f.offset]));

    const data = rows.map((r) => ({
      id: String(r.id),
      number: String(r.issue_number || ''),
      status: String(r.status),
      version: Number(r.version) || 1,
      issueDate: r.issue_date,
      createdAt: r.created_at,
      fromWarehouse: { id: String(r.from_warehouse_id || ''), name: String(r.from_warehouse_name || r.from_warehouse_id || '') },
      toWarehouse: { id: String(r.to_warehouse_id || ''), name: String(r.to_warehouse_name || r.to_warehouse_id || '') },
      totalCost: Number(r.total_cost) || 0,
      lineCount: Number(r.line_count) || 0,
      remainingQty: Number(r.remaining_qty) || 0,
    }));

    const totals = {
      count: total,
      byStatus,
      draft: byStatus.draft || 0,
      approved: byStatus.approved || 0,
      issued: byStatus.issued || 0,
      partiallyReceived: byStatus.partially_received || 0,
      received: byStatus.received || 0,
      cancelled: byStatus.cancelled || 0,
      reversed: byStatus.reversed || 0,
      pending: (byStatus.draft || 0) + (byStatus.approved || 0),
      inTransit: (byStatus.issued || 0) + (byStatus.partially_received || 0),
      remainingQty: Number(rem.remaining) || 0,
    };

    res.json({
      success: true,
      data,
      totals,
      pagination: { page: f.page, pageSize: f.pageSize, total, totalPages: Math.max(1, Math.ceil(total / f.pageSize)) },
      filters: { status: f.status, fromWarehouseId: f.fromWarehouseId, toWarehouseId: f.toWarehouseId, warehouseId: f.warehouseId, dateFrom: f.dateFrom, dateTo: f.dateTo, q: f.q, sort: f.sort, dir: f.dir },
      scope: _scopeInfo(req),
      generatedAt: _generatedAt(),
      dataQualityWarnings: [],
    });
  } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR', error: e.message }); }
});

// ── GET /transfers/:id — detail + timeline ──────────────────────────────────
router.get('/transfers/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query(
      `SELECT si.*,
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
        WHERE si.id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'not found' });
    const h = rows[0];
    if (!req.guardTransfer(res, h.from_warehouse_id, h.to_warehouse_id)) return;

    const [items] = await db.query(
      'SELECT sii.*, i.name AS item_name, i.unit AS item_unit FROM stock_issue_items sii LEFT JOIN inv_items i ON i.id = sii.item_id WHERE sii.issue_id = ? ORDER BY sii.id', [id]);
    const lines = items.map((it) => {
      const qi = Number(it.qty_issued) || 0, qr = Number(it.qty_received) || 0;
      return {
        id: String(it.id), itemId: String(it.item_id), itemName: String(it.item_name || it.item_id || ''),
        unit: String(it.item_unit || ''), qtyRequested: Number(it.qty_requested) || 0,
        qtyIssued: qi, qtyReceived: qr, qtyRemaining: Math.max(0, qi - qr),
        unitCost: Number(it.unit_cost) || 0, lineTotal: Number(it.line_total) || 0,
      };
    });

    // Timeline: prefer the append-only audit events; fall back to the stamped
    // actor/at columns when the events table is empty (pre-Phase-3A rows).
    let timeline = [];
    try {
      const [ev] = await db.query(
        'SELECT action, from_status, to_status, actor, note, created_at FROM stock_issue_events WHERE issue_id = ? ORDER BY created_at, id', [id]);
      timeline = ev.map((e) => ({ action: e.action, fromStatus: e.from_status, toStatus: e.to_status, actor: e.actor || '', note: e.note || null, at: e.created_at }));
    } catch (_) { /* events table optional */ }
    if (!timeline.length) {
      timeline = [
        ['create', h.created_by_name || h.created_by, h.created_at],
        ['approve', h.approved_by_name || h.approved_by, h.approved_at],
        ['issue', h.issued_by_name || h.issued_by, h.issued_at],
        ['receive', h.received_by_name || h.received_by, h.received_at],
        ['reverse', h.reversed_by_name || h.reversed_by, h.reversed_at],
      ].filter((d) => d[2]).map((d) => ({ action: d[0], actor: d[1] || '', note: null, at: d[2] }));
    }

    // Related ledger movements + GL journal references (read-only).
    let movements = [];
    try {
      const [mv] = await db.query(
        "SELECT id, movement_date, type, qty, reason, warehouse_id, item_id, item_name FROM inventory_movements WHERE reference_id = ? AND reference_type IN ('transfer','transfer_reverse') ORDER BY movement_date, id", [id]);
      movements = mv.map((m) => ({ id: String(m.id), at: m.movement_date, type: m.type, qty: Number(m.qty) || 0, reason: m.reason || '', warehouseId: String(m.warehouse_id || ''), itemId: String(m.item_id || ''), itemName: String(m.item_name || '') }));
    } catch (_) { /* ignore */ }

    res.json({
      success: true,
      data: {
        id: String(h.id), number: String(h.issue_number || ''), status: String(h.status), version: Number(h.version) || 1,
        issueDate: h.issue_date, createdAt: h.created_at,
        fromWarehouse: { id: String(h.from_warehouse_id || ''), name: String(h.from_warehouse_name || h.from_warehouse_id || ''), code: String(h.from_warehouse_code || '') },
        toWarehouse: { id: String(h.to_warehouse_id || ''), name: String(h.to_warehouse_name || h.to_warehouse_id || ''), code: String(h.to_warehouse_code || '') },
        totalCost: Number(h.total_cost) || 0,
        actors: {
          createdBy: String(h.created_by_name || h.created_by || ''),
          approvedBy: String(h.approved_by_name || h.approved_by || ''),
          issuedBy: String(h.issued_by_name || h.issued_by || ''),
          receivedBy: String(h.received_by_name || h.received_by || ''),
          reversedBy: String(h.reversed_by_name || h.reversed_by || ''),
        },
        reverseReason: h.reverse_reason || null,
        lines,
        timeline,
        movements,
        gl: { issueJournalId: h.gl_journal_id || null, reverseJournalId: h.reverse_gl_journal_id || null },
      },
      scope: _scopeInfo(req),
      generatedAt: _generatedAt(),
    });
  } catch (e) { res.status(500).json({ success: false, code: 'SERVER_ERROR', error: e.message }); }
});

module.exports = router;
