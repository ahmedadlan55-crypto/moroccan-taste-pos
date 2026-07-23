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
const { nextFlatJournalNumber } = require('../lib/glPosting'); // FC-B1 atomic JV numbering

function _id(p){ return p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }
function _user(req,b){ return (req.user && req.user.username) || 'system'; }

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

// ─── ASSETS (v5.10.5 — Fixed Assets Registry + GL linkage) ──────────────
//
// All asset endpoints support the new GL-linkage columns + depreciation
// tracking. The grid in views/app-content.html (#erpFixedAssets) calls:
//   GET    /assets                  → grid hydrate (with JOINed account names)
//   POST   /assets                  → modal "+ أصل جديد"
//   PUT    /assets/:id              → modal heavy edit
//   PATCH  /assets/:id/cell         → inline cell edit (whitelisted)
//   DELETE /assets/:id              → soft delete (status='disposed')
//   GET    /assets/coa-options      → COA dropdown source for the 3 GL pickers
//   POST   /assets/post-depreciation→ batch journal poster

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
    // LEFT JOIN: brands + branches + cost_centers + the 3 GL accounts so the
    // grid can render code+name chips without a second round-trip per row.
    const [rows] = await db.query(
      `SELECT a.*,
              b.name  AS brand_name,
              br.name AS branch_name,
              cc.name AS cost_center_name,
              ga.code  AS gl_asset_account_code,       ga.name_ar  AS gl_asset_account_name,
              gde.code AS gl_dep_expense_account_code, gde.name_ar AS gl_dep_expense_account_name,
              gad.code AS gl_accum_dep_account_code,   gad.name_ar AS gl_accum_dep_account_name
       FROM assets a
       LEFT JOIN brands       b   ON b.id  = a.brand_id
       LEFT JOIN branches     br  ON br.id = a.branch_id
       LEFT JOIN cost_centers cc  ON cc.id = a.cost_center_id
       LEFT JOIN gl_accounts  ga  ON ga.id  = a.gl_asset_account_id
       LEFT JOIN gl_accounts  gde ON gde.id = a.gl_dep_expense_account_id
       LEFT JOIN gl_accounts  gad ON gad.id = a.gl_accum_dep_account_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT 500`, params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Helper — book value as of `asOf` (defaults to today), per the asset's
// depreciation method. Always clamped to [salvage, cost] and never begins
// before dep_start_month (falls back to purchase_date).
//   • none          → cost (explicitly not depreciated)
//   • straight_line → cost − (months/total) × (cost − salvage)
//   • declining     → double-declining-balance on a monthly grid, switching
//                     to straight-line once that yields a larger charge,
//                     capped at salvage (IAS 16 — never depreciate below
//                     residual value).
function _computeBookValue(a, asOf) {
  const cost    = Number(a.purchase_cost) || 0;
  const salvage = Number(a.salvage_value) || 0;
  const years   = Number(a.useful_life_years) || 0;
  const method  = a.depreciation_method || 'straight_line';
  if (method === 'none') return cost;        // explicitly not depreciated
  if (cost <= 0 || years <= 0) return cost;  // can't depreciate
  const start = a.dep_start_month ? new Date(a.dep_start_month) :
                a.purchase_date    ? new Date(a.purchase_date)    : null;
  if (!start) return cost;
  const ref = asOf ? new Date(asOf) : new Date();
  const monthsElapsed = (ref.getFullYear() - start.getFullYear()) * 12
                      + (ref.getMonth() - start.getMonth());
  if (monthsElapsed <= 0) return cost;
  const totalMonths = years * 12;
  const m = Math.min(monthsElapsed, totalMonths);
  let book;
  if (method === 'declining') {
    book = cost;
    for (let i = 0; i < m; i++) {
      const ddb = book * (2 / years) / 12;                 // DDB monthly charge
      const sl  = (book - salvage) / (totalMonths - i);    // SL on remaining life
      book = Math.max(salvage, book - Math.max(ddb, sl));
      if (book <= salvage) break;
    }
  } else {
    book = cost - (m / totalMonths) * (cost - salvage);    // straight_line
  }
  return Math.max(salvage, Math.min(cost, book));
}

router.post('/assets', async (req,res)=>{
  try {
    const b = req.body||{};
    if (!b.name) return res.status(400).json({error:'name required'});
    const id = b.id||_id('AST');
    const bookValue = _computeBookValue(b);
    await db.query(
      `INSERT INTO assets
       (id,code,name,category,brand_id,branch_id,property_id,cost_center_id,
        serial_number,manufacturer,model,purchase_date,purchase_cost,
        depreciation_method,useful_life_years,salvage_value,current_value,
        warranty_expiry,assigned_to,status,notes,
        dep_start_month,dep_until_date,
        gl_asset_account_id,gl_dep_expense_account_id,gl_accum_dep_account_id,
        project_id,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.code||id, b.name, b.category||'equipment',
       b.brand_id||null, b.branch_id||null, b.property_id||null, b.cost_center_id||null,
       b.serial_number||null, b.manufacturer||null, b.model||null,
       b.purchase_date||null, b.purchase_cost||null,
       b.depreciation_method||'straight_line', b.useful_life_years||5,
       b.salvage_value||0,
       b.current_value!=null ? b.current_value : bookValue,
       b.warranty_expiry||null, b.assigned_to||null,
       b.status||'active', b.notes||null,
       b.dep_start_month || b.purchase_date || null,
       b.dep_until_date || null,
       b.gl_asset_account_id || null,
       b.gl_dep_expense_account_id || null,
       b.gl_accum_dep_account_id || null,
       b.project_id || null,
       _user(req, b)]);
    res.json({ success:true, id, bookValue });
  } catch(e){ res.status(500).json({error:e.message}); }
});

const _ASSET_FIELDS = ['code','name','category','brand_id','branch_id','property_id','cost_center_id',
                       'serial_number','manufacturer','model','purchase_date','purchase_cost',
                       'depreciation_method','useful_life_years','salvage_value','current_value',
                       'warranty_expiry','last_maintenance_date','next_maintenance_date',
                       'assigned_to','status','notes',
                       // v5.10.5 additions
                       'dep_start_month','dep_until_date',
                       'gl_asset_account_id','gl_dep_expense_account_id','gl_accum_dep_account_id',
                       'project_id'];

router.put('/assets/:id', async (req,res)=>{
  try {
    const set=[]; const params=[];
    for (const f of _ASSET_FIELDS) if (f in req.body){ set.push(`${f}=?`); params.push(req.body[f]||null); }
    if (!set.length) return res.json({success:true,noop:true});
    params.push(req.params.id);
    await db.query(`UPDATE assets SET ${set.join(',')} WHERE id=?`, params);
    // Re-compute book value on every save when cost/life/salvage changed
    if ('purchase_cost' in req.body || 'salvage_value' in req.body
        || 'useful_life_years' in req.body || 'dep_start_month' in req.body) {
      const [rows] = await db.query('SELECT * FROM assets WHERE id=?', [req.params.id]);
      if (rows.length) {
        const bv = _computeBookValue(rows[0]);
        await db.query('UPDATE assets SET current_value=? WHERE id=?', [bv, req.params.id]);
      }
    }
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// v5.10.5 — Inline single-cell PATCH for grid editing. Whitelist + same
// computed-fields refresh as PUT, but the response carries the recomputed
// book value so the grid can update its sibling cell in-place.
router.patch('/assets/:id/cell', async (req,res)=>{
  try {
    const { field, value } = req.body || {};
    if (!field || !_ASSET_FIELDS.includes(field)) return res.status(400).json({error:'field-not-allowed'});
    await db.query(`UPDATE assets SET ${field}=? WHERE id=?`, [value === '' ? null : value, req.params.id]);
    const [rows] = await db.query('SELECT * FROM assets WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({error:'not-found'});
    let bookValue = rows[0].current_value;
    if (['purchase_cost','salvage_value','useful_life_years','dep_start_month','purchase_date'].includes(field)) {
      bookValue = _computeBookValue(rows[0]);
      await db.query('UPDATE assets SET current_value=? WHERE id=?', [bookValue, req.params.id]);
    }
    res.json({ success:true, bookValue });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// v5.10.5 — Soft delete: keeps the row (journals reference it) but flags
// status='disposed'. Use ?hard=1 for an actual DELETE (admin-only path).
router.delete('/assets/:id', async (req,res)=>{
  try {
    if (req.query.hard === '1') {
      await db.query('DELETE FROM assets WHERE id=?', [req.params.id]);
    } else {
      await db.query("UPDATE assets SET status='disposed' WHERE id=?", [req.params.id]);
    }
    res.json({ success:true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// v5.10.5 — COA dropdown source for the 3 asset-row pickers.
router.get('/assets/coa-options', async (req,res)=>{
  try {
    const kind = String(req.query.kind || 'asset');
    let where = "is_active = 1";
    if (kind === 'asset') {
      // PP&E only — exclude accumulated depreciation (124*)
      where += " AND code LIKE '12%' AND code NOT LIKE '124%' AND type = 'asset'";
    } else if (kind === 'expense') {
      // Depreciation expense — by name OR by code under operating expenses
      where += " AND type = 'expense' AND (name_ar LIKE '%إهلاك%' OR code LIKE '524%' OR code LIKE '5232%')";
    } else if (kind === 'accum') {
      // Accumulated depreciation contra-asset
      where += " AND code LIKE '124%' AND type = 'asset'";
    } else {
      return res.status(400).json({error:'kind-must-be-asset|expense|accum'});
    }
    const [rows] = await db.query(
      `SELECT id, code, name_ar AS nameAr, type, level, parent_id AS parentId
       FROM gl_accounts WHERE ${where} ORDER BY code`
    );
    res.json({ success:true, kind, accounts: rows });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Insert one gl_entries row, appending accounting-dimension columns when
// present and falling back to the base column set if the DB predates them
// (mirrors the defensive pattern in routes/cash.js).
async function _insertGlEntry(row) {
  const cols = ['id','journal_id','account_id','account_code','account_name','debit','credit','description'];
  const vals = [row.id, row.journal_id, row.account_id, row.account_code||'', row.account_name||'',
                Number(row.debit)||0, Number(row.credit)||0, row.description||''];
  const dimCols = [], dimVals = [];
  for (const [k, col] of [['brand_id','brand_id'],['branch_id','branch_id'],['cost_center_id','cost_center_id']]) {
    if (row[k]) { dimCols.push(col); dimVals.push(row[k]); }
  }
  const allCols = cols.concat(dimCols), allVals = vals.concat(dimVals);
  try {
    await db.query('INSERT INTO gl_entries ('+allCols.join(',')+') VALUES ('+allCols.map(()=>'?').join(',')+')', allVals);
  } catch (err) {
    if (dimCols.length) await db.query('INSERT INTO gl_entries ('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')', vals);
    else throw err;
  }
  // Keep the cached account balance in step (net = debit − credit).
  if (row.account_id) {
    const net = (Number(row.debit)||0) - (Number(row.credit)||0);
    await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [net, row.account_id]);
  }
}

// v6.30.0 — Post one balanced depreciation journal across all eligible
// assets for [from, to]. Per asset the period charge is the DROP in book
// value over the period — book(effectiveStart) − book(to) — which by
// construction:
//   • is idempotent (effectiveStart is anchored at dep_until_date, so a
//     re-run of an already-posted period charges 0),
//   • respects each asset's depreciation_method (incl. declining / none),
//   • honours dep_start_month (no charge before depreciation begins), and
//   • is capped at the residual value (never depreciates below salvage).
// Each line carries the asset's brand/branch/cost-center so depreciation
// expense is analysable by dimension. Pass ?preview=1 for a dry-run that
// returns the projected count + total without writing anything.
router.post('/assets/post-depreciation', async (req,res)=>{
  try {
    const { from, to, preparedBy } = req.body || {};
    const preview = req.query.preview === '1' || (req.body && req.body.preview === true);
    if (!from || !to) return res.status(400).json({error:'from + to required'});
    // Period-lock guard (v5.10.0). Best-effort: skip if helper unavailable / preview.
    if (!preview) {
      try {
        const erpRouter = require('./erp');
        if (erpRouter._checkPeriodOpen) {
          const open = await erpRouter._checkPeriodOpen(to, false);
          if (open && open.locked) return res.status(400).json({error:'period-locked', period: open.period});
        }
      } catch(_) { /* helper not exported — soft-skip */ }
    }

    // Eligible: active, fully GL-linked, depreciable, and NOT method='none'.
    // JOIN the two posting accounts so each entry carries its code + name.
    const [assets] = await db.query(
      `SELECT a.id, a.code, a.name, a.purchase_cost, a.salvage_value, a.useful_life_years,
              a.depreciation_method, a.purchase_date, a.dep_start_month, a.dep_until_date,
              a.gl_dep_expense_account_id, a.gl_accum_dep_account_id,
              a.brand_id, a.branch_id, a.cost_center_id,
              gde.code AS dep_expense_code, gde.name_ar AS dep_expense_name,
              gad.code AS accum_code,       gad.name_ar AS accum_name
         FROM assets a
         LEFT JOIN gl_accounts gde ON gde.id = a.gl_dep_expense_account_id
         LEFT JOIN gl_accounts gad ON gad.id = a.gl_accum_dep_account_id
        WHERE a.status = 'active'
          AND a.depreciation_method <> 'none'
          AND a.gl_dep_expense_account_id IS NOT NULL
          AND a.gl_accum_dep_account_id   IS NOT NULL
          AND a.useful_life_years > 0
          AND a.purchase_cost > 0`);

    const toDate = new Date(to);
    const lines = [];
    let total = 0;
    const stamp = [];   // { id, bookValue }
    for (const a of assets) {
      // effectiveStart = latest of (from, dep_until_date). Anchoring at
      // dep_until_date is what makes re-running a period a no-op.
      let effStart = new Date(from);
      if (a.dep_until_date) {
        const d = new Date(a.dep_until_date);
        if (d > effStart) effStart = d;
      }
      if (toDate <= effStart) continue;                 // nothing new this period
      const bvStart = _computeBookValue(a, effStart);
      const bvEnd   = _computeBookValue(a, to);
      const periodAmt = Math.round((bvStart - bvEnd) * 100) / 100;
      if (periodAmt <= 0) continue;                     // not started / fully depreciated
      lines.push({
        debit_account: a.gl_dep_expense_account_id, debit_code: a.dep_expense_code, debit_name: a.dep_expense_name,
        credit_account: a.gl_accum_dep_account_id,  credit_code: a.accum_code,      credit_name: a.accum_name,
        amount: periodAmt,
        brand_id: a.brand_id, branch_id: a.branch_id, cost_center_id: a.cost_center_id,
        description: `إهلاك الأصل ${a.code || a.id} — ${a.name}`
      });
      total += periodAmt;
      stamp.push({ id: a.id, bookValue: bvEnd });
    }
    total = Math.round(total * 100) / 100;
    if (!lines.length) return res.json({ success:true, message:'لا توجد أصول قابلة للإهلاك خلال الفترة', total:0, lines:0 });

    // Dry-run — report the projection without touching the ledger.
    if (preview) return res.json({ success:true, preview:true, total, lines: lines.length });

    // Build a balanced journal — one DR + one CR per asset.
    const jrnId = 'JRN-DEP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); // FC-B1 unique under concurrency
    const journalNumber = await nextFlatJournalNumber(); // FC-B1 atomic (was created_at DESC race)
    await db.query(
      `INSERT INTO gl_journals
        (id, journal_number, journal_date, description, total_debit, total_credit, status, reference_type, reference_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [jrnId, journalNumber, to,
       `قيد إهلاك أصول ثابتة — الفترة ${from} → ${to}`,
       total, total, 'posted', 'depreciation', jrnId,
       preparedBy || _user(req, {}), new Date()]);
    let lineNo = 0;
    for (const l of lines) {
      lineNo++;
      await _insertGlEntry({ id:`${jrnId}-D${lineNo}`, journal_id:jrnId,
        account_id:l.debit_account, account_code:l.debit_code, account_name:l.debit_name,
        debit:l.amount, credit:0, description:l.description,
        brand_id:l.brand_id, branch_id:l.branch_id, cost_center_id:l.cost_center_id });
      await _insertGlEntry({ id:`${jrnId}-C${lineNo}`, journal_id:jrnId,
        account_id:l.credit_account, account_code:l.credit_code, account_name:l.credit_name,
        debit:0, credit:l.amount, description:l.description,
        brand_id:l.brand_id, branch_id:l.branch_id, cost_center_id:l.cost_center_id });
    }
    // Stamp dep_until_date + refresh the cached book value on each asset.
    for (const s of stamp) {
      await db.query('UPDATE assets SET dep_until_date=?, current_value=? WHERE id=?', [to, s.bookValue, s.id]);
    }
    res.json({ success:true, journalId: jrnId, journalNumber, total, lines: lines.length });
  } catch(e){ console.error('[post-depreciation]', e); res.status(500).json({error:e.message}); }
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
         SUM(CASE WHEN line_type='labor' THEN total_cost ELSE 0 END) AS labor_total,
         SUM(CASE WHEN line_type='part'  THEN total_cost ELSE 0 END) AS parts_total,
         SUM(CASE WHEN line_type IN ('service','external') THEN total_cost ELSE 0 END) AS ext_total,
         SUM(total_cost) AS grand_total,
         SUM(CASE WHEN line_type='labor' THEN hours ELSE 0 END) AS hours_total
       FROM work_order_lines WHERE work_order_id=?`, [req.params.id]);
    const a = agg[0]||{};
    await db.query(
      `UPDATE work_orders
       SET completed_at=NOW(), status='completed',
           labor_cost=?, parts_cost=?, external_cost=?, total_cost=?,
           actual_hours=?, completion_notes=?
       WHERE id=?`,
      [a.labor_total||0, a.parts_total||0, a.ext_total||0, a.grand_total||0, a.hours_total||0,
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
