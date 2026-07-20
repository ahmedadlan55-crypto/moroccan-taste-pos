/**
 * Account Role Registry lookup — resolves a symbolic business role
 * ("CASH_ON_HAND", "ACCOUNTS_RECEIVABLE", ...) to the gl_accounts row a
 * company has assigned to it, via the account_roles table (migration 0014).
 *
 * This module has NO current callers wired to it (Tier A ships the registry
 * and this lookup only — see docs/adr/0002-chart-of-accounts-trial-balance.md
 * section 5). Business code still resolves accounts through
 * lib/glPosting.js CORE_ACCOUNTS / lib/hrGLPosting.js SALARY_ACCOUNTS /
 * literal code strings until each call site is migrated individually.
 *
 * Contract: NEVER silently fall back and NEVER auto-create an account. A
 * missing or invalid mapping is a hard, typed failure — the caller (and
 * ultimately the financial posting operation) must stop rather than guess.
 */
'use strict';

class AccountRoleError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'AccountRoleError';
    this.code = code;
    this.details = details || {};
  }
}

// Small in-process cache, same shape as lib/glPosting.js's _accountIdCache.
// Keyed by roleKey + companyId so scoped and global lookups don't collide.
const _cache = new Map();

async function _lookupRow(db, roleKey, companyId) {
  const [rows] = await db.query(
    `SELECT ar.account_id, ar.is_active AS role_active,
            a.code, a.name_ar, a.type, a.is_active AS account_active, a.is_folder
     FROM account_roles ar
     JOIN gl_accounts a ON a.id = ar.account_id
     WHERE ar.role_key = ? AND ar.company_id <=> ?
     LIMIT 1`,
    [roleKey, companyId]
  );
  return rows[0] || null;
}

/**
 * @param {object} db - a pool/connection exposing .query() (db/connection.js or a transaction conn)
 * @param {string} roleKey - e.g. 'CASH_ON_HAND'
 * @param {object} [opts]
 * @param {string|null} [opts.companyId] - if omitted or unmapped, falls back to the global (company_id IS NULL) mapping
 * @param {boolean} [opts.skipCache]
 * @returns {Promise<{accountId: string, code: string, nameAr: string, type: string}>}
 * @throws {AccountRoleError} ACCOUNT_ROLE_MISSING_KEY | ACCOUNT_ROLE_UNMAPPED | ACCOUNT_ROLE_INACTIVE | ACCOUNT_ROLE_TARGET_INACTIVE | ACCOUNT_ROLE_TARGET_IS_FOLDER
 */
async function getAccountByRole(db, roleKey, opts) {
  opts = opts || {};
  if (!roleKey || typeof roleKey !== 'string') {
    throw new AccountRoleError('roleKey is required and must be a string', 'ACCOUNT_ROLE_MISSING_KEY');
  }
  const companyId = opts.companyId || null;
  const cacheKey = roleKey + '::' + (companyId || '*');
  if (!opts.skipCache && _cache.has(cacheKey)) return _cache.get(cacheKey);

  let row = await _lookupRow(db, roleKey, companyId);
  if (!row && companyId) {
    row = await _lookupRow(db, roleKey, null); // fall back to the unscoped/global mapping
  }

  if (!row) {
    throw new AccountRoleError(
      `لا يوجد حساب مُعيَّن للدور "${roleKey}"${companyId ? ` (الشركة ${companyId})` : ''}. ` +
      'لن يتم تخمين أو إنشاء حساب تلقائيًا — أضِف تعيينًا صريحًا في account_roles أولاً.',
      'ACCOUNT_ROLE_UNMAPPED',
      { roleKey, companyId }
    );
  }
  if (!row.role_active) {
    throw new AccountRoleError(
      `الدور "${roleKey}" مُعطَّل (تم سحبه حوكميًا) — راجع account_role_history.`,
      'ACCOUNT_ROLE_INACTIVE',
      { roleKey, companyId, accountId: row.account_id, code: row.code }
    );
  }
  if (!row.account_active) {
    throw new AccountRoleError(
      `الدور "${roleKey}" يشير إلى الحساب ${row.code} وهو غير نشط.`,
      'ACCOUNT_ROLE_TARGET_INACTIVE',
      { roleKey, companyId, accountId: row.account_id, code: row.code }
    );
  }
  if (row.is_folder) {
    throw new AccountRoleError(
      `الدور "${roleKey}" يشير إلى الحساب ${row.code} وهو حساب تجميعي (Folder) لا يقبل الترحيل.`,
      'ACCOUNT_ROLE_TARGET_IS_FOLDER',
      { roleKey, companyId, accountId: row.account_id, code: row.code }
    );
  }

  const result = { accountId: row.account_id, code: row.code, nameAr: row.name_ar, type: row.type };
  _cache.set(cacheKey, result);
  return result;
}

function invalidateCache() {
  _cache.clear();
}

module.exports = { getAccountByRole, invalidateCache, AccountRoleError };
