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

function _id(p){ return p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }

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
    const id = b.id || _id('STK');
    // V5-FIX: existing stocktakes.status ENUM may not include 'draft' — use 'completed'
    // for the legacy column and rely on workflow_status for the new state.
    await db.query(`
      INSERT INTO stocktakes
        (id, stocktake_date, username, notes, status, items_count, total_variance,
         warehouse_id, branch_id, workflow_status, variance_threshold_pct, count_method)
      VALUES (?, ?, ?, ?, 'completed', 0, 0, ?, ?, 'draft', ?, ?)`,
      [id, b.stocktakeDate || new Date().toISOString().slice(0,10),
       b.username || (req.user && req.user.username) || 'system',
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
      SELECT si.*, s.variance_threshold_pct
      FROM stocktake_items si
      JOIN stocktakes s ON s.id = si.stocktake_id
      WHERE si.id = ?`, [req.params.lineId]);
    if (!lRows.length) return res.status(404).json({ error: 'Line not found' });
    const line = lRows[0];
    const threshold = Number(line.variance_threshold_pct) || 10;
    const newActual = b.actualQty != null ? Number(b.actualQty) : Number(line.actual_qty);
    const variance = Math.round((newActual - Number(line.system_qty)) * 1000) / 1000;
    const variancePct = Number(line.system_qty) > 0
      ? Math.round((Math.abs(variance) / Number(line.system_qty)) * 10000) / 100 : (variance ? 100 : 0);
    const varianceValue = Math.round(variance * (Number(line.unit_cost)||0) * 100) / 100;
    const isFlagged = variancePct >= threshold ? 1 : 0;
    const sets = ['actual_qty=?','variance=?','variance_pct=?','variance_value=?','is_flagged=?'];
    const params = [newActual, variance, variancePct, varianceValue, isFlagged];
    if (b.reasonCode !== undefined) { sets.push('reason_code=?'); params.push(b.reasonCode || null); }
    if (b.notes !== undefined)      { sets.push('notes=?'); params.push(b.notes || null); }
    if (b.photoData !== undefined)  { sets.push('photo_data=?'); params.push(b.photoData || null); }
    if (b.verified)                  {
      sets.push('verified_by=?,verified_at=NOW()');
      params.push(b.verifiedBy || (req.user && req.user.username) || 'system');
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
    let lineId = null;
    let item = null;
    if (b.itemId) {
      const [r] = await db.query(`SELECT * FROM inv_items WHERE id = ?`, [b.itemId]);
      if (r.length) item = r[0];
    }
    if (!item && b.itemCode) {
      const [r] = await db.query(`SELECT * FROM inv_items WHERE id = ? OR name LIKE ? LIMIT 1`,
        [b.itemCode, '%'+b.itemCode+'%']);
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
    const username = (req.body && req.body.username) || (req.user && req.user.username) || 'system';
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

router.post('/:id/approve', async (req, res) => {
  try {
    const username = (req.body && req.body.username) || (req.user && req.user.username) || 'system';
    const [hRows] = await db.query(`SELECT * FROM stocktakes WHERE id = ?`, [req.params.id]);
    if (!hRows.length) return res.status(404).json({ error: 'Not found' });
    const h = hRows[0];
    if (h.workflow_status !== 'pending_approval') {
      return res.status(409).json({ error: 'الجرد ليس بانتظار الاعتماد' });
    }
    const [items] = await db.query(`SELECT * FROM stocktake_items WHERE stocktake_id = ? AND ABS(variance) > 0.001`,
      [req.params.id]);
    let movements = 0;
    for (const ln of items) {
      try {
        // V5-FIX: legacy column inv_item_id — try insert-or-update warehouse_stock
        await db.query(`
          INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE qty = VALUES(qty)`,
          [_id('WS'), h.warehouse_id, ln.inv_item_id, ln.actual_qty]);
        try {
          await db.query(`
            INSERT INTO inventory_movements
              (id, item_id, warehouse_id, type, qty, unit_cost, ref_type, ref_id, notes, username, created_at)
            VALUES (?, ?, ?, 'adjust', ?, ?, 'stocktake', ?, ?, ?, NOW())`,
            [_id('MOV'), ln.inv_item_id, h.warehouse_id, ln.variance, ln.unit_cost,
             req.params.id, 'Stocktake adjustment ' + (ln.reason_code || ''), username]);
        } catch(_e) {}
        movements++;
      } catch(_e) {}
    }
    await db.query(`
      UPDATE stocktakes SET workflow_status = 'approved', status = 'completed',
        approved_by = ?, approved_at = NOW()
      WHERE id = ?`, [username, req.params.id]);
    res.json({ success: true, movements });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const username = (req.body && req.body.username) || (req.user && req.user.username) || 'system';
    const reason = (req.body && req.body.reason) || '';
    if (reason.length < 10) return res.status(400).json({ error: 'سبب الرفض مطلوب (10 أحرف على الأقل)' });
    await db.query(`
      UPDATE stocktakes SET workflow_status = 'rejected',
        rejected_by = ?, rejected_at = NOW(), rejection_reason = ?
      WHERE id = ?`, [username, reason, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const [r] = await db.query(`SELECT workflow_status FROM stocktakes WHERE id = ?`, [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Not found' });
    if (!['draft','in_progress'].includes(r[0].workflow_status)) {
      return res.status(409).json({ error: 'لا يمكن الإلغاء بعد التقديم' });
    }
    await db.query(`UPDATE stocktakes SET workflow_status = 'cancelled' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/export', async (req, res) => {
  try {
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
