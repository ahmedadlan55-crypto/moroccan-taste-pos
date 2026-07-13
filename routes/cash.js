const router = require('express').Router();
const db = require('../db/connection');
// FC-P1b — capability guard + JWT actor for voucher approval (double-approve safe).
const requireCapability = require('../middleware/requireCapability');
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }

// ═══════════════════════════════════════════════════════════════
// HELPER: Auto-create GL accounts for cash/bank + post journals
// ═══════════════════════════════════════════════════════════════
async function ensureCashAccount(cashBoxId, name, code) {
  const [existing] = await db.query('SELECT gl_account_id FROM cash_boxes WHERE id = ?', [cashBoxId]);
  if (existing.length && existing[0].gl_account_id) return existing[0].gl_account_id;
  // Create under 1101 (النقدية)
  const [parent] = await db.query("SELECT id FROM gl_accounts WHERE code = '1101' LIMIT 1");
  let parentId = parent.length ? parent[0].id : null;
  if (!parentId) {
    const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11' LIMIT 1");
    parentId = 'GL-1101';
    await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [parentId, '1101', 'النقدية', 'asset', p11.length ? p11[0].id : null, 3]);
  }
  const accId = 'GL-CB-' + Date.now();
  const accCode = '1101-' + code;
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
    [accId, accCode, name, 'asset', parentId, 4]);
  await db.query('UPDATE cash_boxes SET gl_account_id = ? WHERE id = ?', [accId, cashBoxId]);
  return accId;
}

async function ensureBankAccount(bankId, name, code) {
  const [existing] = await db.query('SELECT gl_account_id FROM bank_accounts WHERE id = ?', [bankId]);
  if (existing.length && existing[0].gl_account_id) return existing[0].gl_account_id;
  const [parent] = await db.query("SELECT id FROM gl_accounts WHERE code = '1102' LIMIT 1");
  let parentId = parent.length ? parent[0].id : null;
  if (!parentId) {
    const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11' LIMIT 1");
    parentId = 'GL-1102';
    await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [parentId, '1102', 'البنوك', 'asset', p11.length ? p11[0].id : null, 3]);
  }
  const accId = 'GL-BK-' + Date.now();
  const accCode = '1102-' + code;
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
    [accId, accCode, name, 'asset', parentId, 4]);
  await db.query('UPDATE bank_accounts SET gl_account_id = ? WHERE id = ?', [accId, bankId]);
  return accId;
}

// v5.11.4 — explicit-parent helper used when the cashbox / bank-account
// modal lets the user pick a parent GL account and the system needs to
// mint a fresh gl_account beneath it (with the suggested code that the
// frontend computed via the same algorithm as erpAddChildAccount).
//
// Rules:
//   - parentId must exist and live under root 1101 (cashbox) or 1102 (bank).
//   - newCode must be unique on gl_accounts.code.
//   - On collision, falls back to '<parent.code>-<random>' so the
//     account still gets created — the user can rename later.
async function createGlAccountUnderParent({ parentId, suggestedCode, suggestedLevel, suggestedName, type, requiredRoot }) {
  if (!parentId) return null;
  const [parentRows] = await db.query('SELECT id, code, level FROM gl_accounts WHERE id = ?', [parentId]);
  if (!parentRows.length) return null;
  const parent = parentRows[0];
  if (requiredRoot && !String(parent.code || '').startsWith(requiredRoot)) {
    throw new Error('الأب يجب أن يكون تحت ' + requiredRoot);
  }
  let code = String(suggestedCode || '').trim();
  if (!code) {
    // Compute next-suffix based on parent's existing children — same algorithm
    // as erpAddChildAccount so the cash modal produces consistent codes.
    const [siblings] = await db.query(
      'SELECT code FROM gl_accounts WHERE parent_id = ? ORDER BY code',
      [parentId]);
    if (!siblings.length) {
      code = (Number(parent.level) >= 3) ? (parent.code + '01') : (parent.code + '1');
    } else {
      const last = siblings[siblings.length - 1].code;
      const suffix = String(last).substring(String(parent.code).length);
      const next = parseInt(suffix, 10) + 1;
      code = parent.code + String(next).padStart(suffix.length || 1, '0');
    }
  }
  // Resolve collision by appending a random suffix
  const [clash] = await db.query('SELECT id FROM gl_accounts WHERE code = ?', [code]);
  if (clash.length) {
    code = code + '-' + Math.random().toString(36).slice(2, 5);
  }
  const newId = 'GL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  // v5.11.6 — level is ALWAYS parent.level + 1. The frontend ships a
  // suggestedLevel for sanity (computed from the same parent picker),
  // but it's only used to log a warning when the two disagree — never
  // as the source of truth. Single source of truth = parent.level.
  const computedLevel = Number(parent.level || 1) + 1;
  if (suggestedLevel != null && Number(suggestedLevel) && Number(suggestedLevel) !== computedLevel) {
    console.warn('[cash] suggestedLevel ' + suggestedLevel +
                 ' != computed ' + computedLevel + ' for parent ' + parent.code +
                 ' — using computed value');
  }
  await db.query(
    'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
    [newId, code, suggestedName || code, type || 'asset', parentId, computedLevel]);
  return { id: newId, code, level: computedLevel };
}

async function getSourceAccount(type, id) {
  if (type === 'cash') {
    const [r] = await db.query('SELECT id, name, code, gl_account_id FROM cash_boxes WHERE id = ?', [id]);
    if (!r.length) throw new Error('الصندوق غير موجود');
    const gl = await ensureCashAccount(id, r[0].name, r[0].code || r[0].id);
    return { glId: gl, name: r[0].name, code: r[0].code };
  }
  const [r] = await db.query('SELECT id, bank_name, account_number, gl_account_id FROM bank_accounts WHERE id = ?', [id]);
  if (!r.length) throw new Error('الحساب البنكي غير موجود');
  const gl = await ensureBankAccount(id, r[0].bank_name, r[0].account_number || r[0].id.substring(0,6));
  return { glId: gl, name: r[0].bank_name, code: r[0].account_number || '' };
}

