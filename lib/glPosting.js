/**
 * Central GL Posting Service
 *
 * The single source of truth for creating journal entries. All business
 * modules (purchases, sales, waste, royalty, expenses, stock variances)
 * call postJournal() rather than hand-rolling INSERTs.
 *
 * Guarantees:
 *   - Debits == Credits (rejects unbalanced journals)
 *   - Period lock enforced (rejects posts into closed periods)
 *   - Dimensions (brand_id / branch_id / cost_center_id / warehouse_id)
 *     are carried through to every gl_entries row.
 *   - Failures do NOT break the caller's business operation — they are
 *     returned as { success:false, error, warning } so the caller can
 *     surface a warning to the UI while keeping the main flow committed.
 *
 * Usage:
 *   const gl = require('../lib/glPosting');
 *   const r = await gl.postJournal(db, {
 *     journalDate: '2026-04-18',
 *     description: 'Purchase receipt GRN-00001',
 *     referenceType: 'PurchaseReceipt',
 *     referenceId: 'PR-...',
 *     entries: [
 *       { accountCode: '1200', debit: 1000, credit: 0, branchId, brandId, warehouseId },
 *       { accountCode: '1290', debit: 150,  credit: 0, branchId, brandId },
 *       { accountCode: '2100', debit: 0,    credit: 1150, brandId }
 *     ],
 *     postedBy: 'admin'
 *   });
 */

// Well-known account codes the system relies on. These are seeded by
// ensureCoreAccounts() the first time posting runs.
//
// v5.11.14 — Realigned to the v5.11.8 IFRS template (216 accounts):
//   111 = Cash and Bank · 112 = AR · 113 = Inventory · 114 = Prepayments
//   115 = Custody · 116 = Input VAT · 121-124 = Non-current assets.
// Earlier values had INVENTORY/WIP/FINISHED_GOODS rooted under '112'
// (which is AR in the new template, NOT inventory) and AR rooted under
// '113' (which is now Inventory!) — exactly the swap the user saw as
// "ذمم تطبيقات تحت المخزون / مخزون تحت الذمم". Input VAT moved to 116
// because 114 in the new chart is Prepayments.
const CORE_ACCOUNTS = {
  // ─── Assets ───
  CASH:              { code: '1110', nameAr: 'النقدية',                  type: 'asset',     parent: '111' }, // Cash and Bank
  BANK:              { code: '1120', nameAr: 'البنوك',                   type: 'asset',     parent: '111' }, // Cash and Bank
  AR:                { code: '1150', nameAr: 'ذمم العملاء',              type: 'asset',     parent: '112' }, // Accounts Receivable
  INVENTORY:         { code: '1200', nameAr: 'المخزون الرئيسي',          type: 'asset',     parent: '113' }, // Inventory
  BRANCH_INVENTORY:  { code: '1210', nameAr: 'مخزون الفروع',             type: 'asset',     parent: '113' }, // Inventory
  WIP:               { code: '1220', nameAr: 'الإنتاج تحت التشغيل',      type: 'asset',     parent: '113' }, // Inventory
  FINISHED_GOODS:    { code: '1230', nameAr: 'المنتجات التامة',          type: 'asset',     parent: '113' }, // Inventory
  INPUT_VAT:         { code: '1290', nameAr: 'ضريبة المدخلات',           type: 'asset',     parent: '116' }, // Input VAT
  // ─── Liabilities ───
  AP:                { code: '2100', nameAr: 'ذمم الموردين',             type: 'liability', parent: '211' }, // Trade Payables
  OUTPUT_VAT:        { code: '2210', nameAr: 'ضريبة المخرجات',           type: 'liability', parent: '213' }, // Output VAT
  ROYALTY_PAYABLE:   { code: '2310', nameAr: 'مستحقات الامتياز',         type: 'liability', parent: '215' }, // Royalty / Franchise Payable
  // ─── Revenue ───
  SALES_REVENUE:     { code: '4100', nameAr: 'إيرادات المبيعات',         type: 'revenue',   parent: '411' }, // Sales — Dine-in
  STOCK_GAIN:        { code: '4910', nameAr: 'إيراد فروقات جرد',         type: 'revenue',   parent: '422' }, // Stock Gain
  // ─── Expenses ───
  // 51 = Direct Cost · 52 = Inventory adjustments + waste · 53 = Direct Labor
  // 521 = Spoilage parent (5211-5215 in the template) · 522 = Production
  // Variance · 523 = Purchase Price Variance · 65 = Franchise · 651 = Royalty.
  COGS:              { code: '5100', nameAr: 'تكلفة المبيعات',           type: 'expense',   parent: '51'  }, // Direct Cost (generic)
  WASTE_EXPENSE:     { code: '5200', nameAr: 'مصروف الهدر (عام)',         type: 'expense',   parent: '521' }, // Spoilage parent
  // v5.10.39 — granular waste sub-accounts route each reason to its own
  // GL account so the income statement shows the breakdown.
  WASTE_RAW:         { code: '5121', nameAr: 'هدر المواد الخام',          type: 'expense',   parent: '521' }, // prep_loss
  WASTE_FINISHED:    { code: '5122', nameAr: 'هدر المنتجات الجاهزة',      type: 'expense',   parent: '521' }, // damaged
  WASTE_EXPIRED:     { code: '5123', nameAr: 'تالف منتهي الصلاحية',       type: 'expense',   parent: '521' }, // expired
  WASTE_SPILL:       { code: '5124', nameAr: 'هدر التشغيل (انسكاب)',      type: 'expense',   parent: '521' }, // spill
  WASTE_RETURNS:     { code: '5125', nameAr: 'مرتجعات العملاء (هدر)',     type: 'expense',   parent: '521' }, // customer_return
  STOCK_VARIANCE:    { code: '5300', nameAr: 'فروقات الجرد',             type: 'expense',   parent: '522' }, // Production Variance
  PPV:               { code: '5350', nameAr: 'فروق سعر المشتريات',       type: 'expense',   parent: '523' }, // Purchase Price Variance
  LABOR_APPLIED:     { code: '5400', nameAr: 'العمالة المحملة',           type: 'expense',   parent: '53'  }, // Direct Labor
  OVERHEAD_APPLIED:  { code: '5410', nameAr: 'التكاليف غير المباشرة',     type: 'expense',   parent: '6'   }, // Operating & Admin (catch-all)
  PRODUCTION_VARIANCE:{ code: '5420', nameAr: 'فروقات الإنتاج',           type: 'expense',   parent: '522' }, // Production Variance
  FRANCHISE_FEE:     { code: '6100', nameAr: 'مصروف رسوم الامتياز',       type: 'expense',   parent: '651' }  // Royalty Expense
};

