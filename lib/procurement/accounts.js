/**
 * Procurement GL account resolver.
 *
 * Posting and reconciliation must read the same governed account-role
 * registry.  This module therefore never guesses from a literal code, an
 * environment variable, or CORE_ACCOUNTS, and it never creates an account as
 * a side effect of posting.  Missing/revoked/structurally invalid mappings are
 * typed, fail-closed errors so the surrounding procurement transaction rolls
 * back before either stock or a journal can be committed alone.
 *
 * The ledger is currently the repository-wide single CO-MAIN ledger (the same
 * explicit contract used by the trial balance).  Callers still pass that
 * company id explicitly; there is no global/company fallback in this module.
 */
'use strict';

const { getAccountByRole, AccountRoleError } = require('../accountRoles');

const PROCUREMENT_LEDGER_COMPANY_ID = 'CO-MAIN';

const ROLE_BY_KEY = Object.freeze({
  inventory: 'INVENTORY',
  grni: 'GRNI',
  ap: 'ACCOUNTS_PAYABLE',
  inputVat: 'INPUT_VAT',
  ppv: 'PPV',
  cash: 'CASH_ON_HAND',
  bank: 'BANK',
});

const EXPECTED_TYPES = Object.freeze({
  inventory: ['asset'],
  grni: ['liability'],
  ap: ['liability'],
  inputVat: ['asset'],
  ppv: ['expense', 'revenue'],
  cash: ['asset'],
  bank: ['asset'],
});

const EXPECTED_TAX_NATURE = Object.freeze({ inputVat: 'vat_input' });

class AccountError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.details = details || null;
  }
}

function _normalizeKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new AccountError(
      'PROC_ACCOUNT_ROLE_REQUIRED',
      'يجب تحديد أدوار الحسابات المطلوبة لعملية الترحيل'
    );
  }
  const unique = [...new Set(keys.map(String))];
  for (const key of unique) {
    if (!ROLE_BY_KEY[key]) {
      throw new AccountError(
        'PROC_ACCOUNT_ROLE_UNKNOWN',
        `دور حساب مشتريات غير معروف: ${key}`,
        { key }
      );
    }
  }
  return unique;
}

/**
 * Resolve only the roles needed by one posting operation.
 *
 * @param {object} db transaction connection/pool exposing query()
 * @param {string[]} keys keys from ROLE_BY_KEY (inventory, grni, ...)
 * @param {{companyId:string}} opts explicit ledger company
 */
async function resolveProcurementAccounts(db, keys, opts = {}) {
  const companyId = opts.companyId;
  if (!companyId) {
    throw new AccountError(
      'PROC_ACCOUNT_COMPANY_REQUIRED',
      'يجب تحديد شركة الدفتر صراحةً قبل ترحيل المشتريات'
    );
  }

  const requested = _normalizeKeys(keys);
  const resolved = {};
  const accountOwners = new Map();

  for (const key of requested) {
    const roleKey = ROLE_BY_KEY[key];
    let account;
    try {
      account = await getAccountByRole(db, roleKey, { companyId });
    } catch (error) {
      if (!(error instanceof AccountRoleError)) throw error;
      throw new AccountError(
        'PROC_ACCOUNT_ROLE_INVALID',
        `تعذّر ترحيل المشتريات: تعيين الحساب للدور ${roleKey} غير صالح`,
        { key, roleKey, companyId, causeCode: error.code }
      );
    }

    const allowed = EXPECTED_TYPES[key];
    if (!allowed.includes(account.type)) {
      throw new AccountError(
        'PROC_ACCOUNT_ROLE_TYPE_DRIFT',
        `الدور ${roleKey} مربوط بحساب من نوع ${account.type} بينما المطلوب ${allowed.join('/')}`,
        { key, roleKey, companyId, accountId: account.accountId, accountType: account.type, allowedTypes: allowed }
      );
    }

    const expectedTaxNature = EXPECTED_TAX_NATURE[key];
    if (expectedTaxNature && account.taxNature !== expectedTaxNature) {
      throw new AccountError(
        'PROC_ACCOUNT_ROLE_TAX_DRIFT',
        `الدور ${roleKey} يتطلب الطبيعة الضريبية ${expectedTaxNature} والحساب ${account.code} تصنيفه ${account.taxNature || 'none'}`,
        {
          key,
          roleKey,
          companyId,
          accountId: account.accountId,
          expectedTaxNature,
          actualTaxNature: account.taxNature || null,
        }
      );
    }

    // Procurement control roles are deliberately distinct.  Letting AP and
    // GRNI (or inventory and input VAT) point to one leaf makes the journal
    // balance while destroying the reconciliation control.
    const priorKey = accountOwners.get(account.accountId);
    if (priorKey && priorKey !== key) {
      throw new AccountError(
        'PROC_ACCOUNT_ROLE_COLLISION',
        `الحساب ${account.code} معيّن لدورين ماليين مختلفين (${ROLE_BY_KEY[priorKey]} و${roleKey})`,
        { firstKey: priorKey, secondKey: key, accountId: account.accountId, code: account.code }
      );
    }
    accountOwners.set(account.accountId, key);
    resolved[key] = {
      id: account.accountId,
      accountId: account.accountId,
      code: account.code,
      nameAr: account.nameAr,
      type: account.type,
      roleKey,
    };
  }

  return resolved;
}

/**
 * Backwards-compatible name used by the standalone procurement verifier.
 * Despite the historical name, it no longer creates or repairs anything.
 */
async function ensureProcurementAccounts(db, opts = {}) {
  return resolveProcurementAccounts(
    db,
    ['inventory', 'grni', 'ap', 'inputVat'],
    { companyId: opts.companyId }
  );
}

module.exports = {
  resolveProcurementAccounts,
  ensureProcurementAccounts,
  ROLE_BY_KEY,
  PROCUREMENT_LEDGER_COMPANY_ID,
  AccountError,
};