// v5.11.4 — fifth `dims` argument carries brand/branch/cost-center/project
// from the voucher header through to gl_journals + gl_entries so every
// dimensional report (Trial Balance by brand, P&L by branch, etc.)
// includes voucher activity. Each entry inherits the header dims unless
// the line explicitly overrides — same inheritance contract that
// gl/journals POST uses.
async function createJournal(date, description, lines, username, dims) {
  dims = dims || {};
  const journalId = 'GLJ-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
  const [last] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
  let num = 1;
  if (last.length && last[0].journal_number) {
    const m = last[0].journal_number.match(/(\d+)/);
    if (m) num = parseInt(m[1]) + 1;
  }
  const jNum = 'JE-' + String(num).padStart(5, '0');
  let totalD = 0, totalC = 0;
  lines.forEach(l => { totalD += Number(l.debit)||0; totalC += Number(l.credit)||0; });
  if (Math.abs(totalD - totalC) > 0.01) throw new Error('القيد غير متوازن');
  // Header insert: try the wide form (with dim columns) first; fall back
  // to the legacy column set if the migration hasn't applied yet.
  const headerCols = ['id','journal_number','journal_date','reference_type','description',
                      'total_debit','total_credit','status','created_by','posted_by','posted_at'];
  const headerVals = [journalId, jNum, date, 'cash', description, totalD, totalC,
                      'posted', username||'', username||'', new Date()];
  const dimMap = [
    ['brandId','brand_id'], ['branchId','branch_id'],
    ['projectId','project_id'], ['costCenterId','cost_center_id']
  ];
  const dimCols = [], dimVals = [];
  for (const [k, col] of dimMap) {
    if (dims[k]) { dimCols.push(col); dimVals.push(dims[k]); }
  }
  const allCols = headerCols.concat(dimCols);
  const allVals = headerVals.concat(dimVals);
  try {
    await db.query(
      'INSERT INTO gl_journals (' + allCols.join(',') + ') VALUES (' + allCols.map(() => '?').join(',') + ')',
      allVals);
  } catch (err) {
    if (dimCols.length) {
      await db.query(
        'INSERT INTO gl_journals (' + headerCols.slice(0, -1).join(',') + ', posted_at) VALUES (' + headerCols.map(() => '?').join(',') + ')',
        headerVals);
    } else throw err;
  }
  for (const l of lines) {
    const entryId = 'GLE-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    // Per-entry insert with dim inheritance (line value wins, header is fallback)
    const entryCols = ['id','journal_id','account_id','account_code','account_name',
                       'debit','credit','description'];
    const entryVals = [entryId, journalId, l.accountId||null, l.accountCode||'',
                       l.accountName||'', Number(l.debit)||0, Number(l.credit)||0,
                       l.description || description];
    const entryDimCols = [], entryDimVals = [];
    for (const [k, col] of dimMap.concat([['warehouseId','warehouse_id']])) {
      const v = (l[k] != null && l[k] !== '') ? l[k] : dims[k];
      if (v) { entryDimCols.push(col); entryDimVals.push(v); }
    }
    const allEntryCols = entryCols.concat(entryDimCols);
    const allEntryVals = entryVals.concat(entryDimVals);
    try {
      await db.query(
        'INSERT INTO gl_entries (' + allEntryCols.join(',') + ') VALUES (' + allEntryCols.map(() => '?').join(',') + ')',
        allEntryVals);
    } catch (err) {
      if (entryDimCols.length) {
        await db.query(
          'INSERT INTO gl_entries (' + entryCols.join(',') + ') VALUES (' + entryCols.map(() => '?').join(',') + ')',
          entryVals);
      } else throw err;
    }
    if (l.accountId) {
      const net = (Number(l.debit)||0) - (Number(l.credit)||0);
      await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [net, l.accountId]);
    }
  }
  return { id: journalId, journalNumber: jNum };
}

async function nextNumber(table, column, prefix) {
  const [last] = await db.query(`SELECT ${column} FROM ${table} ORDER BY created_at DESC LIMIT 1`);
  let num = 1;
  if (last.length && last[0][column]) {
    const m = String(last[0][column]).match(/(\d+)/);
    if (m) num = parseInt(m[1]) + 1;
  }
  return prefix + String(num).padStart(5, '0');
}

