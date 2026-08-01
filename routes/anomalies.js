/**
 * Anomaly Alerts — foundation for AI/ML layer
 * Heuristic-based for now; replaceable by ML model later.
 *   GET    /api/anomalies                — list (filter: severity, status, category)
 *   POST   /api/anomalies                — create alert manually or via job
 *   POST   /api/anomalies/:id/ack        — acknowledge
 *   POST   /api/anomalies/:id/dismiss    — dismiss
 *   POST   /api/anomalies/:id/resolve    — resolve with notes
 *   POST   /api/anomalies/scan           — run heuristic scans (duplicates, outliers)
 */
const router = require('express').Router();
const db = require('../db/connection');

function _id(p){ return p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }

router.get('/', async (req,res)=>{
  try {
    const { severity, status, category, since } = req.query;
    const conds=[]; const params=[];
    if (severity) { conds.push('severity=?'); params.push(severity); }
    if (status)   { conds.push('status=?'); params.push(status); }
    if (category) { conds.push('category=?'); params.push(category); }
    if (since)    { conds.push('detected_at>=?'); params.push(since); }
    const where = conds.length?'WHERE '+conds.join(' AND '):'';
    const [rows] = await db.query(
      `SELECT * FROM anomaly_alerts ${where}
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
         detected_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/', async (req,res)=>{
  try {
    const b = req.body||{};
    const id = b.id||_id('ALR');
    await db.query(
      `INSERT INTO anomaly_alerts
       (id,severity,category,title,description,related_doc_type,related_doc_id,score,status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, b.severity||'medium', b.category||'financial', b.title||'تنبيه',
       b.description||null, b.related_doc_type||null, b.related_doc_id||null,
       b.score||null, 'open']);
    res.json({success:true, id});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/ack', async (req,res)=>{
  try {
    await db.query(
      `UPDATE anomaly_alerts SET status='acknowledged', acknowledged_at=NOW(), acknowledged_by=? WHERE id=?`,
      [(req.user && req.user.username) || 'system', req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/dismiss', async (req,res)=>{
  try {
    await db.query(
      `UPDATE anomaly_alerts SET status='dismissed', acknowledged_at=NOW(), acknowledged_by=? WHERE id=?`,
      [(req.user && req.user.username) || 'system', req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/:id/resolve', async (req,res)=>{
  try {
    await db.query(
      `UPDATE anomaly_alerts SET status='resolved', resolution_notes=? WHERE id=?`,
      [(req.body&&req.body.notes)||null, req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Heuristic scans
router.post('/scan', async (req,res)=>{
  const found = [];
  try {
    // 1) Duplicate supplier invoices (same supplier+amount+date within 7 days)
    try {
      const [dups] = await db.query(`
        SELECT s1.id AS id1, s2.id AS id2, s1.supplier_name, s1.total_amount, s1.issue_date
        FROM supplier_invoices s1
        INNER JOIN supplier_invoices s2
          ON s1.supplier_id=s2.supplier_id
         AND s1.total_amount=s2.total_amount
         AND s1.id<s2.id
         AND ABS(DATEDIFF(s1.issue_date,s2.issue_date))<=7
        WHERE s1.status NOT IN ('cancelled') AND s2.status NOT IN ('cancelled')
        LIMIT 30`);
      for (const d of dups) {
        const id = _id('ALR');
        await db.query(
          `INSERT IGNORE INTO anomaly_alerts (id,severity,category,title,description,related_doc_type,related_doc_id,score,status)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [id, 'high', 'duplicate', 'فاتورة مورد محتمل تكرارها',
           `فاتورتان لـ ${d.supplier_name} بنفس المبلغ ${d.total_amount} خلال 7 أيام (${d.id1}, ${d.id2})`,
           'supplier_invoice', d.id1, 95, 'open']);
        found.push({type:'duplicate', id1:d.id1, id2:d.id2});
      }
    } catch(_){}

    // 2) Expense outliers (>3x supplier average)
    try {
      const [outliers] = await db.query(`
        SELECT s.id, s.supplier_name, s.total_amount,
               (SELECT AVG(total_amount) FROM supplier_invoices WHERE supplier_id=s.supplier_id) AS avg_amt
        FROM supplier_invoices s
        WHERE s.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
          AND s.status NOT IN ('cancelled')
          AND s.total_amount > (SELECT AVG(total_amount)*3 FROM supplier_invoices WHERE supplier_id=s.supplier_id)
        LIMIT 20`);
      for (const o of outliers){
        const id = _id('ALR');
        await db.query(
          `INSERT IGNORE INTO anomaly_alerts (id,severity,category,title,description,related_doc_type,related_doc_id,score,status)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [id, 'medium', 'financial', 'فاتورة مرتفعة بشكل غير معتاد',
           `${o.supplier_name}: ${o.total_amount} (المتوسط ${Math.round(o.avg_amt)})`,
           'supplier_invoice', o.id, 75, 'open']);
        found.push({type:'outlier', id:o.id});
      }
    } catch(_){}

    // 3) was "overdue contracts not invoiced" — it read contract_invoice_schedules,
    //    a table that no longer exists. Its try/catch swallows errors, so leaving
    //    the query in place would have looked healthy while silently finding nothing.
  } catch(e) { /* swallow */ }
  res.json({success:true, found_count: found.length, items: found});
});

module.exports = router;
