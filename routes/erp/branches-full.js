// ═══════════════════════════════════════════════════════════════════
// /api/erp/branches-full — Branch CRUD with brand / warehouse /
// cost-center joins
//
// GET returns each branch with its brand_name, warehouse_name and
// cost_center_name pre-joined plus geo fields.
// POST validates the geo coordinates, the supply mode, and the
// optional brand/warehouse/cost-center FKs before write, and uses
// COALESCE on the `type` column so an UPDATE without a type
// selector doesn't accidentally downgrade an existing branch.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

router.get('/branches-full', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, w.name AS warehouse_name, cc.name AS cost_center_name, br.name AS brand_name
       FROM branches b
       LEFT JOIN warehouses w   ON b.warehouse_id  = w.id
       LEFT JOIN cost_centers cc ON b.cost_center_id = cc.id
       LEFT JOIN brands br      ON b.brand_id      = br.id
       ORDER BY b.name`);
    res.json(rows.map(b => ({
      id: b.id, code: b.code || '', name: b.name || '', location: b.location || '',
      type: b.type || 'main',
      isActive: b.is_active !== 0 && b.is_active !== false,
      brandId: b.brand_id || '', brandName: b.brand_name || '',
      warehouseId: b.warehouse_id || '', warehouseName: b.warehouse_name || '',
      costCenterId: b.cost_center_id || '', costCenterName: b.cost_center_name || '',
      manager: b.manager || '',
      supplyMode: b.supply_mode || 'parent_company',
      companyName: b.company_name || '',
      geoLat: b.geo_lat != null ? Number(b.geo_lat) : null,
      geoLng: b.geo_lng != null ? Number(b.geo_lng) : null,
      geoRadius: b.geo_radius != null ? Number(b.geo_radius) : 100
    })));
  } catch(e) { res.json([]); }
});

router.post('/branches-full', async (req, res) => {
  try {
    const body = req.body || {};
    const id        = body.id;
    const name      = String(body.name || '').trim();
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (name.length > 200) return res.json({ success: false, error: 'الاسم طويل جداً (200 حرف كحد أقصى)' });

    const code        = String(body.code || '').trim().slice(0, 20);
    const companyName = body.companyName ? String(body.companyName).trim().slice(0, 200) : null;
    const location    = String(body.location || '').trim().slice(0, 500);
    const manager     = String(body.manager || '').trim().slice(0, 100);
    const brandId     = body.brandId      ? String(body.brandId).trim()      : null;
    const warehouseId = body.warehouseId  ? String(body.warehouseId).trim()  : null;
    const costCenter  = body.costCenterId ? String(body.costCenterId).trim() : null;

    const allowedSupply = ['parent_company','warehouse','auto'];
    const supplyMode = allowedSupply.includes(body.supplyMode) ? body.supplyMode : 'parent_company';
    const allowedTypes = ['main','branch'];
    const type = allowedTypes.includes(body.type) ? body.type : null; // null → preserve on UPDATE

    // Geo: parse-or-null. Reject obviously bad values rather than persisting NaN.
    const parseGeo = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const geoLat = parseGeo(body.geoLat);
    const geoLng = parseGeo(body.geoLng);
    if (geoLat !== null && (geoLat < -90 || geoLat > 90))   return res.json({ success: false, error: 'خط العرض خارج النطاق المسموح' });
    if (geoLng !== null && (geoLng < -180 || geoLng > 180)) return res.json({ success: false, error: 'خط الطول خارج النطاق المسموح' });
    let geoRadius = parseGeo(body.geoRadius);
    if (geoRadius === null || geoRadius < 10) geoRadius = 100;
    if (geoRadius > 10000) geoRadius = 10000;

    // Optional FK validation: keep dropdowns honest so a stale UI can't silently
    // attach a deleted brand/warehouse/cost-center to a branch.
    const checkExists = async (table, val) => {
      if (!val) return true;
      const [r] = await db.query('SELECT 1 FROM ' + table + ' WHERE id=? LIMIT 1', [val]);
      return r.length > 0;
    };
    if (!(await checkExists('brands',       brandId)))     return res.json({ success: false, error: 'البراند المحدد غير موجود' });
    if (!(await checkExists('warehouses',   warehouseId))) return res.json({ success: false, error: 'المستودع المحدد غير موجود' });
    if (!(await checkExists('cost_centers', costCenter)))  return res.json({ success: false, error: 'مركز التكلفة المحدد غير موجود' });

    if (id) {
      // Use COALESCE for `type` so we don't downgrade an existing branch type
      // when the form doesn't expose a type selector.
      await db.query(
        `UPDATE branches SET brand_id=?, code=?, name=?, company_name=?, location=?,
                             type = COALESCE(?, type),
                             warehouse_id=?, cost_center_id=?, manager=?, supply_mode=?,
                             geo_lat=?, geo_lng=?, geo_radius=?
         WHERE id=?`,
        [brandId, code, name, companyName, location,
         type,
         warehouseId, costCenter, manager, supplyMode,
         geoLat, geoLng, geoRadius, id]);
      return res.json({ success: true, id });
    }

    const newId = 'BR-' + Date.now();
    await db.query(
      `INSERT INTO branches (id, brand_id, code, name, company_name, location, type,
                             warehouse_id, cost_center_id, manager, supply_mode,
                             geo_lat, geo_lng, geo_radius)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, brandId, code, name, companyName, location, type || 'main',
       warehouseId, costCenter, manager, supplyMode,
       geoLat, geoLng, geoRadius]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
