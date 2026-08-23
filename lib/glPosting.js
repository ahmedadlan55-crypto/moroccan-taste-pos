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
 *     ONE deliberate exception (Phase 3A.2): when called with the caller's
 *     TRANSACTION connection and InnoDB kills that transaction (deadlock,
 *     errno 1213 — the whole txn is implicitly rolled back), postJournal
 *     RETHROWS instead of returning {success:false}. Returning would let the
 *     caller keep writing on a connection that silently fell back to
 *     autocommit — the caller's business writes are ALREADY gone, and
 *     db.withTransaction must roll back and re-run the whole unit of work.
 *
 * Usage:
 *   const gl = require('../lib/glPosting');
 *   const r = await gl.postJournal(db, {
 *     journalDate: '2026-04-18',
 *     description: 'Purchase receipt GRN-00001',
 *     referenceType: 'PurchaseReceipt',
 *     referenceId: 'PR-...',
 *     entries: [
 *       { accountCode: '113100', debit: 1000, credit: 0, branchId, brandId, warehouseId },
 *       { accountCode: '112400', debit: 150,  credit: 0, branchId, brandId },
 *       { accountCode: '211100', debit: 0,    credit: 1150, brandId }
 *     ],
 *     postedBy: 'admin'
 *   });
 */

// Well-known account codes the system relies on. These are seeded by
// ensureCoreAccounts() the first time posting runs.
//
// Operational codes remain stable for historical compatibility, while their
// parents follow the six-digit reporting hierarchy in coa-template.
// Inventory is intentionally one control account (113100); warehouse, item,
// production-stage and brand detail belong to the inventory subledger and
// journal dimensions, not to separate GL accounts.
// Riyadh calendar dates for journals — never UTC. See lib/accountingDate.js.
const acctDate = require('./accountingDate');

const INVENTORY_CONTROL = Object.freeze({
  code: '113100',
  nameAr: 'حساب مراقبة المخزون',
  type: 'asset',
  parent: '113000',
});

