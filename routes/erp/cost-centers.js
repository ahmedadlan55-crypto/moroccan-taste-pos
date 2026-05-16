// ═══════════════════════════════════════════════════════════════════
// /api/erp/cost-centers — Cost-center CRUD
//
// Part of the v5.17.1 routes/erp/ split.
//
// Two definitions used to live in routes/erp.js (the older one at
// line ~4882 was dead code — Express used the first match at line
// ~3236). The active (richer) version is preserved here:
//   • per-branch + hierarchy via parent_id
//   • Arabic + English names, code uniqueness check
//   • soft-delete when the cost center is in use by gl_entries or budgets
//   • hard-delete only when nothing references it
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

router.get('/cost-centers', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.branchId)  { where.push('cc.branch_id = ?'); params.push(req.query.branchId); }
    if (req.query.activeOnly === '1') where.push('cc.is_active = 1');
    if (req.query.q) {
      where.push('(cc.name_ar LIKE ? OR cc.name_en LIKE ? OR cc.code LIKE ?)');
      params.push('%'+req.query.q+'%', '%'+req.query.q+'%', '%'+req.query.q+'%');
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(
      `SELECT cc.*, b.name AS branch_name, p.name_ar AS parent_name
         FROM cost_centers cc
         LEFT JOIN branches b ON b.id = cc.branch_id
         LEFT JOIN cost_centers p ON p.id = cc.parent_id
        ${whereSql}
        ORDER BY cc.code`, params);
    res.json(rows.map(r => ({
      id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en,
      branchId: r.branch_id || '', branchName: r.branch_name || '',
      parentId: r.parent_id || '', parentName: r.parent_name || '',
      isActive: !!r.is_active, notes: r.notes || '',
      createdAt: r.created_at, createdBy: r.created_by || ''
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/cost-centers', async (req, res) => {
  try {
    const b = req.body || {};
    const nameAr = (b.nameAr || '').trim();
    if (!nameAr) return res.status(400).json({ success:false, error:'name-required' });
    const code = (b.code || '').trim() || null;
    if (code) {
      const [dup] = await db.query(
        'SELECT id FROM cost_centers WHERE code = ?' + (b.id ? ' AND id <> ?' : ''),
        b.id ? [code, b.id] : [code]);
      if (dup.length) return res.status(409).json({ success:false, error:'duplicate-code', conflictId: dup[0].id });
    }
    if (b.id) {
      const [exists] = await db.query('SELECT id FROM cost_centers WHERE id = ?', [b.id]);
      if (!exists.length) return res.status(404).json({ success:false, error:'not-found' });
      await db.query(
        `UPDATE cost_centers SET code=?, name_ar=?, name_en=?, branch_id=?, parent_id=?, is_active=?, notes=? WHERE id=?`,
        [code, nameAr, b.nameEn || null, b.branchId || null, b.parentId || null,
         b.isActive !== false, b.notes || null, b.id]);
      return res.json({ success: true, id: b.id });
    }
    const id = b.id || ('CC-' + Date.now() + '-' + Math.random().toString(36).slice(2,5));
    await db.query(
      `INSERT INTO cost_centers (id, code, name_ar, name_en, branch_id, parent_id, is_active, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, code, nameAr, b.nameEn || null, b.branchId || null, b.parentId || null,
       b.isActive !== false, b.notes || null,
       (req.user && req.user.username) || b.username || 'system']);
    res.status(201).json({ success: true, id });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

router.delete('/cost-centers/:id', async (req, res) => {
  try {
    // Check for children first — refuse to delete a parent
    const [kids] = await db.query('SELECT COUNT(*) AS n FROM cost_centers WHERE parent_id = ?', [req.params.id]);
    if (Number(kids[0].n) > 0) {
      return res.status(409).json({ success:false, error:'has-children', childCount: Number(kids[0].n) });
    }
    // Check for usage in gl_entries / budgets / ap_invoice_lines (best-effort)
    let usage = 0;
    try { const [r] = await db.query('SELECT COUNT(*) AS n FROM gl_entries WHERE cost_center_id = ?', [req.params.id]); usage += Number(r[0].n) || 0; } catch(_){}
    try { const [r] = await db.query('SELECT COUNT(*) AS n FROM budgets WHERE cost_center_id = ?', [req.params.id]); usage += Number(r[0].n) || 0; } catch(_){}
    if (usage > 0) {
      // Soft delete: mark inactive
      await db.query('UPDATE cost_centers SET is_active = 0 WHERE id = ?', [req.params.id]);
      return res.json({ success: true, softDeleted: true, usage });
    }
    await db.query('DELETE FROM cost_centers WHERE id = ?', [req.params.id]);
    res.json({ success: true, hardDeleted: true });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

module.exports = router;
