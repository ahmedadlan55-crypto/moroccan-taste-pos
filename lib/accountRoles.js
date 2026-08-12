/**
 * Account Role Registry lookup + writer — resolves a symbolic business role
 * ("CASH_ON_HAND", "ACCOUNTS_RECEIVABLE", ...) to the gl_accounts row a
 * company has assigned to it, via the account_roles table (migrations 0014
 * + 0015 — see docs/adr/0002-chart-of-accounts-trial-balance.md section 5).
 *
 * This module has NO current callers wired to it. Business code still
 * resolves accounts through lib/glPosting.js CORE_ACCOUNTS /
 * lib/hrGLPosting.js SALARY_ACCOUNTS / literal code strings until each call
 * site is migrated individually, in a separate governed change, once every
 * role this module's consumers need has 100% coverage.
 *
 * Contract: NEVER silently fall back and NEVER auto-create an account. A
 * missing or invalid mapping is a hard, typed failure.
 *
 * Tier A.1 Corrective Gate fixes versus the Tier A version:
 *   - No in-process cache. A cache with no invalidation trigger risks a
 *     revoked/reassigned role continuing to resolve to a stale account —
 *     "لا تسمح باستخدام Mapping قديم بعد تعطيله". With zero current
 *     consumers, the performance cost of always reading fresh is moot;
 *     re-introduce caching only alongside real invalidation once a
 *     consumer's QPS actually needs it.
 *   - company_id is now NOT NULL (migration 0015/0019) — getAccountByRole
 *     no longer has a "global (company_id IS NULL) fallback", which used
 *     to be a silent-fallback risk of its own kind ("لا Global fallback
 *     مالي صامت عند إرسال Company ID"). Every lookup requires an EXPLICIT
 *     companyId argument now — see the CONTRACT note below for what that
 *     scoping does and does NOT actually isolate.
 *   - The "is this account postable" check now verifies structural
 *     parent-ness (no children) in addition to the is_folder flag, matching
 *     the trial-balance engine's stricter AND-based definition.
 *   - Every write goes through setAccountRole(), which validates against
 *     lib/accountRoleCatalog.js (account type + natural side + tax nature),
 *     runs inside a transaction, and writes account_role_history with an
 *     actor/reason/optimistic-concurrency version check.
 *
 * CONTRACT — Single Ledger / CO-MAIN, same lock as lib/reports/trialBalance
 * .js. account_roles.company_id is NOT NULL with a real FK to companies(id)
 * and a genuine UNIQUE(role_key, company_id) — that part IS structurally
 * correct. But gl_accounts itself has NO company_id column: there is only
 * ONE physical chart of accounts, shared by every companyId value a caller
 * might pass. A mapping under companyId='CO-MAIN' and one under some
 * hypothetical 'CO-BRANCH2' would both resolve against the exact same
 * unpartitioned account pool — nothing here isolates one company's accounts
 * from another's, because there is nothing at the account level TO isolate
 * yet. What company_id actually provides today is namespacing for the
 * ROLE-TO-ACCOUNT MAPPING itself (so two companies could, in principle,
 * point the same role_key at different accounts without colliding) — not
 * company-scoped data isolation. Only 'CO-MAIN' exists as a real row in
 * `companies` right now (docs/adr/0002-chart-of-accounts-trial-balance.md
 * section 4); treat any other companyId as untested, not as a proof that
 * real multi-company support exists. Building genuine per-company account
 * isolation would mean adding company_id to gl_accounts/gl_journals/
 * gl_entries and re-deriving every balance/report by it — a real schema
 * change, out of scope for this module.
 */
'use strict';

const { getRoleDefinition } = require('./accountRoleCatalog');

class AccountRoleError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'AccountRoleError';
    this.code = code;
    this.details = details || {};
  }
}

async function _lookupRow(db, roleKey, companyId) {
  const [rows] = await db.query(
    `SELECT ar.id AS role_row_id, ar.account_id, ar.is_active AS role_active, ar.version,
            a.code, a.name_ar, a.type, a.tax_nature, a.is_active AS account_active, a.is_folder,
            (SELECT COUNT(*) FROM gl_accounts c WHERE c.parent_id = a.id) AS child_count
     FROM account_roles ar
     JOIN gl_accounts a ON a.id = ar.account_id
     WHERE ar.role_key = ? AND ar.company_id = ?
     LIMIT 1`,
    [roleKey, companyId]
  );
  return rows[0] || null;
}

/**
 * @param {object} db - a pool/connection exposing .query() (db/connection.js or a transaction conn)
 * @param {string} roleKey - e.g. 'CASH_ON_HAND'
 * @param {object} opts
 * @param {string} opts.companyId - REQUIRED. No silent default — the caller states scope explicitly.
 * @returns {Promise<{accountId: string, code: string, nameAr: string, type: string}>}
 * @throws {AccountRoleError}
 */
