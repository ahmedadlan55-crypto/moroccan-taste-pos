/**
 * Customer Invoices (AR) — V5
 * Symmetric to AP. Includes ZATCA placeholder + recurring spawning hook.
 */
const router = require('express').Router();
const db = require('../db/connection');

function _id(p){ return p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }

router.get('/dashboard', async (req,res)=>{
  try {
    const { brandId } = req.query;
    const w = brandId ? 'WHERE brand_id=?' : '';
    const p = brandId ? [brandId] : [];
    const [c] = await db.query(`
      SELECT
        COUNT(*) AS total,
        SUM(status='draft') AS draft_count,
        SUM(status='issued') AS issued_count,
        SUM(status='partially_paid') AS partial_count,
        SUM(status='paid') AS paid_count,
        SUM(status='overdue') AS overdue_count,
        SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN balance_amount ELSE 0 END) AS total_receivable,
        SUM(CASE WHEN status NOT IN ('paid','cancelled') AND due_date<CURDATE() THEN balance_amount ELSE 0 END) AS overdue_amount
      FROM customer_invoices ${w}`, p);
    res.json(c[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/aging', async (req,res)=>{
  try {
    const { brandId } = req.query;
    const w = brandId ? 'AND brand_id=?' : '';
    const p = brandId ? [brandId] : [];
    const [rows] = await db.query(`
      SELECT
        customer_id, customer_name,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date)<=0  THEN balance_amount ELSE 0 END) AS not_due,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 1 AND 30  THEN balance_amount ELSE 0 END) AS d_0_30,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 31 AND 60 THEN balance_amount ELSE 0 END) AS d_31_60,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 61 AND 90 THEN balance_amount ELSE 0 END) AS d_61_90,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date)>90  THEN balance_amount ELSE 0 END) AS d_90_plus,
        SUM(balance_amount) AS total_balance
      FROM customer_invoices
      WHERE status NOT IN ('paid','cancelled') ${w}
      GROUP BY customer_id, customer_name
      HAVING total_balance > 0
      ORDER BY total_balance DESC`, p);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/', async (req,res)=>{
  try {
    const { brandId, customerId, contractId, status, dateFrom, dateTo, q } = req.query;
    const conds=[]; const params=[];
    if (brandId)    { conds.push('brand_id=?'); params.push(brandId); }
    if (customerId) { conds.push('customer_id=?'); params.push(customerId); }
    if (contractId) { conds.push('contract_id=?'); params.push(contractId); }
    if (status)     { conds.push('status=?'); params.push(status); }
    if (dateFrom)   { conds.push('issue_date>=?'); params.push(dateFrom); }
    if (dateTo)     { conds.push('issue_date<=?'); params.push(dateTo); }
    if (q)          { conds.push('(customer_name LIKE ? OR code LIKE ?)');
                      params.push(`%${q}%`,`%${q}%`); }
    const where = conds.length?'WHERE '+conds.join(' AND '):'';
    const [rows] = await db.query(
      `SELECT * FROM customer_invoices ${where} ORDER BY issue_date DESC, created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/:id', async (req,res)=>{
  try {
    const [h] = await db.query('SELECT * FROM customer_invoices WHERE id=?',[req.params.id]);
    if (!h.length) return res.status(404).json({error:'Not found'});
    const [l] = await db.query('SELECT * FROM customer_invoice_lines WHERE invoice_id=?',[req.params.id]);
    res.json({ ...h[0], lines: l });
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/', async (req,res)=>{
  try {
    const b = req.body||{};
    if (!b.customer_name) return res.status(400).json({error:'customer required'});
    const id = b.id||_id('CI');
    const code = b.code || ('CI-'+new Date().getFullYear()+'-'+String(Date.now()).slice(-5));
    await db.query(
      `INSERT INTO customer_invoices
       (id,code,customer_id,customer_name,vat_number,invoice_type,contract_id,schedule_id,
        issue_date,due_date,brand_id,branch_id,cost_center_id,property_id,property_unit_id,
        currency,subtotal,vat_amount,total_amount,balance_amount,status,attachments,notes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, code, b.customer_id||null, b.customer_name, b.vat_number||null,
       b.invoice_type||'service', b.contract_id||null, b.schedule_id||null,
       b.issue_date||new Date().toISOString().slice(0,10),
       b.due_date||null, b.brand_id||null, b.branch_id||null, b.cost_center_id||null,
       b.property_id||null, b.property_unit_id||null, b.currency||'SAR',
       b.subtotal||0, b.vat_amount||0, b.total_amount||0,
       b.total_amount||0, b.status||'draft',
       b.attachments?JSON.stringify(b.attachments):null, b.notes||null,
       (req.user && req.user.username) || 'system']);
    if (Array.isArray(b.lines)) {
      for (const ln of b.lines) {
        const lid = _id('CIL');
        const lt = parseFloat(ln.quantity||1)*parseFloat(ln.unit_price||0);
        await db.query(
          `INSERT INTO customer_invoice_lines
           (id,invoice_id,description,quantity,uom,unit_price,vat_pct,line_total,account_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [lid, id, ln.description||null, ln.quantity||1, ln.uom||null,
           ln.unit_price||0, ln.vat_pct||15, lt, ln.account_id||null]);
      }
    }
    res.json({success:true, id, code});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/:id', async (req,res)=>{
  try {
    const fields=['customer_id','customer_name','vat_number','invoice_type',
                  'issue_date','due_date','brand_id','branch_id','cost_center_id',
                  'property_id','property_unit_id','subtotal','vat_amount','total_amount',
                  'balance_amount','status','notes'];
    const set=[]; const params=[];
    for (const f of fields) if (f in req.body){ set.push(`${f}=?`); params.push(req.body[f]); }
    if (!set.length) return res.json({success:true,noop:true});
    params.push(req.params.id);
    await db.query(`UPDATE customer_invoices SET ${set.join(',')} WHERE id=?`, params);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/issue', async (req,res)=>{
  try {
    await db.query(`UPDATE customer_invoices SET status='issued', zatca_status='submitted' WHERE id=?`,[req.params.id]);
    res.json({success:true, zatca:'submitted (mock)'});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/cancel', async (req,res)=>{
  try {
    await db.query(`UPDATE customer_invoices SET status='cancelled' WHERE id=?`,[req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/receive', async (req,res)=>{
  try {
    const { amount } = req.body||{};
    if (!amount || amount<=0) return res.status(400).json({error:'amount required'});
    const [r] = await db.query('SELECT total_amount, paid_amount FROM customer_invoices WHERE id=?',[req.params.id]);
    if (!r.length) return res.status(404).json({error:'Not found'});
    const newPaid = parseFloat(r[0].paid_amount||0) + parseFloat(amount);
    const balance = parseFloat(r[0].total_amount) - newPaid;
    const status = balance<=0.01 ? 'paid' : 'partially_paid';
    await db.query(
      `UPDATE customer_invoices SET paid_amount=?, balance_amount=?, status=? WHERE id=?`,
      [newPaid, Math.max(0,balance), status, req.params.id]);
    res.json({success:true, paid_amount:newPaid, balance_amount:Math.max(0,balance), status});
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
