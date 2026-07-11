/**
 * Properties + Property Units (Real-Estate module — V5)
 * GET    /api/properties                — list (filter: brand, status, city)
 * GET    /api/properties/:id            — single + units
 * POST   /api/properties                — create
 * PUT    /api/properties/:id            — update
 * DELETE /api/properties/:id            — soft-deactivate
 * GET    /api/properties/:id/units      — list units of property
 * POST   /api/properties/:id/units      — add unit
 * PUT    /api/properties/units/:uid     — update unit
 * GET    /api/properties/dashboard      — stats: total, occupied, vacant, monthly_revenue
 */
const router = require('express').Router();
const db = require('../db/connection');

function _id(prefix){ return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,7); }

// ─── DASHBOARD STATS ─────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const { brandId } = req.query;
    const where = brandId ? 'WHERE p.brand_id = ?' : '';
    const params = brandId ? [brandId] : [];
    const [props] = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active
       FROM properties p ${where}`, params);
    const [units] = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN u.status='occupied' THEN 1 ELSE 0 END) AS occupied,
              SUM(CASE WHEN u.status='vacant' THEN 1 ELSE 0 END) AS vacant,
              SUM(CASE WHEN u.status='occupied' THEN COALESCE(u.monthly_rent,0) ELSE 0 END) AS monthly_revenue
       FROM property_units u
       LEFT JOIN properties p ON p.id = u.property_id
       ${where}`, params);
    const [contracts] = await db.query(
      `SELECT COUNT(*) AS active_count,
              SUM(COALESCE(payment_amount,0)) AS active_value
       FROM contracts WHERE status='active' ${brandId?'AND brand_id=?':''}`,
      brandId?[brandId]:[]);
    res.json({
      properties: props[0],
      units: units[0],
      contracts: contracts[0]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── LIST ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { brandId, status, city, q } = req.query;
    const conds = []; const params = [];
    if (brandId) { conds.push('p.brand_id = ?'); params.push(brandId); }
    if (status)  { conds.push('p.status = ?');   params.push(status); }
    if (city)    { conds.push('p.city = ?');     params.push(city); }
    if (q)       { conds.push('(p.name LIKE ? OR p.code LIKE ? OR p.address LIKE ?)');
                   params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const [rows] = await db.query(
      `SELECT p.*, b.name AS brand_name,
              (SELECT COUNT(*) FROM property_units WHERE property_id=p.id) AS units_total,
              (SELECT COUNT(*) FROM property_units WHERE property_id=p.id AND status='occupied') AS units_occupied,
              (SELECT COALESCE(SUM(monthly_rent),0) FROM property_units WHERE property_id=p.id AND status='occupied') AS monthly_revenue
       FROM properties p
       LEFT JOIN brands b ON b.id = p.brand_id
       ${where}
       ORDER BY p.created_at DESC`, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ONE ──────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*, b.name AS brand_name FROM properties p
       LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const [units] = await db.query(
      `SELECT u.*, c.code AS contract_code, c.party_name AS tenant_name, c.end_date AS lease_end
       FROM property_units u
       LEFT JOIN contracts c ON c.id = u.current_contract_id
       WHERE u.property_id = ? ORDER BY u.unit_number`, [req.params.id]);
    res.json({ ...rows[0], units });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CREATE ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const id = b.id || _id('PROP');
    await db.query(
      `INSERT INTO properties
       (id,code,name,type,city,district,address,total_area,area_unit,
        cost_center_id,brand_id,owner_party_id,status,acquired_at,acquisition_cost,notes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.code||id, b.name, b.type||'commercial', b.city||null, b.district||null,
       b.address||null, b.total_area||null, b.area_unit||'m2',
       b.cost_center_id||null, b.brand_id||null, b.owner_party_id||null,
       b.status||'active', b.acquired_at||null, b.acquisition_cost||0,
       b.notes||null, (req.user && req.user.username) || 'system']);
    res.json({ success:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── UPDATE ───────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const fields = ['code','name','type','city','district','address','total_area','area_unit',
                    'cost_center_id','brand_id','owner_party_id','status','acquired_at',
                    'acquisition_cost','notes'];
    const set = []; const params = [];
    for (const f of fields) if (f in req.body) { set.push(`${f}=?`); params.push(req.body[f]); }
    if (!set.length) return res.json({ success:true, noop:true });
    params.push(req.params.id);
    await db.query(`UPDATE properties SET ${set.join(',')} WHERE id = ?`, params);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE (soft) ────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await db.query(`UPDATE properties SET status='inactive' WHERE id = ?`, [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── UNITS ────────────────────────────────────────────────────────────
router.get('/:id/units', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.*, c.code AS contract_code, c.party_name AS tenant_name
       FROM property_units u
       LEFT JOIN contracts c ON c.id = u.current_contract_id
       WHERE u.property_id = ? ORDER BY u.unit_number`, [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/units', async (req, res) => {
  try {
    const b = req.body || {};
    const id = b.id || _id('UNIT');
    await db.query(
      `INSERT INTO property_units
       (id,property_id,code,unit_number,floor,type,area,bedrooms,bathrooms,
        monthly_rent,currency,status,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.params.id, b.code||id, b.unit_number||null, b.floor||null,
       b.type||'apartment', b.area||null, b.bedrooms||0, b.bathrooms||0,
       b.monthly_rent||null, b.currency||'SAR', b.status||'vacant', b.notes||null]);
    res.json({ success:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/units/:uid', async (req, res) => {
  try {
    const fields = ['code','unit_number','floor','type','area','bedrooms','bathrooms',
                    'monthly_rent','currency','status','notes','current_contract_id'];
    const set = []; const params = [];
    for (const f of fields) if (f in req.body) { set.push(`${f}=?`); params.push(req.body[f]); }
    if (!set.length) return res.json({ success:true, noop:true });
    params.push(req.params.uid);
    await db.query(`UPDATE property_units SET ${set.join(',')} WHERE id = ?`, params);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/units/:uid', async (req, res) => {
  try {
    await db.query(`DELETE FROM property_units WHERE id = ?`, [req.params.uid]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