async function getAccountByRole(db, roleKey, opts) {
  opts = opts || {};
  if (!roleKey || typeof roleKey !== 'string') {
    throw new AccountRoleError('roleKey is required and must be a string', 'ACCOUNT_ROLE_MISSING_KEY');
  }
  if (!opts.companyId) {
    throw new AccountRoleError(
      'companyId is required — this registry no longer has a silent "global" fallback (migration 0015).',
      'ACCOUNT_ROLE_MISSING_COMPANY'
    );
  }

  const row = await _lookupRow(db, roleKey, opts.companyId);
  if (!row) {
    throw new AccountRoleError(
      `لا يوجد حساب مُعيَّن للدور "${roleKey}" (الشركة ${opts.companyId}). ` +
      'لن يتم تخمين أو إنشاء حساب تلقائيًا — أضِف تعيينًا صريحًا عبر setAccountRole أولاً.',
      'ACCOUNT_ROLE_UNMAPPED',
      { roleKey, companyId: opts.companyId }
    );
  }
  if (!row.role_active) {
    throw new AccountRoleError(
      `الدور "${roleKey}" مُعطَّل (تم سحبه حوكميًا) — راجع account_role_history.`,
      'ACCOUNT_ROLE_INACTIVE',
      { roleKey, companyId: opts.companyId, accountId: row.account_id, code: row.code }
    );
  }
  if (!row.account_active) {
    throw new AccountRoleError(
      `الدور "${roleKey}" يشير إلى الحساب ${row.code} وهو غير نشط.`,
      'ACCOUNT_ROLE_TARGET_INACTIVE',
      { roleKey, companyId: opts.companyId, accountId: row.account_id, code: row.code }
    );
  }
  // Structural check IN ADDITION to the is_folder flag — an account with no
  // is_folder=1 but that some OTHER account still lists as its parent is
  // just as unpostable in practice (see the trial-balance engine's
  // isPostingLeaf definition, which this mirrors).
  if (row.is_folder || Number(row.child_count) > 0) {
    throw new AccountRoleError(
      `الدور "${roleKey}" يشير إلى الحساب ${row.code} وهو حساب تجميعي (Folder/له أبناء) لا يقبل الترحيل.`,
      'ACCOUNT_ROLE_TARGET_IS_FOLDER',
      { roleKey, companyId: opts.companyId, accountId: row.account_id, code: row.code }
    );
  }

  return {
    accountId: row.account_id,
    code: row.code,
    nameAr: row.name_ar,
    type: row.type,
    taxNature: row.tax_nature || null,
  };
}