const CORE_ACCOUNTS = {
  // ─── Assets ───
  CASH:              { code: '111100', nameAr: 'النقدية بالصندوق',        type: 'asset',     parent: '111000' },
  BANK:              { code: '111200', nameAr: 'الحسابات البنكية',        type: 'asset',     parent: '111000' },
  PAYMENT_CLEARING:  { code: '111300', nameAr: 'تسويات وسائل الدفع',      type: 'asset',     parent: '111000' },
  AR:                { code: '112100', nameAr: 'ذمم العملاء',              type: 'asset',     parent: '112000' },
  EMPLOYEE_ADVANCES: { code: '112300', nameAr: 'سلف الموظفين والعهد',      type: 'asset',     parent: '112000' },
  INVENTORY:         INVENTORY_CONTROL, // Detail lives in the inventory subledger + dimensions
  // Compatibility aliases only. Runtime code must not create a separate GL
  // account per branch, production stage, product, category or warehouse.
  BRANCH_INVENTORY:  { ...INVENTORY_CONTROL, aliasOf: 'INVENTORY' },
  WIP:               { ...INVENTORY_CONTROL, aliasOf: 'INVENTORY' },
  FINISHED_GOODS:    { ...INVENTORY_CONTROL, aliasOf: 'INVENTORY' },
  INPUT_VAT:         { code: '115100', nameAr: 'ضريبة المدخلات',           type: 'asset',     parent: '115000' },
  // ─── Liabilities ───
  AP:                { code: '211100', nameAr: 'ذمم الموردين',             type: 'liability', parent: '211000' },
  OUTPUT_VAT:        { code: '213100', nameAr: 'ضريبة المخرجات',           type: 'liability', parent: '213000' },
  ROYALTY_PAYABLE:   { code: '212400', nameAr: 'مستحقات الامتياز',         type: 'liability', parent: '212000' },
  // ─── Revenue ───
  SALES_REVENUE:     { code: '411100', nameAr: 'إيرادات المبيعات',         type: 'revenue',   parent: '411000' },
  STOCK_GAIN:        { code: '419100', nameAr: 'إيراد فروقات جرد',         type: 'revenue',   parent: '419000' },
  // ─── Expenses ───
  // Keep the P&L concise. Operational reason/category detail is carried in
  // dimensions and source documents instead of multiplying ledger accounts.
  COGS:              { code: '511100', nameAr: 'تكلفة المبيعات',           type: 'expense',   parent: '511000' },
  WASTE_EXPENSE:     { code: '512100', nameAr: 'مصروف الهدر (عام)',         type: 'expense',   parent: '512000' },
  // Waste reason is an operational dimension, not a separate account per
  // button. These aliases preserve callers while the P&L stays concise.
  WASTE_RAW:         { code: '512100', nameAr: 'مصروف الهدر', type: 'expense', parent: '512000', aliasOf: 'WASTE_EXPENSE' },
  WASTE_FINISHED:    { code: '512100', nameAr: 'مصروف الهدر', type: 'expense', parent: '512000', aliasOf: 'WASTE_EXPENSE' },
  WASTE_EXPIRED:     { code: '512100', nameAr: 'مصروف الهدر', type: 'expense', parent: '512000', aliasOf: 'WASTE_EXPENSE' },
  WASTE_SPILL:       { code: '512100', nameAr: 'مصروف الهدر', type: 'expense', parent: '512000', aliasOf: 'WASTE_EXPENSE' },
  WASTE_RETURNS:     { code: '512100', nameAr: 'مصروف الهدر', type: 'expense', parent: '512000', aliasOf: 'WASTE_EXPENSE' },
  STOCK_VARIANCE:    { code: '512200', nameAr: 'فروقات الجرد',             type: 'expense',   parent: '512000' },
  PPV:               { code: '512300', nameAr: 'فروق سعر المشتريات',       type: 'expense',   parent: '512000' },
  LABOR_APPLIED:     { code: '551100', nameAr: 'العمالة المحملة',           type: 'expense',   parent: '551000' },
  OVERHEAD_APPLIED:  { code: '551200', nameAr: 'التكاليف غير المباشرة',     type: 'expense',   parent: '551000' },
  PRODUCTION_VARIANCE:{ code: '512400', nameAr: 'فروقات الإنتاج',           type: 'expense',   parent: '512000' },
  FRANCHISE_FEE:     { code: '591100', nameAr: 'مصروف رسوم الامتياز',       type: 'expense',   parent: '590000' },
  // Delivery-platform commission + payable are captured with the immutable
  // sale event and posted in the same aggregated daily/monthly journal.
  PLATFORM_COMMISSION:{ code: '541100', nameAr: 'عمولات منصات التوصيل',      type: 'expense',   parent: '541000' },
  PLATFORM_PAYABLE:  { code: '212500', nameAr: 'مستحقات منصات التوصيل',      type: 'liability', parent: '212000' },
  OTHER_EXPENSE:     { code: '599900', nameAr: 'مصروفات أخرى',               type: 'expense',   parent: '590000' }
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
    if (a.aliasOf) continue;
    try {
      // Resolve the desired parent_id (walks up if seed parent absent).
      // Tier A.2 corrective gate — `desiredLevel` used to default to
      // `a.code.length` (a naive guess), which stays WRONG whenever the walk
      // never finds any ancestor (e.g. bootstrapping a fresh chart with no
      // parent folders seeded yet, as in an isolated test DB): parent_id
      // ends up NULL (a true root), but the stored level would still claim
      // a nested depth like 4 — a stored-vs-computed level mismatch the
      // Trial Balance engine's diagnostics.levelMismatches now (correctly)
      // flags. A root account's level is 1; only override it when a real
      // parent is actually found.
      let desiredParentId = null;
      let desiredLevel = 1;
      if (a.parent) {
        let walk = a.parent;
        while (walk.length > 0 && !desiredParentId) {
          const [p] = await db.query('SELECT id, level FROM gl_accounts WHERE code = ? LIMIT 1', [walk]);
          if (p.length) {
            desiredParentId = p[0].id;
            desiredLevel = Math.max(2, Number(p[0].level || 1) + 1);
            break;
          }
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
    } catch(e) {
      // Best-effort — EXCEPT a deadlock, which has already destroyed the
      // caller's surrounding transaction and must propagate (see postJournal).
      if (_isDeadlock(e)) throw e;
    }
  }
  _accountsEnsured = true;
}

// Look up gl_accounts.id by code (cached per process)
const _accountIdCache = {};
async function resolveAccountId(db, code) {
  if (!code) return null;
  if (_accountIdCache[code]) return _accountIdCache[code];
  let [rows] = await db.query(
    'SELECT id FROM gl_accounts WHERE code = ? AND is_active = 1 LIMIT 1', [code]);
  if (!rows.length) {
    try {
      [rows] = await db.query(
        `SELECT alias_row.account_id AS id
           FROM account_code_aliases alias_row
           JOIN gl_accounts target ON target.id=alias_row.account_id AND target.is_active=1
          WHERE alias_row.old_code=?
          ORDER BY (alias_row.company_id='CO-MAIN') DESC
          LIMIT 1`, [code]);
    } catch (e) {
      if (e && e.code !== 'ER_NO_SUCH_TABLE') throw e;
      rows = [];
    }
  }
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
  let [rows] = await db.query(
    'SELECT name_ar, name_en FROM gl_accounts WHERE code = ? AND is_active = 1 LIMIT 1', [code]);
  if (!rows.length) {
    try {
      [rows] = await db.query(
        `SELECT target.name_ar,target.name_en
           FROM account_code_aliases alias_row
           JOIN gl_accounts target ON target.id=alias_row.account_id AND target.is_active=1
          WHERE alias_row.old_code=?
          ORDER BY (alias_row.company_id='CO-MAIN') DESC
          LIMIT 1`, [code]);
    } catch (e) {
      if (e && e.code !== 'ER_NO_SUCH_TABLE') throw e;
      rows = [];
    }
  }
  if (!rows.length) return '';
  const nm = rows[0].name_ar || rows[0].name_en || '';
  _accountNameCache[code] = nm;
  return nm;
}

/**
 * Statuses that BLOCK posting. accounting_periods.status is
 * ENUM('open','soft_close','soft_closed','closed','locked') — five values, not
 * two. The old check compared against the single literal 'closed', so a period
 * in `locked`, `soft_close` or `soft_closed` silently accepted journals. Both
 * soft_* spellings exist from an old migration; treat both.
 *
 * This is the difference between the Periods screen's "إقفال مبدئي — يمنع
 * الترحيل الجديد" being true or being a lie.
 */
const PERIOD_CLOSED_STATUSES = Object.freeze(['closed', 'locked', 'soft_close', 'soft_closed']);

/**
 * Does `date` fall inside a period that blocks posting?
 *
 * FAILS CLOSED. This used to be `catch(e) { return false; }` — any DB error
 * meant "the period is open", so the swallow defeated the very control it
 * implements: a transient failure turned the period lock off rather than on.
 * Refusing to post is recoverable; posting into a closed period is not.
 *
 * The single source of truth — routes/erp-core.js imports this rather than
 * keeping its own byte-identical copy (which drifted with the same two bugs).
 *
 * @throws never — returns true when it cannot prove the period is open.
 */
async function isPeriodClosed(db, date) {
  if (!date) return false;
  try {
    const [r] = await db.query(
      `SELECT status FROM accounting_periods
       WHERE ? BETWEEN start_date AND end_date LIMIT 1`, [date]);
    if (!r.length) return false;               // no period defined → nothing to lock
    return PERIOD_CLOSED_STATUSES.includes(String(r[0].status || '').toLowerCase());
  } catch (e) {
    console.error('[gl] period-lock check FAILED — refusing to post (fail-closed):', e && (e.code || e.message));
    return true;
  }
}

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── DB-atomic journal numbering (Phase 3A.1) ────────────────────────────────
// Replaces the old timestamp/created_at-ordered numbering. A per-day counter
// row (gl_journal_seq) is incremented atomically; the UNIQUE uq_journal_number
// index is the absolute guard; a bounded retry re-numbers on the rare
// duplicate/deadlock. Gaps after a caller rollback are acceptable (documented);
// duplicates are impossible. No timestamp, no sleep.

function _isDup(err) { return !!err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062 || /duplicate entry/i.test(err.message || '')); }
function _isDeadlock(err) { return !!err && (err.code === 'ER_LOCK_DEADLOCK' || err.errno === 1213 || /deadlock found|lock wait timeout/i.test(err.message || '')); }
function _isMissingColumn(err) { return !!err && (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054 || /unknown column/i.test(err.message || '')); }