// V5.10.3 — Full COA dump for the manual-GL line picker. Returns every
// active leaf account so the bookkeeper can pick any Dr / Cr account
// when creating a voucher with manual posting.
router.get('/gl-accounts-all', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, code, name_ar, type, parent_id, level
       FROM gl_accounts
       WHERE COALESCE(is_active, 1) = 1
       ORDER BY code ASC`);
    res.json(rows.map(r => ({
      id: r.id, code: r.code, nameAr: r.name_ar, type: r.type,
      parentId: r.parent_id, level: Number(r.level) || 0
    })));
  } catch(e) { res.json([]); }
});

// ═══════════════════════════════════════════════════════════════
// V5.9.13 — GL ACCOUNT TREE PICKER (for cash boxes / bank accounts)
//
// Returns active GL accounts under a given root (typically '1101' for
// cash, '1102' for banks) so the cash-box / bank-account create form
// can present an explicit dropdown instead of relying on auto-create.
// ═══════════════════════════════════════════════════════════════
router.get('/gl-accounts-tree', async (req, res) => {
  try {
    const root = String(req.query.root || '1101');
    if (!/^\d{1,4}(?:-\w+)?$/.test(root)) return res.json([]);
    // Return both the root row and any descendant whose code starts with the root.
    // The COA uses a hierarchical text code like 1101-01, 1101-02, …
    const [rows] = await db.query(
      `SELECT id, code, name_ar, type, parent_id, level, is_active
       FROM gl_accounts
       WHERE is_active = 1 AND (code = ? OR code LIKE CONCAT(?, '-%') OR code LIKE CONCAT(?, '%'))
       ORDER BY code ASC`,
      [root, root, root]);
    res.json(rows.map(r => ({
      id: r.id, code: r.code, nameAr: r.name_ar,
      level: Number(r.level)||0, parentId: r.parent_id, type: r.type,
      isLeaf: r.code !== root  // anything below the requested root is selectable
    })));
  } catch(e) { res.json([]); }
});

// ═══════════════════════════════════════════════════════════════
// CASH BOXES
// ═══════════════════════════════════════════════════════════════
router.get('/cash-boxes', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT cb.*, br.name AS branch_name, bd.name AS brand_name,
             ga.code AS gl_code, ga.name_ar AS gl_name
      FROM cash_boxes cb
      LEFT JOIN branches br ON cb.branch_id = br.id
      LEFT JOIN brands bd ON cb.brand_id = bd.id
      LEFT JOIN gl_accounts ga ON cb.gl_account_id = ga.id
      WHERE cb.is_active = 1 ORDER BY cb.name`);
    res.json(rows.map(r => ({
      id: r.id, name: r.name, code: r.code, type: r.type,
      branchId: r.branch_id, branchName: r.branch_name||'',
      brandId: r.brand_id, brandName: r.brand_name||'',
      keeperUsername: r.keeper_username, currency: r.currency,
      balance: Number(r.balance)||0, isActive: !!r.is_active,
      // V5.9.13 — surface the linked GL account so the edit form can preselect it
      glAccountId: r.gl_account_id || '',
      glAccountCode: r.gl_code || '',
      glAccountName: r.gl_name || ''
    })));
  } catch(e) { res.json([]); }
});

