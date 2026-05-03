/**
 * Warehouse Operations — Phase 1/2/3
 * Stock Issues (main → branch), Production Orders, FIFO/WAC costing, Batch/Expiry.
 *
 * All mutations post to GL automatically with period-lock checks.
 */
const router = require('express').Router();
const db = require('../db/connection');
const gl = require('../lib/glPosting');

// ─── Helpers ──────────────────────────────────────────────────────────

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
async function _recordCostHistory(itemId, warehouseId, oldCost, newCost, oldQty, newQty, triggerType, refId, changedBy) {
  try {
    await db.query(
      `INSERT INTO item_cost_history
       (id, item_id, warehouse_id, method, old_cost, new_cost, old_qty, new_qty, trigger_type, reference_id, changed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['CH-' + Date.now() + '-' + Math.random().toString(36).slice(2,7),
       itemId, warehouseId || null, 'WAC', oldCost || 0, newCost || 0,
       oldQty || 0, newQty || 0, triggerType, refId || null, changedBy || '']);
  } catch(e) { /* best effort */ }
}

// Update warehouse_stock with new qty + recompute WAC if adding stock
async function _applyStockMovement(warehouseId, itemId, qtyDelta, unitCost, triggerType, refId, changedBy) {
  const [rows] = await db.query(
    'SELECT qty, avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=? LIMIT 1',
    [warehouseId, itemId]);
  const oldQty = rows.length ? Number(rows[0].qty) : 0;
  const oldCost = rows.length ? Number(rows[0].avg_cost) : 0;
  const newQty = oldQty + Number(qtyDelta);
  let newCost = oldCost;
  // WAC only recomputed when adding inventory (positive qtyDelta)
  if (Number(qtyDelta) > 0 && Number(unitCost) > 0) {
    newCost = _newWAC(oldQty, oldCost || unitCost, qtyDelta, unitCost);
  }
  if (rows.length) {
    await db.query(
      `UPDATE warehouse_stock
       SET qty=?, avg_cost=?, last_cost=?, last_updated=NOW()
       WHERE warehouse_id=? AND item_id=?`,
      [newQty, newCost, unitCost || oldCost, warehouseId, itemId]);
  } else {
    await db.query(
      `INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost, last_updated)
       VALUES (?,?,?,?,?,?,NOW())`,
      ['WS-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
       warehouseId, itemId, newQty, newCost, unitCost || 0]);
  }
  await _recordCostHistory(itemId, warehouseId, oldCost, newCost, oldQty, newQty, triggerType, refId, changedBy);
  return { oldQty, oldCost, newQty, newCost };
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1 — WAREHOUSES HIERARCHY
// ═══════════════════════════════════════════════════════════════════════

// List warehouses with hierarchy info
router.get('/warehouses/hierarchy', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT w.*,
             p.name AS parent_name, p.code AS parent_code,
             (SELECT COUNT(*) FROM warehouses WHERE parent_warehouse_id = w.id) AS child_count
      FROM warehouses w
      LEFT JOIN warehouses p ON p.id = w.parent_warehouse_id
      WHERE w.is_active = 1
      ORDER BY COALESCE(w.parent_warehouse_id, w.id), w.is_main DESC, w.name
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set a warehouse as "main" for a brand
router.post('/warehouses/:id/set-main', async (req, res) => {
  try {
    const id = req.params.id;
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
    const { parentId } = req.body || {};
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
    const { parentId } = req.body;
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
             (SELECT COUNT(*) FROM stock_issue_items WHERE issue_id=si.id) AS line_count
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
  try {
    const { fromWarehouseId, toWarehouseId, brandId, branchId, issueDate, notes, items, createdBy } = req.body;
    if (!fromWarehouseId || !toWarehouseId) return res.status(400).json({ error: 'from/to warehouse required' });
    if (fromWarehouseId === toWarehouseId) return res.status(400).json({ error: 'from and to must differ' });
    if (!items || !items.length) return res.status(400).json({ error: 'items required' });

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

    res.json({ success: true, id, issueNumber, totalCost: total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Approve stock issue
router.post('/stock-issues/:id/approve', async (req, res) => {
  try {
    const id = req.params.id;
    const { approvedBy } = req.body;
    const [rows] = await db.query('SELECT status FROM stock_issues WHERE id=?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].status !== 'draft') return res.status(400).json({ error: 'only draft can be approved' });
    await db.query(
      `UPDATE stock_issues SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?`,
      [approvedBy || '', id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Issue (decrement source warehouse + post GL)
router.post('/stock-issues/:id/issue', async (req, res) => {
  try {
    const id = req.params.id;
    const { issuedBy } = req.body;
    const [hdrRows] = await db.query('SELECT * FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    const hdr = hdrRows[0];
    if (!['draft','approved'].includes(hdr.status)) return res.status(400).json({ error: 'invalid status' });

    const [items] = await db.query('SELECT * FROM stock_issue_items WHERE issue_id=?', [id]);
    if (!items.length) return res.status(400).json({ error: 'no items' });

    // Verify sufficient stock at source
    for (const it of items) {
      const [stk] = await db.query(
        'SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?',
        [hdr.from_warehouse_id, it.item_id]);
      const available = stk.length ? Number(stk[0].qty) : 0;
      if (available < Number(it.qty_requested)) {
        return res.status(400).json({ error: `insufficient stock for item ${it.item_id}: available ${available}, required ${it.qty_requested}` });
      }
    }

    // Decrement source warehouse stock, set qty_issued
    let totalCost = 0;
    for (const it of items) {
      const qty = Number(it.qty_requested);
      await _applyStockMovement(hdr.from_warehouse_id, it.item_id, -qty, Number(it.unit_cost),
                                'stock_issue_out', id, issuedBy || '');
      const lineTotal = qty * Number(it.unit_cost);
      totalCost += lineTotal;
      await db.query(
        `UPDATE stock_issue_items SET qty_issued=?, line_total=? WHERE id=?`,
        [qty, lineTotal, it.id]);
    }

    // Post GL: Dr Branch Inventory / Cr Main Inventory (at total cost)
    let glId = null;
    try {
      const result = await gl.postJournal(db, {
        referenceType: 'stock_issue',
        referenceId: id,
        description: `إذن صرف ${hdr.issue_number}: من ${hdr.from_warehouse_id} إلى ${hdr.to_warehouse_id}`,
        postedBy: issuedBy || '',
        entries: [
          {
            accountCode: gl.CORE_ACCOUNTS.BRANCH_INVENTORY.code,
            debit: totalCost, credit: 0,
            brandId: hdr.brand_id, branchId: hdr.branch_id,
            warehouseId: hdr.to_warehouse_id
          },
          {
            accountCode: gl.CORE_ACCOUNTS.INVENTORY.code,
            debit: 0, credit: totalCost,
            brandId: hdr.brand_id,
            warehouseId: hdr.from_warehouse_id
          }
        ]
      });
      glId = result && result.journalId;
    } catch(glErr) {
      console.warn('[stock-issue] GL posting failed:', glErr.message);
    }

    await db.query(
      `UPDATE stock_issues
       SET status='issued', issued_by=?, issued_at=NOW(), total_cost=?, gl_journal_id=?
       WHERE id=?`,
      [issuedBy || '', totalCost, glId, id]);

    res.json({ success: true, totalCost, glJournalId: glId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Receive (increment destination warehouse)
router.post('/stock-issues/:id/receive', async (req, res) => {
  try {
    const id = req.params.id;
    const { receivedBy, items } = req.body;  // items optional — partial receive
    const [hdrRows] = await db.query('SELECT * FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    const hdr = hdrRows[0];
    if (hdr.status !== 'issued') return res.status(400).json({ error: 'only issued can be received' });

    const [dbItems] = await db.query('SELECT * FROM stock_issue_items WHERE issue_id=?', [id]);
    const qtyMap = {};
    if (Array.isArray(items)) items.forEach(it => { qtyMap[it.id] = Number(it.qtyReceived); });

    for (const it of dbItems) {
      const qtyReceived = qtyMap.hasOwnProperty(it.id) ? qtyMap[it.id] : Number(it.qty_issued);
      if (qtyReceived <= 0) continue;
      await _applyStockMovement(hdr.to_warehouse_id, it.item_id, qtyReceived, Number(it.unit_cost),
                                'stock_issue_in', id, receivedBy || '');
      await db.query('UPDATE stock_issue_items SET qty_received=? WHERE id=?', [qtyReceived, it.id]);
    }

    await db.query(
      `UPDATE stock_issues SET status='received', received_by=?, received_at=NOW() WHERE id=?`,
      [receivedBy || '', id]);

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cancel stock issue
router.post('/stock-issues/:id/cancel', async (req, res) => {
  try {
    const id = req.params.id;
    const [hdrRows] = await db.query('SELECT status FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    if (['issued','received'].includes(hdrRows[0].status))
      return res.status(400).json({ error: 'cannot cancel after issue — use reverse instead' });
    await db.query(`UPDATE stock_issues SET status='cancelled' WHERE id=?`, [id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// V5.9.7 — Reverse an already-issued/received stock issue. This is the
// "إرجاع إذن الصرف" the user asked for: it puts the qty back into the source
// warehouse, takes it out of the destination warehouse (if it was received),
// and posts a reversing GL journal mirroring the original posting. The
// underlying stock_issue row keeps its line totals (audit trail) but moves
// to status='reversed' with reversed_by / reversed_at / reverse_reason set.
router.post('/stock-issues/:id/reverse', async (req, res) => {
  try {
    const id = req.params.id;
    const { reversedBy, reason } = req.body || {};
    const [hdrRows] = await db.query('SELECT * FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    const hdr = hdrRows[0];
    if (!['issued','received'].includes(hdr.status))
      return res.status(400).json({ error: 'يمكن إرجاع الإذن فقط بعد الصرف أو الاستلام' });

    const [items] = await db.query('SELECT * FROM stock_issue_items WHERE issue_id=?', [id]);
    if (!items.length) return res.status(400).json({ error: 'no items' });

    // Reverse the stock movements:
    //   1. PUT BACK what we took from the source (positive delta on the from-warehouse).
    //   2. TAKE BACK what was received at the destination (only if status='received').
    //
    // We use the original unit_cost stored on each line so the reversal lands
    // at the same valuation the issue posted at — keeps weighted-average sane.
    let totalCost = 0;
    for (const it of items) {
      const qtyIssued   = Number(it.qty_issued)   || 0;
      const qtyReceived = Number(it.qty_received) || 0;
      const unitCost    = Number(it.unit_cost)    || 0;
      if (qtyIssued > 0) {
        await _applyStockMovement(hdr.from_warehouse_id, it.item_id, qtyIssued, unitCost,
                                  'stock_issue_reverse', id, reversedBy || '');
        totalCost += qtyIssued * unitCost;
      }
      if (qtyReceived > 0 && hdr.status === 'received') {
        await _applyStockMovement(hdr.to_warehouse_id, it.item_id, -qtyReceived, unitCost,
                                  'stock_issue_reverse', id, reversedBy || '');
      }
    }

    // Post a reversing GL journal — debit Main Inventory, credit Branch
    // Inventory (mirror of the original /issue endpoint above).
    let reverseGlId = null;
    try {
      const result = await gl.postJournal(db, {
        referenceType: 'stock_issue_reverse',
        referenceId: id,
        description: `إرجاع إذن صرف ${hdr.issue_number}: ` + (reason || 'بدون سبب محدد'),
        postedBy: reversedBy || '',
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
      reverseGlId = result && result.journalId;
    } catch(glErr) {
      console.warn('[stock-issue reverse] GL posting failed:', glErr.message);
    }

    await db.query(
      `UPDATE stock_issues
       SET status='reversed', reversed_by=?, reversed_at=NOW(),
           reverse_reason=?, reverse_gl_journal_id=?
       WHERE id=?`,
      [reversedBy || '', (reason || '').slice(0, 500), reverseGlId, id]);

    res.json({ success: true, reverseGlJournalId: reverseGlId, totalCost });
  } catch(e) {
    console.error('[stock-issue reverse] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// V5.9.9 — Hard-delete a stock issue. Only allowed on drafts so the audit
// trail of any approved/issued/received/cancelled/reversed row stays intact.
// Cascade-delete the line items first (no FK CASCADE configured).
router.delete('/stock-issues/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [hdrRows] = await db.query('SELECT status FROM stock_issues WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    if (hdrRows[0].status !== 'draft') {
      return res.status(400).json({ error: 'يمكن حذف الإذن فقط عندما يكون مسودة — استخدم الإلغاء أو الإرجاع' });
    }
    await db.query('DELETE FROM stock_issue_items WHERE issue_id=?', [id]);
    await db.query('DELETE FROM stock_issues WHERE id=?', [id]);
    res.json({ success: true });
  } catch(e) {
    console.error('[stock-issue delete] error:', e);
    res.status(500).json({ error: e.message });
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
      WHERE si.status IN ('issued','received')`;
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
    // Hide `received` rows older than 7 days so the inbox doesn't grow forever.
    sql += " AND (si.status = 'issued' OR si.received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))";
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

// Create production order from BOM
router.post('/production-orders', async (req, res) => {
  try {
    const { bomId, warehouseId, outputWarehouseId, qtyPlanned, plannedDate, brandId, branchId, notes, createdBy } = req.body;
    if (!bomId) return res.status(400).json({ error: 'bomId required' });
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId (raw materials source) required' });
    if (!qtyPlanned || Number(qtyPlanned) <= 0) return res.status(400).json({ error: 'qtyPlanned must be positive' });

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

    await db.query(
      `INSERT INTO production_orders
       (id, order_number, bom_id, product_id, warehouse_id, output_warehouse_id, brand_id, branch_id,
        qty_planned, status, notes, created_by, planned_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, orderNumber, bomId, bom.product_id, warehouseId, outputWarehouseId || warehouseId,
       brandId || null, branchId || null, qtyPlan, 'planned', notes || '', createdBy || '',
       plannedDate || new Date().toISOString().slice(0,10)]);

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
router.post('/production-orders/:id/release', async (req, res) => {
  try {
    const id = req.params.id;
    const { releasedBy, laborCost, overheadCost } = req.body;
    const [hdrRows] = await db.query('SELECT * FROM production_orders WHERE id=?', [id]);
    if (!hdrRows.length) return res.status(404).json({ error: 'not found' });
    const hdr = hdrRows[0];
    if (hdr.status !== 'planned') return res.status(400).json({ error: 'only planned can be released' });

    const [cons] = await db.query('SELECT * FROM production_consumption WHERE production_order_id=?', [id]);
    if (!cons.length) return res.status(400).json({ error: 'no consumption lines' });

    // Verify stock availability
    for (const c of cons) {
      const [stk] = await db.query(
        'SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?',
        [c.warehouse_id, c.item_id]);
      const avail = stk.length ? Number(stk[0].qty) : 0;
      if (avail < Number(c.qty_planned)) {
        return res.status(400).json({ error: `insufficient stock for ${c.item_id}: avail ${avail}, need ${c.qty_planned}` });
      }
    }

    // Consume raw materials
    let materialsCost = 0;
    const glLines = [];
    for (const c of cons) {
      const qty = Number(c.qty_planned);
      const unitCost = Number(c.unit_cost);
      const lineTotal = qty * unitCost;
      materialsCost += lineTotal;
      await _applyStockMovement(c.warehouse_id, c.item_id, -qty, unitCost,
                                'production_release', id, releasedBy || '');
      await db.query(
        `UPDATE production_consumption SET qty_actual=?, total_cost=?, consumed_at=NOW() WHERE id=?`,
        [qty, lineTotal, c.id]);
      glLines.push({
        accountCode: gl.CORE_ACCOUNTS.WIP.code,
        debit: lineTotal, credit: 0,
        brandId: hdr.brand_id, branchId: hdr.branch_id, warehouseId: c.warehouse_id
      });
      glLines.push({
        accountCode: gl.CORE_ACCOUNTS.INVENTORY.code,
        debit: 0, credit: lineTotal,
        brandId: hdr.brand_id, warehouseId: c.warehouse_id
      });
    }

    // Add labor + overhead to WIP
    const labor = Number(laborCost) || 0;
    const overhead = Number(overheadCost) || 0;
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

    let glId = null;
    try {
      const r = await gl.postJournal(db, {
        referenceType: 'production_release',
        referenceId: id,
        description: `إطلاق أمر إنتاج ${hdr.order_number}`,
        postedBy: releasedBy || '',
        entries: glLines
      });
      glId = r && r.journalId;
    } catch(glErr) {
      console.warn('[production-release] GL failed:', glErr.message);
    }

    const totalCost = materialsCost + labor + overhead;
    await db.query(
      `UPDATE production_orders
       SET status='released', released_by=?, released_at=NOW(),
           materials_cost=?, labor_cost=?, overhead_cost=?, total_cost=?, gl_release_id=?
       WHERE id=?`,
      [releasedBy || '', materialsCost, labor, overhead, totalCost, glId, id]);

    res.json({ success: true, materialsCost, laborCost: labor, overheadCost: overhead, totalCost, glJournalId: glId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Complete — transfer WIP to Finished Goods
router.post('/production-orders/:id/complete', async (req, res) => {
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

    const wipTotal = Number(hdr.total_cost);
    // Unit cost = total WIP / produced qty (scrap is absorbed — standard accounting)
    const unitCost = qtyOut > 0 ? (wipTotal / qtyOut) : 0;
    const outputWh = hdr.output_warehouse_id || hdr.warehouse_id;

    // Add finished goods to inventory (WAC updated automatically)
    await _applyStockMovement(outputWh, hdr.product_id, qtyOut, unitCost,
                              'production_complete', id, completedBy || '');

    // Record output row
    await db.query(
      `INSERT INTO production_output
       (id, production_order_id, item_id, warehouse_id, qty, unit_cost, total_cost,
        batch_number, expiry_date, produced_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
      ['POUT-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
       id, hdr.product_id, outputWh, qtyOut, unitCost, wipTotal,
       batchNumber || null, expiryDate || null]);

    // GL: Dr Finished Goods / Cr WIP
    let glId = null;
    try {
      const r = await gl.postJournal(db, {
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
      glId = r && r.journalId;
    } catch(glErr) {
      console.warn('[production-complete] GL failed:', glErr.message);
    }

    await db.query(
      `UPDATE production_orders
       SET status='completed', completed_by=?, completed_at=NOW(),
           qty_produced=?, qty_scrap=?, unit_cost=?, gl_complete_id=?
       WHERE id=?`,
      [completedBy || '', qtyOut, qtyScrapped, unitCost, glId, id]);

    res.json({ success: true, qtyProduced: qtyOut, unitCost, totalCost: wipTotal, glJournalId: glId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cancel
router.post('/production-orders/:id/cancel', async (req, res) => {
  try {
    const id = req.params.id;
    const [r] = await db.query('SELECT status FROM production_orders WHERE id=?', [id]);
    if (!r.length) return res.status(404).json({ error: 'not found' });
    if (r[0].status !== 'planned') return res.status(400).json({ error: 'only planned can be cancelled' });
    await db.query(`UPDATE production_orders SET status='cancelled' WHERE id=?`, [id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// Expiry alerts — items expiring in the next N days
router.get('/expiry-alerts', async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const [rows] = await db.query(`
      SELECT pl.*, i.name AS item_name, i.unit AS item_unit, w.name AS warehouse_name,
             DATEDIFF(pl.expiry_date, CURDATE()) AS days_remaining
      FROM purchase_lots pl
      LEFT JOIN inv_items i ON i.id = pl.item_id
      LEFT JOIN warehouses w ON w.id = pl.warehouse_id
      WHERE pl.expiry_date IS NOT NULL
        AND pl.qty_remaining > 0
        AND pl.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
      ORDER BY pl.expiry_date ASC
      LIMIT 500`, [days]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
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