// A SMALL pool dedicated to sequence allocation, kept SEPARATE from the app
// pool. Why: the serial is allocated + committed in its OWN short transaction,
// so (a) a deadlock while seeding the day's counter row can be retried without
// aborting the caller's business transaction, and (b) 100 concurrent business
// transactions (each already holding an app-pool connection) never exhaust the
// app pool to allocate a number. A committed sequence never rolls back, so a
// gap after a caller rollback is acceptable (documented); duplicates are not.
let _seqPool = null;
function _getSeqPool() {
  if (_seqPool) return _seqPool;
  const mysql = require('mysql2/promise');
  const u = process.env.DATABASE_URL || process.env.MYSQL_URL;
  let cfg = null;
  if (u) { try { const x = new URL(u); cfg = { host: x.hostname, port: Number(x.port || 3306), user: decodeURIComponent(x.username || ''), password: decodeURIComponent(x.password || ''), database: (x.pathname || '/').slice(1) }; } catch (_) {} }
  if (!cfg) cfg = {
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || process.env.DB_NAME || 'moroccan_taste_pos',
  };
  _seqPool = mysql.createPool(Object.assign(cfg, { waitForConnections: true, connectionLimit: 8, queueLimit: 0, charset: 'utf8mb4' }));
  return _seqPool;
}

