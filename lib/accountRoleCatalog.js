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

  // ── roles the posting engines actually need ────────────────────────────
  //
  // The 20 above were the brief's list. These are the rest of what
  // lib/glPosting.js CORE_ACCOUNTS (25 codes) and lib/hrGLPosting.js
  // SALARY_ACCOUNTS (8 codes) resolve by hardcoded string today. Until a role
  // exists for EVERY posting an engine performs, "account_roles is the single
  // source of truth" cannot be true — the engine just keeps its literal.
  //
  // Named for what the money IS, never for the code that currently holds it,
  // so renumbering the chart can never invalidate a role.
  BRANCH_INVENTORY: { allowedTypes: ['asset'], normalBalance: 'debit' },
  GRNI: { allowedTypes: ['liability'], normalBalance: 'credit' },
  ROYALTY_PAYABLE: { allowedTypes: ['liability'], normalBalance: 'credit' },
  PLATFORM_PAYABLE: { allowedTypes: ['liability'], normalBalance: 'credit' },
  PLATFORM_COMMISSION: { allowedTypes: ['expense'], normalBalance: 'debit' },

  // Waste is split by reason because the P&L is expected to separate them.
  // routes/erp-core.js WASTE_ACCOUNT_BY_REASON already maps six reasons to
  // six codes, so six roles is the faithful translation, not an invention.
  WASTE_EXPENSE: { allowedTypes: ['expense'], normalBalance: 'debit' },
  WASTE_RAW: { allowedTypes: ['expense'], normalBalance: 'debit' },
  WASTE_FINISHED: { allowedTypes: ['expense'], normalBalance: 'debit' },
  WASTE_EXPIRED: { allowedTypes: ['expense'], normalBalance: 'debit' },
  WASTE_SPILL: { allowedTypes: ['expense'], normalBalance: 'debit' },
  WASTE_RETURNS: { allowedTypes: ['expense'], normalBalance: 'debit' },

  // Variances legitimately land on either side, so normalBalance is null
  // rather than a side the writer would then have to fight.
  STOCK_VARIANCE: { allowedTypes: ['expense', 'revenue'], normalBalance: null },
  STOCK_GAIN: { allowedTypes: ['revenue'], normalBalance: 'credit' },
  PPV: { allowedTypes: ['expense', 'revenue'], normalBalance: null },
  PRODUCTION_VARIANCE: { allowedTypes: ['expense', 'revenue'], normalBalance: null },

  // Applied/absorbed accounts are CREDITED as production consumes them, so
  // they sit contra to their own expense type.
  LABOR_APPLIED: { allowedTypes: ['expense'], normalBalance: 'credit', contra: true },
  OVERHEAD_APPLIED: { allowedTypes: ['expense'], normalBalance: 'credit', contra: true },

  // Payroll. PAYROLL_PAYABLE above is the accrual; these are the expense legs
  // and the two GOSI sides, which are genuinely different accounts.
  SALARY_EXPENSE: { allowedTypes: ['expense'], normalBalance: 'debit' },
  ALLOWANCES_EXPENSE: { allowedTypes: ['expense'], normalBalance: 'debit' },
  OVERTIME_EXPENSE: { allowedTypes: ['expense'], normalBalance: 'debit' },
  GOSI_COMPANY_SHARE: { allowedTypes: ['expense'], normalBalance: 'debit', taxNature: 'gosi' },
  GOSI_EMPLOYEE_SHARE: { allowedTypes: ['liability'], normalBalance: 'credit', taxNature: 'gosi' },
  EMPLOYEE_ADVANCES: { allowedTypes: ['asset'], normalBalance: 'debit' },
  PENALTY_REVENUE: { allowedTypes: ['revenue'], normalBalance: 'credit' },

  // Where an entry goes when its account genuinely cannot be determined.
  // Having this as a ROLE rather than a hardcoded code is what makes the
  // null-account repair reviewable: entries land somewhere explicit and
  // visible instead of being guessed into a real account.
  SUSPENSE: { allowedTypes: ['asset', 'liability'], normalBalance: null },
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