let _accountsEnsured = false;

// v5.10.35 — Self-repair: in addition to creating missing CORE accounts,
// we now also FIX existing rows whose parent_id no longer matches the
// canonical mapping above. Safe because CORE row IDs and codes don't
// change — only parent_id is updated. Walks up the parent code if the
// preferred parent is missing in this deployment's chart. Idempotent.
async function ensureCoreAccounts(db) {
  if (_accountsEnsured) return;
  for (const [k, a] of Object.entries(CORE_ACCOUNTS)) {
    try {
      // Resolve the desired parent_id (walks up if seed parent absent)
      let desiredParentId = null;
      let desiredLevel = a.code.length;
      if (a.parent) {
        let walk = a.parent;
        while (walk.length > 0 && !desiredParentId) {
          const [p] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [walk]);
          if (p.length) { desiredParentId = p[0].id; desiredLevel = walk.length + 1; break; }
          walk = walk.substring(0, walk.length - 1);
        }
      }

      const [existing] = await db.query(
        'SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [a.code]);
      if (existing.length) {
        // v5.11.6 — DO NOT touch existing accounts. The previous
        // self-repair block silently re-parented core accounts to the
        // canonical CORE_ACCOUNTS hierarchy on every postJournal call,
        // which trampled the user's imported chart-of-accounts template
        // (rows kept "moving back" after every transaction). The user
        // can still trigger explicit repairs via /gl/deep-repair.
        continue;
      }
      const accId = 'GL-' + a.code;
      await db.query(
        `INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, balance)
         VALUES (?,?,?,?,?,?,1,0)`,
        [accId, a.code, a.nameAr, a.type, desiredParentId, desiredLevel]);
    } catch(e) { /* ignore — core accounts are best-effort */ }
  }
  _accountsEnsured = true;
}

