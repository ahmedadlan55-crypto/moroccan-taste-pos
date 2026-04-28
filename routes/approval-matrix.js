/**
 * Approval Matrix — sophisticated policy engine
 *   GET    /api/approval-matrix              — list with filters
 *   GET    /api/approval-matrix/:id          — single
 *   POST   /api/approval-matrix              — create policy
 *   PUT    /api/approval-matrix/:id          — update
 *   DELETE /api/approval-matrix/:id          — delete (soft via is_active=0)
 *   POST   /api/approval-matrix/test         — given (type, amount, brand) → which policies fire
 *   GET    /api/approval-matrix/transaction-types — taxonomy for dropdowns
 */
const router = require('express').Router();
const db = require('../db/connection');

function _id(p){ return p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }

router.get('/', async (req,res)=>{
  try {
    const { typeCode, brandId, branchId, active } = req.query;
    const conds=[]; const params=[];
    if (typeCode) { conds.push('transaction_type_code=?'); params.push(typeCode); }
    if (brandId)  { conds.push('(brand_id=? OR brand_id IS NULL)'); params.push(brandId); }
    if (branchId) { conds.push('(branch_id=? OR branch_id IS NULL)'); params.push(branchId); }
    if (active!==undefined) { conds.push('is_active=?'); params.push(active==='true'?1:0); }
    const where = conds.length?'WHERE '+conds.join(' AND '):'';
    const [rows] = await db.query(
      `SELECT * FROM approval_policies ${where}
       ORDER BY transaction_type_code, step_order, amount_from`, params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/transaction-types', async (req,res)=>{
  try {
    const [rows] = await db.query(
      `SELECT code, name, category, requires_payment, icon, icon_color
       FROM transaction_types ORDER BY category, sort_order`);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/:id', async (req,res)=>{
  try {
    const [rows] = await db.query('SELECT * FROM approval_policies WHERE id=?',[req.params.id]);
    if (!rows.length) return res.status(404).json({error:'Not found'});
    res.json(rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/', async (req,res)=>{
  try {
    const b = req.body||{};
    if (!b.transaction_type_code || !b.step_order || !b.approver_value) {
      return res.status(400).json({error:'transaction_type_code + step_order + approver_value required'});
    }
    const id = b.id||_id('POL');
    await db.query(
      `INSERT INTO approval_policies
       (id,transaction_type_code,brand_id,branch_id,cost_center_id,
        amount_from,amount_to,currency,step_order,approver_type,approver_value,
        sla_hours,can_approve,can_reject,can_return,can_delegate,
        escalate_after_hours,escalate_to_role,is_active,notes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.transaction_type_code, b.brand_id||null, b.branch_id||null, b.cost_center_id||null,
       b.amount_from||0, b.amount_to||null, b.currency||'SAR',
       b.step_order, b.approver_type||'role', b.approver_value,
       b.sla_hours||24,
       b.can_approve!==false?1:0, b.can_reject!==false?1:0,
       b.can_return!==false?1:0, b.can_delegate!==false?1:0,
       b.escalate_after_hours||null, b.escalate_to_role||null,
       b.is_active!==false?1:0, b.notes||null,
       req.headers['x-user']||'system']);
    res.json({success:true, id});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/:id', async (req,res)=>{
  try {
    const fields=['transaction_type_code','brand_id','branch_id','cost_center_id',
                  'amount_from','amount_to','currency','step_order','approver_type',
                  'approver_value','sla_hours','can_approve','can_reject','can_return',
                  'can_delegate','escalate_after_hours','escalate_to_role','is_active','notes'];
    const set=[]; const params=[];
    for (const f of fields) if (f in req.body){ set.push(`${f}=?`); params.push(req.body[f]); }
    if (!set.length) return res.json({success:true,noop:true});
    params.push(req.params.id);
    await db.query(`UPDATE approval_policies SET ${set.join(',')} WHERE id=?`, params);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.delete('/:id', async (req,res)=>{
  try {
    await db.query('UPDATE approval_policies SET is_active=0 WHERE id=?',[req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// TEST: simulate which policies fire for a given context
router.post('/test', async (req,res)=>{
  try {
    const { typeCode, amount, brandId, branchId } = req.body||{};
    if (!typeCode) return res.status(400).json({error:'typeCode required'});
    const amt = parseFloat(amount||0);
    const conds = ['is_active=1','transaction_type_code=?'];
    const params = [typeCode];
    conds.push('(amount_from <= ? AND (amount_to IS NULL OR amount_to >= ?))');
    params.push(amt, amt);
    conds.push('(brand_id IS NULL OR brand_id=?)');
    params.push(brandId||null);
    conds.push('(branch_id IS NULL OR branch_id=?)');
    params.push(branchId||null);
    const [matched] = await db.query(
      `SELECT * FROM approval_policies WHERE ${conds.join(' AND ')}
       ORDER BY step_order, brand_id IS NULL, branch_id IS NULL`, params);
    res.json({
      typeCode, amount: amt, brandId, branchId,
      matched_count: matched.length,
      path: matched.map(m => ({
        step: m.step_order,
        approver_type: m.approver_type,
        approver: m.approver_value,
        sla_hours: m.sla_hours
      })),
      raw: matched
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
