/**
 * Account Role Catalog — Tier A.1 Corrective Gate, item 5.
 *
 * Static rules for every symbolic business role the overhaul brief lists.
 * lib/accountRoles.js's writer validates every mapping against this catalog
 * BEFORE it is allowed to be saved — a role can never be pointed at an
 * account of the wrong type or natural side just because someone typed the
 * wrong account_id.
 *
 * `normalBalance` is the side the role's own money is expected to sit on.
 * For a normal (non-contra) role this must agree with the target account's
 * type-implied natural side (asset/expense -> debit, liability/equity/
 * revenue -> credit); `contra: true` roles are explicitly exempt from that
 * check (e.g. SALES_DISCOUNT is type=revenue but naturally debit).
 * `normalBalance: null` means the role can legitimately swing either way
 * (a gain/loss or rounding bucket) and is not checked.
 */
'use strict';

const ROLE_CATALOG = {
  CASH_ON_HAND: { allowedTypes: ['asset'], normalBalance: 'debit' },
  BANK: { allowedTypes: ['asset'], normalBalance: 'debit' },
  ACCOUNTS_RECEIVABLE: { allowedTypes: ['asset'], normalBalance: 'debit' },
  ACCOUNTS_PAYABLE: { allowedTypes: ['liability'], normalBalance: 'credit' },
  INVENTORY: { allowedTypes: ['asset'], normalBalance: 'debit' },
  WORK_IN_PROGRESS: { allowedTypes: ['asset'], normalBalance: 'debit' },
  FINISHED_GOODS: { allowedTypes: ['asset'], normalBalance: 'debit' },
  INPUT_VAT: { allowedTypes: ['asset'], normalBalance: 'debit', taxNature: 'vat_input' },
  OUTPUT_VAT: { allowedTypes: ['liability'], normalBalance: 'credit', taxNature: 'vat_output' },
  SALES_REVENUE: { allowedTypes: ['revenue'], normalBalance: 'credit' },
  SALES_DISCOUNT: { allowedTypes: ['revenue'], normalBalance: 'debit', contra: true },
  COGS: { allowedTypes: ['expense'], normalBalance: 'debit' },
  INVENTORY_GAIN_LOSS: { allowedTypes: ['revenue', 'expense'], normalBalance: null },
  PAYROLL_PAYABLE: { allowedTypes: ['liability'], normalBalance: 'credit' },
  ZAKAT: { allowedTypes: ['liability'], normalBalance: 'credit', taxNature: 'zakat' },
  DELIVERY_COMMISSION: { allowedTypes: ['expense'], normalBalance: 'debit' },
  FRANCHISE_FEE: { allowedTypes: ['expense'], normalBalance: 'debit' },
  ROUNDING: { allowedTypes: ['revenue', 'expense'], normalBalance: null },
  CUSTOMER_ADVANCES: { allowedTypes: ['liability'], normalBalance: 'credit' },
  SUPPLIER_ADVANCES: { allowedTypes: ['asset'], normalBalance: 'debit' },
};

// Every role in this catalog requires a postable (non-folder, childless)
// account — there is no role that is ever legitimately satisfied by a
// header/rollup account. Kept as an explicit constant (not per-role) so the
// writer's intent reads clearly at the call site.
const POSTING_REQUIRED_FOR_ALL_ROLES = true;

function getRoleDefinition(roleKey) {
  return ROLE_CATALOG[roleKey] || null;
}

module.exports = { ROLE_CATALOG, POSTING_REQUIRED_FOR_ALL_ROLES, getRoleDefinition };