function _historyId() {
  return 'ARH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Transactionally create or reassign a role mapping. Validates the target
 * account against lib/accountRoleCatalog.js (type, natural side, tax
 * nature where applicable, and postability) before writing anything, and
 * always writes an account_role_history row (actor + reason required).
 *
 * @param {object} db - pool (must expose withTransaction — db/connection.js)
 * @param {object} opts
 * @param {string} opts.roleKey
 * @param {string} opts.companyId - REQUIRED, must reference an existing companies row
 * @param {string} opts.accountId - REQUIRED, must be an existing, active, postable account
 * @param {string} opts.actor - REQUIRED, who is making this change
 * @param {string} opts.reason - REQUIRED, governance record of why
 * @param {number} [opts.expectedVersion] - optimistic concurrency: required when reassigning an
 *   EXISTING mapping (omit only for a brand-new role/company pair, which has no version yet)
 * @returns {Promise<{accountId: string, version: number, created: boolean}>}
 * @throws {AccountRoleError}
 */
async function setAccountRole(db, opts) {
  opts = opts || {};
  const { roleKey, companyId, accountId, actor, reason, expectedVersion } = opts;
  if (!roleKey) throw new AccountRoleError('roleKey is required', 'ACCOUNT_ROLE_MISSING_KEY');
  if (!companyId) throw new AccountRoleError('companyId is required', 'ACCOUNT_ROLE_MISSING_COMPANY');
  if (!accountId) throw new AccountRoleError('accountId is required', 'ACCOUNT_ROLE_MISSING_ACCOUNT');
  if (!actor) throw new AccountRoleError('actor is required', 'ACCOUNT_ROLE_MISSING_ACTOR');
  if (!reason || !String(reason).trim()) throw new AccountRoleError('reason is required (governance record)', 'ACCOUNT_ROLE_MISSING_REASON');

  const roleDef = getRoleDefinition(roleKey);
  if (!roleDef) {
    throw new AccountRoleError(`دور غير معروف في الكتالوج: ${roleKey}`, 'ACCOUNT_ROLE_UNKNOWN_ROLE', { roleKey });
  }

  return db.withTransaction(async (conn) => {
    const [companyRows] = await conn.query('SELECT id FROM companies WHERE id = ? LIMIT 1', [companyId]);
    if (!companyRows.length) {
      throw new AccountRoleError(`الشركة غير موجودة: ${companyId}`, 'ACCOUNT_ROLE_COMPANY_NOT_FOUND', { companyId });
    }

    const [accRows] = await conn.query(
      'SELECT id, code, type, is_active, is_folder FROM gl_accounts WHERE id = ? FOR UPDATE',
      [accountId]
    );
    if (!accRows.length) {
      throw new AccountRoleError(`الحساب غير موجود: ${accountId}`, 'ACCOUNT_ROLE_TARGET_NOT_FOUND', { accountId });
    }
    const acc = accRows[0];

    if (!roleDef.allowedTypes.includes(acc.type)) {
      throw new AccountRoleError(
        `الدور "${roleKey}" يتطلب حسابًا من نوع (${roleDef.allowedTypes.join('/')})، لكن ${acc.code} من نوع ${acc.type}.`,
        'ACCOUNT_ROLE_TYPE_MISMATCH',
        { roleKey, accountId, accountType: acc.type, allowedTypes: roleDef.allowedTypes }
      );
    }
    if (!(acc.is_active === 1 || acc.is_active === true)) {
      throw new AccountRoleError(`الحساب ${acc.code} غير نشط.`, 'ACCOUNT_ROLE_TARGET_INACTIVE', { accountId });
    }
    const [[childRow]] = await conn.query('SELECT COUNT(*) n FROM gl_accounts WHERE parent_id = ?', [accountId]);
    if (acc.is_folder || Number(childRow.n) > 0) {
      throw new AccountRoleError(`الحساب ${acc.code} تجميعي (Folder/له أبناء) — لا يقبل الترحيل.`, 'ACCOUNT_ROLE_TARGET_NOT_POSTABLE', { accountId });
    }
    if (roleDef.normalBalance && !roleDef.contra) {
      const impliedSide = acc.type === 'asset' || acc.type === 'expense' ? 'debit' : 'credit';
      if (impliedSide !== roleDef.normalBalance) {
        throw new AccountRoleError(
          `الدور "${roleKey}" يتوقع طبيعة ${roleDef.normalBalance}، لكن نوع الحساب ${acc.type} طبيعته ${impliedSide}.`,
          'ACCOUNT_ROLE_NORMAL_BALANCE_MISMATCH',
          { roleKey, accountId, expected: roleDef.normalBalance, implied: impliedSide }
        );
      }
    }
    if (roleDef.taxNature) {
      const [[taxRow]] = await conn.query('SELECT tax_nature FROM gl_accounts WHERE id = ?', [accountId]);
      if (taxRow.tax_nature !== roleDef.taxNature) {
        throw new AccountRoleError(
          `الدور "${roleKey}" يتطلب tax_nature=${roleDef.taxNature}، لكن الحساب ${acc.code} تصنيفه ${taxRow.tax_nature}.`,
          'ACCOUNT_ROLE_TAX_NATURE_MISMATCH',
          { roleKey, accountId, expected: roleDef.taxNature, actual: taxRow.tax_nature }
        );
      }
    }

    const [existingRows] = await conn.query(
      'SELECT id, account_id, version FROM account_roles WHERE role_key = ? AND company_id = ? FOR UPDATE',
      [roleKey, companyId]
    );

    if (existingRows.length) {
      const existing = existingRows[0];
      if (expectedVersion === undefined || expectedVersion === null) {
        throw new AccountRoleError(
          'expectedVersion is required when reassigning an existing role mapping (optimistic concurrency).',
          'ACCOUNT_ROLE_VERSION_REQUIRED',
          { roleKey, companyId, currentVersion: existing.version }
        );
      }
      if (Number(expectedVersion) !== Number(existing.version)) {
        throw new AccountRoleError(
          `تعديل متزامن: كانت النسخة المتوقعة ${expectedVersion} لكن النسخة الحالية ${existing.version}. أعد التحميل وحاول مجددًا.`,
          'ACCOUNT_ROLE_VERSION_CONFLICT',
          { roleKey, companyId, expectedVersion, currentVersion: existing.version }
        );
      }
      const newVersion = existing.version + 1;
      await conn.query(
        'UPDATE account_roles SET account_id = ?, version = ?, updated_by = ? WHERE id = ?',
        [accountId, newVersion, actor, existing.id]
      );
      await conn.query(
        'INSERT INTO account_role_history (id, role_key, company_id, old_account_id, new_account_id, expected_version, reason, changed_by) VALUES (?,?,?,?,?,?,?,?)',
        [_historyId(), roleKey, companyId, existing.account_id, accountId, expectedVersion, reason, actor]
      );
      return { accountId, version: newVersion, created: false };
    }

    // account_roles.id is VARCHAR(40) — embedding the full role key +
    // company id (both unbounded-ish in practice) overflowed it. role_key
    // and company_id are already unique together (uq_role_company), so the
    // id itself only needs to be unique, not descriptive.
    const id = 'AR-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    await conn.query(
      'INSERT INTO account_roles (id, role_key, company_id, account_id, is_active, version, created_by) VALUES (?,?,?,?,1,1,?)',
      [id, roleKey, companyId, accountId, actor]
    );
    await conn.query(
      'INSERT INTO account_role_history (id, role_key, company_id, old_account_id, new_account_id, expected_version, reason, changed_by) VALUES (?,?,?,NULL,?,?,?,?)',
      [_historyId(), roleKey, companyId, accountId, expectedVersion ?? null, reason, actor]
    );
    return { accountId, version: 1, created: true };
  });
}

module.exports = { getAccountByRole, setAccountRole, AccountRoleError };
