/**
 * Budgets — annual + monthly per cost center, with variance tracking.
 *   GET    /api/budgets                  — list (filter: year, cc, brand)
 *   POST   /api/budgets                  — create budget line
 *   POST   /api/budgets/bulk             — create many at once (for full year)
 *   PUT    /api/budgets/:id              — update
 *   DELETE /api/budgets/:id              — delete
 *   GET    /api/budgets/variance         — variance report
 *   POST   /api/budgets/recompute        — refresh actuals from journal lines
 */
const router = require('express').Router();
const db = require('../db/connection');

function _id(p){ return p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }

router.get('/', async (req,res)=>{
  try {
    const { year, costCenterId, brandId } = req.query;
    const conds=[]; const params=[];
    if (year)         { conds.push('fiscal_year=?'); params.push(year); }
    if (costCenterId) { conds.push('cost_center_id=?'); params.push(costCenterId); }
    if (brandId)      { conds.push('brand_id=?'); params.push(brandId); }
    const where = conds.length?'WHERE '+conds.join(' AND '):'';
    const [rows] = await db.query(
      `SELECT b.*, cc.name AS cc_name FROM budget_lines b
       LEFT JOIN cost_centers cc ON cc.id=b.cost_center_id
       ${where} ORDER BY fiscal_year DESC, period_month, cc_name`, params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/', async (req,res)=>{
  try {
    const b = req.body||{};
    if (!b.fiscal_year || !b.cost_center_id) return res.status(400).json({error:'fiscal_year + cost_center_id required'});
    const id = b.id||_id('BUD');
    await db.query(
      `INSERT INTO budget_lines
       (id,fiscal_year,period_month,cost_center_id,account_id,brand_id,
        budget_amount,actual_amount,committed_amount,
        threshold_warn_pct,threshold_block_pct,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.fiscal_year, b.period_month||null, b.cost_center_id, b.account_id||null,
       b.brand_id||null, b.budget_amount||0, 0, 0,
       b.threshold_warn_pct||80, b.threshold_block_pct||100, b.notes||null]);
    res.json({success:true, id});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/bulk', async (req,res)=>{
  try {
    const { fiscal_year, cost_center_id, brand_id, monthly_amounts } = req.body||{};
    if (!fiscal_year || !cost_center_id || !Array.isArray(monthly_amounts) || monthly_amounts.length !== 12) {
      return res.status(400).json({error:'fiscal_year + cost_center_id + monthly_amounts(12) required'});
    }
    const ids = [];
    for (let m=0; m<12; m++){
      const id = _id('BUD');
      await db.query(
        `INSERT INTO budget_lines (id,fiscal_year,period_month,cost_center_id,brand_id,budget_amount)
         VALUES (?,?,?,?,?,?)`,
        [id, fiscal_year, m+1, cost_center_id, brand_id||null, monthly_amounts[m]||0]);
      ids.push(id);
    }
    res.json({success:true, ids, count:12});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/:id', async (req,res)=>{
  try {
    const fields=['budget_amount','threshold_warn_pct','threshold_block_pct','notes'];
    const set=[]; const params=[];
    for (const f of fields) if (f in req.body){ set.push(`${f}=?`); params.push(req.body[f]); }
    if (!set.length) return res.json({success:true,noop:true});
    params.push(req.params.id);
    await db.query(`UPDATE budget_lines SET ${set.join(',')} WHERE id=?`, params);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.delete('/:id', async (req,res)=>{
  try {
    await db.query('DELETE FROM budget_lines WHERE id=?',[req.params.id]);
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/variance', async (req,res)=>{
  try {
    const { year } = req.query;
    if (!year) return res.status(400).json({error:'year required'});
    const [rows] = await db.query(
      `SELECT b.fiscal_year, b.period_month, b.cost_center_id, cc.name AS cc_name,
              SUM(b.budget_amount) AS budget,
              SUM(b.actual_amount) AS actual,
              SUM(b.budget_amount - b.actual_amount) AS variance,
              CASE WHEN SUM(b.budget_amount)>0 THEN
                ROUND((SUM(b.actual_amount)/SUM(b.budget_amount))*100,2) ELSE 0 END AS utilization_pct
       FROM budget_lines b
       LEFT JOIN cost_centers cc ON cc.id=b.cost_center_id
       WHERE b.fiscal_year=?
       GROUP BY b.fiscal_year, b.period_month, b.cost_center_id, cc.name
       ORDER BY b.period_month, cc.name`, [year]);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/recompute', async (req,res)=>{
  try {
    const { year } = req.body||{};
    if (!year) return res.status(400).json({error:'year required'});
    // Reset
    await db.query(`UPDATE budget_lines SET actual_amount=0 WHERE fiscal_year=?`, [year]);
    // Recompute from gl_journal_lines if exists
    try {
      await db.query(`
        UPDATE budget_lines b
        LEFT JOIN (
          SELECT cost_center_id, MONTH(j.entry_date) AS m, SUM(jl.debit-jl.credit) AS amt
          FROM gl_journal_lines jl
          INNER JOIN gl_journals j ON j.id=jl.journal_id
          WHERE YEAR(j.entry_date)=? AND j.status='posted'
          GROUP BY cost_center_id, MONTH(j.entry_date)
        ) a ON a.cost_center_id=b.cost_center_id AND a.m=b.period_month
        SET b.actual_amount = COALESCE(a.amt,0),
            b.variance_amount = b.budget_amount - COALESCE(a.amt,0),
            b.variance_pct = CASE WHEN b.budget_amount>0
              THEN ROUND(((COALESCE(a.amt,0)/b.budget_amount)*100),2) ELSE 0 END
        WHERE b.fiscal_year=?`, [year, year]);
    } catch(e) { /* gl tables might not exist yet */ }
    res.json({success:true, year});
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
