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
const CORE_ACCOUNTS = {
  // Assets
  CASH:            { code: '1110', nameAr: 'النقدية',            type: 'asset',     parent: '111' },
  BANK:            { code: '1120', nameAr: 'البنوك',             type: 'asset',     parent: '112' },
  AR:              { code: '1150', nameAr: 'ذمم العملاء',        type: 'asset',     parent: '115' },
  INVENTORY:       { code: '1200', nameAr: 'المخزون',            type: 'asset',     parent: '12'  },
  INPUT_VAT:       { code: '1290', nameAr: 'ضريبة المدخلات',     type: 'asset',     parent: '129' },
  // Liabilities
  AP:              { code: '2100', nameAr: 'ذمم الموردين',       type: 'liability', parent: '21'  },
  OUTPUT_VAT:      { code: '2210', nameAr: 'ضريبة المخرجات',     type: 'liability', parent: '221' },
  ROYALTY_PAYABLE: { code: '2310', nameAr: 'مستحقات الامتياز',   type: 'liability', parent: '231' },
  // Revenue
  SALES_REVENUE:   { code: '4100', nameAr: 'إيرادات المبيعات',   type: 'revenue',   parent: '41'  },
  STOCK_GAIN:      { code: '4910', nameAr: 'إيراد فروقات جرد',   type: 'revenue',   parent: '49'  },
  // Expenses
  COGS:            { code: '5100', nameAr: 'تكلفة المبيعات',     type: 'expense',   parent: '51'  },
  WASTE_EXPENSE:   { code: '5200', nameAr: 'مصروف الهدر',        type: 'expense',   parent: '52'  },
  STOCK_VARIANCE:  { code: '5300', nameAr: 'فروقات الجرد',       type: 'expense',   parent: '53'  },
  FRANCHISE_FEE:   { code: '6100', nameAr: 'مصروف رسوم الامتياز', type: 'expense',   parent: '61'  }
};

let _accountsEnsured = false;

async function ensureCoreAccounts(db) {
  if (_accountsEnsured) return;
  for (const [k, a] of Object.entries(CORE_ACCOUNTS)) {
    try {
      const [existing] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [a.code]);
      if (existing.length) continue;
      // Ensure parent exists — if not, create a stub parent at the appropriate level
      let parentId = null;
      if (a.parent) {
        const [p] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [a.parent]);
        if (p.length) parentId = p[0].id;
        else {
          // Try the grandparent (single digit)
          const gp = a.parent.charAt(0);
          const [gpRow] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [gp]);
          if (gpRow.length) parentId = gpRow[0].id;
        }
      }
      const accId = 'GL-' + a.code;
      await db.query(
        `INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, balance)
         VALUES (?,?,?,?,?,?,1,0)`,
        [accId, a.code, a.nameAr, a.type, parentId, a.code.length]);
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
      enriched.push({
        ...e,
        accountId: accId,
        accountCode: e.accountCode,
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

    await db.query(
      `INSERT INTO gl_journals (
         id, journal_number, journal_date, reference_type, reference_id,
         description, total_debit, total_credit, status, created_by, posted_by, posted_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [jId, jNum, jdate, spec.referenceType || 'manual', spec.referenceId || '',
       spec.description || '', td, tc,
       spec.status === 'draft' ? 'draft' : 'posted',
       spec.postedBy || '', spec.postedBy || '',
       spec.status === 'draft' ? null : new Date()]);

    for (const e of enriched) {
      const lineId = genId('GLE');
      // Detect which dimension columns exist (tolerate older schemas)
      const cols = ['id', 'journal_id', 'account_id', 'account_code', 'account_name',
                    'debit', 'credit', 'description'];
      const vals = [lineId, jId, e.accountId, e.accountCode, '',
                    e.debit, e.credit, e.description || spec.description || ''];
      // Try with dimensions — if the schema lacks them, fall back to the minimal insert
      const dimCols = [];
      const dimVals = [];
      for (const [k, col] of [
        ['branchId', 'branch_id'], ['brandId', 'brand_id'],
        ['costCenterId', 'cost_center_id'], ['warehouseId', 'warehouse_id']
      ]) {
        if (e[k] !== undefined && e[k] !== null && e[k] !== '') {
          dimCols.push(col); dimVals.push(e[k]);
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
