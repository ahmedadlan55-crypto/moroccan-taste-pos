/**
 * Stocktake Pro — V5.4 (professional stocktake with workflow + variance)
 *
 *   GET  /stocktake-pro                       — list (filter: warehouse, status, dateFrom/To)
 *   GET  /stocktake-pro/:id                   — single + items + variance summary
 *   POST /stocktake-pro                       — create draft (warehouse + count_method + threshold)
 *   POST /stocktake-pro/:id/load-snapshot     — auto-populate items from current warehouse stock
 *   POST /stocktake-pro/:id/items             — bulk add/update items (actual_qty per item)
 *   POST /stocktake-pro/:id/items/scan        — single-item rapid entry by barcode/code
 *   PUT  /stocktake-pro/:id/items/:lineId     — update one line (actual_qty, notes, photo, reason)
 *   POST /stocktake-pro/:id/submit            — draft → pending_approval (recompute variance)
 *   POST /stocktake-pro/:id/approve           — pending_approval → approved → posts adjustments
 *   POST /stocktake-pro/:id/reject            — pending_approval → rejected (with reason)
 *   POST /stocktake-pro/:id/cancel            — only draft
 *   GET  /stocktake-pro/:id/export            — CSV export of variances
 */
const router = require('express').Router();
const db = require('../db/connection');
const gl = require('../lib/glPosting');
// v7.1 — sync the inv_items.stock rollup after a stocktake sets warehouse_stock.
const { recomputeInvItemStock } = require('../lib/stockRecompute');
// v7.4 — stocktake approve/reject post stock + GL adjustments → managers only.
const MGR = require('../middleware/auth').requireRole('admin', 'manager');
// Phase 0 — shared workflow + variance helpers (tests/stocktakeWorkflow.test.js
// validates the exact same functions the route uses, so they can never drift).
const STK = require('../lib/stocktakeWorkflow');

function _id(p){ return p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }

// Phase 0 §5 — actor identity from the authenticated JWT (req.user). The
// state-changing actions (submit/approve/reject) take the actor STRICTLY from
// the session; create/edit keep a body fallback for tooling.
function _actor(req, fallback) {
  return (req.user && (req.user.username || req.user.name)) || fallback || '';
}

const REASON_CODES = {
  'damage':       'تلف',
  'expiry':       'انتهاء صلاحية',
  'theft':        'فقد/سرقة',
  'count_error':  'خطأ في الجرد',
  'received':     'استلام غير مسجل',
  'transferred':  'تحويل غير مسجل',
  'sold':         'بيع غير مسجل',
  'production':   'استهلاك إنتاج',
  'other':        'أخرى'
};
router.get('/__reason-codes', (req, res) => res.json(REASON_CODES));