// Allocate the next per-day serial atomically — NO timestamp/created_at order.
// Runs in its own dedicated-pool transaction; `LAST_INSERT_ID(expr)` makes the
// increment + read atomic on the one connection. Seeds the row once (only when
// absent) from existing journals so a day that already has JV-rows doesn't
// restart at 1. Retries on the rare seed deadlock (its own txn → safe).
async function _nextJournalSerial(ymd) {
  const pool = _getSeqPool();
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    let conn = null;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const [ex] = await conn.query('SELECT 1 FROM gl_journal_seq WHERE period_key = ? LIMIT 1', [ymd]);
      if (!ex.length) {
        const [mx] = await conn.query(
          "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(journal_number,'-',-1) AS UNSIGNED)), 0) AS m " +
          "FROM gl_journals WHERE journal_number LIKE ?", ['JV-' + ymd + '-%']);
        await conn.query('INSERT IGNORE INTO gl_journal_seq (period_key, last_serial) VALUES (?, ?)', [ymd, (mx[0] && mx[0].m) || 0]);
      }
      await conn.query('UPDATE gl_journal_seq SET last_serial = LAST_INSERT_ID(last_serial + 1) WHERE period_key = ?', [ymd]);
      const [r] = await conn.query('SELECT LAST_INSERT_ID() AS s');
      await conn.commit();
      return Number(r[0] && r[0].s) || 1;
    } catch (e) {
      lastErr = e;
      if (conn) { try { await conn.rollback(); } catch (_) {} }
      if (_isDeadlock(e) && attempt < 7) continue; // safe to retry — its own txn
      throw e;
    } finally {
      if (conn) { try { conn.release(); } catch (_) {} }
    }
  }
  throw (lastErr || new Error('تعذّر حجز رقم تسلسلي للقيد'));
}