router.post('/cash-boxes', async (req, res) => {
  try {
    const { id, name, code, type, branchId, brandId, keeperUsername, currency, glAccountId, username,
            // v5.11.4 — parent-picker payload from the new "add cashbox" modal
            parentGlId, suggestedCode, suggestedLevel } = req.body;
    if (!name) return res.json({ success:false, error: 'الاسم مطلوب' });
    // V5.9.13 — validate the chosen GL account exists and lives under root 1101 (النقدية).
    let glId = null;
    if (glAccountId) {
      const [g] = await db.query('SELECT code FROM gl_accounts WHERE id=? AND is_active=1', [glAccountId]);
      if (!g.length) return res.json({ success:false, error: 'حساب الأستاذ غير موجود' });
      if (g[0].code && !String(g[0].code).startsWith('1101'))
        return res.json({ success:false, error: 'حساب الصندوق يجب أن يكون تحت 1101 (النقدية)' });
      glId = glAccountId;
    }
    // v5.11.4 — when no existing glAccountId is supplied but a parent IS,
    // mint a fresh gl_account beneath it with the user's suggested code.
    else if (parentGlId) {
      try {
        const created = await createGlAccountUnderParent({
          parentId: parentGlId, suggestedCode, suggestedLevel,
          suggestedName: name, type: 'asset', requiredRoot: '1101'
        });
        if (created) glId = created.id;
      } catch (e) {
        return res.json({ success:false, error: e.message });
      }
    }
    if (id) {
      await db.query(
        'UPDATE cash_boxes SET name=?, code=?, type=?, branch_id=?, brand_id=?, keeper_username=?, currency=?, gl_account_id = COALESCE(?, gl_account_id) WHERE id=?',
        [name, code||'', type||'branch', branchId||null, brandId||null, keeperUsername||'', currency||'SAR', glId, id]);
      return res.json({ success:true, id });
    }
    const newId = 'CB-' + Date.now();
    await db.query(
      'INSERT INTO cash_boxes (id, name, code, type, branch_id, brand_id, keeper_username, currency, gl_account_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [newId, name, code||'', type||'branch', branchId||null, brandId||null, keeperUsername||'', currency||'SAR', glId]);
    res.json({ success:true, id: newId });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

router.delete('/cash-boxes/:id', async (req, res) => {
  try { await db.query('UPDATE cash_boxes SET is_active=0 WHERE id=?', [req.params.id]); res.json({success:true}); }
  catch(e) { res.json({success:false, error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
// BANK ACCOUNTS
// ═══════════════════════════════════════════════════════════════
router.get('/bank-accounts', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ba.*, bd.name AS brand_name,
             ga.code AS gl_code, ga.name_ar AS gl_name
      FROM bank_accounts ba
      LEFT JOIN brands bd ON ba.brand_id = bd.id
      LEFT JOIN gl_accounts ga ON ba.gl_account_id = ga.id
      WHERE ba.is_active = 1 ORDER BY ba.bank_name`);
    res.json(rows.map(r => ({
      id: r.id, bankName: r.bank_name, accountName: r.account_name,
      accountNumber: r.account_number, iban: r.iban, currency: r.currency,
      brandId: r.brand_id, brandName: r.brand_name||'',
      balance: Number(r.balance)||0,
      // V5.9.13 — explicit GL link for the picker
      glAccountId: r.gl_account_id || '',
      glAccountCode: r.gl_code || '',
      glAccountName: r.gl_name || ''
    })));
  } catch(e) { res.json([]); }
});

router.post('/bank-accounts', async (req, res) => {
  try {
    const { id, bankName, accountName, accountNumber, iban, currency, brandId, glAccountId,
            parentGlId, suggestedCode, suggestedLevel } = req.body;
    if (!bankName) return res.json({ success:false, error: 'اسم البنك مطلوب' });
    // V5.9.13 — validate GL account is under root 1102 (البنوك)
    let glId = null;
    if (glAccountId) {
      const [g] = await db.query('SELECT code FROM gl_accounts WHERE id=? AND is_active=1', [glAccountId]);
      if (!g.length) return res.json({ success:false, error: 'حساب الأستاذ غير موجود' });
      if (g[0].code && !String(g[0].code).startsWith('1102'))
        return res.json({ success:false, error: 'حساب البنك يجب أن يكون تحت 1102 (البنوك)' });
      glId = glAccountId;
    }
    // v5.11.4 — same parent-picker support for the "add bank" modal
    else if (parentGlId) {
      try {
        const created = await createGlAccountUnderParent({
          parentId: parentGlId, suggestedCode, suggestedLevel,
          suggestedName: bankName, type: 'asset', requiredRoot: '1102'
        });
        if (created) glId = created.id;
      } catch (e) {
        return res.json({ success:false, error: e.message });
      }
    }
    if (id) {
      await db.query(
        'UPDATE bank_accounts SET bank_name=?, account_name=?, account_number=?, iban=?, currency=?, brand_id=?, gl_account_id = COALESCE(?, gl_account_id) WHERE id=?',
        [bankName, accountName||'', accountNumber||'', iban||'', currency||'SAR', brandId||null, glId, id]);
      return res.json({ success:true, id });
    }
    const newId = 'BA-' + Date.now();
    await db.query(
      'INSERT INTO bank_accounts (id, bank_name, account_name, account_number, iban, currency, brand_id, gl_account_id) VALUES (?,?,?,?,?,?,?,?)',
      [newId, bankName, accountName||'', accountNumber||'', iban||'', currency||'SAR', brandId||null, glId]);
    res.json({ success:true, id: newId });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

router.delete('/bank-accounts/:id', async (req, res) => {
  try { await db.query('UPDATE bank_accounts SET is_active=0 WHERE id=?', [req.params.id]); res.json({success:true}); }
  catch(e) { res.json({success:false, error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
// RECEIPTS (سندات القبض)
// ═══════════════════════════════════════════════════════════════
router.get('/receipts', async (req, res) => {
  try {
    const { from, to, source_type } = req.query;
    // V5.10.3 — JOIN users for the creator/approver display name + a hasManualGl flag
    let sql = `
      SELECT r.*,
             COALESCE(uc.full_name, uc.username, r.created_by)  AS created_by_name,
             COALESCE(ua.full_name, ua.username, r.approved_by) AS approved_by_name
      FROM cash_receipts r
      LEFT JOIN users uc ON uc.username = r.created_by
      LEFT JOIN users ua ON ua.username = r.approved_by
      WHERE 1=1`;
    const params = [];
    if (from) { sql += ' AND r.receipt_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND r.receipt_date <= ?'; params.push(to); }
    if (source_type) { sql += ' AND r.source_type = ?'; params.push(source_type); }
    sql += ' ORDER BY r.receipt_date DESC, r.created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, receiptNumber: r.receipt_number, receiptDate: r.receipt_date,
      destinationType: r.destination_type, destinationId: r.destination_id,
      sourceType: r.source_type, sourceId: r.source_id, sourceName: r.source_name,
      amount: Number(r.amount)||0, reference: r.reference, description: r.description,
      status: r.status, journalId: r.journal_id,
      createdBy: r.created_by, createdByName: r.created_by_name || r.created_by || '',
      approvedBy: r.approved_by, approvedByName: r.approved_by_name || r.approved_by || '',
      approvedAt: r.approved_at, createdAt: r.created_at,
      hasManualGl: !!r.manual_gl_lines
    })));
  } catch(e) { res.json([]); }
});

// V5.9.14 — Helper: resolve which source GL account a receipt should credit
// based on its source_type. Reused by POST /receipts (draft persist) and
// POST /receipts/:id/approve (GL posting).
async function _receiptSourceGl(sourceType) {
  let code = '4203', name = 'إيرادات أخرى';
  if (sourceType === 'customer') { code = '1125'; name = 'حسابات العملاء'; }
  else if (sourceType === 'employee') { code = '1130'; name = 'سلف الموظفين'; }
  else if (sourceType === 'rent')     { code = '4202'; name = 'إيرادات إيجارات'; }
  else if (sourceType === 'sales')    { code = '4101'; name = 'المبيعات'; }
  let [r] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  let id;
  if (r.length) id = r[0].id;
  else {
    id = 'GL-' + code;
    const parentCode = code[0] === '1' ? '11' : '4';
    const type = code[0] === '1' ? 'asset' : 'revenue';
    const [p] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [parentCode]);
    await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [id, code, name, type, p.length ? p[0].id : null, 3]);
  }
  return { id, code, name };
}

// V5.10.3 — Validate manual GL lines (when the bookkeeper hand-picks Dr/Cr).
// Lines must balance to the voucher amount and reference real GL accounts.
async function _validateManualGlLines(lines, expectedAmount) {
  if (!Array.isArray(lines) || lines.length === 0) return null; // empty → fall back to auto-routing
  let totalDr = 0, totalCr = 0;
  for (const l of lines) {
    if (!l.accountId) return { error: 'كل سطر يحتاج حساباً من شجرة الحسابات' };
    const [g] = await db.query('SELECT id FROM gl_accounts WHERE id=? AND is_active=1', [l.accountId]);
    if (!g.length) return { error: 'حساب غير موجود في شجرة الحسابات: ' + l.accountId };
    totalDr += Number(l.debit) || 0;
    totalCr += Number(l.credit) || 0;
  }
  if (Math.abs(totalDr - totalCr) > 0.01) return { error: 'القيد غير متوازن: مدين=' + totalDr.toFixed(2) + ' دائن=' + totalCr.toFixed(2) };
  if (expectedAmount && Math.abs(totalDr - Number(expectedAmount)) > 0.01) {
    return { error: 'إجمالي القيد (' + totalDr.toFixed(2) + ') لا يطابق مبلغ السند (' + Number(expectedAmount).toFixed(2) + ')' };
  }
  return null;
}

// V5.9.14 — Receipt creation now persists as DRAFT only — no GL journal,
// no balance update. The user must explicitly approve the receipt to post
// the journal and credit the destination account. Old behavior posted
// instantly which let unreviewed receipts hit the books.
// V5.10.3 — Optionally accepts `manualGlLines` (array of {accountId, debit,
// credit, description}) which overrides the auto-routed contra account at
// approval time. Lets the user hand-pick Dr / Cr from the COA tree.
router.post('/receipts', async (req, res) => {
  try {
    const { receiptDate, destinationType, destinationId, sourceType, sourceId, sourceName, amount, reference, description, username, manualGlLines,
            // v5.11.4 — accounting dimensions captured at the voucher header
            brandId, branchId, costCenterId, projectId } = req.body;
    if (!amount || !destinationId || !destinationType) return res.json({ success:false, error: 'البيانات ناقصة' });
    const destTable = destinationType === 'cash' ? 'cash_boxes' : 'bank_accounts';
    const [chk] = await db.query('SELECT id FROM ' + destTable + ' WHERE id=? AND is_active=1', [destinationId]);
    if (!chk.length) return res.json({ success:false, error: 'الجهة المُستلِمة غير موجودة' });

    // V5.10.3 — validate manual GL lines if provided
    if (manualGlLines && Array.isArray(manualGlLines) && manualGlLines.length) {
      const err = await _validateManualGlLines(manualGlLines, amount);
      if (err) return res.json({ success:false, error: err.error });
    }

    const number = await nextNumber('cash_receipts', 'receipt_number', 'REC-');
    const id = 'REC-' + Date.now();
    // v5.11.4 — wide insert that also writes the dims; if the migration
    // hasn't run yet, fall back to the legacy column set.
    try {
      await db.query(
        `INSERT INTO cash_receipts (id, receipt_number, receipt_date, destination_type, destination_id, source_type, source_id, source_name, amount, reference, description, status, created_by, manual_gl_lines, brand_id, branch_id, cost_center_id, project_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?, ?, ?, ?)`,
        [id, number, receiptDate, destinationType, destinationId, sourceType||'other', sourceId||null, sourceName||'', amount, reference||'', description||'', username||'',
         manualGlLines && manualGlLines.length ? JSON.stringify(manualGlLines) : null,
         brandId||null, branchId||null, costCenterId||null, projectId||null]);
    } catch (e) {
      await db.query(
        `INSERT INTO cash_receipts (id, receipt_number, receipt_date, destination_type, destination_id, source_type, source_id, source_name, amount, reference, description, status, created_by, manual_gl_lines)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`,
        [id, number, receiptDate, destinationType, destinationId, sourceType||'other', sourceId||null, sourceName||'', amount, reference||'', description||'', username||'',
         manualGlLines && manualGlLines.length ? JSON.stringify(manualGlLines) : null]);
    }
    res.json({ success:true, id, number, status:'draft' });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// V5.9.14 — Approve a draft receipt: posts the GL journal and updates the
// destination balance. Idempotent (refuses to re-post a posted receipt).
// V5.10.3 — When manual_gl_lines is set on the row, posts that exact journal
// instead of the auto-routed Dr destination / Cr source contra. The lines
// are already validated at create time.
router.post('/receipts/:id/approve', requireCapability('finance.cash.approve'), async (req, res) => {
  try {
    const id = req.params.id;
    const username = _actor(req); // FC-P1b — actor from JWT, not body
    // FC-P1b — claim the voucher under a row lock so two concurrent approves
    // can never both post a journal / double the cashbox balance.
    const out = await db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM cash_receipts WHERE id=? FOR UPDATE', [id]);
    if (!rows.length) return { error: 'السند غير موجود' };
    const r = rows[0];
    if (r.status !== 'draft') return { error: 'السند غير قابل للاعتماد (الحالة: ' + r.status + ')' };

    let lines;
    if (r.manual_gl_lines) {
      // Use the bookkeeper's manual journal — re-resolve account names from the COA.
      let parsed = [];
      try { parsed = JSON.parse(r.manual_gl_lines); } catch(_) {}
      lines = [];
      for (const l of parsed) {
        const [g] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE id=?', [l.accountId]);
        if (!g.length) continue;
        lines.push({
          accountId: g[0].id, accountCode: g[0].code, accountName: g[0].name_ar,
          debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
          description: l.description || ''
        });
      }
      if (!lines.length) return { error: 'القيد اليدوي فارغ — راجع الأسطر' };
    } else {
      const destAcc = await getSourceAccount(r.destination_type, r.destination_id);
      const src = await _receiptSourceGl(r.source_type);
      lines = [
        { accountId: destAcc.glId, accountCode: destAcc.code, accountName: destAcc.name, debit: r.amount, credit: 0 },
        { accountId: src.id,       accountCode: src.code,    accountName: src.name,    debit: 0, credit: r.amount }
      ];
    }

    // v5.11.4 — pass voucher dims into the journal so reports sliced by
    // brand/branch/cost-center/project pick up cash receipts.
    const journal = await createJournal(r.receipt_date,
      'سند قبض ' + r.receipt_number + ' — ' + (r.source_name || ''),
      lines, username, {
        brandId: r.brand_id || null,
        branchId: r.branch_id || null,
        costCenterId: r.cost_center_id || null,
        projectId: r.project_id || null
      });
    await conn.query('UPDATE cash_receipts SET status=?, journal_id=?, approved_by=?, approved_at=NOW() WHERE id=?',
      ['posted', journal.id, username, id]);
    if (r.destination_type === 'cash') await conn.query('UPDATE cash_boxes SET balance = balance + ? WHERE id = ?', [r.amount, r.destination_id]);
    else                               await conn.query('UPDATE bank_accounts SET balance = balance + ? WHERE id = ?', [r.amount, r.destination_id]);
    return { journal };
    });
    if (out.error) return res.json({ success:false, error: out.error });
    res.json({ success:true, journalId: out.journal.id, journalNumber: out.journal.journalNumber });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// V5.9.14 — Cancel a draft receipt (refuses if posted — needs a reversal journal)
router.post('/receipts/:id/cancel', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query('SELECT status FROM cash_receipts WHERE id=?', [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    if (rows[0].status === 'posted') return res.json({ success:false, error:'لا يمكن إلغاء سند مُرحَّل — أعكسه بقيد مضاد' });
    if (rows[0].status === 'cancelled') return res.json({ success:false, error:'السند ملغى مسبقاً' });
    await db.query('UPDATE cash_receipts SET status=? WHERE id=?', ['cancelled', id]);
    res.json({ success:true });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// V5.9.14 — Print data: the row + linked accounts + company settings, in one
// round-trip so the e-voucher template doesn't need parallel fetches.
// V5.10.3 — Also resolves the linked customer name (when source_id matches)
// and parses manual_gl_lines into a structured array for the print template.
router.get('/receipts/:id/print-data', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query(`
      SELECT r.*,
             COALESCE(cb.name, ba.bank_name) AS dest_name,
             COALESCE(cb.code, ba.account_number) AS dest_code,
             ga.code AS dest_gl_code, ga.name_ar AS dest_gl_name,
             jr.journal_number,
             COALESCE(uc.full_name, uc.username, r.created_by) AS created_by_name,
             COALESCE(ua.full_name, ua.username, r.approved_by) AS approved_by_name,
             cust.name AS customer_name
      FROM cash_receipts r
      LEFT JOIN cash_boxes cb ON r.destination_type='cash' AND r.destination_id=cb.id
      LEFT JOIN bank_accounts ba ON r.destination_type='bank' AND r.destination_id=ba.id
      LEFT JOIN gl_accounts ga ON ga.id = COALESCE(cb.gl_account_id, ba.gl_account_id)
      LEFT JOIN gl_journals jr ON jr.id = r.journal_id
      LEFT JOIN users uc ON uc.username = r.created_by
      LEFT JOIN users ua ON ua.username = r.approved_by
      LEFT JOIN customers cust ON cust.id = r.source_id AND r.source_type='customer'
      WHERE r.id=?`, [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    const r = rows[0];
    // Parse manual GL lines for the print template
    let manualLines = null;
    if (r.manual_gl_lines) {
      try {
        const parsed = JSON.parse(r.manual_gl_lines);
        if (Array.isArray(parsed) && parsed.length) {
          // Enrich with code/name from gl_accounts
          const ids = parsed.map(l => l.accountId).filter(Boolean);
          const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
          const [accs] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE id IN (' + placeholders + ')', ids);
          const byId = {}; accs.forEach(a => { byId[a.id] = a; });
          manualLines = parsed.map(l => ({
            accountId: l.accountId,
            accountCode: byId[l.accountId] ? byId[l.accountId].code : '',
            accountName: byId[l.accountId] ? byId[l.accountId].name_ar : '',
            debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
            description: l.description || ''
          }));
        }
      } catch(_) {}
    }
    const [stg] = await db.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyLogo')");
    const cfg = {};
    stg.forEach(s => { cfg[s.setting_key] = s.setting_value; });
    res.json({ success:true, voucher: { ...r, manual_lines: manualLines }, company: cfg });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// PAYMENTS (سندات الصرف)
// ═══════════════════════════════════════════════════════════════
router.get('/payments', async (req, res) => {
  try {
    const { from, to, recipient_type } = req.query;
    let sql = `
      SELECT p.*,
             COALESCE(uc.full_name, uc.username, p.created_by)  AS created_by_name,
             COALESCE(ua.full_name, ua.username, p.approved_by) AS approved_by_name
      FROM cash_payments p
      LEFT JOIN users uc ON uc.username = p.created_by
      LEFT JOIN users ua ON ua.username = p.approved_by
      WHERE 1=1`;
    const params = [];
    if (from) { sql += ' AND p.payment_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND p.payment_date <= ?'; params.push(to); }
    if (recipient_type) { sql += ' AND p.recipient_type = ?'; params.push(recipient_type); }
    sql += ' ORDER BY p.payment_date DESC, p.created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, paymentNumber: r.payment_number, paymentDate: r.payment_date,
      sourceType: r.source_type, sourceId: r.source_id,
      recipientType: r.recipient_type, recipientId: r.recipient_id, recipientName: r.recipient_name,
      amount: Number(r.amount)||0, reference: r.reference, description: r.description,
      status: r.status, journalId: r.journal_id,
      createdBy: r.created_by, createdByName: r.created_by_name || r.created_by || '',
      approvedBy: r.approved_by, approvedByName: r.approved_by_name || r.approved_by || '',
      approvedAt: r.approved_at, createdAt: r.created_at,
      hasManualGl: !!r.manual_gl_lines
    })));
  } catch(e) { res.json([]); }
});

// V5.9.14 — Helper for payment recipient GL account resolution.
async function _paymentRecipientGl(recipientType, expenseAccountId) {
  if (expenseAccountId) {
    const [r] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE id = ?', [expenseAccountId]);
    if (r.length) return { id: r[0].id, code: r[0].code, name: r[0].name_ar };
  }
  let code = '5205', name = 'مصروفات أخرى';
  if (recipientType === 'supplier')      { code = '2101'; name = 'حسابات الموردين'; }
  else if (recipientType === 'employee') { code = '1130'; name = 'سلف الموظفين'; }
  const [r] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  let id;
  if (r.length) id = r[0].id;
  else {
    id = 'GL-' + code;
    const type = recipientType === 'supplier' ? 'liability' : (recipientType === 'employee' ? 'asset' : 'expense');
    const [p] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [code[0]]);
    await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [id, code, name, type, p.length ? p[0].id : null, 3]);
  }
  return { id, code, name };
}

// V5.9.14 — Payment creation persists as DRAFT only — same approval gate
// as receipts. Eliminates instant-post-on-create.
// V5.10.3 — Optionally accepts manualGlLines for bookkeeper-controlled posting.
router.post('/payments', async (req, res) => {
  try {
    const { paymentDate, sourceType, sourceId, recipientType, recipientId, recipientName, expenseAccountId, amount, reference, description, username, manualGlLines,
            brandId, branchId, costCenterId, projectId } = req.body;
    if (!amount || !sourceId || !sourceType) return res.json({ success:false, error: 'البيانات ناقصة' });
    const srcTable = sourceType === 'cash' ? 'cash_boxes' : 'bank_accounts';
    const [chk] = await db.query('SELECT id FROM ' + srcTable + ' WHERE id=? AND is_active=1', [sourceId]);
    if (!chk.length) return res.json({ success:false, error:'الجهة الدافعة غير موجودة' });
    if (manualGlLines && Array.isArray(manualGlLines) && manualGlLines.length) {
      const err = await _validateManualGlLines(manualGlLines, amount);
      if (err) return res.json({ success:false, error: err.error });
    }
    const number = await nextNumber('cash_payments', 'payment_number', 'PAY-');
    const id = 'PAY-' + Date.now();
    // v5.11.4 — same wide-insert with dim columns + legacy fallback
    try {
      await db.query(
        `INSERT INTO cash_payments (id, payment_number, payment_date, source_type, source_id, recipient_type, recipient_id, recipient_name, expense_account_id, amount, reference, description, status, created_by, manual_gl_lines, brand_id, branch_id, cost_center_id, project_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?, ?, ?, ?)`,
        [id, number, paymentDate, sourceType, sourceId, recipientType||'other', recipientId||null, recipientName||'', expenseAccountId||null, amount, reference||'', description||'', username||'',
         manualGlLines && manualGlLines.length ? JSON.stringify(manualGlLines) : null,
         brandId||null, branchId||null, costCenterId||null, projectId||null]);
    } catch (e) {
      await db.query(
        `INSERT INTO cash_payments (id, payment_number, payment_date, source_type, source_id, recipient_type, recipient_id, recipient_name, expense_account_id, amount, reference, description, status, created_by, manual_gl_lines)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`,
        [id, number, paymentDate, sourceType, sourceId, recipientType||'other', recipientId||null, recipientName||'', expenseAccountId||null, amount, reference||'', description||'', username||'',
         manualGlLines && manualGlLines.length ? JSON.stringify(manualGlLines) : null]);
    }
    res.json({ success:true, id, number, status:'draft' });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// V5.9.14 — Approve a draft payment: posts the GL journal and decrements
// the source balance.
// V5.10.3 — Honors manual_gl_lines override (same as receipt approval).
router.post('/payments/:id/approve', requireCapability('finance.cash.approve'), async (req, res) => {
  try {
    const id = req.params.id;
    const username = _actor(req); // FC-P1b — actor from JWT, not body
    // FC-P1b — claim the voucher under a row lock (double-approve safe).
    const out = await db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM cash_payments WHERE id=? FOR UPDATE', [id]);
    if (!rows.length) return { error: 'السند غير موجود' };
    const p = rows[0];
    if (p.status !== 'draft') return { error: 'السند غير قابل للاعتماد (الحالة: ' + p.status + ')' };

    let lines;
    if (p.manual_gl_lines) {
      let parsed = [];
      try { parsed = JSON.parse(p.manual_gl_lines); } catch(_) {}
      lines = [];
      for (const l of parsed) {
        const [g] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE id=?', [l.accountId]);
        if (!g.length) continue;
        lines.push({
          accountId: g[0].id, accountCode: g[0].code, accountName: g[0].name_ar,
          debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
          description: l.description || ''
        });
      }
      if (!lines.length) return { error: 'القيد اليدوي فارغ — راجع الأسطر' };
    } else {
      const srcAcc = await getSourceAccount(p.source_type, p.source_id);
      const recip = await _paymentRecipientGl(p.recipient_type, p.expense_account_id);
      lines = [
        { accountId: recip.id,    accountCode: recip.code,    accountName: recip.name,    debit: p.amount, credit: 0 },
        { accountId: srcAcc.glId, accountCode: srcAcc.code,   accountName: srcAcc.name,   debit: 0, credit: p.amount }
      ];
    }

    // v5.11.4 — pass voucher dims into the journal
    const journal = await createJournal(p.payment_date,
      'سند صرف ' + p.payment_number + ' — ' + (p.recipient_name || ''),
      lines, username, {
        brandId: p.brand_id || null,
        branchId: p.branch_id || null,
        costCenterId: p.cost_center_id || null,
        projectId: p.project_id || null
      });
    await conn.query('UPDATE cash_payments SET status=?, journal_id=?, approved_by=?, approved_at=NOW() WHERE id=?',
      ['posted', journal.id, username, id]);
    if (p.source_type === 'cash') await conn.query('UPDATE cash_boxes SET balance = balance - ? WHERE id = ?', [p.amount, p.source_id]);
    else                          await conn.query('UPDATE bank_accounts SET balance = balance - ? WHERE id = ?', [p.amount, p.source_id]);
    return { journal };
    });
    if (out.error) return res.json({ success:false, error: out.error });
    res.json({ success:true, journalId: out.journal.id, journalNumber: out.journal.journalNumber });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

router.post('/payments/:id/cancel', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query('SELECT status FROM cash_payments WHERE id=?', [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    if (rows[0].status === 'posted') return res.json({ success:false, error:'لا يمكن إلغاء سند مُرحَّل — أعكسه بقيد مضاد' });
    if (rows[0].status === 'cancelled') return res.json({ success:false, error:'السند ملغى مسبقاً' });
    await db.query('UPDATE cash_payments SET status=? WHERE id=?', ['cancelled', id]);
    res.json({ success:true });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

router.get('/payments/:id/print-data', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query(`
      SELECT p.*,
             COALESCE(cb.name, ba.bank_name) AS src_name,
             COALESCE(cb.code, ba.account_number) AS src_code,
             ga.code AS src_gl_code, ga.name_ar AS src_gl_name,
             jr.journal_number,
             COALESCE(uc.full_name, uc.username, p.created_by) AS created_by_name,
             COALESCE(ua.full_name, ua.username, p.approved_by) AS approved_by_name,
             sup.name AS supplier_name
      FROM cash_payments p
      LEFT JOIN cash_boxes cb ON p.source_type='cash' AND p.source_id=cb.id
      LEFT JOIN bank_accounts ba ON p.source_type='bank' AND p.source_id=ba.id
      LEFT JOIN gl_accounts ga ON ga.id = COALESCE(cb.gl_account_id, ba.gl_account_id)
      LEFT JOIN gl_journals jr ON jr.id = p.journal_id
      LEFT JOIN users uc ON uc.username = p.created_by
      LEFT JOIN users ua ON ua.username = p.approved_by
      LEFT JOIN suppliers sup ON sup.id = p.recipient_id AND p.recipient_type='supplier'
      WHERE p.id=?`, [id]);
    if (!rows.length) return res.json({ success:false, error:'السند غير موجود' });
    const r = rows[0];
    let manualLines = null;
    if (r.manual_gl_lines) {
      try {
        const parsed = JSON.parse(r.manual_gl_lines);
        if (Array.isArray(parsed) && parsed.length) {
          const ids = parsed.map(l => l.accountId).filter(Boolean);
          const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
          const [accs] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE id IN (' + placeholders + ')', ids);
          const byId = {}; accs.forEach(a => { byId[a.id] = a; });
          manualLines = parsed.map(l => ({
            accountId: l.accountId,
            accountCode: byId[l.accountId] ? byId[l.accountId].code : '',
            accountName: byId[l.accountId] ? byId[l.accountId].name_ar : '',
            debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
            description: l.description || ''
          }));
        }
      } catch(_) {}
    }
    const [stg] = await db.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyLogo')");
    const cfg = {};
    stg.forEach(s => { cfg[s.setting_key] = s.setting_value; });
    res.json({ success:true, voucher: { ...r, manual_lines: manualLines }, company: cfg });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// TRANSFERS (تحويلات بين الصناديق والبنوك)
// ═══════════════════════════════════════════════════════════════
router.get('/transfers', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM cash_transfers ORDER BY transfer_date DESC LIMIT 200');
    res.json(rows);
  } catch(e) { res.json([]); }
});

router.post('/transfers', async (req, res) => {
  try {
    const { transferDate, fromType, fromId, toType, toId, amount, description, username } = req.body;
    if (!amount || !fromId || !toId) return res.json({ success:false, error: 'البيانات ناقصة' });
    if (fromType === toType && fromId === toId) return res.json({ success:false, error: 'لا يمكن التحويل لنفس الحساب' });
    const fromAcc = await getSourceAccount(fromType, fromId);
    const toAcc = await getSourceAccount(toType, toId);
    const number = await nextNumber('cash_transfers', 'transfer_number', 'TRF-');
    const id = 'TRF-' + Date.now();

    const journal = await createJournal(transferDate, 'تحويل ' + number + ' من ' + fromAcc.name + ' إلى ' + toAcc.name, [
      { accountId: toAcc.glId, accountCode: toAcc.code, accountName: toAcc.name, debit: amount, credit: 0 },
      { accountId: fromAcc.glId, accountCode: fromAcc.code, accountName: fromAcc.name, debit: 0, credit: amount }
    ], username);

    await db.query(
      `INSERT INTO cash_transfers (id, transfer_number, transfer_date, from_type, from_id, to_type, to_id, amount, description, journal_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, number, transferDate, fromType, fromId, toType, toId, amount, description||'', journal.id, username||'']);

    // Update balances
    if (fromType === 'cash') await db.query('UPDATE cash_boxes SET balance = balance - ? WHERE id = ?', [amount, fromId]);
    else await db.query('UPDATE bank_accounts SET balance = balance - ? WHERE id = ?', [amount, fromId]);
    if (toType === 'cash') await db.query('UPDATE cash_boxes SET balance = balance + ? WHERE id = ?', [amount, toId]);
    else await db.query('UPDATE bank_accounts SET balance = balance + ? WHERE id = ?', [amount, toId]);

    res.json({ success:true, id, number, journalNumber: journal.journalNumber });
  } catch(e) { res.json({ success:false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CASH SUMMARY (for dashboard)
// ═══════════════════════════════════════════════════════════════
router.get('/summary', async (req, res) => {
  try {
    const [cash] = await db.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(balance),0) AS total FROM cash_boxes WHERE is_active=1');
    const [bank] = await db.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(balance),0) AS total FROM bank_accounts WHERE is_active=1');
    const today = new Date().toISOString().slice(0,10);
    const [monthStart] = [today.slice(0,7) + '-01'];
    let rcpt = 0, pay = 0;
    try {
      const [r] = await db.query('SELECT COALESCE(SUM(amount),0) AS t FROM cash_receipts WHERE receipt_date >= ?', [monthStart]);
      rcpt = Number(r[0].t)||0;
    } catch(e) {}
    try {
      const [r] = await db.query('SELECT COALESCE(SUM(amount),0) AS t FROM cash_payments WHERE payment_date >= ?', [monthStart]);
      pay = Number(r[0].t)||0;
    } catch(e) {}
    res.json({
      cashBoxCount: cash[0].cnt, cashTotal: Number(cash[0].total)||0,
      bankCount: bank[0].cnt, bankTotal: Number(bank[0].total)||0,
      monthReceipts: rcpt, monthPayments: pay,
      grandTotal: (Number(cash[0].total)||0) + (Number(bank[0].total)||0)
    });
  } catch(e) { res.json({ cashBoxCount:0, cashTotal:0, bankCount:0, bankTotal:0, monthReceipts:0, monthPayments:0, grandTotal:0 }); }
});

module.exports = router;
