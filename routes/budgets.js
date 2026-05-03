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
    // V5.9.15 — fiscal_year is required; either cost_center_id OR account_id
    // must be set (account-level budgets are now first-class).
    if (!b.fiscal_year) return res.status(400).json({error:'fiscal_year required'});
    if (!b.cost_center_id && !b.account_id)
      return res.status(400).json({error:'يجب اختيار مركز تكلفة أو حساب من شجرة الحسابات'});
    // If account_id is provided, validate it exists
    if (b.account_id) {
      const [g] = await db.query('SELECT id FROM gl_accounts WHERE id=? LIMIT 1', [b.account_id]);
      if (!g.length) return res.status(400).json({error:'الحساب غير موجود'});
    }
    const id = b.id||_id('BUD');
    await db.query(
      `INSERT INTO budget_lines
       (id,fiscal_year,period_month,cost_center_id,account_id,brand_id,
        budget_amount,actual_amount,committed_amount,
        threshold_warn_pct,threshold_block_pct,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.fiscal_year, b.period_month||null,
       b.cost_center_id || null,
       b.account_id || null,
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
    // V5.9.15 — recompute from BOTH cost_center_id AND account_id paths so
    // account-level budgets (the user's new requirement) actually pick up
    // their real actuals from gl_entries. The historical query only joined
    // by cost-center, leaving account_id-keyed budgets stuck on zero.
    try {
      // Path 1: cost-center based budgets (legacy)
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
        WHERE b.fiscal_year=? AND b.account_id IS NULL`, [year, year]);
    } catch(e) { /* gl_journal_lines might not exist on older schemas */ }
    try {
      // Path 2: account-level budgets (NEW). Uses gl_entries.account_id +
      // posted-journal entry_date so each leaf account in the COA can
      // be budgeted on its own. Falls back gracefully if the v5 schema
      // hasn't been migrated yet.
      await db.query(`
        UPDATE budget_lines b
        LEFT JOIN (
          SELECT e.account_id, MONTH(j.journal_date) AS m, SUM(e.debit - e.credit) AS amt
          FROM gl_entries e
          INNER JOIN gl_journals j ON j.id = e.journal_id
          WHERE YEAR(j.journal_date)=? AND j.status='posted'
          GROUP BY e.account_id, MONTH(j.journal_date)
        ) a ON a.account_id = b.account_id AND a.m = b.period_month
        SET b.actual_amount = COALESCE(a.amt,0),
            b.variance_amount = b.budget_amount - COALESCE(a.amt,0),
            b.variance_pct = CASE WHEN b.budget_amount>0
              THEN ROUND(((COALESCE(a.amt,0)/b.budget_amount)*100),2) ELSE 0 END
        WHERE b.fiscal_year=? AND b.account_id IS NOT NULL`, [year, year]);
    } catch(e) { /* gl_entries might not exist on older schemas */ }
    res.json({success:true, year});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// V5.9.15 — Full COA tree for the budget UI: returns EVERY active account
// (including zero-balance and zero-budget) joined with its budget for the
// requested fiscal year. Lets the UI render the entire IFRS COA tree with
// budget/actual/variance per node, instead of only listing the rows that
// happen to have a budget_lines row already. This is what the user asked
// for: "اريد في قسم الميزانية ان نظهر لي الحسابات الصفرية وجميع الحسابات
// الخاصة بالشجرة حسب المعيار".
router.get('/coa-tree', async (req, res) => {
  try {
    const fiscalYear = req.query.fiscalYear || new Date().getFullYear();
    const brandId    = req.query.brandId || null;

    // Pull every active account in the COA. We don't filter by type — the
    // budget tree shows assets/liabilities/equity/revenue/expense alike;
    // the user can collapse roots they don't care about in the UI.
    const [accounts] = await db.query(
      `SELECT id, code, name_ar, name_en, type, parent_id, level, COALESCE(balance,0) AS balance
       FROM gl_accounts
       WHERE COALESCE(is_active,1)=1
       ORDER BY code ASC`);

    // Aggregate budget_lines for the requested fiscal year, summed across
    // months (so the tree shows the full-year roll-up). Optional brand filter.
    const params = [fiscalYear];
    let whereBrand = '';
    if (brandId) { whereBrand = ' AND brand_id=?'; params.push(brandId); }
    const [budgets] = await db.query(
      `SELECT account_id,
              SUM(COALESCE(budget_amount,0))   AS budget_amount,
              SUM(COALESCE(actual_amount,0))   AS actual_amount,
              SUM(COALESCE(committed_amount,0)) AS committed_amount,
              MAX(threshold_warn_pct)  AS threshold_warn_pct,
              MAX(threshold_block_pct) AS threshold_block_pct
       FROM budget_lines
       WHERE fiscal_year=? AND account_id IS NOT NULL${whereBrand}
       GROUP BY account_id`, params);

    const byAccount = {};
    budgets.forEach(b => { byAccount[b.account_id] = b; });

    res.json({
      fiscalYear: Number(fiscalYear),
      accounts: accounts.map(a => {
        const b = byAccount[a.id] || {};
        const budget = Number(b.budget_amount || 0);
        const actual = Number(b.actual_amount || 0);
        const variance = budget - actual;
        const utilizationPct = budget > 0 ? Math.round((actual / budget) * 10000) / 100 : 0;
        return {
          id: a.id, code: a.code, nameAr: a.name_ar, nameEn: a.name_en,
          type: a.type, parentId: a.parent_id, level: Number(a.level)||1,
          balance: Number(a.balance || 0),
          budgetAmount: budget,
          actualAmount: actual,
          committedAmount: Number(b.committed_amount || 0),
          varianceAmount: variance,
          variancePct: utilizationPct,
          warnPct:  Number(b.threshold_warn_pct  || 80),
          blockPct: Number(b.threshold_block_pct || 100),
          // Convenience flags for the UI
          isZeroBudget: budget === 0,
          isZeroActual: actual === 0,
          hasBudget:    budget > 0
        };
      })
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

module.exports = router;