// ── Atomic FLAT sequential journal numbering (Phase FC — B1) ────────────────
// A second numbering family lives in gl_journals alongside the dated
// JV-YYYYMMDD-NNNN form above: the FLAT 6-digit "JV-######" used by the
// maker-checker POST /gl/journals and the custody / work-order / module
// journals, and the payroll "JE-#####". Every one of those sites used to derive
// its next number from `SELECT journal_number FROM gl_journals ORDER BY
// created_at DESC LIMIT 1` + parse + 1 — which RACED: gl_journals.created_at is
// a 1-second TIMESTAMP, so two journals in the same second tie and the "latest"
// is arbitrary (a non-max row), producing a duplicate the uq_journal_number
// index then rejected (500). It also mis-parsed a coexisting dated number
// (grabbing the YYYYMMDD run). This replaces all of them with the SAME atomic
// gl_journal_seq mechanism as the dated form: a per-family counter row bumped
// with LAST_INSERT_ID in its own short committed transaction. Seeds once from
// the existing MAX of that family's FLAT form only. A gap after a caller
// rollback is acceptable (documented); duplicates are impossible.
async function _nextFlatSerial(key, familyRegexp, digitStart) {
  const pool = _getSeqPool();
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    let conn = null;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const [ex] = await conn.query('SELECT 1 FROM gl_journal_seq WHERE period_key = ? LIMIT 1', [key]);
      if (!ex.length) {
        const [mx] = await conn.query(
          'SELECT COALESCE(MAX(CAST(SUBSTRING(journal_number, ?) AS UNSIGNED)), 0) AS m ' +
          'FROM gl_journals WHERE journal_number REGEXP ?', [digitStart, familyRegexp]);
        await conn.query('INSERT IGNORE INTO gl_journal_seq (period_key, last_serial) VALUES (?, ?)', [key, (mx[0] && mx[0].m) || 0]);
      }
      await conn.query('UPDATE gl_journal_seq SET last_serial = LAST_INSERT_ID(last_serial + 1) WHERE period_key = ?', [key]);
      const [r] = await conn.query('SELECT LAST_INSERT_ID() AS s');
      await conn.commit();
      return Number(r[0] && r[0].s) || 1;
    } catch (e) {
      lastErr = e;
      if (conn) { try { await conn.rollback(); } catch (_) {} }
      if (_isDeadlock(e) && attempt < 7) continue;
      throw e;
    } finally {
      if (conn) { try { conn.release(); } catch (_) {} }
    }
  }
  throw (lastErr || new Error('تعذّر حجز رقم تسلسلي للقيد'));
}

// "JV-######" (grows past 6 digits without ever colliding). period_key 'JV6'.
async function nextFlatJournalNumber() {
  const s = await _nextFlatSerial('JV6', '^JV-[0-9]+$', 4);
  return 'JV-' + String(s).padStart(6, '0');
}
// Payroll "JE-#####". period_key 'JE5'.
async function nextFlatJENumber() {
  const s = await _nextFlatSerial('JE5', '^JE-[0-9]+$', 4);
  return 'JE-' + String(s).padStart(5, '0');
}

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
  // ── Mode detection (Phase 3A.2) ───────────────────────────────────────────
  // `db` is either the app POOL (route-level posts) or the caller's
  // TRANSACTION connection (posting atomic with the business writes).
  if (typeof db.getConnection === 'function') {
    // Pool mode. Previously every statement ran as its own autocommit txn, so
    // a mid-flight failure left a committed half-journal (header without
    // entries, or entries without balance updates). Post atomically in our own
    // short transaction instead. A deadlock rolls the whole attempt back, so
    // re-running it is safe (a fresh serial is allocated — gaps after a
    // rollback are documented-acceptable).
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const r = await _postJournalTx(conn, spec);
        await conn.commit();
        return r;
      } catch (e) {
        lastErr = e;
        // Harmless no-op if the deadlock already rolled the txn back.
        try { await conn.rollback(); } catch (_) {}
      } finally {
        try { conn.release(); } catch (_) {}
      }
      if (!_isDeadlock(lastErr) || attempt === 3) break;
    }
    return { success: false, error: lastErr.message };
  }

  // Connection mode — INSIDE the caller's transaction. A deadlock (1213) means
  // InnoDB has ALREADY rolled back the caller's entire transaction and the
  // connection silently fell back to autocommit. Swallowing it here is exactly
  // what used to lose journals under concurrency: the header row had been
  // undone, the next gl_entries INSERT hit FK 1452, and the "committed"
  // business writes were gone too. Rethrow so the caller's db.withTransaction
  // rolls back and re-runs the whole unit of work.
  try {
    return await _postJournalTx(db, spec);
  } catch (e) {
    if (_isDeadlock(e)) throw e;
    return { success: false, error: e.message };
  }
}

