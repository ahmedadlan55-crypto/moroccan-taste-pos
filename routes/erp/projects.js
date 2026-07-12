// ═══════════════════════════════════════════════════════════════════
// /api/erp/projects — read-only projects directory
//
// Release Gate 2026-07. The `projects` table has existed since v5.10.39
// (created in server.js) and GL journals reference it (journals filter +
// create-form dimension pickers expect {id, nameAr} — public/js/erp.js
// _erpLoadJrnDims), but no route ever served it: the frontend fetch of
// /api/erp/projects 404'd forever and the project selectors stayed
// silently empty. Sibling of cost-centers.js / audit-logs.js in the
// v5.17.1 routes/erp split; mounted from routes/erp.js.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

router.get('/projects', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.activeOnly !== '0') where.push("(p.status IS NULL OR p.status = 'active')");
    if (req.query.q) {
      where.push('(p.name_ar LIKE ? OR p.name_en LIKE ? OR p.code LIKE ?)');
      params.push('%' + req.query.q + '%', '%' + req.query.q + '%', '%' + req.query.q + '%');
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(
      `SELECT p.id, p.code, p.name_ar, p.name_en, p.status, p.brand_id, p.branch_id
         FROM projects p
        ${whereSql}
        ORDER BY p.code, p.name_ar`, params);
    res.json(rows.map(r => ({
      id: r.id, code: r.code || '', nameAr: r.name_ar, nameEn: r.name_en || '',
      status: r.status || 'active', brandId: r.brand_id || '', branchId: r.branch_id || ''
    })));
  } catch (e) {
    console.error('[erp/projects] list failed:', e.message);
    res.status(500).json({ success: false, error: 'تعذر تحميل المشاريع' });
  }
});

module.exports = router;