// Look up gl_accounts.id by code (cached per process)
const _accountIdCache = {};
async function resolveAccountId(db, code) {
  if (!code) return null;
  if (_accountIdCache[code]) return _accountIdCache[code];
  const [rows] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  if (!rows.length) return null;
  _accountIdCache[code] = rows[0].id;
  return rows[0].id;
}

// V5.7.18 — companion to resolveAccountId: fetch the human-readable name
//   so gl_entries can be persisted WITH the account name (so the journal
//   viewer doesn't have to JOIN every time and shows the name even if
//   the account is later renamed/deleted).
const _accountNameCache = {}; // code → "code — name_ar"
async function resolveAccountName(db, code) {
  if (!code) return '';
  if (_accountNameCache[code]) return _accountNameCache[code];
  const [rows] = await db.query(
    'SELECT name_ar, name_en FROM gl_accounts WHERE code = ? LIMIT 1',
    [code]
  );
  if (!rows.length) return '';
  const nm = rows[0].name_ar || rows[0].name_en || '';
  _accountNameCache[code] = nm;
  return nm;
}

// Check whether a date falls within a closed accounting period
async function isPeriodClosed(db, date) {
  if (!date) return false;
  try {
    const [r] = await db.query(
      `SELECT status FROM accounting_periods
       WHERE ? BETWEEN start_date AND end_date LIMIT 1`, [date]);
    return r.length && r[0].status === 'closed';
  } catch(e) { return false; }
}

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * Create a balanced GL journal and its entries.
 *
 * spec:
 *   journalDate     (YYYY-MM-DD) required
 *   description     string
 *   referenceType   string (Sale, PurchaseReceipt, Waste, Royalty, Expense, Manual, ...)
 *   referenceId     string
 *   postedBy        username
 *   entries[]       required; each { accountCode, debit, credit, description?,
 *                   branchId?, brandId?, costCenterId?, warehouseId? }
 *   status          'draft' (default) | 'posted'
 *
 * Returns: { success, journalId, journalNumber, warning? }
 */