// The posting body. `db` is ALWAYS a single connection here. Validation
// failures return {success:false}; SQL errors THROW so the postJournal wrapper
// above decides (retry in its own txn / rethrow to the caller's txn / convert)
// — this function must never paper over an error mid-write.
async function _postJournalTx(db, spec) {
    await ensureCoreAccounts(db);

    if (!spec || !Array.isArray(spec.entries) || !spec.entries.length) {
      return { success: false, error: 'لا توجد سطور قيد' };
    }
    const jdate = acctDate.toAccountingDate(spec.journalDate || undefined);
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
      // Data-integrity ALERT — an unbalanced journal must never post. Count + log.
      try { require('./v2Metrics').inc('gl_imbalance_total'); } catch (_) {}
      try { require('./logger').fatal({ alert: 'gl_imbalance', debit: td, credit: tc }, 'GL_IMBALANCE'); } catch (_) {}
      return { success: false, error: `القيد غير متوازن: مدين=${td} دائن=${tc}` };
    }

    // Journal number — DB-atomic per-day sequence (gl_journal_seq), NOT
    // timestamp/created_at ordering. The number is allocated in its own short
    // pooled transaction (so concurrent posters don't serialise on the counter),
    // the UNIQUE uq_journal_number index is the absolute guard, and a bounded
    // retry re-numbers on the rare duplicate. Gaps after a caller rollback are
    // acceptable (documented); duplicates are impossible.
    const ymd = jdate.replace(/-/g, '');

    // Header column plan + dimensions (computed once; independent of the number).
    const headerCols = ['id','journal_number','journal_date','reference_type','reference_id',
                        'description','total_debit','total_credit','status','created_by','posted_by','posted_at'];
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
    const _baseStatus = spec.status === 'draft' ? 'draft' : 'posted';
    const _postedAt = spec.status === 'draft' ? null : new Date();

    let jId, jNum, insertedHeader = false, lastErr = null;
    for (let attempt = 0; attempt < 6 && !insertedHeader; attempt++) {
      const serial = await _nextJournalSerial(ymd);
      jNum = 'JV-' + ymd + '-' + String(serial).padStart(4, '0');
      jId = genId('JRN');
      const headerVals = [jId, jNum, jdate, spec.referenceType || 'manual', spec.referenceId || '',
                          spec.description || '', td, tc, _baseStatus,
                          spec.postedBy || '', spec.postedBy || '', _postedAt];
      const allHeaderCols = headerCols.concat(headerDimCols);
      const allHeaderVals = headerVals.concat(headerDimVals);
      try {
        try {
          await db.query(
            'INSERT INTO gl_journals (' + allHeaderCols.join(',') + ') VALUES (' + allHeaderCols.map(() => '?').join(',') + ')',
            allHeaderVals);
        } catch (err) {
          // Fall back to the legacy (no-dimension) column set ONLY for a
          // missing-column error — NEVER for a duplicate (that must bubble up so
          // the loop re-numbers instead of silently swallowing the collision).
          if (headerDimCols.length && _isMissingColumn(err)) {
            await db.query(
              'INSERT INTO gl_journals (' + headerCols.join(',') + ') VALUES (' + headerCols.map(() => '?').join(',') + ')',
              headerVals);
          } else { throw err; }
        }
        insertedHeader = true;
      } catch (err) {
        lastErr = err;
        // ONLY a duplicate re-numbers: a dup-key error is statement-level, the
        // transaction survives. A deadlock is NOT retryable here — InnoDB has
        // rolled back the WHOLE transaction, so retrying on this connection
        // would write outside any transaction; it must propagate instead.
        if (_isDup(err)) continue; // re-allocate + retry
        throw err;
      }
    }
    if (!insertedHeader) throw (lastErr || new Error('تعذّر توليد رقم قيد فريد بعد عدة محاولات'));

    // ── Account balances FIRST — exclusive locks in deterministic order ─────
    // (Phase 3A.2, fixes the concurrency loss.) The gl_entries INSERT below
    // takes an implicit FK *shared* lock on each parent gl_accounts row
    // (gl_entries_ibfk_2). The old code inserted the entry first and then ran
    // this UPDATE — a shared→exclusive upgrade: two posters touching the same
    // account both held S and both waited forever for X, so InnoDB killed one
    // and rolled back its ENTIRE transaction (header vanished → next entries
    // INSERT failed FK 1452 → journal lost). Taking the X lock BEFORE any
    // S lock, on net per-account deltas sorted by account id, removes both the
    // upgrade and any AB-BA ordering between journals with overlapping
    // account sets.
    if (spec.status !== 'draft') {
      const deltas = new Map();
      for (const e of enriched) {
        deltas.set(e.accountId, (deltas.get(e.accountId) || 0) + (e.debit - e.credit));
      }
      for (const accountId of Array.from(deltas.keys()).sort()) {
        try {
          await db.query(
            `UPDATE gl_accounts SET balance = balance + ? WHERE id = ?`,
            [round2(deltas.get(accountId)), accountId]);
        } catch (err) {
          // A deadlock destroyed the surrounding transaction — never continue
          // on it (that was the swallowed-error path that lost journals).
          // Anything else (e.g. legacy schema) stays non-fatal as before.
          if (_isDeadlock(err)) throw err;
        }
      }
    }

    for (const e of enriched) {
      const lineId = genId('GLE');
      // Detect which dimension columns exist (tolerate older schemas)
      const cols = ['id', 'journal_id', 'account_id', 'account_code', 'account_name',
                    'debit', 'credit', 'description'];
      // V5.7.18 — persist resolved account_name (was previously empty string,
      //           which made the journal viewer show only bare account codes
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
        ['warehouseId','warehouse_id', null],
        // PARTY — the counterparty a line belongs to (a supplier, a customer,
        // an employee). Header inheritance is deliberately OFF (null headerKey,
        // like warehouse): one journal can legitimately touch two parties —
        // «Dr supplier payable / Cr bank» — and inheriting downward would stamp
        // the supplier onto the BANK line, corrupting every query that asks
        // "what does this account owe that party".
        ['partyType', 'party_type', null],
        ['partyId',   'party_id',   null],
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
        // Retry without dimension columns ONLY for pre-v3 schemas (missing
        // column). Retrying on ANY error used to mask deadlocks — the retry
        // then ran on an already-rolled-back transaction and failed FK 1452.
        if (dimCols.length && _isMissingColumn(err)) {
          // The fallback drops EVERY dimension, not just the missing one, and
          // then reports success. That is an acceptable degradation for an
          // advisory dimension on an old schema — and a silent data-integrity
          // failure for a REQUIRED one. A supplier payable posted without its
          // party is money owed to nobody: invisible to the supplier statement,
          // invisible to ageing, and indistinguishable afterwards from a
          // manual entry.
          //
          // So: if this line carries a party, refuse rather than degrade. The
          // caller sees a real error instead of a green result and a hole.
          if (e.partyId) throw err;
          await db.query(`INSERT INTO gl_entries (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
        } else throw err;
      }
    }

    return { success: true, journalId: jId, journalNumber: jNum };
}

/**
 * The GR/IR account code — «بضاعة مستلمة لم تُفوتر».
 *
 * A goods receipt creates a liability that is NOT a supplier-invoice
 * liability: nothing has been invoiced yet. Crediting A/P at receipt puts
 * money into the control account that no invoice backs, and the A/P ageing —
 * which reads the supplier-invoice subledger — can then never tie.
 *
 * Resolved through the SAME role registry the V2 procurement module uses
 * (lib/procurement/accounts.js maps `grni` → role GRNI), so the legacy and V2
 * receipt paths cannot post to two different accounts.
 *
 * THROWS when the role is unmapped. It deliberately does not fall back to
 * A/P: a silent fallback is how the defect survived, and refusing to post a
 * receipt is less costly than posting it somewhere that corrupts the ageing.
 */
async function getGrniAccountCode(db, companyId) {
  const { getAccountByRole } = require('./accountRoles');
  const acc = await getAccountByRole(db, 'GRNI', { companyId: companyId || 'CO-MAIN' });
  const code = acc && (acc.code || acc.account_code);
  if (!code) {
    const e = new Error('حساب البضاعة المستلمة غير المفوترة (GRNI) غير مُعيَّن');
    e.code = 'GRNI_UNMAPPED';
    throw e;
  }
  return code;
}
module.exports = { postJournal, ensureCoreAccounts, resolveAccountId, isPeriodClosed, PERIOD_CLOSED_STATUSES, CORE_ACCOUNTS, nextFlatJournalNumber, nextFlatJENumber, getGrniAccountCode };
