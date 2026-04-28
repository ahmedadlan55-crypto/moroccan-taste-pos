/**
 * Work Orders + Maintenance Requests + Assets — V5
 *   GET    /api/work-orders/dashboard
 *   GET    /api/work-orders/assets         — list assets
 *   POST   /api/work-orders/assets         — create asset
 *   GET    /api/work-orders                — list (filter: status, priority, assignee, asset)
 *   GET    /api/work-orders/:id            — single + lines
 *   POST   /api/work-orders                — create
 *   PUT    /api/work-orders/:id            — update
 *   POST   /api/work-orders/:id/assign     — set assignee
 *   POST   /api/work-orders/:id/start      — mark in_progress
 *   POST   /api/work-orders/:id/complete   — set completed + roll-up costs
 *   POST   /api/work-orders/:id/close      — close (after approval)
 *   POST   /api/work-orders/:id/lines      — add line (labor/part/external)
 *   DELETE /api/work-orders/lines/:lid     — delete a line
 */
const router = require('express').Router();
const db = require('../db/connection');

function _id(p){ return p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }
function _user(req,b){ return (b&&b.user)||req.headers['x-user']||'system'; }

// ─── DASHBOARD ───────────────────────────────────────────────────────
router.get('/dashboard', async (req,res)=>{
  try {
    const { brandId } = req.query;
    const w = brandId ? 'WHERE brand_id = ?' : '';
    const p = brandId ? [brandId] : [];
    const [counts] = await db.query(`
      SELECT
        SUM(status='open') AS open_count,
        SUM(status='in_progress') AS in_progress,
        SUM(status='completed') AS completed,
        SUM(status='closed') AS closed,
        SUM(priority='critical' AND status NOT IN ('closed','cancelled','completed')) AS critical_open,
        SUM(due_date<CURDATE() AND status NOT IN ('closed','cancelled','completed')) AS overdue,
        SUM(actual_hours) AS total_hours,
        SUM(total_cost) AS total_cost
      FROM work_orders ${w}`, p);
    const [byType] = await db.query(`
      SELECT type, COUNT(*) AS c FROM work_orders ${w} GROUP BY type`, p);
    res.json({ ...counts[0], byType });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ─── ASSETS ──────────────────────────────────────────────────────────
router.get('/assets', async (req,res)=>{
  try {
    const { brandId, branchId, status, q } = req.query;
    const conds = []; const params = [];
    if (brandId) { conds.push('a.brand_id=?'); params.push(brandId); }
    if (branchId){ conds.push('a.branch_id=?'); params.push(branchId); }
    if (status)  { conds.push('a.status=?'); params.push(status); }
    if (q)       { conds.push('(a.name LIKE ? OR a.code LIKE ? OR a.serial_number LIKE ?)');
                   params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    const where = conds.length?'WHERE '+conds.join(' AND '):'';
    const [rows] = await db.query(
      `SELECT a.*, b.name AS brand_name FROM assets a
       LEFT JOIN brands b ON b.id=a.brand_id ${where}
       ORDER BY a.created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/assets', async (req,res)=>{
  try {
    const b = req.body||{};
    if (!b.name) return res.status(400).json({error:'name required'});
    const id = b.id||_id('AST');
    await db.query(
      `INSERT INTO assets
       (id,code,name,category,brand_id,branch_id,property_id,cost_center_id,
        serial_number,manufacturer,model,purchase_date,purchase_cost,
        depreciation_method,useful_life_years,salvage_value,current_value,
        warranty_expiry,assigned_to,status,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.code||id, b.name, b.category||'equipment',
       b.brand_id||null, b.branch_id||null, b.property_id||null, b.cost_center_id||null,
       b.serial_number||null, b.manufacturer||null, b.model||null,
       b.purchase_date||null, b.purchase_cost||null,
       b.depreciation_method||'straight_line', b.useful_life_years||5,
       b.salvage_value||0, b.current_value||b.purchase_cost||0,
       b.warranty_expiry||null, b.assigned_to||null,
       b.status||'active', b.notes||null]);
    res.json({ success:true, id });
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/assets/:id', async (req,res)=>{
  try {
    const fields = ['code','name','category','brand_id','branch_id','property_id','cost_center_id',
                    'serial_number','manufacturer','model','purchase_date','purchase_cost',
                    'depreciation_method','useful_life_years','salvage_value','current_value',
                    'warranty_expiry','last_maintenance_date','next_maintenance_date',
                    'assigned_to','status','notes'];
    const set=[]; const params=[];
    for (const f of fields) if (f in req.body){ set.push(`${f}=?`); params.push(req.body[f]); }
    if (!set.length) return res.json({success:true,noop:true});
    params.push(req.params.id);
    await db.query(`UPDATE assets SET ${set.join(',')} WHERE id=?`, params);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ─── WORK ORDERS ─────────────────────────────────────────────────────
router.get('/', async (req,res)=>{
  try {
    const { brandId, branchId, status, priority, assignedTo, assetId, q } = req.query;
    const conds = []; const params = [];
    if (brandId) { conds.push('w.brand_id=?'); params.push(brandId); }
    if (branchId){ conds.push('w.branch_id=?'); params.push(branchId); }
    if (status)  { conds.push('w.status=?'); params.push(status); }
    if (priority){ conds.push('w.priority=?'); params.push(priority); }
    if (assignedTo){ conds.push('w.assigned_to=?'); params.push(assignedTo); }
    if (assetId) { conds.push('w.asset_id=?'); params.push(assetId); }
    if (q)       { conds.push('(w.title LIKE ? OR w.code LIKE ? OR w.description LIKE ?)');
                   params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    const where = conds.length?'WHERE '+conds.join(' AND '):'';
    const [rows] = await db.query(
      `SELECT w.*, a.name AS asset_name, p.name AS property_name, b.name AS brand_name
       FROM work_orders w
       LEFT JOIN assets a ON a.id=w.asset_id
       LEFT JOIN properties p ON p.id=w.property_id
       LEFT JOIN brands b ON b.id=w.brand_id
       ${where}
       ORDER BY
         CASE w.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         w.requested_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/:id', async (req,res)=>{
  try {
    const [rows] = await db.query(
      `SELECT w.*, a.name AS asset_name, a.serial_number,
              p.name AS property_name, b.name AS brand_name
       FROM work_orders w
       LEFT JOIN assets a ON a.id=w.asset_id
       LEFT JOIN properties p ON p.id=w.property_id
       LEFT JOIN brands b ON b.id=w.brand_id
       WHERE w.id=?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({error:'Not found'});
    const [lines] = await db.query(
      `SELECT * FROM work_order_lines WHERE work_order_id=? ORDER BY id`, [req.params.id]);
    res.json({ ...rows[0], lines });
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/', async (req,res)=>{
  try {
    const b = req.body||{};
    if (!b.title) return res.status(400).json({error:'title required'});
    const id = b.id||_id('WO');
    const code = b.code || ('WO-'+new Date().getFullYear()+'-'+String(Date.now()).slice(-5));
    await db.query(
      `INSERT INTO work_orders
       (id,code,type,priority,title,description,asset_id,property_id,property_unit_id,
        branch_id,brand_id,cost_center_id,requested_by,due_date,status,
        estimated_hours,attachments)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, code, b.type||'maintenance', b.priority||'normal', b.title,
       b.description||null, b.asset_id||null, b.property_id||null, b.property_unit_id||null,
       b.branch_id||null, b.brand_id||null, b.cost_center_id||null,
       _user(req,b), b.due_date||null, b.status||'open',
       b.estimated_hours||0,
       b.attachments?JSON.stringify(b.attachments):null]);
    res.json({ success:true, id, code });
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/:id', async (req,res)=>{
  try {
    const fields = ['code','type','priority','title','description','asset_id',
                    'property_id','property_unit_id','branch_id','brand_id','cost_center_id',
                    'assigned_to','due_date','status','estimated_hours','actual_hours',
                    'completion_notes'];
    const set=[]; const params=[];
    for (const f of fields) if (f in req.body){ set.push(`${f}=?`); params.push(req.body[f]); }
    if (!set.length) return res.json({success:true,noop:true});
    params.push(req.params.id);
    await db.query(`UPDATE work_orders SET ${set.join(',')} WHERE id=?`, params);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/assign', async (req,res)=>{
  try {
    const { assigned_to } = req.body||{};
    if (!assigned_to) return res.status(400).json({error:'assigned_to required'});
    await db.query(
      `UPDATE work_orders SET assigned_to=?, assigned_at=NOW(), status='assigned' WHERE id=?`,
      [assigned_to, req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/start', async (req,res)=>{
  try {
    await db.query(
      `UPDATE work_orders SET started_at=NOW(), status='in_progress' WHERE id=?`,
      [req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/complete', async (req,res)=>{
  try {
    const b = req.body||{};
    // roll-up costs from lines
    const [agg] = await db.query(
      `SELECT
         SUM(CASE WHEN line_type='labor' THEN total_cost ELSE 0 END) AS labor,
         SUM(CASE WHEN line_type='part'  THEN total_cost ELSE 0 END) AS parts,
         SUM(CASE WHEN line_type IN ('service','external') THEN total_cost ELSE 0 END) AS external,
         SUM(total_cost) AS total,
         SUM(CASE WHEN line_type='labor' THEN hours ELSE 0 END) AS hours
       FROM work_order_lines WHERE work_order_id=?`, [req.params.id]);
    const a = agg[0]||{};
    await db.query(
      `UPDATE work_orders
       SET completed_at=NOW(), status='completed',
           labor_cost=?, parts_cost=?, external_cost=?, total_cost=?,
           actual_hours=?, completion_notes=?
       WHERE id=?`,
      [a.labor||0, a.parts||0, a.external||0, a.total||0, a.hours||0,
       b.completion_notes||null, req.params.id]);
    // Update asset's last_maintenance_date if maintenance type
    const [w] = await db.query('SELECT type, asset_id FROM work_orders WHERE id=?',[req.params.id]);
    if (w.length && w[0].asset_id && w[0].type==='maintenance'){
      await db.query('UPDATE assets SET last_maintenance_date=CURDATE() WHERE id=?',[w[0].asset_id]);
    }
    res.json({success:true, totals:a});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/close', async (req,res)=>{
  try {
    await db.query(
      `UPDATE work_orders SET closed_at=NOW(), status='closed' WHERE id=?`,
      [req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/lines', async (req,res)=>{
  try {
    const b = req.body||{};
    const id = _id('WOL');
    const total = b.line_type==='labor'
      ? (parseFloat(b.hours||0) * parseFloat(b.hourly_rate||0))
      : (parseFloat(b.quantity||0) * parseFloat(b.unit_cost||0));
    await db.query(
      `INSERT INTO work_order_lines
       (id,work_order_id,line_type,item_id,description,quantity,uom,unit_cost,total_cost,
        employee_id,hours,hourly_rate,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.params.id, b.line_type||'part', b.item_id||null, b.description||null,
       b.quantity||1, b.uom||null, b.unit_cost||0, total,
       b.employee_id||null, b.hours||null, b.hourly_rate||null, b.notes||null]);
    res.json({success:true, id, total});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.delete('/lines/:lid', async (req,res)=>{
  try {
    await db.query('DELETE FROM work_order_lines WHERE id=?', [req.params.lid]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