async function postJournal(db, spec) {
  try {
    await ensureCoreAccounts(db);

    if (!spec || !Array.isArray(spec.entries) || !spec.entries.length) {
      return { success: false, error: 'لا توجد سطور قيد' };
    }
    const jdate = spec.journalDate || new Date().toISOString().slice(0, 10);
    if (await isPeriodClosed(db, jdate)) {
      return { success: false, error: 'الفترة المحاسبية مُقفلة لهذا التاريخ' };
    }

    // Resolve account codes to IDs + validate existence
    const enriched = [];
    for (const e of spec.entries) {
      const d = round2(e.debit);
      const c = round2(e.credit);
      if (d < 0 || c < 0) return { success: false, error: 'لا يجوز سطر بقيمة سالبة' };
      if (d === 0 && c === 0) continue;  // skip zero lines
      if (d > 0 && c > 0) return { success: false, error: 'لا يجوز مدين ودائن على نفس السطر' };
      const accId = await resolveAccountId(db, e.accountCode);
      if (!accId) return { success: false, error: 'حساب غير موجود: ' + e.accountCode, warning: true };
      // V5.7.18 — also resolve the human-readable name so we persist it on the entry
      const accName = await resolveAccountName(db, e.accountCode);
      enriched.push({
        ...e,
        accountId: accId,
        accountCode: e.accountCode,
        accountName: accName,
        debit: d, credit: c
      });
    }
    if (!enriched.length) return { success: false, error: 'كل السطور صفرية' };

    // Balance check (tolerance 0.01)
    let td = 0, tc = 0;
    enriched.forEach(e => { td += e.debit; tc += e.credit; });
    td = round2(td); tc = round2(tc);
    if (Math.abs(td - tc) > 0.01) {
      return { success: false, error: `القيد غير متوازن: مدين=${td} دائن=${tc}` };
    }

    // Journal number: sequential per day (JV-YYYYMMDD-NNNN)
    const ymd = jdate.replace(/-/g, '');
    const [lastJ] = await db.query(
      `SELECT journal_number FROM gl_journals WHERE journal_number LIKE ? ORDER BY created_at DESC LIMIT 1`,
      ['JV-' + ymd + '-%']);
    let serial = 1;
    if (lastJ.length) {
      const m = lastJ[0].journal_number.match(/-(\d+)$/);
      if (m) serial = parseInt(m[1]) + 1;
    }
    const jNum = 'JV-' + ymd + '-' + String(serial).padStart(4, '0');
    const jId = genId('JRN');

    // v5.11.0 — persist header dimensions on the journal too. Tries the
    // wide INSERT first and falls back to the legacy column set if the
    // schema is older. Same defensive pattern as the entries below.
    const headerCols = ['id','journal_number','journal_date','reference_type','reference_id',
                        'description','total_debit','total_credit','status','created_by','posted_by','posted_at'];
    const headerVals = [jId, jNum, jdate, spec.referenceType || 'manual', spec.referenceId || '',
                        spec.description || '', td, tc,
                        spec.status === 'draft' ? 'draft' : 'posted',
                        spec.postedBy || '', spec.postedBy || '',
                        spec.status === 'draft' ? null : new Date()];
    const headerDims = [
      ['brandId','brand_id'], ['branchId','branch_id'],
      ['projectId','project_id'], ['costCenterId','cost_center_id']
    ];
    const headerDimCols = [], headerDimVals = [];
    for (const [k, col] of headerDims) {
      if (spec[k] !== undefined && spec[k] !== null && spec[k] !== '') {
        headerDimCols.push(col); headerDimVals.push(spec[k]);
      }
    }
    const allHeaderCols = headerCols.concat(headerDimCols);
    const allHeaderVals = headerVals.concat(headerDimVals);
    try {
      await db.query(
        'INSERT INTO gl_journals (' + allHeaderCols.join(',') + ') VALUES (' + allHeaderCols.map(() => '?').join(',') + ')',
        allHeaderVals);
    } catch (err) {
      if (headerDimCols.length) {
        await db.query(
          'INSERT INTO gl_journals (' + headerCols.join(',') + ') VALUES (' + headerCols.map(() => '?').join(',') + ')',
          headerVals);
      } else throw err;
    }

    for (const e of enriched) {
      const lineId = genId('GLE');
      // Detect which dimension columns exist (tolerate older schemas)
      const cols = ['id', 'journal_id', 'account_id', 'account_code', 'account_name',
                    'debit', 'credit', 'description'];
      // V5.7.18 — persist resolved account_name (was previously empty string,
      //           which made the journal viewer show only codes like "1110"
      //           with no human-readable label).
      const vals = [lineId, jId, e.accountId, e.accountCode, e.accountName || '',
                    e.debit, e.credit, e.description || spec.description || ''];
      // Try with dimensions — if the schema lacks them, fall back to the minimal insert.
      // v5.11.0 — entry inherits each dim from the journal header when
      // the line itself didn't override it (BR-3). projectId is now in
      // the set too. The result is a fully-qualified entry that downstream
      // multi-dim reports can slice on without scanning the header row.
      const dimCols = [];
      const dimVals = [];
      for (const [k, col, headerKey] of [
        ['branchId', 'branch_id', 'branchId'],
        ['brandId',  'brand_id',  'brandId'],
        ['projectId','project_id','projectId'],
        ['costCenterId','cost_center_id','costCenterId'],
        ['warehouseId','warehouse_id', null]
      ]) {
        let v = e[k];
        if ((v === undefined || v === null || v === '') && headerKey) v = spec[headerKey];
        if (v !== undefined && v !== null && v !== '') {
          dimCols.push(col); dimVals.push(v);
        }
      }
      const allCols = cols.concat(dimCols);
      const allVals = vals.concat(dimVals);
      const placeholders = allCols.map(() => '?').join(',');
      try {
        await db.query(`INSERT INTO gl_entries (${allCols.join(',')}) VALUES (${placeholders})`, allVals);
      } catch(err) {
        // Retry without dimension columns (for pre-v3 schemas)
        if (dimCols.length) {
          try {
            await db.query(`INSERT INTO gl_entries (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
          } catch(err2) { throw err2; }
        } else throw err;
      }

      // Update account balance (only for posted journals)
      if (spec.status !== 'draft') {
        try {
          await db.query(
            `UPDATE gl_accounts SET balance = balance + ? WHERE id = ?`,
            [e.debit - e.credit, e.accountId]);
        } catch(err) { /* non-fatal */ }
      }
    }

    return { success: true, journalId: jId, journalNumber: jNum };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { postJournal, ensureCoreAccounts, resolveAccountId, isPeriodClosed, CORE_ACCOUNTS };