router.get('/', async (req, res) => {
  try {
    const { warehouseId, status, dateFrom, dateTo, brandId } = req.query;
    const conds = []; const params = [];
    if (warehouseId) { conds.push('s.warehouse_id = ?'); params.push(warehouseId); }
    if (status) { conds.push('COALESCE(s.workflow_status, s.status) = ?'); params.push(status); }
    if (dateFrom) { conds.push('s.stocktake_date >= ?'); params.push(dateFrom); }
    if (dateTo) { conds.push('s.stocktake_date <= ?'); params.push(dateTo); }
    if (brandId) { conds.push('w.brand_id = ?'); params.push(brandId); }
    const _scope = req.whScopeClause('s.warehouse_id');
    if (_scope.sql) { conds.push(_scope.sql.replace(/^ AND /, '')); params.push(..._scope.params); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const [rows] = await db.query(`
      SELECT s.*, w.name AS warehouse_name, br.name AS branch_name,
             COALESCE(s.workflow_status, s.status) AS effective_status,
             (SELECT COUNT(*) FROM stocktake_items WHERE stocktake_id = s.id) AS line_count,
             (SELECT COUNT(*) FROM stocktake_items WHERE stocktake_id = s.id AND is_flagged = 1) AS flagged_count
      FROM stocktakes s
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN branches br ON br.id = s.branch_id
      ${where}
      ORDER BY s.stocktake_date DESC, s.id DESC LIMIT 500`, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const [hRows] = await db.query(`
      SELECT s.*, w.name AS warehouse_name, br.name AS branch_name,
             COALESCE(s.workflow_status, s.status) AS effective_status
      FROM stocktakes s
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN branches br ON br.id = s.branch_id
      WHERE s.id = ?`, [req.params.id]);
    if (!hRows.length) return res.status(404).json({ error: 'Not found' });
    if (!req.guardWh(res, hRows[0].warehouse_id)) return;
    // V5-FIX: legacy schema uses inv_item_id (not item_id). Map to item_id in output for UI consistency.
    // V5.7.26 — also surface big_unit + conv_rate so the frontend can
    //   render the unified WoQtyInput widget (major + minor + auto-sync).
    const [items] = await db.query(`
      SELECT si.id, si.stocktake_id, si.inv_item_id AS item_id,
             si.system_qty, si.actual_qty, si.variance,
             si.unit_cost, si.variance_value, si.variance_pct, si.is_flagged,
             si.verified_by, si.verified_at, si.reason_code, si.notes,
             COALESCE(it.name, si.inv_item_name, si.inv_item_id) AS item_name,
             '' AS item_code,
             COALESCE(it.unit, si.unit, '') AS item_unit,
             COALESCE(it.big_unit, '') AS big_unit,
             COALESCE(it.conv_rate, 1) AS conv_rate,
             COALESCE(it.stock, 0) AS current_stock
      FROM stocktake_items si
      LEFT JOIN inv_items it ON it.id = si.inv_item_id
      WHERE si.stocktake_id = ? ORDER BY si.is_flagged DESC, si.variance_pct DESC`, [req.params.id]);
    // Compute summary
    const summary = {
      total_lines: items.length,
      total_system_qty: 0,
      total_actual_qty: 0,
      total_variance_qty: 0,
      total_variance_value: 0,
      flagged_lines: 0,
      verified_lines: 0,
      reasons: {}
    };
    items.forEach(i => {
      summary.total_system_qty  += Number(i.system_qty)  || 0;
      summary.total_actual_qty  += Number(i.actual_qty)  || 0;
      summary.total_variance_qty += Number(i.variance)    || 0;
      summary.total_variance_value += Number(i.variance_value) || 0;
      if (i.is_flagged)  summary.flagged_lines++;
      if (i.verified_at) summary.verified_lines++;
      if (i.reason_code) {
        summary.reasons[i.reason_code] = (summary.reasons[i.reason_code] || 0) + 1;
      }
    });
    res.json({ ...hRows[0], items, summary });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.warehouseId) return res.status(400).json({ error: 'warehouseId required' });
    if (!req.guardWh(res, b.warehouseId)) return;
    const id = b.id || _id('STK');
    // V5-FIX: existing stocktakes.status ENUM may not include 'draft' — use 'completed'
    // for the legacy column and rely on workflow_status for the new state.
    await db.query(`
      INSERT INTO stocktakes
        (id, stocktake_date, username, notes, status, items_count, total_variance,
         warehouse_id, branch_id, workflow_status, variance_threshold_pct, count_method)
      VALUES (?, ?, ?, ?, 'completed', 0, 0, ?, ?, 'draft', ?, ?)`,
      [id, b.stocktakeDate || new Date().toISOString().slice(0,10),
       _actor(req, b.username) || 'system',
       b.notes || null, b.warehouseId, b.branchId || null,
       b.varianceThresholdPct != null ? b.varianceThresholdPct : 10,
       b.countMethod || 'full']);
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/load-snapshot', async (req, res) => {
  try {
    const [hRows] = await db.query('SELECT warehouse_id, workflow_status FROM stocktakes WHERE id = ?', [req.params.id]);
    if (!hRows.length) return res.status(404).json({ error: 'Not found' });
    if (!req.guardWh(res, hRows[0].warehouse_id)) return;
    if (hRows[0].workflow_status !== 'draft' && hRows[0].workflow_status !== 'in_progress') {
      return res.status(409).json({ error: 'لا يمكن إعادة التحميل بعد المراجعة' });
    }
    const wh = hRows[0].warehouse_id;
    // V5-FIX: actual inv_items columns are id/name/cost/stock/active.
    // Try warehouse_stock first, fall back to inv_items.stock.
    let stockRows;
    try {
      [stockRows] = await db.query(`
        SELECT it.id AS item_id, COALESCE(ws.qty, 0) AS system_qty, COALESCE(it.cost,0) AS unit_cost
        FROM inv_items it
        LEFT JOIN warehouse_stock ws ON ws.item_id = it.id AND ws.warehouse_id = ?
        WHERE COALESCE(it.active, 1) = 1 AND it.deleted_at IS NULL
        ORDER BY it.name LIMIT 5000`, [wh]);
    } catch(_e) {
      try {
        [stockRows] = await db.query(`
          SELECT id AS item_id, COALESCE(stock,0) AS system_qty, COALESCE(cost,0) AS unit_cost
          FROM inv_items WHERE COALESCE(active,1) = 1 LIMIT 5000`);
      } catch(_e2) {
        [stockRows] = [];
      }
    }
    // Clear old lines
    await db.query('DELETE FROM stocktake_items WHERE stocktake_id = ?', [req.params.id]);
    // V5-FIX: legacy schema uses inv_item_id (not item_id) and INT auto-increment id.
    let inserted = 0;
    for (const r of stockRows) {
      await db.query(`
        INSERT INTO stocktake_items
          (stocktake_id, inv_item_id, system_qty, actual_qty, variance, unit_cost, variance_value, variance_pct)
        VALUES (?, ?, ?, ?, 0, ?, 0, 0)`,
        [req.params.id, r.item_id, r.system_qty, r.system_qty, r.unit_cost || 0]);
      inserted++;
    }
    await db.query(`UPDATE stocktakes SET workflow_status = 'in_progress', items_count = ? WHERE id = ?`,
      [inserted, req.params.id]);
    res.json({ success: true, inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/items/:lineId', async (req, res) => {
  try {
    const b = req.body || {};
    // Load the line + threshold
    const [lRows] = await db.query(`
      SELECT si.*, s.variance_threshold_pct, s.warehouse_id
      FROM stocktake_items si
      JOIN stocktakes s ON s.id = si.stocktake_id
      WHERE si.id = ?`, [req.params.lineId]);
    if (!lRows.length) return res.status(404).json({ error: 'Line not found' });
    const line = lRows[0];
    if (!req.guardWh(res, line.warehouse_id)) return;
    const threshold = Number(line.variance_threshold_pct) || 10;
    const newActual = b.actualQty != null ? Number(b.actualQty) : Number(line.actual_qty);
    // Phase 0 — variance math via the shared helper so the route and the
    // contract test stay in lock-step.
    const _v = STK.computeVariance({
      systemQty: line.system_qty, actualQty: newActual,
      unitCost: line.unit_cost, thresholdPct: threshold
    });
    const variance = _v.variance;
    const variancePct = _v.variancePct;
    const varianceValue = _v.varianceValue;
    const isFlagged = _v.isFlagged ? 1 : 0;
    const sets = ['actual_qty=?','variance=?','variance_pct=?','variance_value=?','is_flagged=?'];
    const params = [newActual, variance, variancePct, varianceValue, isFlagged];
    if (b.reasonCode !== undefined) { sets.push('reason_code=?'); params.push(b.reasonCode || null); }
    if (b.notes !== undefined)      { sets.push('notes=?'); params.push(b.notes || null); }
    if (b.photoData !== undefined)  { sets.push('photo_data=?'); params.push(b.photoData || null); }
    if (b.verified)                  {
      sets.push('verified_by=?,verified_at=NOW()');
      params.push(_actor(req, b.verifiedBy) || 'system');
    }
    params.push(req.params.lineId);
    await db.query(`UPDATE stocktake_items SET ${sets.join(',')} WHERE id = ?`, params);
    res.json({ success: true, variance, variancePct, varianceValue, isFlagged: !!isFlagged });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/items/scan', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.itemCode && !b.itemId) return res.status(400).json({ error: 'itemCode or itemId required' });
    const [stRows] = await db.query('SELECT warehouse_id FROM stocktakes WHERE id = ?', [req.params.id]);
    if (!stRows.length) return res.status(404).json({ error: 'Not found' });
    if (!req.guardWh(res, stRows[0].warehouse_id)) return;
    let lineId = null;
    let item = null;
    if (b.itemId) {
      const [r] = await db.query(`SELECT * FROM inv_items WHERE id = ?`, [b.itemId]);
      if (r.length) item = r[0];
    }
    if (!item && b.itemCode) {
      // Phase W4 — match id, barcode (primary + secondary), then name.
      const bn = require('../lib/barcode').normalize(b.itemCode);
      const [r] = await db.query(
        'SELECT * FROM inv_items WHERE id = ? OR barcode_norm = ? OR id IN (SELECT item_id FROM item_barcodes WHERE code_norm = ?) OR name LIKE ? LIMIT 1',
        [b.itemCode, bn, bn, '%' + b.itemCode + '%']);
      if (r.length) item = r[0];
    }
    if (!item) return res.status(404).json({ error: 'الصنف غير موجود' });
    // Find existing line in this stocktake (legacy column inv_item_id)
    const [exRows] = await db.query(`
      SELECT id FROM stocktake_items WHERE stocktake_id = ? AND inv_item_id = ?`,
      [req.params.id, item.id]);
    if (exRows.length) {
      lineId = exRows[0].id;
    } else {
      const [hRows] = await db.query('SELECT warehouse_id FROM stocktakes WHERE id = ?', [req.params.id]);
      let systemQty = 0; let unitCost = Number(item.cost) || 0;
      try {
        const [ws] = await db.query(`SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?`,
          [hRows[0].warehouse_id, item.id]);
        if (ws.length) systemQty = Number(ws[0].qty);
      } catch(_) { systemQty = Number(item.stock) || 0; }
      const [insR] = await db.query(`
        INSERT INTO stocktake_items
          (stocktake_id, inv_item_id, inv_item_name, system_qty, actual_qty, variance, unit_cost, variance_value, variance_pct)
        VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0)`,
        [req.params.id, item.id, item.name, systemQty, systemQty, unitCost]);
      lineId = insR.insertId;
    }
    if (b.actualQty != null) {
      req.body = { actualQty: b.actualQty };
      req.params.lineId = lineId;
      return router.handle({ ...req, method: 'PUT', url: '/'+req.params.id+'/items/'+lineId }, res, () => {});
    }
    res.json({ success: true, lineId, item: { id: item.id, code: item.id, name: item.name } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/submit', async (req, res) => {
  try {
    const username = _actor(req) || 'system'; // Phase 0 §5 — actor from JWT only
    const [hRows] = await db.query('SELECT warehouse_id FROM stocktakes WHERE id = ?', [req.params.id]);
    if (!hRows.length) return res.status(404).json({ error: 'Not found' });
    if (!req.guardWh(res, hRows[0].warehouse_id)) return;
    // Recompute totals
    const [agg] = await db.query(`
      SELECT
        COUNT(*) AS line_count,
        SUM(variance) AS total_variance,
        SUM(variance_value) AS total_variance_value,
        SUM(CASE WHEN is_flagged = 1 THEN 1 ELSE 0 END) AS flagged_count
      FROM stocktake_items WHERE stocktake_id = ?`, [req.params.id]);
    await db.query(`
      UPDATE stocktakes SET
        workflow_status = 'pending_approval',
        items_count = ?, total_variance = ?,
        submitted_by = ?, submitted_at = NOW()
      WHERE id = ?`, [agg[0].line_count, agg[0].total_variance, username, req.params.id]);
    res.json({ success: true, summary: agg[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/approve', MGR, async (req, res) => {
  try {
    const username = _actor(req) || 'system'; // Phase 0 §5 — actor from JWT only

    // v7.4 (B3b/c/d) + Phase 0 — the whole approval is ATOMIC and CONCURRENCY-
    // SAFE: the header is locked FOR UPDATE and the status gate + the final flip
    // are state-guarded, so two concurrent approvals can no longer BOTH post the
    // ledger rows + variance GL journal for one count. warehouse_stock set +
    // ledger rows (CORRECT columns & in/out type) + a balanced GL variance
    // journal (Dr inventory/gain, Cr loss/inventory) all commit or roll back
    // together. GL failure aborts the whole approval (no silent drift).
    const result = await db.withTransaction(async (conn) => {
      // Phase 0 — lock the header, gate the status INSIDE the txn.
      const [hRows] = await conn.query(`SELECT * FROM stocktakes WHERE id = ? FOR UPDATE`, [req.params.id]);
      if (!hRows.length) { const e = new Error('Not found'); e.status = 404; throw e; }
      const h = hRows[0];
      if (!req.guardWh(res, h.warehouse_id)) { const e = new Error('__wh_denied'); e.handled = true; throw e; }
      if (!STK.canApprove(h.workflow_status)) {
        const e = new Error('الجرد ليس بانتظار الاعتماد'); e.status = 409; throw e;
      }

      // v7.4 (B3a) — a physical count can never be negative. Block approval so a
      // data-entry slip can't lock a negative on-hand into stock + GL.
      const [negRows] = await conn.query(
        `SELECT COUNT(*) AS n FROM stocktake_items WHERE stocktake_id = ? AND actual_qty < 0`,
        [req.params.id]);
      if (negRows[0] && Number(negRows[0].n) > 0) {
        const e = new Error('لا يمكن اعتماد جرد يحتوي على كمية فعلية سالبة. صحّح العدّ أولاً.');
        e.status = 400; throw e;
      }

      // Only changed lines drive adjustments. JOIN inv_items for the ledger name.
      const [items] = await conn.query(
        `SELECT si.*, i.name AS item_name FROM stocktake_items si
         LEFT JOIN inv_items i ON i.id = si.inv_item_id
         WHERE si.stocktake_id = ? AND ABS(si.variance) > 0.001`,
        [req.params.id]);

      let movements = 0;
      const glLines = [];
      for (const ln of items) {
        await conn.query(`
          INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE qty = VALUES(qty)`,
          [_id('WS'), h.warehouse_id, ln.inv_item_id, ln.actual_qty]);
        try { await recomputeInvItemStock(conn, ln.inv_item_id); } catch (_e) {}

        const variance = Number(ln.variance) || 0;          // actual − system (signed)
        const adjType  = variance >= 0 ? 'in' : 'out';
        const adjQty   = Math.abs(variance);
        const movId    = _id('MOV');
        try {
          await conn.query(`
            INSERT INTO inventory_movements
              (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id)
            VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, 'stocktake', ?)`,
            [movId, ln.inv_item_id, ln.item_name || ln.inv_item_id, adjType, adjQty,
             'تسوية جرد', username, ('Stocktake adjustment ' + (ln.reason_code || '')).trim(),
             h.warehouse_id, req.params.id]);
        } catch (_e) {
          // Older deploys may lack warehouse_id/reference_* columns — minimal fallback.
          await conn.query(`
            INSERT INTO inventory_movements
              (id, movement_date, item_id, item_name, type, qty, reason, username, notes)
            VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?)`,
            [movId, ln.inv_item_id, ln.item_name || ln.inv_item_id, adjType, adjQty,
             'تسوية جرد', username, 'Stocktake ' + req.params.id]);
        }

        // GL line(s): value the variance at the line cost. Gain → Dr Inventory /
        // Cr Stock-Gain ; Loss → Dr Stock-Variance (expense) / Cr Inventory.
        const val = Math.round(variance * (Number(ln.unit_cost) || 0) * 100) / 100;
        if (val > 0.005) {
          glLines.push({ accountCode: gl.CORE_ACCOUNTS.INVENTORY.code,  debit: val, credit: 0, warehouseId: h.warehouse_id });
          glLines.push({ accountCode: gl.CORE_ACCOUNTS.STOCK_GAIN.code, debit: 0, credit: val, warehouseId: h.warehouse_id });
        } else if (val < -0.005) {
          const loss = Math.abs(val);
          glLines.push({ accountCode: gl.CORE_ACCOUNTS.STOCK_VARIANCE.code, debit: loss, credit: 0, warehouseId: h.warehouse_id });
          glLines.push({ accountCode: gl.CORE_ACCOUNTS.INVENTORY.code,      debit: 0, credit: loss, warehouseId: h.warehouse_id });
        }
        movements++;
      }

      let glId = null;
      if (glLines.length) {
        const glRes = await gl.postJournal(conn, {
          referenceType: 'stocktake',
          referenceId: req.params.id,
          description: 'تسوية جرد مخزني — ' + (h.warehouse_id || ''),
          postedBy: username,
          entries: glLines
        });
        if (!glRes || !glRes.success) {
          throw new Error('فشل ترحيل قيد تسوية الجرد: ' + ((glRes && glRes.error) || 'خطأ غير معروف'));
        }
        glId = glRes.journalId;
      }

      // Phase 0 — state-guarded flip: a concurrent double-approve loses here
      // (affectedRows=0) and rolls its own ledger rows + GL journal back.
      const [flip] = await conn.query(`
        UPDATE stocktakes SET workflow_status = 'approved', status = 'completed',
          approved_by = ?, approved_at = NOW()
        WHERE id = ? AND workflow_status = 'pending_approval'`, [username, req.params.id]);
      if (!flip || flip.affectedRows !== 1) {
        const e = new Error('تغيّرت حالة الجرد (اعتماد متزامن؟) — أعد التحميل'); e.status = 409; throw e;
      }

      return { movements, glId };
    });

    res.json({ success: true, movements: result.movements, glJournalId: result.glId });
  } catch(e) { if (e.handled) return; res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/:id/reject', MGR, async (req, res) => {
  try {
    const username = _actor(req) || 'system'; // Phase 0 §5 — actor from JWT only
    const reason = (req.body && req.body.reason) || '';
    if (reason.length < 10) return res.status(400).json({ error: 'سبب الرفض مطلوب (10 أحرف على الأقل)' });
    // Phase 0 — only a pending_approval count can be rejected. Without this a
    // reject could overwrite an already-approved (posted) count's status to
    // 'rejected', which then made the posted count deletable (STK.canDelete).
    const [h] = await db.query('SELECT workflow_status, warehouse_id FROM stocktakes WHERE id = ?', [req.params.id]);
    if (!h.length) return res.status(404).json({ error: 'Not found' });
    if (!req.guardWh(res, h[0].warehouse_id)) return;
    if (!STK.canReject(h[0].workflow_status)) {
      return res.status(409).json({ error: 'لا يمكن رفض جرد ليس بانتظار الاعتماد' });
    }
    const [rej] = await db.query(`
      UPDATE stocktakes SET workflow_status = 'rejected',
        rejected_by = ?, rejected_at = NOW(), rejection_reason = ?
      WHERE id = ? AND workflow_status = 'pending_approval'`, [username, reason, req.params.id]);
    if (!rej || rej.affectedRows !== 1) {
      return res.status(409).json({ error: 'تغيّرت حالة الجرد — أعد التحميل' });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const [r] = await db.query(`SELECT workflow_status, warehouse_id FROM stocktakes WHERE id = ?`, [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Not found' });
    if (!req.guardWh(res, r[0].warehouse_id)) return;
    if (!STK.canCancel(r[0].workflow_status)) {
      return res.status(409).json({ error: 'لا يمكن الإلغاء بعد التقديم' });
    }
    await db.query(`UPDATE stocktakes SET workflow_status = 'cancelled' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/export', async (req, res) => {
  try {
    const [hRows] = await db.query('SELECT warehouse_id FROM stocktakes WHERE id = ?', [req.params.id]);
    if (!hRows.length) return res.status(404).json({ error: 'Not found' });
    if (!req.guardWh(res, hRows[0].warehouse_id)) return;
    const [items] = await db.query(`
      SELECT si.*, COALESCE(it.name, si.inv_item_name, si.inv_item_id) AS item_name,
             si.inv_item_id AS item_id
      FROM stocktake_items si
      LEFT JOIN inv_items it ON it.id = si.inv_item_id
      WHERE si.stocktake_id = ? ORDER BY si.is_flagged DESC, si.variance_pct DESC`, [req.params.id]);
    const headers = ['ID','الصنف','المخزون النظامي','الكمية الفعلية','الفرق','نسبة الفرق %','قيمة الفرق','الحالة','السبب','ملاحظة'];
    let csv = '﻿' + headers.join(',') + '\n';
    items.forEach(i => {
      const row = [
        i.item_id || '',
        (i.item_name || '').replace(/"/g,'""'),
        i.system_qty,
        i.actual_qty,
        i.variance,
        i.variance_pct || 0,
        i.variance_value || 0,
        i.is_flagged ? 'مُعلَّمة' : 'عادية',
        REASON_CODES[i.reason_code] || i.reason_code || '',
        (i.notes || '').replace(/"/g,'""')
      ];
      csv += row.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=stocktake_'+req.params.id+'.csv');
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
