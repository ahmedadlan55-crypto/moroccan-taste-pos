// ═══════════════════════════════════════════════════════════════════
// /api/erp/brands — Brand CRUD
//
// Part of the v5.17.1 routes/erp/ split. Mounted at the same prefix
// as the original routes/erp.js so URLs are unchanged.
// Endpoints:
//   GET    /brands           (returns id, name, code, logo, isActive, linkedBranches)
//   POST   /brands           (insert or update)
//   DELETE /brands/:id       (blocked if the brand has linked branches)
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

router.get('/brands', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM brands ORDER BY name');
    res.json(rows.map(b => {
      let linkedBranches = [];
      try { if (b.linked_branches) linkedBranches = JSON.parse(b.linked_branches); } catch(e) {}
      return {
        id: b.id, name: b.name, code: b.code, logo: b.logo, isActive: !!b.is_active,
        linkedBranches: linkedBranches
      };
    }));
  } catch(e) { res.json([]); }
});

router.post('/brands', async (req, res) => {
  try {
    const { id, name, code, logo, isActive, linkedBranches } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    const linkedBranchesJson = Array.isArray(linkedBranches) ? JSON.stringify(linkedBranches) : null;
    if (id) {
      try {
        await db.query('UPDATE brands SET name=?, code=?, logo=?, is_active=?, linked_branches=? WHERE id=?',
          [name, code||'', logo||null, isActive!==false?1:0, linkedBranchesJson, id]);
      } catch(e) {
        // Fallback for older deploys without linked_branches column
        await db.query('UPDATE brands SET name=?, code=?, logo=?, is_active=? WHERE id=?',
          [name, code||'', logo||null, isActive!==false?1:0, id]);
      }
      return res.json({ success: true, id });
    }
    const newId = 'BR-' + Date.now();
    try {
      await db.query('INSERT INTO brands (id, name, code, logo, linked_branches) VALUES (?,?,?,?,?)',
        [newId, name, code||'', logo||null, linkedBranchesJson]);
    } catch(e) {
      await db.query('INSERT INTO brands (id, name, code, logo) VALUES (?,?,?,?)', [newId, name, code||'', logo||null]);
    }
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/brands/:id', async (req, res) => {
  try {
    // Check if brand has branches
    const [branches] = await db.query('SELECT COUNT(*) AS cnt FROM branches WHERE brand_id = ?', [req.params.id]);
    if (branches[0].cnt > 0) return res.json({ success: false, error: 'لا يمكن حذف براند لديه فروع مرتبطة' });
    await db.query('DELETE FROM brands WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
