/**
 * Supplier Invoices (AP) — V5
 *   GET    /api/ap-invoices/dashboard
 *   GET    /api/ap-invoices/aging                 — Aging report 0-30/31-60/61-90/90+
 *   GET    /api/ap-invoices                       — list
 *   GET    /api/ap-invoices/:id                   — single + lines
 *   POST   /api/ap-invoices                       — create draft
 *   PUT    /api/ap-invoices/:id                   — update header
 *   POST   /api/ap-invoices/:id/lines             — add line
 *   DELETE /api/ap-invoices/lines/:lid            — delete line
 *   POST   /api/ap-invoices/:id/approve           — approve (changes status)
 *   POST   /api/ap-invoices/:id/cancel
 *   POST   /api/ap-invoices/:id/pay               — record payment + reduce balance
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
        SUM(status='approved') AS approved_count,
        SUM(status='partially_paid') AS partial_count,
        SUM(status='paid') AS paid_count,
        SUM(status='overdue') AS overdue_count,
        SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN balance_amount ELSE 0 END) AS total_payable,
        SUM(CASE WHEN status NOT IN ('paid','cancelled') AND due_date<CURDATE() THEN balance_amount ELSE 0 END) AS overdue_amount
      FROM supplier_invoices ${w}`, p);
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
        supplier_id, supplier_name,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date)<=0  THEN balance_amount ELSE 0 END) AS not_due,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 1 AND 30  THEN balance_amount ELSE 0 END) AS d_0_30,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 31 AND 60 THEN balance_amount ELSE 0 END) AS d_31_60,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 61 AND 90 THEN balance_amount ELSE 0 END) AS d_61_90,
        SUM(CASE WHEN DATEDIFF(CURDATE(),due_date)>90  THEN balance_amount ELSE 0 END) AS d_90_plus,
        SUM(balance_amount) AS total_balance
      FROM supplier_invoices
      WHERE status NOT IN ('paid','cancelled') ${w}
      GROUP BY supplier_id, supplier_name
      HAVING total_balance > 0
      ORDER BY total_balance DESC`, p);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/', async (req,res)=>{
  try {
    const { brandId, supplierId, status, dateFrom, dateTo, q } = req.query;
    const conds=[]; const params=[];
    if (brandId)   { conds.push('brand_id=?'); params.push(brandId); }
    if (supplierId){ conds.push('supplier_id=?'); params.push(supplierId); }
    if (status)    { conds.push('status=?'); params.push(status); }
    if (dateFrom)  { conds.push('issue_date>=?'); params.push(dateFrom); }
    if (dateTo)    { conds.push('issue_date<=?'); params.push(dateTo); }
    if (q)         { conds.push('(invoice_no LIKE ? OR supplier_name LIKE ? OR code LIKE ?)');
                     params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    const where = conds.length?'WHERE '+conds.join(' AND '):'';
    const [rows] = await db.query(
      `SELECT * FROM supplier_invoices ${where} ORDER BY issue_date DESC, created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/:id', async (req,res)=>{
  try {
    const [h] = await db.query('SELECT * FROM supplier_invoices WHERE id=?', [req.params.id]);
    if (!h.length) return res.status(404).json({error:'Not found'});
    const [l] = await db.query('SELECT * FROM supplier_invoice_lines WHERE invoice_id=?',[req.params.id]);
    res.json({ ...h[0], lines: l });
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/', async (req,res)=>{
  try {
    const b = req.body||{};
    if (!b.supplier_name) return res.status(400).json({error:'supplier required'});
    const id = b.id||_id('SI');
    const code = b.code || ('SI-'+new Date().getFullYear()+'-'+String(Date.now()).slice(-5));
    await db.query(
      `INSERT INTO supplier_invoices
       (id,code,supplier_id,supplier_name,vat_number,invoice_no,issue_date,due_date,
        brand_id,branch_id,cost_center_id,purchase_order_id,grn_id,currency,
        subtotal,discount_amount,vat_amount,total_amount,balance_amount,
        payment_terms,status,attachments,notes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, code, b.supplier_id||null, b.supplier_name, b.vat_number||null,
       b.invoice_no||null, b.issue_date||new Date().toISOString().slice(0,10),
       b.due_date||null, b.brand_id||null, b.branch_id||null, b.cost_center_id||null,
       b.purchase_order_id||null, b.grn_id||null, b.currency||'SAR',
       b.subtotal||0, b.discount_amount||0, b.vat_amount||0, b.total_amount||0,
       b.total_amount||0, b.payment_terms||'net30', b.status||'draft',
       b.attachments?JSON.stringify(b.attachments):null, b.notes||null,
       req.headers['x-user']||'system']);
    if (Array.isArray(b.lines)) {
      for (const ln of b.lines) {
        const lid = _id('SIL');
        const lt = (parseFloat(ln.quantity||1)*parseFloat(ln.unit_price||0))*(1-(parseFloat(ln.discount_pct||0)/100));
        await db.query(
          `INSERT INTO supplier_invoice_lines
           (id,invoice_id,item_id,description,quantity,uom,unit_price,discount_pct,vat_pct,line_total,account_id,cost_center_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [lid, id, ln.item_id||null, ln.description||null, ln.quantity||1, ln.uom||null,
           ln.unit_price||0, ln.discount_pct||0, ln.vat_pct||15, lt,
           ln.account_id||null, ln.cost_center_id||null]);
      }
    }
    res.json({success:true, id, code});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/:id', async (req,res)=>{
  try {
    const fields=['supplier_id','supplier_name','vat_number','invoice_no','issue_date','due_date',
                  'brand_id','branch_id','cost_center_id','purchase_order_id','grn_id',
                  'subtotal','discount_amount','vat_amount','total_amount','balance_amount',
                  'payment_terms','status','notes'];
    const set=[]; const params=[];
    for (const f of fields) if (f in req.body){ set.push(`${f}=?`); params.push(req.body[f]); }
    if (!set.length) return res.json({success:true,noop:true});
    params.push(req.params.id);
    await db.query(`UPDATE supplier_invoices SET ${set.join(',')} WHERE id=?`, params);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/lines', async (req,res)=>{
  try {
    const ln = req.body||{};
    const lid = _id('SIL');
    const lt = (parseFloat(ln.quantity||1)*parseFloat(ln.unit_price||0))*(1-(parseFloat(ln.discount_pct||0)/100));
    await db.query(
      `INSERT INTO supplier_invoice_lines
       (id,invoice_id,item_id,description,quantity,uom,unit_price,discount_pct,vat_pct,line_total,account_id,cost_center_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lid, req.params.id, ln.item_id||null, ln.description||null, ln.quantity||1, ln.uom||null,
       ln.unit_price||0, ln.discount_pct||0, ln.vat_pct||15, lt,
       ln.account_id||null, ln.cost_center_id||null]);
    res.json({success:true, id: lid, total: lt});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.delete('/lines/:lid', async (req,res)=>{
  try {
    await db.query('DELETE FROM supplier_invoice_lines WHERE id=?',[req.params.lid]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/approve', async (req,res)=>{
  try {
    await db.query(`UPDATE supplier_invoices SET status='approved' WHERE id=?`,[req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/cancel', async (req,res)=>{
  try {
    await db.query(`UPDATE supplier_invoices SET status='cancelled' WHERE id=?`,[req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/pay', async (req,res)=>{
  try {
    const { amount } = req.body||{};
    if (!amount || amount<=0) return res.status(400).json({error:'amount required'});
    const [r] = await db.query('SELECT total_amount, paid_amount FROM supplier_invoices WHERE id=?',[req.params.id]);
    if (!r.length) return res.status(404).json({error:'Not found'});
    const newPaid = parseFloat(r[0].paid_amount||0) + parseFloat(amount);
    const balance = parseFloat(r[0].total_amount) - newPaid;
    const status = balance<=0.01 ? 'paid' : 'partially_paid';
    await db.query(
      `UPDATE supplier_invoices SET paid_amount=?, balance_amount=?, status=? WHERE id=?`,
      [newPaid, Math.max(0,balance), status, req.params.id]);
    res.json({success:true, paid_amount: newPaid, balance_amount: Math.max(0,balance), status});
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
